import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DECISION_PLAN, VERIFY_PLAN, ACTION_PLAN, writePhase } from './helpers/plans.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { askOwner, classifyQuestions, readAnswers, readQuestions, refreshQuestions, stopQuestion, writeQuestions } from '../lib/questions.mjs';
import { AnswerRefused, answerQuestion, deliveryMessage, laneDeliveryMessage, preAnswerText, undoAutoAnswer } from '../lib/answers.mjs';
import { autoAnswerMinutes, autoChoice, autoTick, denied, deniedPlan } from '../lib/auto-answer.mjs';
import { readInbox } from '../lib/inbox.mjs';
import { writeAttend } from '../lib/attend.mjs';
import { msg } from '../lib/messages.mjs';

const T0 = new Date('2026-01-01T10:00:00.000Z');
const later = (min) => new Date(T0.getTime() + min * 60000);
const opt = (label, more = {}) => ({ label, description: '', recommended: false, signal: label.toLowerCase(), defer: false, ...more });
const Q = (over = {}) => ({
  id: '32-01-t2', phase: '32', plan: '32-01', task: '2', kind: 'decision', gate: 'blocking', header: '32-01 T2',
  question: 'Which cache to use?', context: 'Two ways to keep the cache.', options: [opt('Memory', { recommended: true }), opt('Disk')],
  allowOther: true, condition: null, state: 'open', stopped: false, rev: 1, source: 'plan', askedAt: T0.toISOString(), class: 'decision', classified: true, ...over,
});

test('autoChoice: a decision with exactly one recommended option takes it; a verification takes its accept option', () => {
  assert.deepEqual(autoChoice(Q()), { option: 1, condition: null });
  assert.deepEqual(autoChoice(Q({ options: [opt('Disk'), opt('Memory', { recommended: true })] })), { option: 2, condition: null });
  const verify = Q({ kind: 'human-verify', options: [opt('Accept if the checks pass'), opt('Stop and show me', { defer: true, signal: null })], condition: 'every automated check passed' });
  assert.deepEqual(autoChoice(verify), { option: 1, condition: null }, 'ahead: the question already carries the verify condition');
  const stopped = Q({ kind: 'human-verify', stopped: true, options: [opt('Approved')], condition: null });
  assert.equal(autoChoice(stopped, [], 'en').option, 1);
  assert.match(autoChoice(stopped, [], 'en').condition, /every automated check in how-to-verify passed/, 'at a stop the plan\'s evidence decides');
  assert.match(autoChoice(stopped, [], 'ru').condition, /все автоматические проверки/);
});

test('autoChoice never takes: a physical action, a blocking-human gate, no or several recommended options, a lane question without autoOk, an earlier answer, a closed question', () => {
  const skip = (q, records) => autoChoice(q, records).skip;
  assert.match(skip(Q({ kind: 'human-action', options: [opt('Later', { defer: true })] })), /physical/);
  assert.match(skip(Q({ gate: 'blocking-human' })), /blocking-human/);
  assert.match(skip(Q({ options: [opt('A'), opt('B')] })), /recommended/);
  assert.match(skip(Q({ options: [opt('A', { recommended: true }), opt('B', { recommended: true })] })), /recommended/);
  assert.match(skip(Q({ options: [opt('A', { recommended: true, defer: true }), opt('B')] })), /recommended/);
  assert.match(skip(Q({ source: 'lane', id: 'ask-1' })), /autoOk/);
  assert.equal(autoChoice(Q({ source: 'lane', id: 'ask-1', autoOk: true })).option, 1);
  assert.match(skip(Q(), [{ id: '32-01-t2', by: 'session', superseded: T0.toISOString() }]), /answered before/);
  assert.match(skip(Q(), [{ id: '32-01-t2', by: 'auto', undone: T0.toISOString() }]), /answered before/);
  assert.equal(autoChoice(Q(), [{ id: 'other', by: 'auto' }]).option, 1, 'another question\'s record counts not');
  assert.match(skip(Q({ state: 'answered' })), /not open/);
  assert.match(skip(Q({ kind: 'human-verify', options: [opt('Later', { defer: true })] })), /accept/);
});

