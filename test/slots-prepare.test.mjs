import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { gitIn, mainProject, slotFixture } from './helpers/slots.mjs';
import { SlotRefused, depsFile, freeSlot, jobBranch, listSlots, prepareSlot, readSlotRecord, releaseSlot, removeSlot, setupSlots, slotForPhase, slotPath } from '../lib/slots.mjs';
import { trustState, untrustSlot } from '../lib/trust.mjs';

const refused = (fn, code, re) => assert.throws(fn, (e) => e instanceof SlotRefused && e.code === code && (!re || re.test(e.message)), `${code} ${re ?? ''}`);
const LOCK = { 'package.json': '{"name":"app","private":true}\n', 'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n' };
const AT = '2026-10-13T12:00:00.000Z';
function ready({ files = {}, before = () => {} } = {}) {
  const p = mainProject({ files });
  before(p);
  const t = slotFixture(p.root);
  setupSlots(p.root, t.config, t.deps);
  return { p, t, s1: slotPath(p.root, t.config, 1), s2: slotPath(p.root, t.config, 2) };
}
const head = (dir) => gitIn(dir, 'rev-parse', 'HEAD');
const branchOf = (dir) => gitIn(dir, 'symbolic-ref', '--short', 'HEAD');

test('prepare puts a fresh slot on turbo/<job> at the main branch and records the job; a held slot is refused', () => {
  const { p, t, s1 } = ready();
  assert.deepEqual([jobBranch({ kind: 'phase', phase: '3' }), jobBranch({ kind: 'prep', phase: '4' }), jobBranch({ kind: 'annotate' })], ['turbo/p3', 'turbo/prep-4', 'turbo/annotate']);
  const r = prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  const base = { branch: 'main', sha: head(p.root) };
  assert.deepEqual([r.k, r.path, r.branch, r.base], [1, s1, 'turbo/p3', base]);
  assert.deepEqual([branchOf(s1), head(s1)], ['turbo/p3', head(p.root)]);
  assert.deepEqual(readSlotRecord(s1).job, { kind: 'phase', phase: '3', branch: 'turbo/p3', base, state: 'active', startedAt: AT, endedAt: null, outcome: null });
  assert.deepEqual(r.deps, [{ dir: '', lockfile: null, command: null, action: 'none' }]);
  assert.equal(slotForPhase(p.root, t.config, '3').k, 1);
  assert.equal(slotForPhase(p.root, t.config, '4'), null);
  assert.equal(slotForPhase(p.root, t.config, '3', { kind: 'prep' }), null);
  assert.deepEqual(listSlots(p.root, t.config, t.deps).map((s) => [s.k, s.state]), [[1, 'busy'], [2, 'free']]);
  refused(() => prepareSlot(p.root, 1, { kind: 'prep', phase: '4' }, t.deps), 'busy', /slot 1 holds phase 3 on turbo\/p3/);
  assert.throws(() => prepareSlot(p.root, 2, { kind: 'phase' }, t.deps), /a phase job needs a phase id/);
  assert.throws(() => prepareSlot(p.root, 2, { kind: 'phase', phase: '3', branch: 'main' }, t.deps), /job\.branch must be turbo\//);
  assert.throws(() => prepareSlot(p.root, 2, { kind: 'deploy', phase: '3' }, t.deps), /job\.kind must be one of phase, prep, annotate/);
  const a = prepareSlot(p.root, 2, { kind: 'annotate' }, t.deps);
  assert.deepEqual([a.branch, readSlotRecord(a.path).job.phase], ['turbo/annotate', null]);
  assert.equal(slotForPhase(p.root, t.config, null, { kind: 'annotate' }).k, 2);
});

test('the next job: the new main, the last job\'s leftovers and branch gone, the copies refreshed, node_modules kept', () => {
  const { p, t, s1 } = ready({ before: (q) => q.write('.env', 'A=1\n') });
  prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  fs.writeFileSync(path.join(s1, '.planning', 'state.json'), '{}');
  fs.mkdirSync(path.join(s1, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(s1, 'dist', 'app.js'), 'x');
  fs.mkdirSync(path.join(s1, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(s1, 'node_modules', 'dep', 'index.js'), 'x');
  const done = releaseSlot(p.root, 1, { outcome: 'merged', config: t.config, now: t.deps.now });
  assert.deepEqual([done.job.state, done.job.outcome, done.job.endedAt], ['done', 'merged', AT]);
  assert.equal(listSlots(p.root, t.config, t.deps)[0].state, 'free', 'a merged job\'s untracked leftovers do not block');
  p.write('.env', 'A=2\n');
  p.write('src/next.js', 'export const x = 1;\n');
  p.git('add', 'src/next.js');
  p.git('commit', '-q', '-m', 'next');
  const r = prepareSlot(p.root, 1, { kind: 'prep', phase: '4' }, t.deps);
  assert.deepEqual([r.branch, head(s1), branchOf(s1)], ['turbo/prep-4', head(p.root), 'turbo/prep-4']);
  assert.equal(fs.existsSync(path.join(s1, '.planning', 'state.json')), false);
  assert.equal(fs.existsSync(path.join(s1, 'dist')), false);
  assert.equal(fs.existsSync(path.join(s1, 'src', 'next.js')), true);
  assert.equal(fs.readFileSync(path.join(s1, 'node_modules', 'dep', 'index.js'), 'utf8'), 'x');
  assert.equal(fs.readFileSync(path.join(s1, '.env'), 'utf8'), 'A=2\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s1, '.claude', 'settings.local.json'), 'utf8')).worktree.baseRef, 'head');
  assert.equal(gitIn(s1, 'branch', '--list', 'turbo/p3'), '', 'the last job\'s branch is gone');
  assert.equal(gitIn(s1, 'status', '--porcelain'), '');
  assert.equal(slotForPhase(p.root, t.config, '4', { kind: 'prep' }).k, 1);
});

test('prepare never overwrites work: tracked changes, a file no job explains, a failed job\'s files; nothing changes (Review Focus 3)', () => {
  const { p, t, s1, s2 } = ready();
  prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  fs.appendFileSync(path.join(s1, 'README.md'), 'edited\n');
  releaseSlot(p.root, 1, { outcome: 'merged', config: t.config });
  refused(() => prepareSlot(p.root, 1, { kind: 'phase', phase: '5' }, t.deps), 'dirty', /M README\.md/);
  assert.deepEqual([branchOf(s1), fs.readFileSync(path.join(s1, 'README.md'), 'utf8')], ['turbo/p3', '# t\nedited\n']);
  assert.equal(readSlotRecord(s1).job.outcome, 'merged');
  fs.writeFileSync(path.join(s2, 'notes.txt'), 'mine');
  refused(() => prepareSlot(p.root, 2, { kind: 'phase', phase: '5' }, t.deps), 'dirty', /\?\? notes\.txt/);
  assert.equal(fs.readFileSync(path.join(s2, 'notes.txt'), 'utf8'), 'mine');
  fs.rmSync(path.join(s2, 'notes.txt'));
  prepareSlot(p.root, 2, { kind: 'phase', phase: '5' }, t.deps);
  fs.writeFileSync(path.join(s2, 'draft.js'), 'x');
  releaseSlot(p.root, 2, { outcome: 'failed', config: t.config });
  refused(() => prepareSlot(p.root, 2, { kind: 'phase', phase: '6' }, t.deps), 'dirty', /\?\? draft\.js/);
  assert.equal(fs.readFileSync(path.join(s2, 'draft.js'), 'utf8'), 'x');
  assert.deepEqual(listSlots(p.root, t.config, t.deps).map((s) => s.state), ['dirty', 'dirty']);
  assert.throws(() => releaseSlot(p.root, 2, { outcome: 'lost', config: t.config }), /outcome must be one of merged, failed, abandoned/);
});

test('dependencies: installed by the lockfile at the first job, again only when the lockfile or lanes.install changes', () => {
  const { p, t, s1 } = ready({ files: LOCK });
  let r = prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  assert.deepEqual(r.deps, [{ dir: '', lockfile: 'package-lock.json', command: 'npm ci', action: 'installed' }]);
  assert.deepEqual(t.calls, [{ command: 'npm ci', cwd: s1 }]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(depsFile(s1), 'utf8')).entries), ['']);
  releaseSlot(p.root, 1, { config: t.config });
  r = prepareSlot(p.root, 1, { kind: 'phase', phase: '4' }, t.deps);
  assert.deepEqual([r.deps[0].action, t.calls.length], ['unchanged', 1]);
  releaseSlot(p.root, 1, { config: t.config });
  p.write('package-lock.json', '{"lockfileVersion":3,"packages":{"":{"name":"app"}}}\n');
  p.git('commit', '-q', '-am', 'lock');
  r = prepareSlot(p.root, 1, { kind: 'phase', phase: '5' }, t.deps);
  assert.deepEqual([r.deps[0].action, t.calls.length], ['installed', 2]);
  releaseSlot(p.root, 1, { config: t.config });
  const custom = { ...t.deps, config: { ...t.config, lanes: { ...t.config.lanes, install: 'npm install --offline' } } };
  r = prepareSlot(p.root, 1, { kind: 'phase', phase: '6' }, custom);
  assert.deepEqual([r.deps[0].command, r.deps[0].action, t.calls.at(-1).command], ['npm install --offline', 'installed', 'npm install --offline']);
});

test('a failed install or a linked node_modules refuses the job: the slot stays free, the deps record unchanged, the link target untouched', () => {
  const { p, t, s1 } = ready({ files: LOCK });
  const failing = { ...t.deps, run: () => ({ code: 1, tail: 'npm ERR! network' }) };
  refused(() => prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, failing), 'install', /npm ci in the project root of .* failed \(exit 1\): npm ERR! network/);
  assert.equal(readSlotRecord(s1).job, null);
  assert.equal(fs.existsSync(depsFile(s1)), false);
  assert.equal(listSlots(p.root, t.config, t.deps)[0].state, 'free');
  const outside = tmpDir('outside');
  fs.writeFileSync(path.join(outside, 'keep.js'), 'x');
  fs.symlinkSync(outside, path.join(s1, 'node_modules'), 'junction');
  refused(() => prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps), 'link', /node_modules is a link/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.js'), 'utf8'), 'x');
  assert.deepEqual(t.calls, []);
});

test('free and trusted for a job; remove only a free slot, with its trust; links leading outside go as links; unmerged lane branches stop it (Review Focus 5)', () => {
  const { p, t, s1, s2 } = ready();
  assert.equal(freeSlot(p.root, t.config, t.deps).k, 1);
  untrustSlot(s1, { file: t.claudeJson });
  assert.equal(freeSlot(p.root, t.config, t.deps).k, 2, 'an untrusted slot takes no job');
  prepareSlot(p.root, 2, { kind: 'phase', phase: '3' }, t.deps);
  assert.equal(freeSlot(p.root, t.config, t.deps), null);
  refused(() => removeSlot(p.root, t.config, 2, t.deps), 'busy', /slot 2 holds phase 3 on turbo\/p3/);
  fs.writeFileSync(path.join(s2, 'work.js'), 'x');
  gitIn(s2, 'add', 'work.js');
  gitIn(s2, 'commit', '-q', '-m', 'work');
  releaseSlot(p.root, 2, { outcome: 'failed', config: t.config });
  refused(() => removeSlot(p.root, t.config, 2, t.deps), 'unmerged', /turbo\/p3/);
  gitIn(s2, 'checkout', '-q', '--detach', 'origin/main');
  gitIn(s2, 'branch', '-q', '-D', 'turbo/p3');
  const outside = tmpDir('outside');
  fs.writeFileSync(path.join(outside, 'keep.js'), 'x');
  fs.symlinkSync(outside, path.join(s2, 'node_modules'), 'junction');
  const r = removeSlot(p.root, t.config, 2, t.deps);
  assert.deepEqual([r.removed, r.untrust.status], [true, 'removed']);
  assert.equal(fs.existsSync(s2), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.js'), 'utf8'), 'x');
  assert.equal(trustState(s2, { file: t.claudeJson }), 'untrusted');
  assert.deepEqual(removeSlot(p.root, t.config, 2, t.deps), { k: 2, path: s2, removed: false, why: 'missing', untrust: null });
  const foreign = path.join(t.dir, 'lane-3');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'x'), 'x');
  refused(() => removeSlot(p.root, t.config, 3, t.deps), 'foreign');
  assert.equal(fs.existsSync(path.join(foreign, 'x')), true);
});

