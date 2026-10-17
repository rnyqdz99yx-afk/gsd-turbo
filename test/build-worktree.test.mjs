import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { gitIn } from './helpers/slots.mjs';
import { buildRepo } from './helpers/build.mjs';
import { buildGit, createSliceWorktree, removeSliceWorktree, sliceWorktreePath } from '../lib/build-queue.mjs';

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const PLANS = [{ id: '33-01', files: ['src/one.js'] }, { id: '33-02', files: ['src/two.js'] }];

// A lane checkout with a real node_modules/dep/index.js and an ignored .env.
function lane() {
  const repo = buildRepo({ plans: PLANS });
  repo.write('node_modules/dep/index.js', 'module.exports = 1;\n');
  repo.write('.env', 'TOKEN=dummy\n');
  return { ...repo, base: repo.git('rev-parse', 'HEAD') };
}
const exists = (p) => fs.existsSync(p);
const branchExists = (root, b) => { try { gitIn(root, 'rev-parse', '--verify', '-q', `refs/heads/${b}`); return true; } catch { return false; } };
const markerOf = (dir) => path.resolve(dir, gitIn(dir, 'rev-parse', '--git-path', 'turbo-last-green'));

test('createSliceWorktree forks from the base', () => {
  const l = lane();
  const w = createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base });
  assert.equal(w.path, path.join(l.lanesDir, 'b', '33-02'));
  assert.equal(sliceWorktreePath(l.root, '33-02'), w.path);
  assert.equal(w.branch, 'turbo-build/33-02');
  assert.equal(gitIn(w.path, 'rev-parse', 'HEAD'), l.base);
  assert.equal(gitIn(w.path, 'symbolic-ref', '--short', 'HEAD'), 'turbo-build/33-02');
  const list = l.git('worktree', 'list', '--porcelain');
  assert.throws(() => createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base }), /exists/);
  assert.equal(l.git('worktree', 'list', '--porcelain'), list, 'nothing changed');
  // a branch left behind (no worktree) is refused the same way
  removeSliceWorktree(l.root, { path: w.path, branch: w.branch, deleteBranch: false });
  assert.throws(() => createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base }), /exists/);
  assert.equal(exists(w.path), false);
});

test('a worktree has the lane\'s dependencies, copies and test marker, and a clean status', () => {
  const l = lane();
  const old = l.base;
  l.write('src/one.js', 'export const one = 1;\n');
  const base = l.commit('feat: one');
  fs.writeFileSync(markerOf(l.root), JSON.stringify({ fullSha: old, targetedSince: 1, command: 'node --test' }));
  const w = createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: base });
  assert.deepEqual(w.links, ['node_modules']);
  assert.ok(fs.lstatSync(path.join(w.path, 'node_modules')).isSymbolicLink(), 'a link (a junction on Windows)');
  assert.equal(fs.readFileSync(path.join(w.path, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.readFileSync(path.join(w.path, '.env'), 'utf8'), 'TOKEN=dummy\n');
  assert.equal(gitIn(w.path, 'status', '--porcelain', '--untracked-files=normal'), '');
  const exclude = fs.readFileSync(path.join(l.root, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /# gsd-turbo build links: begin\n\/node_modules\n# gsd-turbo build links: end\n/);
  assert.deepEqual(JSON.parse(fs.readFileSync(markerOf(w.path), 'utf8')), { fullSha: old, targetedSince: 1, command: 'node --test' }, 'the full run is an ancestor of the base');
  assert.notEqual(markerOf(w.path), markerOf(l.root));
  // a second worktree: the block is written again, once
  const w1 = createSliceWorktree(l.root, { phase: '33', id: '33-01', baseSha: base });
  assert.equal((fs.readFileSync(path.join(l.root, '.git', 'info', 'exclude'), 'utf8').match(/build links: begin/g) ?? []).length, 1);
  assert.equal(gitIn(w1.path, 'status', '--porcelain', '--untracked-files=normal'), '');

  // a full run on another line of history: no marker
  const l2 = lane();
  l2.git('checkout', '-q', '-b', 'side');
  l2.write('src/side.js', 'export {};\n');
  const side = l2.commit('side');
  l2.git('checkout', '-q', 'main');
  fs.writeFileSync(markerOf(l2.root), JSON.stringify({ fullSha: side, targetedSince: 0, command: 'node --test' }));
  const w2 = createSliceWorktree(l2.root, { phase: '33', id: '33-02', baseSha: l2.base });
  assert.equal(exists(markerOf(w2.path)), false);
});

test('removeSliceWorktree keeps the lane checkout\'s node_modules', () => {
  const l = lane();
  const w = createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base });
  // an extra junction into another folder, planted by a builder
  const other = tmpDir('target');
  fs.writeFileSync(path.join(other, 'keep.txt'), 'keep\n');
  fs.symlinkSync(other, path.join(w.path, 'src-link'), LINK_TYPE);
  const r = removeSliceWorktree(l.root, { path: w.path, branch: w.branch });
  assert.deepEqual(r, { removed: true, leftover: null, why: null });
  assert.equal(exists(w.path), false);
  assert.equal(branchExists(l.root, 'turbo-build/33-02'), false);
  assert.equal(fs.readFileSync(path.join(l.root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep\n');
  assert.equal(l.git('worktree', 'list', '--porcelain').includes('33-02'), false);
});

test('a branch with commits not on HEAD is never deleted', () => {
  const l = lane();
  const w = createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base });
  fs.writeFileSync(path.join(w.path, 'two.txt'), 'work\n');
  gitIn(w.path, 'add', '-A');
  gitIn(w.path, 'commit', '-q', '-m', 'work');
  const r = removeSliceWorktree(l.root, { path: w.path, branch: w.branch, deleteBranch: true });
  assert.equal(r.removed, true);
  assert.equal(exists(w.path), false);
  assert.equal(branchExists(l.root, 'turbo-build/33-02'), true);
  assert.equal(r.why, 'branch turbo-build/33-02 has commits not on HEAD: kept');
});

test('what a halfway removal left is deleted as a plain folder, never through its links', () => {
  const l = lane();
  const w = createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base });
  const other = tmpDir('target');
  fs.writeFileSync(path.join(other, 'keep.txt'), 'keep\n');
  fs.symlinkSync(other, path.join(w.path, 'src-link'), LINK_TYPE);
  // git gave the worktree up (its record and its .git file gone) and left the files
  fs.rmSync(path.resolve(w.path, gitIn(w.path, 'rev-parse', '--git-dir')), { recursive: true, force: true });
  fs.rmSync(path.join(w.path, '.git'), { force: true });
  const r = removeSliceWorktree(l.root, { path: w.path, branch: w.branch });
  assert.deepEqual(r, { removed: true, leftover: null, why: null });
  assert.equal(exists(w.path), false);
  assert.equal(fs.readFileSync(path.join(l.root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep\n');
  assert.equal(branchExists(l.root, w.branch), false);
  assert.ok(createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base }).path);
});

