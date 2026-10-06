import path from 'node:path';
import { runDir } from './paths.mjs';
import { writeJsonAtomic, readJson } from './fsx.mjs';

export const LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed'];
const file = (root, phase) => path.join(runDir(root), `p${phase}.json`);

export function writeLaneStatus(root, phase, status, { reason = '', sessionId = '' } = {}) {
  if (!LANE_STATUSES.includes(status)) throw new Error(`unknown lane status: ${status}`);
  const rec = { phase: String(phase), status, reason, sessionId, at: new Date().toISOString() };
  writeJsonAtomic(file(root, phase), rec);
  return rec;
}

export function readLaneStatus(root, phase) {
  return readJson(file(root, phase), null);
}

const LIVE = new Set(['working', 'busy']);
const BLOCKED = new Set(['blocked', 'waiting']);

export function inferStatus({ agent, laneRecord, launchedAt, phase }) {
  const state = agent?.state || '';
  if (LIVE.has(state)) return 'running';
  if (BLOCKED.has(state)) return 'blocked';
  if (phase?.complete) return 'done';
  const fresh = laneRecord && launchedAt && Date.parse(laneRecord.at) >= Date.parse(launchedAt);
  if (fresh && laneRecord.status !== 'running') return laneRecord.status;
  if (phase?.verification === 'human_needed') return 'needs-owner';
  if (state === 'failed') return 'failed';
  return 'paused-context';
}
