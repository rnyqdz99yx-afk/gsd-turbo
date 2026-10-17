import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { jsonl, projectDirFor } from './helpers/transcripts.mjs';
import { executed, executorTranscript, phaseRepo } from './helpers/whatif.mjs';
import { gitRunner } from '../lib/staleness.mjs';
import { fmtMin, formatWhatIf, parseMinutes, phasePlans, runExecWhatif, whatIf, WhatifRefused } from '../lib/exec-whatif.mjs';

// Phase 32 of a demo app, executed by GSD in two waves (git dates):
//   08:00 plans committed (the last commit before wave 1: an hour before, so its lead is estimated)
//   wave 1: 32-01 09:03 -> 09:20, 32-02 09:02 -> 09:05; 09:25 tracking commit (tail 5 min)
//   wave 2: 32-03 (needs 32-01) 09:27 -> 09:35, 32-04 (needs 32-02) 09:28 -> 09:36; 09:40 tracking commit
const PLANS = [
  { id: '32-01', files: ['src/a.ts'] },
  { id: '32-02', files: ['src/b.ts'] },
  { id: '32-03', wave: 2, deps: ['32-01'], files: ['src/c.ts'] },
  { id: '32-04', wave: 2, deps: ['02'], files: ['src/d.ts'] },
  { id: '32-05', wave: 3, deps: ['32-03'], files: ['src/e.ts'], gap: true },
];
function finished() {
  const repo = phaseRepo({ plans: PLANS });
  executed(repo, '32-02', '2026-10-01T09:02:00Z', '2026-10-01T09:05:00Z');
  repo.at('2026-10-01T09:03:00Z', 'feat(32-01): first task', ['src/a.ts']);
  repo.at('2026-10-01T09:20:00Z', 'docs(32-01): complete demo plan', ['.planning/phases/32-demo/32-01-SUMMARY.md']);
  repo.at('2026-10-01T09:25:00Z', 'docs(phase-32): update tracking after wave 1', ['.planning/STATE.md']);
  repo.at('2026-10-01T09:27:00Z', 'feat(32-03): work', ['src/c.ts']);
  repo.at('2026-10-01T09:28:00Z', 'feat(32-04): work', ['src/d.ts']);
  repo.at('2026-10-01T09:35:00Z', 'docs(32-03): complete demo plan', ['.planning/phases/32-demo/32-03-SUMMARY.md']);
  repo.at('2026-10-01T09:36:00Z', 'docs(32-04): complete demo plan', ['.planning/phases/32-demo/32-04-SUMMARY.md']);
  repo.at('2026-10-01T09:40:00Z', 'docs(phase-32): update tracking after wave 2', ['.planning/STATE.md']);
  return repo;
}
const deps = (root, home = tmpDir('home')) => ({ git: gitRunner(root), home, slotsBase: path.join(path.dirname(root), `${path.basename(root)}.turbo`) });

test('phasePlans: the plans of the phase, gap-closure plans left out, a missing phase refused', () => {
  const repo = finished();
  const r = phasePlans(repo.root, '32');
  assert.deepEqual(r.plans.map((p) => p.id), ['32-01', '32-02', '32-03', '32-04']);
  assert.deepEqual(r.left, ['32-05']);
  assert.equal(r.rel, '.planning/phases/32-demo');
  assert.throws(() => phasePlans(repo.root, '7'), WhatifRefused);
});

