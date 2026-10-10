import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { parseCheckpoints } from '../lib/checkpoints.mjs';
import { maskSecrets } from '../lib/secrets.mjs';
import { completeStep, readProgress } from '../lib/phase-progress.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import {
  CLASSES, answersRel, buildQuestion, classifyQuestions, deliveryState, dynamicQuestion, liveAnswer, lockFile, markDelivered,
  questionId, questionsFile, readAnswers, readQuestions, refreshQuestions, stopQuestion, withPhaseLock, writeAnswers, writeQuestions,
} from '../lib/questions.mjs';

const cpOf = (text) => parseCheckpoints(text)[0];

test('a decision question: id, header, the plan\'s options with the recommended one first, signals and the condition', () => {
  const q = buildQuestion(cpOf(DECISION_PLAN), { phase: '32', plan: '32-09' });
  assert.equal(q.id, '32-09-t2');
  assert.equal(questionId('32-09', 2), '32-09-t2');
  assert.equal(q.header, '32-09 T2');
  assert.equal(q.question, 'Select the authentication provider');
  assert.equal(q.context, 'The app needs sign-in. Two options with different trade-offs.');
  assert.deepEqual(q.options, [
    { label: 'Clerk', description: '+ Pre-built UI & good docs − Paid after 10k users', recommended: true, signal: 'clerk', defer: false },
    { label: 'Supabase Auth', description: '+ Built into the database we use − Less customizable UI', recommended: false, signal: 'supabase', defer: false },
  ]);
  assert.equal(q.allowOther, true);
  assert.equal(q.condition, 'the checkpoint offers the options the plan lists');
  assert.deepEqual([q.phase, q.plan, q.task, q.kind, q.gate], ['32', '32-09', '2', 'decision', 'blocking']);
  assert.deepEqual([q.class, q.topic, q.classified, q.agentId, q.stopped, q.state, q.answer, q.delivery, q.rev, q.source],
    ['decision', null, false, null, false, 'open', null, null, 1, 'plan']);
  const stop = buildQuestion(cpOf(DECISION_PLAN), { phase: '32', plan: '32-09', stopped: true });
  assert.deepEqual(stop.options, q.options);
  assert.equal(stop.condition, null);
  const plain = buildQuestion({ ...cpOf(DECISION_PLAN), autoSelect: null }, { phase: '32', plan: '32-09' });
  assert.deepEqual(plain.options.map((o) => [o.signal, o.recommended]), [['supabase', false], ['clerk', false]]);
});

test('a human-verify question: ahead "accept if the checks pass" or "stop and show me"; at the stop the approval its resume signal asks for', () => {
  const ahead = buildQuestion(cpOf(VERIFY_PLAN), { phase: '32', plan: '32-10' });
  assert.equal(ahead.question, 'Verify: Dashboard layout - dev server running at http://localhost:3000');
  assert.match(ahead.context, /^Visit http:\/\/localhost:3000\/dashboard and check: 1\. Sidebar left/);
  assert.deepEqual(ahead.options.map((o) => [o.label, o.signal, o.defer, o.recommended]),
    [['Accept if the checks pass', 'approved', false, false], ['Stop and show me', null, true, false]]);
  assert.equal(ahead.condition, 'every automated check in how-to-verify passed, and the evidence is attached');
  assert.deepEqual([ahead.class, ahead.allowOther], ['decision', true]);
  const stop = buildQuestion(cpOf(VERIFY_PLAN), { phase: '32', plan: '32-10', stopped: true });
  assert.deepEqual(stop.options.map((o) => [o.label, o.signal, o.defer]), [['Approved', 'approved', false]]);
  assert.deepEqual([stop.condition, stop.allowOther], [null, true]);
});

