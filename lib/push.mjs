import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { SECRET_RULES } from './secrets.mjs';
import { forbiddenName, maskOutput } from './push-guard.mjs';
import { splitZ } from './test-changed.mjs';

// Push and CI (spec §6, S2). A lane asks with turbo-run push-request (p<N>-push-request.json, written only by the
// lane); the supervisor, the only process that pushes, answers in p<N>-push.json (written only by the supervisor).
export const requestFile = (root, phase) => path.join(runDir(root), `p${phase}-push-request.json`);
export const recordFile = (root, phase) => path.join(runDir(root), `p${phase}-push.json`);

const GIT_BASE = ['-c', 'core.quotepath=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
const GIT_TIMEOUT_MS = 60000;
// git must never wait for a password: no terminal prompt, no credential-manager window
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const UNREADABLE = { file: '(a file name that is not UTF-8)', kind: 'unreadable file name' };

export const short = (sha) => String(sha ?? '').slice(0, 7);
const tailLines = (s, n) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(' / ');

// (args, { timeout, encoding }) => stdout of git in the project; encoding 'buffer' returns the bytes. A failure throws
// the last stderr lines, masked, as one line (never Node's "Command failed: <argv>"), with git's exit status.
export function createGit(root, { exec = execFileSync, env = process.env } = {}) {
  return (args, { timeout = GIT_TIMEOUT_MS, encoding = 'utf8' } = {}) => {
    try {
      return exec('git', [...GIT_BASE, ...args], {
        cwd: root, encoding, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024 * 1024, env: { ...env, ...NO_PROMPT },
      });
    } catch (err) {
      const why = err?.code === 'ETIMEDOUT' ? `timed out after ${timeout / 1000} s` : tailLines(err?.stderr, 3) || (typeof err?.status === 'number' ? `exit status ${err.status}` : err?.code || 'failed');
      throw Object.assign(new Error([...maskOutput(why)].slice(0, 300).join('')), { status: typeof err?.status === 'number' ? err.status : null });
    }
  };
}

// HEAD, or null before the first commit (an unborn HEAD exits 1 under --verify -q).
function headOf(git) {
  try {
    return String(git(['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
  } catch (e) {
    if (e.status === 1) return null;
    throw e;
  }
}

export const validRequest = (r) => Boolean(r) && typeof r.id === 'string' && REQUEST_ID.test(r.id) && typeof r.head === 'string' && SHA_RE.test(r.head);

// Every finding in the commits <base>..<sha>, merges included, as { file, kind }: a forbidden name among the files
// they add or change, and a secret rule on any line they add. Never the value.
export function scanRange(git, base, sha) {
  const range = `${base}..${sha}`;
  const found = new Map();
  const add = (file, kind) => found.set(`${file}\0${kind}`, { file, kind });
  const z = splitZ(git(['log', '--format=', '--name-only', '-z', '--no-renames', '--diff-filter=d', '-m', range], { encoding: 'buffer' }));
  // a name that is not UTF-8 cannot be checked: refused, never skipped
  if (z.bad) add(UNREADABLE.file, UNREADABLE.kind);
  for (const raw of z.names) {
    const file = raw.replace(/^\n+/, '');
    const kind = file && forbiddenName(file);
    if (kind) add(file, kind);
  }
  const patch = String(git(['log', '--format=', '-p', '-m', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--unified=0', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', range]));
  let file = null;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      const name = line.slice(4).replace(/\r$/, '');
      file = name === '/dev/null' ? null : name.replace(/^"?b\//, '').replace(/"$/, '');
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && file && line.startsWith('+')) {
      const text = line.slice(1);
      for (const [rule, re] of SECRET_RULES) if (re.test(text)) add(file, rule);
    }
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...found.values()].sort((a, b) => order(a.file, b.file) || order(a.kind, b.kind));
}

// "a.log (forbidden name *.log), c.mjs (github token)": at most five, then how many more
export function listFindings(findings) {
  const shown = findings.slice(0, 5).map((f) => `${f.file} (${f.kind})`).join(', ');
  return findings.length > 5 ? `${shown} and ${findings.length - 5} more` : shown;
}

// The lane's ask (spec §6, S2). point: 'wave' (after a wave; after-wave mode only), 'phase' (the end of a phase) or
// null (after a CI fix, a plan that pushes). The same head asked again keeps its request, unless that request
// ended without a push.
export function requestPush({ root, phase, point = null, settings, git, now = new Date(), newId = randomUUID }) {
  if (settings.mode === 'off') return { code: 0, line: 'push off: nothing requested (push.mode in .planning/turbo/config.json)' };
  if (point === 'wave' && settings.mode !== 'after-wave') return { code: 0, line: `push ${settings.mode}: nothing requested at a wave` };
  const head = headOf(git);
  if (!head) return { code: 0, line: 'nothing to push: no commit yet' };
  const prev = readJson(requestFile(root, phase), null);
  const rec = readJson(recordFile(root, phase), null);
  if (validRequest(prev) && prev.head === head && (rec?.requestId !== prev.id || rec.outcome === 'pushed')) {
    return { code: 0, request: prev, line: `push already requested: ${short(head)}` };
  }
  const request = { id: newId(), phase: String(phase), head, at: now.toISOString() };
  writeJsonAtomic(requestFile(root, phase), request);
  return { code: 0, request, line: `push requested: ${short(head)} (the supervisor pushes it at its next check)` };
}