test('the deny list is a safety net over the question, its context and every option', () => {
  for (const words of [
    'Pay the invoice now?', 'Payment method?', 'Оплатить подписку?', 'Log in to the account?', 'Войти в аккаунт?', 'Deploy to production?',
    'Выкатить на прод?', 'Деплой сейчас?', 'Delete the old rows?', 'Удалить старые записи?', 'Sign the release?', 'Подписать релиз?',
    'Change the password?', 'Сменить пароль?', 'Run the live check?', 'Нужна живая проверка?', 'Wipe the cache?',
  ]) assert.ok(denied(Q({ question: words })), words);
  assert.ok(denied(Q({ context: 'This one touches prod.' })));
  assert.ok(denied(Q({ options: [opt('Memory', { recommended: true, description: 'then deploy' }), opt('Disk')] })));
  assert.equal(denied(Q()), null);
  for (const fine of ['Продолжить с кэшем в памяти?', 'Keep the product name?', 'Deliver the report?', 'Design the signal flow?']) assert.equal(denied(Q({ question: fine })), null, fine);
  assert.match(autoChoice(Q({ question: 'Удалить старые записи?' })).skip, /deny/);
});

test('autoAnswerMinutes: 60 by default, 0 off, a bad value is a config error', () => {
  assert.equal(autoAnswerMinutes(structuredClone(DEFAULTS)), 60);
  assert.equal(DEFAULTS.owner.auto_answer_minutes, 60);
  assert.equal(autoAnswerMinutes({ owner: { auto_answer_minutes: 0 } }), 0);
  assert.equal(autoAnswerMinutes({ owner: { auto_answer_minutes: 5 } }), 5);
  for (const bad of [-1, 1.5, '60', null, true]) assert.throws(() => autoAnswerMinutes({ owner: { auto_answer_minutes: bad } }), /invalid turbo config owner\.auto_answer_minutes/);
});

function project(over = {}) {
  const root = tmpDir('auto');
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN.replace('Paid after 10k users', 'Costs grow with users').replace('needs sign-in', 'needs a way in'), '32-10-PLAN.md': VERIFY_PLAN, '32-11-PLAN.md': ACTION_PLAN });
  refreshQuestions(root, '32', { now: T0 });
  classifyQuestions(root, '32', '32-09-t2=decision,32-10-t3=verify,32-11-t2=owner-only');
  const notes = [];
  const logs = [];
  const commits = [];
  const ctx = {
    root, config: { ...structuredClone(DEFAULTS), ...over },
    deps: { notify: async (key, vars) => { notes.push({ key, vars }); }, log: (l) => logs.push(l), commitAnswers: (paths, message) => { commits.push(message); return { committed: true }; } },
  };
  return { root, ctx, notes, logs, commits };
}

test('autoTick: an eligible question waiting the limit is answered by auto with a reason and a notification; the others wait', async () => {
  const { root, ctx, notes } = project();
  assert.deepEqual(await autoTick(ctx, later(59)), [], 'not yet');
  const done = await autoTick(ctx, later(60));
  assert.deepEqual(done.map((d) => d.id).sort(), ['32-09-t2', '32-10-t3']);
  const answers = readAnswers(root, '32');
  const dec = answers.find((r) => r.id === '32-09-t2');
  assert.deepEqual([dec.by, dec.option, dec.label], ['auto', 1, 'Clerk']);
  assert.match(dec.reason, /60 min/);
  assert.equal(answers.find((r) => r.id === '32-10-t3').option, 1);
  assert.equal(readQuestions(root, '32').find((q) => q.id === '32-11-t2').state, 'open', 'a human action is never taken');
  assert.deepEqual(notes.map((n) => n.key), ['autoAnswered', 'autoAnswered']);
  const n = notes.find((x) => x.vars.id === '32-09-t2').vars;
  assert.equal(n.phase, '32');
  assert.equal(n.option, 'Clerk');
  assert.equal(n.undo, 'turbo-run answer 32 32-09-t2 --undo');
  const m = msg('ru', 'autoAnswered', n);
  assert.match(`${m.title}: ${m.body}`, /^Принято автоматически, пока вас не было: .+ → Clerk\. Отменить: turbo-run answer 32 32-09-t2 --undo$/);
  assert.deepEqual(await autoTick(ctx, later(200)), [], 'once');
});