test('a human-action question: ahead only "I will do it when the lane asks", without own words; Done at the stop; class owner-only', () => {
  const ahead = buildQuestion(cpOf(ACTION_PLAN), { phase: '32', plan: '32-11' });
  assert.equal(ahead.question, 'Action: Complete the email verification for the mail service account');
  assert.equal(ahead.context, 'I created the account and asked for the verification mail. Click the link in it. The mail API key works: the test send succeeds');
  assert.deepEqual(ahead.options.map((o) => [o.label, o.signal, o.defer]), [['I will do it when the lane asks', null, true]]);
  assert.deepEqual([ahead.allowOther, ahead.condition, ahead.class, ahead.gate], [false, null, 'owner-only', 'blocking-human']);
  const stop = buildQuestion(cpOf(ACTION_PLAN), { phase: '32', plan: '32-11', stopped: true });
  assert.deepEqual(stop.options.map((o) => [o.label, o.signal]), [['Done', 'done']]);
  assert.equal(stop.allowOther, true);
});

test('Russian labels with lang ru; long texts cut after masking; secrets masked; header at most 12 characters', () => {
  const ru = buildQuestion(cpOf(VERIFY_PLAN), { phase: '32', plan: '32-10', lang: 'ru' });
  assert.deepEqual(ru.options.map((o) => o.label), ['Принять при условии', 'Остановиться и показать мне']);
  assert.match(ru.question, /^Проверка: /);
  assert.equal(ru.condition, 'все автоматические проверки из how-to-verify прошли, и доказательства приложены');
  const token = `ghp_${'a1B2'.repeat(9)}`;
  const q = buildQuestion({ ...cpOf(DECISION_PLAN), context: `${'x'.repeat(700)} ${token}`, decision: `Use ${token} now` }, { phase: '32', plan: '32.1-05' });
  assert.equal([...q.context].length, 600);
  assert.equal(q.question, maskSecrets(`Use ${token} now`));
  assert.ok(!JSON.stringify(q).includes(token));
  assert.equal(q.header, '32.1-05 T2');
  assert.equal(buildQuestion(cpOf(DECISION_PLAN), { phase: '5', plan: 'ABC-05.1-03' }).header, 'ABC-05.1-03 ');
});

test('a checkpoint the lane names at a stop: plan and task from its id, the options of its kind', () => {
  const q = dynamicQuestion({ phase: '32', id: '32-09-t4', kind: 'human-action', question: 'Log in to the CLI of the mail service' });
  assert.deepEqual([q.plan, q.task, q.kind, q.stopped, q.source, q.gate, q.allowOther], ['32-09', '4', 'human-action', true, 'stop', 'blocking-human', true]);
  assert.equal(q.question, 'Action: Log in to the CLI of the mail service');
  assert.deepEqual(q.options.map((o) => o.signal), ['done']);
  const v = dynamicQuestion({ phase: '32', id: '32-09-t5', kind: 'human-verify', question: 'Check the package before install' });
  assert.deepEqual([v.question, v.options.map((o) => o.signal)], ['Verify: Check the package before install', ['approved']]);
  assert.throws(() => dynamicQuestion({ phase: '32', id: 'nope', kind: 'human-action', question: 'x' }), /<plan>-t<task>/);
});

// A phase with plans 08 (done), 09 (decision), 10 (human-verify) and 11 (human-action).
function project() {
  const root = tmpDir('q');
  const dir = writePhase(root, '32-auth', {
    '32-08-PLAN.md': DECISION_PLAN, '32-08-SUMMARY.md': '# done\n',
    '32-09-PLAN.md': DECISION_PLAN, '32-10-PLAN.md': VERIFY_PLAN, '32-11-PLAN.md': ACTION_PLAN,
  });
  return { root, dir };
}
const record = (over) => ({ plan: '32-10', task: '3', option: 1, label: 'Accept if the checks pass', answer: 'approved', by: 'session', at: '2026-01-01T00:00:00.000Z', conditional: true, condition: 'c', defer: false, ...over });

