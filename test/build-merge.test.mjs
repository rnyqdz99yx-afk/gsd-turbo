import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitIn } from './helpers/slots.mjs';
import { buildRepo } from './helpers/build.mjs';
import { BuildLocked, MERGE_RETRY_MS, buildLockFile, createSliceWorktree, mergeSlice, mergeSubject, runMergeTests } from '../lib/build-queue.mjs';

const PLANS = ['33-01', '33-02', '33-03', '33-04'].map((id) => ({ id, files: [`src/${id}.js`] }));
const TEST_OF = (name) => `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { ${name} } from '../src/${name}.js';\ntest('${name}', () => assert.equal(${name}, 1));\n`;

function lane() {
  const l = buildRepo({ plans: PLANS });
  l.write('src/a.js', 'export const a = 1;\n');
  l.write('test/a.test.js', TEST_OF('a'));
  l.write('src/b.js', 'export const b = 1;\n');
  l.write('test/b.test.js', TEST_OF('b'));
  l.write('src/shared.js', 'export const shared = 0;\n');
  l.commit('feat: code');
  return l;
}
const head = (l) => l.git('rev-parse', 'HEAD');
const exists = (p) => fs.existsSync(p);
const branchExists = (root, b) => { try { gitIn(root, 'rev-parse', '--verify', '-q', `refs/heads/${b}`); return true; } catch { return false; } };
const mergeHead = (root) => { try { gitIn(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'); return true; } catch { return false; } };

// A builder's work in the slice worktree: files, a commit, then its SUMMARY committed (summary: false leaves it out).
function built(l, id, files = { [`src/${id}.js`]: `export const x = '${id}';\n` }, { summary = '# Summary\n\n## Self-Check: PASSED\n', base = head(l) } = {}) {
  const w = createSliceWorktree(l.root, { phase: '33', id, baseSha: base });
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(w.path, f)), { recursive: true });
    fs.writeFileSync(path.join(w.path, f), text);
  }
  gitIn(w.path, 'add', '-A');
  gitIn(w.path, 'commit', '-q', '--allow-empty', '-m', `feat(${id}): work`);
  if (summary !== false) {
    fs.writeFileSync(path.join(w.path, ...`${l.rel}/${id}-SUMMARY.md`.split('/')), summary);
    gitIn(w.path, 'add', '-A');
    gitIn(w.path, 'commit', '-q', '-m', `docs(${id}): summary`);
  }
  return { phase: '33', id, ...w };
}
const kept = (l, s, before) => {
  assert.equal(head(l), before, 'HEAD unchanged');
  assert.equal(mergeHead(l.root), false, 'no MERGE_HEAD');
  assert.equal(l.git('status', '--porcelain'), '', 'a clean checkout');
  assert.equal(branchExists(l.root, s.branch), true, 'the branch kept');
  assert.equal(exists(s.path), true, 'the worktree kept');
};

test('two siblings from one base merge in either order', () => {
  const l = lane();
  const base = head(l);
  const two = built(l, '33-02', undefined, { base });
  const three = built(l, '33-03', undefined, { base });
  const r3 = mergeSlice(l.root, three);
  const r2 = mergeSlice(l.root, two);
  for (const [r, id] of [[r3, '33-03'], [r2, '33-02']]) {
    assert.match(r.sha, /^[0-9a-f]{40}$/, JSON.stringify(r));
    assert.equal(r.blocked, undefined);
    assert.equal(l.git('rev-list', '--parents', '-n', '1', r.sha).split(' ').length, 3, 'two parents');
    assert.equal(l.git('log', '-1', '--format=%s', r.sha), `chore(phase-33): merge slice ${id}`);
    assert.equal(mergeSubject('33', id), `chore(phase-33): merge slice ${id}`);
  }
  assert.equal(head(l), r2.sha);
  for (const s of [two, three]) {
    assert.equal(exists(s.path), false);
    assert.equal(branchExists(l.root, s.branch), false);
  }
  const four = createSliceWorktree(l.root, { phase: '33', id: '33-04', baseSha: head(l) });
  for (const f of ['src/33-02.js', 'src/33-03.js', `${l.rel}/33-02-SUMMARY.md`, `${l.rel}/33-03-SUMMARY.md`]) assert.ok(exists(path.join(four.path, f)), f);
});

