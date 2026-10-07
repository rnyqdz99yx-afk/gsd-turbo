import fs from 'node:fs';
import path from 'node:path';
import { nextPhase, relaunchDecision } from './scheduler.mjs';
import { inferStatus, isAgentAlive, readLaneStatus, unknownAgentState, writeLaneStatus } from './run-status.mjs';
import { laneSessionName } from './claude.mjs';
import { laneSystemPrompt, laneUserPrompt } from './lane-prompt.mjs';
import { writeJsonAtomic } from './fsx.mjs';

const SUPERVISOR_LOG = '.planning/turbo/logs/supervisor.log';
// Consecutive failed launches before the supervisor halts: a --bg that keeps failing (or
// registers a session that dies at once) must never launch on every tick forever.
const MAX_LAUNCH_FAILURES = 10;
// Dead sessions of the lane removed before a launch; the cap keeps a tick inside the heartbeat window.
const MAX_DEAD_REMOVED = 3;
// claude --bg in a folder Claude Code does not trust yet fails at once; no retry can fix that.
const UNTRUSTED_RE = /workspace not trusted/i;
// The lane mode doctor chose when the daemon started: full runs /turbo-phase, anything else is safe.
const laneMode = (ctx) => (ctx.mode === 'full' ? 'full' : 'safe');
// A relaunched lane runs this supervisor's mode. An adopted live session may run either prompt: one
// an earlier supervisor launched (the lane's recorded mode) or one whose --bg call from this
// supervisor timed out after it registered (this supervisor's mode). It takes the stricter of the
// two: a full lane never ends on GSD's completion alone, while safe mode would end it early.
const relaunchMode = (lane, adopted, ctx) => (adopted && lane.mode === 'full' ? 'full' : laneMode(ctx));

