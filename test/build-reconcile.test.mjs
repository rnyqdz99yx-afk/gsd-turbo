import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitIn } from './helpers/slots.mjs';
import { buildRepo } from './helpers/build.mjs';
import { planText } from './helpers/whatif.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { askOwner, markDelivered, readQuestions } from '../lib/questions.mjs';
import {
  createSliceWorktree, loadBuildState, mergeSlice, mergeSubject, newBuildState, nextReady, planGraph, reconcileBuildState, saveBuildState, setSlice,
} from '../lib/build-queue.mjs';

const now = new Date('2026-10-17T12:00:00Z');
const PLANS = ['33-01', '33-02', '33-03'].map((id) => ({ id, files: [`src/${id}.js`] }));
const exists = (p) => fs.existsSync(p);
const branchExists = (root, b) => { try { gitIn(root, 'rev-parse', '--verify', '-q', `refs/heads/${b}`); return true; } catch { return false; } };
const merges = (l) => l.git('rev-list', '--count', '--merges', 'HEAD');

// A lane with a build state saved in its run directory, every slice waiting.
function lane(plans = PLANS) {
  const l = buildRepo({ plans });
  const runDir = path.join(l.root, '.planning', 'turbo', 'run');
  const state = newBuildState({ phase: '33', graph: planGraph(l.root, '33'), head: l.git('rev-parse', 'HEAD'), now });
  saveBuildState(runDir, '33', state);
  return { ...l, runDir, state };
}
// A slice as a dead build leaves it: dispatched, then running with its worktree recorded; `work` runs in the worktree.
function inFlight(l, id, work = () => {}, { to = 'running', pid = null } = {}) {
  const w = createSliceWorktree(l.root, { phase: '33', id, baseSha: l.git('rev-parse', 'HEAD') });
  setSlice(l.state, id, 'dispatched', { worktree: w.path, branch: w.branch, base: l.git('rev-parse', 'HEAD'), links: w.links }, now);
  if (to !== 'dispatched') setSlice(l.state, id, 'running', { pid, session: { id: `sess-${id}`, role: 'builder' } }, now);
  work(w);
  saveBuildState(l.runDir, '33', l.state);
  return w;
}
const commitIn = (w, files, msg) => {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(w.path, f)), { recursive: true });
    fs.writeFileSync(path.join(w.path, f), text);
  }
  gitIn(w.path, 'add', '-A');
  gitIn(w.path, 'commit', '-q', '-m', msg);
};
const finish = (l, id) => (w) => {
  commitIn(w, { [`src/${id}.js`]: `export const x = '${id}';\n` }, `feat(${id}): work`);
  commitIn(w, { [`${l.rel}/${id}-SUMMARY.md`]: '# Summary\n\n## Self-Check: PASSED\n' }, `docs(${id}): summary`);
};
const reconcile = (l, opts = {}) => reconcileBuildState(l.root, l.runDir, '33', { now, ...opts });
const acts = (r) => r.actions.map((a) => [a.id, a.action]);

test('a slice that finished is merged', () => {
  const l = lane();
  const w = inFlight(l, '33-02', finish(l, '33-02'));
  const r = reconcile(l);
  const s = r.state.slices['33-02'];
  assert.equal(s.state, 'merged');
  assert.equal(s.merge, l.git('rev-parse', 'HEAD'));
  assert.equal(l.git('log', '-1', '--format=%s'), mergeSubject('33', '33-02'));
  assert.equal(s.tests, null);
  assert.equal(exists(w.path), false);
  assert.deepEqual(r.actions.find((a) => a.action === 'merged'), { id: '33-02', action: 'merged', detail: s.merge });
  assert.deepEqual(r.actions.find((a) => a.action === 'test'), { id: '33-02', action: 'test', detail: s.merge });
  assert.deepEqual(nextReady(r.state), [], 'tested before anything new forks from it');
  assert.deepEqual(loadBuildState(l.runDir, '33'), r.state, 'saved');
});

