import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { buildRepo } from './helpers/build.mjs';
import {
  BuildStateDamaged, SLICE_STATES, buildStateFile, loadBuildState, newBuildState, nextReady, planGraph, saveBuildState, setSlice,
} from '../lib/build-queue.mjs';

const P = (id, more = {}) => ({ id, files: [`src/${id}.js`], ...more });
const PLANS = [
  P('33-01', { files: ['src/one.js'] }),
  P('33-02', { deps: ['33-01'], files: ['src/two.js'] }),
  P('33-03', { files: ['src/one.js', 'src/three.js'] }),
  P('33-04', { deps: ['33-01'], files: ['src/four.js'], links: [['src/four.js', 'src/two.js']] }),
  P('33-05', { gap: true, files: ['src/five.js'] }),
];
const now = new Date('2026-10-17T12:00:00Z');

test('planGraph reads the round\'s plans, edges forward, SUMMARY in HEAD as done', () => {
  const repo = buildRepo({ plans: PLANS });
  const g = planGraph(repo.root, '33');
  assert.deepEqual(g.nodes.map((n) => n.id), ['33-01', '33-02', '33-03', '33-04']);
  assert.deepEqual(g.edges, [
    { from: '33-01', to: '33-02', kind: 'depends', why: '' },
    { from: '33-01', to: '33-04', kind: 'depends', why: '' },
    { from: '33-01', to: '33-03', kind: 'files', why: 'src/one.js' },
    { from: '33-02', to: '33-04', kind: 'reads', why: 'src/two.js' },
  ]);
  assert.deepEqual(g.order, ['33-01', '33-03', '33-02', '33-04']);
  const n2 = g.nodes.find((n) => n.id === '33-02');
  assert.equal(n2.plan, '.planning/phases/33-demo/33-02-PLAN.md');
  assert.equal(n2.summary, '.planning/phases/33-demo/33-02-SUMMARY.md');
  assert.deepEqual([n2.files, n2.deletions, n2.gapClosure, n2.done], [['src/two.js'], [], false, false]);
  assert.deepEqual(g.nodes.find((n) => n.id === '33-04').reads, ['src/two.js']);
  assert.deepEqual(g.dropped, []);
  assert.match(g.graphSha, /^[0-9a-f]{64}$/);

  repo.write(`${repo.rel}/33-02-SUMMARY.md`, '# done\n');
  assert.equal(planGraph(repo.root, '33').nodes.find((n) => n.id === '33-02').done, false, 'written, not committed');
  repo.commit('docs(33-02): summary');
  assert.equal(planGraph(repo.root, '33').nodes.find((n) => n.id === '33-02').done, true);

  const gaps = planGraph(repo.root, '33', { gaps: true });
  assert.deepEqual(gaps.nodes.map((n) => [n.id, n.gapClosure]), [['33-05', true]]);
  assert.notEqual(gaps.graphSha, g.graphSha);

  // line endings never change the graph; content does
  const file = path.join(repo.root, ...`${repo.rel}/33-03-PLAN.md`.split('/'));
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/\n/g, '\r\n'));
  assert.equal(planGraph(repo.root, '33').graphSha, g.graphSha);
  fs.writeFileSync(file, text.replace('Plan 33-03.', 'Plan 33-03, edited.'));
  assert.notEqual(planGraph(repo.root, '33').graphSha, g.graphSha);
});

test('planGraph refuses a depends_on cycle and a missing phase', () => {
  const repo = buildRepo({ plans: [P('33-01', { deps: ['33-02'] }), P('33-02', { deps: ['33-01'] })] });
  assert.throws(() => planGraph(repo.root, '33'), /depends_on cycle/);
  assert.throws(() => planGraph(repo.root, '34'), /no phase directory for phase 34/);
});

