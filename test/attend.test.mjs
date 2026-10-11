import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { deliveryState, markDelivered, readQuestions, refreshQuestions, stopQuestion } from '../lib/questions.mjs';
import { answerQuestion, preAnswerText } from '../lib/answers.mjs';
import { STEPS } from '../lib/phase-progress.mjs';
import { attendFile, attendGates, attendedPhases, clearAttend, openPlans, releaseStops, sweepLateLanes, writeAttend } from '../lib/attend.mjs';

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

test('attendGates: off only while a full lane\'s restore and fan-out lie ahead; on after them and in safe mode; refused before the plans are checked (F1)', () => {
  const want = {
    freshness: 'refuse', discuss: 'refuse', prologue: 'refuse', plan: 'refuse',
    'gates-off': 'off', execute: 'off', restore: 'off',
    fanout: 'on', fix: 'on', 'final-gate': 'on', uat: 'on', close: 'on',
  };
  for (const next of [...STEPS, null]) {
    const r = attendGates({ mode: 'full', next });
    const got = r.refuse ? 'refuse' : r.gates;
    assert.equal(got, want[next] ?? 'on', String(next));
    assert.ok(r.refuse ? r.refuse.includes(String(next)) : r.why, String(next));
    assert.equal(attendGates({ mode: 'safe', next }).gates, 'on', `safe ${next}`);
  }
  assert.equal(attendGates({ mode: undefined, next: 'execute' }).gates, 'on', 'no recorded mode is safe');
});

test('releaseStops leaves a stop whose answer the stopped session already took: it is no question asked ahead (F4)', () => {
  const root = tmpDir('att');
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN, '32-10-PLAN.md': VERIFY_PLAN });
  refreshQuestions(root, '32');
  stopQuestion(root, '32', '32-09-t2', { agentId: AG });
  answerQuestion({ root, phase: '32', id: '32-09-t2', option: 1, by: 'session', laneRunning: true });
  markDelivered(root, '32', '32-09-t2', 'same-agent');
  stopQuestion(root, '32', '32-10-t3', { agentId: AG });
  assert.deepEqual(releaseStops(root, '32'), ['32-10-t3']);
  const d = readQuestions(root, '32').find((q) => q.id === '32-09-t2');
  assert.deepEqual([d.stopped, d.state], [true, 'delivered']);
  assert.deepEqual(deliveryState(root, '32'), { waiting: [], ready: [] }, 'nothing to deliver after the hand-back either');
});

test('sweepLateLanes: for the settle time, a live lane session that appears late is stopped once; other sessions and ended ones are left; a failed stop is retried and reported (F7)', async () => {
  const lane = (id, state = 'working') => ({ id, name: 'lane', state });
  const seq = [[], [lane('late01'), { id: 'other9', name: 'other', state: 'working' }, lane('old', 'stopped')], [lane('late01'), lane('stuck1')], [lane('late01'), lane('stuck1')]];
  let calls = 0;
  const stops = [];
  const slept = [];
  let clock = 0;
  const r = await sweepLateLanes({
    list: () => seq[Math.min(calls++, seq.length - 1)],
    stop: (id) => { stops.push(id); if (id === 'stuck1') throw new Error('permission denied'); },
    isLane: (x) => x.name === 'lane',
    settleMs: 3500, stepMs: 1000, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  assert.deepEqual(slept, [1000, 1000, 1000, 500]);
  assert.deepEqual(stops, ['late01', 'stuck1', 'stuck1']);
  assert.deepEqual(r, { stopped: ['late01'], failed: [{ id: 'stuck1', error: 'permission denied' }] });
  let listed = 0;
  assert.deepEqual(await sweepLateLanes({ list: () => { listed++; return []; }, stop: () => {}, isLane: () => true, settleMs: 0 }), { stopped: [], failed: [] });
  assert.equal(listed, 0, 'no settle time: no sweep');
  const broken = await sweepLateLanes({ list: () => { throw new Error('agents broke'); }, stop: () => {}, isLane: () => true, settleMs: 100, sleep: async () => {} });
  assert.deepEqual(broken, { stopped: [], failed: [{ id: null, error: 'agents broke' }] });
});

test('sweepLateLanes keeps to its window by the clock: slow session lists eat into it, they never stretch it (N3)', async () => {
  let clock = 0;
  const slept = [];
  let lists = 0;
  await sweepLateLanes({
    list: () => { lists++; clock += 2000; return []; }, // a claude agents call that takes 2 s
    stop: () => {}, isLane: () => true, settleMs: 5000, stepMs: 1000,
    now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; },
  });
  assert.deepEqual([lists, slept], [2, [1000, 1000]]);
  assert.ok(clock <= 5000 + 2000, `ended at ${clock} ms: within the window plus the last list`);
});
