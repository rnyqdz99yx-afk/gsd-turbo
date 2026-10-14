import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { ACTION_PLAN, DECISION_PLAN, SITTING_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { askOwner, deliveryState, markDelivered, readAnswers, readQuestions, refreshQuestions, stopQuestion, writeAnswers, writeQuestions } from '../lib/questions.mjs';
import { answerQuestion, preAnswerText } from '../lib/answers.mjs';
import { STEPS } from '../lib/phase-progress.mjs';
import { attendFile, attendGates, attendMark, attendedPhases, clearAttend, openPlans, releaseStops, sweepLateLanes, writeAttend } from '../lib/attend.mjs';
import { NOT_RUNNING, SERVICE_GONE } from '../lib/claude.mjs';

const AG = 'a0123456789abcdef';

test('the attend mark: written once with its first time, listed in phase order, a broken one still listed, cleared once (Review Focus 1)', () => {
  const root = tmpDir('att');
  assert.deepEqual(attendedPhases(root), []);
  assert.deepEqual(writeAttend(root, '10', { sessionId: '1a2b3c4d', now: new Date('2026-01-01T10:00:00Z') }), { phase: '10', at: '2026-01-01T10:00:00.000Z', sessionId: '1a2b3c4d', owner: null });
  assert.deepEqual(writeAttend(root, '10', { now: new Date('2026-01-01T11:00:00Z') }), { phase: '10', at: '2026-01-01T10:00:00.000Z', sessionId: '1a2b3c4d', owner: null }, 'a second attend keeps the first mark');
  writeAttend(root, '4', { now: new Date('2026-01-01T12:00:00Z') });
  fs.writeFileSync(attendFile(root, '7'), ''); // broken
  fs.writeFileSync(`${attendFile(root, '9')}.tmp-123`, '{}'); // a half-written temp file is no mark
  assert.deepEqual(attendedPhases(root), [{ phase: '4', at: '2026-01-01T12:00:00.000Z' }, { phase: '7', at: null }, { phase: '10', at: '2026-01-01T10:00:00.000Z' }]);
  assert.equal(path.basename(attendFile(root, '4')), 'p4-attend.json');
  assert.equal(clearAttend(root, '4'), true);
  assert.equal(clearAttend(root, '4'), false);
  assert.deepEqual(attendedPhases(root).map((a) => a.phase), ['7', '10']);
});

test('the attend mark names the owner\'s session that runs the sitting: a later attend from another session names that one, one without a session keeps it; attendMark reads it (journal ~12:05Z)', () => {
  const root = tmpDir('att');
  assert.equal(attendMark(root, '10'), null);
  writeAttend(root, '10', { sessionId: '1a2b3c4d', owner: 'owner-1', now: new Date('2026-01-01T10:00:00Z') });
  assert.deepEqual(attendMark(root, '10'), { at: '2026-01-01T10:00:00.000Z', owner: 'owner-1' });
  assert.deepEqual(writeAttend(root, '10', { sessionId: 'ffff0000', owner: 'owner-2' }), { phase: '10', at: '2026-01-01T10:00:00.000Z', sessionId: '1a2b3c4d', owner: 'owner-2' }, 'the sitting goes on in a new session');
  assert.equal(writeAttend(root, '10', { owner: null }).owner, 'owner-2');
  fs.writeFileSync(attendFile(root, '7'), 'not json');
  assert.deepEqual(attendMark(root, '7'), { at: null, owner: null }, 'a broken mark is still a mark, with no session');
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

  assert.deepEqual(releaseStops(root, '32'), { ids: ['32-10-t3', '32-11-t2'], kept: [], dropped: [] }, 'an answer given at the stop stands as it is');
  assert.deepEqual(deliveryState(root, '32'), { waiting: [], ready: [] });
  const list = refreshQuestions(root, '32');
  const v = list.find((q) => q.id === '32-10-t3');
  assert.deepEqual([v.stopped, v.agentId, v.state], [false, null, 'answered']);
  assert.match(preAnswerText(root, '32', '32-10'), /At checkpoint task 3 \(checkpoint:human-verify\) the owner's answer is: approved\./);
  const a = list.find((q) => q.id === '32-11-t2');
  assert.deepEqual([a.stopped, a.state, a.options.map((o) => o.defer)], [false, 'open', [true]], 'a physical action is asked ahead as a preference again');
  assert.deepEqual(releaseStops(root, '32').ids, []);
  assert.deepEqual(releaseStops(tmpDir('att-none'), '3'), { ids: [], kept: [], dropped: [] });
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
  assert.deepEqual(releaseStops(root, '32').ids, ['32-10-t3']);
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

test('sweepLateLanes: a session the stop finds not running (a stale record of a stopped background service) is no late lane: not reported, not stopped again while listed the same way; stopped once it is listed running again', async () => {
  const lane = (id, state, pid = 0) => ({ id, name: 'lane', state, pid });
  const seq = [[lane('old1', 'blocked', 4242), lane('old2', 'blocked')], [lane('old1', 'blocked', 4242), lane('old2', 'blocked')], [lane('old1', 'working', 5150), lane('old2', 'blocked')]];
  let calls = 0;
  const stops = [];
  let clock = 0;
  const r = await sweepLateLanes({
    list: () => seq[Math.min(calls++, seq.length - 1)],
    stop: (id) => {
      stops.push(id);
      if (stops.length > 2) return 'stopped';
      return id === 'old1' ? SERVICE_GONE : NOT_RUNNING;
    },
    isLane: () => true,
    settleMs: 3000, stepMs: 1000, now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.deepEqual(stops, ['old1', 'old2', 'old1'], 'the second list changes nothing; the third lists old1 running under a new pid');
  assert.deepEqual(r, { stopped: ['old1'], failed: [] });
});

test('releaseStops leaves a lane\'s own question alone: it belongs to no agent, and the owner answers it in the sitting or after (v0.3.3)', () => {
  const root = tmpDir('att-lane');
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN });
  askOwner(root, '32', { action: 'Plug the phone in.' }, { lang: 'en' });
  assert.deepEqual(releaseStops(root, '32').ids, []);
  assert.deepEqual(deliveryState(root, '32').waiting.map((q) => q.id), ['ask-1']);
});

test('a released stop keeps the owner\'s last real answer as the sitting\'s pre-answer, with its time, when only the stop came back (journal 08:22Z)', () => {
  const root = tmpDir('att-keep');
  writePhase(root, '32-auth', { '32-11-PLAN.md': ACTION_PLAN });
  refreshQuestions(root, '32');
  stopQuestion(root, '32', '32-11-t2', { agentId: AG, now: new Date('2026-01-01T08:20:00Z') });
  answerQuestion({ root, phase: '32', id: '32-11-t2', text: 'go', by: 'pane', laneRunning: true, now: new Date('2026-01-01T08:22:11Z') });
  markDelivered(root, '32', '32-11-t2', 'same-agent');
  // the agent returns the same checkpoint (the lane cannot go on without the owner's session): asked again, the answer set aside
  stopQuestion(root, '32', '32-11-t2', { agentId: AG, now: new Date('2026-01-01T08:26:09Z') });
  assert.equal(readQuestions(root, '32')[0].state, 'open');
  assert.equal(readAnswers(root, '32')[0].supersededBy, 'stop');
  assert.deepEqual(releaseStops(root, '32', { now: new Date('2026-01-01T08:30:00Z') }), { ids: ['32-11-t2'], kept: ['32-11-t2'], dropped: [] });
  for (const list of [readQuestions(root, '32'), refreshQuestions(root, '32')]) {
    const q = list[0];
    assert.deepEqual([q.stopped, q.agentId, q.state, q.answer.answer, q.answer.by, q.answer.at], [false, null, 'answered', 'go', 'pane', '2026-01-01T08:22:11.000Z']);
  }
  assert.match(preAnswerText(root, '32', '32-11'), /At checkpoint task 2 \(checkpoint:human-action\) the owner's answer is: \(the owner's own words\) go\./);
  const records = readAnswers(root, '32');
  assert.equal(records.length, 2, 'the set-aside record stays as it was');
  assert.deepEqual([records[0].superseded, records[1].superseded, records[1].at, records[1].keptAt], ['2026-01-01T08:26:09.000Z', undefined, '2026-01-01T08:22:11.000Z', '2026-01-01T08:30:00.000Z']);
  assert.deepEqual(deliveryState(root, '32'), { waiting: [], ready: [] }, 'nothing to deliver: the sitting\'s executor takes it ahead');
  assert.deepEqual(releaseStops(root, '32'), { ids: [], kept: [], dropped: [] });
});

test('a released stop asks again when its condition changed: an unmet answer, the lane\'s new diagnosis, a preference, turbo\'s own answer, a newer preference, a changed plan', () => {
  const setup = (plans) => {
    const root = tmpDir('att-changed');
    writePhase(root, '32-auth', plans);
    refreshQuestions(root, '32');
    return root;
  };
  const answerAndReturn = (root, id, answer, again = {}) => {
    stopQuestion(root, '32', id, { agentId: AG });
    answerQuestion({ root, phase: '32', id, laneRunning: true, ...answer });
    markDelivered(root, '32', id, 'same-agent');
    stopQuestion(root, '32', id, { agentId: AG, ...again });
  };
  const opened = (root, id) => {
    const r = releaseStops(root, '32');
    assert.deepEqual(r.kept, [], id);
    assert.equal(refreshQuestions(root, '32').find((q) => q.id === id).state, 'open', id);
  };
  let root = setup({ '32-10-PLAN.md': VERIFY_PLAN });
  answerAndReturn(root, '32-10-t3', { option: 1, by: 'session' }, { unmet: true });
  assert.equal(readAnswers(root, '32')[0].supersededBy, 'unmet');
  opened(root, '32-10-t3');
  root = setup({ '32-11-PLAN.md': ACTION_PLAN });
  answerAndReturn(root, '32-11-t2', { option: 1, by: 'pane' }, { question: 'Turn the mail service on in its console first.', context: 'The check still finds it off.' });
  assert.equal(readAnswers(root, '32')[0].supersededBy, 'diagnosis');
  opened(root, '32-11-t2');
  // a preference given ahead ("ask me then"): the stop asks, never a kept answer
  root = setup({ '32-11-PLAN.md': ACTION_PLAN });
  answerQuestion({ root, phase: '32', id: '32-11-t2', option: 1, by: 'pane', laneRunning: true });
  stopQuestion(root, '32', '32-11-t2', { agentId: AG });
  assert.equal(readAnswers(root, '32')[0].supersededBy, 'defer');
  opened(root, '32-11-t2');
  // turbo's own answer is never kept for the owner's sitting
  root = setup({ '32-09-PLAN.md': DECISION_PLAN });
  answerAndReturn(root, '32-09-t2', { option: 1, by: 'auto' });
  opened(root, '32-09-t2');
  // the owner's newest word was a preference: the real answer before it is not taken back
  root = setup({ '32-09-PLAN.md': DECISION_PLAN });
  answerAndReturn(root, '32-09-t2', { option: 1, by: 'session' });
  const [first] = readAnswers(root, '32');
  const { superseded: _s, supersededBy: _b, ...plain } = first;
  writeAnswers(root, '32', [first, { ...plain, defer: true, at: '2026-01-02T00:00:00.000Z' }]);
  assert.deepEqual(releaseStops(root, '32').kept, []);
  assert.equal(refreshQuestions(root, '32').find((q) => q.id === '32-09-t2').state, 'deferred');
  // an answer recorded before supersededBy existed: kept only when plain (no condition) at an unchanged card
  root = setup({ '32-09-PLAN.md': DECISION_PLAN });
  answerAndReturn(root, '32-09-t2', { option: 1, by: 'telegram' });
  writeAnswers(root, '32', readAnswers(root, '32').map(({ supersededBy: _gone, ...r }) => r));
  assert.deepEqual(releaseStops(root, '32').kept, ['32-09-t2']);
  // the plan changed the checkpoint after the release: the kept answer is set aside at the next refresh
  const dir = path.join(root, '.planning', 'phases', '32-auth');
  fs.writeFileSync(path.join(dir, '32-09-PLAN.md'), DECISION_PLAN.replace('Clerk', 'Clerk Pro'));
  assert.equal(refreshQuestions(root, '32').find((q) => q.id === '32-09-t2').state, 'open');
});

// journal 2026-10-14 (15:19:48Z): the owner pressed the Done a sitting's v0.3.3 card offered; attend must drop it
test('releaseStops drops a done on a live sitting, released or released before, and never keeps one: the question opens and no executor gets it', () => {
  const root = tmpDir('att-sit');
  // the plans in the lane's slot (phaseRoot), the questions and answers in the control root
  const slot = tmpDir('att-sit-slot');
  writePhase(slot, '33-live', { '33-11-PLAN.md': ACTION_PLAN, '33-16-PLAN.md': SITTING_PLAN });
  refreshQuestions(slot, '33');
  const done = { id: '33-16-t2', plan: '33-16', task: '2', option: 1, label: 'Сделано', answer: 'done', by: 'pane', at: '2026-01-01T15:19:48.000Z', conditional: false, condition: null, defer: false };
  const setup = (q) => {
    // the stop as v0.3.3 wrote it: no sitting mark
    const list = readQuestions(slot, '33').map((x) => (x.id === '33-16-t2' ? (({ sitting: _m, ...rest }) => ({ ...rest, ...q }))(x) : x));
    writeQuestions(root, '33', list);
    writeAnswers(root, '33', [done]);
  };
  const answered = { state: 'answered', answer: { option: 1, label: 'Сделано', answer: 'done', by: 'pane', at: done.at, conditional: false }, rev: 3 };
  setup({ ...answered, stopped: true, agentId: AG });
  const r = releaseStops(root, '33', { now: new Date('2026-01-01T16:00:00Z'), phaseRoot: slot });
  assert.deepEqual(r, { ids: ['33-16-t2'], kept: [], dropped: [{ id: '33-16-t2', label: 'Сделано', answer: 'done', by: 'pane', at: '2026-01-01T15:19:48.000Z' }] });
  const q = readQuestions(root, '33').find((x) => x.id === '33-16-t2');
  assert.deepEqual([q.state, q.answer, q.stopped, q.agentId, q.rev], ['open', null, false, null, 4]);
  assert.deepEqual([readAnswers(root, '33')[0].superseded, readAnswers(root, '33')[0].supersededBy], ['2026-01-01T16:00:00.000Z', 'sitting']);
  assert.equal(preAnswerText(root, '33', '33-16'), '');
  assert.deepEqual(releaseStops(root, '33', { phaseRoot: slot }), { ids: [], kept: [], dropped: [] });
  // released by an older attend (it kept the done as a pre-answer): dropped all the same
  setup({ ...answered, stopped: false, agentId: null });
  assert.deepEqual(releaseStops(root, '33', { phaseRoot: slot }).dropped.map((d) => d.id), ['33-16-t2']);
  assert.equal(readQuestions(root, '33').find((x) => x.id === '33-16-t2').state, 'open');
  // a done set aside at the stop (the stop came back) is never kept for the sitting
  setup({ state: 'open', answer: null, stopped: true, agentId: AG });
  writeAnswers(root, '33', [{ ...done, superseded: '2026-01-01T15:25:00.000Z', supersededBy: 'stop' }]);
  assert.deepEqual(releaseStops(root, '33', { phaseRoot: slot }), { ids: ['33-16-t2'], kept: [], dropped: [] });
  // the same done on a plain action stands as before
  setup({});
  writeAnswers(root, '33', [{ ...done, id: '33-11-t2', plan: '33-11', label: 'Done' }]);
  const plain = readQuestions(root, '33');
  Object.assign(plain.find((x) => x.id === '33-11-t2'), { ...answered, stopped: true, agentId: AG });
  writeQuestions(root, '33', plain);
  assert.deepEqual(releaseStops(root, '33', { phaseRoot: slot }), { ids: ['33-11-t2'], kept: [], dropped: [] });
  assert.match(preAnswerText(root, '33', '33-11'), /the owner's answer is: done/);
});
