import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { REAL_CORE, NO_REAL_GSD } from './helpers/real-gsd.mjs';
import { FIELDS, STEPS, compare, issuePlan, makeProject, normalize, pick, pickVersions, reportText, runSteps } from '../scripts/gsd-compat.mjs';

// scripts/gsd-compat.mjs: the nightly compatibility check's rule, without a GSD.
const rec = (name, over = {}) => ({ name, kind: STEPS.find((s) => s.name === name)?.kind ?? null, write: false, status: 0, stdout: '', stderr: '', tree: null, ...over });

test('the steps: every name once (the runs are paired by name), every kind a FIELDS entry', () => {
  const names = STEPS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(STEPS.every((s) => s.kind === null || s.kind in FIELDS));
  assert.deepEqual(STEPS.filter((s) => s.kind).map((s) => s.kind).filter((k, i, a) => a.indexOf(k) === i).sort(), Object.keys(FIELDS).sort(), 'every FIELDS entry has a step');
  assert.equal(STEPS.find((s) => s.name.startsWith('WRITE query phase.complete')).write, true);
  assert.deepEqual(STEPS.find((s) => s.name === 'init phase-op 2').args, ['init', 'phase-op', '2']);
});

test('pick follows a.b, list[].field and *', () => {
  const o = { a: { b: 1 }, list: [{ x: 1, r: { c: 'k' } }, { x: 2 }] };
  assert.deepEqual(pick(o, 'a.b'), [1]);
  assert.deepEqual(pick(o, 'list[].x'), [1, 2]);
  assert.deepEqual(pick(o, 'list[].r.c'), ['k', undefined]);
  assert.deepEqual(pick(o, 'nope[].x'), [undefined]);
  assert.equal(pick(o, '*'), o);
});

test('normalize hides what differs between two runs by itself: the run\'s directories, times, commit ids', () => {
  const dir = path.join(tmpDir('norm'), 'p');
  const text = `{"root":${JSON.stringify(dir)},"at":"2026-11-19T10:00:00.123Z","hash":"abc1234","state_head":"${'a'.repeat(40)}"}\r\nstate_head: abcdef1\nindex 1a2b3c4..5d6e7f8 100644\n`;
  assert.equal(normalize(text, { [dir]: '<root>' }), '{"root":"<root>","at":"<time>","hash":"<sha>","state_head":"<sha>"}\nstate_head: <sha>\nindex <blob> 100644\n');
});

