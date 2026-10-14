import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { STEPS, readProgress, nextStep, completeStep, resetProgress, activePhase, countAttempt, clearAttempts } from '../lib/phase-progress.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';

const project = () => { const root = tmpDir('pp'); fs.mkdirSync(path.join(root, '.planning')); return root; };

test('steps complete in order; out-of-order and unknown steps throw', () => {
  const root = project();
  assert.equal(nextStep(readProgress(root, '3')), 'freshness');
  completeStep(root, '3', 'freshness');
  assert.throws(() => completeStep(root, '3', 'plan'), /out of order \(next is discuss\)/);
  assert.throws(() => completeStep(root, '3', 'nope'), /unknown step/);
  for (const s of STEPS.slice(1)) completeStep(root, '3', s, { note: s === 'execute' ? 'waves 1-2' : '' });
  const p = readProgress(root, '3');
  assert.equal(nextStep(p), null);
  assert.equal(p.notes.execute, 'waves 1-2');
  resetProgress(root, '3');
  assert.equal(nextStep(readProgress(root, '3')), 'freshness');
});

test('a corrupt progress file reads in canonical order without unknown steps', () => {
  const root = project();
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'run', 'phase-p3.json'), JSON.stringify({ done: ['plan', 'bogus', 'freshness'] }));
  assert.deepEqual(readProgress(root, '3').done, ['freshness', 'plan']);
  assert.equal(nextStep(readProgress(root, '3')), 'discuss');
});

test('activePhase prefers the supervisor lane, then the newest unfinished run', () => {
  const root = project();
  assert.equal(activePhase(root), null);
  completeStep(root, '2', 'freshness', { now: new Date('2026-01-01T00:00:00Z') });
  completeStep(root, '4', 'freshness', { now: new Date('2026-01-02T00:00:00Z') });
  assert.equal(activePhase(root), '4');
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), { lane: { phase: '7' } });
  assert.equal(activePhase(root), '7');
});

test('phase-step CLI: next step, --done, --json, errors and usage', async () => {
  const root = project();
  const lines = [];
  const errs = [];
  const run = (...a) => runPhaseCommand('phase-step', a, { root, out: (l) => lines.push(l), err: (l) => errs.push(l) });
  assert.equal(await run('3'), 0);
  assert.match(lines.at(-1), /next freshness/);
  assert.equal(await run('3', '--done', 'freshness', '--json'), 0);
  assert.equal(JSON.parse(lines.at(-1)).next, 'discuss');
  assert.equal(await run('3', '--done', 'plan'), 1);
  assert.match(errs.at(-1), /out of order/);
  assert.equal(await run('../x'), 2);
  assert.equal(await runPhaseCommand('nope', [], { root, out: () => {}, err: (l) => errs.push(l) }), 2);
});

test('attempt counters: increment, persist across sessions and steps, reset, unknown step refused (I1)', async () => {
  const root = project();
  assert.equal(countAttempt(root, '3', 'fix'), 1);
  assert.equal(countAttempt(root, '3', 'fix'), 2);
  assert.equal(countAttempt(root, '3', 'execute'), 1);
  // completing a step keeps every counter; a fresh read (a resumed session) sees them
  completeStep(root, '3', 'freshness', { note: 'ok' });
  assert.deepEqual(readProgress(root, '3').attempts, { execute: 1, fix: 2 });
  assert.deepEqual(readProgress(root, '3').done, ['freshness']);
  assert.throws(() => countAttempt(root, '3', 'nope'), /unknown step: nope/);
  // a corrupt counter reads as absent, never as a budget left
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'run', 'phase-p4.json'), JSON.stringify({ done: [], attempts: { fix: 'x', uat: -1, execute: 2.5, bogus: 1, 'final-gate': 2 } }));
  assert.deepEqual(readProgress(root, '4').attempts, { 'final-gate': 2 });

  const lines = [];
  const errs = [];
  const run = (...a) => runPhaseCommand('phase-step', a, { root, out: (l) => lines.push(l), err: (l) => errs.push(l) });
  assert.equal(await run('3', '--attempt', 'fix'), 0);
  assert.equal(lines.at(-1), 'attempt fix 3');
  assert.equal(await run('3', '--json'), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)).attempts, { execute: 1, fix: 3 });
  assert.equal(await run('3', '--attempt', 'bogus'), 1);
  assert.match(errs.at(-1), /unknown step: bogus/);
  assert.equal(await run('3', '--attempt'), 2);
  assert.match(errs.at(-1), /--attempt <step>/);
  // --reset clears the progress and every counter with it
  assert.equal(await run('3', '--reset'), 0);
  assert.equal(await run('3', '--attempt', 'fix'), 0);
  assert.equal(lines.at(-1), 'attempt fix 1');
  // the owner's resume clears the counters only: the steps done stay done
  completeStep(root, '3', 'freshness');
  clearAttempts(root, '3');
  assert.deepEqual([readProgress(root, '3').attempts, readProgress(root, '3').done], [{}, ['freshness']]);
  clearAttempts(root, '9');
  assert.ok(!fs.existsSync(path.join(root, '.planning', 'turbo', 'run', 'phase-p9.json')), 'nothing to clear writes nothing');
});

