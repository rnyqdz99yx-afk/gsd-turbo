import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { ACTION_PLAN, DECISION_PLAN, OWNER_ACTION_PLAN, OWNER_CONTEXT_PLAN, OWNER_DECISION_PLAN, OWNER_VERIFY_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { parseCheckpoints } from '../lib/checkpoints.mjs';
import { maskSecrets } from '../lib/secrets.mjs';
import { completeStep, readProgress } from '../lib/phase-progress.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import {
  CLASSES, answersRel, buildQuestion, classifyQuestions, deliveryState, dynamicQuestion, liveAnswer, lockFile, markDelivered,
  questionId, questionsFile, readAnswers, readQuestions, refreshQuestions, stopQuestion, withPhaseLock, writeAnswers, writeQuestions,
  askOwner, dropLaneQuestions, jargonIn, laneQuestion,
} from '../lib/questions.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';

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

test('a human-action question: ahead only "I will do it when the phase asks", without own words; Done at the stop; class owner-only', () => {
  const ahead = buildQuestion(cpOf(ACTION_PLAN), { phase: '32', plan: '32-11' });
  assert.equal(ahead.question, 'Action: Complete the email verification for the mail service account');
  assert.equal(ahead.context, 'I created the account and asked for the verification mail. Click the link in it. The mail API key works: the test send succeeds');
  assert.deepEqual(ahead.options.map((o) => [o.label, o.signal, o.defer]), [['I will do it when the phase asks', null, true]]);
  assert.deepEqual([ahead.allowOther, ahead.condition, ahead.class, ahead.gate], [false, null, 'owner-only', 'blocking-human']);
  const stop = buildQuestion(cpOf(ACTION_PLAN), { phase: '32', plan: '32-11', stopped: true });
  assert.deepEqual(stop.options.map((o) => [o.label, o.signal]), [['Done', 'done']]);
  assert.equal(stop.allowOther, true);
});