test('refreshQuestions: one question per checkpoint of every plan without a SUMMARY, in run/p<N>-questions.json', () => {
  const { root } = project();
  const list = refreshQuestions(root, '32');
  assert.deepEqual(list.map((q) => q.id), ['32-09-t2', '32-10-t3', '32-11-t2']);
  assert.deepEqual(readQuestions(root, '32'), list);
  assert.equal(path.basename(questionsFile(root, '32')), 'p32-questions.json');
  assert.equal(answersRel('32'), '.planning/turbo/answers/p32.json');
  assert.deepEqual(refreshQuestions(tmpDir('none'), '7'), []);
});

test('a refresh keeps the class, the agent and the stop; state and answer come from the answers file; rev counts option changes', () => {
  const { root, dir } = project();
  refreshQuestions(root, '32');
  classifyQuestions(root, '32', '32-09-t2=consent:deploy');
  writeAnswers(root, '32', [record({ id: '32-10-t3' })]);
  let list = refreshQuestions(root, '32');
  const d = list.find((q) => q.id === '32-09-t2');
  assert.deepEqual([d.class, d.topic, d.classified, d.rev], ['consent', 'deploy', true, 1]);
  const v = list.find((q) => q.id === '32-10-t3');
  assert.equal(v.state, 'answered');
  assert.deepEqual(v.answer, { option: 1, label: 'Accept if the checks pass', answer: 'approved', by: 'session', at: '2026-01-01T00:00:00.000Z', conditional: true });
  fs.writeFileSync(path.join(dir, '32-09-PLAN.md'), DECISION_PLAN.replace('<name>Clerk</name>', '<name>Clerk (hosted)</name>'));
  list = refreshQuestions(root, '32');
  assert.deepEqual([list[0].rev, list[0].class, list[0].options[0].label], [2, 'consent', 'Clerk (hosted)']);
  fs.writeFileSync(path.join(dir, '32-10-SUMMARY.md'), '# done\n');
  assert.deepEqual(refreshQuestions(root, '32').map((q) => q.id), ['32-09-t2', '32-11-t2']);
  assert.equal(readAnswers(root, '32').length, 1, 'answers stay');
});

test('liveAnswer skips superseded records; a preference reads as deferred', () => {
  const recs = [{ id: 'a', answer: 'x' }, { id: 'a', answer: 'y', superseded: 'z' }, { id: 'b', answer: 'q' }];
  assert.equal(liveAnswer(recs, 'a').answer, 'x');
  assert.equal(liveAnswer(recs, 'c'), null);
  const { root } = project();
  refreshQuestions(root, '32');
  writeAnswers(root, '32', [record({ id: '32-11-t2', plan: '32-11', task: '2', label: 'I will do it when the lane asks', answer: null, conditional: false, condition: null, defer: true })]);
  assert.equal(refreshQuestions(root, '32').find((q) => q.id === '32-11-t2').state, 'deferred');
});

test('classifyQuestions sets owner-only, consent, consent:deploy, decision or verify by id; anything else is refused and nothing changes', () => {
  const { root } = project();
  refreshQuestions(root, '32');
  assert.deepEqual(CLASSES, ['owner-only', 'consent', 'consent:deploy', 'decision', 'verify']);
  const list = classifyQuestions(root, '32', '32-10-t3=verify, 32-11-t2=owner-only');
  assert.deepEqual(list.map((q) => [q.id, q.class, q.classified]), [['32-09-t2', 'decision', false], ['32-10-t3', 'verify', true], ['32-11-t2', 'owner-only', true]]);
  assert.throws(() => classifyQuestions(root, '32', '32-09-t2=urgent'), /unknown class urgent for 32-09-t2/);
  assert.throws(() => classifyQuestions(root, '32', '32-99-t1=verify'), /no question 32-99-t1 in phase 32/);
  assert.throws(() => classifyQuestions(root, '32', ''), /--class needs <id>=<class>/);
  assert.equal(readQuestions(root, '32').find((q) => q.id === '32-09-t2').classified, false);
});

