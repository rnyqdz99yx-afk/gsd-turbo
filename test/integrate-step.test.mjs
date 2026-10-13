import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { fakeSlot } from './helpers/slots.mjs';
import { STEPS, completeStep, countAttempt, readProgress } from '../lib/phase-progress.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';

// every step up to close done, and a passed verification, so that --done close passes its check
function closable(root) {
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '03-VERIFICATION.md'), '---\nphase: 03-demo\nstatus: passed\n---\n');
  for (const s of STEPS.slice(0, STEPS.indexOf('close'))) completeStep(root, '3', s);
}
async function step(root, ...args) {
  const lines = [];
  const code = await runPhaseCommand('phase-step', args, { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  return { code, lines };
}

test('integrate is the last step, after close, and counts attempts like a step', () => {
  assert.deepEqual(STEPS.slice(-3), ['uat', 'close', 'integrate']);
  const root = tmpDir('integ');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  assert.equal(countAttempt(root, '3', 'integrate'), 1);
});

test('outside a slot there is nothing to integrate: the step passes as soon as it is next, with its note', async () => {
  const root = tmpDir('integ');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  closable(root);
  const r = await step(root, '3', '--done', 'close');
  assert.equal(r.code, 0);
  assert.match(r.lines.at(-1), /^phase 3: next none \(done: .*, close, integrate\)$/);
  assert.equal(readProgress(root, '3').notes.integrate, 'not a slot: nothing to integrate (checkout mode)');
  // a later call changes nothing
  assert.match((await step(root, '3')).lines.at(-1), /^phase 3: next none/);
});

test('in a slot the step waits for the supervisor: next integrate, and the lane cannot mark it done', async () => {
  const { control, slot } = fakeSlot();
  closable(slot);
  let r = await step(slot, '3', '--done', 'close');
  assert.equal(r.code, 0);
  assert.match(r.lines.at(-1), /^phase 3: next integrate \(done: /);
  r = await step(slot, '3', '--done', 'integrate');
  assert.equal(r.code, 1);
  assert.equal(r.lines.at(-1), 'ERR turbo-run phase-step: phase 3: step integrate is marked by the supervisor after it merges the phase into main; report ready with turbo-run lane-status 3 ready --base <sha>');
  assert.equal(readProgress(slot, '3').done.includes('integrate'), false);
  assert.ok(fs.existsSync(path.join(control, '.planning', 'turbo', 'run', 'phase-p3.json')), 'the progress lives in the control root');
  // the supervisor's own mark (lib/merge.mjs) is a plain completeStep in the control root
  completeStep(control, '3', 'integrate', { note: 'merged' });
  assert.match((await step(slot, '3')).lines.at(-1), /^phase 3: next none/);
});