test('newBuildState and the state file', () => {
  const repo = buildRepo({ plans: PLANS });
  repo.write(`${repo.rel}/33-03-SUMMARY.md`, '# done\n');
  const head = repo.commit('docs(33-03): summary');
  const graph = planGraph(repo.root, '33');
  const s = newBuildState({ phase: '33', graph, head, now });
  assert.deepEqual([s.v, s.phase, s.round, s.head0, s.maxBuilders, s.graphSha, s.red, s.hold, s.startedAt], [1, '33', 0, head, 4, graph.graphSha, null, null, now.toISOString()]);
  assert.deepEqual(s.order, graph.order);
  assert.deepEqual(s.edges, graph.edges);
  assert.deepEqual(Object.fromEntries(Object.entries(s.slices).map(([id, x]) => [id, x.state])), { '33-01': 'waiting', '33-02': 'waiting', '33-03': 'done-before', '33-04': 'waiting' });
  const one = s.slices['33-01'];
  assert.deepEqual(one, {
    state: 'waiting', plan: '.planning/phases/33-demo/33-01-PLAN.md', summary: '.planning/phases/33-demo/33-01-SUMMARY.md', base: null, sessions: [], pid: null,
    worktree: null, branch: null, links: [], merge: null, tests: null, question: null, ownerQuestion: null, reason: null, retries: 0, rebuilds: 0, salvage: [],
    leftover: null, at: { waiting: now.toISOString() },
  });
  assert.equal(newBuildState({ phase: '33', graph, head, maxBuilders: 2, round: 1 }).maxBuilders, 2);

  const runDir = path.join(tmpDir('run'), 'run');
  assert.equal(loadBuildState(runDir, '33'), null, 'missing');
  saveBuildState(runDir, '33', s);
  assert.equal(buildStateFile(runDir, '33'), path.join(runDir, 'build-p33.json'));
  assert.deepEqual(loadBuildState(runDir, '33'), s);
  fs.writeFileSync(buildStateFile(runDir, '33'), '');
  assert.throws(() => loadBuildState(runDir, '33'), (e) => e instanceof BuildStateDamaged && e.message.includes(buildStateFile(runDir, '33')));
  fs.writeFileSync(buildStateFile(runDir, '33'), JSON.stringify({ v: 2, slices: {} }));
  assert.throws(() => loadBuildState(runDir, '33'), BuildStateDamaged);
});

// A state over hand-made slices: ids in plan order, edges [from, to].
function stateOf(ids, edges, { maxBuilders = 4 } = {}) {
  const nodes = ids.map((id) => ({ id, plan: `p/${id}-PLAN.md`, summary: `p/${id}-SUMMARY.md`, done: false }));
  return newBuildState({ phase: '33', graph: { nodes, edges: edges.map(([from, to]) => ({ from, to, kind: 'depends', why: '' })), order: ids, graphSha: 'x' }, head: 'h', maxBuilders, now });
}
const merge = (s, id) => {
  setSlice(s, id, 'dispatched', {}, now);
  setSlice(s, id, 'running', {}, now);
  setSlice(s, id, 'merged', { merge: 'm', tests: 'green' }, now);
};

test('setSlice follows the table', () => {
  assert.deepEqual(SLICE_STATES, ['waiting', 'dispatched', 'running', 'merged', 'owner', 'failed', 'blocked', 'done-before']);
  assert.ok(Object.isFrozen(SLICE_STATES));
  const allowed = {
    waiting: ['dispatched', 'done-before'],
    dispatched: ['running', 'waiting'],
    running: ['merged', 'owner', 'failed', 'blocked', 'waiting'],
    owner: ['running', 'waiting'],
    failed: ['waiting'],
    blocked: ['waiting', 'merged'],
    merged: ['waiting', 'done-before'],
    'done-before': [],
  };
  // a slice put into `from` the long way, through allowed moves only
  const route = { waiting: [], dispatched: ['dispatched'], running: ['dispatched', 'running'], owner: ['dispatched', 'running', 'owner'], failed: ['dispatched', 'running', 'failed'], blocked: ['dispatched', 'running', 'blocked'], merged: ['dispatched', 'running', 'merged'], 'done-before': ['done-before'] };
  for (const from of SLICE_STATES) {
    for (const to of SLICE_STATES) {
      const s = stateOf(['33-01'], []);
      for (const step of route[from]) setSlice(s, '33-01', step, {}, now);
      if (to === from) {
        const x = setSlice(s, '33-01', to, { reason: 'same' }, now);
        assert.deepEqual([x.state, x.reason], [from, 'same']);
      } else if (allowed[from].includes(to)) {
        const x = setSlice(s, '33-01', to, {}, new Date('2026-10-17T13:00:00Z'));
        assert.equal(x.state, to, `${from} -> ${to}`);
        assert.equal(x.at[to], '2026-10-17T13:00:00.000Z');
      } else {
        assert.throws(() => setSlice(s, '33-01', to, {}, now), /is not a build transition/, `${from} -> ${to}`);
        assert.equal(s.slices['33-01'].state, from, 'nothing changed');
      }
    }
  }
  const s = stateOf(['33-01'], []);
  assert.throws(() => setSlice(s, '33-09', 'dispatched'), /no slice 33-09/);
  setSlice(s, '33-01', 'dispatched', { session: { id: 'sess-1', role: 'builder' } }, now);
  setSlice(s, '33-01', 'running', { pid: 42, session: { id: 'sess-1', role: 'builder' } }, now);
  assert.deepEqual(s.slices['33-01'].sessions, [{ id: 'sess-1', role: 'builder', at: now.toISOString() }, { id: 'sess-1', role: 'builder', at: now.toISOString() }]);
  assert.equal(s.slices['33-01'].pid, 42);
  assert.equal('session' in s.slices['33-01'], false);
  setSlice(s, '33-01', 'failed', {}, now);
  setSlice(s, '33-01', 'waiting', {}, now);
  assert.equal(s.slices['33-01'].retries, 1);
  setSlice(s, '33-01', 'dispatched', {}, now);
  setSlice(s, '33-01', 'running', {}, now);
  setSlice(s, '33-01', 'blocked', { reason: 'conflict' }, now);
  setSlice(s, '33-01', 'waiting', {}, now);
  assert.deepEqual([s.slices['33-01'].retries, s.slices['33-01'].rebuilds], [1, 1]);
});

