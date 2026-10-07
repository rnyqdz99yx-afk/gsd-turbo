import path from 'node:path';
import { runDir } from './paths.mjs';
import { writeJsonAtomic, readJson } from './fsx.mjs';

export const LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed'];
const file = (root, phase) => path.join(runDir(root), `p${phase}.json`);

export function writeLaneStatus(root, phase, status, { reason = '', sessionId = '', at = new Date().toISOString() } = {}) {
  if (!LANE_STATUSES.includes(status)) throw new Error(`unknown lane status: ${status}`);
  const rec = { phase: String(phase), status, reason, sessionId, at };
  writeJsonAtomic(file(root, phase), rec);
  return rec;
}

export function readLaneStatus(root, phase) {
  return readJson(file(root, phase), null);
}

const LIVE = new Set(['working', 'busy']);
const BLOCKED = new Set(['blocked', 'waiting']);
// States of a session that has finished; `stopped` is what `claude stop` leaves listed.
// An empty or missing state counts as finished too.
const ENDED = new Set(['done', 'failed', 'idle', 'stopped']);
// Lane-record statuses GSD cannot infer itself; 'done' needs GSD completion.
const TRUSTED = new Set(['needs-owner', 'paused-context', 'failed']);

// Any state that is not known to be ended counts as alive: `claude rm` kills a running
// session, and a relaunch next to a live one runs two lanes in the same checkout.
export function isAgentAlive(agent) {
  const state = agent?.state || '';
  return Boolean(state) && !ENDED.has(state);
}

// The agent's state when it is none of the known ones, else ''.
export function unknownAgentState(agent) {
  const state = agent?.state || '';
  return state && !LIVE.has(state) && !BLOCKED.has(state) && !ENDED.has(state) ? state : '';
}

export function inferStatus({ agent, laneRecord, launchedAt, phase, mode = 'safe' }) {
  const state = agent?.state || '';
  const fresh = Boolean(laneRecord && launchedAt && Date.parse(laneRecord.at) >= Date.parse(launchedAt));
  if (LIVE.has(state)) return 'running';
  // A lane that wrote its record and ended its turn stays listed as blocked (Claude Code 2.1.292):
  // its fresh trusted record decides. Without one, wait (the owner is notified after blocked_minutes_before_notify).
  if (BLOCKED.has(state)) return fresh && TRUSTED.has(laneRecord.status) ? laneRecord.status : 'blocked';
  // unknown state: wait
  if (state && !ENDED.has(state)) return 'blocked';
  // Full mode: GSD marks the phase complete inside execute-phase (G9), before turbo's fan-out,
  // fixes and UAT. Only the lane's own fresh done record ends a /turbo-phase lane.
  if (phase?.complete && (mode !== 'full' || (fresh && laneRecord.status === 'done'))) return 'done';
  if (fresh && TRUSTED.has(laneRecord.status)) return laneRecord.status;
  if (mode !== 'full' && phase?.verification === 'human_needed') return 'needs-owner';
  if (state === 'failed') return 'failed';
  return 'paused-context';
}
