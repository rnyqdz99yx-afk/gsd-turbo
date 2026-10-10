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

// what gh prints when it has no usable login
const GH_LOGIN_RE = /gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i;
// the GitHub forms git prints for a remote: https://[user@]github.com/o/r[.git], ssh://[user@]github.com[:port]/o/r[.git]
// and user@github.com:o/r[.git]
const GITHUB_URL_RE = /^(?:(?:https?|ssh):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/|[^@/\s:]+@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;

// "owner/repo" of a GitHub remote URL, for gh -R; null for any other remote (gh would pick a repository by itself)
export function githubRepo(url) {
  const m = GITHUB_URL_RE.exec(String(url ?? '').trim());
  return m && m[2] !== '.' && m[2] !== '..' ? `${m[1]}/${m[2]}` : null;
}

// (args) => stdout of gh, run in the project. Never prompts; a failure is one masked line without the argv.
export function createGh(root, { exec = execFileSync, env = process.env } = {}) {
  return (args) => {
    try {
      return String(exec('gh', args, {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024, env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      }));
    } catch (err) {
      const missing = err?.code === 'ENOENT';
      const why = missing ? 'the GitHub CLI (gh) is not installed or not on PATH'
        : err?.code === 'ETIMEDOUT' ? `timed out after ${GH_TIMEOUT_MS / 1000} s`
          : tailLines(err?.stderr, 2) || (typeof err?.status === 'number' ? `exit status ${err.status}` : err?.code || 'failed');
      const e = new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${cut(maskOutput(why), 300)}`);
      // no gh or no login: waiting changes nothing, so the caller stops watching instead of waiting for the timeout
      if (missing || GH_LOGIN_RE.test(String(err?.stderr ?? ''))) e.unavailable = true;
      throw e;
    }
  };
}

// gh run list --json databaseId,name,status,conclusion → [{ id, name, status, conclusion }]; any other shape throws.
// Every text is masked here, so a run name reaches the record, the log and the notifications only masked.
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
    return { id: r.databaseId, name: maskOutput(r.name), status: maskOutput(r.status), conclusion: maskOutput(r.conclusion) };
  });
}

export const isRed = (run) => run.status === 'completed' && RED_CONCLUSIONS.includes(run.conclusion);

// pending while no run is listed or any run is not completed; then red when any run is red, cancelled when every run was
// cancelled, else green
export function ciVerdict(runs) {
  if (!runs.length || runs.some((r) => r.status !== 'completed')) return 'pending';
  if (runs.some(isRed)) return 'red';
  // every run cancelled (skipped ones beside them change nothing): nothing was tested, so neither green nor red
  if (runs.some((r) => r.conclusion === 'cancelled') && runs.every((r) => r.conclusion === 'cancelled' || r.conclusion === 'skipped')) return 'cancelled';
  return 'green';
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