test('Russian labels with lang ru; long texts cut after masking; secrets masked; header at most 12 characters', () => {
  const ru = buildQuestion(cpOf(VERIFY_PLAN), { phase: '32', plan: '32-10', lang: 'ru' });
  assert.deepEqual(ru.options.map((o) => o.label), ['Принять, если проверки прошли', 'Остановиться и показать мне']);
  assert.match(ru.question, /^Проверка: /);
  assert.equal(ru.condition, 'все автоматические проверки из плана прошли, и доказательства приложены');
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

test('the answers directory\'s .gitignore is put right when a crash left it empty or cut; a CRLF copy of the right one stays; nothing temporary is left there', () => {
  const { root } = project();
  const dir = path.join(root, '.planning', 'turbo', 'answers');
  const ignore = path.join(dir, '.gitignore');
  const RULE = '*\n!p*.json\n!.gitignore\n';
  fs.mkdirSync(dir, { recursive: true });
  for (const broken of ['', '*\n!p*']) {
    fs.writeFileSync(ignore, broken);
    writeAnswers(root, '32', []);
    assert.equal(fs.readFileSync(ignore, 'utf8'), RULE, JSON.stringify(broken));
  }
  fs.writeFileSync(ignore, RULE.replace(/\n/g, '\r\n'));
  writeAnswers(root, '32', []);
  assert.equal(fs.readFileSync(ignore, 'utf8'), RULE.replace(/\n/g, '\r\n'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.gitignore', 'p32.json']);
});

test('a rename of the answers .gitignore that Windows refuses a few times is retried; one that keeps failing never costs the answer: it is written, with a warning', () => {
  const { root } = project();
  const ignore = path.join(root, '.planning', 'turbo', 'answers', '.gitignore');
  const real = fs.renameSync;
  let refuse = 0;
  fs.renameSync = function (from, to, ...rest) {
    if (to === ignore && refuse > 0) {
      refuse -= 1;
      throw Object.assign(new Error('operation not permitted, rename'), { code: 'EPERM' });
    }
    return real.call(this, from, to, ...rest);
  };
  const warnings = [];
  try {
    refuse = 2;
    writeAnswers(root, '32', [], { warn: (l) => warnings.push(l) });
    assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n!p*.json\n!.gitignore\n');
    assert.deepEqual(warnings, []);
    fs.writeFileSync(ignore, '');
    refuse = Infinity;
    writeAnswers(root, '32', [{ id: '32-09-t2', answer: 'clerk' }], { warn: (l) => warnings.push(l) });
  } finally {
    fs.renameSync = real;
  }
  assert.deepEqual(readAnswers(root, '32').map((r) => r.answer), ['clerk']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^warn: \.planning\/turbo\/answers\/\.gitignore not written \(.*operation not permitted.*\); the answer is written all the same$/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.planning', 'turbo', 'run')).filter((n) => n.startsWith('answers-gitignore')), []);
});

// v0.3.3 owner stops: a lane's own question (D1, D2)
const RU_Q = 'Исправления готовы, живая проверка ещё не запускалась. Что делать дальше?';
const RU_OPTS = [
  { label: 'Сначала исправить замечания', description: 'Фаза исправит три новых замечания ревью и потом запустит проверку.' },
  { label: 'Сразу живая проверка', description: 'Замечания останутся; проверка покажет, мешают ли они.' },
];

test('a lane question: options in the given order with the recommended one moved first and marked, caps and masking like buildQuestion', () => {
  const q = laneQuestion({ phase: '32', id: 'ask-1', question: RU_Q, context: 'Ревью нашло новые мелочи.', options: RU_OPTS, recommended: 2, lang: 'ru' });
  assert.deepEqual([q.id, q.phase, q.plan, q.task, q.kind, q.class, q.classified, q.stopped, q.state, q.agentId, q.source, q.rev, q.allowOther, q.header], ['ask-1', '32', null, null, 'decision', 'decision', true, true, 'open', null, 'lane', 1, true, '']);
  assert.deepEqual(q.options.map((o) => [o.label, o.recommended, o.signal, o.defer]), [['Сразу живая проверка', true, 'Сразу живая проверка', false], ['Сначала исправить замечания', false, 'Сначала исправить замечания', false]]);
  assert.equal(q.question, RU_Q);
  const long = laneQuestion({ phase: '32', id: 'ask-2', question: 'я'.repeat(400), context: `ключ ghp_${'a1B2'.repeat(9)} ${'ж'.repeat(700)}`, options: [{ label: 'д'.repeat(100), description: 'о'.repeat(300) }, RU_OPTS[1]], recommended: 1, lang: 'ru' });
  assert.equal([...long.question].length, 300);
  assert.equal([...long.context].length, 600);
  assert.ok(!long.context.includes('a1B2a1B2'), 'masked');
  assert.equal([...long.options[0].label].length, 80);
  assert.equal([...long.options[0].description].length, 200);
});

test('a lane question is refused without 2-4 options, a recommended one, a question, or with a bare label', () => {
  const base = { phase: '32', id: 'ask-1', question: RU_Q, options: RU_OPTS, recommended: 1, lang: 'ru' };
  assert.throws(() => laneQuestion({ ...base, options: RU_OPTS.slice(0, 1) }), /2 to 4 options/);
  assert.throws(() => laneQuestion({ ...base, options: [...RU_OPTS, ...RU_OPTS, RU_OPTS[0]] }), /2 to 4 options/);
  assert.throws(() => laneQuestion({ ...base, recommended: null }), /--recommended/);
  assert.throws(() => laneQuestion({ ...base, recommended: 3 }), /--recommended/);
  assert.throws(() => laneQuestion({ ...base, question: '  ' }), /--question/);
  assert.throws(() => laneQuestion({ ...base, options: [{ label: '', description: 'x' }, RU_OPTS[1]] }), /label/);
});

test('owner text with turbo\'s or GSD\'s ids is refused; a Russian owner gets no bare English question', () => {
  const base = { phase: '32', id: 'ask-1', question: RU_Q, options: RU_OPTS, recommended: 1, lang: 'ru', planIds: ['32-46', '32-01'] };
  const bad = [
    ['Исправить WR-01..03 сначала?', /finding code WR-01/],
    ['Закрыть G-32-22?', /finding code G-32-22/],
    ['Закрыть LOOP8-WR-01?', /finding code LOOP8-WR-01/],
    ['Закрыть CR-2?', /finding code CR-2/],
    ['План 32-46 готов, что дальше?', /plan id 32-46/],
    ['Задача 32-01-t2 ждёт?', /question id 32-01-t2/],
    ['Ответ на ask-3 устарел?', /question id ask-3/],
    ['Коммит 7b65341 отправлен?', /commit hash 7b65341/],
    ['Поправить REVIEW.md?', /file name REVIEW\.md/],
    ['Поправить 32-REVIEW.md?', /file name 32-REVIEW\.md/],
    ['Поправить sync.js?', /file name sync\.js/],
    ['Поправить код в src/stop/flush?', /path src\/stop\/flush/],
  ];
  for (const [question, re] of bad) assert.throws(() => laneQuestion({ ...base, question }), re, question);
  assert.throws(() => laneQuestion({ ...base, options: [{ label: 'Фикс', description: 'Правка 32-01-t2' }, RU_OPTS[1]] }), /question id 32-01-t2/);
  const fine = ['5-10 минут', 'с 10:00-12:00', 'страница 3-14', 'версия 1.2-10', '10-20 минут', 'после COVID-19', 'хеш SHA-256', 'дата ISO-8601', 'по RFC-7231', 'на Node.js и Next.js', 'слово decade12 и facade1', '2026-10-13', 'UTF-8', 'CI зелёный', '32-47 (не план этой фазы)'];
  for (const t of fine) assert.doesNotThrow(() => laneQuestion({ ...base, question: 'Проверка: ' + t + '. Дальше?' }), t);
  assert.throws(() => laneQuestion({ ...base, question: 'gap loop 8 done; fix review warnings first?' }), /the question has no Russian word/);
  assert.throws(() => laneQuestion({ ...base, context: 'the review found edges' }), /the context has no Russian word/);
  assert.throws(() => laneQuestion({ ...base, options: [{ label: 'Fix first', description: 'Сначала исправить' }, RU_OPTS[1]] }), /option 1 has no Russian word/);
  assert.throws(() => laneQuestion({ phase: '32', id: 'ask-1', action: 'plug the phone in', lang: 'ru' }), /the question has no Russian word/, 'the action itself, not turbo\'s prefix');
  assert.doesNotThrow(() => laneQuestion({ ...base, options: [{ label: 'OK — 42', description: 'Сразу' }, RU_OPTS[1]] }), 'an option with a Russian description');
  assert.doesNotThrow(() => laneQuestion({ ...base, lang: 'en', question: 'The fixes are in; what next?', options: [{ label: 'Fix first', description: 'x' }, { label: 'Live check', description: 'y' }] }));
});

test('an owner-only action is a card with turbo\'s two options in the owner\'s language: done, or later', () => {
  const ru = laneQuestion({ phase: '32', id: 'ask-1', action: 'Подключите телефон к компьютеру и разблокируйте его.', lang: 'ru' });
  assert.deepEqual([ru.kind, ru.class, ru.allowOther], ['human-action', 'owner-only', true]);
  assert.equal(ru.question, 'Нужно от вас: Подключите телефон к компьютеру и разблокируйте его.');
  assert.deepEqual(ru.options.map((o) => [o.label, o.recommended]), [['Сделано', false], ['Сделаю позже', false]]);
  const en = laneQuestion({ phase: '32', id: 'ask-1', action: 'Plug the phone in.', lang: 'en' });
  assert.deepEqual(en.options.map((o) => o.label), ['Done', 'I will do it later']);
  assert.throws(() => laneQuestion({ phase: '32', id: 'ask-1', action: 'x', options: RU_OPTS, recommended: 1, lang: 'en' }), /--action takes no --option/);
});

test('askOwner: the next ask id after the questions and the answers file, the older open lane question superseded, the needs-owner record written', () => {
  const root = tmpDir('ask');
  fs.mkdirSync(path.join(root, '.planning'));
  writeAnswers(root, '32', [{ id: 'ask-4', option: 1, label: 'x', answer: 'x', by: 'session', at: '2026-01-01T00:00:00.000Z' }]);
  const now = new Date('2026-02-01T00:00:00Z');
  const first = askOwner(root, '32', { question: RU_Q, options: RU_OPTS, recommended: 1 }, { lang: 'ru', now });
  assert.equal(first.question.id, 'ask-5');
  assert.deepEqual(first.superseded, []);
  assert.deepEqual(readLaneStatus(root, '32'), { phase: '32', status: 'needs-owner', reason: 'owner question ask-5', sessionId: '', at: now.toISOString() });
  const second = askOwner(root, '32', { action: 'Подтвердите вход кодом из СМС.' }, { lang: 'ru', now });
  assert.equal(second.question.id, 'ask-6');
  assert.deepEqual(second.superseded, ['ask-5']);
  assert.deepEqual(readQuestions(root, '32').map((q) => q.id), ['ask-6']);
  assert.throws(() => askOwner(root, '32', { question: 'plain english only', options: RU_OPTS, recommended: 1 }, { lang: 'ru', now }), /no Russian word/);
  assert.deepEqual(readQuestions(root, '32').map((q) => q.id), ['ask-6'], 'a refusal writes nothing');
});

test('a lane question survives refreshQuestions until delivered; once answered it is ready without an agent and is delivered on the lane path only', () => {
  const root = tmpDir('askd');
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN });
  refreshQuestions(root, '32');
  askOwner(root, '32', { question: RU_Q, options: RU_OPTS, recommended: 1 }, { lang: 'ru' });
  assert.deepEqual(refreshQuestions(root, '32').map((q) => q.id), ['32-09-t2', 'ask-1']);
  assert.deepEqual(deliveryState(root, '32').waiting.map((q) => q.id), ['ask-1']);
  answerQuestion({ root, phase: '32', id: 'ask-1', option: 2, by: 'pane', laneRunning: true });
  assert.equal(refreshQuestions(root, '32').find((q) => q.id === 'ask-1').state, 'answered');
  assert.deepEqual(deliveryState(root, '32').ready.map((q) => q.id), ['ask-1']);
  assert.throws(() => markDelivered(root, '32', 'ask-1', 'same-agent'), /lane question ask-1 is delivered on the lane path/);
  assert.throws(() => markDelivered(root, '32', '32-09-t2', 'lane'), /only a lane question/);
  assert.equal(markDelivered(root, '32', 'ask-1', 'lane').delivery.path, 'lane');
  assert.deepEqual(refreshQuestions(root, '32').map((q) => q.id), ['32-09-t2'], 'delivered: gone from the questions, kept in the answers');
  assert.equal(readAnswers(root, '32').at(-1).id, 'ask-1');
});

test('review 1 (MAJOR 1): dropLaneQuestions removes the lane questions not yet delivered, checkpoints stay; deliveryState with ask counts only the named lane question', () => {
  const root = tmpDir('askdrop');
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN });
  refreshQuestions(root, '32');
  askOwner(root, '32', { action: 'Plug the phone in.' }, { lang: 'en' });
  assert.deepEqual(deliveryState(root, '32', { ask: 'ask-9' }).waiting, []);
  assert.deepEqual(deliveryState(root, '32', { ask: 'ask-1' }).waiting.map((q) => q.id), ['ask-1']);
  assert.deepEqual(deliveryState(root, '32').waiting.map((q) => q.id), ['ask-1'], 'without ask: as before');
  assert.deepEqual(dropLaneQuestions(root, '32'), ['ask-1']);
  assert.deepEqual(readQuestions(root, '32').map((q) => q.id), ['32-09-t2']);
  assert.deepEqual(dropLaneQuestions(root, '32'), []);
});

test('review 2: «and/or», «on/off», «yes/no», «read/write», CI/CD, dates and URLs are plain; real paths are refused', () => {
  const base = { phase: '32', id: 'ask-1', question: RU_Q, options: RU_OPTS, recommended: 1, lang: 'ru' };
  for (const t of ['и and/or', 'режим on/off', 'ответ yes/no', 'права read/write', 'CI/CD', '13/10/2026', 'страница https://example.com/login', 'адрес http://localhost:3000/a/b.js']) {
    assert.equal(jargonIn(t), null, t);
    assert.doesNotThrow(() => laneQuestion({ phase: '32', id: 'ask-1', action: `Войдите: ${t}`, lang: 'en' }), t);
  }
  for (const [t, re] of [['файл lib/foo.mjs', /lib\/foo\.mjs|foo\.mjs/], ['файл src/a/b.ts', /src\/a\/b\.ts|b\.ts/], ['запустите ./x', /path \.\/x/], ['в ../tools/run', /path \.\.\/tools\/run/], ['папка src/a/b', /path src\/a\/b/], ['папка lib/my_util', /path lib\/my_util/]]) {
    assert.throws(() => laneQuestion({ ...base, question: `Проверить ${t}?` }), re, t);
  }
});

// Owner cards from plans written for a Russian owner (synthetic fixtures): the owner's words only, never the
// executor's lines, a tag, a fence or bold markers.
const PLAN_IDS = ['32-12', '32-13', '32-14', '32-15'];
const card = (text, plan, more = {}) => buildQuestion(cpOf(text), { phase: '32', plan, lang: 'ru', planIds: PLAN_IDS, ...more });
function assertOwnerText(q) {
  for (const t of [q.question, q.context]) {
    assert.doesNotMatch(t, /<\/?[a-z][\w-]*>|\*\*|`{3}|\bExecutor\b|before presenting|\bpresent\b|\bverify 1\b/i, t);
  }
}

test('owner card, human-verify: the verdict\'s first sentence is the question; the rest of the owner block and the steps are the context', () => {
  const q = card(OWNER_VERIFY_PLAN, '32-12');
  assert.equal(q.question, 'Проверка: проверил пакет библиотеки картинок, ничего не устанавливая.');
  assert.equal(q.context, 'Что получилось: Контрольная сумма архива совпадает с реестром: <да/нет>. Что не сделано: ничего не установлено, файлы проекта не менялись. Что решаем: ставить ли эту версию библиотеки. 1. Открой страницу пакета в реестре — там ссылка на официальный репозиторий. 2. В сводке выше сверка контрольной суммы — «да».');
  assertOwnerText(q);
  assert.deepEqual([q.id, q.rev, q.options.map((o) => o.signal)], ['32-12-t1', 1, ['approved', null]]);
});

test('owner card, human-action: the task name is the question, never the executor\'s action; executor lines and English-only lines are left out', () => {
  const q = card(OWNER_ACTION_PLAN, '32-13');
  assert.equal(q.question, 'Действие: Владелец — создать тестового пользователя Windows и один раз войти в него');
  assert.equal(q.context, 'Что получилось: пробная сборка готова и прошла все проверки сборки. Твои данные не трогались. Что нужно от тебя (5 минут): 1. Открой PowerShell от имени администратора. 2. Вставь и выполни: `powershell -File C:\\Users\\dev\\smoke\\create-user.ps1`. 3. Войди в нового пользователя один раз и вернись.');
  assertOwnerText(q);
  assert.ok(!/Get-LocalUser|Claude checks|administrator\b/.test(q.question + q.context));
  // a «Коротко» line in the owner block is the question
  const short = card(OWNER_ACTION_PLAN.replace('    **Что получилось:** пробная', '    **Коротко:** нужен отдельный пользователь для проверки.\n    **Что получилось:** пробная'), '32-13');
  assert.equal(short.question, 'Действие: нужен отдельный пользователь для проверки.');
  assert.match(short.context, /^Что получилось: пробная сборка/);
});

test('owner card, decision with options: the decision is the question, the context as written, the options as before; the action never shows', () => {
  const q = card(OWNER_DECISION_PLAN, '32-14');
  assert.equal(q.question, 'Где хранить превью картинок?');
  assert.equal(q.context, 'Превью сейчас лежат рядом с оригиналами и занимают много места. Выбор нужен до следующего шага.');
  assert.deepEqual(q.options.map((o) => [o.label, o.signal]), [['a — на локальном диске', 'a'], ['b — в облаке', 'b']]);
  assertOwnerText(q);
  const named = card(OWNER_DECISION_PLAN.replace(/ *<decision>.*<\/decision>\n/, ''), '32-14');
  assert.equal(named.question, 'Владелец выбирает, где хранить превью картинок', 'no <decision>: the task name');
});

test('owner card, decision whose owner text is in <context> after the executor\'s preparation: only the text after the owner line', () => {
  const q = card(OWNER_CONTEXT_PLAN, '32-15');
  assert.equal(q.question, 'Включать ли сжатие картинок при загрузке?');
  assert.equal(q.context, 'Коротко: сжатие картинок можно включить — проба на этом компьютере прошла. Нужно твоё решение, потому что это меняет правило «оригиналы не трогать». Что получилось: Проба сжала сто картинок без видимой потери качества. Что решить: a (рекомендую) — включить сжатие. b — оставить как есть.');
  assertOwnerText(q);
  // no owner line: the executor's lines and the lines indented under them are left out all the same
  const noIntro = card(OWNER_CONTEXT_PLAN.replace(/ *The text for the owner .*\n/, ''), '32-15');
  assert.match(noIntro.context, /^Коротко: сжатие картинок можно включить/);
  assertOwnerText(noIntro);
  const noDecision = card(OWNER_CONTEXT_PLAN.replace(/ *<decision>.*<\/decision>\n/, ''), '32-15');
  assert.equal(noDecision.question, 'сжатие картинок можно включить — проба на этом компьютере прошла.');
});

test('owner card: text that fails the plain-words check falls back to the task name, then to a generic sentence in the card\'s language', () => {
  const plan = VERIFY_PLAN.replace('<task type="checkpoint:human-verify" gate="blocking">', '<task type="checkpoint:human-verify" gate="blocking">\n  <name>Task 3: Проверить вывод gallery.mjs</name>')
    .replace(/<what-built>.*<\/what-built>/, '<what-built>Обновлён gallery.mjs по плану 32-10.</what-built>');
  const ru = buildQuestion(cpOf(plan), { phase: '32', plan: '32-10', lang: 'ru', planIds: ['32-10'] });
  assert.equal(ru.question, 'Проверка: План 10, задача 3 ждёт вашего решения: подробности в плане');
  assert.equal(ru.context, '', 'English steps are no Russian owner text');
  const en = buildQuestion(cpOf(plan), { phase: '32', plan: '32-10', lang: 'en', planIds: ['32-10'] });
  assert.equal(en.question, 'Verify: Plan 10, task 3 is waiting for your decision: see the plan for details');
  assert.match(en.context, /^Visit http:\/\/localhost:3000\/dashboard and check: 1\. Sidebar left 2\. No horizontal scroll$/);
  const named = buildQuestion(cpOf(plan.replace('Проверить вывод gallery.mjs', 'Проверить вывод галереи')), { phase: '32', plan: '32-10', lang: 'ru', planIds: ['32-10'] });
  assert.equal(named.question, 'Проверка: Проверить вывод галереи');
});

test('owner cards: a re-extraction with new text keeps the id, the rev and the answer already given', () => {
  const root = tmpDir('cards');
  writePhase(root, '32-auth', { '32-15-PLAN.md': OWNER_CONTEXT_PLAN, '32-12-PLAN.md': OWNER_VERIFY_PLAN });
  refreshQuestions(root, '32', { lang: 'ru' });
  // the questions file as an older turbo wrote it: the plumbing text, the same options
  const old = readQuestions(root, '32').map((q) => ({ ...q, question: `${q.question} </action> <what-built>`, context: 'Executor preparation, before presenting; no file changes:' }));
  writeQuestions(root, '32', old);
  owner(root, '32-15-t2', { option: 1 });
  const list = refreshQuestions(root, '32', { lang: 'ru' });
  const d = list.find((q) => q.id === '32-15-t2');
  assert.deepEqual([d.rev, d.state, d.answer.label], [1, 'answered', 'a — включить сжатие']);
  assert.match(d.context, /^Коротко: /);
  assert.deepEqual(list.map((q) => [q.id, q.rev]), [['32-12-t1', 1], ['32-15-t2', 1]]);
});