test('git timings: dispatch at the orchestration commit before the first commit; a lead too long becomes the median lead (~); tails measured', () => {
  const repo = finished();
  const r = whatIf(repo.root, '32', deps(repo.root), {});
  const byId = Object.fromEntries(r.plans.map((p) => [p.id, p]));
  // 32-03: dispatched at the 09:25 tracking commit, summary 09:35 -> 10; 32-04: 09:25 -> 09:36 -> 11
  assert.deepEqual([byId['32-03'].minutes, byId['32-03'].source], [10, 'git']);
  assert.deepEqual([byId['32-04'].minutes, byId['32-04'].source], [11, 'git']);
  // wave 1: the last orchestration commit is the 08:00 plan commit (lead > 20 min): the median good lead (2.5) instead
  assert.deepEqual([byId['32-01'].minutes, byId['32-01'].source], [19.5, 'git~']);
  assert.deepEqual([byId['32-02'].minutes, byId['32-02'].source], [5.5, 'git~']);
  assert.deepEqual(r.tail, { minutes: 5, from: 'git', list: [{ after: 1, minutes: 5 }] });
  assert.deepEqual(r.merge, { minutes: 5, from: 'tail' });
  assert.deepEqual(r.left, ['32-05']);
  assert.equal(r.observed.source, 'git');
  // waves: max(19.5, 5.5) + 5 + max(10, 11) + 5 = 40.5; graph: 32-02 and 32-04 run beside 32-01, the chain 32-01 -> 32-03
  // with a merge after each decides (19.5 + 5 + 10 + 5)
  assert.equal(r.waves.total, 40.5);
  assert.equal(r.graph.at(-1).total, 39.5, '32-01, its merge, 32-03, its merge: the chain decides');
  assert.deepEqual(r.critical.ids, ['32-01', '32-03']);
  assert.equal(r.best.k, 2);
  assert.deepEqual(r.graph.map((x) => x.k), [1, 2, 3, 4]);
});

test('transcripts win over git: the union of a plan\'s executor spans (an owner wait between two agents does not count); tails from dispatches', () => {
  const repo = finished();
  const home = tmpDir('home');
  const { root } = repo;
  // 32-01 stopped at a checkpoint: agent 1 09:01-09:11, the owner answered, a continuation agent 09:50-09:56
  executorTranscript(home, root, { agent: 'a01', description: 'Execute plan 01 of phase 32', times: ['2026-10-01T09:01:00Z', '2026-10-01T09:11:00Z'] });
  executorTranscript(home, root, { agent: 'a01b', description: 'Continue plan 32-01 from Task 2', times: ['2026-10-01T09:50:00Z', '2026-10-01T09:53:00Z', '2026-10-01T09:56:00Z'] });
  executorTranscript(home, root, { agent: 'a02', description: 'Execute plan 02 of phase 32', times: ['2026-10-01T09:01:00Z', '2026-10-01T09:05:00Z'] });
  executorTranscript(home, root, { agent: 'a03', description: 'Execute plan 03 of phase 32', times: ['2026-10-01T09:58:00Z', '2026-10-01T10:06:00Z'], cwd: path.join(root, '.claude', 'worktrees', 'agent-a03') });
  // not counted: a planner, an executor of another project with the same phase number, another phase's executor
  executorTranscript(home, root, { agent: 'p01', type: 'gsd-planner', description: 'Execute plan 04 of phase 32', times: ['2026-10-01T07:00:00Z', '2026-10-01T09:00:00Z'] });
  executorTranscript(home, root, { agent: 'x04', description: 'Execute plan 04 of phase 32', times: ['2026-10-01T07:00:00Z', '2026-10-01T09:00:00Z'], cwd: path.join(path.dirname(root), 'other-app') });
  executorTranscript(home, root, { agent: 'y04', description: 'Execute plan 04 of phase 31', times: ['2026-10-01T07:00:00Z', '2026-10-01T09:00:00Z'] });
  const r = whatIf(root, '32', deps(root, home), {});
  const byId = Object.fromEntries(r.plans.map((p) => [p.id, p]));
  assert.deepEqual([byId['32-01'].minutes, byId['32-01'].source, byId['32-01'].agents], [16, 'transcripts', 2]);
  assert.deepEqual([byId['32-02'].minutes, byId['32-02'].source], [4, 'transcripts']);
  assert.deepEqual([byId['32-03'].minutes, byId['32-03'].source], [8, 'transcripts']);
  assert.deepEqual([byId['32-04'].minutes, byId['32-04'].source], [11, 'git'], 'no executor transcript of this project: git');
  // boundary 1 -> 2: 32-03 dispatched 09:58, wave 1 last returned 09:56
  assert.deepEqual(r.tail, { minutes: 2, from: 'transcripts', list: [{ after: 1, minutes: 2 }] });
  assert.equal(r.observed.source, 'git', 'transcripts cover fewer plans than git: the measured span comes from git');
  executorTranscript(home, root, { agent: 'a04', description: 'Execute plan 04 of phase 32', times: ['2026-10-01T09:58:00Z', '2026-10-01T10:08:00Z'] });
  const all = whatIf(root, '32', deps(root, home), {});
  assert.deepEqual([all.observed.source, all.observed.from, all.observed.to, all.observed.minutes], ['transcripts', '2026-10-01T09:01:00Z', '2026-10-01T10:08:00Z', 67]);
  // --no-transcripts: git only
  assert.equal(whatIf(root, '32', deps(root, home), { transcripts: false }).plans[0].source, 'git~');
});