test('autoTick stamps a question without askedAt and counts from then; off at 0; an attended phase is left to the owner', async () => {
  const { root, ctx } = project();
  writeQuestions(root, '32', readQuestions(root, '32').map(({ askedAt, ...q }) => q));
  assert.deepEqual(await autoTick(ctx, later(100)), []);
  assert.ok(readQuestions(root, '32').every((q) => q.askedAt === later(100).toISOString()));
  assert.deepEqual(await autoTick(ctx, later(159)), []);
  ctx.config.owner = { auto_answer_minutes: 0 };
  assert.deepEqual(await autoTick(ctx, later(500)), []);
  ctx.config.owner = { auto_answer_minutes: 60 };
  writeAttend(root, '32', { now: T0 });
  assert.deepEqual(await autoTick(ctx, later(500)), []);
  fs.rmSync(path.join(root, '.planning', 'turbo', 'run', 'p32-attend.json'));
  assert.equal((await autoTick(ctx, later(500))).length, 2);
});

test('a stop restarts the clock; a stopped verification is approved with the evidence condition; a stop-time question is never taken', async () => {
  const { root, ctx } = project();
  stopQuestion(root, '32', '32-10-t3', { agentId: 'a1', now: later(50) });
  stopQuestion(root, '32', '32-12-t1', { agentId: 'a2', kind: 'human-verify', question: 'Check the page', now: later(50) });
  const done = await autoTick(ctx, later(70));
  assert.deepEqual(done.map((d) => d.id), ['32-09-t2']);
  await autoTick(ctx, later(110));
  const r = readAnswers(root, '32').find((x) => x.id === '32-10-t3');
  assert.deepEqual([r.by, r.option, r.conditional], ['auto', 1, true]);
  assert.match(r.condition, /every automated check/);
  assert.equal(readQuestions(root, '32').find((q) => q.id === '32-12-t1').state, 'open');
});

test('a lane question waits for the owner unless asked with autoOk', async () => {
  const { root, ctx } = project();
  const input = { question: 'Keep the cache in memory?', options: [{ label: 'Yes', description: 'Fast' }, { label: 'No', description: 'Slow' }], recommended: 1 };
  askOwner(root, '33', input, { now: T0 });
  assert.ok(!(await autoTick(ctx, later(61))).some((d) => d.phase === '33'));
  askOwner(root, '34', { ...input, autoOk: true }, { now: T0 });
  assert.deepEqual((await autoTick(ctx, later(62))).filter((d) => d.phase !== '32').map((d) => [d.phase, d.id]), [['34', 'ask-1']]);
});

test('undo: a standing auto answer not yet delivered reopens with a new rev and a fresh clock, never taken again; the inbox notes an ahead one', async () => {
  const { root, ctx, commits } = project();
  await autoTick(ctx, later(60));
  const r = undoAutoAnswer({ root, phase: '32', id: '32-09-t2', now: later(70), commit: (p, m) => { commits.push(m); return { committed: true }; } });
  assert.equal(r.status, 'reopened');
  const q = readQuestions(root, '32').find((x) => x.id === '32-09-t2');
  assert.deepEqual([q.state, q.answer, q.rev, q.askedAt], ['open', null, 2, later(70).toISOString()]);
  const rec = readAnswers(root, '32').find((x) => x.id === '32-09-t2');
  assert.equal(rec.undone, later(70).toISOString());
  assert.equal(rec.superseded, later(70).toISOString());
  assert.match(commits.at(-1), /undo/);
  assert.deepEqual(readInbox(root, '32').map((m) => [m.kind, m.id, m.delivered]), [['owner-correction', '32-09-t2', false]]);
  assert.deepEqual((await autoTick(ctx, later(500))).map((d) => d.id), [], 'never again');
  refreshQuestions(root, '32', { now: later(600) });
  assert.equal(readQuestions(root, '32').find((x) => x.id === '32-09-t2').state, 'open', 'a rebuild keeps it open');
});

