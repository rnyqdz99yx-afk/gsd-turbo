import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { LEAN_WINDOW_HOURS, leanDeferral, phaseLean, pinLean } from '../lib/phase-progress.mjs';

// Stage 6 L2 (D10): lean is decided per phase; a phase whose execution began before lean finishes without it.
const runFile = (root, name) => path.join(root, '.planning', 'turbo', 'run', name);
const setLean = (root, enabled) => writeJsonAtomic(path.join(root, '.planning', 'turbo', 'config.json'), { lean: { enabled } });
const progress = (root, done, extra = {}) => writeJsonAtomic(runFile(root, 'phase-p3.json'), { phase: '3', done, updatedAt: new Date().toISOString(), ...extra });
function project(prefix) {
  const root = tmpDir(prefix);
  fs.mkdirSync(path.join(root, '.planning', 'phases', '03-alpha'), { recursive: true });
  return root;
}
const cli = (root) => {
  const lines = [];
  const errs = [];
  const run = (...a) => runPhaseCommand('phase-step', a, { root, out: (l) => lines.push(...String(l).split('\n')), err: (l) => errs.push(l) });
  return { run, lines, errs };
};

test('phaseLean: the pin decides; no pin after gates-off means the phase began before lean (D10); otherwise lean.enabled', async () => {
  const root = project('lean-phase');
  assert.equal(phaseLean(root, '3'), true, 'lean on by default, no progress');
  setLean(root, false);
  assert.equal(phaseLean(root, '3'), false);
  setLean(root, true);
  progress(root, ['freshness', 'discuss', 'prologue', 'plan', 'gates-off']);
  assert.equal(phaseLean(root, '3'), false, 'gates-off done without a pin');
  fs.rmSync(runFile(root, 'phase-p3.json'));
  fs.writeFileSync(path.join(root, '.planning', 'phases', '03-alpha', '03-01-SUMMARY.md'), '# s\n');
  assert.equal(phaseLean(root, '3'), false, 'a plan SUMMARY: execution began');
  setLean(root, false);
  pinLean(root, '3', true);
  assert.equal(phaseLean(root, '3'), true, 'the pin wins over the config and the SUMMARY');
  assert.equal(phaseLean(root, '3', { lean: { enabled: false } }), true, 'and over a config passed in');
  const { run } = cli(root);
  assert.equal(await run('3', '--reset'), 0);
  assert.ok(!fs.existsSync(runFile(root, 'lean-p3.json')), '--reset removes the pin');
});

test('phase-step prints lean: on before its next line and pins lean at --done gates-off', async () => {
  const root = project('lean-step');
  const { run, lines } = cli(root);
  assert.equal(await run('3'), 0);
  assert.equal(lines[0], 'lean: on');
  assert.match(lines.at(-1), /^phase 3: next freshness/);
  assert.equal(lines.length, 2);
  lines.length = 0;
  setLean(root, false);
  assert.equal(await run('3'), 0);
  assert.deepEqual(lines, ['phase 3: next freshness']);
  setLean(root, true);
  progress(root, ['freshness', 'discuss', 'prologue', 'plan']);
  lines.length = 0;
  assert.equal(await run('3', '--done', 'gates-off'), 0);
  assert.equal(lines[0], 'lean: on');
  assert.match(lines.at(-1), /^phase 3: next execute/);
  const pin = JSON.parse(fs.readFileSync(runFile(root, 'lean-p3.json'), 'utf8'));
  assert.equal(pin.lean, true);
  assert.ok(Number.isFinite(Date.parse(pin.at)));
  setLean(root, false);
  lines.length = 0;
  assert.equal(await run('3'), 0);
  assert.equal(lines[0], 'lean: on', 'pinned: a config change mid-phase changes nothing');
  lines.length = 0;
  assert.equal(await run('3', '--json'), 0);
  assert.equal(lines.length, 1);
  assert.ok(!Object.hasOwn(JSON.parse(lines[0]), 'lean'), '--json keeps its stage-5 shape');
});

test('phase-step pins lean off at --done gates-off when lean is off, and a phase begun without a pin stays off', async () => {
  const root = project('lean-step-off');
  const { run, lines } = cli(root);
  setLean(root, false);
  progress(root, ['freshness', 'discuss', 'prologue', 'plan']);
  assert.equal(await run('3', '--done', 'gates-off'), 0);
  assert.deepEqual(lines, ['phase 3: next execute (done: freshness, discuss, prologue, plan, gates-off)']);
  assert.equal(JSON.parse(fs.readFileSync(runFile(root, 'lean-p3.json'), 'utf8')).lean, false);
  setLean(root, true);
  lines.length = 0;
  assert.equal(await run('3'), 0);
  assert.equal(lines.length, 1, 'pinned off');
});

test('phase-step --prep prints lean: on first with lean on, nothing with lean off', async () => {
  const root = project('lean-prep');
  const { run, lines } = cli(root);
  assert.equal(await run('3', '--prep'), 0);
  assert.deepEqual(lines, ['lean: on', 'phase 3: prep next freshness']);
  lines.length = 0;
  assert.equal(await run('3', '--prep', '--done', 'freshness'), 0);
  assert.deepEqual(lines, ['lean: on', 'phase 3: prep next discuss (done: freshness)']);
  setLean(root, false);
  lines.length = 0;
  assert.equal(await run('3', '--prep'), 0);
  assert.deepEqual(lines, ['phase 3: prep next discuss (done: freshness)']);
});

test('leanDeferral: a lean phase\'s turbo-phase run before final-gate only', () => {
  const root = project('lean-defer');
  assert.equal(leanDeferral(root), null, 'no progress file');
  progress(root, ['freshness']);
  assert.deepEqual(leanDeferral(root), { phase: '3' });
  progress(root, ['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate']);
  pinLean(root, '3', true);
  assert.equal(leanDeferral(root), null, 'final-gate done');
  progress(root, ['freshness']);
  fs.rmSync(runFile(root, 'lean-p3.json'));
  setLean(root, false);
  assert.equal(leanDeferral(root), null, 'lean off');
  assert.deepEqual(leanDeferral(root, { lean: { enabled: true } }), { phase: '3' }, 'the config passed in decides');
});

test('leanDeferral: a run that has not moved for a day is an abandoned one outside a lane; a lane keeps its window', () => {
  const root = project('lean-stale');
  const old = new Date(Date.now() - (LEAN_WINDOW_HOURS + 1) * 3600000).toISOString();
  progress(root, ['freshness'], { updatedAt: old });
  assert.equal(leanDeferral(root, null, { env: {} }), null, 'a hand run tests in full');
  assert.deepEqual(leanDeferral(root, null, { env: { TURBO_LANE: '1' } }), { phase: '3' }, 'the lane session');
  progress(root, ['freshness'], { updatedAt: 'not a date' });
  assert.equal(leanDeferral(root, null, { env: {} }), null, 'an unreadable time closes the window');
  progress(root, ['freshness']);
  assert.deepEqual(leanDeferral(root, null, { env: {} }), { phase: '3' }, 'a run that moves keeps it');
});