test('bin/turbo-run.mjs routes phase-step to the stage-2 CLI', () => {
  const root = project();
  const out = execFileSync(process.execPath, [path.resolve('bin/turbo-run.mjs'), 'phase-step', '3', '--project', root], { encoding: 'utf8' });
  assert.match(out, /phase 3: next freshness/);
});

test('the ci attempt counter (push.ci_fix_rounds) counts like a step, is no step, and clears with the others (S2)', async () => {
  const root = project();
  assert.equal(countAttempt(root, '3', 'ci'), 1);
  assert.equal(countAttempt(root, '3', 'ci'), 2);
  assert.deepEqual(readProgress(root, '3').attempts, { ci: 2 });
  assert.throws(() => completeStep(root, '3', 'ci'), /unknown step: ci/);
  const lines = [];
  assert.equal(await runPhaseCommand('phase-step', ['3', '--attempt', 'ci'], { root, out: (l) => lines.push(l), err: () => {} }), 0);
  assert.equal(lines.at(-1), 'attempt ci 3');
  clearAttempts(root, '3');
  assert.deepEqual(readProgress(root, '3').attempts, {});
});

test('review 1 (MAJOR 2): phase-step N --done close refuses unless VERIFICATION.md reads passed and SECURITY.md (when there) has no open threat', async () => {
  const root = project();
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of STEPS.slice(0, STEPS.indexOf('close'))) completeStep(root, '3', s);
  const lines = [];
  const close = () => runPhaseCommand('phase-step', ['3', '--done', 'close'], { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  assert.equal(await close(), 1);
  assert.match(lines.at(-1), /^ERR turbo-run phase-step: phase 3 cannot close: no VERIFICATION\.md$/);
  fs.writeFileSync(path.join(dir, '03-VERIFICATION.md'), '---\nphase: 03-demo\nstatus: gaps_found\n---\n\nstatus: passed\n');
  assert.equal(await close(), 1);
  assert.match(lines.at(-1), /cannot close: VERIFICATION\.md status is gaps_found, not passed$/);
  fs.writeFileSync(path.join(dir, '03-VERIFICATION.md'), '---\r\nstatus: "passed"\r\n---\r\n');
  fs.writeFileSync(path.join(dir, '03-SECURITY.md'), '---\nthreats_open: 2\n---\n');
  assert.equal(await close(), 1);
  assert.match(lines.at(-1), /cannot close: SECURITY\.md has 2 open threat\(s\)$/);
  fs.writeFileSync(path.join(dir, '03-SECURITY.md'), '---\nthreats_open: x\n---\n');
  assert.equal(await close(), 1);
  assert.match(lines.at(-1), /cannot close: SECURITY\.md threats_open is not a count$/);
  fs.writeFileSync(path.join(dir, '03-SECURITY.md'), '---\nthreats_open: 0\n---\n');
  assert.equal(await close(), 0);
  assert.match(lines.at(-1), /next none/);
});

test('review 2: the close check reads YAML inline comments as GSD does: status: passed  # ok and threats_open: 0 # none open close; a # inside quotes stays', async () => {
  const root = project();
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of STEPS.slice(0, STEPS.indexOf('close'))) completeStep(root, '3', s);
  const lines = [];
  const close = () => runPhaseCommand('phase-step', ['3', '--done', 'close'], { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  fs.writeFileSync(path.join(dir, '03-VERIFICATION.md'), '---\nstatus: "passed # not a comment"\n---\n');
  fs.writeFileSync(path.join(dir, '03-SECURITY.md'), '---\nthreats_open: 0 # none open\n---\n');
  assert.equal(await close(), 1);
  assert.match(lines.at(-1), /status is passed # not a comment, not passed$/);
  fs.writeFileSync(path.join(dir, '03-VERIFICATION.md'), '---\nstatus: passed  # ok\n---\n');
  assert.equal(await close(), 0, lines.at(-1));
});

// GSD 1.16 chunked planning (plan-phase/steps/chunked-planning-mode.md): the outline <padded phase>-PLAN-OUTLINE.md lists
// every plan in a table and ends with ## OUTLINE COMPLETE; each plan is written and committed one by one, and has_plans
// is true from the first one on. A lane interrupted between two plans must resume planning, not execute a partial set.
const OUTLINE = [
  '# Phase 3: plan outline', '',
  '| Plan ID | Objective | Wave | Depends On | Requirements |',
  '|---------|-----------|------|-----------|-------------|',
  '| 03-01 | Parser | 1 | none | REQ-01 |',
  '| `03-02` | Store | 1 | none | REQ-02 |',
  '| 03-03 | Wire them | 2 | 03-01, 03-02 | REQ-03 |',
  '', '## OUTLINE COMPLETE', '',
].join('\n');
const planFile = (id) => `---\nphase: 03-demo\nplan: ${id.slice(3)}\nwave: 1\n---\n\n<objective>${id}</objective>\n`;

test('an interrupted chunked planning: while GSD\'s outline lists plans not written yet, --check plan says so and --done plan refuses; the whole set marks it done', async () => {
  const root = project();
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of STEPS.slice(0, STEPS.indexOf('plan'))) completeStep(root, '3', s);
  fs.writeFileSync(path.join(dir, '03-PLAN-OUTLINE.md'), OUTLINE);
  fs.writeFileSync(path.join(dir, '03-01-PLAN.md'), planFile('03-01'));
  const lines = [];
  const run = (...a) => runPhaseCommand('phase-step', ['3', ...a], { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });

  assert.equal(await run('--check', 'plan'), 0);
  assert.equal(lines.at(-1), 'phase 3: plan set incomplete: GSD\'s chunked plan outline 03-PLAN-OUTLINE.md lists 3 plans, 2 not written yet: 03-02, 03-03');
  assert.equal(await run('--done', 'plan'), 1);
  assert.match(lines.at(-1), /^ERR turbo-run phase-step: phase 3 cannot finish planning: GSD's chunked plan outline .* 2 not written yet: 03-02, 03-03$/);
  assert.equal(nextStep(readProgress(root, '3')), 'plan', 'the step stays open, so a resumed lane plans the rest');

  // a plan file without frontmatter is what GSD's own resume check plans again
  fs.writeFileSync(path.join(dir, '03-02-PLAN.md'), 'half written\n');
  assert.equal(await run('--check', 'plan'), 0);
  assert.match(lines.at(-1), /plan set incomplete: .*2 not written yet: 03-02, 03-03$/);

  fs.writeFileSync(path.join(dir, '03-02-PLAN.md'), planFile('03-02'));
  fs.writeFileSync(path.join(dir, '03-03-PLAN.md'), planFile('03-03').replace(/\n/g, '\r\n'));
  assert.equal(await run('--check', 'plan'), 0);
  assert.equal(lines.at(-1), 'phase 3: plan set complete: GSD\'s chunked plan outline 03-PLAN-OUTLINE.md lists 3 plans, all written');
  assert.equal(await run('--done', 'plan'), 0);
  assert.match(lines.at(-1), /next gates-off/);
});

test('an outline GSD stopped writing (no ## OUTLINE COMPLETE line) is an incomplete plan set; without an outline has_plans decides; --check takes plan only', async () => {
  const root = project();
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const run = (...a) => runPhaseCommand('phase-step', ['3', ...a], { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  fs.writeFileSync(path.join(dir, '03-PLAN-OUTLINE.md'), OUTLINE.replace('## OUTLINE COMPLETE', '').replace(/\n/g, '\r\n'));
  fs.writeFileSync(path.join(dir, '03-01-PLAN.md'), planFile('03-01'));
  assert.equal(await run('--check', 'plan'), 0);
  assert.equal(lines.at(-1), 'phase 3: plan set incomplete: GSD\'s chunked plan outline 03-PLAN-OUTLINE.md is unfinished (no ## OUTLINE COMPLETE line)');
  // CRLF and the marker GSD's resume check greps for
  fs.writeFileSync(path.join(dir, '03-PLAN-OUTLINE.md'), OUTLINE.replace(/\n/g, '\r\n'));
  assert.equal(await run('--check', 'plan'), 0);
  assert.match(lines.at(-1), /plan set incomplete: .*lists 3 plans, 2 not written yet: 03-02, 03-03$/);
  // a non-chunked run writes every plan at once and no outline
  fs.rmSync(path.join(dir, '03-PLAN-OUTLINE.md'));
  assert.equal(await run('--check', 'plan'), 0);
  assert.equal(lines.at(-1), 'phase 3: plan set complete: no chunked plan outline (gsd-tools has_plans decides)');
  assert.equal(await run('--check', 'close'), 2);
  assert.match(lines.at(-1), /^ERR usage: turbo-run phase-step <phase> .*--check plan/);
});

test('activePhase in slots mode: no lane works in the main checkout while lanes run; with none, the newest unfinished run (Stage 4 L1)', () => {
  const root = project();
  completeStep(root, '4', 'freshness', { now: new Date('2026-01-02T00:00:00Z') });
  const sup = path.join(root, '.planning', 'turbo', 'run', 'supervisor.json');
  writeJsonAtomic(sup, { lanesMode: 'slots', lanes: { 7: { key: '7', job: 'phase', phase: '7', slot: 1, slotPath: path.join(root, '..', 'elsewhere') } } });
  assert.equal(activePhase(root), null);
  writeJsonAtomic(sup, { lanesMode: 'slots', lanes: {} });
  assert.equal(activePhase(root), '4');
});