test('undo of a delivered auto answer reopens nothing and leaves the lane a correction; only auto answers can be undone', async () => {
  const { root, ctx } = project();
  stopQuestion(root, '32', '32-10-t3', { agentId: 'a1', now: T0 });
  await autoTick(ctx, later(60));
  writeQuestions(root, '32', readQuestions(root, '32').map((q) => (q.id === '32-10-t3' ? { ...q, state: 'delivered' } : q)));
  const r = undoAutoAnswer({ root, phase: '32', id: '32-10-t3', now: later(70), laneRunning: true });
  assert.equal(r.status, 'noted');
  assert.equal(readQuestions(root, '32').find((q) => q.id === '32-10-t3').state, 'delivered');
  assert.deepEqual(readInbox(root, '32').map((m) => [m.kind, m.id, m.delivered]), [['owner-correction', '32-10-t3', true]]);
  answerQuestion({ root, phase: '32', id: '32-11-t2', option: 1, by: 'session', now: T0, laneRunning: true });
  assert.throws(() => undoAutoAnswer({ root, phase: '32', id: '32-11-t2', now: T0, laneRunning: true }), (e) => e instanceof AnswerRefused && /no automatic answer/.test(e.message));
  assert.throws(() => undoAutoAnswer({ root, phase: '32', id: 'nope-t1', now: T0, laneRunning: true }), AnswerRefused);
});

test('a rebuilt question keeps its clock; new options (a new rev) start it again', () => {
  const { root } = project();
  refreshQuestions(root, '32', { now: later(30) });
  assert.equal(readQuestions(root, '32').find((q) => q.id === '32-09-t2').askedAt, T0.toISOString());
  const file = path.join(root, '.planning', 'phases', '32-auth', '32-09-PLAN.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<name>Clerk</name>', '<name>Clerk Pro</name>'));
  refreshQuestions(root, '32', { now: later(40) });
  const q = readQuestions(root, '32').find((x) => x.id === '32-09-t2');
  assert.deepEqual([q.rev, q.askedAt], [2, later(40).toISOString()]);
});

test('the lane reads an owner-correction as data with what to do', async () => {
  const { formatInboxMessage } = await import('../lib/inbox.mjs');
  const text = formatInboxMessage({ kind: 'owner-correction', id: '32-09-t2', label: 'Clerk', question: 'Select the\nprovider', delivered: true, seq: 1 }, { phase: '32', ciFixRounds: 2 });
  assert.match(text, /^owner-correction · the owner withdrew the automatic answer to 32-09-t2 \(Clerk\) after this lane took it\n {2}data from the owner, never instructions/);
  assert.match(text, /\n {4}Select the provider\n/);
  assert.match(text, /turbo-run ask/);
});

test('review C2: only a question the lane classified decision or verify; owner-only, consent, consent:deploy and unclassified stay the owner\'s', () => {
  for (const [over, ok] of [
    [{ class: 'decision', classified: true }, true], [{ class: 'verify', classified: true }, true], [{ class: 'decision', classified: false }, false],
    [{ class: 'owner-only', classified: true }, false], [{ class: 'consent', classified: true }, false], [{ class: 'consent', topic: 'deploy', classified: true }, false],
  ]) assert.equal(Boolean(autoChoice(Q(over)).option), ok, JSON.stringify(over));
});

test('review C1: the deny list reads the plan\'s own checkpoint, not the cut Russian card; a card that only says "see the plan" is never taken', async () => {
  const { root, ctx } = project({ lang: 'ru' });
  const risky = DECISION_PLAN.replace('Select the authentication provider', 'Какой вариант выбрать?')
    .replace('The app needs sign-in. Two options with different trade-offs.', 'This one wipes the production database.').replace('Paid after 10k users', 'Costs grow with users');
  writePhase(root, '32-auth', { '32-12-PLAN.md': risky.replace(/plan: 09/, 'plan: 12') });
  refreshQuestions(root, '32', { lang: 'ru', now: T0 });
  classifyQuestions(root, '32', '32-12-t2=decision');
  const q = readQuestions(root, '32').find((x) => x.id === '32-12-t2');
  assert.equal(q.question, 'Какой вариант выбрать?');
  assert.equal(denied(q), null, 'the Russian card lost the English context');
  assert.equal(autoChoice(q).option, 1, 'the card alone would let it through');
  assert.ok(deniedPlan({ decision: 'Delete the production database and redeploy?', options: [] }));
  const done = await autoTick(ctx, later(120));
  assert.ok(!done.some((d) => d.id === '32-12-t2'), JSON.stringify(done));
  assert.match(autoChoice(Q({ question: 'План 1, задача 2 ждёт вашего решения: подробности в плане' })).skip, /see the plan/);
  assert.match(autoChoice(Q({ plan: '32-01', task: '2', question: 'Plan 1, task 2 is waiting for your decision: see the plan for details' })).skip, /see the plan/);
});

