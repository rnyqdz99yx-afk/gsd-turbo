import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { SECRET_RULES } from './secrets.mjs';
import { forbiddenName, maskOutput } from './push-guard.mjs';
import { splitZ } from './test-changed.mjs';
import { appendInbox } from './inbox.mjs';
import { CI_START_GRACE_MINUTES, ciVerdict, failedLogTail, githubRepo, isRed, parseRuns } from './ci.mjs';

// Push and CI (spec §6, S2). A lane asks with turbo-run push-request (p<N>-push-request.json, written only by the
// lane); the supervisor, the only process that pushes, answers in p<N>-push.json (written only by the supervisor).
export const requestFile = (root, phase) => path.join(runDir(root), `p${phase}-push-request.json`);
export const recordFile = (root, phase) => path.join(runDir(root), `p${phase}-push.json`);

// log.showSignature off: a signature check would print its verdict into the output turbo parses
const GIT_BASE = ['-c', 'core.quotepath=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'log.showSignature=false'];
const GIT_TIMEOUT_MS = 60000;
// git must never wait for a password: no terminal prompt, no credential-manager window
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const UNREADABLE = { file: '(a file name that is not UTF-8)', kind: 'unreadable file name' };
// the version or oid line a Git LFS pointer file adds (https://git-lfs.github.com/spec/v1)
const LFS_POINTER_RE = /^(version https:\/\/git-lfs\.github\.com\/spec\/v1|oid sha256:[0-9a-f]{64})$/;
const LFS_KIND = 'lfs-content-not-scanned';

export const short = (sha) => String(sha ?? '').slice(0, 7);
const tailLines = (s, n) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(' / ');

// git commands that may reach a remote over ssh
const NETWORK = new Set(['fetch', 'push', 'ls-remote']);
const TREE_TIMEOUT = fileURLToPath(new URL('./tree-timeout.mjs', import.meta.url));
const TREE_TIMED_OUT = 'turbo: timed out';
const TREE_BACKSTOP_MS = 15000;
// the subcommand of a git argument list, after any -c <key=value> pairs
const subcommand = (args) => args[args.findIndex((a, i) => !a.startsWith('-') && args[i - 1] !== '-c')];

// The ssh command git would use (GIT_SSH_COMMAND, then core.sshCommand, then plain ssh) with -o BatchMode=yes appended,
// so a key that needs a passphrase fails at once instead of waiting for the time limit; null leaves git's choice as it
// is. Only for OpenSSH: GIT_SSH (a program, no arguments), another program (plink) or another GIT_SSH_VARIANT stay as
// configured.
function batchSsh(env, configured) {
  const cmd = String(env.GIT_SSH_COMMAND || configured || (env.GIT_SSH ? '' : 'ssh')).trim();
  if (!cmd || !['', 'auto', 'ssh'].includes(String(env.GIT_SSH_VARIANT ?? '').toLowerCase())) return null;
  const first = /^(["'])(.*?)\1/.exec(cmd)?.[2] ?? cmd.split(/\s+/)[0];
  return /^ssh(\.exe)?$/i.test(first.split(/[\\/]/).pop()) ? `${cmd} -o BatchMode=yes` : null;
}

// (args, { timeout, encoding }) => stdout of git in the project; encoding 'buffer' returns the bytes. A failure throws
// the last stderr lines, masked, as one line (never Node's "Command failed: <argv>"), with git's exit status.
export function createGit(root, { exec = execFileSync, env = process.env } = {}) {
  const opts = (timeout, encoding, extra = {}) => ({
    cwd: root, encoding, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024 * 1024, env: { ...env, ...NO_PROMPT, ...extra },
  });
  // read once, at the first command that may use ssh
  let ssh;
  const sshEnv = () => {
    if (ssh === undefined) {
      let configured = '';
      if (!env.GIT_SSH_COMMAND) {
        try {
          const out = exec('git', [...GIT_BASE, 'config', '--get', 'core.sshCommand'], opts(10000, 'utf8'));
          configured = typeof out === 'string' ? out.trim() : '';
        } catch {
          // unset (exit 1) or unreadable: git falls back the same way
        }
      }
      ssh = batchSsh(env, configured);
    }
    return ssh ? { GIT_SSH_COMMAND: ssh } : {};
  };
  return (args, { timeout = GIT_TIMEOUT_MS, encoding = 'utf8' } = {}) => {
    const network = NETWORK.has(subcommand(args));
    try {
      // fetch and push start hooks, ssh and remote helpers: their time limit ends the whole tree (lib/tree-timeout.mjs);
      // the wrapper's own limit, a little later, is only a backstop
      if (network) return exec(process.execPath, [TREE_TIMEOUT, String(timeout), 'git', ...GIT_BASE, ...args], opts(timeout + TREE_BACKSTOP_MS, encoding, sshEnv()));
      return exec('git', [...GIT_BASE, ...args], opts(timeout, encoding));
    } catch (err) {
      const treeTimedOut = network && err?.status === 124 && String(err?.stderr ?? '').includes(TREE_TIMED_OUT);
      const why = err?.code === 'ETIMEDOUT' || treeTimedOut ? `timed out after ${timeout / 1000} s` : tailLines(err?.stderr, 3) || (typeof err?.status === 'number' ? `exit status ${err.status}` : err?.code || 'failed');
      throw Object.assign(new Error([...maskOutput(why)].slice(0, 300).join('')), { status: typeof err?.status === 'number' && !treeTimedOut ? err.status : null });
    }
  };
}

// A boolean git setting; unset (exit 1) reads as false.
function configBool(git, key) {
  try {
    return String(git(['config', '--get', '--bool', key])).trim() === 'true';
  } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}

// A sha of rev, or null when it names no commit (an unborn branch exits 1 under --verify -q).
function commitOf(git, rev) {
  try {
    return String(git(['rev-parse', '--verify', '-q', `${rev}^{commit}`])).trim() || null;
  } catch (e) {
    if (e.status === 1) return null;
    throw e;
  }
}

// The branch HEAD is on, or null when it is detached. symbolic-ref without --short: a tag of the same name would turn
// "main" into "heads/main".
function currentBranch(git) {
  let ref;
  try {
    ref = String(git(['symbolic-ref', '-q', 'HEAD'])).trim();
  } catch (e) {
    if (e.status === 1) return null;
    throw e;
  }
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

// a branch name git could write, and nothing a refspec or an option could read otherwise
const validBranch = (b) => typeof b === 'string' && b.length > 0 && b.length <= 255 && !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/.test(b);
export const validRequest = (r) => Boolean(r) && typeof r.id === 'string' && REQUEST_ID.test(r.id) && typeof r.head === 'string' && SHA_RE.test(r.head)
  && (r.branch === null || validBranch(r.branch));

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
// A path as git C-quotes it in a diff header ("…" with \t, \", \\ and octal byte escapes) back to the path; an unquoted
// path unchanged.
function unquotePath(s) {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const parts = [];
  for (const [tok, esc] of s.slice(1, -1).matchAll(/\\([0-7]{3}|.)|[^\\]+/gs)) {
    if (esc === undefined) parts.push(Buffer.from(tok, 'utf8'));
    else parts.push(Buffer.from([/^[0-7]{3}$/.test(esc) ? parseInt(esc, 8) : (C_ESCAPES[esc] ?? esc.charCodeAt(0) & 0xff)]));
  }
  return Buffer.concat(parts).toString('utf8');
}

// Every finding in the commits <base>..<sha>, merges included, as { file, kind }: a forbidden name among the files
// they add or change, and a secret rule on any line they add. Never the value.
export function scanRange(git, base, sha) {
  const range = `${base}..${sha}`;
  const found = new Map();
  // a file name is shown, so it is masked like any other text from git
  const add = (file, kind) => {
    const shown = maskOutput(file);
    found.set(`${shown}\0${kind}`, { file: shown, kind });
  };
  // merges shown against each parent, whatever log.diffMerges says (a combined diff hides the files a merge takes over)
  const z = splitZ(git(['log', '--format=', '--name-only', '-z', '--no-show-signature', '--no-renames', '--diff-filter=d', '--diff-merges=separate', range], { encoding: 'buffer' }));
  // a name that is not UTF-8 cannot be checked: refused, never skipped
  if (z.bad) add(UNREADABLE.file, UNREADABLE.kind);
  for (const raw of z.names) {
    const file = raw.replace(/^\n+/, '');
    const kind = file && forbiddenName(file);
    if (kind) add(file, kind);
  }
  // --text: a file git calls binary (a NUL byte, a -diff or binary attribute) is scanned as text, never skipped
  const patch = String(git(['log', '--format=', '-p', '--text', '--diff-merges=separate', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--unified=0', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', range]));
  let file = null;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff ')) {
      // any header form (diff --git, diff --cc, diff --combined) starts a new file
      file = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      // git ends an unquoted path that holds a space with a tab; a real trailing tab would have been quoted
      const name = line.slice(4).replace(/\r$/, '').replace(/\t$/, '');
      file = name === '/dev/null' ? null : unquotePath(name).replace(/^b\//, '');
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && file && line.startsWith('+')) {
      const text = line.slice(1);
      for (const [rule, re] of SECRET_RULES) if (re.test(text)) add(file, rule);
      // a Git LFS pointer: the content it stands for is not in the range, so it cannot be scanned
      if (LFS_POINTER_RE.test(text.replace(/\r$/, ''))) add(file, LFS_KIND);
    }
  }
  // commit messages are pushed too: each one against the same rules, named by its commit
  for (const entry of String(git(['log', '-z', '--no-show-signature', '--format=%H%n%B', range])).split('\0')) {
    const [id, ...body] = entry.replace(/^\n+/, '').split('\n');
    if (!SHA_RE.test(id)) continue;
    for (const text of body) for (const [rule, re] of SECRET_RULES) if (re.test(text)) add(`(commit message ${short(id)})`, rule);
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
  // the branch and its tip, pinned now: the supervisor pushes exactly this commit to exactly this branch (a detached
  // HEAD is asked for too, and refused by the supervisor with its reason)
  const branch = currentBranch(git);
  const head = commitOf(git, branch ? `refs/heads/${branch}` : 'HEAD');
  if (!head) return { code: 0, line: 'nothing to push: no commit yet' };
  const prev = readJson(requestFile(root, phase), null);
  const rec = readJson(recordFile(root, phase), null);
  if (validRequest(prev) && prev.head === head && prev.branch === branch && (rec?.requestId !== prev.id || rec.outcome === 'pushed')) {
    return { code: 0, request: prev, line: `push already requested: ${short(head)}` };
  }
  const request = { id: newId(), phase: String(phase), branch, head, at: now.toISOString() };
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

// One request: branch, the pinned sha, fetch, ancestor check, scan, push. Every failure is recorded on the request and
// notified once: a git call that timed out or a broken repository included, so a waiting lane reads the real cause
// and the request is never retried silently every tick (the lane's next request tries again).
// pace: the tick's budget, its heartbeat and the time left in the heartbeat window (pushTick). A request that finds
// the budget used before its scan or its push waits for the next tick, where it goes first and is not stopped again.
async function handleRequest(ctx, phase, now, pace = FREE_PACE) {
  const { root, deps } = ctx;
  const { remote, ci } = ctx.config.push;
  const req = readJson(requestFile(root, phase), null);
  const prev = readJson(recordFile(root, phase), null);
  if (!validRequest(req) || prev?.requestId === req.id) return;
  // every git call ends inside the heartbeat window
  const git = (args, opts = {}) => deps.git(args, { ...opts, timeout: pace.limit(opts.timeout ?? GIT_TIMEOUT_MS) });
  const at = now.toISOString();
  const resumed = prev?.deferred?.requestId === req.id;
  const waits = (before) => {
    if (resumed || pace.budgetLeft()) return false;
    writeJsonAtomic(recordFile(root, phase), { ...(prev || {}), deferred: { requestId: req.id, at } });
    deps.log(`push p${phase}: ${short(req.head)} waits for the next tick before ${before}`);
    return true;
  };
  // the latest request's outcome; lastPush (the last push and its CI watch) is carried over until the next push
  const record = (outcome, fields, lastPush = prev?.lastPush) => {
    writeJsonAtomic(recordFile(root, phase), { requestId: req.id, phase: String(phase), remote, at, outcome, ...fields, ...(lastPush ? { lastPush } : {}) });
    deps.log(`push p${phase}: ${outcome}${fields.sha ? ` ${short(fields.sha)}` : ''}${fields.reason ? `: ${fields.reason}` : ''}`);
  };
  const failed = (reason, fields = {}) => {
    record('failed', { ...fields, reason });
    return deps.notify('pushFailed', { phase: String(phase), error: reason });
  };
  // exactly the commit and the branch the lane asked for: a later HEAD (the next wave, untested) is never pushed
  const ref = req.branch;
  const sha = req.head;
  if (ref === null) return failed('HEAD is detached; turbo pushes a branch only');
  // git gets the branch as it is; records, logs and notifications get it masked like any other text from git
  const branch = maskOutput(ref);
  let step = 'reading the branch';
  let repo = null;
  try {
    const current = currentBranch(git);
    if (current !== ref) return failed(`the request is for branch ${branch}, but the checkout is on ${current === null ? 'a detached HEAD' : maskOutput(current)} now; nothing was pushed`, { branch, sha });
    step = 'checking the requested commit';
    try {
      git(['merge-base', '--is-ancestor', sha, `refs/heads/${ref}`]);
    } catch (e) {
      // 1: not an ancestor; 128: no such commit any more (the branch was reset or rewritten)
      if (e.status !== 1 && e.status !== 128) throw e;
      return failed(`${short(sha)} is no longer on branch ${branch}; nothing was pushed`, { branch, sha });
    }
    step = 'reading the remote settings';
    // a mirror remote would push every ref and delete the remote's others
    if (configBool(git, `remote.${remote}.mirror`)) return failed(`remote.${remote}.mirror is true: turbo never pushes to a mirror remote; nothing was pushed`, { branch, sha });
    const base = `refs/remotes/${remote}/${ref}`;
    pace.beat();
    try {
      git(['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${ref}:${base}`], { timeout: FETCH_TIMEOUT_MS });
    } catch (e) {
      return failed(`git fetch ${remote} ${branch} failed: ${firstLine(e)}`, { branch, sha });
    }
    step = 'the ancestor check';
    try {
      git(['merge-base', '--is-ancestor', base, sha]);
    } catch (e) {
      if (e.status !== 1) throw e;
      record('diverged', { branch, sha });
      return deps.notify('pushDiverged', { phase: String(phase), remote, branch });
    }
    step = 'the secret scan';
    if (waits('the secret scan')) return;
    pace.beat();
    const findings = scanRange(git, base, sha);
    if (findings.length) {
      // the same findings as this phase's last refusal (a false alarm every wave carries along) are not notified again
      const again = prev?.outcome === 'refused' && JSON.stringify(prev.findings) === JSON.stringify(findings);
      record('refused', { branch, sha, findings });
      return again ? undefined : deps.notify('pushRefused', { phase: String(phase), remote, branch, findings: listFindings(findings) });
    }
    // the CI to watch, decided before the push: gh reads the runs of push.remote's repository, never one it picks
    if (ci === 'github') {
      step = 'reading the remote URL';
      repo = githubRepo(String(git(['remote', 'get-url', remote])));
    }
    // a daemon whose lease went during the fetch leaves the request to the new owner
    if (deps.leaseHeld && !deps.leaseHeld()) return;
    if (waits('the push')) return;
    pace.beat();
    try {
      // nothing from the git config widens it: no mirror, no tags that follow, no submodule pushes
      git(['-c', `remote.${remote}.mirror=false`, 'push', '--quiet', '--no-follow-tags', '--no-recurse-submodules', remote, `${sha}:refs/heads/${ref}`], { timeout: PUSH_TIMEOUT_MS });
    } catch (e) {
      return failed(`git push to ${remote}/${branch} failed: ${firstLine(e)}`, { branch, sha });
    }
  } catch (e) {
    // git's messages are masked by createGit; the reason names the step that failed
    return failed(`${step} failed: ${firstLine(e)}`, { branch, sha });
  }
  const notGithub = `remote ${remote} is not a GitHub repository, so CI is not watched`;
  const watch = ci !== 'github' ? { state: 'none', reason: 'push.ci is none' } : repo ? { state: 'pending', since: at, runs: [] } : { state: 'none', reason: notGithub };
  record('pushed', { branch, sha }, { requestId: req.id, sha, branch, remote, ...(repo ? { repo } : {}), at, ci: watch });
  supersede(root, phase, sha, at);
  if (ci === 'github' && !repo) await tellUnavailable(ctx, phase, notGithub, at);
}

// CI that cannot be watched (gh missing or not logged in, a remote not on GitHub): the owner is told once per reason;
// a later gh call that works clears it, so the next outage is told again.
const unavailableFile = (root) => path.join(runDir(root), 'ci-unavailable.json');
async function tellUnavailable(ctx, phase, reason, at) {
  if (readJson(unavailableFile(ctx.root), null)?.reason === reason) return;
  writeJsonAtomic(unavailableFile(ctx.root), { reason, at });
  await ctx.deps.notify('ciUnavailable', { phase: String(phase), reason });
}

// A newer push ends the CI watch of every other phase's earlier push: that result no longer says anything about HEAD.
function supersede(root, phase, sha, at) {
  for (const p of phasesWith(root, RECORD_RE)) {
    if (p === String(phase)) continue;
    const rec = readJson(recordFile(root, p), null);
    const lp = rec?.lastPush;
    if (lp?.ci?.state === 'pending' && lp.sha !== sha) writeJsonAtomic(recordFile(root, p), { ...rec, lastPush: { ...lp, ci: { ...lp.ci, state: 'superseded', doneAt: at } } });
  }
}

// gh -R owner/repo of the pushed remote, so gh never picks another remote of the checkout (upstream before origin)
const repoArgs = (lastPush) => (lastPush.repo ? ['-R', lastPush.repo] : []);

// Each red run's failed log tail, masked, goes into the lane's inbox; the owner is told once.
async function reportRed(ctx, phase, rec, runs, save, at) {
  const { root, deps } = ctx;
  const red = runs.filter(isRed);
  for (const run of red) {
    let log = { job: '', step: '', tail: [] };
    let logError = '';
    try {
      log = failedLogTail(deps.gh(['run', 'view', String(run.id), '--log-failed', ...repoArgs(rec)]));
    } catch (e) {
      logError = firstLine(e);
    }
    appendInbox(root, phase, { kind: 'ci-red', sha: rec.sha, run: run.id, workflow: maskOutput(run.name).slice(0, 100), conclusion: run.conclusion, ...log, ...(logError ? { logError } : {}) }, { now: new Date(at) });
  }
  save({ state: 'red', runs, doneAt: at });
  deps.log(`ci p${phase}: red on ${short(rec.sha)}: ${red.map((r) => r.name).join(', ')}`);
  await deps.notify('ciRed', { phase: String(phase), sha: short(rec.sha), runs: red.map((r) => `${r.name} (${r.conclusion})`).join(', '), rounds: ctx.config.push.ci_fix_rounds });
}

// The CI runs of this phase's last push (spec §6, S2: record.lastPush, whatever later requests ended in), once per
// tick, until all completed or push.ci_timeout_minutes passed (then ciTimeout; the lane is left alone). No run listed
// after CI_START_GRACE_MINUTES: no CI for this commit.
async function checkCi(ctx, phase, now) {
  const { root, deps } = ctx;
  const limit = ctx.config.push.ci_timeout_minutes;
  const full = readJson(recordFile(root, phase), null);
  const rec = full?.lastPush;
  if (rec?.ci?.state !== 'pending') return;
  const at = now.toISOString();
  const minutes = (now.getTime() - Date.parse(rec.ci.since)) / 60000;
  let runs = null;
  let error = '';
  const save = (ci) => writeJsonAtomic(recordFile(root, phase), { ...full, lastPush: { ...rec, ci: { ...rec.ci, ...ci, checkedAt: at } } });
  try {
    runs = parseRuns(deps.gh(['run', 'list', '--commit', rec.sha, '--json', 'databaseId,name,status,conclusion', ...repoArgs(rec)]));
    fs.rmSync(unavailableFile(root), { force: true });
  } catch (e) {
    error = firstLine(e);
    if (e.unavailable) {
      // no gh or no login: waiting would only end in ciTimeout, so this push counts as having no CI
      const reason = `CI not watched: ${error}`;
      save({ state: 'none', reason, doneAt: at });
      deps.log(`ci p${phase}: ${reason}`);
      return tellUnavailable(ctx, phase, reason, at);
    }
  }
  const seen = runs ?? (Array.isArray(rec.ci.runs) ? rec.ci.runs : []);
  const verdict = runs ? ciVerdict(runs) : 'pending';
  if (verdict === 'red' || (minutes >= limit && seen.some(isRed))) return reportRed(ctx, phase, rec, seen, save, at);
  if (verdict === 'green' || verdict === 'cancelled') {
    save({ state: verdict, runs, doneAt: at });
    return deps.log(`ci p${phase}: ${verdict} on ${short(rec.sha)}`);
  }
  if (runs && !runs.length && minutes >= CI_START_GRACE_MINUTES) {
    save({ state: 'none', reason: `no CI run appeared within ${CI_START_GRACE_MINUTES} min`, runs, doneAt: at });
    return deps.log(`ci p${phase}: no CI run for ${short(rec.sha)}`);
  }
  if (minutes >= limit) {
    save({ state: 'timeout', runs: seen, error, doneAt: at });
    deps.log(`ci p${phase}: no result on ${short(rec.sha)} after ${limit} min`);
    return deps.notify('ciTimeout', { phase: String(phase), sha: short(rec.sha), commit: rec.sha, repo: rec.repo ? ` -R ${rec.repo}` : '', minutes: limit, error: error ? `; last gh error: ${error}` : '' });
  }
  save({ runs: seen, error });
}

// The daemon counts as alive while its heartbeat is at most 10 minutes old (bin/turbo-run.mjs HEARTBEAT_MIN_MS, the
// shortest window). The push work refreshes it between its steps (deps.heartbeat, lent by runDaemon), bounds every git
// call by the time left in the window, and starts no new work after TICK_BUDGET_MS; the rest waits for the next tick.
export const TICK_BUDGET_MS = 2 * 60 * 1000;
const HEARTBEAT_WINDOW_MS = 10 * 60 * 1000;
const CALL_MARGIN_MS = 30 * 1000;
// outside a tick (tests, a direct call): no budget, no heartbeat, the calls' own limits
const FREE_PACE = Object.freeze({ budgetLeft: () => true, beat: () => {}, limit: (ms) => ms });

// Least recently checked first (never checked before all), then by phase: a CI watch the budget skipped goes first
// in the next tick.
function byLastCheck(root, phases) {
  const last = (p) => {
    const t = Date.parse(readJson(recordFile(root, p), null)?.lastPush?.ci?.checkedAt ?? '');
    return Number.isFinite(t) ? t : -Infinity;
  };
  return phases.map((p) => [p, last(p)]).sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([p]) => p);
}

// The supervisor's push work in one tick (spec §6, S2). Nothing with push off, or once this daemon lost its lease.
// CI first: a run that finished before a newer push replaces the record is still reported. Each phase separately:
// an error is logged and the work stays for the next tick. Nothing new starts once TICK_BUDGET_MS is used.
export async function pushTick(ctx, now) {
  const settings = ctx.config.push;
  const { root, deps } = ctx;
  if (!settings || settings.mode === 'off' || (deps.leaseHeld && !deps.leaseHeld())) return;
  const clock = deps.now || (() => new Date());
  const start = clock().getTime();
  let over = false;
  const budgetLeft = () => {
    if (!over && clock().getTime() - start >= TICK_BUDGET_MS) {
      over = true;
      deps.log(`push: this tick used its ${TICK_BUDGET_MS / 60000} min budget for push and CI work; the rest waits for the next tick`);
    }
    return !over;
  };
  let lastBeat = start;
  const beat = () => {
    if (!deps.heartbeat) return;
    deps.heartbeat();
    lastBeat = clock().getTime();
  };
  const limit = (ms) => Math.max(1000, Math.min(ms, HEARTBEAT_WINDOW_MS - (clock().getTime() - lastBeat) - CALL_MARGIN_MS));
  const pace = { budgetLeft, beat, limit };
  const request = async (phase) => {
    beat();
    try {
      await handleRequest(ctx, phase, now, pace);
    } catch (err) {
      deps.log(`push p${phase}: ${firstLine(err)}`);
    }
  };
  // a request an earlier tick stopped for its budget goes first, budget or not: it is never stopped twice
  const resumed = phasesWith(root, REQUEST_RE).filter((p) => {
    const id = readJson(requestFile(root, p), null)?.id;
    return id && readJson(recordFile(root, p), null)?.deferred?.requestId === id;
  });
  for (const phase of resumed) await request(phase);
  for (const phase of byLastCheck(root, phasesWith(root, RECORD_RE))) {
    if (!budgetLeft()) break;
    beat();
    try {
      await checkCi(ctx, phase, now);
    } catch (err) {
      deps.log(`ci p${phase}: ${firstLine(err)}`);
    }
  }
  for (const phase of phasesWith(root, REQUEST_RE)) {
    if (resumed.includes(phase)) continue;
    if (!budgetLeft()) break;
    await request(phase);
  }
}

// Claude Code's Bash tool stops a command after at most 10 minutes: --wait returns "waiting:" (exit 3) before that
const WAIT_SLICE_MS = 9 * 60 * 1000;
const WAIT_POLL_MS = 5000;
// a request no supervisor took for this long (a supervisor started with push off ignores requests) fails
export const UNHANDLED_MS = 10 * 60 * 1000;

const runNames = (runs) => (Array.isArray(runs) ? runs : []).map((r) => `${r.name} ${r.conclusion || r.status}`).join(', ');

// The one line a lane acts on, with its exit code: 0 pushed and CI green or none, 3 still going, 1 anything else.
export function describeRecord(rec) {
  if (rec.outcome === 'refused') return { code: 1, line: `refused: ${listFindings(rec.findings || [])}; nothing was pushed` };
  if (rec.outcome === 'diverged') return { code: 1, line: `diverged: ${rec.remote}/${rec.branch} has commits this checkout does not have; nothing was pushed` };
  if (rec.outcome !== 'pushed') return { code: 1, line: `failed: ${rec.reason || 'no reason recorded'}` };
  // the CI watch of this push, when this record's request is the one that pushed
  const ci = (rec.lastPush?.requestId === rec.requestId ? rec.lastPush.ci : null) || {};
  const head = `pushed ${short(rec.sha)} to ${rec.remote}/${rec.branch} · CI`;
  if (ci.state === 'pending') return { code: 3, line: `${head} pending` };
  if (ci.state === 'green') return { code: 0, line: `${head} green (${runNames(ci.runs)})` };
  if (ci.state === 'none') return { code: 0, line: `${head} none (${ci.reason})` };
  if (ci.state === 'red') return { code: 1, line: `${head} red (${runNames((ci.runs || []).filter(isRed))}); read it with turbo-run inbox ${rec.phase}` };
  if (ci.state === 'timeout') return { code: 1, line: `${head} timeout: no result within push.ci_timeout_minutes` };
  if (ci.state === 'cancelled') return { code: 1, line: `${head} cancelled (${runNames(ci.runs)}): nothing was tested` };
  return { code: 1, line: `${head} superseded by a later push` };
}

// Waits for the supervisor's answer to request id (spec §6, S2: a plan that pushes, and the phase end), at most one
// slice per call.
export async function waitPush({ root, phase, id, supervisorAlive, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), sliceMs = WAIT_SLICE_MS, pollMs = WAIT_POLL_MS, unhandledMs = UNHANDLED_MS }) {
  const start = now().getTime();
  // "not taken" counts from the first wait on this request, not from its asking: a request asked long ago without
  // --wait (no supervisor then) gets its full time once a lane waits for it; running the command again keeps the count
  const first = readJson(requestFile(root, phase), null);
  if (first?.id === id && !first.waitFrom) writeJsonAtomic(requestFile(root, phase), { ...first, waitFrom: new Date(start).toISOString() });
  for (;;) {
    const req = readJson(requestFile(root, phase), null);
    if (req?.id !== id) return { code: 1, line: 'superseded: a newer push request for this phase replaced this one' };
    const rec = readJson(recordFile(root, phase), null);
    const mine = rec?.requestId === id;
    if (mine) {
      const d = describeRecord(rec);
      if (d.code !== 3) return d;
    } else if (now().getTime() - Math.max(Date.parse(req.at), Date.parse(req.waitFrom ?? '') || 0) >= unhandledMs) {
      return { code: 1, line: `failed: the supervisor has not taken this request for ${Math.round(unhandledMs / 60000)} min; check turbo-run status and .planning/turbo/logs/supervisor.log (a supervisor started while push.mode was off ignores requests: stop it and start it again)` };
    }
    if (!supervisorAlive()) return { code: 1, line: 'failed: no supervisor is running, so nothing pushes this request or watches its CI; start one (turbo-run start) or push by hand' };
    if (now().getTime() - start >= sliceMs) return { code: 3, line: `waiting: ${mine ? `CI on ${short(rec.sha)} is still running` : 'the supervisor has not pushed yet'}; run the same command again` };
    await sleep(pollMs);
  }
}