test('an executor transcript whose last line is longer than the tail window (a large tool result) still counts', () => {
  const repo = finished();
  const home = tmpDir('home');
  const { root } = repo;
  executorTranscript(home, root, { agent: 'big02', description: 'Execute plan 02 of phase 32', times: ['2026-10-01T09:01:00Z'] });
  const file = path.join(projectDirFor(home, root), '11111111-2222-4333-8444-555555555555', 'subagents', 'agent-big02.jsonl');
  fs.appendFileSync(file, jsonl([{ type: 'user', isSidechain: true, agentId: 'big02', timestamp: '2026-10-01T09:07:00Z', cwd: root, message: { role: 'user', content: 'x'.repeat(200 * 1024) } }]));
  const p = whatIf(root, '32', deps(root, home), {}).plans.find((x) => x.id === '32-02');
  assert.deepEqual([p.minutes, p.source], [6, 'transcripts']);
});

test('options: --minutes wins, --tail-minutes and --merge-minutes are taken, depends-only edges, the executors table stops at the plan count', () => {
  const repo = finished();
  const r = whatIf(repo.root, '32', deps(repo.root), { minutes: parseMinutes('32-1=30,32-04=2'), tail: 3, merge: 1, kinds: ['depends'], maxExecutors: 20 });
  const byId = Object.fromEntries(r.plans.map((p) => [p.id, p]));
  assert.deepEqual([byId['32-01'].minutes, byId['32-01'].source, byId['32-04'].minutes], [30, 'option', 2]);
  assert.deepEqual([r.tail.minutes, r.tail.from, r.merge.minutes, r.merge.from], [3, 'option', 1, 'option']);
  assert.deepEqual(r.kinds, ['depends']);
  assert.equal(r.graph.length, 4);
  assert.throws(() => parseMinutes('32-01:5'), WhatifRefused);
});

test('formatWhatIf: the lines the owner reads', () => {
  const repo = finished();
  const lines = formatWhatIf(whatIf(repo.root, '32', deps(repo.root), {}));
  assert.equal(lines[0], 'phase 32: 4 plans · left out (gap closure): 32-05');
  assert.equal(lines[1], 'timings: git, start estimated 2 · git 2');
  assert.ok(lines.includes('GSD waves: 41m (2 waves by depends_on)'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('assumptions: wave tail 5m (median of 1 wave boundaries (git): 5m) · merge after each plan 5m (as a wave tail; --merge-minutes)')));
  assert.ok(lines.some((l) => l.startsWith('gain: 1m of 41m (2 %) at 2 executors · with a merge at half a wave tail: 37m')), lines.join('\n'));
  assert.ok(lines.includes('critical path 40m: 32-01 20m → 32-03 10m (+ 5m merge each)'), lines.join('\n'));
  assert.ok(lines.some((l) => /^ {2}32-01 · 1 · 20m · git, start estimated · 0m → 0m$/.test(l)), lines.join('\n'));
  assert.equal(fmtMin(95), '1h35m');
  assert.equal(fmtMin(7.4), '7m');
});

test('turbo-run exec-whatif is read-only: no file in the project changes, nothing is written', () => {
  const repo = finished();
  const before = execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: repo.root, encoding: 'utf8' });
  const out = [];
  const err = [];
  assert.equal(runExecWhatif(['32', '--json'], { root: repo.root, out: (l) => out.push(l), err: (l) => err.push(l), deps: deps(repo.root) }), 0);
  assert.equal(JSON.parse(out.join('\n')).phase, '32');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: repo.root, encoding: 'utf8' }), before);
  assert.equal(runExecWhatif(['9'], { root: repo.root, out: () => {}, err: (l) => err.push(l), deps: deps(repo.root) }), 1);
  assert.match(err.at(-1), /^refused: no single phase directory for phase 9/);
  assert.equal(runExecWhatif(['32', '--edges', 'files'], { root: repo.root, out: () => {}, err: (l) => err.push(l), deps: deps(repo.root) }), 1);
  assert.equal(runExecWhatif([], { root: repo.root, out: () => {}, err: (l) => err.push(l), deps: deps(repo.root) }), 2);
});
