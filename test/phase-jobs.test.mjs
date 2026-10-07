import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { AI_GOAL_RE, prologueJobs, fanoutJobs, gateOutcome } from '../lib/phase-jobs.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { gatesRel } from '../lib/gates.mjs';

const step = (capId, ref = {}) => ({ kind: 'step', capId, ref });
const HOOKS = [step('research'), step('ui'), step('ai-integration'), step('pattern-mapper'), step('intel', { command: 'intel api-surface' }), { kind: 'contribution', capId: 'security' }];
const EMPTY = { plans: [], research: null, uiSpec: null, aiSpec: null };
// The list `gates restore` leaves behind for the fan-out.
const activeFile = (root) => path.join(root, '.planning', 'turbo', 'run', 'gates-active-p3.json');

// Answers like GSD's `frontmatter get` for flat `key: value` blocks (string values), and with
// exit-0 {error, path} for an empty file (cmdFrontmatterGet).
function stubFrontmatter(calls = []) {
  return (file) => {
    calls.push(path.basename(file));
    const text = fs.readFileSync(file, 'utf8');
    if (!text) return { error: 'File not found', path: file };
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    return Object.fromEntries(block.split(/\r?\n/).map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map(([, k, v]) => [k, v]));
  };
}

test('AI_GOAL_RE: GSD keywords, plural forms too', () => {
  for (const goal of ['Add an LLM summary', 'Compare LLMs', 'Build agents', 'Store embeddings', 'Chatbots for support', 'llm evals']) assert.ok(AI_GOAL_RE.test(goal), goal);
  for (const goal of ['Billing report', 'Fix ragged table edges']) assert.ok(!AI_GOAL_RE.test(goal), goal);
});

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

// GSD's `frontmatter get` answers an empty file or broken YAML with exit 0 and {error, path} (cmdFrontmatterGet).
const gsdError = (file, error = 'File not found') => ({ error, path: `/p/.planning/phases/03-alpha/${file}` });

test('gateOutcome: an unreadable gate report (empty file, broken YAML, no review status) fails closed and names the file', () => {
  const jobs = fanoutJobs({ phase: '3', active: ['security', 'ui', 'code-review', 'nyquist'], artifacts: { uiSpec: '03-UI-SPEC.md' } });
  const clean = { security: { threats_open: '0' }, ui: {}, 'code-review': { status: 'clean' }, nyquist: { status: 'validated', nyquist_compliant: 'true' } };
  assert.deepEqual([gateOutcome({ jobs, fm: clean }).next, gateOutcome({ jobs, fm: clean }).unreadable], ['final-gate', []]);
  const review = gateOutcome({ jobs, fm: { ...clean, 'code-review': gsdError('03-REVIEW.md', 'Frontmatter is not parseable YAML') } });
  assert.deepEqual([review.reviewFindings, review.missing, review.next], [1, ['code-review'], 'fix']);
  assert.match(review.unreadable.join('\n'), /code-review: 03-REVIEW\.md .*not parseable YAML/);
  const noStatus = gateOutcome({ jobs, fm: { ...clean, 'code-review': {} } });
  assert.deepEqual([noStatus.reviewFindings, noStatus.next], [1, 'fix'], 'a REVIEW.md without a gsd-code-reviewer status is not clean');
  assert.equal(gateOutcome({ jobs, fm: { ...clean, 'code-review': { status: 'skipped' } } }).next, 'final-gate');
  const sec = gateOutcome({ jobs, fm: { ...clean, security: gsdError('03-SECURITY.md') } });
  assert.deepEqual([sec.securityOpen, sec.blockingMissing, sec.next], [1, ['security'], 'retry']);
  assert.match(sec.unreadable.join('\n'), /03-SECURITY\.md/);
  const ui = gateOutcome({ jobs, fm: { ...clean, ui: gsdError('03-UI-REVIEW.md') } });
  assert.deepEqual([ui.missing, ui.next], [['ui'], 'final-gate']);
  assert.match(ui.unreadable.join('\n'), /03-UI-REVIEW\.md/);
  const nyq = gateOutcome({ jobs, fm: { ...clean, nyquist: gsdError('03-VALIDATION.md') } });
  assert.deepEqual([nyq.blockingMissing, nyq.next], [['nyquist'], 'retry']);
  assert.match(nyq.unreadable.join('\n'), /03-VALIDATION\.md/);
});