test('artifacts are checked before anything is merged', () => {
  const l = lane();
  const before = head(l);
  const none = built(l, '33-02', undefined, { summary: false });
  assert.deepEqual(mergeSlice(l.root, none), { blocked: true, kind: 'artifacts', reason: 'no .planning/phases/33-demo/33-02-SUMMARY.md on turbo-build/33-02' });
  kept(l, none, before);

  const failed = built(l, '33-03', undefined, { summary: '# Summary\n\n## Self-Check: FAILED\n\n- tests red\n' });
  const f = mergeSlice(l.root, failed);
  assert.deepEqual([f.blocked, f.kind], [true, 'artifacts']);
  assert.match(f.reason, /Self-Check: FAILED/);
  kept(l, failed, before);

  const dirty = built(l, '33-04');
  fs.writeFileSync(path.join(dirty.path, 'notes.txt'), 'left over\n');
  const d = mergeSlice(l.root, dirty);
  assert.deepEqual([d.blocked, d.kind], [true, 'dirty']);
  assert.match(d.reason, /notes\.txt/);
  kept(l, dirty, before);
  fs.rmSync(path.join(dirty.path, 'notes.txt'));

  fs.writeFileSync(path.join(l.root, 'src', 'a.js'), 'export const a = 1; // edited\n');
  const c = mergeSlice(l.root, dirty);
  assert.deepEqual([c.blocked, c.kind], [true, 'checkout']);
  assert.match(c.reason, /src\/a\.js/);
  assert.equal(head(l), before);
  assert.equal(exists(dirty.path), true);
  l.git('checkout', '--', 'src/a.js');

  // a SUMMARY already in HEAD and a branch with no commit beyond it
  const l2 = lane();
  l2.write(`${l2.rel}/33-02-SUMMARY.md`, '# Summary\n');
  const b2 = l2.commit('docs(33-02): summary');
  const empty = { phase: '33', id: '33-02', ...createSliceWorktree(l2.root, { phase: '33', id: '33-02', baseSha: b2 }) };
  assert.deepEqual(mergeSlice(l2.root, empty), { blocked: true, kind: 'artifacts', reason: 'no commit on turbo-build/33-02' });
  kept(l2, empty, b2);
});

test('a conflict is aborted', () => {
  const l = lane();
  const base = head(l);
  const one = built(l, '33-02', { 'src/shared.js': 'export const shared = 2;\n' }, { base });
  const two = built(l, '33-03', { 'src/shared.js': 'export const shared = 3;\n' }, { base });
  assert.ok(mergeSlice(l.root, one).sha);
  const after = head(l);
  const r = mergeSlice(l.root, two);
  assert.deepEqual([r.blocked, r.kind], [true, 'conflict']);
  assert.match(r.reason, /merge conflict in src\/shared\.js/);
  kept(l, two, after);
});

