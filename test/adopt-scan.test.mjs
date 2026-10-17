import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { ADOPT_REL, currentPhase, formatOverview, phaseList, phaseStates, scanProject } from '../lib/adopt.mjs';

// The journal's milestone (spec §4.2): 24 and 31 checked off with a stale or missing verification, 32 built but not
// checked off, 33 half built, 34 planned (chunked, one plan of two written), 35 discussed, 36 empty, 37 done.
const row = (number, o) => ({ number, name: `Demo ${number}`, deps_display: '—', phase_complete: false, roadmap_complete: false, implementation_complete: false, plan_count: 0, summary_count: 0, has_context: false, is_active: false, verification_status: null, ...o });
export const MANAGER = {
  milestone_version: 'v2',
  phases: [
    row('24', { disk_status: 'executed', verification_status: 'stale', roadmap_complete: true, implementation_complete: true, plan_count: 3, summary_count: 3 }),
    row('31', { disk_status: 'executed', verification_status: 'missing', roadmap_complete: true, implementation_complete: true, plan_count: 2, summary_count: 2 }),
    row('32', { disk_status: 'executed', verification_status: 'human_needed', implementation_complete: true, plan_count: 2, summary_count: 2 }),
    row('33', { disk_status: 'partial', plan_count: 10, summary_count: 9, has_context: true }),
    row('34', { disk_status: 'planned', plan_count: 1, has_context: true, is_active: true }),
    row('35', { disk_status: 'discussed', has_context: true }),
    row('36', { disk_status: 'empty' }),
    row('37', { disk_status: 'complete', phase_complete: true, verification_status: 'passed', roadmap_complete: true, implementation_complete: true, plan_count: 1, summary_count: 1 }),
  ],
};