test('a failed job\'s commits are never reset or deleted: prepare of the same phase and of another phase refuses unmerged (C1)', () => {
  const { p, t, s1 } = ready();
  prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  fs.writeFileSync(path.join(s1, 'work.js'), 'x');
  gitIn(s1, 'add', 'work.js');
  gitIn(s1, 'commit', '-q', '-m', 'work');
  const work = head(s1);
  releaseSlot(p.root, 1, { outcome: 'failed', config: t.config });
  assert.equal(listSlots(p.root, t.config, t.deps)[0].state, 'free', 'committed work leaves the tree clean');
  refused(() => prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps), 'unmerged', /turbo\/p3/);
  assert.deepEqual([branchOf(s1), head(s1), gitIn(s1, 'rev-parse', 'turbo/p3')], ['turbo/p3', work, work]);
  refused(() => prepareSlot(p.root, 1, { kind: 'phase', phase: '4' }, t.deps), 'unmerged', /turbo\/p3/);
  assert.deepEqual([branchOf(s1), gitIn(s1, 'rev-parse', 'turbo/p3')], ['turbo/p3', work]);
  assert.equal(readSlotRecord(s1).job.outcome, 'failed');
  // once main has the work, the next job goes ahead and the old branch is deleted with -d
  p.git('fetch', '-q', s1, 'turbo/p3');
  p.git('merge', '-q', '--ff-only', 'FETCH_HEAD');
  const r = prepareSlot(p.root, 1, { kind: 'phase', phase: '4' }, t.deps);
  assert.deepEqual([r.branch, head(s1)], ['turbo/p4', work]);
  assert.equal(gitIn(s1, 'branch', '--list', 'turbo/p3'), '');
});