test('a slice merged before the crash is not merged again', () => {
  // the branch merged, the state still running
  const l = lane();
  const w = inFlight(l, '33-02', finish(l, '33-02'));
  const m = mergeSlice(l.root, { phase: '33', id: '33-02', path: w.path, branch: w.branch });
  const tip = l.git('rev-parse', `${m.sha}^2`);
  l.git('branch', w.branch, tip); // the branch is still there
  const n = merges(l);
  let r = reconcile(l);
  assert.deepEqual([r.state.slices['33-02'].state, r.state.slices['33-02'].merge], ['merged', m.sha]);
  assert.equal(merges(l), n, 'no new merge commit');
  assert.equal(branchExists(l.root, w.branch), false);

  // the branch already deleted too: found by its subject on HEAD
  const l2 = lane();
  const w2 = inFlight(l2, '33-02', finish(l2, '33-02'));
  const m2 = mergeSlice(l2.root, { phase: '33', id: '33-02', path: w2.path, branch: w2.branch });
  r = reconcile(l2);
  assert.deepEqual([r.state.slices['33-02'].state, r.state.slices['33-02'].merge, r.state.slices['33-02'].tests], ['merged', m2.sha, null]);
  assert.deepEqual(acts(r), [['33-02', 'merged'], ['33-02', 'test']]);

  // SUMMARY on HEAD with no merge commit (made by hand): done-before
  const l3 = lane();
  setSlice(l3.state, '33-02', 'dispatched', {}, now);
  setSlice(l3.state, '33-02', 'running', {}, now);
  saveBuildState(l3.runDir, '33', l3.state);
  l3.write(`${l3.rel}/33-02-SUMMARY.md`, '# done by hand\n');
  l3.commit('docs(33-02): summary');
  r = reconcile(l3);
  assert.equal(r.state.slices['33-02'].state, 'done-before');
  assert.deepEqual(acts(r), [['33-02', 'done-before']]);
});

test('partial work is salvaged', () => {
  const l = lane();
  const w = inFlight(l, '33-02', (wt) => {
    commitIn(wt, { 'src/33-02.js': 'export const half = 1;\n' }, 'feat(33-02): half');
    fs.writeFileSync(path.join(wt.path, 'src', 'more.js'), 'export const more = 1;\n');
  });
  const r = reconcile(l);
  const name = 'turbo-salvage/33-02-20261017T120000Z';
  assert.deepEqual(r.actions.find((a) => a.action === 'salvaged'), { id: '33-02', action: 'salvaged', detail: name });
  const s = r.state.slices['33-02'];
  assert.equal(s.state, 'waiting');
  assert.deepEqual(s.salvage, [name]);
  assert.deepEqual(l.git('log', '--format=%s', `main..${name}`).split('\n'), ['wip(33-02): uncommitted work salvaged by turbo', 'feat(33-02): half']);
  assert.equal(l.git('show', `${name}:src/more.js`), 'export const more = 1;');
  assert.equal(branchExists(l.root, 'turbo-build/33-02'), false);
  assert.equal(exists(w.path), false);
  assert.deepEqual([s.worktree, s.branch, s.pid], [null, null, null]);
  // the slice is built again from a fresh worktree
  assert.deepEqual(nextReady(r.state), ['33-01', '33-02', '33-03']);
  assert.ok(createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.git('rev-parse', 'HEAD') }).path);
});

// What a removal Windows stopped halfway leaves: git dropped the worktree's record and its .git file, the files stay.
function halfRemoved(l, w) {
  const admin = path.resolve(w.path, gitIn(w.path, 'rev-parse', '--git-dir'));
  fs.rmSync(admin, { recursive: true, force: true });
  fs.rmSync(path.join(w.path, '.git'), { force: true });
}

