import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { answersRel, readAnswers, readQuestions, refreshQuestions } from '../lib/questions.mjs';
import { AnswerRefused, QuestionChanged, TEXT_MAX, answerQuestion, describeAnswer, secretRule } from '../lib/answers.mjs';

const NOW = new Date('2026-01-01T10:00:00.000Z');
function project({ git = false } = {}) {
  const root = git ? tmpGitRepo() : tmpDir('ans');
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN, '32-10-PLAN.md': VERIFY_PLAN, '32-11-PLAN.md': ACTION_PLAN });
  refreshQuestions(root, '32');
  return root;
}
const ask = (root, more) => answerQuestion({ root, phase: '32', now: NOW, laneRunning: true, ...more });
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof AnswerRefused && re.test(e.message));

test('the first answer wins: the record goes to the answers file and the question reads answered; a repeat gets the first one back', () => {
  const root = project();
  const r = ask(root, { id: '32-09-t2', option: 1, by: 'telegram' });
  assert.equal(r.status, 'recorded');
  assert.deepEqual(r.record, { id: '32-09-t2', plan: '32-09', task: '2', option: 1, label: 'Clerk', answer: 'clerk', by: 'telegram', at: NOW.toISOString(), conditional: true, condition: 'the checkpoint offers the options the plan lists', defer: false });
  assert.equal(r.commit, null);
  assert.deepEqual(readAnswers(root, '32'), [r.record]);
  const q = readQuestions(root, '32').find((x) => x.id === '32-09-t2');
  assert.deepEqual([q.state, q.answer.label, q.answer.by], ['answered', 'Clerk', 'telegram']);
  const again = ask(root, { id: '32-09-t2', option: 2, by: 'session' });
  assert.equal(again.status, 'already');
  assert.equal(describeAnswer(again.record), `Clerk, telegram, ${NOW.toISOString()}`);
  assert.equal(readAnswers(root, '32').length, 1);
});

test('"stop and show me" or "I will do it" is a preference, not an answer: the question reads deferred and keeps it', () => {
  const root = project();
  const r = ask(root, { id: '32-10-t3', option: 2, by: 'pane' });
  assert.deepEqual([r.record.defer, r.record.answer, r.record.conditional, r.record.condition], [true, null, false, null]);
  assert.equal(readQuestions(root, '32').find((x) => x.id === '32-10-t3').state, 'deferred');
  assert.equal(ask(root, { id: '32-10-t3', option: 1, by: 'session' }).status, 'already');
});

test('own words are kept as written (Russian, emoji, quotes, percent, new lines), control characters out; refused where only options count (Review Focus 4)', () => {
  const root = project();
  const words = 'Да, «Clerk» — но 100% с "SSO" 🙂\nи второй строкой';
  const r = ask(root, { id: '32-09-t2', text: `\u0007${words}\r\n\u0000 `, by: 'session' });
  assert.equal(r.record.answer, words);
  assert.deepEqual([r.record.option, r.record.label, r.record.conditional], [null, null, true]);
  assert.equal(describeAnswer(r.record).startsWith('Да, «Clerk»'), true);
  refused(() => ask(root, { id: '32-11-t2', text: 'I did it', by: 'session' }), /options only/);
});

test('refusals: a secret (never echoed), empty or too long words, an unknown question or option, a bad channel; nothing is recorded', () => {
  const root = project();
  const token = `ghp_${'a1B2'.repeat(9)}`;
  assert.equal(secretRule(`use ${token}`), 'github token');
  assert.equal(secretRule('plain words'), null);
  assert.throws(() => ask(root, { id: '32-09-t2', text: `use ${token}`, by: 'session' }),
    (e) => e instanceof AnswerRefused && /looks like it contains a secret \(github token\)/.test(e.message) && !e.message.includes(token));
  refused(() => ask(root, { id: '32-09-t2', text: ' \u0001 ', by: 'session' }), /empty/);
  refused(() => ask(root, { id: '32-09-t2', text: 'я'.repeat(TEXT_MAX + 1), by: 'session' }), new RegExp(`longer than ${TEXT_MAX}`));
  refused(() => ask(root, { id: '32-10-t3', option: 3, by: 'session' }), /no option 3; its options are 1 to 2/);
  refused(() => ask(root, { id: '32-99-t1', option: 1, by: 'session' }), /no question 32-99-t1 in phase 32/);
  refused(() => ask(root, { id: '32-10-t3', option: 1, by: 'email' }), /unknown channel email/);
  refused(() => ask(root, { id: '32-10-t3', option: 1, text: 'x', by: 'session' }), /exactly one/);
  assert.equal(readAnswers(root, '32').length, 0);
  assert.equal(ask(root, { id: '32-09-t2', text: 'я'.repeat(TEXT_MAX), by: 'session' }).status, 'recorded');
});

test('a channel that showed an older revision of the question records nothing; "already answered" comes first', () => {
  const root = project();
  // the plan is re-planned with other options: rev 1 -> 2
  const plan = path.join(root, '.planning', 'phases', '32-auth', '32-09-PLAN.md');
  fs.writeFileSync(plan, DECISION_PLAN.replace('<name>Clerk</name>', '<name>Clerk (hosted)</name>'));
  refreshQuestions(root, '32');
  assert.throws(() => ask(root, { id: '32-09-t2', option: 1, by: 'pane', rev: 1 }),
    (e) => e instanceof QuestionChanged && e instanceof AnswerRefused && e.message === 'question 32-09-t2 changed since it was shown (now rev 2, shown rev 1); read it again and answer the new version');
  assert.equal(readAnswers(root, '32').length, 0);
  assert.equal(ask(root, { id: '32-09-t2', option: 1, by: 'pane', rev: 2 }).status, 'recorded');
  assert.equal(ask(root, { id: '32-09-t2', option: 1, by: 'telegram', rev: 1 }).status, 'already');
  assert.equal(ask(root, { id: '32-10-t3', option: 1, by: 'session' }).status, 'recorded', 'no rev: no check');
});

test('with no lane running the answers file is committed at once; with a lane, the lane commits it; a failed commit keeps the answer', () => {
  const root = project({ git: true });
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-q', '-m', 'plans');
  const r = answerQuestion({ root, phase: '32', id: '32-09-t2', option: 1, by: 'session', now: NOW, laneRunning: false });
  assert.equal(r.commit, 'committed');
  assert.equal(git('log', '-1', '--format=%s').trim(), 'docs(turbo): owner answer 32-09-t2 (phase 32)');
  assert.equal(git('status', '--porcelain', '--', answersRel('32')), '');
  const lane = answerQuestion({ root, phase: '32', id: '32-10-t3', option: 1, by: 'session', now: NOW, laneRunning: true });
  assert.equal(lane.commit, null);
  assert.match(git('status', '--porcelain', '--', answersRel('32')), /p32\.json/);
  const failing = answerQuestion({ root, phase: '32', id: '32-11-t2', option: 1, by: 'session', now: NOW, laneRunning: false, commit: () => { throw new Error('index.lock exists'); } });
  assert.deepEqual([failing.status, failing.commit], ['recorded', 'not committed: index.lock exists']);
});
