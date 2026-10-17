import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonId, criticalPath, edgeCosts, gsdWaves, keyLinkPaths, pathsMeet, planEdges, planIdOf, planInfo, resolveDeps, simulateGraph, simulateWaves } from '../lib/exec-graph.mjs';
import { planText } from './helpers/whatif.mjs';

const info = (p) => planInfo(planText(p), p.id);
const mins = (o) => new Map(Object.entries(o));

test('planInfo reads GSD frontmatter: waves, depends_on in every spelling, written files, key_links reads, checkpoints, gap closure', () => {
  const p = info({ id: '32-04', wave: 2, deps: ['01', '32-02-auth', 'none'], files: ['./src\\a.ts', 'src/b.ts'], deleted: ['src/old.ts'], links: [['src/a.ts', 'src/api/route.ts'], ['src/b.ts', 'src/db.ts']], autonomous: false, gap: true });
  assert.equal(p.declaredWave, 2);
  assert.deepEqual(p.dependsOn, ['32-01', '32-02']);
  assert.deepEqual(p.writes, ['src/a.ts', 'src/b.ts', 'src/old.ts']);
  assert.deepEqual(p.reads, ['src/api/route.ts', 'src/db.ts'], 'a key_link file the plan writes itself is no read');
  assert.equal(p.autonomous, false);
  assert.equal(p.gapClosure, true);
  const block = planInfo('---\nwave: 1\ndepends_on:\n  - "32-01"\nfiles_modified:\n  - src/x.ts # main\n  - \'src/y.ts\'\nautonomous: true\n---\n', '32-03');
  assert.deepEqual([block.dependsOn, block.writes, block.reads, block.autonomous, block.gapClosure], [['32-01'], ['src/x.ts', 'src/y.ts'], [], true, false]);
});

test('keyLinkPaths: object links (from/to), bare-string links by their path words, an inline list, nothing outside the block', () => {
  const text = '---\nmust_haves:\n  truths: ["a.b works"]\n  key_links:\n    - from: "src/ui/Chat.tsx"\n      to: src/api/chat.ts\n      via: "fetch /api/chat"\n      pattern: "fetch.*"\n    - "src/a.ts -> src/b.ts via import"\n  artifacts: []\nfiles_modified: [src/z.ts]\n---\n';
  assert.deepEqual(keyLinkPaths(text), ['src/ui/Chat.tsx', 'src/api/chat.ts', 'src/a.ts', 'src/b.ts']);
  assert.deepEqual(keyLinkPaths('---\nkey_links: ["lib/x.mjs calls lib/y.mjs"]\n---\n'), ['lib/x.mjs', 'lib/y.mjs']);
  assert.deepEqual(keyLinkPaths('no frontmatter'), []);
});

test('ids and paths compare as GSD reads them', () => {
  assert.equal(canonId('032-07'), canonId('32-7'));
  assert.equal(planIdOf('32-07-auth'), '32-07');
  assert.equal(planIdOf('09.2-01'), '09.2-01');
  assert.ok(pathsMeet('src/a.ts', './src/a.ts'));
  assert.ok(pathsMeet('src/api/**', 'src/api/x/route.ts'), 'a glob meets the files under its fixed start');
  assert.ok(pathsMeet('src/api/', 'src/api/x.ts'), 'a directory meets its files');
  assert.ok(!pathsMeet('src/a.ts', 'src/a.tsx'));
});

test('gsdWaves: the longest depends_on path, declared waves ignored, as phase.cjs computes them; dropped tokens named; a cycle throws', () => {
  const plans = [
    info({ id: '32-01' }),
    info({ id: '32-02', wave: 3, deps: ['32-01'] }),
    info({ id: '32-03', deps: ['32-01', '32-02', '31-04'] }),
    info({ id: '32-04', wave: 2 }),
  ];
  const { deps, dropped } = resolveDeps(plans);
  assert.deepEqual(dropped, [{ plan: '32-03', token: '31-04' }]);
  assert.deepEqual(Object.fromEntries(gsdWaves(plans, deps)), { '32-01': 1, '32-02': 2, '32-03': 3, '32-04': 1 });
  assert.throws(() => gsdWaves([info({ id: '32-01', deps: ['32-02'] }), info({ id: '32-02', deps: ['32-01'] })]), /cycle among: 32-01, 32-02/);
});

