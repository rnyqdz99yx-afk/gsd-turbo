import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { agentWorktrees, ancestorPids, outsideLinks, runWorktreesCommand } from '../lib/worktrees.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const LINK = process.platform === 'win32' ? 'junction' : 'dir';

// A project with agent worktrees the way Claude Code's Agent(isolation="worktree") makes them:
// .claude/worktrees/agent-<id> on branch worktree-agent-<id>. The root as git prints it: a Windows runner's temp
// path has an 8.3 short name (C:UsersRUNNER~1…) that only the native realpath expands.
function project() {
  const root = fs.realpathSync.native(tmpGitRepo());
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n.claude/\n');
  git(root, 'add', '.gitignore');
  git(root, 'commit', '-q', '-m', 'ignore');
  const add = (id, { commit = false, merge = false } = {}) => {
    const p = path.join(root, '.claude', 'worktrees', `agent-${id}`);
    git(root, 'worktree', 'add', '-q', '-b', `worktree-agent-${id}`, p);
    if (commit) {
      fs.writeFileSync(path.join(p, `${id}.test.mjs`), '// a test\n');
      git(p, 'add', '.');
      git(p, 'commit', '-q', '-m', `test: ${id}`);
    }
    if (merge) git(root, 'merge', '-q', '--no-ff', `worktree-agent-${id}`, '-m', `merge ${id}`);
    return p;
  };
  return { root, add };
}

