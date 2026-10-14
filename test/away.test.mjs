import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DECISION_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { readQuestions, refreshQuestions, writeQuestions } from '../lib/questions.mjs';
import { answerQuestion, undoAutoAnswer } from '../lib/answers.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { autoAnswers, readAway } from '../lib/away-state.mjs';
import { backSummary, formatBack, gatherAhead, setAway } from '../lib/away.mjs';

const T0 = new Date('2026-01-01T22:00:00.000Z');
const later = (min) => new Date(T0.getTime() + min * 60000);
const PHASES = [
  { number: '31', complete: true, closed: false, deps: [] },
  { number: '32', complete: false, closed: false, deps: [] },
  { number: '33', complete: false, closed: false, deps: [] },
  { number: '34', complete: false, closed: false, deps: [] },
];
function project() {
  const root = tmpDir('away');
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN });
  writePhase(root, '33-dash', { '33-10-PLAN.md': VERIFY_PLAN.replace(/32-auth/g, '33-dash').replace('plan: 10', 'plan: 10') });
  writePhase(root, '34-more', { '34-01-PLAN.md': VERIFY_PLAN });
  return root;
}
const sup = (over = {}) => ({ lanes: { 1: { key: '1', job: 'phase', phase: '32', slot: 1, slotPath: 'C:/Users/dev/p.turbo/1', sessionId: 's1' } }, range: { from: '32', to: '33' }, ...over });

test('gatherAhead: the questions of every idle unfinished phase of the range are built from its plans; a running lane\'s and an existing file are left as they are', () => {
  const root = project();
  writeQuestions(root, '32', [{ id: '32-09-t2', phase: '32', plan: '32-09', task: '2', kind: 'decision', question: 'Kept', options: [], state: 'open', stopped: true, rev: 1, source: 'plan' }]);
  const list = gatherAhead({ root, phases: PHASES, sup: sup(), lang: 'en', now: T0 });
  assert.deepEqual(list.map((q) => [q.phase, q.id]), [['32', '32-09-t2'], ['33', '33-10-t3']]);
  assert.equal(readQuestions(root, '32')[0].question, 'Kept', 'the running lane\'s file is its own');
  assert.equal(readQuestions(root, '34').length, 0, 'outside the range');
  assert.equal(readQuestions(root, '33')[0].askedAt, T0.toISOString());
  const all = gatherAhead({ root, phases: PHASES, sup: { finished: true, range: { from: '32', to: '33' } }, lang: 'en', now: T0 });
  assert.ok(all.some((q) => q.phase === '34'), 'a finished run keeps no range');
});

test('setAway then backSummary: phases progressed, commits since, auto answers with undo (not the undone one), questions still waiting, failures; back clears the mode', () => {
  const root = project();
  refreshQuestions(root, '32', { now: T0 });
  refreshQuestions(root, '33', { now: T0 });
  const set = setAway(root, { phases: PHASES, now: T0 });
  assert.equal(set.since, T0.toISOString());
  assert.equal(readAway(root).since, T0.toISOString());
  assert.deepEqual(readAway(root).snapshot.phases['32'], { done: false, plans: 0 });
  // the night: phase 32 finished a plan, phase 33's verification was taken automatically, then one taken and undone
  fs.writeFileSync(path.join(root, '.planning', 'phases', '32-auth', '32-09-SUMMARY.md'), '# done\n');
  answerQuestion({ root, phase: '33', id: '33-10-t3', option: 1, by: 'auto', now: later(60), laneRunning: true, reason: 'no answer for 60 min' });
  answerQuestion({ root, phase: '32', id: '32-09-t2', option: 1, by: 'auto', now: later(61), laneRunning: true });
  undoAutoAnswer({ root, phase: '32', id: '32-09-t2', now: later(62), laneRunning: true });
  writeLaneStatus(root, '33', 'failed', { reason: 'its session failed', at: later(70).toISOString() });
  const commits = () => [{ sha: 'b2', at: later(80).toISOString(), subject: 'feat: night work' }, { sha: 'a1', at: later(-10).toISOString(), subject: 'feat: before' }];
  const s = backSummary({ root, phases: PHASES, sup: sup({ lanes: { 2: { key: '2', job: 'phase', phase: '33', slot: 2, slotPath: 'x' } } }), now: later(600), commits });
  assert.equal(s.wasAway, true);
  assert.deepEqual(s.progressed, [{ phase: '32', finished: false, before: 0, done: 1, total: 1 }]);
  assert.deepEqual(s.commits.map((c) => c.sha), ['b2']);
  assert.deepEqual(s.autoAnswered.map((a) => [a.phase, a.id, a.option, a.undo]), [['33', '33-10-t3', 'Accept if the checks pass', 'turbo-run answer 33 33-10-t3 --undo']]);
  assert.deepEqual(s.waiting.map((q) => q.id), ['32-09-t2']);
  assert.deepEqual(s.failures, [{ phase: '33', status: 'failed', reason: 'its session failed' }]);
  assert.equal(readAway(root).since, null);
  assert.equal(readAway(root).ackAt, later(600).toISOString());
  const text = formatBack(s, 'ru');
  assert.match(text, /^С возвращением! Вас не было с \d{4}-\d\d-\d\d \d\d:\d\d\.\n/);
  assert.match(text, /Фаза 32: планов готово 1 из 1 \(было 0\)/);
  assert.match(text, /Коммитов: 1/);
  assert.match(text, /Принято автоматически \(1\):\n {2}Проверка: .+ → Принять, если проверки прошли|Принято автоматически \(1\):\n {2}Verify: .+ → Accept if the checks pass/);
  assert.match(text, /отменить: turbo-run answer 33 33-10-t3 --undo/);
  assert.match(text, /Ждут вашего ответа \(1\)/);
  assert.match(text, /Сбои: фаза 33 — its session failed/);
  const again = backSummary({ root, phases: PHASES, sup: null, now: later(700), commits });
  assert.equal(again.wasAway, false);
  assert.equal(formatBack(again, 'en').split('\n')[0], 'Away mode was not on (turbo-run away --set turns it on).');
});