test('remove refuses any work main lacks: a branch of any name, a stash, a detached HEAD commit; nothing removed (I5)', () => {
  const { p, t, s1 } = ready();
  const keeps = () => assert.equal(fs.existsSync(path.join(s1, '.git')), true);
  gitIn(s1, 'checkout', '-q', '-b', 'feature');
  gitIn(s1, 'commit', '-q', '--allow-empty', '-m', 'feature work');
  gitIn(s1, 'checkout', '-q', '--detach', 'origin/main');
  refused(() => removeSlot(p.root, t.config, 1, t.deps), 'unmerged', /feature/);
  keeps();
  gitIn(s1, 'branch', '-q', '-D', 'feature');
  fs.appendFileSync(path.join(s1, 'README.md'), 'stashed\n');
  gitIn(s1, 'stash', '-q');
  refused(() => removeSlot(p.root, t.config, 1, t.deps), 'unmerged', /stash/);
  keeps();
  gitIn(s1, 'stash', 'drop', '-q');
  gitIn(s1, 'commit', '-q', '--allow-empty', '-m', 'detached work');
  refused(() => removeSlot(p.root, t.config, 1, t.deps), 'unmerged', /detached HEAD/);
  keeps();
  gitIn(s1, 'checkout', '-q', '--detach', 'origin/main');
  assert.equal(removeSlot(p.root, t.config, 1, t.deps).removed, true);
});