async function run(root, args, deps = {}) {
  const lines = [];
  const code = await runWorktreesCommand(args, { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), deps });
  return { code, text: lines.join('\n'), lines };
}
const registered = (root) => git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;
const branches = (root) => git(root, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();

test('agentWorktrees lists only Claude Code agent worktrees of the project (inside its .claude/worktrees), never the main checkout or another worktree', () => {
  const { root, add } = project();
  const a = add('a1b2c3');
  git(root, 'worktree', 'add', '-q', '-b', 'feature', path.join(tmpDir('feat'), 'feature'));
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-agent-zz', path.join(tmpDir('elsewhere'), 'agent-zz'));
  const list = agentWorktrees(root);
  assert.deepEqual(list.map((w) => [w.path, w.branch]), [[a, 'worktree-agent-a1b2c3']]);
});

test('worktrees prune --dry-run: lists the clean merged agent worktrees it would remove and why it keeps the others; changes nothing', async () => {
  const { root, add } = project();
  const merged = add('m1', { commit: true, merge: true });
  const fresh = add('f1');
  const dirty = add('d1', { commit: true, merge: true });
  fs.writeFileSync(path.join(dirty, 'notes.txt'), 'not committed\n');
  const unmerged = add('u1', { commit: true });
  const linked = add('l1', { commit: true, merge: true });
  const outside = tmpDir('main-node-modules');
  fs.writeFileSync(path.join(outside, 'precious.js'), '1\n');
  fs.symlinkSync(outside, path.join(linked, 'node_modules'), LINK);
  const before = [registered(root), branches(root)];
  const r = await run(root, ['prune', '--dry-run']);
  assert.equal(r.code, 0);
  const line = (p) => r.lines.find((l) => l.includes(p));
  assert.equal(line(merged), `would remove ${merged} (branch worktree-agent-m1)`);
  assert.equal(line(fresh), `would remove ${fresh} (branch worktree-agent-f1)`, 'no commits of its own: nothing to lose');
  assert.match(line(dirty), /^kept .*: it has uncommitted changes/);
  assert.match(line(unmerged), /^kept .*: its commits are not in the current branch/);
  assert.match(line(linked), /^kept .*: a link inside it leads outside it \(node_modules → .*\): remove that link first/);
  assert.deepEqual([registered(root), branches(root)], before, 'a dry run changes nothing');
});

test('worktrees prune removes the clean merged agent worktrees and their branches, never forced; the others stay, and nothing a link points to is touched', async () => {
  const { root, add } = project();
  const merged = add('m1', { commit: true, merge: true });
  const unmerged = add('u1', { commit: true });
  const linked = add('l1', { commit: true, merge: true });
  const outside = tmpDir('main-node-modules');
  fs.writeFileSync(path.join(outside, 'precious.js'), '1\n');
  fs.symlinkSync(outside, path.join(linked, 'node_modules'), LINK);
  const r = await run(root, ['prune']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.includes(`removed ${merged} (branch worktree-agent-m1 deleted)`), r.text);
  assert.equal(fs.existsSync(merged), false);
  assert.deepEqual(agentWorktrees(root).map((w) => w.path).sort(), [unmerged, linked].sort());
  assert.deepEqual(branches(root), ['main', 'worktree-agent-l1', 'worktree-agent-u1']);
  assert.equal(fs.readFileSync(path.join(outside, 'precious.js'), 'utf8'), '1\n');
  assert.equal((await run(root, ['prune'])).lines.filter((l) => l.startsWith('removed')).length, 0, 'nothing more to remove');
  assert.equal((await run(tmpGitRepo(), ['prune'])).text, 'no agent worktrees');
});

test('locks: a Claude Code lock whose process is gone is released; a live one is kept, and so is a lock someone set by hand', async () => {
  const { root, add } = project();
  const stale = add('s1', { commit: true, merge: true });
  const live = add('v1', { commit: true, merge: true });
  const hand = add('h1', { commit: true, merge: true });
  git(root, 'worktree', 'lock', '--reason', 'claude agent agent-s1 (pid 4001)', stale);
  git(root, 'worktree', 'lock', '--reason', 'claude agent agent-v1 (pid 4002)', live);
  git(root, 'worktree', 'lock', '--reason', 'on a removable disk', hand);
  const alive = (pid) => pid === 4002;
  const dry = await run(root, ['prune', '--dry-run'], { alive });
  assert.ok(dry.lines.includes(`would remove ${stale} (branch worktree-agent-s1; the lock of pid 4001, which no longer runs, is released)`), dry.text);
  const r = await run(root, ['prune'], { alive, ancestors: () => [4002] });
  assert.ok(r.lines.includes(`removed ${stale} (branch worktree-agent-s1 deleted)`), r.text);
  assert.ok(r.lines.some((l) => l.startsWith(`kept ${live}: locked by a running process (pid 4002)`)), 'a prune of all never releases a live lock, its own session\'s neither');
  assert.ok(r.lines.includes(`kept ${hand}: locked: on a removable disk`), r.text);
  assert.deepEqual(agentWorktrees(root).map((w) => w.path).sort(), [live, hand].sort());
});

test('worktrees prune <path>: one worktree; the lock of the session that runs the command is released (its agent returned); exit 1 when it stays', async () => {
  const { root, add } = project();
  const own = add('o1', { commit: true, merge: true });
  const other = add('x1', { commit: true, merge: true });
  git(root, 'worktree', 'lock', '--reason', 'claude agent agent-o1 (pid 4100)', own);
  git(root, 'worktree', 'lock', '--reason', 'claude agent agent-x1 (pid 4200)', other);
  const deps = { alive: () => true, ancestors: () => [4100] };
  let r = await run(root, ['prune', other, '--dry-run'], deps);
  assert.equal(r.code, 1);
  assert.match(r.text, /^kept .*: locked by a running process \(pid 4200\)/);
  r = await run(root, ['prune', own, '--dry-run'], deps);
  assert.deepEqual([r.code, r.text], [0, `would remove ${own} (branch worktree-agent-o1; the lock of this session, pid 4100, is released)`]);
  r = await run(root, ['prune', own], deps);
  assert.deepEqual([r.code, r.text], [0, `removed ${own} (branch worktree-agent-o1 deleted)`]);
  assert.deepEqual(agentWorktrees(root).map((w) => w.path), [other], 'only the named one');
  r = await run(root, ['prune', path.join(root, 'src')], deps);
  assert.equal(r.code, 1);
  assert.match(r.text, /^ERR not an agent worktree of this project: /);
  assert.equal((await run(root, ['nope'])).code, 2);
});

test('a worktree remove git refuses leaves the worktree locked as it was', async () => {
  const { root, add } = project();
  const p = add('r1', { commit: true, merge: true });
  git(root, 'worktree', 'lock', '--reason', 'claude agent agent-r1 (pid 4300)', p);
  const failing = (cwd, args) => {
    if (args[0] === 'worktree' && args[1] === 'remove') throw Object.assign(new Error('x'), { stderr: 'fatal: cannot remove: Permission denied\n' });
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const r = await run(root, ['prune'], { alive: () => false, git: failing });
  assert.equal(r.text, `kept ${p}: git worktree remove: fatal: cannot remove: Permission denied`);
  assert.match(git(root, 'worktree', 'list', '--porcelain'), /locked claude agent agent-r1 \(pid 4300\)/);
});

test('outsideLinks finds a link that leads outside the directory, a junction included; links within it are fine', () => {
  const dir = tmpDir('links');
  fs.mkdirSync(path.join(dir, 'pkg', 'lib'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'pkg', 'lib'), path.join(dir, 'pkg', 'alias'), LINK);
  assert.deepEqual(outsideLinks(dir), []);
  const outside = tmpDir('elsewhere');
  fs.mkdirSync(path.join(dir, 'pkg', 'deep'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'pkg', 'deep', 'node_modules'), LINK);
  assert.deepEqual(outsideLinks(dir).map((l) => [l.path, l.target]), [[path.join('pkg', 'deep', 'node_modules'), fs.realpathSync.native(outside)]]);
});

test('ancestorPids names the processes this one runs under', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const chain = ancestorPids();
    assert.ok(chain.includes(process.ppid), `${process.ppid} in ${chain}`);
    assert.ok(!chain.includes(child.pid), 'a child is no ancestor');
    assert.deepEqual(ancestorPids(process.pid, { exec: () => { throw new Error('no process table'); } }), [], 'no table, no ancestors');
  } finally {
    child.kill();
  }
});

