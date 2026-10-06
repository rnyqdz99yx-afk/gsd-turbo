import path from 'node:path';
import { nextPhase, relaunchDecision } from './scheduler.mjs';
import { inferStatus, isAgentAlive, readLaneStatus, writeLaneStatus } from './run-status.mjs';
import { laneSessionName } from './claude.mjs';
import { laneSystemPrompt, laneUserPrompt } from './lane-prompt.mjs';
import { writeJsonAtomic } from './fsx.mjs';

const SUPERVISOR_LOG = '.planning/turbo/logs/supervisor.log';

// Same normalization as laneSessionName: resolved, forward slashes, case-insensitive on win32.
function dirKey(p) {
  const key = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

// Sessions of this lane: the lane name AND started in this checkout. An empty cwd never
// matches (path.resolve('') would be the supervisor's own working directory).
function laneAgents(agents, root, phase, exclude = null) {
  const name = laneSessionName(root, phase);
  const home = dirKey(root);
  return agents.filter((a) => a.id !== exclude && a.name === name && Boolean(a.cwd) && dirKey(a.cwd) === home);
}

// Adopts an alive session of this lane (for example one whose --bg call timed out after it
// registered) instead of launching a duplicate. Throws when launchBg throws.
function startLane(phase, agents, ctx, { resume, exclude, at }) {
  const { root, config, turboRun, deps } = ctx;
  const name = laneSessionName(root, phase.number);
  const alive = laneAgents(agents, root, phase.number, exclude).find(isAgentAlive);
  if (alive) {
    deps.log(`adopt phase ${phase.number} session ${alive.id}`);
    return { sessionId: alive.id, name };
  }
  const sessionId = deps.claude.launchBg({
    name,
    prompt: laneUserPrompt({ phase: phase.number, resume }),
    systemPrompt: laneSystemPrompt({ phase: phase.number, turboRun, contextPct: config.context_stop_pct, autonomy: config.autonomy }),
    permissionMode: config.lane_permission_mode,
    model: config.lane_model,
  }, root);
  // Written only after a successful launch: a failed launch leaves the lane record
  // (paused-context, needs-owner) as it was, so the next tick reaches the same decision.
  writeLaneStatus(root, phase.number, 'running', { sessionId, at });
  deps.log(`launch phase ${phase.number} session ${sessionId}${resume ? ' (resume)' : ''}`);
  return { sessionId, name };
}

// null when the launch failed; the caller then leaves the state as it was and the next tick retries.
function tryStartLane(phase, agents, ctx, opts) {
  try {
    return startLane(phase, agents, ctx, opts);
  } catch (err) {
    ctx.deps.log(`launch phase ${phase.number} failed: ${err.message}`);
    return null;
  }
}

function removeSession(ctx, id) {
  try {
    ctx.deps.claude.rm(id);
  } catch {
    // already gone
  }
}

export async function tick(state, ctx) {
  const { root, config, deps } = ctx;
  const s = structuredClone(state);
  const phases = deps.loadPhases();
  const agents = deps.claude.list();
  const now = deps.now();
  const at = now.toISOString();

  if (!s.lane) {
    const p = nextPhase(phases);
    if (!p) {
      if (phases.every((x) => x.complete)) {
        deps.log('milestone done');
        await deps.notify('milestoneDone', {});
        s.finished = true;
      }
      return s;
    }
    const started = tryStartLane(p, agents, ctx, { resume: false, exclude: null, at });
    if (started) s.lane = { phase: p.number, ...started, launchedAt: at, restarts: 0, fingerprint: deps.fingerprint(p), notified: {}, blockedSince: null };
    return s;
  }

  const lane = s.lane;
  lane.notified ??= {};
  const phase = phases.find((x) => x.number === lane.phase) || { number: lane.phase, complete: false, verification: null };
  if (lane.forceRelaunch) {
    removeSession(ctx, lane.sessionId);
    const started = tryStartLane(phase, agents, ctx, { resume: true, exclude: lane.sessionId, at });
    if (started) Object.assign(lane, started, { launchedAt: at, restarts: 0, fingerprint: deps.fingerprint(phase), notified: {}, blockedSince: null, forceRelaunch: false });
    return s;
  }

  const mine = laneAgents(agents, root, lane.phase);
  const agent = agents.find((a) => a.id === lane.sessionId) || mine.find(isAgentAlive) || mine[0];
  if (agent && agent.id !== lane.sessionId) {
    deps.log(`phase ${lane.phase}: session ${lane.sessionId} not listed, following ${agent.id}`);
    lane.sessionId = agent.id;
  }
  const record = readLaneStatus(root, lane.phase);
  const status = inferStatus({ agent, laneRecord: record, launchedAt: lane.launchedAt, phase });

  if (status === 'running') {
    lane.blockedSince = null;
    lane.notified.blocked = false;
    return s;
  }
  if (status === 'blocked') {
    lane.blockedSince ||= at;
    const waited = (now - Date.parse(lane.blockedSince)) / 60000;
    if (waited >= config.blocked_minutes_before_notify && !lane.notified.blocked) {
      deps.log(`phase ${lane.phase} blocked for ${Math.floor(waited)} min`);
      await deps.notify('laneBlocked', { phase: lane.phase, id: lane.sessionId });
      lane.notified.blocked = true;
    }
    return s;
  }
  if (status === 'done') {
    deps.log(`phase ${lane.phase} done`);
    await deps.notify('phaseDone', { phase: lane.phase });
    removeSession(ctx, lane.sessionId);
    s.lane = null;
    return s;
  }
  if (status === 'paused-context') {
    const fp = deps.fingerprint(phase);
    const d = relaunchDecision({ restarts: lane.restarts, progressed: fp !== lane.fingerprint, maxRestarts: config.max_restarts_without_progress });
    if (d.action === 'halt') {
      deps.log(`phase ${lane.phase} halted: no progress after ${lane.restarts} restarts`);
      await deps.notify('laneHalted', { phase: lane.phase, restarts: lane.restarts, log: SUPERVISOR_LOG });
      s.halted = true;
      return s;
    }
    removeSession(ctx, lane.sessionId);
    const started = tryStartLane(phase, agents, ctx, { resume: true, exclude: lane.sessionId, at });
    if (started) Object.assign(lane, started, { launchedAt: at, restarts: d.restarts, fingerprint: fp, notified: {}, blockedSince: null });
    return s;
  }
  if (status === 'needs-owner') {
    if (!lane.notified.owner) {
      deps.log(`phase ${lane.phase} needs the owner`);
      const reason = record?.status === 'needs-owner' && record.reason ? record.reason : 'human verification';
      await deps.notify('laneNeedsOwner', { phase: lane.phase, reason });
      lane.notified.owner = true;
    }
    return s;
  }
  deps.log(`phase ${lane.phase} failed: session ${lane.sessionId}`);
  await deps.notify('laneFailed', { phase: lane.phase, id: lane.sessionId });
  s.halted = true;
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
