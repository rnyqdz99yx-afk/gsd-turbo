import fs from 'node:fs';
import path from 'node:path';
import { comparePhase, inRange, isFinished, nextPhase, rangeBlocker, rangeLabel, relaunchDecision } from './scheduler.mjs';
import { inferStatus, isAgentAlive, readLaneStatus, turnEnded, unknownAgentState, writeLaneStatus } from './run-status.mjs';
import { laneSessionName, parseResume } from './claude.mjs';
import { laneSystemPrompt, laneUserPrompt } from './lane-prompt.mjs';
import { writeJsonAtomic } from './fsx.mjs';
import { prepareLaneTmp, removeLaneTmp } from './lane-tmp.mjs';
import { pushTick } from './push.mjs';
import { deliveryState } from './questions.mjs';
import { answerWakePrompt } from './wake.mjs';

const SUPERVISOR_LOG = '.planning/turbo/logs/supervisor.log';
// Consecutive failed launches before the supervisor halts: a --bg that keeps failing (or
// registers a session that dies at once) must never launch on every tick forever.
const MAX_LAUNCH_FAILURES = 10;
// Dead sessions of the lane removed before a launch; the cap keeps a tick inside the heartbeat window.
const MAX_DEAD_REMOVED = 3;
// claude --bg --resume attempts per wake: a copy is removed and the wake tried once more (spec §5.5.1 step 4).
const WAKE_ATTEMPTS = 2;
// Wakes for the same set of answers: a lane that stops again without delivering them is the owner's.
const ANSWER_WAKES = 2;
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
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
    // the session's TMP, TEMP and TMPDIR, emptied of what an earlier session of the phase left
    const tmpDir = prepareLaneTmp(root, phase.number, deps.log);
    sessionId = deps.claude.launchBg({
      name,
      prompt: laneUserPrompt({ phase: phase.number, resume, mode: ctx.mode, turboRun, answered: resume ? deliveryState(root, phase.number).ready.map((q) => q.id) : [] }),
      systemPrompt: laneSystemPrompt({ phase: phase.number, turboRun, contextPct: config.context_stop_pct, autonomy: config.autonomy, mode: ctx.mode, tmpDir, pushMode: config.push?.mode }),
      permissionMode: config.lane_permission_mode,
      model: config.lane_model,
      tmpDir,
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
  // the session is gone now: its temp directory goes too (Claude Code's scratch files and GSD's hook
  // files may live there while it runs)
  try {
    removeLaneTmp(ctx.root, phase);
  } catch (err) {
    ctx.deps.log(`phase ${phase}: temp directory not removed: ${err.message}`);
  }
  s.lane = null;
}

// The scheduler skips closed phases that GSD reports unfinished (verification stale, for example):
// logged once per distinct set (the last one is kept in the state), never notified.
function logSkipped(s, phases, deps) {
  const skipped = phases.filter((x) => x.closed && !x.complete).sort((a, b) => comparePhase(a.number, b.number));
  const numbers = skipped.map((x) => x.number);
  if (numbers.join() === (s.skippedClosed || []).join()) return;
  if (!numbers.length) {
    delete s.skippedClosed;
    return;
  }
  const why = [...new Set(skipped.map((x) => x.verification || 'missing'))].join(', ');
  deps.log(`skipped phases ${numbers.join(', ')}: checked off in the roadmap, GSD reports them unfinished (verification ${why}); re-verify by hand with /gsd-execute-phase <N>`);
  s.skippedClosed = numbers;
}

function removeSession(ctx, id) {
  try {
    ctx.deps.claude.rm(id);
  } catch (err) {
    ctx.deps.log(`rm session ${id} failed: ${err.message}`);
  }
}

// One wake of the lane's own conversation (spec §5.5.1, the §9 spikes): claude stop <job id>, then claude --bg
// --resume <session id> <prompt> without any other flag. A copy cannot reach the old subagents: it is stopped and
// removed, and the wake is tried once more. Output that is neither a wake nor a copy, or an error, is a failed
// attempt. Returns true when the session itself woke.
function wakeSession(ctx, lane, prompt) {
  const { deps, root } = ctx;
  // the transcript's session id from the job state, read while the lane is idle (§5.5.1 step 5); else the job id
  const target = deps.lanes?.session(lane.sessionId) || lane.sessionId;
  for (let attempt = 1; attempt <= WAKE_ATTEMPTS; attempt++) {
    try {
      deps.claude.stop(lane.sessionId);
    } catch (err) {
      deps.log(`wake phase ${lane.phase}: stop ${lane.sessionId}: ${errLine(err)}`);
    }
    let r;
    try {
      r = parseResume(deps.claude.resume(target, prompt, root), { jobId: lane.sessionId, sessionId: target });
    } catch (err) {
      deps.log(`wake phase ${lane.phase} attempt ${attempt}: ${errLine(err)}`);
      continue;
    }
    if (r.woke) {
      deps.log(`wake phase ${lane.phase}: woke session ${lane.sessionId}`);
      return true;
    }
    if (!r.copyId) {
      deps.log(`wake phase ${lane.phase} attempt ${attempt}: claude reported neither a wake nor a copy`);
      continue;
    }
    deps.log(`wake phase ${lane.phase} attempt ${attempt}: started a copy ${r.copyId}; stopped and removed`);
    for (const f of ['stop', 'rm']) {
      try {
        deps.claude[f](r.copyId);
      } catch (err) {
        deps.log(`${f} copy ${r.copyId}: ${errLine(err)}`);
      }
    }
  }
  return false;
}

// The session did not wake: it goes, and a new one starts (spec §5.5.1 step 4, path continuation). startLane puts
// the undelivered answers into its prompt; the skill delivers them by the continuation path.
function relaunchAfterFailedWake(ctx, lane, phase, at) {
  ctx.deps.log(`wake phase ${lane.phase}: the session did not wake; starting a new session (continuation path)`);
  removeSession(ctx, lane.sessionId);
  // listed again: the copies just removed must not be adopted
  const { adopted, ...started } = startLane(phase, ctx.deps.claude.list(), ctx, { resume: true, exclude: lane.sessionId, at });
  Object.assign(lane, started, { notified: {}, blockedSince: null, mode: relaunchMode(lane, adopted, ctx) });
}

// spec §5.5.1: every question the lane stopped for has an answer → its own conversation goes on. Returns true when
// it woke the lane or started a new session for it.
function wakeForAnswers(ctx, lane, phase, at) {
  const { deps, root } = ctx;
  if (!deps.claude.resume) return false;
  const { waiting, ready } = deliveryState(root, lane.phase);
  if (waiting.length || !ready.length) return false;
  const ids = ready.map((q) => q.id);
  const key = ids.join(',');
  const count = lane.woken?.key === key ? lane.woken.count : 0;
  if (count >= ANSWER_WAKES) return false;
  deps.log(`phase ${lane.phase}: the owner answered ${key}; waking session ${lane.sessionId}`);
  if (wakeSession(ctx, lane, answerWakePrompt({ phase: lane.phase, turboRun: ctx.turboRun, ids }))) {
    // its needs-owner record is older than this: it no longer counts
    Object.assign(lane, { launchedAt: at, notified: {}, blockedSince: null });
  } else {
    relaunchAfterFailedWake(ctx, lane, phase, at);
  }
  lane.woken = { key, count: count + 1, at };
  return true;
}

// One supervisor step; mutates s. Throws on any failure, and tick then keeps the previous state.
async function step(s, ctx, now) {
  const { root, config, deps } = ctx;
  const at = now.toISOString();
  const phases = deps.loadPhases();
  const agents = deps.claude.list();

  if (!s.lane) {
    const range = s.range || null;
    // what the scheduler looks at: the run's range, or the whole milestone without one
    const scoped = phases.filter((x) => inRange(x.number, range));
    if (scoped.length) delete s.noPhases;
    logSkipped(s, scoped, deps);
    const p = nextPhase(phases, { range });
    if (!p) {
      if (!scoped.length) {
        // an empty list is a broken or empty roadmap, never a finished milestone; nor is an empty range a finished run
        if (!s.noPhases) deps.log(phases.length ? `no phase of the milestone is in the range ${rangeLabel(range)}; waiting` : 'no phases in the current milestone; waiting');
        s.noPhases = true;
      } else if (scoped.every(isFinished)) {
        if (range) {
          deps.log(`phases ${rangeLabel(range)} done`);
          await deps.notify('rangeDone', { range: rangeLabel(range) });
        } else {
          deps.log('milestone done');
          await deps.notify('milestoneDone', {});
        }
        s.finished = true;
      } else if (rangeBlocker(phases, range)) {
        // only the owner can change the range or finish the phase outside it
        const { phase, dep } = rangeBlocker(phases, range);
        deps.log(`phases ${rangeLabel(range)} wait: phase ${phase} depends on phase ${dep} outside the range, which is not finished; halted`);
        await deps.notify('rangeBlocked', { range: rangeLabel(range), phase, dep });
        s.halted = true;
      } else if (!s.noReady) {
        // every unfinished phase waits on another unfinished one: a dependency cycle
        const waiting = scoped.filter((x) => !isFinished(x)).map((x) => x.number);
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
  // By id only: an unlisted session counts as ended, and the relaunch below adopts an already
  // registered session of this lane with full accounting (restarts, launchedAt, notified).
  const agent = agents.find((a) => a.id === lane.sessionId);
  if (lane.forceRelaunch) {
    const record = readLaneStatus(root, lane.phase);
    // resume removed the lane record: a fresh done record on a completed phase (the owner ran the
    // remaining steps and recorded it, or the lane did) leaves nothing to relaunch
    if (phase.complete && record?.status === 'done' && isFresh(record, lane.launchedAt)) return finishLane(s, ctx, agent);
    if (await holdDowngradedLane(lane, ctx, phase, record)) return;
    const fingerprint = deps.fingerprint(phase);
    // a still-listed (usually blocked) old session must be gone first; a failed rm fails the tick and keeps the resume
    if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
    else removeSession(ctx, lane.sessionId);
    const { adopted, ...started } = startLane(phase, agents, ctx, { resume: true, exclude: lane.sessionId, at });
    Object.assign(lane, started, { restarts: 0, fingerprint, notified: {}, blockedSince: null, forceRelaunch: false, mode: relaunchMode(lane, adopted, ctx) });
    return;
  }

  if (!listed && turnEnded(agent)) {
    // Relaunching a phase GSD no longer lists would loop; the lane is cleared so that a
    // restart goes on with the next ready phase. The ended (or finished, listed blocked)
    // session is kept for inspection.
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
    // a full lane that finished its turn on a phase GSD completed waits for full mode, never as a generic block
    if (turnEnded(agent) && await holdDowngradedLane(lane, ctx, phase, record)) return;
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
    // spec §5.5.1: the owner's answers are in → the same conversation goes on
    if (wakeForAnswers(ctx, lane, phase, at)) return;
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
  // push requests and CI watches live in their own run files (spec §6, S2): their failures never fail the lane's tick
  try {
    await pushTick(ctx, now);
  } catch (err) {
    ctx.deps.log(`push: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
  try {
    await step(s, ctx, now);
  } catch (err) {
    const failed = await failedTick(state, err, ctx, now);
    // the skipped line this tick logged stays logged: it is not repeated during a failing spell
    if (s.skippedClosed) failed.skippedClosed = s.skippedClosed;
    else delete failed.skippedClosed;
    return failed;
  }
  delete s.failingSince;
  delete s.failingNotified;
  // any successful tick, adoption included, ends a launch-failure spell; restarts bound it from there
  delete s.launchFailures;
  return s;
}

// The lane a starting daemon takes over: none after a finished run, and none outside the run's range.
// The session of a lane outside it is left alone (turbo-run stop already stopped it; kept for inspection).
export function resumableLane(prev, range, log) {
  const lane = prev && !prev.finished ? prev.lane || null : null;
  if (!lane || inRange(lane.phase, range)) return lane;
  log(`lane phase ${lane.phase} is outside the range ${rangeLabel(range)}; not resumed (session ${lane.sessionId} kept)`);
  return null;
}

export async function runDaemon({ ctx, statePath, initial, intervalMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let state = initial || { lane: null, finished: false, halted: false };
  let writeFailing = false;
  const beat = () => writeJsonAtomic(statePath, { ...state, pid: process.pid, updatedAt: ctx.deps.now().toISOString() });
  // long push work inside a tick refreshes the heartbeat between its steps (lib/push.mjs pushTick); a failing write
  // is reported by the write after the tick. A daemon that lost its lease writes nothing and answers false: its push
  // work stops, and the daemon ends the way it does after any tick without the lease.
  ctx.deps.heartbeat = () => {
    if (ctx.deps.leaseHeld && !ctx.deps.leaseHeld()) return false;
    try {
      beat();
    } catch {
      // reported after the tick
    }
    return true;
  };
  while (!state.finished && !state.halted) {
    try {
      state = await tick(state, ctx);
    } catch (err) {
      ctx.deps.log(`tick error: ${err.message}`);
    }
    // A failed state write (disk full, locked file) must not kill the daemon: the state stays
    // in memory and the next tick writes it again. Logged once per failing spell.
    try {
      beat();
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
