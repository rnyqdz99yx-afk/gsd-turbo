// turbo-run worktrees prune: the worktrees Claude Code's Agent(isolation="worktree") leaves in a project. The harness
// makes .claude/worktrees/agent-<id> on branch worktree-agent-<id> and locks it, "claude agent agent-<id> (pid <n>)",
// for as long as the session that made it runs; git worktree remove refuses a locked worktree, so a lane's fan-out
// left its merged Nyquist worktree behind. Only a clean, merged agent worktree is removed, never forced: no uncommitted
// change or untracked file, no commit the current branch lacks, no link inside it that leads outside it (a cleanup
// through a junction once deleted the main checkout's node_modules). Files git ignores go with it, as with any git
// worktree remove. A Claude Code lock is released only when its process is gone, or, for the one worktree a command
// names, when it is the lock of the session that runs the command (its agent returned).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pidAlive } from './merge-lock.mjs';
import { dirKey } from './paths.mjs';

export const WORKTREES_USAGE = 'worktrees prune [<path>] [--dry-run]';
const AGENT_NAME = /^(?:worktree-)?agent-[A-Za-z0-9]+$/;
const CLAUDE_LOCK = /^claude agent \S+ \(pid (\d+)\)$/;
const firstLine = (s) => String(s ?? '').trim().split(/\r?\n/)[0];
const gitError = (e) => firstLine(e?.stderr) || firstLine(e?.message);
const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

// git worktree list --porcelain, the main worktree first: { path, head, branch, locked (reason, '' without one, or
// null), prunable }.
export function listWorktrees(root, { git = runGit } = {}) {
  const list = [];
  let w = null;
  for (const line of git(root, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) list.push((w = { path: path.resolve(line.slice(9)), head: null, branch: null, locked: null, prunable: false }));
    else if (!w) continue;
    else if (line.startsWith('HEAD ')) w.head = line.slice(5);
    else if (line.startsWith('branch ')) w.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'locked' || line.startsWith('locked ')) w.locked = line.slice(7);
    else if (line === 'prunable' || line.startsWith('prunable ')) w.prunable = true;
  }
  return list;
}

// The agent worktrees of the project: a folder agent-<id> (or worktree-agent-<id>) right inside the main checkout's
// .claude/worktrees/, where Claude Code makes them; never the main checkout, never a worktree anywhere else.
export function agentWorktrees(root, opts = {}) {
  const [main, ...rest] = listWorktrees(root, opts);
  if (!main) return [];
  const home = dirKey(path.join(main.path, '.claude', 'worktrees'));
  return rest.filter((w) => AGENT_NAME.test(path.basename(w.path)) && dirKey(path.dirname(w.path)) === home);
}

// The links inside dir (symbolic links and junctions) whose target lies outside it, or is gone: { path (relative),
// target }. Links are never followed; at most `limit` are named.
export function outsideLinks(dir, limit = 3) {
  const base = fs.realpathSync.native(dir);
  const within = (p) => {
    const r = path.relative(base, p);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  const found = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.realpathSync.native(p);
        } catch { /* a link to nothing: not known to stay inside */ }
        if (target === null || !within(target)) found.push({ path: path.relative(base, p), target: target ?? '(missing)' });
      } else if (e.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(base);
  return found;
}

// The pids of the processes this one runs under (parent first), from one snapshot of the process table; [] when the
// table cannot be read. A Bash call of a Claude Code session runs under the session's process, the pid its agent
// worktree locks name; should a session ever lock with another process's pid, its lock is simply not released here.
export function ancestorPids(pid = process.pid, { platform = process.platform, exec = execFileSync } = {}) {
  let text;
  try {
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000 };
    text = platform === 'win32'
      ? exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], opts)
      : exec('ps', ['-A', '-o', 'pid=,ppid='], opts);
  } catch {
    return [];
  }
  const parent = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const [a, b] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(a) && Number.isInteger(b) && a > 0) parent.set(a, b);
  }
  const chain = [];
  for (let p = parent.get(pid); Number.isInteger(p) && p > 1 && !chain.includes(p) && chain.length < 64; p = parent.get(p)) chain.push(p);
  return chain;
}

