import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { writeQuestions } from '../lib/questions.mjs';
import { ownerTick } from '../lib/owner-tick.mjs';
import { tick } from '../lib/supervisor.mjs';

const NOW = new Date('2026-01-01T10:00:00.000Z');
const Q = (id, over = {}) => ({ id, phase: '3', plan: id.slice(0, 5), task: '2', kind: 'decision', header: `${id.slice(0, 5)} T2`, question: 'Pick one', options: [], state: 'open', stopped: false, rev: 1, ...over });
function project() {
  const root = tmpDir('own');
  fs.mkdirSync(path.join(root, '.planning'));
  const notes = [];
  const logs = [];
  const ctx = { root, config: structuredClone(DEFAULTS), turboRun: 'node x', deps: { notify: async (key, vars) => { notes.push({ key, vars }); }, log: (l) => logs.push(l) } };
  return { root, ctx, notes, logs };
}

test('ownerTick: one questionsReady per phase for open questions not notified before; again when a stop reopens one', async () => {
  const { root, ctx, notes } = project();
  await ownerTick(ctx, NOW, {});
  assert.deepEqual(notes, []);
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo', 'run')), false, 'nothing written for nothing');
  writeQuestions(root, '3', [Q('03-01-t2'), Q('03-01-t4', { state: 'answered' })]);
  writeQuestions(root, '10', [Q('10-02-t1', { phase: '10', plan: '10-02', task: '1', header: '10-02 T1', question: 'Deploy after green CI?' })]);
  await ownerTick(ctx, NOW, {});
  assert.deepEqual(notes.map((x) => [x.key, x.vars.phase, x.vars.n]), [['questionsReady', '3', 1], ['questionsReady', '10', 1]]);
  assert.equal(notes[1].vars.list, '10-02 T1: Deploy after green CI?');
  await ownerTick(ctx, NOW, {});
  assert.equal(notes.length, 2, 'notified once');
  writeQuestions(root, '3', [Q('03-01-t2', { stopped: true, rev: 2 }), Q('03-01-t4', { state: 'answered' })]);
  await ownerTick(ctx, NOW, {});
  assert.deepEqual(notes.slice(2).map((x) => [x.vars.phase, x.vars.n]), [['3', 1]]);
});

test('every supervisor tick runs ownerTick; a failure there is logged and never fails the tick', async () => {
  const { root, ctx, notes, logs } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  ctx.deps = {
    ...ctx.deps,
    loadPhases: () => [],
    claude: { list: () => [] },
    fingerprint: () => 'A',
    now: () => NOW,
    notify: async (key) => { notes.push({ key }); if (key === 'questionsReady') throw new Error('notifier down'); },
  };
  const s = await tick({ lane: null, finished: false, halted: false }, ctx);
  assert.deepEqual(notes.map((x) => x.key), ['questionsReady']);
  assert.ok(logs.includes('questions: notifier down'), logs.join('\n'));
  assert.equal(s.failingSince, undefined);
});

test('questionsReady names each question by its own plan and task, never by the cut header: "32.1A-07b T12" is not "T1" (review n4)', async () => {
  const { root, ctx, notes } = project();
  writeQuestions(root, '32.1A', [Q('32.1A-07b-t12', { phase: '32.1A', plan: '32.1A-07b', task: '12', header: '32.1A-07b T1', question: 'Ship it?' })]);
  await ownerTick(ctx, NOW, {});
  assert.equal(notes[0].vars.list, '32.1A-07b T12: Ship it?');
});