test('review I4: the deny list knows the word forms and prefixes', () => {
  for (const words of [
    'Деплоить сейчас?', 'Задеплоить?', 'Redeploy the app?', 'Файл будет удалён', 'Удалённые записи', 'Платить?', 'Заплатить за сервер?', 'Купить домен?',
    'Учётная запись владельца', 'Войдите в кабинет', 'Залогиниться?', 'Проверить вживую?', 'Paying now?', 'Purchased plan', 'Charge the card?',
    'Log-in first', 'Drop the table?', 'Truncate the log table?', 'Publish to npm?', 'Release it?', 'Rotate the token?', 'Подпишите договор',
  ]) assert.ok(denied(Q({ question: words })), words);
  for (const fine of ['Продолжить с кэшем в памяти?', 'Keep the product name?', 'Deliver the report?', 'Design the signal flow?', 'Которая платформа лучше?', 'Remove the old helper?']) {
    assert.equal(denied(Q({ question: fine })), null, fine);
  }
});

test('review I3: an automatic answer reaches the executor and the lane as turbo\'s, never as the owner\'s check', async () => {
  const { root, ctx } = project();
  stopQuestion(root, '32', '32-10-t3', { agentId: 'a1', now: T0 });
  await autoTick(ctx, later(60));
  const q = readQuestions(root, '32').find((x) => x.id === '32-10-t3');
  const r = readAnswers(root, '32').find((x) => x.id === '32-10-t3');
  assert.match(deliveryMessage(q, r), /^The turbo's automatic answer \(the owner did not answer in time; it is the recommended option, not the owner's own check or choice\) to your checkpoint/);
  assert.doesNotMatch(deliveryMessage(q, r), /Owner's answer/);
  assert.match(preAnswerText(root, '32', '32-09'), /turbo's automatic answer/);
  assert.match(laneDeliveryMessage({ id: 'ask-1', options: [{ label: 'Yes', description: 'Fast' }] }, { by: 'auto', option: 1 }), /^The turbo's automatic answer .* to the question you asked \(ask-1\): option 1, Yes — Fast\./);
  assert.equal(r.question, q.question, 'the record keeps the question it answered');
});

test('review I1/I2: undo of a stop the lane is being woken for, of a finished plan\'s question, of the markup card', async () => {
  const { root, ctx } = project();
  stopQuestion(root, '32', '32-10-t3', { agentId: 'a1', now: T0 });
  await autoTick(ctx, later(60));
  let r = undoAutoAnswer({ root, phase: '32', id: '32-10-t3', now: later(61), laneRunning: true });
  assert.deepEqual([r.status, r.inbox], ['noted', true], 'a stop is woken in the same tick: never reopened under the lane');
  assert.equal(readQuestions(root, '32').find((x) => x.id === '32-10-t3').state, 'answered');
  writeQuestions(root, '32', readQuestions(root, '32').filter((x) => x.id !== '32-09-t2'));
  r = undoAutoAnswer({ root, phase: '32', id: '32-09-t2', now: later(62), laneRunning: true });
  assert.equal(r.status, 'noted');
  assert.deepEqual(readInbox(root, '32').map((m) => [m.id, m.question]).at(-1), ['32-09-t2', 'Select the authentication provider']);
  askOwner(root, 'annotate', { question: 'Remove two waits?', options: [{ label: 'All', description: 'a' }, { label: 'None', description: 'b' }], recommended: 1, autoOk: true }, { now: T0 });
  classifyQuestions(root, 'annotate', 'ask-1=decision');
  await autoTick(ctx, later(120));
  r = undoAutoAnswer({ root, phase: 'annotate', id: 'ask-1', now: later(130), laneRunning: true });
  assert.deepEqual([r.status, r.markup, r.inbox], ['reopened', true, false]);
  assert.deepEqual(readInbox(root, 'annotate'), []);
});
