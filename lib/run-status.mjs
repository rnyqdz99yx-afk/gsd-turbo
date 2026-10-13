import path from 'node:path';
import { runDir } from './paths.mjs';
import { writeJsonAtomic, readJson } from './fsx.mjs';

// Stage 4 L1 (D3): ready (a phase lane integrated, L2 merges it), prepped and annotated (a job ended, L3 merges it).
// Checkout mode never writes them; inferStatus reads them like any status it does not trust (lanes-state DONE_STATUSES).
export const LANE_STATUSES = ['running', 'paused-context', 'needs-owner', 'done', 'failed', 'ready', 'prepped', 'annotated'];
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

// True for a session that has ended, or that finished its turn (listed blocked, see inferStatus).
// Such a session still counts as alive for removal: `claude rm` must succeed before a relaunch.
export function turnEnded(agent) {
  return !isAgentAlive(agent) || BLOCKED.has(agent?.state || '');
}

// The agent's state when it is none of the known ones, else ''.
export function unknownAgentState(agent) {
  const state = agent?.state || '';
  return state && !LIVE.has(state) && !BLOCKED.has(state) && !ENDED.has(state) ? state : '';
}

export function inferStatus({ agent, laneRecord, launchedAt, phase, mode = 'safe' }) {
  const state = agent?.state || '';
  if (LIVE.has(state)) return 'running';
  // A session that finished its turn stays listed as blocked (status idle, Claude Code 2.1.292). Lanes
  // run without AskUserQuestion and with bypassPermissions, so blocked means the turn ended: it is
  // inferred like an ended session, but without a decision it waits as blocked (the owner is notified
  // after blocked_minutes_before_notify) instead of the paused-context / failed fallbacks.
  const blocked = BLOCKED.has(state);
  // unknown state: wait
  if (state && !blocked && !ENDED.has(state)) return 'blocked';
  const fresh = Boolean(laneRecord && launchedAt && Date.parse(laneRecord.at) >= Date.parse(launchedAt));
  // Full mode: GSD marks the phase complete inside execute-phase (G9), before turbo's fan-out,
  // fixes and UAT. Only the lane's own fresh done record ends a /turbo-phase lane.
  if (phase?.complete && (mode !== 'full' || (fresh && laneRecord.status === 'done'))) return 'done';
  if (fresh && TRUSTED.has(laneRecord.status)) return laneRecord.status;
  if (mode !== 'full' && phase?.verification === 'human_needed') return 'needs-owner';
  if (blocked) return 'blocked';
  if (state === 'failed') return 'failed';
  return 'paused-context';
}
// spec §6 (L3, D11): prep and annotate jobs record their statuses as lane records, where L1 reads them (its recordKey):
// p<N>.json for a prep job, pannotate.json for the annotate job. Each kind takes only its own statuses.
export const JOB_STATUSES = Object.freeze({ prep: ['running', 'paused-context', 'failed', 'prepped'], annotate: ['running', 'paused-context', 'failed', 'annotated'] });
// L0's supervisor.json.lanes key, and L1's record key
export const jobKey = (job) => (job.kind === 'annotate' ? 'annotate' : `${job.kind}-${job.phase}`);
export const jobRecordKey = (job) => (job.kind === 'annotate' ? 'annotate' : String(job.phase));

export function writeJobStatus(root, job, status, { reason = '', at = new Date().toISOString() } = {}) {
  const allowed = Object.hasOwn(JOB_STATUSES, job?.kind) ? JOB_STATUSES[job.kind] : null;
  if (!allowed || !allowed.includes(status)) throw new Error(`unknown ${job?.kind} status: ${status}`);
  return writeLaneStatus(root, jobRecordKey(job), status, { reason, at });
}

export const readJobStatus = (root, job) => readLaneStatus(root, jobRecordKey(job));

// D11, D12: the last annotate status with the ROADMAP digest it ran on; a failed markup is not retried on the same one.
const attemptFile = (root) => path.join(runDir(root), 'annotate-attempt.json');
export function writeAnnotateAttempt(root, { status, roadmapSha256 = null, at = new Date().toISOString() }) {
  const rec = { status, roadmapSha256, at };
  writeJsonAtomic(attemptFile(root), rec);
  return rec;
}
export const readAnnotateAttempt = (root) => readJson(attemptFile(root), null);