test('jobs outcome: an empty REVIEW.md is not clean', async () => {
  const root = tmpDir('jobs-empty');
  const dir = path.join(root, '.planning', 'phases', '03-alpha');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '03-REVIEW.md'), '');
  const gsd = { hooks: () => [], frontend: () => false, goal: () => '', frontmatter: stubFrontmatter() };
  const lines = [];
  const run = (...a) => runPhaseCommand('jobs', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps: { gsd } });
  writeJsonAtomic(activeFile(root), { phase: '3', active: ['code-review'] });
  assert.equal(await run('3', 'outcome', '--json'), 0);
  const o = JSON.parse(lines.at(-1));
  assert.deepEqual([o.next, o.reviewFindings], ['fix', 1]);
  assert.match(o.unreadable[0], /03-REVIEW\.md/);
  assert.equal(await run('3', 'outcome'), 0);
  assert.match(lines.at(-1), /^next fix; review findings 1;.*; unreadable code-review: 03-REVIEW\.md is unreadable \(File not found\)$/);
});

test('gateOutcome: counts are strict integers; a bad or left-out tier counts one and is named', () => {
  const jobs = fanoutJobs({ phase: '3', active: ['security', 'code-review', 'nyquist'], artifacts: {} });
  const clean = { security: { threats_open: '0' }, 'code-review': { status: 'clean' }, nyquist: { status: 'validated', nyquist_compliant: 'true' } };
  const files = { security: '03-SECURITY.md', 'code-review': '03-REVIEW.md', nyquist: '03-VALIDATION.md' };
  const out = (patch) => gateOutcome({ jobs, fm: { ...clean, ...patch }, files });
  const issues = (findings) => out({ 'code-review': { status: 'issues_found', findings } });
  assert.deepEqual(out({}).unreadable, []);
  for (const findings of [{ critical: 'one', warning: '0' }, { critical: [], warning: '0' }, { critical: true, warning: '0' }, { critical: '1.5', warning: '0' }, { critical: '-1', warning: '0' }, { warning: '0' }]) {
    const o = issues(findings);
    assert.deepEqual([o.reviewFindings, o.next], [1, 'fix'], JSON.stringify(findings));
    assert.match(o.unreadable.join('\n'), /^code-review: 03-REVIEW\.md .*findings\.critical/m, JSON.stringify(findings));
  }
  assert.equal(issues({ critical: 'x', warning: 'y' }).reviewFindings, 2, 'each unreadable tier counts one');
  assert.equal(issues({ critical: 'x', warning: 'y' }).unreadable.length, 2);
  assert.equal(issues({ blocker: '2', warning: '1' }).reviewFindings, 3);
  assert.equal(issues({ critical: 2, warning: 0 }).reviewFindings, 2, 'numbers are counts too');
  const tiersOverStatus = out({ 'code-review': { status: 'clean', findings: { critical: '2', warning: '0' } } });
  assert.deepEqual([tiersOverStatus.reviewFindings, tiersOverStatus.next], [2, 'fix'], 'the tiers count whatever the status says');
  assert.equal(out({ 'code-review': { status: 'skipped', findings: { critical: '0', warning: '0', info: '0' } } }).next, 'final-gate');
  for (const threats of [[], true, '1.5', '-1', 'none']) {
    const o = out({ security: { threats_open: threats } });
    assert.deepEqual([o.securityOpen, o.next], [1, 'fix'], JSON.stringify(threats));
    assert.match(o.unreadable.join('\n'), /^security: 03-SECURITY\.md threats_open .* is not a count$/m);
  }
  assert.equal(out({ security: { threats_open: 3 } }).securityOpen, 3);
  assert.match(out({ security: {} }).unreadable.join('\n'), /^security: 03-SECURITY\.md threats_open is missing$/m);
  const nyq = out({ nyquist: { nyquist_compliant: 'true' } });
  assert.deepEqual([nyq.blockingMissing, nyq.next], [['nyquist'], 'retry']);
  assert.match(nyq.unreadable.join('\n'), /^nyquist: 03-VALIDATION\.md status is missing$/m);
  assert.deepEqual(out({ nyquist: { status: 'draft' } }).unreadable, [], 'a draft is missing, not unreadable');
});

