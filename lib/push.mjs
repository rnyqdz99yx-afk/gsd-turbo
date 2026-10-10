import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { SECRET_RULES } from './secrets.mjs';
import { forbiddenName, maskOutput } from './push-guard.mjs';
import { splitZ } from './test-changed.mjs';
import { appendInbox } from './inbox.mjs';
import { CI_START_GRACE_MINUTES, ciVerdict, failedLogTail, isRed, parseRuns } from './ci.mjs';

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

const FETCH_TIMEOUT_MS = 120000;
// a pre-push hook slower than this fails the push; with the fetch, a tick stays inside the daemon's heartbeat window
const PUSH_TIMEOUT_MS = 300000;
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
const REQUEST_RE = /^p(.+)-push-request\.json$/;
const RECORD_RE = /^p(.+)-push\.json$/;
const firstLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 300);

// The phases that have a run file matching re.
function phasesWith(root, re) {
  let names = [];
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    return [];
  }
  return names.map((n) => re.exec(n)?.[1]).filter((p) => p && PHASE_ID.test(p)).sort();
}

// One request: branch, the pinned sha, fetch, ancestor check, scan, push. Every expected failure is recorded and
// notified; anything else throws, and the request stays for the next tick.
async function handleRequest(ctx, phase, now) {
  const { root, deps } = ctx;
  const { remote, ci } = ctx.config.push;
  const req = readJson(requestFile(root, phase), null);
  const prev = readJson(recordFile(root, phase), null);
  if (!validRequest(req) || prev?.requestId === req.id) return;
  const git = deps.git;
  const at = now.toISOString();
  const record = (outcome, fields) => {
    writeJsonAtomic(recordFile(root, phase), { requestId: req.id, phase: String(phase), remote, at, outcome, ...fields });
    deps.log(`push p${phase}: ${outcome}${fields.sha ? ` ${short(fields.sha)}` : ''}${fields.reason ? `: ${fields.reason}` : ''}`);
  };
  const failed = (reason, fields = {}) => {
    record('failed', { ...fields, reason });
    return deps.notify('pushFailed', { phase: String(phase), error: reason });
  };
  let branch;
  try {
    branch = String(git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  } catch (e) {
    if (e.status !== 1) throw e;
    return failed('HEAD is detached; turbo pushes a branch only');
  }
  // pinned once: a commit the lane makes during this tick is neither scanned nor pushed
  const sha = String(git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const base = `refs/remotes/${remote}/${branch}`;
  try {
    git(['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:${base}`], { timeout: FETCH_TIMEOUT_MS });
  } catch (e) {
    return failed(`git fetch ${remote} ${branch} failed: ${firstLine(e)}`, { branch, sha });
  }
  try {
    git(['merge-base', '--is-ancestor', base, sha]);
  } catch (e) {
    if (e.status !== 1) throw e;
    record('diverged', { branch, sha });
    return deps.notify('pushDiverged', { phase: String(phase), remote, branch });
  }
  const findings = scanRange(git, base, sha);
  if (findings.length) {
    // the same findings as this phase's last refusal (a false alarm every wave carries along) are not notified again
    const again = prev?.outcome === 'refused' && JSON.stringify(prev.findings) === JSON.stringify(findings);
    record('refused', { branch, sha, findings });
    return again ? undefined : deps.notify('pushRefused', { phase: String(phase), remote, branch, findings: listFindings(findings) });
  }
  // a daemon whose lease went during the fetch leaves the request to the new owner
  if (deps.leaseHeld && !deps.leaseHeld()) return;
  try {
    git(['push', '--quiet', remote, `${sha}:refs/heads/${branch}`], { timeout: PUSH_TIMEOUT_MS });
  } catch (e) {
    return failed(`git push to ${remote}/${branch} failed: ${firstLine(e)}`, { branch, sha });
  }
  record('pushed', { branch, sha, ci: ci === 'github' ? { state: 'pending', since: at, runs: [] } : { state: 'none', reason: 'push.ci is none' } });
  supersede(root, phase, sha, at);
}

// A newer push ends the CI watch of every other phase's earlier push: that result no longer says anything about HEAD.
function supersede(root, phase, sha, at) {
  for (const p of phasesWith(root, RECORD_RE)) {
    if (p === String(phase)) continue;
    const rec = readJson(recordFile(root, p), null);
    if (rec?.outcome === 'pushed' && rec.ci?.state === 'pending' && rec.sha !== sha) writeJsonAtomic(recordFile(root, p), { ...rec, ci: { ...rec.ci, state: 'superseded', doneAt: at } });
  }
}

// Each red run's failed log tail, masked, goes into the lane's inbox; the owner is told once.
async function reportRed(ctx, phase, rec, runs, save, at) {
  const { root, deps } = ctx;
  const red = runs.filter(isRed);
  for (const run of red) {
    let log = { job: '', step: '', tail: [] };
    let logError = '';
    try {
      log = failedLogTail(deps.gh(['run', 'view', String(run.id), '--log-failed']));
    } catch (e) {
      logError = firstLine(e);
    }
    appendInbox(root, phase, { kind: 'ci-red', sha: rec.sha, run: run.id, workflow: maskOutput(run.name).slice(0, 100), conclusion: run.conclusion, ...log, ...(logError ? { logError } : {}) }, { now: new Date(at) });
  }
  save({ state: 'red', runs, doneAt: at });
  deps.log(`ci p${phase}: red on ${short(rec.sha)}: ${red.map((r) => r.name).join(', ')}`);
  await deps.notify('ciRed', { phase: String(phase), sha: short(rec.sha), runs: red.map((r) => `${r.name} (${r.conclusion})`).join(', '), rounds: ctx.config.push.ci_fix_rounds });
}

// The CI runs of this phase's last push (spec §6, S2), once per tick, until all completed or push.ci_timeout_minutes
// passed (then ciTimeout; the lane is left alone). No run listed after CI_START_GRACE_MINUTES: no CI for this commit.
async function checkCi(ctx, phase, now) {
  const { root, deps } = ctx;
  const limit = ctx.config.push.ci_timeout_minutes;
  const rec = readJson(recordFile(root, phase), null);
  if (rec?.outcome !== 'pushed' || rec.ci?.state !== 'pending') return;
  const at = now.toISOString();
  const minutes = (now.getTime() - Date.parse(rec.ci.since)) / 60000;
  let runs = null;
  let error = '';
  try {
    runs = parseRuns(deps.gh(['run', 'list', '--commit', rec.sha, '--json', 'databaseId,name,status,conclusion']));
  } catch (e) {
    error = firstLine(e);
  }
  const seen = runs ?? (Array.isArray(rec.ci.runs) ? rec.ci.runs : []);
  const save = (ci) => writeJsonAtomic(recordFile(root, phase), { ...rec, ci: { ...rec.ci, ...ci, checkedAt: at } });
  const verdict = runs ? ciVerdict(runs) : 'pending';
  if (verdict === 'red' || (minutes >= limit && seen.some(isRed))) return reportRed(ctx, phase, rec, seen, save, at);
  if (verdict === 'green') {
    save({ state: 'green', runs, doneAt: at });
    return deps.log(`ci p${phase}: green on ${short(rec.sha)}`);
  }
  if (runs && !runs.length && minutes >= CI_START_GRACE_MINUTES) {
    save({ state: 'none', reason: `no CI run appeared within ${CI_START_GRACE_MINUTES} min`, runs, doneAt: at });
    return deps.log(`ci p${phase}: no CI run for ${short(rec.sha)}`);
  }
  if (minutes >= limit) {
    save({ state: 'timeout', runs: seen, error, doneAt: at });
    deps.log(`ci p${phase}: no result on ${short(rec.sha)} after ${limit} min`);
    return deps.notify('ciTimeout', { phase: String(phase), sha: short(rec.sha), minutes: limit, error: error ? `; last gh error: ${error}` : '' });
  }
  save({ runs: seen, error });
}

// The supervisor's push work in one tick (spec §6, S2). Nothing with push off, or once this daemon lost its lease.
// CI first: a run that finished before a newer push replaces the record is still reported. Each phase separately:
// an error is logged and the work stays for the next tick.
export async function pushTick(ctx, now) {
  const settings = ctx.config.push;
  const { root, deps } = ctx;
  if (!settings || settings.mode === 'off' || (deps.leaseHeld && !deps.leaseHeld())) return;
  for (const phase of phasesWith(root, RECORD_RE)) {
    try {
      await checkCi(ctx, phase, now);
    } catch (err) {
      deps.log(`ci p${phase}: ${firstLine(err)}`);
    }
  }
  for (const phase of phasesWith(root, REQUEST_RE)) {
    try {
      await handleRequest(ctx, phase, now);
    } catch (err) {
      deps.log(`push p${phase}: ${firstLine(err)}`);
    }
  }
}