test('salvage runs no hook, and keeps a detached HEAD the builder committed on', () => {
  const l = lane();
  const w = inFlight(l, '33-02', (wt) => {
    commitIn(wt, { 'src/33-02.js': 'export const half = 1;\n' }, 'feat(33-02): half');
    gitIn(wt.path, 'checkout', '-q', '--detach');
    commitIn(wt, { 'src/33-02.js': 'export const half = 2;\n' }, 'feat(33-02): detached');
    fs.writeFileSync(path.join(wt.path, 'src', 'more.js'), 'export const more = 1;\n');
  });
  // the project's hooks refuse every commit and every commit message
  for (const h of ['pre-commit', 'commit-msg']) fs.writeFileSync(path.join(l.root, '.git', 'hooks', h), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const r = reconcile(l);
  const name = 'turbo-salvage/33-02-20261017T120000Z';
  assert.deepEqual(acts(r), [['33-02', 'salvaged']]);
  assert.deepEqual(l.git('log', '--format=%s', `main..${name}`).split('\n'), ['wip(33-02): uncommitted work salvaged by turbo', 'feat(33-02): detached', 'feat(33-02): half']);
  assert.equal(l.git('show', `${name}:src/more.js`), 'export const more = 1;');
  assert.equal(r.state.slices['33-02'].state, 'waiting');
  assert.equal(branchExists(l.root, 'turbo-build/33-02'), false, 'the salvage branch holds all of it');
  assert.equal(exists(w.path), false);
});

test('a folder a halfway removal left inside another repository: git never runs in it', () => {
  const outer = buildRepo({ plans: [] });
  outer.write('outer-dirty.txt', 'the owner\'s own uncommitted file\n');
  const commits = outer.git('rev-list', '--count', 'HEAD');
  const l = buildRepo({ plans: PLANS, config: { lanes: { dir: path.join(outer.root, 'slots') } } });
  const runDir = path.join(l.root, '.planning', 'turbo', 'run');
  const state = newBuildState({ phase: '33', graph: planGraph(l.root, '33'), head: l.git('rev-parse', 'HEAD'), now });
  const ctx = { ...l, runDir, state };
  const w = inFlight(ctx, '33-02', (wt) => commitIn(wt, { 'src/33-02.js': 'export const half = 1;\n' }, 'feat(33-02): half'));
  assert.ok(w.path.startsWith(outer.root));
  const tip = gitIn(w.path, 'rev-parse', 'HEAD');
  halfRemoved(l, w);
  fs.writeFileSync(path.join(w.path, 'src', 'left.js'), 'left behind\n');
  const r = reconcile(ctx);
  assert.deepEqual(acts(r), [['33-02', 'salvaged']]);
  assert.equal(l.git('rev-parse', 'refs/heads/turbo-salvage/33-02-20261017T120000Z'), tip);
  assert.equal(exists(w.path), false, 'what was left is deleted as a plain folder');
  assert.equal(outer.git('rev-list', '--count', 'HEAD'), commits, 'no commit in the repository around it');
  assert.equal(outer.git('status', '--porcelain', '--', 'outer-dirty.txt'), '?? outer-dirty.txt');
  assert.equal(r.state.slices['33-02'].leftover, null);
  assert.ok(createSliceWorktree(l.root, { phase: '33', id: '33-02', baseSha: l.git('rev-parse', 'HEAD') }).path, 'the slice is built again');
});

test('nothing done: requeued, also for an orphan branch of a waiting slice', () => {
  const l = lane();
  const w = inFlight(l, '33-02');
  // a crash between worktree add and the save: the state still says waiting
  const orphan = createSliceWorktree(l.root, { phase: '33', id: '33-03', baseSha: l.git('rev-parse', 'HEAD') });
  const r = reconcile(l);
  assert.deepEqual(acts(r), [['33-02', 'requeued'], ['33-03', 'requeued']]);
  for (const [id, p] of [['33-02', w.path], ['33-03', orphan.path]]) {
    assert.equal(r.state.slices[id].state, 'waiting');
    assert.equal(exists(p), false);
    assert.equal(branchExists(l.root, `turbo-build/${id}`), false);
  }
  assert.equal(l.git('for-each-ref', '--format=%(refname)', 'refs/heads/turbo-salvage'), '', 'nothing to salvage');
});

test('a live session is left alone', () => {
  const l = lane();
  const w = inFlight(l, '33-02', () => {}, { pid: 4242 });
  const r = reconcile(l, { alive: (s) => s.pid === 4242 });
  assert.deepEqual(r.actions, [{ id: '33-02', action: 'alive', detail: 4242 }]);
  assert.equal(r.state.slices['33-02'].state, 'running');
  assert.ok(exists(w.path));
  assert.ok(branchExists(l.root, w.branch));
});

test('a merge that left HEAD', () => {
  for (const summaryOnHead of [true, false]) {
    const l = lane();
    const before = l.git('rev-parse', 'HEAD');
    const w = inFlight(l, '33-02', finish(l, '33-02'));
    const m = mergeSlice(l.root, { phase: '33', id: '33-02', path: w.path, branch: w.branch });
    setSlice(l.state, '33-02', 'merged', { merge: m.sha, tests: 'green' }, now);
    saveBuildState(l.runDir, '33', l.state);
    l.git('reset', '-q', '--hard', before);
    if (summaryOnHead) {
      l.write(`${l.rel}/33-02-SUMMARY.md`, '# kept by hand\n');
      l.commit('docs(33-02): summary');
    }
    const work = l.git('rev-parse', `${m.sha}^2`);
    const r = reconcile(l);
    assert.equal(r.state.slices['33-02'].state, summaryOnHead ? 'done-before' : 'waiting');
    assert.deepEqual(acts(r), [['33-02', 'salvaged'], ['33-02', summaryOnHead ? 'done-before' : 'requeued']]);
    assert.equal(r.state.slices['33-02'].merge, null);
    // the slice's commits, on no ref after the reset, are kept
    assert.equal(l.git('rev-parse', 'refs/heads/turbo-salvage/33-02-20261017T120000Z'), work);
    assert.deepEqual(acts(reconcile(l)), [], 'kept once');
  }
});

test('a merged slice\'s leftover worktree is cleaned', () => {
  const l = lane();
  const w = inFlight(l, '33-02', finish(l, '33-02'));
  const m = mergeSlice(l.root, { phase: '33', id: '33-02', path: w.path, branch: w.branch });
  // a worktree left over from a merge (Windows held a file): made again by hand
  l.git('worktree', 'add', '-q', '--detach', w.path.split(path.sep).join('/'), m.sha);
  setSlice(l.state, '33-02', 'merged', { merge: m.sha, tests: 'green', leftover: w.path }, now);
  saveBuildState(l.runDir, '33', l.state);
  const r = reconcile(l);
  assert.deepEqual(r.actions, [{ id: '33-02', action: 'cleaned', detail: w.path }]);
  assert.equal(exists(w.path), false);
  assert.equal(r.state.slices['33-02'].leftover, null);
  assert.deepEqual(reconcile(l).actions, []);
});

const ASK = { question: 'Which cache do we keep?', options: [{ label: 'Memory', description: 'Fast' }, { label: 'Disk', description: 'Slow' }], recommended: 1 };
function ownerLane() {
  const l = lane();
  const w = inFlight(l, '33-02', (wt) => commitIn(wt, { 'src/33-02.js': 'export const half = 1;\n' }, 'feat(33-02): half'));
  const { question } = askOwner(l.root, '33', ASK, { now, keepRunning: true });
  setSlice(l.state, '33-02', 'owner', { question: question.id, ownerQuestion: { question: ASK.question, context: '', options: ASK.options }, pid: null }, now);
  saveBuildState(l.runDir, '33', l.state);
  return { l, w, ask: question.id };
}

test('owner by card state', () => {
  // open: nothing
  let { l, w, ask } = ownerLane();
  let r = reconcile(l);
  assert.deepEqual(r.actions, []);
  assert.equal(r.state.slices['33-02'].state, 'owner');
  assert.ok(exists(w.path));
  // answered: the answer goes to the same session
  answerQuestion({ root: l.root, phase: '33', id: ask, option: 1, by: 'pane', laneRunning: true });
  r = reconcile(l);
  assert.deepEqual(r.actions, [{ id: '33-02', action: 'answered', detail: ask }]);
  assert.equal(r.state.slices['33-02'].state, 'owner');
  assert.ok(exists(w.path), 'the worktree kept for the resumed session');
  // delivered: a running slice without a process (its partial work is salvaged)
  markDelivered(l.root, '33', ask, 'lane');
  r = reconcile(l);
  assert.deepEqual(acts(r), [['33-02', 'salvaged']]);
  assert.equal(r.state.slices['33-02'].state, 'waiting');

  // the card is gone: asked again
  ({ l, w, ask } = ownerLane());
  fs.rmSync(path.join(l.runDir, 'p33-questions.json'));
  r = reconcile(l);
  assert.deepEqual(r.actions, [{ id: '33-02', action: 'reask', detail: ask }]);
  assert.equal(r.state.slices['33-02'].state, 'owner');

  // built in an attend sitting: SUMMARY on HEAD, the card dropped, the partial work kept
  ({ l, w, ask } = ownerLane());
  l.write(`${l.rel}/33-02-SUMMARY.md`, '# built in the sitting\n');
  l.commit('docs(33-02): summary');
  r = reconcile(l);
  assert.equal(r.state.slices['33-02'].state, 'done-before');
  assert.deepEqual(acts(r), [['33-02', 'salvaged'], ['33-02', 'done-before']]);
  assert.deepEqual(readQuestions(l.root, '33').map((q) => q.id), []);
  assert.equal(exists(w.path), false);
});

test('red and graph', () => {
  const l = lane();
  l.state.red = { after: '33-01', merge: 'abc1234', line: 'not ok 1 - b', log: 'x.log', at: now.toISOString() };
  setSlice(l.state, '33-01', 'dispatched', {}, now);
  saveBuildState(l.runDir, '33', l.state);
  // plans edited since: 33-02 changed, 33-03 gone, 33-04 new
  l.write(`${l.rel}/33-02-PLAN.md`, planText({ id: '33-02', files: ['src/33-02.js', 'src/extra.js'] }));
  fs.rmSync(path.join(l.root, ...`${l.rel}/33-03-PLAN.md`.split('/')));
  l.write(`${l.rel}/33-04-PLAN.md`, planText({ id: '33-04', deps: ['33-02'], files: ['src/33-04.js'] }));
  l.commit('docs(33): plans changed');
  const r = reconcile(l);
  assert.equal(r.actions[0].action, 'graph');
  assert.deepEqual(acts(r).slice(1), [['33-01', 'requeued'], [null, 'retest']]);
  assert.deepEqual(Object.keys(r.state.slices).sort(), ['33-01', '33-02', '33-04']);
  assert.equal(r.state.slices['33-04'].state, 'waiting');
  assert.deepEqual(r.state.order, ['33-01', '33-02', '33-04']);
  assert.deepEqual(r.state.edges, [{ from: '33-02', to: '33-04', kind: 'depends', why: '' }]);
  assert.equal(r.state.graphSha, planGraph(l.root, '33').graphSha);
  assert.deepEqual(r.actions.at(-1), { id: null, action: 'retest', detail: 'abc1234' });
});

test('idempotent: a second call returns only the standing actions', () => {
  const l = lane([...PLANS, { id: '33-04', files: ['src/33-04.js'] }]);
  inFlight(l, '33-01', finish(l, '33-01')); // merged -> test
  inFlight(l, '33-02', () => {}, { pid: 7 }); // alive
  inFlight(l, '33-03', (w) => commitIn(w, { 'src/33-03.js': 'x\n' }, 'half')); // salvaged
  l.state.red = { after: '33-01', merge: 'abc1234', line: 'x', log: 'x.log', at: now.toISOString() };
  saveBuildState(l.runDir, '33', l.state);
  const alive = (s) => s.pid === 7;
  const first = reconcile(l, { alive });
  assert.deepEqual(acts(first), [['33-01', 'merged'], ['33-02', 'alive'], ['33-03', 'salvaged'], [null, 'retest'], ['33-01', 'test']]);
  const second = reconcile(l, { alive });
  assert.deepEqual(acts(second), [['33-02', 'alive'], [null, 'retest'], ['33-01', 'test']]);
  assert.deepEqual(second.state.slices, first.state.slices);
});

test('no state file: nothing to reconcile', () => {
  const l = buildRepo({ plans: PLANS });
  assert.deepEqual(reconcileBuildState(l.root, path.join(l.root, '.planning', 'turbo', 'run'), '33'), { state: null, actions: [] });
});