test('a removal Windows really refuses: a leftover, then removed once nothing holds it', { skip: process.platform !== 'win32' && 'Windows only: an open folder cannot be deleted' }, async () => {
  const l = lane();
  const w = createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: path.join(w.path, '.planning'), stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => child.once('spawn', resolve));
  try {
    const r = removeSliceWorktree(l.root, { path: w.path, branch: w.branch }, { rm: (p) => fs.rmSync(p, { recursive: true, force: true }) });
    assert.equal(r.removed, false);
    assert.equal(r.leftover, w.path);
    assert.ok(exists(w.path));
    assert.equal(fs.readFileSync(path.join(l.root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1;\n');
  } finally {
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await gone;
  }
  assert.deepEqual(removeSliceWorktree(l.root, { path: w.path, branch: w.branch }), { removed: true, leftover: null, why: null });
  assert.equal(exists(w.path), false);
  assert.equal(branchExists(l.root, w.branch), false);
  assert.ok(createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base }).path);
});

test('createSliceWorktree: a marker naming a commit that is gone, a held lock, a failed add', () => {
  const l = lane();
  fs.writeFileSync(markerOf(l.root), JSON.stringify({ fullSha: 'a'.repeat(40), targetedSince: 0, command: 'node --test' }));
  const w = createSliceWorktree(l.root, { phase: '33', id: '33-01', baseSha: l.base });
  assert.equal(exists(markerOf(w.path)), false, 'no marker; the worktree is made');

  // the first add makes the branch, then finds the index locked: the retry takes the branch as it is
  const real = buildGit();
  const sleeps = [];
  let adds = 0;
  const locking = (dir, args, o) => {
    if (args[0] === 'worktree' && args[1] === 'add' && ++adds === 1) {
      real(dir, ['branch', 'turbo-build/33-02', l.base]);
      const e = new Error(`git worktree in ${dir} failed: remove the file manually to continue.`);
      e.stderr = "fatal: Unable to create '.git/index.lock': File exists.\n\nremove the file manually to continue.\n";
      throw e;
    }
    return real(dir, args, o);
  };
  const two = createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base }, { git: locking, sleep: (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [2000]);
  assert.equal(gitIn(two.path, 'symbolic-ref', '--short', 'HEAD'), 'turbo-build/33-02');

  // an add that fails after making the branch leaves nothing behind
  const failing = (dir, args, o) => {
    if (args[0] === 'worktree' && args[1] === 'add') {
      real(dir, ['branch', 'turbo-build/33-03', l.base]);
      throw new Error(`git worktree in ${dir} failed: timed out after 120 s`);
    }
    return real(dir, args, o);
  };
  assert.throws(() => createSliceWorktree(l.root, { phase: '33', id: '33-03', baseSha: l.base }, { git: failing }), /timed out/);
  assert.equal(branchExists(l.root, 'turbo-build/33-03'), false);
  assert.equal(exists(sliceWorktreePath(l.root, '33-03')), false);
});

test('a removal Windows refuses leaves a leftover', () => {
  const l = lane();
  const w = createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.base });
  const real = buildGit();
  const git = (dir, args, o) => {
    if (args[0] === 'worktree' && args[1] === 'remove') throw new Error(`git worktree in ${dir} failed: error: failed to delete '${w.path}': Permission denied`);
    return real(dir, args, o);
  };
  let r;
  assert.doesNotThrow(() => { r = removeSliceWorktree(l.root, { path: w.path, branch: w.branch }, { git }); });
  assert.equal(r.removed, false);
  assert.equal(r.leftover, w.path);
  assert.match(r.why, /Permission denied/);
  assert.equal(branchExists(l.root, 'turbo-build/33-02'), true);
  assert.equal(fs.readFileSync(path.join(l.root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1;\n');
});