test('the phase lock: a second writer waits and gives up with a clear error; a lock left by a crash is taken over (Review Focus 1)', () => {
  const { root } = project();
  refreshQuestions(root, '32');
  const file = lockFile(root, '32');
  fs.writeFileSync(file, '');
  assert.throws(() => withPhaseLock(root, '32', () => 1, { waitMs: 100 }), /the questions of phase 32 are locked by another turbo-run/);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
  assert.equal(withPhaseLock(root, '32', () => 42), 42);
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => withPhaseLock(root, '32', () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(file), false, 'released after an error');
});

const AG = 'a0123456789abcdef';
const owner = (root, id, more) => answerQuestion({ root, phase: '32', id, by: 'session', laneRunning: true, ...more });

test('a stop at an unanswered checkpoint opens it again with the options the waiting agent takes, its agent and a new rev', () => {
  const { root } = project();
  refreshQuestions(root, '32');
  const r = stopQuestion(root, '32', '32-10-t3', { agentId: AG });
  assert.equal(r.status, 'stopped');
  assert.deepEqual([r.question.stopped, r.question.agentId, r.question.state, r.question.rev, r.question.condition], [true, AG, 'open', 2, null]);
  assert.deepEqual(r.question.options.map((o) => o.label), ['Approved']);
  assert.deepEqual(deliveryState(root, '32').waiting.map((q) => q.id), ['32-10-t3']);
  assert.equal(refreshQuestions(root, '32').find((q) => q.id === '32-10-t3').options[0].label, 'Approved', 'a refresh keeps the stop');
});

test('a stop at an answered checkpoint is delivered at once, unless the executor reports its condition unmet', () => {
  const { root } = project();
  refreshQuestions(root, '32');
  owner(root, '32-09-t2', { option: 1 });
  const r = stopQuestion(root, '32', '32-09-t2', { agentId: AG });
  assert.equal(r.status, 'answered');
  assert.deepEqual(deliveryState(root, '32').ready.map((q) => [q.id, q.agentId]), [['32-09-t2', AG]]);
  const unmet = stopQuestion(root, '32', '32-09-t2', { agentId: AG, unmet: true, now: new Date('2026-01-01T11:00:00Z') });
  assert.deepEqual([unmet.status, unmet.question.state], ['stopped', 'open']);
  const recs = readAnswers(root, '32');
  assert.equal(recs[0].superseded, '2026-01-01T11:00:00.000Z');
  assert.equal(liveAnswer(recs, '32-09-t2'), null);
  assert.equal(owner(root, '32-09-t2', { option: 2, by: 'telegram' }).status, 'recorded', 'a new answer stands');
  assert.equal(deliveryState(root, '32').ready[0].answer.label, 'Supabase Auth');
});

test('a deferred checkpoint opens at the stop; a checkpoint that is no plan task needs its kind and a line', () => {
  const { root } = project();
  refreshQuestions(root, '32');
  owner(root, '32-11-t2', { option: 1 });
  const r = stopQuestion(root, '32', '32-11-t2', { agentId: AG });
  assert.equal(r.status, 'stopped');
  assert.deepEqual(r.question.options.map((o) => o.signal), ['done']);
  assert.throws(() => stopQuestion(root, '32', '32-09-t7', { agentId: AG }), /--kind human-verify\|human-action and --question/);
  const d = stopQuestion(root, '32', '32-09-t7', { agentId: AG, kind: 'human-action', question: 'Log in to the deploy CLI' });
  assert.deepEqual([d.status, d.question.source, d.question.question], ['stopped', 'stop', 'Action: Log in to the deploy CLI']);
  assert.ok(refreshQuestions(root, '32').some((q) => q.id === '32-09-t7'), 'kept while its plan is open');
  assert.throws(() => stopQuestion(root, '32', '32-09-t2', { agentId: '../x' }), /--agent/);
});