test('autoAnswers: standing auto answers newer than a time, newest first, with their question text', () => {
  const root = project();
  refreshQuestions(root, '32', { now: T0 });
  refreshQuestions(root, '33', { now: T0 });
  answerQuestion({ root, phase: '32', id: '32-09-t2', option: 1, by: 'auto', now: later(5), laneRunning: true });
  answerQuestion({ root, phase: '33', id: '33-10-t3', option: 1, by: 'session', now: later(6), laneRunning: true });
  assert.deepEqual(autoAnswers(root).map((a) => [a.id, a.question, a.option, a.at]), [['32-09-t2', 'Select the authentication provider', 'Clerk', later(5).toISOString()]]);
  assert.deepEqual(autoAnswers(root, { after: later(5).toISOString() }), []);
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'answers', 'p35.json'), 'broken');
  assert.equal(autoAnswers(root).length, 1, 'a broken file is none');
});

test('turbo-run away / away --set / back: the questions to answer before leaving, the mode on, the summary in the owner\'s language', async () => {
  const { runAwayCommand } = await import('../lib/away.mjs');
  const root = project();
  const lines = [];
  const deps = { loadPhases: () => PHASES, sup: null, config: { lang: 'ru', owner: { auto_answer_minutes: 60 } }, now: () => T0, commits: () => [] };
  const run = (cmd, args) => { lines.length = 0; const code = runAwayCommand(cmd, args, { root, out: (l) => lines.push(l), deps }); return { code, text: lines.join('\n') }; };
  let r = run('away', ['--json']);
  assert.deepEqual(JSON.parse(r.text).map((q) => q.id), ['32-09-t2', '33-10-t3', '34-01-t3']);
  r = run('away', []);
  assert.match(r.text, /^p32 32-09-t2 · decision · План 9, задача 2 ждёт вашего решения/m);
  r = run('away', ['--set']);
  assert.match(r.text, /безопасные вопросы turbo решит сам через 60 мин; когда вернётесь: turbo-run back$/);
  assert.equal(readAway(root).since, T0.toISOString());
  deps.config.owner.auto_answer_minutes = 0;
  assert.match(run('away', ['--set']).text, /автоответы выключены/);
  r = run('back', ['--json']);
  assert.equal(JSON.parse(r.text).wasAway, true);
  assert.match(run('back', []).text, /^Режим «ушёл» не был включён/);
});

test('bin: turbo-run away --set, status lists the mode and the auto answers, back clears it (no gsd-core: no phases loaded, a warning)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));
  const root = project();
  refreshQuestions(root, '32', { now: T0 });
  answerQuestion({ root, phase: '32', id: '32-09-t2', option: 1, by: 'auto', now: later(5), laneRunning: true });
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, 'no-claude') } });
  let r = run('away', '--set');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^away since .+; turbo takes the safe questions itself after 60 min; when you are back: turbo-run back/);
  assert.match(r.stderr, /gsd-core not found/);
  r = run('status');
  assert.match(r.stdout, /^away: since .+; when you are back: turbo-run back$/m);
  assert.match(r.stdout, /^auto-answered: phase 32 — Select the authentication provider → Clerk \(undo: turbo-run answer 32 32-09-t2 --undo\)$/m);
  r = run('back', '--json');
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual([s.wasAway, s.autoAnswered.map((a) => a.id)], [true, ['32-09-t2']]);
  r = run('status');
  assert.doesNotMatch(r.stdout, /^away:|^auto-answered:/m, 'seen on the way back');
});

test('review I5: the summary counts a lane the supervisor stopped alone, never a lane waiting for an answer; not away, only the news', () => {
  const root = project();
  setAway(root, { phases: PHASES, now: T0 });
  writeLaneStatus(root, '32', 'needs-owner', { reason: 'owner question 32-09-t2' });
  const s = backSummary({ root, phases: PHASES, sup: { lanes: { 1: { key: '1', job: 'phase', phase: '32' }, 2: { key: '2', job: 'phase', phase: '33', halted: { why: 'noProgress', at: T0.toISOString() } } } }, now: later(5), commits: () => [] });
  assert.deepEqual(s.failures, [{ phase: '33', status: 'stopped', reason: 'noProgress' }]);
  refreshQuestions(root, '32', { now: T0 });
  const off = backSummary({ root, phases: PHASES, sup: null, now: later(6), commits: () => [] });
  assert.equal(formatBack(off, 'en'), 'Away mode was not on (turbo-run away --set turns it on).', 'the waiting questions are the pane\'s');
});