test('gateOutcome: a YAML flow list or an empty value is never a gate status (M1)', () => {
  const jobs = fanoutJobs({ phase: '3', active: ['security', 'code-review', 'nyquist'], artifacts: {} });
  const clean = { security: { threats_open: '0' }, 'code-review': { status: 'clean' }, nyquist: { status: 'validated', nyquist_compliant: 'true' } };
  const files = { security: '03-SECURITY.md', 'code-review': '03-REVIEW.md', nyquist: '03-VALIDATION.md' };
  const out = (patch) => gateOutcome({ jobs, fm: { ...clean, ...patch }, files });
  // GSD's frontmatter get answers `status: [clean]` with ["clean"] and an empty `status:` with {}
  for (const status of [['clean'], ['issues_found'], ['skipped'], {}]) {
    const o = out({ 'code-review': { status, findings: { critical: '0', warning: '0' } } });
    assert.deepEqual([o.reviewFindings, o.next, o.missing], [1, 'fix', ['code-review']], JSON.stringify(status));
    assert.match(o.unreadable.join('\n'), /^code-review: 03-REVIEW\.md is unreadable \(status .+, not one of clean, issues_found, skipped\)$/m, JSON.stringify(status));
  }
  for (const [status, why] of [[['validated'], /^nyquist: 03-VALIDATION\.md status \["validated"\] is not a string$/m], [{}, /^nyquist: 03-VALIDATION\.md status is missing$/m]]) {
    const o = out({ nyquist: { status, nyquist_compliant: 'true' } });
    assert.deepEqual([o.missing, o.blockingMissing, o.next, o.nyquist.status], [['nyquist'], ['nyquist'], 'retry', ''], JSON.stringify(status));
    assert.match(o.unreadable.join('\n'), why);
  }
});

test('jobs outcome reads 03-SECURITY.md and a draft 03-VALIDATION.md through their own artifact keys', async () => {
  const root = tmpDir('jobs-files');
  const dir = path.join(root, '.planning', 'phases', '03-alpha');
  fs.mkdirSync(dir, { recursive: true });
  const write = (f, body) => fs.writeFileSync(path.join(dir, f), body);
  write('03-SECURITY.md', '---\nphase: 03-alpha\nthreats_open: 2\n---\n\n# Security\n');
  write('03-VALIDATION.md', '---\nphase: 03\nstatus: draft\nnyquist_compliant: false\n---\n\n# Validation\n');
  write('03-REVIEW.md', '---\nstatus: issues_found\n---\n'); // code-review was not an active gate: never read
  const calls = [];
  const gsd = { hooks: () => [], frontend: () => false, goal: () => '', frontmatter: stubFrontmatter(calls) };
  const lines = [];
  const run = (...a) => runPhaseCommand('jobs', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps: { gsd } });
  writeJsonAtomic(activeFile(root), { phase: '3', active: ['security', 'nyquist'] });
  assert.equal(await run('3', 'outcome', '--json'), 0);
  const o = JSON.parse(lines.at(-1));
  assert.deepEqual(calls, ['03-SECURITY.md', '03-VALIDATION.md']);
  assert.deepEqual([o.securityOpen, o.missing, o.blockingMissing, o.nyquist, o.unreadable, o.next], [2, ['nyquist'], ['nyquist'], { status: 'draft', compliant: false }, [], 'retry']);
  write('03-SECURITY.md', '---\nthreats_open: 0\n---\n');
  write('03-VALIDATION.md', '---\nstatus: validated\nnyquist_compliant: true\n---\n');
  assert.equal(await run('3', 'outcome'), 0);
  assert.equal(lines.at(-1), 'next final-gate; review findings 0; open threats 0; missing none');
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
  // while the gates are off, GSD's gate skills exit without doing anything (G16)
  assert.equal(await run('3', 'outcome', '--json'), 1, 'gates restore must have run before the fan-out');
  assert.match(lines.at(-1), /turbo-run gates restore 3/);
  assert.equal(await run('3', 'fanout'), 1);
  assert.match(lines.at(-1), /turbo-run gates restore 3/);
  fs.rmSync(path.join(root, gatesRel('3'))); // after gates restore only the active file is left
  writeJsonAtomic(activeFile(root), { phase: '3', active: ['code-review'] });
  assert.equal(await run('3', 'outcome', '--json'), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)).next, 'fix');
  writeJsonAtomic(activeFile(root), { phase: '3', active: ['security'] });
  assert.equal(await run('3', 'fanout', '--json'), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)).map((j) => j.id), ['security']);
  assert.equal(await run('3', 'bogus'), 2);
});
