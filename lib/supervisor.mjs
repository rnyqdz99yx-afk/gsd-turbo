import fs from 'node:fs';
import path from 'node:path';
import { nextPhase, relaunchDecision } from './scheduler.mjs';
import { inferStatus, isAgentAlive, readLaneStatus, writeLaneStatus } from './run-status.mjs';
import { laneSessionName } from './claude.mjs';
import { laneSystemPrompt, laneUserPrompt } from './lane-prompt.mjs';
import { writeJsonAtomic } from './fsx.mjs';

const SUPERVISOR_LOG = '.planning/turbo/logs/supervisor.log';

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

// Adopts an alive session of this lane (for example one whose --bg call timed out after it
// registered) instead of launching a duplicate. Throws when the launch fails.
function startLane(phase, agents, ctx, { resume, exclude, at }) {
  const { root, config, turboRun, deps } = ctx;
  const name = laneSessionName(root, phase.number);
  const alive = laneAgents(agents, root, phase.number, exclude).find(isAgentAlive);
  if (alive) {
    deps.log(`adopt phase ${phase.number} session ${alive.id}`);
    return { sessionId: alive.id, name };
  }
  let sessionId;
  try {
    sessionId = deps.claude.launchBg({
      name,
      prompt: laneUserPrompt({ phase: phase.number, resume }),
      systemPrompt: laneSystemPrompt({ phase: phase.number, turboRun, contextPct: config.context_stop_pct, autonomy: config.autonomy }),
      permissionMode: config.lane_permission_mode,
      model: config.lane_model,
    }, root);
  } catch (err) {
    throw new Error(`launch phase ${phase.number} failed: ${err.message}`, { cause: err });
  }
  // Written only after a successful launch: a failed launch leaves the lane record
  // (paused-context, needs-owner) as it was, so the next tick reaches the same decision.
  writeLaneStatus(root, phase.number, 'running', { sessionId, at });
  deps.log(`launch phase ${phase.number} session ${sessionId}${resume ? ' (resume)' : ''}`);
  return { sessionId, name };
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
      }
      return;
    }
    const fingerprint = deps.fingerprint(p);
    const started = startLane(p, agents, ctx, { resume: false, exclude: null, at });
    s.lane = { phase: p.number, ...started, launchedAt: at, restarts: 0, fingerprint, notified: {}, blockedSince: null };
    return;
  }

  const lane = s.lane;
  lane.notified ??= {};
  const phase = phases.find((x) => x.number === lane.phase) || { number: lane.phase, complete: false, verification: null };
  if (lane.forceRelaunch) {
    const fingerprint = deps.fingerprint(phase);
    removeSession(ctx, lane.sessionId);
    const started = startLane(phase, agents, ctx, { resume: true, exclude: lane.sessionId, at });
    Object.assign(lane, started, { launchedAt: at, restarts: 0, fingerprint, notified: {}, blockedSince: null, forceRelaunch: false });
    return;
  }

  // By id only: an unlisted session counts as ended, and the relaunch below adopts an already
  // registered session of this lane with full accounting (restarts, launchedAt, notified).
  const agent = agents.find((a) => a.id === lane.sessionId);
  const record = readLaneStatus(root, lane.phase);
  const status = inferStatus({ agent, laneRecord: record, launchedAt: lane.launchedAt, phase });

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
  if (status === 'done') {
    deps.log(`phase ${lane.phase} done`);
    await deps.notify('phaseDone', { phase: lane.phase });
    removeSession(ctx, lane.sessionId);
    s.lane = null;
    return;
  }
  if (status === 'paused-context') {
    const fp = deps.fingerprint(phase);
    const d = relaunchDecision({ restarts: lane.restarts, progressed: fp !== lane.fingerprint, maxRestarts: config.max_restarts_without_progress });
    if (d.action === 'halt') {
      deps.log(`phase ${lane.phase} halted: no progress after ${lane.restarts} restarts`);
      await deps.notify('laneHalted', { phase: lane.phase, restarts: lane.restarts, log: SUPERVISOR_LOG });
      s.halted = true;
      return;
    }
    removeSession(ctx, lane.sessionId);
    const started = startLane(phase, agents, ctx, { resume: true, exclude: lane.sessionId, at });
    Object.assign(lane, started, { launchedAt: at, restarts: d.restarts, fingerprint: fp, notified: {}, blockedSince: null });
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
async function failedTick(state, err, ctx, now) {
  const { config, deps } = ctx;
  const text = String(err?.message ?? err);
  deps.log(`tick error: ${text.replace(/\s*\r?\n\s*/g, ' ')}`);
  const s = structuredClone(state);
  s.failingSince ||= now.toISOString();
  if (!s.failingNotified && (now - Date.parse(s.failingSince)) / 60000 >= config.blocked_minutes_before_notify) {
    await deps.notify('supervisorFailing', { error: text.split(/\r?\n/)[0].slice(0, 200) });
    s.failingNotified = true;
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
  return s;
}

export async function runDaemon({ ctx, statePath, initial, intervalMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let state = initial || { lane: null, finished: false, halted: false };
  while (!state.finished && !state.halted) {
    try {
      state = await tick(state, ctx);
    } catch (err) {
      ctx.deps.log(`tick error: ${err.message}`);
    }
    writeJsonAtomic(statePath, { ...state, pid: process.pid, updatedAt: ctx.deps.now().toISOString() });
    if (state.finished || state.halted) break;
    await sleep(intervalMs);
  }
  return state;
}
