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