test('nextReady: a diamond, the longest remaining chain first, seats', () => {
  const D = [['33-01', '33-02'], ['33-01', '33-03'], ['33-02', '33-04'], ['33-03', '33-04']];
  const s = stateOf(['33-01', '33-02', '33-03', '33-04'], D);
  assert.deepEqual(nextReady(s), ['33-01']);
  merge(s, '33-01');
  assert.deepEqual(nextReady(s), ['33-02', '33-03']);
  merge(s, '33-02');
  assert.deepEqual(nextReady(s), ['33-03'], '33-04 waits for both');
  merge(s, '33-03');
  assert.deepEqual(nextReady(s), ['33-04']);

  const ids = ['33-01', '33-02', '33-03', '33-04', '33-05', '33-06'];
  const chain = stateOf(ids, [...D, ['33-03', '33-05'], ['33-05', '33-06']], { maxBuilders: 1 });
  merge(chain, '33-01');
  assert.deepEqual(nextReady(chain), ['33-03'], 'the longer remaining chain');
  const equal = stateOf(['33-01', '33-02', '33-03'], [], { maxBuilders: 1 });
  assert.deepEqual(nextReady(equal), ['33-01'], 'equal chains: plan order');
  assert.deepEqual(nextReady(equal, { maxBuilders: 2 }), ['33-01', '33-02']);

  const seats = stateOf(ids, [], { maxBuilders: 4 });
  setSlice(seats, '33-01', 'dispatched', {}, now);
  setSlice(seats, '33-02', 'dispatched', {}, now);
  setSlice(seats, '33-02', 'running', {}, now);
  assert.deepEqual(nextReady(seats), ['33-03', '33-04']);
  setSlice(seats, '33-02', 'owner', {}, now);
  assert.deepEqual(nextReady(seats), ['33-03', '33-04', '33-05'], 'an owner slice takes no seat');
});

test('nextReady stops', () => {
  const s = stateOf(['33-01', '33-02', '33-03'], [['33-01', '33-02']]);
  s.red = { after: '33-01', merge: 'm', line: 'not ok 1', log: 'x.log', at: now.toISOString() };
  assert.deepEqual(nextReady(s), []);
  s.red = null;
  s.hold = { reason: 'pause', at: now.toISOString() };
  assert.deepEqual(nextReady(s), []);
  s.hold = null;

  setSlice(s, '33-01', 'dispatched', {}, now);
  setSlice(s, '33-01', 'running', {}, now);
  setSlice(s, '33-01', 'merged', { merge: 'm', tests: null }, now);
  assert.deepEqual(nextReady(s), [], 'a merge not yet tested');
  setSlice(s, '33-01', 'merged', { tests: 'green' }, now);
  assert.deepEqual(nextReady(s), ['33-02', '33-03']);

  const o = stateOf(['33-01', '33-02', '33-03'], [['33-01', '33-02']]);
  setSlice(o, '33-01', 'dispatched', {}, now);
  setSlice(o, '33-01', 'running', {}, now);
  setSlice(o, '33-01', 'owner', { ownerQuestion: 'ask-1' }, now);
  assert.deepEqual(nextReady(o), ['33-03'], 'an owner slice holds its dependents only');

  const d = stateOf(['33-01', '33-02'], [['33-01', '33-02']]);
  setSlice(d, '33-01', 'done-before', {}, now);
  assert.deepEqual(nextReady(d), ['33-02'], 'done-before counts as merged');
});

test('a plan graph in a fresh state file from the repo', () => {
  const repo = buildRepo({ plans: [P('33-01'), P('33-02', { deps: ['33-01'] })] });
  const s = newBuildState({ phase: '33', graph: planGraph(repo.root, '33'), head: repo.git('rev-parse', 'HEAD') });
  assert.deepEqual(nextReady(s), ['33-01']);
});
