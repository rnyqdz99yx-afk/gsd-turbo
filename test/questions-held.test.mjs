import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DECISION_PLAN, writePhase } from './helpers/plans.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { askOwner, dropLaneQuestions, markDelivered, readQuestions } from '../lib/questions.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { openQuestions } from '../lib/view.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';

const RU_Q = 'Исправления готовы, живая проверка ещё не запускалась. Что делать дальше?';
const RU_OPTS = [
  { label: 'Сначала исправить замечания', description: 'Фаза исправит три новых замечания ревью и потом запустит проверку.' },
  { label: 'Сразу живая проверка', description: 'Замечания останутся; проверка покажет, мешают ли они.' },
];
const INPUT = { question: RU_Q, options: RU_OPTS, recommended: 1 };
const now = new Date('2026-10-17T12:00:00Z');

function phaseRoot() {
  const root = tmpDir('held');
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN });
  return root;
}
const ids = (root) => readQuestions(root, '32').map((q) => q.id);

test('a held card writes no lane status and supersedes nothing', () => {
  const root = phaseRoot();
  const a = askOwner(root, '32', INPUT, { lang: 'ru', now, keepRunning: true });
  const b = askOwner(root, '32', INPUT, { lang: 'ru', now, keepRunning: true });
  assert.deepEqual([a.question.id, b.question.id], ['ask-1', 'ask-2']);
  for (const r of [a, b]) {
    assert.equal(r.question.state, 'open');
    assert.equal(r.question.held, true);
    assert.deepEqual(r.superseded, []);
  }
  assert.equal(readLaneStatus(root, '32'), null);
  assert.deepEqual(ids(root), ['ask-1', 'ask-2']);
});

test('a plain ask supersedes only cards not held', () => {
  const root = phaseRoot();
  askOwner(root, '32', INPUT, { lang: 'ru', now, keepRunning: true });
  askOwner(root, '32', INPUT, { lang: 'ru', now, keepRunning: true });
  const c = askOwner(root, '32', INPUT, { lang: 'ru', now });
  assert.equal(c.question.id, 'ask-3');
  assert.equal(c.question.held, undefined);
  assert.deepEqual(c.superseded, []);
  const st = readLaneStatus(root, '32');
  assert.deepEqual([st.status, st.reason], ['needs-owner', 'owner question ask-3']);
  const d = askOwner(root, '32', INPUT, { lang: 'ru', now });
  assert.equal(d.question.id, 'ask-4');
  assert.deepEqual(d.superseded, ['ask-3']);
  assert.deepEqual(ids(root), ['ask-1', 'ask-2', 'ask-4']);
});

test('a restarted step keeps held cards', () => {
  const root = phaseRoot();
  askOwner(root, '32', INPUT, { lang: 'ru', now, keepRunning: true });
  askOwner(root, '32', INPUT, { lang: 'ru', now, keepRunning: true });
  askOwner(root, '32', INPUT, { lang: 'ru', now });
  askOwner(root, '32', INPUT, { lang: 'ru', now });
  assert.deepEqual(dropLaneQuestions(root, '32'), ['ask-4']);
  assert.deepEqual(ids(root), ['ask-1', 'ask-2']);
  assert.deepEqual(dropLaneQuestions(root, '32', { ids: ['ask-1'] }), ['ask-1']);
  assert.deepEqual(ids(root), ['ask-2']);
  assert.deepEqual(dropLaneQuestions(root, '32', { ids: ['ask-9'] }), [], 'an unknown id drops nothing');
});

test('a held card is answered and delivered like any lane question', () => {
  const root = phaseRoot();
  askOwner(root, '32', INPUT, { lang: 'ru', now, keepRunning: true });
  askOwner(root, '32', INPUT, { lang: 'ru', now, keepRunning: true });
  assert.deepEqual(openQuestions(root).map((q) => q.id), ['ask-1', 'ask-2'], 'the pane, Telegram and the automatic answer see it');
  answerQuestion({ root, phase: '32', id: 'ask-2', option: 1, by: 'pane', laneRunning: true });
  assert.equal(readQuestions(root, '32').find((q) => q.id === 'ask-2').state, 'answered');
  assert.equal(markDelivered(root, '32', 'ask-2', 'lane').state, 'delivered');
  assert.equal(readLaneStatus(root, '32'), null);
  // a delivered held card is gone from a restarted step's drop list as any delivered card
  assert.deepEqual(dropLaneQuestions(root, '32', { ids: ['ask-1', 'ask-2'] }), ['ask-1']);
});

async function run(root, args) {
  const lines = [];
  const code = await runPhaseCommand(args[0], args.slice(1), { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), deps: { env: {}, supervisorAlive: () => true } });
  return { code, lines };
}

test('CLI: turbo-run ask … --keep-running', async () => {
  const root = phaseRoot();
  const ASK = ['ask', '32', '--question', 'Which cache do we keep?', '--option', 'a|b', '--option', 'c|d', '--recommended', '1', '--keep-running'];
  let r = await run(root, ASK);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(r.lines[0], 'asked: ask-1 waits for the owner; the lane keeps running (only the work that needs this answer waits)');
  assert.equal(readLaneStatus(root, '32'), null);
  r = await run(root, [...ASK, '--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.lines[0]);
  assert.equal(j.question.held, true);
  assert.deepEqual(j.superseded, []);
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo', 'run', 'p32.json')), false, 'no lane record');
});
