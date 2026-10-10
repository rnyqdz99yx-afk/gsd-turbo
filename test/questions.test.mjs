import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN } from './helpers/plans.mjs';
import { parseCheckpoints } from '../lib/checkpoints.mjs';
import { maskSecrets } from '../lib/secrets.mjs';
import { buildQuestion, dynamicQuestion, questionId } from '../lib/questions.mjs';

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