test('markDelivered records the path on the question and as a note of the step in progress', () => {
  const { root } = project();
  refreshQuestions(root, '32');
  for (const s of ['freshness', 'discuss', 'prologue', 'plan', 'gates-off']) completeStep(root, '32', s);
  stopQuestion(root, '32', '32-10-t3', { agentId: AG });
  assert.throws(() => markDelivered(root, '32', '32-10-t3', 'same-agent'), /is open, not answered/);
  owner(root, '32-10-t3', { option: 1 });
  assert.throws(() => markDelivered(root, '32', '32-10-t3', 'carrier-pigeon'), /same-agent or continuation/);
  const q = markDelivered(root, '32', '32-10-t3', 'same-agent', { now: new Date('2026-01-01T12:00:00Z') });
  assert.deepEqual([q.state, q.delivery], ['delivered', { path: 'same-agent', at: '2026-01-01T12:00:00.000Z' }]);
  assert.equal(readProgress(root, '32').notes.execute, 'owner answer 32-10-t3: same-agent');
  assert.deepEqual(deliveryState(root, '32').ready, []);
  assert.equal(refreshQuestions(root, '32').find((x) => x.id === '32-10-t3').state, 'delivered');
});

test('the same checkpoint returned again after its answer was delivered opens again for the owner: the delivered answer is superseded', () => {
  const { root } = project();
  refreshQuestions(root, '32');
  stopQuestion(root, '32', '32-10-t3', { agentId: AG });
  owner(root, '32-10-t3', { text: 'The sidebar overlaps the header; fix it' });
  markDelivered(root, '32', '32-10-t3', 'same-agent');
  // the agent fixed it and asks for the verification again
  const again = stopQuestion(root, '32', '32-10-t3', { agentId: AG, now: new Date('2026-01-01T13:00:00Z') });
  assert.deepEqual([again.status, again.question.state, again.question.stopped, again.question.rev, again.question.answer], ['stopped', 'open', true, 3, null]);
  assert.equal(readAnswers(root, '32')[0].superseded, '2026-01-01T13:00:00.000Z');
  assert.deepEqual(deliveryState(root, '32').waiting.map((q) => q.id), ['32-10-t3']);
  assert.equal(owner(root, '32-10-t3', { option: 1 }).status, 'recorded', 'the owner is asked again');
});

test('a plan whose name is no usable question id is skipped with a warning: its checkpoints never reach a question, a prompt or an argv', () => {
  const { root, dir } = project();
  fs.writeFileSync(path.join(dir, '32-12 draft%2-PLAN.md'), DECISION_PLAN);
  fs.writeFileSync(path.join(dir, `32-${'x'.repeat(60)}-PLAN.md`), VERIFY_PLAN);
  const warnings = [];
  const list = refreshQuestions(root, '32', { warn: (l) => warnings.push(l) });
  assert.deepEqual(list.map((q) => q.id), ['32-09-t2', '32-10-t3', '32-11-t2']);
  assert.equal(warnings.length, 2);
  assert.match(warnings.find((w) => w.includes('draft')), /^plan 32-12 draft%2-PLAN\.md: its name cannot make a question id .*for the owner: rename the plan file; a lane never renames plan files$/);
  assert.deepEqual(refreshQuestions(root, '32').map((q) => q.id), list.map((q) => q.id), 'no warn callback: skipped all the same');
});

test('deliveryState never lists a question whose id is unusable (a hand-edited file): nothing of it reaches a wake prompt', () => {
  const { root } = project();
  const q = (id) => ({ id, phase: '32', plan: '32-09', task: '2', kind: 'decision', options: [], state: 'answered', stopped: true, agentId: AG, answer: { option: 1 }, rev: 2 });
  writeQuestions(root, '32', [q('32-09-t2'), q('32 09"x%-t2'), { ...q('bad id-t3'), state: 'open' }]);
  const d = deliveryState(root, '32');
  assert.deepEqual([d.ready.map((x) => x.id), d.waiting.map((x) => x.id)], [['32-09-t2'], []]);
});
