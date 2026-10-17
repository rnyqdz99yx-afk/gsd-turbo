import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { fakeSlot } from './helpers/slots.mjs';
import { STEPS, completeStep, readProgress } from '../lib/phase-progress.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { writeDrafts } from '../lib/plan-drafts.mjs';

// Stage 5 §5.8 (B12): the plan step's wall clock and its measurement line.
const project = () => {
  const root = tmpDir('clock');
  fs.mkdirSync(path.join(root, '.planning'));
  return root;
};
const LINE_RE = /^\S+ phase (\S+) plan: (?:\d+h\d{2}m wall clock|wall clock unknown) · drafts (?:on: \d+ plans in \d+ waves, \d+ drafted, \d+ reconciled, \d+ replanned|off: .+)$/;
const logLines = (root) => {
  try {
    return fs.readFileSync(path.join(root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const runner = (root, phase, lines) => (...a) => runPhaseCommand('phase-step', [phase, ...a], { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });

test('phase-step naming plan next keeps its first start; --done plan logs the wall clock and the drafts summary once, before the lane\'s note', async () => {
  const root = project();
  const lines = [];
  const run = runner(root, '3', lines);
  for (const s of STEPS.slice(0, STEPS.indexOf('plan'))) completeStep(root, '3', s);
  const clock = path.join(root, '.planning', 'turbo', 'run', 'plan-clock-p3.json');
  assert.equal(fs.existsSync(clock), false);
  assert.equal(await run(), 0);
  assert.match(lines.at(-1), /next plan/);
  const first = JSON.parse(fs.readFileSync(clock, 'utf8')).started;
  assert.ok(first);
  assert.equal(await run('--json'), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)).timings, { plan: { started: first, done: null, ms: null } });
  // an hour and twelve minutes of planning, across sessions: a resumed session keeps the start
  const started = new Date(Date.now() - (72 * 60 + 30) * 1000).toISOString();
  writeJsonAtomic(clock, { started, done: null });
  assert.equal(await run(), 0);
  assert.equal(JSON.parse(fs.readFileSync(clock, 'utf8')).started, started);
  assert.equal(await run('--done', 'plan', '--note', 'plans 03-01..03-03', '--json'), 0);
  const out = JSON.parse(lines.at(-1));
  assert.ok(out.timings.plan.ms >= 72 * 60000 && out.timings.plan.ms < 74 * 60000);
  const log = logLines(root);
  assert.equal(log.length, 1);
  assert.match(log[0], LINE_RE);
  assert.match(log[0], / phase 3 plan: 1h1[23]m wall clock · drafts off: not asked$/);
  assert.match(readProgress(root, '3').notes.plan, /^phase 3 plan: 1h1[23]m wall clock · drafts off: not asked; plans 03-01\.\.03-03$/);
  // the steps after it log nothing
  assert.equal(await run('--done', 'gates-off'), 0);
  assert.equal(logLines(root).length, 1);
});

test('a v0.4 progress file without a start logs wall clock unknown; --reset clears the clock', async () => {
  const root = project();
  for (const s of STEPS.slice(0, STEPS.indexOf('plan'))) completeStep(root, '3', s);
  const lines = [];
  const run = runner(root, '3', lines);
  assert.equal(await run('--done', 'plan', '--json'), 0);
  assert.equal(JSON.parse(lines.at(-1)).timings.plan.ms, null);
  assert.match(logLines(root)[0], / phase 3 plan: wall clock unknown · drafts off: not asked$/);
  assert.equal(readProgress(root, '3').notes.plan, 'phase 3 plan: wall clock unknown · drafts off: not asked');
  assert.equal(await run('--reset'), 0);
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo', 'run', 'plan-clock-p3.json')), false);
});

test('in a slot the drafts record is the slot\'s and the measurement line lands in the control root\'s log', async () => {
  const { control, slot } = fakeSlot();
  const lines = [];
  const run = runner(slot, '33', lines);
  for (const s of STEPS.slice(0, STEPS.indexOf('plan'))) completeStep(slot, '33', s);
  assert.equal(await run(), 0);
  assert.ok(fs.existsSync(path.join(control, '.planning', 'turbo', 'run', 'plan-clock-p33.json')));
  const at = { drafting: 'x', drafted: 'x' };
  writeDrafts(slot, '33', { v: 1, phase: '33', outline: { file: '33-PLAN-OUTLINE.md', sha256: 'x', plans: 5, waves: 4 }, lastPlan: { use: true, at: 'x' }, plans: {
    '33-02': { state: 'promoted', blobs: {}, at: { ...at, reconciled: 'x', promoted: 'x' } },
    '33-03': { state: 'replanned', blobs: {}, at: { ...at, replanned: 'x' } },
    '33-04': { state: 'drafted', blobs: {}, at },
  } });
  assert.ok(fs.existsSync(path.join(slot, '.planning', 'turbo', 'run', 'drafts-p33', 'drafts.json')));
  assert.equal(await run('--done', 'plan'), 0, lines.at(-1));
  assert.deepEqual(logLines(slot), []);
  const log = logLines(control);
  assert.equal(log.length, 1);
  assert.match(log[0], LINE_RE);
  assert.match(log[0], / phase 33 plan: 0h00m wall clock · drafts on: 5 plans in 4 waves, 3 drafted, 1 reconciled, 1 replanned$/);
  // a record whose last answer was off
  writeDrafts(slot, '34', { v: 1, phase: '34', outline: null, lastPlan: { use: false, why: 'no chunked plan outline', at: 'x' }, plans: {} });
  for (const s of STEPS.slice(0, STEPS.indexOf('plan'))) completeStep(slot, '34', s);
  assert.equal(await runner(slot, '34', lines)('--done', 'plan'), 0);
  assert.match(logLines(control).at(-1), / phase 34 plan: wall clock unknown · drafts off: no chunked plan outline$/);
});