// Real path when it exists (resolve() otherwise), forward slashes, case-insensitive on win32:
// the same normalization laneSessionName uses.
function dirKey(p) {
  let abs;
  try {
    abs = fs.realpathSync.native(p);
  } catch {
    abs = path.resolve(p);
  }
  const key = abs.replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

// Sessions of this lane: the lane name AND started in this checkout. An empty cwd never
// matches (it would resolve to the supervisor's own working directory).
function laneAgents(agents, root, phase, exclude) {
  const name = laneSessionName(root, phase);
  const home = dirKey(root);
  return agents.filter((a) => a.id !== exclude && a.name === name && Boolean(a.cwd) && dirKey(a.cwd) === home);
}

const isFresh = (record, launchedAt) => Boolean(record && launchedAt && Date.parse(record.at) >= Date.parse(launchedAt));

const MIN_START_MS = Date.parse('2000-01-01T00:00:00Z');
// An adopted session's start time (ms number, digit string or ISO string) as ISO, or null
// unless it lies between 2000 and now: seconds since the epoch would make stale lane records
// count as fresh, and a future time would make the session's own records stale.
function startedAtIso(agent, at) {
  const v = agent?.startedAt;
  const text = typeof v === 'string' ? v.trim() : '';
  const ms = typeof v === 'number' ? v : /^\d+$/.test(text) ? Number(text) : text ? Date.parse(text) : NaN;
  return Number.isFinite(ms) && ms >= MIN_START_MS && ms <= Date.parse(at) ? new Date(ms).toISOString() : null;
}

// Adopts an alive session of this lane (for example one whose --bg call timed out after it
// registered) instead of launching a duplicate. Before a launch, removes dead sessions of this
// lane (a --bg that registers a session that dies at once would otherwise leave one per tick);
// `exclude` (the old session, already removed by the caller) is skipped. Throws when the
// launch fails, with the error marked launchFailed for failedTick's bound.
// Returns { sessionId, name, launchedAt, adopted }: an adopted session keeps its own start time when
// it is valid, so lane records it wrote before the adoption still count as fresh.
function startLane(phase, agents, ctx, { resume, exclude, at }) {
  const { root, config, turboRun, deps } = ctx;
  const name = laneSessionName(root, phase.number);
  const mine = laneAgents(agents, root, phase.number, exclude);
  const alive = mine.find(isAgentAlive);
  if (alive) {
    deps.log(`adopt phase ${phase.number} session ${alive.id}`);
    return { sessionId: alive.id, name, launchedAt: startedAtIso(alive, at) || at, adopted: true };
  }
  for (const dead of mine.filter((a) => !isAgentAlive(a)).slice(0, MAX_DEAD_REMOVED)) removeSession(ctx, dead.id);
  // A daemon whose lease was revoked mid-tick (stop, resume, another start) launches nothing: the
  // lease check after this tick ends it. Not a launch failure.
  if (deps.leaseHeld && !deps.leaseHeld()) throw Object.assign(new Error(`launch phase ${phase.number} skipped: lease lost`), { leaseLost: true });
  let sessionId = null;
  try {
    sessionId = deps.claude.launchBg({
      name,
      prompt: laneUserPrompt({ phase: phase.number, resume, mode: ctx.mode, turboRun }),
      systemPrompt: laneSystemPrompt({ phase: phase.number, turboRun, contextPct: config.context_stop_pct, autonomy: config.autonomy, mode: ctx.mode }),
      permissionMode: config.lane_permission_mode,
      model: config.lane_model,
    }, root);
    // Written only after a successful launch: a failed launch leaves the lane record
    // (paused-context, needs-owner) as it was, so the next tick reaches the same decision.
    writeLaneStatus(root, phase.number, 'running', { sessionId, at });
    deps.log(`launch phase ${phase.number} session ${sessionId}${resume ? ' (resume)' : ''}`);
  } catch (err) {
    // Any error from the launch on counts toward MAX_LAUNCH_FAILURES: a session that starts but whose
    // lane record cannot be written would otherwise be launched again on every tick, unbounded.
    const what = sessionId ? `session ${sessionId} started, then ${err.message}` : err.message;
    throw Object.assign(new Error(`launch phase ${phase.number} failed: ${what}`, { cause: err }), { launchFailed: true, phase: phase.number });
  }
  return { sessionId, name, launchedAt: at, adopted: false };
}

// GSD marks a phase complete inside execute-phase (G9), before a full lane's fan-out runs the gates.
// A safe relaunch of such a lane (gsd-autonomous) would end at once on the completed phase and count
// as done, so the gates and the owner items would be lost. Until the lane's own fresh done record
// exists, a full lane on a completed phase is never relaunched or adopted by a safe-mode supervisor:
// the owner is told once and the lane waits, still recorded as full. Returns true while it waits.
async function holdDowngradedLane(lane, ctx, phase, record) {
  const doneRecord = record?.status === 'done' && isFresh(record, lane.launchedAt);
  if (lane.mode !== 'full' || laneMode(ctx) === 'full' || !phase.complete || doneRecord) return false;
  if (!lane.notified.downgraded) {
    ctx.deps.log(`phase ${lane.phase}: GSD completed it before turbo's gates finished and this supervisor runs in safe mode; waiting for the owner`);
    await ctx.deps.notify('laneDowngraded', { phase: lane.phase, turboRun: ctx.turboRun });
    lane.notified.downgraded = true;
  }
  return true;
}

// A lane that finished its turn stays listed as blocked, which counts as alive: it is removed before
// phaseDone and before the next lane starts, and a failed rm fails the tick, which the next tick retries.
async function finishLane(s, ctx, agent) {
  const { phase, sessionId } = s.lane;
  const alive = isAgentAlive(agent);
  if (alive) ctx.deps.claude.rm(sessionId);
  ctx.deps.log(`phase ${phase} done`);
  await ctx.deps.notify('phaseDone', { phase });
  if (!alive) removeSession(ctx, sessionId);
  s.lane = null;
}

function removeSession(ctx, id) {
  try {
    ctx.deps.claude.rm(id);
  } catch (err) {
    ctx.deps.log(`rm session ${id} failed: ${err.message}`);
  }
}

// One supervisor step; mutates s. Throws on any failure, and tick then keeps the previous state.
async function step(s, ctx, now) {
  const { root, config, deps } = ctx;
  const at = now.toISOString();
  const phases = deps.loadPhases();
  const agents = deps.claude.list();
  if (phases.length) delete s.noPhases;

  if (!s.lane) {
    const p = nextPhase(phases);
    if (!p) {
      if (!phases.length) {
        // an empty list is a broken or empty roadmap, never a finished milestone
        if (!s.noPhases) deps.log('no phases in the current milestone; waiting');
        s.noPhases = true;
      } else if (phases.every((x) => x.complete)) {
        deps.log('milestone done');
        await deps.notify('milestoneDone', {});
        s.finished = true;
      } else if (!s.noReady) {
        // every unfinished phase waits on another unfinished one: a dependency cycle
        const waiting = phases.filter((x) => !x.complete).map((x) => x.number);
        deps.log(`no ready phase: ${waiting.join(', ')} wait on each other; waiting for the roadmap to change`);
        await deps.notify('noReadyPhase', { phases: waiting.slice(0, 10).join(', ') });
        s.noReady = true;
      }
      return;
    }
    delete s.noReady;
    const fingerprint = deps.fingerprint(p);
    const { adopted, ...started } = startLane(p, agents, ctx, { resume: false, exclude: null, at });
    s.lane = { phase: p.number, ...started, mode: laneMode(ctx), restarts: 0, fingerprint, notified: {}, blockedSince: null };
    return;
  }

  const lane = s.lane;
  lane.notified ??= {};
  const listed = phases.find((x) => x.number === lane.phase);
  const phase = listed || { number: lane.phase, complete: false, verification: null };
  if (lane.forceRelaunch) {
    const record = readLaneStatus(root, lane.phase);
    // resume removed the lane record: a fresh done record on a completed phase (the owner ran the
    // remaining steps and recorded it, or the lane did) leaves nothing to relaunch
    if (phase.complete && record?.status === 'done' && isFresh(record, lane.launchedAt)) return finishLane(s, ctx, agents.find((a) => a.id === lane.sessionId));
    if (await holdDowngradedLane(lane, ctx, phase, record)) return;
    const fingerprint = deps.fingerprint(phase);
    removeSession(ctx, lane.sessionId);
    const { adopted, ...started } = startLane(phase, agents, ctx, { resume: true, exclude: lane.sessionId, at });
    Object.assign(lane, started, { restarts: 0, fingerprint, notified: {}, blockedSince: null, forceRelaunch: false, mode: relaunchMode(lane, adopted, ctx) });
    return;
  }

  // By id only: an unlisted session counts as ended, and the relaunch below adopts an already
  // registered session of this lane with full accounting (restarts, launchedAt, notified).
  const agent = agents.find((a) => a.id === lane.sessionId);
  if (!listed && !isAgentAlive(agent)) {
    // Relaunching a phase GSD no longer lists would loop; the lane is cleared so that a
    // restart goes on with the next ready phase. The ended session is kept for inspection.
    deps.log(`phase ${lane.phase} is no longer in the roadmap and session ${lane.sessionId} has ended; halted`);
    await deps.notify('phaseMissing', { phase: lane.phase, id: lane.sessionId });
    s.lane = null;
    s.halted = true;
    return;
  }
  const record = readLaneStatus(root, lane.phase);
  const status = inferStatus({ agent, laneRecord: record, launchedAt: lane.launchedAt, phase, mode: lane.mode || 'safe' });
  const unknown = unknownAgentState(agent);
  if (unknown && lane.notified.unknownState !== unknown) {
    deps.log(`phase ${lane.phase} session ${lane.sessionId} reports unknown state ${JSON.stringify(unknown.slice(0, 40))}; waiting`);
    lane.notified.unknownState = unknown;
  }

  if (status === 'running') {
    lane.blockedSince = null;
    lane.notified.blocked = false;
    return;
  }
  if (status === 'blocked') {
    lane.blockedSince ||= at;
    const waited = (now - Date.parse(lane.blockedSince)) / 60000;
    if (waited >= config.blocked_minutes_before_notify && !lane.notified.blocked) {
      deps.log(`phase ${lane.phase} blocked for ${Math.floor(waited)} min`);
      await deps.notify('laneBlocked', { phase: lane.phase, id: lane.sessionId });
      lane.notified.blocked = true;
    }
    return;
  }
  if (status === 'done') return finishLane(s, ctx, agent);
  if (status === 'paused-context') {
    if (await holdDowngradedLane(lane, ctx, phase, record)) return;
    const fp = deps.fingerprint(phase);
    const d = relaunchDecision({ restarts: lane.restarts, progressed: fp !== lane.fingerprint, maxRestarts: config.max_restarts_without_progress });
    if (d.action === 'halt') {
      deps.log(`phase ${lane.phase} halted: no progress after ${lane.restarts} restarts`);
      await deps.notify('laneHalted', { phase: lane.phase, restarts: lane.restarts, log: SUPERVISOR_LOG });
      s.halted = true;
      return;
    }
    // A blocked session that wrote paused-context is still alive: two sessions must never work in one
    // checkout, so its rm must succeed (a failure fails the tick, which the next tick retries).
    if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
    else removeSession(ctx, lane.sessionId);
    const { adopted, ...started } = startLane(phase, agents, ctx, { resume: true, exclude: lane.sessionId, at });
    Object.assign(lane, started, { restarts: d.restarts, fingerprint: fp, notified: {}, blockedSince: null, mode: relaunchMode(lane, adopted, ctx) });
    return;
  }
  if (status === 'needs-owner') {
    if (!lane.notified.owner) {
      deps.log(`phase ${lane.phase} needs the owner`);
      const own = record?.status === 'needs-owner' && record.reason && isFresh(record, lane.launchedAt);
      await deps.notify('laneNeedsOwner', { phase: lane.phase, reason: own ? record.reason : 'human verification' });
      lane.notified.owner = true;
    }
    return;
  }
  deps.log(`phase ${lane.phase} failed: session ${lane.sessionId}`);
  await deps.notify('laneFailed', { phase: lane.phase, id: lane.sessionId });
  s.halted = true;
}

// A failing tick (launch, agents list, GSD phases) keeps the previous state so the next tick
// retries, and notifies the owner once per failing spell that lasts blocked_minutes_before_notify.
// Failed launches are counted (a successful tick resets the count) and halt at MAX_LAUNCH_FAILURES.
async function failedTick(state, err, ctx, now) {
  const { config, deps } = ctx;
  const text = String(err?.message ?? err);
  const firstLine = text.split(/\r?\n/)[0].slice(0, 200);
  deps.log(`tick error: ${text.replace(/\s*\r?\n\s*/g, ' ')}`);
  const s = structuredClone(state);
  // the lease check after this tick ends the daemon: nothing to count or notify
  if (err?.leaseLost) return s;
  if (err?.launchFailed && UNTRUSTED_RE.test(text)) {
    deps.log(`phase ${err.phase} halted: Claude Code does not trust ${ctx.root}`);
    await deps.notify('workspaceUntrusted', { phase: err.phase, dir: ctx.root });
    s.halted = true;
    return s;
  }
  s.failingSince ||= now.toISOString();
  if (!s.failingNotified && (now - Date.parse(s.failingSince)) / 60000 >= config.blocked_minutes_before_notify) {
    await deps.notify('supervisorFailing', { error: firstLine });
    s.failingNotified = true;
  }
  if (err?.launchFailed) {
    s.launchFailures = (Number(s.launchFailures) || 0) + 1;
    if (s.launchFailures >= MAX_LAUNCH_FAILURES) {
      deps.log(`phase ${err.phase} halted: launch failed ${s.launchFailures} times in a row`);
      await deps.notify('launchHalted', { phase: err.phase, error: firstLine });
      s.halted = true;
    }
  }
  return s;
}

export async function tick(state, ctx) {
  const now = ctx.deps.now();
  const s = structuredClone(state);
  try {
    await step(s, ctx, now);
  } catch (err) {
    return failedTick(state, err, ctx, now);
  }
  delete s.failingSince;
  delete s.failingNotified;
  // any successful tick, adoption included, ends a launch-failure spell; restarts bound it from there
  delete s.launchFailures;
  return s;
}

export async function runDaemon({ ctx, statePath, initial, intervalMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let state = initial || { lane: null, finished: false, halted: false };
  let writeFailing = false;
  while (!state.finished && !state.halted) {
    try {
      state = await tick(state, ctx);
    } catch (err) {
      ctx.deps.log(`tick error: ${err.message}`);
    }
    // A failed state write (disk full, locked file) must not kill the daemon: the state stays
    // in memory and the next tick writes it again. Logged once per failing spell.
    try {
      writeJsonAtomic(statePath, { ...state, pid: process.pid, updatedAt: ctx.deps.now().toISOString() });
      if (writeFailing) ctx.deps.log('state write ok again');
      writeFailing = false;
    } catch (err) {
      if (!writeFailing) ctx.deps.log(`state write failed: ${err.message}`);
      writeFailing = true;
    }
    if (state.finished || state.halted) break;
    await sleep(intervalMs);
  }
  return state;
}