test('turbo-run worktrees prune --dry-run from the project folder; a wrong form is a usage error', () => {
  const { root, add } = project();
  fs.mkdirSync(path.join(root, '.planning'));
  const p = add('c1', { commit: true, merge: true });
  const cli = (...a) => spawnSync(process.execPath, [path.resolve('bin/turbo-run.mjs'), 'worktrees', ...a], { cwd: root, encoding: 'utf8', windowsHide: true });
  const r = cli('prune', '--dry-run');
  assert.deepEqual([r.status, r.stdout.trim()], [0, `would remove ${p} (branch worktree-agent-c1)`]);
  assert.equal(cli('tidy').status, 2);
  assert.ok(fs.existsSync(p));
});

test('a worktree remove git gives up halfway (its record gone, files left): partly removed, the branch still deleted', async () => {
  const { root, add } = project();
  const p = add('p1', { commit: true, merge: true });
  const halfway = (cwd, args) => {
    if (args[0] === 'worktree' && args[1] === 'remove') {
      // git dropped the worktree's record, then failed on a file a process holds
      fs.renameSync(p, `${p}.held`);
      execFileSync('git', ['worktree', 'prune'], { cwd });
      fs.renameSync(`${p}.held`, p);
      throw Object.assign(new Error('x'), { stderr: 'error: failed to delete: Permission denied\n' });
    }
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const r = await run(root, ['prune', p], { git: halfway });
  assert.equal(r.code, 1);
  assert.equal(r.text, `partly removed ${p} (branch worktree-agent-p1 deleted): git worktree remove: error: failed to delete: Permission denied; what is left of the folder is no worktree any more: delete it once nothing holds it`);
});

test('worktrees prune runs in the main checkout only: from inside a worktree nothing is judged or removed', async () => {
  const { root, add } = project();
  const p = add('w1', { commit: true });
  const r = await run(p, ['prune']);
  assert.equal(r.code, 2);
  assert.match(r.text, /^ERR turbo-run worktrees prune runs in the main checkout (.*), not in a worktree of it/);
  assert.deepEqual(agentWorktrees(root).map((w) => w.path), [p]);
});

test('an untracked file counts as a change whatever status.showUntrackedFiles says', async () => {
  const { root, add } = project();
  const p = add('n1', { commit: true, merge: true });
  git(root, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(p, 'new-work.txt'), 'not committed\n');
  const r = await run(root, ['prune']);
  assert.equal(r.text, `kept ${p}: it has uncommitted changes`);
  assert.ok(fs.existsSync(path.join(p, 'new-work.txt')));
});