test('planEdges: depends_on, then a shared written file and a key_links read from an earlier plan to a later one, each pair once', () => {
  const plans = [
    info({ id: '32-01', files: ['src/a.ts'] }),
    info({ id: '32-02', files: ['src/b.ts'], links: [['src/b.ts', 'src/a.ts']] }), // reads 32-01's file, same wave: 32-01 is earlier
    info({ id: '32-03', wave: 2, deps: ['32-01'], files: ['src/a.ts'] }), // also shares src/a.ts: one depends edge only
    info({ id: '32-04', wave: 2, files: ['src/c.ts'], deleted: ['src/b.ts'] }), // deletes 32-02's file
    info({ id: '32-05', wave: 3, files: ['src/d.ts'], links: [['src/d.ts', 'src/c.ts']] }), // reads 32-04's file
  ];
  assert.deepEqual(planEdges(plans).map((e) => [e.from, e.to, e.kind, e.why]), [
    ['32-01', '32-03', 'depends', ''],
    ['32-01', '32-02', 'reads', 'src/a.ts'],
    ['32-02', '32-04', 'files', 'src/b.ts'],
    ['32-04', '32-05', 'reads', 'src/c.ts'],
  ]);
  assert.deepEqual(planEdges(plans, ['depends']).length, 1);
  assert.deepEqual(planEdges(plans, ['depends', 'files']).map((e) => e.kind), ['depends', 'files']);
});

test('simulateWaves: a barrier and a tail after every wave; a wave with a shared file runs one plan at a time; executors capped', () => {
  const plans = [
    info({ id: '32-01', files: ['src/a.ts'] }),
    info({ id: '32-02', files: ['src/b.ts'] }),
    info({ id: '32-03', files: ['src/c.ts'] }),
    info({ id: '32-04', deps: ['32-01'], files: ['src/x.ts'] }),
    info({ id: '32-05', deps: ['32-02'], files: ['src/x.ts'] }),
  ];
  const minutes = mins({ '32-01': 20, '32-02': 5, '32-03': 5, '32-04': 10, '32-05': 10 });
  const r = simulateWaves(plans, { minutes, tail: 5 });
  assert.equal(r.total, 20 + 5 + 20 + 5);
  assert.deepEqual(r.waves.map((w) => [w.wave, w.ids, w.sequential, w.exec]), [[1, ['32-01', '32-02', '32-03'], false, 20], [2, ['32-04', '32-05'], true, 20]]);
  assert.deepEqual(r.waves[1].overlap, { a: '32-04', b: '32-05', file: 'src/x.ts' });
  assert.deepEqual([r.start.get('32-04'), r.start.get('32-05')], [25, 35]);
  // two executors: 32-01 and 32-02 first, 32-03 when 32-02 is done
  assert.equal(simulateWaves(plans, { minutes, tail: 5, maxExecutors: 2 }).waves[0].exec, 20);
  assert.equal(simulateWaves(plans, { minutes, tail: 5, maxExecutors: 1 }).waves[0].exec, 30);
});

