import { execFileSync } from 'node:child_process';
import { maskOutput } from './push-guard.mjs';

// GitHub Actions through the gh CLI (spec §6, S2): gh run list --commit <sha> and gh run view <id> --log-failed.
const GH_TIMEOUT_MS = 60000;
// No run listed for a pushed commit within this many minutes: no workflow runs for it (path filters, no CI at all).
export const CI_START_GRACE_MINUTES = 5;
// Conclusions that make CI red. cancelled (a newer push often cancels a run), skipped, neutral, stale and
// action_required do not.
export const RED_CONCLUSIONS = Object.freeze(['failure', 'timed_out', 'startup_failure']);
const TAIL_LINES = 200;
const LINE_CHARS = 400;
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
// every control character but a tab
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const STAMP_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// by code points, after masking: a cut never splits a secret so that the rest escapes the mask
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const tailLines = (s, n) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(' / ');

// (args) => stdout of gh, run in the project. Never prompts; a failure is one masked line without the argv.
export function createGh(root, { exec = execFileSync, env = process.env } = {}) {
  return (args) => {
    try {
      return String(exec('gh', args, {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024, env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      }));
    } catch (err) {
      const why = err?.code === 'ETIMEDOUT' ? `timed out after ${GH_TIMEOUT_MS / 1000} s` : tailLines(err?.stderr, 2) || (typeof err?.status === 'number' ? `exit status ${err.status}` : err?.code || 'failed');
      throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${cut(maskOutput(why), 300)}`);
    }
  };
}

// gh run list --json databaseId,name,status,conclusion → [{ id, name, status, conclusion }]; any other shape throws.
export function parseRuns(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('gh run list output is not JSON');
  }
  if (!Array.isArray(data)) throw new Error('gh run list output is not a JSON array');
  return data.map((r, i) => {
    if (!r || typeof r !== 'object' || !Number.isInteger(r.databaseId) || typeof r.status !== 'string') throw new Error(`gh run list entry ${i} has no databaseId or status`);
    return { id: r.databaseId, name: String(r.name ?? ''), status: r.status, conclusion: String(r.conclusion ?? '') };
  });
}

export const isRed = (run) => run.status === 'completed' && RED_CONCLUSIONS.includes(run.conclusion);

// pending while no run is listed or any run is not completed; then red when any run is red, else green
export function ciVerdict(runs) {
  if (!runs.length || runs.some((r) => r.status !== 'completed')) return 'pending';
  return runs.some(isRed) ? 'red' : 'green';
}

// gh run view <id> --log-failed prints "<job>\t<step>\t<timestamp> <text>" per line. Returns the job and step of
// the last such line and the last texts, without colour codes, masked, each cut to LINE_CHARS.
export function failedLogTail(text, { lines = TAIL_LINES } = {}) {
  let job = '';
  let step = '';
  const texts = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const clean = raw.replace(ANSI_RE, '').replace(CONTROL_RE, '');
    if (!clean.trim()) continue;
    const parts = clean.split('\t');
    if (parts.length >= 3) {
      [job, step] = parts;
      texts.push(parts.slice(2).join('\t').replace(STAMP_RE, ''));
    } else {
      texts.push(clean);
    }
  }
  return { job: cut(maskOutput(job), 100), step: cut(maskOutput(step), 200), tail: texts.slice(-lines).map((l) => cut(maskOutput(l), LINE_CHARS)) };
}
