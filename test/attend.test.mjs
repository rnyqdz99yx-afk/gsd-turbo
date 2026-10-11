import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { deliveryState, refreshQuestions, stopQuestion } from '../lib/questions.mjs';
import { answerQuestion, preAnswerText } from '../lib/answers.mjs';
import { attendFile, attendedPhases, clearAttend, openPlans, releaseStops, writeAttend } from '../lib/attend.mjs';

const AG = 'a0123456789abcdef';

test('the attend mark: written once with its first time, listed in phase order, a broken one still listed, cleared once (Review Focus 1)', () => {
  const root = tmpDir('att');
  assert.deepEqual(attendedPhases(root), []);
  assert.deepEqual(writeAttend(root, '10', { sessionId: '1a2b3c4d', now: new Date('2026-01-01T10:00:00Z') }), { phase: '10', at: '2026-01-01T10:00:00.000Z', sessionId: '1a2b3c4d' });
  assert.deepEqual(writeAttend(root, '10', { now: new Date('2026-01-01T11:00:00Z') }), { phase: '10', at: '2026-01-01T10:00:00.000Z', sessionId: '1a2b3c4d' }, 'a second attend keeps the first mark');
  writeAttend(root, '4', { now: new Date('2026-01-01T12:00:00Z') });
  fs.writeFileSync(attendFile(root, '7'), ''); // broken
  fs.writeFileSync(`${attendFile(root, '9')}.tmp-123`, '{}'); // a half-written temp file is no mark
  assert.deepEqual(attendedPhases(root), [{ phase: '4', at: '2026-01-01T12:00:00.000Z' }, { phase: '7', at: null }, { phase: '10', at: '2026-01-01T10:00:00.000Z' }]);
  assert.equal(path.basename(attendFile(root, '4')), 'p4-attend.json');
  assert.equal(clearAttend(root, '4'), true);
  assert.equal(clearAttend(root, '4'), false);
  assert.deepEqual(attendedPhases(root).map((a) => a.phase), ['7', '10']);
});

test('openPlans: the plans without a SUMMARY; null without a single phase directory', () => {
  const root = tmpDir('att');
  const dir = writePhase(root, '04-four', { '04-01-PLAN.md': 'x', '04-01-SUMMARY.md': 'x', '04-02-PLAN.md': 'x', '04-03-PLAN.md': 'x' });
  assert.deepEqual(openPlans(root, '4'), ['04-02', '04-03']);
  assert.equal(openPlans(root, '5'), null);
  for (const f of ['04-02-SUMMARY.md', '04-03-SUMMARY.md']) fs.writeFileSync(path.join(dir, f), 'x');
  assert.deepEqual(openPlans(root, '4'), []);
});

test('releaseStops: the checkpoints a stopped lane waits at are asked ahead again; an answer given at the stop reaches the attended executor as a pre-answer (Review Focus 2)', () => {
  const root = tmpDir('att');
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN, '32-10-PLAN.md': VERIFY_PLAN, '32-11-PLAN.md': ACTION_PLAN });
  refreshQuestions(root, '32');
  stopQuestion(root, '32', '32-10-t3', { agentId: AG });
  answerQuestion({ root, phase: '32', id: '32-10-t3', option: 1, by: 'session', laneRunning: true });
  stopQuestion(root, '32', '32-11-t2', { agentId: AG });
  assert.deepEqual(deliveryState(root, '32').ready.map((q) => q.id), ['32-10-t3'], 'without the release the next lane session would deliver it');
  assert.equal(preAnswerText(root, '32', '32-10'), '', 'a stop is delivered, never pre-answered');

  assert.deepEqual(releaseStops(root, '32'), ['32-10-t3', '32-11-t2']);
  assert.deepEqual(deliveryState(root, '32'), { waiting: [], ready: [] });
  const list = refreshQuestions(root, '32');
  const v = list.find((q) => q.id === '32-10-t3');
  assert.deepEqual([v.stopped, v.agentId, v.state], [false, null, 'answered']);
  assert.match(preAnswerText(root, '32', '32-10'), /At checkpoint task 3 \(checkpoint:human-verify\) the owner's answer is: approved\./);
  const a = list.find((q) => q.id === '32-11-t2');
  assert.deepEqual([a.stopped, a.state, a.options.map((o) => o.defer)], [false, 'open', [true]], 'a physical action is asked ahead as a preference again');
  assert.deepEqual(releaseStops(root, '32'), []);
  assert.deepEqual(releaseStops(tmpDir('att-none'), '3'), []);
});