test('compare: an exit, a tree or a field turbo reads that differs is a break; anything else is a note', () => {
  const manager = (extra = {}, phase = {}) => JSON.stringify({ milestone_version: 'v1', phases: [{ number: '1', name: 'A', dep_phases: [], deps_display: '', disk_status: 'planned', phase_complete: false, roadmap_complete: false, implementation_complete: false, verification_status: 'missing', is_active: true, ...phase }], ...extra });
  const base = [
    rec('init manager', { stdout: manager() }),
    rec('config-get context_window --raw', { stdout: '200000\n' }),
    rec('init plan-phase 2', { stdout: '{"prompt":"old words"}' }),
    rec('check ui-plan-gate 2', { stdout: '{"frontend":false}' }),
    rec('WRITE query phase.complete 1', { write: true, tree: '--- a/x\n+++ b/x\n-| R-1 | Pending |\n+| R-1 | Complete |\n' }),
    rec('WRITE state add-decision --phase 1 --summary compat decision line', { write: true, tree: '--- a/x\n+++ b/x\n-| R-1 | Pending |\n+| R-1 | Complete |\n+decision\n' }),
  ];
  const same = compare(base, base);
  assert.deepEqual(same, { breaks: [], notes: [] });
  // a field GSD added, a reworded answer nobody parses: notes
  const additive = base.map((r) => ({ ...r }));
  additive[0].stdout = manager({ new_top: 1 }, { executor_runtime: null });
  additive[2].stdout = '{"prompt":"new words"}';
  assert.deepEqual(compare(base, additive), { breaks: [], notes: [{ step: 'init manager', what: 'added: new_top, phases[].executor_runtime' }, { step: 'init plan-phase 2', what: 'values differ in fields turbo does not read' }] });
  // what turbo reads
  const broken = base.map((r) => ({ ...r }));
  broken[0].stdout = manager({}, { disk_status: 'ready' });
  broken[1].stdout = '"200000"\n';
  broken[3] = { ...broken[3], status: 1, stderr: 'Error: unknown gate\nusage' };
  const b = compare(base, broken);
  assert.deepEqual(b.breaks, [
    { step: 'init manager', why: 'phases[].disk_status (read by turbo): ["planned"] → ["ready"]' },
    { step: 'config-get context_window --raw', why: 'turbo reads this answer as text and it differs: 200000 → "200000"' },
    { step: 'check ui-plan-gate 2', why: 'exit 0 on the tested GSD, exit 1 on the GSD under test: Error: unknown gate' },
  ]);
  // a write that leaves another tree: said at the step that made it, not again at every later write
  const wrote = base.map((r) => ({ ...r }));
  wrote[4].tree = `${base[4].tree}-| R-2 | Pending (note) |\n+| R-2 | Complete |\n`;
  wrote[5].tree = `${base[5].tree}-| R-2 | Pending (note) |\n+| R-2 | Complete |\n`;
  const w = compare(base, wrote);
  assert.deepEqual(w.breaks, [{ step: 'WRITE query phase.complete 1', why: 'the write leaves a different .planning tree; tested GSD only: nothing; GSD under test only: -| R-2 | Pending (note) | ⏎ +| R-2 | Complete |' }]);
  // a step the GSD under test did not run
  assert.deepEqual(compare(base, base.slice(1)).breaks, [{ step: 'init manager', why: 'the step did not run on the GSD under test' }]);
  const text = reportText({ baseVersion: '1.22.0', headVersion: '1.23.0', result: w, steps: 51 });
  assert.match(text, /^## GSD 1\.23\.0 against gsd-turbo \(compared with GSD 1\.22\.0\)\n\n51 gsd-tools calls/);
  assert.match(text, /\*\*1 break\(s\):\*\*\n\n- `WRITE query phase\.complete 1`: the write leaves/);
  assert.match(reportText({ baseVersion: 'a', headVersion: 'b', result: same, steps: 51 }), /\*\*No break:\*\*/);
});

test('pickVersions: the newest GSD of the tested range is the base; issuePlan: one issue per version and verdict', () => {
  const all = ['1.15.9', '1.16.0', '1.21.0', '1.22.0', '1.22.1', '1.23.0', '1.23.0-rc.1', '2.0.0'];
  assert.deepEqual(pickVersions(all, '1.23.0'), { base: '1.22.1', head: '1.23.0', cls: 'newer' });
  assert.deepEqual(pickVersions(all, '1.22.1'), { base: '1.22.1', head: '1.22.1', cls: 'tested' });
  assert.deepEqual(pickVersions(['2.0.0'], '2.0.0'), { base: null, head: '2.0.0', cls: 'other' });
  const fail = 'GSD 1.23.0: the compatibility check fails';
  const pass = 'GSD 1.23.0 passes the compatibility check: the tested range can take it';
  assert.deepEqual(issuePlan({ verdict: 'fail', version: '1.23.0', cls: 'newer', open: [] }), { action: 'create', title: fail });
  assert.deepEqual(issuePlan({ verdict: 'fail', version: '1.23.0', cls: 'newer', open: [fail] }), { action: 'comment', title: fail });
  assert.deepEqual(issuePlan({ verdict: 'fail', version: '1.22.0', cls: 'tested', open: [] }).action, 'create', 'a tested version that fails is said too');
  assert.deepEqual(issuePlan({ verdict: 'pass', version: '1.23.0', cls: 'newer', open: [] }), { action: 'create', title: pass });
  assert.deepEqual(issuePlan({ verdict: 'pass', version: '1.23.0', cls: 'newer', open: [pass] }), { action: 'none', title: null });
  assert.deepEqual(issuePlan({ verdict: 'pass', version: '1.22.0', cls: 'tested', open: [] }), { action: 'none', title: null });
});

// The synthetic project is one the installed GSD accepts: every call of the list exits 0 on it. On the nightly
// (TURBO_GSD_UNTESTED=1, the newest GSD) a refusal here says the new GSD no longer takes what turbo writes.
test('every step exits 0 on the synthetic project with the installed GSD', { skip: NO_REAL_GSD, timeout: 300000 }, () => {
  const dir = makeProject(path.join(tmpDir('gsd-compat'), 'p'));
  const run = runSteps(path.join(REAL_CORE, 'bin', 'gsd-tools.cjs'), dir);
  assert.deepEqual(run.filter((r) => r.status !== 0).map((r) => `${r.name}: exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`), []);
  assert.match(run.find((r) => r.name === 'git log').tree, /^docs\(phase-1\): complete phase$/m);
  // GSD's own untracked files aside, the last commit took what the phase close wrote
  assert.deepEqual(run.find((r) => r.name === 'git status').tree.split('\n').filter((l) => l && !l.startsWith('??')), []);
});