// Whether a worktree may go, and what releases its lock: { ok: false, why } or { ok: true, unlock: null | <how> }.
function judge(root, w, { git, alive, ancestors, named }) {
  if (w.prunable || !fs.existsSync(w.path)) return { ok: false, why: 'its directory is gone (git worktree prune forgets it)' };
  let status;
  try {
    // whatever the status config says: every untracked file counts, submodules too
    status = git(w.path, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
  } catch (e) {
    return { ok: false, why: `git status: ${gitError(e)}` };
  }
  if (status.trim()) return { ok: false, why: 'it has uncommitted changes' };
  try {
    git(root, ['merge-base', '--is-ancestor', w.head, 'HEAD']);
  } catch (e) {
    return { ok: false, why: e?.status === 1 ? 'its commits are not in the current branch' : `git merge-base: ${gitError(e)}` };
  }
  const links = outsideLinks(w.path);
  if (links.length) return { ok: false, why: `a link inside it leads outside it (${links.map((l) => `${l.path} → ${l.target}`).join(', ')}): remove that link first, as a link` };
  if (w.locked === null) return { ok: true, unlock: null };
  const m = CLAUDE_LOCK.exec(w.locked.trim());
  if (!m) return { ok: false, why: `locked: ${w.locked || 'no reason given'}` };
  const pid = Number(m[1]);
  if (!alive(pid)) return { ok: true, unlock: `the lock of pid ${pid}, which no longer runs, is released` };
  if (named && ancestors().includes(pid)) return { ok: true, unlock: `the lock of this session, pid ${pid}, is released` };
  return { ok: false, why: `locked by a running process (pid ${pid}): an agent may still work in it` };
}

// turbo-run worktrees prune [<path>] [--dry-run], in the main checkout only. Exit 0; with a path, 1 when that
// worktree stays or is only partly removed (or is no agent worktree of the project); 2 on a usage error or when run
// in a worktree (its HEAD is not the branch the agent worktrees were merged into).
export async function runWorktreesCommand(args, { root, out = console.log, err = (l) => process.stderr.write(`${l}\n`), deps = {} }) {
  const git = deps.git || runGit;
  const alive = deps.alive || pidAlive;
  let chain = null;
  const ancestors = () => (chain ??= (deps.ancestors || ancestorPids)());
  const [sub, ...rest] = args;
  const pos = rest.filter((a) => !a.startsWith('--'));
  if (sub !== 'prune' || pos.length > 1 || rest.some((a) => a.startsWith('--') && a !== '--dry-run')) {
    err(`usage: turbo-run ${WORKTREES_USAGE}`);
    return 2;
  }
  const top = git(root, ['rev-parse', '--show-toplevel']).trim();
  const main = listWorktrees(root, { git })[0];
  if (!main || dirKey(top) !== dirKey(main.path)) {
    err(`turbo-run worktrees prune runs in the main checkout${main ? ` (${main.path})` : ''}, not in a worktree of it (${path.resolve(top)})`);
    return 2;
  }
  const dry = rest.includes('--dry-run');
  const named = pos[0] ? path.resolve(root, pos[0]) : null;
  let list = agentWorktrees(root, { git });
  if (named) {
    list = list.filter((w) => dirKey(w.path) === dirKey(named));
    if (!list.length) {
      err(`not an agent worktree of this project: ${named}`);
      return 1;
    }
  } else if (!list.length) {
    out('no agent worktrees');
    return 0;
  }
  let left = 0;
  const deleteBranch = (branch) => {
    if (!branch) return 'no agent branch';
    try {
      git(root, ['branch', '-d', branch]);
      return `branch ${branch} deleted`;
    } catch (e) {
      return `branch ${branch} kept: ${gitError(e)}`;
    }
  };
  for (const w of list) {
    const j = judge(root, w, { git, alive, ancestors, named: Boolean(named) });
    const branch = w.branch && AGENT_NAME.test(w.branch) ? w.branch : null;
    if (!j.ok) {
      out(`kept ${w.path}: ${j.why}`);
      left++;
      continue;
    }
    if (dry) {
      out(`would remove ${w.path} (${[branch ? `branch ${branch}` : 'no agent branch', j.unlock].filter(Boolean).join('; ')})`);
      continue;
    }
    try {
      if (j.unlock) git(root, ['worktree', 'unlock', w.path]);
      git(root, ['worktree', 'remove', w.path]);
    } catch (e) {
      left++;
      // git may have given the worktree up (its record is gone) and still left files that a process holds
      const still = listWorktrees(root, { git }).some((x) => dirKey(x.path) === dirKey(w.path));
      if (!still) {
        out(`partly removed ${w.path} (${deleteBranch(branch)}): git worktree remove: ${gitError(e)}; what is left of the folder is no worktree any more: delete it once nothing holds it`);
        continue;
      }
      // the worktree stays as it was found, its lock included
      if (j.unlock) try { git(root, ['worktree', 'lock', '--reason', w.locked, w.path]); } catch { /* best effort */ }
      out(`kept ${w.path}: git worktree remove: ${gitError(e)}`);
      continue;
    }
    out(`removed ${w.path} (${deleteBranch(branch)})`);
  }
  return named && left ? 1 : 0;
}
