import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { prologueJobs, fanoutJobs, gateOutcome } from '../lib/phase-jobs.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { gatesRel } from '../lib/gates.mjs';

const step = (capId, ref = {}) => ({ kind: 'step', capId, ref });
const HOOKS = [step('research'), step('ui'), step('ai-integration'), step('pattern-mapper'), step('intel', { command: 'intel api-surface' }), { kind: 'contribution', capId: 'security' }];
const EMPTY = { plans: [], research: null, uiSpec: null, aiSpec: null };

test('prologueJobs: missing artifacts only, frontend-only UI, AI keywords, intel; nothing once plans exist', () => {
  const ids = (o) => prologueJobs({ phase: '3', hooks: HOOKS, artifacts: EMPTY, ...o }).map((j) => j.id);
  assert.deepEqual(ids({ frontend: true, goal: 'Add an LLM summary' }), ['research', 'ui', 'ai', 'intel']);
  assert.deepEqual(ids({ frontend: false, goal: 'Billing report', artifacts: { ...EMPTY, research: '03-RESEARCH.md' } }), ['intel']);
  assert.deepEqual(ids({ frontend: true, goal: 'llm', artifacts: { ...EMPTY, plans: [{ id: '03-01' }] } }), []);
  assert.deepEqual(prologueJobs({ phase: '3', hooks: [], artifacts: EMPTY, frontend: true, goal: 'llm' }), []);
  const jobs = prologueJobs({ phase: '3', hooks: HOOKS, artifacts: EMPTY, frontend: true, goal: '' });
  assert.equal(jobs.find((j) => j.id === 'research').args, '--research-phase 3');
  assert.equal(jobs.find((j) => j.id === 'ui').args, '3 --auto');
  assert.deepEqual(jobs.find((j) => j.id === 'intel').gsdTools, ['intel', 'api-surface']);
});

test('fanoutJobs: only gates that were active; UI review needs a UI-SPEC; nyquist in its own worktree', () => {
  const all = ['nyquist', 'security', 'ui', 'code-review'];
  assert.deepEqual(fanoutJobs({ phase: '3', active: all, artifacts: { uiSpec: null } }).map((j) => j.id), ['security', 'code-review', 'nyquist']);
  const withUi = fanoutJobs({ phase: '3', active: all, artifacts: { uiSpec: '03-UI-SPEC.md' } });
  assert.deepEqual(withUi.map((j) => [j.id, j.isolation, j.blocking]), [['security', 'none', true], ['ui', 'none', false], ['code-review', 'none', false], ['nyquist', 'worktree', true]]);
  assert.deepEqual(fanoutJobs({ phase: '3', active: ['code-review'], artifacts: {} }).map((j) => j.skill), ['gsd-code-review']);
});

test('gateOutcome: findings → fix, open threats → fix, missing blocking artifact → retry, unreadable counts fail closed', () => {
  const jobs = fanoutJobs({ phase: '3', active: ['security', 'code-review', 'nyquist'], artifacts: {} });
  const clean = { security: { threats_open: '0' }, 'code-review': { status: 'clean' }, nyquist: { status: 'validated', nyquist_compliant: 'true' } };
  assert.equal(gateOutcome({ jobs, fm: clean }).next, 'final-gate');
  const review = gateOutcome({ jobs, fm: { ...clean, 'code-review': { status: 'issues_found', findings: { critical: '1', warning: '2', info: '5' } } } });
  assert.deepEqual([review.reviewFindings, review.next], [3, 'fix']);
  assert.equal(gateOutcome({ jobs, fm: { ...clean, 'code-review': { status: 'issues_found', findings: { critical: '0', warning: '0', info: '4' } } } }).next, 'final-gate', 'info-only findings are not fixed');
  assert.equal(gateOutcome({ jobs, fm: { ...clean, security: { threats_open: '2' } } }).securityOpen, 2);
  assert.equal(gateOutcome({ jobs, fm: { ...clean, security: { threats_open: 'x' } } }).securityOpen, 1);
  assert.equal(gateOutcome({ jobs, fm: { ...clean, 'code-review': { status: 'issues_found', findings: 'garbled' } } }).reviewFindings, 1);
  const missing = gateOutcome({ jobs, fm: { 'code-review': { status: 'clean' } } });
  assert.deepEqual([missing.blockingMissing, missing.next], [['security', 'nyquist'], 'retry']);
  const draft = gateOutcome({ jobs, fm: { ...clean, nyquist: { status: 'draft', nyquist_compliant: 'false' } } });
  assert.deepEqual([draft.missing, draft.next], [['nyquist'], 'retry'], 'the VALIDATION.md plan-phase seeds is not a finished gate');
  assert.deepEqual(gateOutcome({ jobs, fm: { security: { threats_open: '0' }, nyquist: { status: 'validated' } } }).missing, ['code-review']);
});

test('jobs CLI reads hooks, gate state and frontmatter through injected GSD queries', async () => {
  const root = tmpDir('jobs');
  const dir = path.join(root, '.planning', 'phases', '03-alpha');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '03-REVIEW.md'), '');
  const gsd = {
    hooks: () => HOOKS,
    frontend: () => false,
    goal: () => 'Plain backend work',
    frontmatter: (f) => (f.endsWith('03-REVIEW.md') ? { status: 'issues_found', findings: { critical: '0', warning: '1' } } : {}),
  };
  const lines = [];
  const run = (...a) => runPhaseCommand('jobs', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps: { gsd } });
  assert.equal(await run('3', 'prologue', '--json'), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)).map((j) => j.id), ['research', 'intel']);
  assert.equal(await run('3', 'fanout'), 1, 'gates off must have run for the phase');
  assert.match(lines.at(-1), /gates off 3/);
  writeJsonAtomic(path.join(root, gatesRel('3')), { active: ['code-review'] });
  assert.equal(await run('3', 'outcome', '--json'), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)).next, 'fix');
  fs.rmSync(path.join(root, gatesRel('3'))); // after gates restore only the active file is left
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'gates-active-p3.json'), { phase: '3', active: ['security'] });
  assert.equal(await run('3', 'fanout', '--json'), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)).map((j) => j.id), ['security']);
  assert.equal(await run('3', 'bogus'), 2);
});
