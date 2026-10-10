import { execFileSync } from 'node:child_process';
import { maskOutput } from './push-guard.mjs';
import { MASK } from './secrets.mjs';

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
// an operating system command (a terminal hyperlink, a window title), ended by BEL or ESC backslash
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const noEscapes = (s) => String(s ?? '').replace(OSC_RE, '').replace(ANSI_RE, '');
// every control character but a tab
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const STAMP_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// a text gh printed, masked, with no control character left: a run name cannot add lines or colours to a log
const oneLine = (s) => maskOutput(noEscapes(s)).replace(/[\x00-\x1f\x7f]/g, '');
const KEY_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/;
// by code points, after masking: a cut never splits a secret so that the rest escapes the mask
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const tailLines = (s, n) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(' / ');

// what gh prints when it has no usable login
const GH_LOGIN_RE = /gh auth login|not logged in|authentication required|HTTP 401|Bad credentials/i;
// a repository that does not exist for gh, or that this login cannot see
const GH_NO_REPO_RE = /Could not resolve to a Repository|HTTP 404/i;
// the URL forms git prints for a remote: scheme://[user@]host[:port]/path and the scp-like user@host:path
const URL_FORM_RE = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i;
const SCP_FORM_RE = /^[^@/\s:]+@([^/:\s]+):(?!\/)(.+)$/;
const OWNER_REPO_RE = /^\/?([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'ssh.github.com']);
// forges that are clearly not GitHub: no gh call for them
const NOT_GITHUB_RE = /(^|\.)(gitlab\.com|bitbucket\.org|codeberg\.org|gitea\.com|dev\.azure\.com|visualstudio\.com|sr\.ht|sourceforge\.net)$/;

// The repository of a remote URL for gh -R: "owner/repo" on github.com, "host/owner/repo" on any other host (GitHub
// Enterprise; gh decides whether it knows the host); null for local paths, other forges and anything without an owner
// and a repository (gh would otherwise pick a repository by itself).
export function githubRepo(url) {
  const s = String(url ?? '').trim();
  const m = URL_FORM_RE.exec(s) ?? SCP_FORM_RE.exec(s);
  const p = m && OWNER_REPO_RE.exec(m[2]);
  if (!p || p[2] === '.' || p[2] === '..') return null;
  const host = m[1].toLowerCase();
  if (NOT_GITHUB_RE.test(host)) return null;
  return GITHUB_HOSTS.has(host) ? `${p[1]}/${p[2]}` : `${host}/${p[1]}/${p[2]}`;
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
      // no gh, no login, no such repository, or a host other than github.com that gh cannot reach: waiting changes
      // nothing, so the caller stops watching instead of waiting for the timeout
      const stderr = String(err?.stderr ?? '');
      const otherHost = String(args[args.indexOf('-R') + 1] ?? '').split('/').length === 3 && args.includes('-R');
      if (missing || GH_LOGIN_RE.test(stderr) || GH_NO_REPO_RE.test(stderr) || (otherHost && /error connecting to/i.test(stderr))) e.unavailable = true;
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
    return { id: r.databaseId, name: oneLine(r.name), status: oneLine(r.status), conclusion: oneLine(r.conclusion) };
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
  // inside a private key block every line is masked, not only its header (each log line carries its own prefix)
  let inKey = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const clean = noEscapes(raw).replace(CONTROL_RE, '');
    if (!clean.trim()) continue;
    const parts = clean.split('\t');
    let line = clean;
    if (parts.length >= 3) {
      [job, step] = parts;
      line = parts.slice(2).join('\t').replace(STAMP_RE, '');
    }
    if (inKey || KEY_BEGIN_RE.test(line)) {
      inKey = !KEY_END_RE.test(line);
      line = MASK;
    }
    texts.push(line);
  }
  return { job: cut(maskOutput(job), 100), step: cut(maskOutput(step), 200), tail: texts.slice(-lines).map((l) => cut(maskOutput(l), LINE_CHARS)) };
}