const git = (root) => (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function write(root, rel, text) {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

// A git project with a ROADMAP, phase 34's chunked outline (34-02 not written) and GSD's state contract naming 33.
function project() {
  const root = tmpGitRepo();
  write(root, '.planning/ROADMAP.md', '# Roadmap\n');
  write(root, '.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  write(root, '.planning/turbo/config.json', JSON.stringify({ lanes: { mode: 'checkout' } }));
  write(root, '.planning/state.json', JSON.stringify({ contract: '1.0.0', phases: [{ number: '32', name: 'x', status: 'pending' }, { number: '33', name: 'y', status: 'in_progress' }] }));
  write(root, '.planning/phases/34-demo/34-PLAN-OUTLINE.md', '| Plan ID | Objective | Wave |\n|---|---|---|\n| 34-01 | a | 1 |\n| 34-02 | b | 2 |\n\n## OUTLINE COMPLETE\n');
  write(root, '.planning/phases/34-demo/34-01-PLAN.md', '---\nwave: 1\n---\n');
  git(root)(['add', '-A']);
  git(root)(['commit', '-q', '-m', 'project']);
  return root;
}
const deps = (root, o = {}) => ({
  gsd: (args) => {
    if (args[0] === 'init') return o.manager ?? MANAGER;
    throw new Error('not faked');
  },
  gsdGet: (key) => o.config?.[key] ?? '__turbo_absent__',
  git: git(root),
  supervisor: () => ({ alive: false, pid: null, lanes: [], attended: [], why: null, ...o.sup }),
  doctorMode: () => o.mode ?? 'full',
});

test('phase states follow spec §4.2, first match wins; a half-written chunked plan set stays planned and is named', () => {
  const root = project();
  const r = scanProject(root, { deps: deps(root) });
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.overview.phases.map((p) => [p.number, p.state]), [
    ['24', 'closed-stale'], ['31', 'closed-stale'], ['32', 'verifying'], ['33', 'executing'], ['34', 'planned'], ['35', 'prepped'], ['36', 'fresh'], ['37', 'done'],
  ]);
  assert.deepEqual(r.overview.staleClosed, ['24', '31']);
  assert.equal(r.overview.phases.find((p) => p.number === '34').planSet, 'incomplete');
  // GSD's current phase comes from its state contract, never from init manager's is_active (a recent file change)
  assert.deepEqual(r.overview.phases.filter((p) => p.active).map((p) => p.number), ['33']);
  assert.equal(r.overview.markup, 'off');
  assert.equal(r.overview.branch, 'main');
  assert.deepEqual(r.overview.owner.humanNeeded, [{ phase: '32', items: ['verification'] }]);
  assert.equal(r.phases.find((p) => p.number === '24').closed, true);
  assert.equal(r.overview.adopted, null);
});

test('the current phase: the state contract, else gsd-tools state json, else none', () => {
  const root = tmpGitRepo();
  assert.equal(currentPhase(root, () => ({ current_phase: '07 of 9 (Api)' })), '7');
  assert.equal(currentPhase(root, () => { throw new Error('no STATE.md'); }), null);
  write(root, '.planning/state.json', JSON.stringify({ phases: [{ number: '3', status: 'complete' }, { number: '4.1', status: 'in_progress' }] }));
  assert.equal(currentPhase(root, () => ({ current_phase: '9' })), '4.1');
});

test('every refusal is listed at once, one line each', () => {
  const root = project();
  fs.rmSync(path.join(root, '.planning', 'ROADMAP.md'));
  fs.writeFileSync(path.join(root, '.git', 'MERGE_HEAD'), 'x\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'mine\n');
  const r = scanProject(root, { deps: deps(root, { mode: 'unsupported', sup: { alive: true, pid: 42, lanes: ['33'], attended: ['35'] } }) });
  const expect = [/^no \.planning\/ROADMAP\.md/, /doctor says unsupported/, /supervisor is running \(pid 42\)/, /lane of phase 33 still works/, /phase 35 is attended/, /git merge is in progress/, /uncommitted changes: .*\.planning\/ROADMAP\.md, notes\.txt/];
  assert.equal(r.refused.length, expect.length, r.refused.join('\n'));
  expect.forEach((re, i) => assert.match(r.refused[i], re));
  assert.equal(r.overview, null);
});

test('a dirty tree is accepted only inside an adopt that stopped before its commit, or turbo run files', () => {
  const root = project();
  write(root, '.planning/config.json', '{"x":1}\n');
  write(root, '.planning/turbo/run/whatever.json', '{}');
  assert.match(scanProject(root, { deps: deps(root) }).refused.join('\n'), /uncommitted changes: \.planning\/config\.json:/);
  write(root, ADOPT_REL, JSON.stringify({ v: 1, state: 'applying', paths: ['.planning/config.json', ADOPT_REL] }));
  const r = scanProject(root, { deps: deps(root) });
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.dirty.sort(), ['.planning/config.json', ADOPT_REL].sort());
  // an applied record whose own file is committed covers nothing
  write(root, ADOPT_REL, JSON.stringify({ v: 1, state: 'applied', at: '2026-10-14T00:00:00.000Z', paths: ['.planning/config.json', ADOPT_REL] }));
  git(root)(['add', '--', ADOPT_REL]);
  git(root)(['commit', '-q', '-m', 'adopt']);
  assert.match(scanProject(root, { deps: deps(root) }).refused.join('\n'), /uncommitted changes: \.planning\/config\.json:/);
  // review 1: an applied record that is not committed itself (the commit failed) is an interrupted adopt
  write(root, ADOPT_REL, JSON.stringify({ v: 1, state: 'applied', at: '2026-10-14T00:00:01.000Z', paths: ['.planning/config.json', ADOPT_REL] }));
  assert.deepEqual(scanProject(root, { deps: deps(root) }).refused, []);
});

test('GSD branching per phase or milestone: refused while HEAD is on another branch than the default one', () => {
  const root = project();
  const cfg = { config: { 'git.branching_strategy': 'phase' } };
  assert.deepEqual(scanProject(root, { deps: deps(root, cfg) }).refused, []);
  git(root)(['switch', '-q', '-c', 'gsd/phase-33-demo']);
  // only main suggests the default branch: a guess warns, never refuses
  let r = scanProject(root, { deps: deps(root, cfg) });
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.overview.warnings, ["HEAD is on GSD's branch gsd/phase-33-demo; merge it into main and switch back (git switch main), if main is this project's default branch"]);
  assert.ok(formatOverview(r.overview, 'en').includes(`warn: ${r.overview.warnings[0]}`));
  // git's init.defaultBranch, or GSD's git.base_branch, makes it sure: refused
  git(root)(['config', 'init.defaultBranch', 'main']);
  assert.deepEqual(scanProject(root, { deps: deps(root, cfg) }).refused, ["HEAD is on GSD's branch gsd/phase-33-demo; merge it into main and switch back (git switch main)"]);
  git(root)(['config', '--unset', 'init.defaultBranch']);
  r = scanProject(root, { deps: deps(root, { config: { 'git.branching_strategy': 'milestone', 'git.base_branch': 'main' } }) });
  assert.equal(r.refused.length, 1);
  assert.deepEqual(scanProject(root, { deps: deps(root, { config: { 'git.branching_strategy': 'none' } }) }).refused, []);
});

test('review 4: GSD cannot list the phases while a new report it cannot read is in the tree: scan names adopt reverify', () => {
  const root = project();
  write(root, '.planning/phases/24-old/24-VERIFICATION.md', '---\nstatus: weird\n---\n');
  const r = scanProject(root, { deps: { ...deps(root), gsd: () => { throw new Error('verification status weird is not one of passed, gaps_found, human_needed'); } } });
  assert.match(r.refused.join('\n'), /GSD cannot list the phases \(verification status weird .*\): a re-check report it cannot read may be the cause: run turbo-run adopt reverify 24$/);
});

test('nothing to adopt when every phase is done; the overview in Russian names the closed phases without file names', () => {
  const root = project();
  const done = { milestone_version: 'v1', phases: [row('1', { disk_status: 'complete', phase_complete: true })] };
  const r = scanProject(root, { deps: deps(root, { manager: done }) });
  assert.match(formatOverview(r.overview, 'en').join('\n'), /^nothing to adopt: every phase is done$/m);
  const ru = formatOverview(scanProject(root, { deps: deps(root) }).overview, 'ru');
  assert.ok(ru.includes('  закрыты, проверка устарела: 24, 31'), ru.join('\n'));
  assert.ok(ru.includes('  спланированы: 34 (планирование не закончено: 34)'), ru.join('\n'));
  assert.ok(ru.includes('сейчас идёт фаза 33'), ru.join('\n'));
  assert.ok(ru.includes('markup: off'));
  for (const l of ru) assert.doesNotMatch(l, /\.md\b|\.planning/, l);
});

test('phaseList writes runs of three or more as ranges', () => {
  assert.equal(phaseList(['31', '24', '25', '26', '27']), '24–27, 31');
  assert.equal(phaseList(['24', '25']), '24, 25');
  assert.equal(phaseList(['2', '2.1', '3']), '2, 2.1, 3');
});

test('phaseStates: a re-verified phase counts as closed-stale until apply commits', () => {
  const m = { phases: [row('24', { disk_status: 'complete', phase_complete: true, roadmap_complete: true, implementation_complete: true, plan_count: 1, summary_count: 1 })] };
  assert.equal(phaseStates(m, {})[0].row.state, 'done');
  assert.equal(phaseStates(m, { reverified: { 24: { status: 'passed' } } })[0].row.state, 'closed-stale');
});