test('a held index.lock is waited for', () => {
  const l = lane();
  const s = built(l, '33-02');
  const lock = path.join(l.root, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const sleeps = [];
  const r = mergeSlice(l.root, s, { sleep: (ms) => { sleeps.push(ms); fs.rmSync(lock, { force: true }); } });
  assert.match(r.sha ?? '', /^[0-9a-f]{40}$/, JSON.stringify(r));
  assert.deepEqual(sleeps, [2000]);

  const l2 = lane();
  const before = head(l2);
  const s2 = built(l2, '33-02');
  fs.writeFileSync(path.join(l2.root, '.git', 'index.lock'), '');
  const waited = [];
  const r2 = mergeSlice(l2.root, s2, { sleep: (ms) => waited.push(ms) });
  assert.deepEqual([r2.blocked, r2.kind], [true, 'lock']);
  assert.match(r2.reason, /index\.lock/);
  assert.deepEqual(waited, [...MERGE_RETRY_MS]);
  assert.deepEqual(waited, [2000, 4000, 8000]);
  kept(l2, s2, before);
});

test('already merged (a crash after the merge)', () => {
  const l = lane();
  const s = built(l, '33-02');
  const tip = gitIn(s.path, 'rev-parse', 'HEAD');
  const first = mergeSlice(l.root, s);
  assert.ok(first.sha);
  const merges = l.git('rev-list', '--count', '--merges', 'HEAD');
  l.git('branch', s.branch, tip);
  const again = mergeSlice(l.root, s);
  assert.deepEqual(again, { sha: first.sha, already: true });
  assert.equal(l.git('rev-list', '--count', '--merges', 'HEAD'), merges);
  assert.equal(branchExists(l.root, s.branch), false, 'the merged branch goes');
});

test('the build lock orders merges', () => {
  const l = lane();
  const before = head(l);
  const s = built(l, '33-02');
  const file = buildLockFile(l.root, '33');
  assert.equal(file, path.join(l.root, '.planning', 'turbo', 'locks', 'build-p33'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${process.pid}-held-by-a-live-process`);
  assert.throws(() => mergeSlice(l.root, s, { lockWaitMs: 200 }), (e) => e instanceof BuildLocked && /build-p33/.test(e.message));
  assert.equal(head(l), before, 'the merge did not run');
  assert.ok(exists(file), 'the other owner\'s lock is left alone');
});

test('a lock a dead build left is taken over at once; a very old one even when its pid runs again', () => {
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  for (const [token, ageMs] of [[`${dead}-a-killed-build`, 60000], [`${process.pid}-a-reused-pid`, 31 * 60000]]) {
    const l = lane();
    const s = built(l, '33-02');
    const file = buildLockFile(l.root, '33');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token);
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
    const t0 = Date.now();
    const r = mergeSlice(l.root, s, { lockWaitMs: 5000 });
    assert.match(r.sha ?? '', /^[0-9a-f]{40}$/, `${token}: ${JSON.stringify(r)}`);
    assert.ok(Date.now() - t0 < 5000, 'not waited out');
    assert.equal(exists(file), false, 'released');
  }
  // a fresh lock is waited on, even when its owner is gone: it may still be writing its token
  const l = lane();
  const s = built(l, '33-02');
  const file = buildLockFile(l.root, '33');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${dead}-just-made`);
  assert.throws(() => mergeSlice(l.root, s, { lockWaitMs: 300 }), BuildLocked);
});

test('runMergeTests: the targeted tests of one merge, a red one, a retest', async () => {
  const l = lane();
  const runDir = path.join(l.root, '.planning', 'turbo', 'run');
  const first = await runMergeTests(l.root, runDir, '33', { sha: null });
  assert.equal(first.green, true, fs.readFileSync(first.log, 'utf8'));
  assert.match(path.basename(first.log), /^tests-retest-\d+\.log$/);
  assert.equal(path.dirname(first.log), path.join(runDir, 'build-p33'));
  assert.match(fs.readFileSync(first.log, 'utf8'), /\[turbo-test\] full: no previous full green run/);

  const green = built(l, '33-02', { 'src/b.js': 'export const b = 1; // slice\n' });
  const g = mergeSlice(l.root, green);
  const r = await runMergeTests(l.root, runDir, '33', { sha: g.sha });
  assert.deepEqual([r.green, r.code], [true, 0], fs.readFileSync(r.log, 'utf8'));
  assert.equal(r.log, path.join(runDir, 'build-p33', `tests-${g.sha.slice(0, 7)}.log`));
  assert.match(fs.readFileSync(r.log, 'utf8'), new RegExp(`merge ${g.sha.slice(0, 7)}: targeted`));

  const red = built(l, '33-03', { 'src/b.js': 'export const b = 2;\n' });
  const m = mergeSlice(l.root, red);
  const x = await runMergeTests(l.root, runDir, '33', { sha: m.sha });
  assert.equal(x.green, false);
  assert.notEqual(x.code, 0);
  const lines = fs.readFileSync(x.log, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  assert.equal(x.line, lines.at(-1));
  assert.ok(lines.some((s) => s.includes(`merge ${m.sha.slice(0, 7)}: targeted`)));
});