test('simulateGraph: a plan starts when its predecessors are merged; merges one at a time; the longest remaining path first', () => {
  const plans = [
    info({ id: '32-01', files: ['src/a.ts'] }),
    info({ id: '32-02', files: ['src/b.ts'] }),
    info({ id: '32-03', deps: ['32-02'], files: ['src/c.ts'] }),
    info({ id: '32-04', deps: ['32-03'], files: ['src/d.ts'] }),
  ];
  const minutes = mins({ '32-01': 30, '32-02': 5, '32-03': 5, '32-04': 5 });
  const edges = planEdges(plans);
  // waves: 30 + 5 | 5 + 5 | 5 + 5 = 55; graph: the chain runs beside 32-01
  assert.equal(simulateWaves(plans, { minutes, tail: 5 }).total, 55);
  const g = simulateGraph(plans, edges, { minutes, merge: 5 });
  assert.deepEqual(Object.fromEntries(g.start), { '32-01': 0, '32-02': 0, '32-03': 10, '32-04': 20 });
  assert.equal(g.total, 35, '32-01 ends at 30 and merges until 35; the chain merged at 30');
  // one executor: the longest remaining path (32-01, 35) first, then the chain; merges overlap the next plan
  const one = simulateGraph(plans, edges, { minutes, merge: 5, maxExecutors: 1 });
  assert.deepEqual(Object.fromEntries(one.start), { '32-01': 0, '32-02': 30, '32-03': 40, '32-04': 50 });
  assert.equal(one.total, 60);
  // merges queue: two plans finishing together merge one after the other
  const two = simulateGraph([info({ id: '32-01' }), info({ id: '32-02' })], [], { minutes: mins({ '32-01': 10, '32-02': 10 }), merge: 3 });
  assert.deepEqual(Object.fromEntries(two.merged), { '32-01': 13, '32-02': 16 });
  assert.equal(simulateGraph(plans, edges, { minutes, merge: 0 }).total, 30);
});

test('a near-linear chain gains nothing when a merge costs a wave tail; a wide uneven phase gains', () => {
  const chain = ['32-01', '32-02', '32-03', '32-04'].map((id, i, a) => info({ id, deps: i ? [a[i - 1]] : [] }));
  const m = mins({ '32-01': 10, '32-02': 20, '32-03': 15, '32-04': 5 });
  assert.equal(simulateGraph(chain, planEdges(chain), { minutes: m, merge: 4 }).total, simulateWaves(chain, { minutes: m, tail: 4 }).total);
  const wide = [
    info({ id: '33-01' }), info({ id: '33-02' }), info({ id: '33-03' }),
    info({ id: '33-04', deps: ['33-02'] }), info({ id: '33-05', deps: ['33-03'] }), info({ id: '33-06', deps: ['33-01'] }),
  ];
  const w = mins({ '33-01': 25, '33-02': 5, '33-03': 6, '33-04': 20, '33-05': 22, '33-06': 4 });
  const waves = simulateWaves(wide, { minutes: w, tail: 4 }).total;
  const graph = simulateGraph(wide, planEdges(wide), { minutes: w, merge: 4 }).total;
  assert.equal(waves, 25 + 4 + 22 + 4);
  assert.ok(graph < waves - 10, `graph ${graph} vs waves ${waves}`);
});

test('criticalPath and edgeCosts name the chain that decides and the edge that costs most', () => {
  const plans = [
    info({ id: '32-01', files: ['src/a.ts'] }),
    info({ id: '32-02', files: ['src/a.ts'] }), // a files edge 32-01 -> 32-02
    info({ id: '32-03', deps: ['32-02'] }),
    info({ id: '32-04' }),
  ];
  const minutes = mins({ '32-01': 10, '32-02': 10, '32-03': 10, '32-04': 5 });
  const edges = planEdges(plans);
  const cp = criticalPath(plans, edges, { minutes, merge: 1 });
  assert.deepEqual(cp, { ids: ['32-01', '32-02', '32-03'], minutes: 33 });
  const costs = edgeCosts(plans, edges, { minutes, merge: 1 });
  // without 32-02 -> 32-03, 32-03 runs at once (the chain ends at 22); without the files edge 32-01 and 32-02 run
  // together and merge one after the other (23)
  assert.deepEqual(costs.map((e) => [e.from, e.to, e.kind, e.saves]), [['32-02', '32-03', 'depends', 11], ['32-01', '32-02', 'files', 10]]);
  assert.equal(simulateGraph(plans, edges, { minutes, merge: 1 }).total, 33);
});
