import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { laneRuns, runPhaseCommand } from '../lib/cli-phase.mjs';
import { readAnswers } from '../lib/questions.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';

const AG = 'a0123456789abcdef';
function project(root = tmpDir('cliq')) {
  writePhase(root, '32-auth', { '32-09-PLAN.md': DECISION_PLAN, '32-10-PLAN.md': VERIFY_PLAN, '32-11-PLAN.md': ACTION_PLAN });
  return root;
}
// a running supervisor with a lane: the lane commits the answers, so turbo-run answer does not
const withLane = (root) => writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), { lane: { phase: '32', sessionId: '1a2b3c4d' } });
async function run(root, args, deps = {}) {
  const lines = [];
  const code = await runPhaseCommand(args[0], args.slice(1), { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), deps: { env: {}, supervisorAlive: () => true, ...deps } });
  return { code, text: lines.join('\n'), lines };
}

test('turbo-run questions N builds and lists the questions with unclassified ones marked; --class classifies; --json prints the list', async () => {
  const root = project();
  let r = await run(root, ['questions', '32']);
  assert.equal(r.code, 0);
  assert.equal(r.lines[0], 'phase 32: 3 question(s) · 3 open · 0 answered · 0 deferred');
  assert.equal(r.lines[1], '  32-09-t2 · decision · open · unclassified · Select the authentication provider');
  r = await run(root, ['questions', '32', '--class', '32-09-t2=decision,32-10-t3=verify,32-11-t2=owner-only']);
  assert.match(r.text, /^ {2}32-10-t3 · human-verify · open · class verify · Verify: Dashboard layout/m);
  assert.ok(!r.text.includes('unclassified'));
  r = await run(root, ['questions', '32', '--json']);
  assert.deepEqual(JSON.parse(r.text).map((q) => q.id), ['32-09-t2', '32-10-t3', '32-11-t2']);
  r = await run(root, ['questions', '32', '--class', '32-09-t2=urgent']);
  assert.equal(r.code, 1);
  assert.match(r.text, /^ERR turbo-run questions: unknown class urgent/);
  assert.equal((await run(root, ['questions', '../x'])).code, 2);
});

test('turbo-run answer: recorded (0), already answered (3), refused (1), usage (2); a lane and its agents never answer (Review Focus 3)', async () => {
  const root = project();
  withLane(root);
  await run(root, ['questions', '32']);
  let r = await run(root, ['answer', '32', '32-09-t2', '--option', '1', '--by', 'session']);
  assert.equal(r.code, 0);
  assert.match(r.text, /^answered 32-09-t2: Clerk, session, \d{4}-/);
  r = await run(root, ['answer', '32', '32-09-t2', '--text', 'no, the other', '--by', 'pane']);
  assert.equal(r.code, 3);
  assert.match(r.text, /^already answered: Clerk, session, /);
  r = await run(root, ['answer', '32', '32-10-t3', '--text', `token ghp_${'a1B2'.repeat(9)}`, '--by', 'session']);
  assert.equal(r.code, 1);
  assert.match(r.text, /^refused: the answer looks like it contains a secret \(github token\)/);
  assert.ok(!r.text.includes('a1B2a1B2'));
  r = await run(root, ['answer', '32', '32-10-t3', '--option', '1', '--by', 'session'], { env: { TURBO_LANE: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.text, /^refused: a lane never answers the owner's questions/);
  for (const bad of [['--by', 'standing-rule', '--option', '1'], ['--option', '1'], ['--option', '0', '--by', 'session'], ['--option', '1', '--text', 'x', '--by', 'session'], ['--by', 'session'], ['--option', '1', '--by', 'pane', '--rev', '0']]) {
    assert.equal((await run(root, ['answer', '32', '32-10-t3', ...bad])).code, 2, bad.join(' '));
  }
  assert.equal(readAnswers(root, '32').length, 1);
});

test('turbo-run answer --rev: the revision the pane or Telegram showed; another one is exit 4 and records nothing', async () => {
  const root = project();
  withLane(root);
  await run(root, ['questions', '32']);
  await run(root, ['questions', '32', '--stop', '32-10-t3', '--agent', AG]); // rev 1 -> 2
  let r = await run(root, ['answer', '32', '32-10-t3', '--option', '1', '--by', 'pane', '--rev', '1']);
  assert.equal(r.code, 4);
  assert.equal(r.text, 'changed: question 32-10-t3 changed since it was shown (now rev 2, shown rev 1); read it again and answer the new version');
  assert.equal(readAnswers(root, '32').length, 0);
  r = await run(root, ['answer', '32', '32-10-t3', '--option', '1', '--by', 'pane', '--rev', '2']);
  assert.equal(r.code, 0);
  assert.match(r.text, /^answered 32-10-t3: Approved, pane, /);
  assert.equal((await run(root, ['answer', '32', '32-10-t3', '--text', 'late', '--by', 'telegram', '--rev', '1'])).code, 3, 'already answered comes first');
});

test('the lane\'s side: --preanswers, --stop, --deliver, --delivered; --open lists every phase\'s open questions', async () => {
  const root = project();
  withLane(root);
  await run(root, ['questions', '32']);
  await run(root, ['answer', '32', '32-09-t2', '--option', '1', '--by', 'session']);
  let r = await run(root, ['questions', '32', '--preanswers', '32-09']);
  assert.match(r.text, /^Owner pre-answers for plan 32-09 /);
  assert.equal((await run(root, ['questions', '32', '--preanswers', '32-10'])).text, '');
  r = await run(root, ['questions', '32', '--stop', '32-10-t3', '--agent', AG]);
  assert.equal(r.text, 'stopped: 32-10-t3 waits for the owner; stop for the owner with the reason: owner question 32-10-t3');
  r = await run(root, ['questions', '--open', '--json']);
  assert.deepEqual(JSON.parse(r.text).map((q) => [q.id, q.stopped]), [['32-10-t3', true], ['32-11-t2', false]]);
  assert.match((await run(root, ['questions', '--open'])).text, /^p32 32-10-t3 · human-verify · open \(stopped\) · unclassified · /);
  r = await run(root, ['questions', '32', '--stop', '32-09-t2', '--agent', AG]);
  assert.equal(r.text, 'answered: 32-09-t2; deliver it now (turbo-run questions 32 --deliver)');
  r = await run(root, ['questions', '32', '--deliver']);
  assert.match(r.text, new RegExp(`^32-09-t2 · plan 32-09 task 2 · agent ${AG}\\n {2}message: Owner's answer to your checkpoint \\(plan 32-09, task 2, checkpoint:decision\\): clerk \\(Clerk\\)\\.`));
  assert.equal(JSON.parse((await run(root, ['questions', '32', '--deliver', '--json'])).text)[0].agentId, AG);
  r = await run(root, ['questions', '32', '--delivered', '32-09-t2', '--path', 'same-agent']);
  assert.equal(r.text, '32-09-t2: delivered (same-agent)');
  assert.equal((await run(root, ['questions', '32', '--deliver'])).text, 'phase 32: nothing to deliver');
  assert.equal((await run(root, ['questions', '32', '--delivered', '32-09-t2', '--path', 'x'])).code, 1);
});

test('turbo-run questions --stop --unmet --question --context: a human action that failed its check after Done goes back to the owner with the lane\'s diagnosis', async () => {
  const root = project();
  withLane(root);
  await run(root, ['questions', '32']);
  await run(root, ['questions', '32', '--stop', '32-11-t2', '--agent', AG]);
  await run(root, ['answer', '32', '32-11-t2', '--option', '1', '--by', 'session']);
  await run(root, ['questions', '32', '--delivered', '32-11-t2', '--path', 'same-agent']);
  const r = await run(root, ['questions', '32', '--stop', '32-11-t2', '--agent', AG, '--unmet', '--question', 'Run Stop-Service demo-sync in an administrator terminal', '--context', 'The sync service still runs after the window closed.']);
  assert.equal(r.text, 'stopped: 32-11-t2 waits for the owner, its card in your words (diagnosis 1); stop for the owner with the reason: owner question 32-11-t2');
  const q = JSON.parse((await run(root, ['questions', '32', '--json'])).text).find((x) => x.id === '32-11-t2');
  assert.deepEqual([q.question, q.context, q.diagnosis, q.state], ['Action: Run Stop-Service demo-sync in an administrator terminal', 'The sync service still runs after the window closed.', 1, 'open']);
  await run(root, ['answer', '32', '32-11-t2', '--option', '1', '--by', 'session']);
  await run(root, ['questions', '32', '--delivered', '32-11-t2', '--path', 'same-agent']);
  const again = await run(root, ['questions', '32', '--stop', '32-11-t2', '--agent', AG, '--unmet', '--question', 'The service starts again by itself: tell me how to handle it', '--context', 'Stopped twice, running again both times.']);
  assert.equal(again.text, 'stopped: 32-11-t2 waits for the owner, its card in your words (diagnosis 2: the same failure again); stop for the owner with the reason: owner question 32-11-t2: <your diagnosis in one line>');
  await run(root, ['answer', '32', '32-11-t2', '--option', '1', '--by', 'session']);
  await run(root, ['questions', '32', '--delivered', '32-11-t2', '--path', 'same-agent']);
  const refused = await run(root, ['questions', '32', '--stop', '32-11-t2', '--agent', AG, '--unmet', '--question', 'Remove ./cache/sync.lock, then answer Done']);
  assert.equal(refused.code, 1);
  assert.match(refused.text, /^ERR turbo-run questions: the question holds the (?:file name|path) .*a command the owner runs goes in backticks\)$/);
});

// Runs bin/turbo-run.mjs with the given arguments at a moment both racers wait for: turbo-run's modules are loaded
// first, so the two answers meet at the lock, not at start-up.
const AT_BARRIER = `
import { fileURLToPath } from 'node:url';
const [bin, warm, at, ...args] = process.argv.slice(1);
await import(warm);
while (Date.now() < Number(at)) { /* the shared start */ }
process.argv = [process.execPath, fileURLToPath(bin), ...args];
await import(bin);
`;

test('two channels answer the same question at the same moment: one record, the other process reads already answered (Review Focus 1)', async () => {
  const root = project(tmpGitRepo());
  await run(root, ['questions', '32']);
  const bin = pathToFileURL(path.resolve('bin/turbo-run.mjs')).href;
  const warm = pathToFileURL(path.resolve('lib/cli-phase.mjs')).href;
  const at = String(Date.now() + 2500);
  const answer = (k, by) => new Promise((resolve) => {
    const args = ['--input-type=module', '-e', AT_BARRIER, bin, warm, at, 'answer', '32', '32-09-t2', '--option', String(k), '--by', by, '--project', root];
    const c = spawn(process.execPath, args, { cwd: root, env: { ...process.env, TURBO_LANE: '' }, windowsHide: true, timeout: 30000, killSignal: 'SIGKILL' });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  const both = await Promise.all([answer(1, 'session'), answer(2, 'telegram')]);
  assert.deepEqual(both.map((x) => x.code).sort(), [0, 3], JSON.stringify(both));
  assert.match(both.find((x) => x.code === 0).out, /^answered 32-09-t2: /);
  assert.match(both.find((x) => x.code === 3).out, /^already answered: /);
  assert.equal(readAnswers(root, '32').length, 1);
});

test('a deploy consent the standing rule answered and the executor reported unmet goes to the owner: no loop of standing-rule answers', async () => {
  const root = project();
  withLane(root);
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'config.json'), { autonomy: 'max', deploy: { command: 'd', snapshot: 's', health: 'h', rollback: 'r' } });
  await run(root, ['questions', '32']);
  assert.match((await run(root, ['questions', '32', '--class', '32-10-t3=consent:deploy'])).text, /32-10-t3 · human-verify · answered/);
  for (let i = 0; i < 3; i++) {
    const r = await run(root, ['questions', '32', '--stop', '32-10-t3', '--agent', AG, '--unmet']);
    assert.equal(r.text, 'stopped: 32-10-t3 waits for the owner; stop for the owner with the reason: owner question 32-10-t3', `stop ${i + 1}`);
  }
  assert.deepEqual(readAnswers(root, '32').map((r) => [r.by, Boolean(r.superseded)]), [['standing-rule', true]]);
});

test('turbo-run questions N warns about a plan whose name cannot make a question id, and lists the others', async () => {
  const root = project();
  writePhase(root, '32-auth', { '32-12 draft-PLAN.md': DECISION_PLAN });
  const r = await run(root, ['questions', '32']);
  assert.equal(r.code, 0);
  assert.match(r.text, /^ERR warn: plan 32-12 draft-PLAN\.md: its name cannot make a question id/m);
  assert.match(r.text, /^phase 32: 3 question\(s\)/m);
});

test('while a lane runs, an answer to another phase is not committed by turbo-run answer either: the lane commits the whole answers directory', async () => {
  const root = project(tmpGitRepo());
  writePhase(root, '33-mail', { '33-01-PLAN.md': DECISION_PLAN });
  withLane(root);
  await run(root, ['questions', '33']);
  const r = await run(root, ['answer', '33', '33-01-t2', '--option', '1', '--by', 'session']);
  assert.match(r.text, /^answered 33-01-t2: Clerk, session, \S+$/);
});

test('turbo-run questions --stop --unmet after the owner answered a deploy consent the rule had answered: the owner is asked again, the rule stays out', async () => {
  const root = project();
  withLane(root);
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'config.json'), { autonomy: 'max', deploy: { command: 'd', snapshot: 's', health: 'h', rollback: 'r' } });
  await run(root, ['questions', '32']);
  await run(root, ['questions', '32', '--class', '32-10-t3=consent:deploy']);
  await run(root, ['questions', '32', '--stop', '32-10-t3', '--agent', AG, '--unmet']);
  assert.equal((await run(root, ['answer', '32', '32-10-t3', '--text', 'deploy only after I check staging myself', '--by', 'session'])).code, 0);
  const r = await run(root, ['questions', '32', '--stop', '32-10-t3', '--agent', AG, '--unmet']);
  assert.match(r.text, /^stopped: 32-10-t3 waits for the owner/);
  assert.deepEqual(readAnswers(root, '32').map((x) => [x.by, Boolean(x.superseded)]), [['standing-rule', true], ['session', true]]);
});

test('turbo-run questions --stop at a checkpoint of a plan whose name cannot make a question id: refused with what the lane does, stop for the owner, never rename', async () => {
  const root = project();
  writePhase(root, '32-auth', { '32-12 draft-PLAN.md': DECISION_PLAN });
  const r = await run(root, ['questions', '32', '--stop', '32-12 draft-t2', '--agent', AG]);
  assert.equal(r.code, 1);
  assert.match(r.text, /^ERR turbo-run questions: not a question id: 32-12 draft-t2: .*stop for the owner.*never rename the plan file/);
});

test('during an attend sitting turbo-run answer commits the answer itself, also under a supervisor started meanwhile whose lane is the attended phase (S4 N2)', async () => {
  const root = project(tmpGitRepo());
  withLane(root);
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'p32-attend.json'), { phase: '32', at: '2026-01-01T10:00:00.000Z', sessionId: '1a2b3c4d' });
  await run(root, ['questions', '32']);
  const r = await run(root, ['answer', '32', '32-09-t2', '--option', '1', '--by', 'session']);
  assert.match(r.text, /^answered 32-09-t2: Clerk, session, \S+ · committed$/);
});

// v0.3.3: turbo-run ask (D2, D7) and owner-gaps (D6)
const ruConfig = (root) => writeJsonAtomic(path.join(root, '.planning', 'turbo', 'config.json'), { lang: 'ru' });
const ASK = ['ask', '32', '--question', 'Исправления готовы, живая проверка ещё не запускалась. Что дальше?', '--context', 'Ревью нашло новые мелочи в коде остановки.',
  '--option', 'Сначала исправить|Фаза исправит замечания ревью и потом запустит живую проверку.', '--option', 'Сразу живая проверка|Замечания останутся до проверки.', '--recommended', '2'];

test('turbo-run ask: the lane\'s question becomes an open owner question and the lane\'s needs-owner record; --json; a refusal exits 1 and writes nothing', async () => {
  const root = project();
  ruConfig(root);
  let r = await run(root, ASK);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.lines[0], 'asked: ask-1 waits for the owner; now end your turn (the lane status is needs-owner)');
  const [q] = JSON.parse((await run(root, ['questions', '--open', '--json'])).text).filter((x) => x.id === 'ask-1');
  assert.deepEqual(q.options.map((o) => [o.label, o.recommended]), [['Сразу живая проверка', true], ['Сначала исправить', false]]);
  assert.equal(q.context, 'Ревью нашло новые мелочи в коде остановки.');
  assert.equal(readLaneStatus(root, '32').reason, 'owner question ask-1');
  r = await run(root, ['ask', '32', '--action', 'Подключите телефон к компьютеру.', '--json']);
  assert.equal(JSON.parse(r.text).question.id, 'ask-2');
  assert.deepEqual(JSON.parse(r.text).superseded, ['ask-1']);
  r = await run(root, ['ask', '32', '--question', 'Fix WR-01 first?', '--option', 'a|b', '--option', 'c|d', '--recommended', '1']);
  assert.equal(r.code, 1);
  assert.match(r.text, /^ERR turbo-run ask: the question holds the finding code WR-01/);
  assert.equal(readLaneStatus(root, '32').reason, 'owner question ask-2', 'nothing written');
  assert.equal((await run(root, ['ask', '32', '--question', 'Что дальше?', '--option', 'нет разделителя', '--option', 'a|b', '--recommended', '1'])).code, 2);
  assert.equal((await run(root, ['ask', '32'])).code, 2);
});

test('turbo-run ask --about-review: a review that keeps finding edges in the same code adds the plain sentence and the live-check option', async () => {
  const root = tmpGitRepo();
  project(root);
  ruConfig(root);
  const file = path.join(root, '.planning', 'phases', '32-auth', '32-REVIEW.md');
  const rev = (title, file2 = 'src/stop.js') => `---\nstatus: issues_found\n---\n\n### WR-01: ${title}\n\n**File:** \`${file2}:10\`\n**Issue:** x\n`;
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  for (const t of ['Stop waits forever', 'Stop races the flush', 'Flush drops the last item']) {
    fs.writeFileSync(file, rev(t));
    git('add', '-A');
    git('commit', '-q', '-m', 'review');
  }
  let r = await run(root, [...ASK, '--about-review']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^review loop: 3 reviews in a row found new edges in the same code \(src\/stop\.js\); added the sentence and the option «Хватит шлифовать — живая проверка»$/m);
  const q = JSON.parse((await run(root, ['questions', '--open', '--json'])).text).find((x) => x.id === 'ask-1');
  assert.match(q.context, /^Ревью в третий раз подряд находит новые крайние случаи в том же коде: .* Ревью нашло новые мелочи в коде остановки\.$/);
  assert.deepEqual(q.options.map((o) => o.label), ['Сразу живая проверка', 'Сначала исправить', 'Хватит шлифовать — живая проверка']);
  fs.writeFileSync(file, rev('Bad header', 'src/http.js'));
  r = await run(root, [...ASK, '--about-review']);
  assert.match(r.text, /^review loop: none \(1 review round\)$/m);
  assert.equal(JSON.parse((await run(root, ['questions', '--open', '--json'])).text).find((x) => x.id === 'ask-2').options.length, 2);
});

test('turbo-run questions --deliver lists an answered lane question for the lane itself; --delivered --path lane; owner-gaps prints the planner paragraph', async () => {
  const root = project();
  ruConfig(root);
  await run(root, ASK);
  await run(root, ['answer', '32', 'ask-1', '--option', '2', '--by', 'pane']);
  let r = await run(root, ['questions', '32', '--deliver']);
  assert.match(r.text, /^ask-1 · your own question \(take it yourself, no agent\)\n {2}message: The owner's answer to the question you asked \(ask-1\): option 2, Сначала исправить — /);
  r = await run(root, ['questions', '32', '--delivered', 'ask-1', '--path', 'lane']);
  assert.equal(r.text, 'ask-1: delivered (lane)');
  fs.writeFileSync(path.join(root, '.planning', 'phases', '32-auth', '32-REVIEW.md'), '### WR-01: Stop waits forever\n\n**File:** `src/stop.js:3`\n**Issue:** the timer is never cleared.\n');
  r = await run(root, ['owner-gaps', '32', '--review', 'WR-01']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^Owner-chosen gaps: .* 1\. Code review finding WR-01 \(warning\) in src\/stop\.js: Stop waits forever\. \*\*Issue:\*\* the timer is never cleared\.$/);
  r = await run(root, ['owner-gaps', '32', '--review', 'WR-07']);
  assert.equal(r.code, 1);
  assert.match(r.text, /^ERR turbo-run owner-gaps: no finding WR-07 in REVIEW\.md/);
  assert.equal((await run(root, ['owner-gaps', '32'])).code, 1);
  assert.equal((await run(root, ['owner-gaps', '32', '--gap', 'x'])).code, 2);
});

test('review 1 (MAJOR 3): turbo-run ask takes the phase\'s own plan ids as plan ids; a range is no plan', async () => {
  const root = project();
  let r = await run(root, ['ask', '32', '--question', 'Plan 32-10 is done; what next?', '--option', 'Fix|a', '--option', 'Go|b', '--recommended', '1']);
  assert.equal(r.code, 1);
  assert.match(r.text, /holds the plan id 32-10/);
  r = await run(root, ['ask', '32', '--question', 'It takes 10-20 minutes; what next?', '--option', 'Fix|a', '--option', 'Go|b', '--recommended', '1']);
  assert.equal(r.code, 0, r.text);
});

test('review 1: ask refuses --about-review with --action up front; a --option that is another flag\'s value is no option', async () => {
  const root = project();
  assert.equal((await run(root, ['ask', '32', '--action', 'Plug the phone in.', '--about-review'])).code, 2);
  const r = await run(root, [...ASK, '--context', '--option']);
  assert.equal(r.code, 0, r.text);
  const q = JSON.parse((await run(root, ['questions', '--open', '--json'])).text).find((x) => x.id === 'ask-1');
  assert.equal(q.options.length, 2);
  assert.equal(q.context, '--option');
});

test('laneRuns: only v0.3\'s lane commits in this checkout; slots lanes never do, so the owner\'s answer is committed by turbo-run answer (Stage 4 L1, L0 D14)', () => {
  const root = project();
  const file = path.join(root, '.planning', 'turbo', 'run', 'supervisor.json');
  withLane(root);
  assert.equal(laneRuns(root, { supervisorAlive: () => true }), true);
  writeJsonAtomic(file, { lanesMode: 'slots', lanes: { 32: { key: '32', job: 'phase', phase: '32', slot: 1, slotPath: tmpDir('slot'), sessionId: '1a2b3c4d' } } });
  assert.equal(laneRuns(root, { supervisorAlive: () => true }), false);
});

test('v0.4.0: turbo-run answer N <id> --undo takes back an automatic answer (reopened, or noted when delivered); refused for another answer and inside a lane; ask --auto-ok marks a lane question', async () => {
  const root = project();
  await run(root, ['questions', '32']);
  const { answerQuestion } = await import('../lib/answers.mjs');
  answerQuestion({ root, phase: '32', id: '32-09-t2', option: 1, by: 'auto', laneRunning: true });
  answerQuestion({ root, phase: '32', id: '32-10-t3', option: 1, by: 'session', laneRunning: true });
  withLane(root);
  let r = await run(root, ['answer', '32', '32-09-t2', '--undo'], { env: { TURBO_LANE: '1' } });
  assert.equal(r.code, 1);
  assert.match(r.text, /^refused: a lane never answers/);
  r = await run(root, ['answer', '32', '32-09-t2', '--undo']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /^reopened 32-09-t2: the automatic answer \(Clerk\) is taken back; the question is open again/);
  r = await run(root, ['answer', '32', '32-10-t3', '--undo']);
  assert.equal(r.code, 1);
  assert.match(r.text, /^refused: question 32-10-t3 has no automatic answer to undo/);
  r = await run(root, ['answer', '32', '32-09-t2', '--undo', '--option', '1']);
  assert.equal(r.code, 2, 'undo takes no answer');
  r = await run(root, ['ask', '33', '--question', 'Keep the cache in memory?', '--option', 'Yes|Fast', '--option', 'No|Slow', '--recommended', '1', '--auto-ok', '--json']);
  assert.equal(JSON.parse(r.text).question.autoOk, true);
  r = await run(root, ['ask', '34', '--question', 'Keep the cache in memory?', '--option', 'Yes|Fast', '--option', 'No|Slow', '--recommended', '1', '--json']);
  assert.equal(JSON.parse(r.text).question.autoOk, false);
});

test('turbo-run questions N lists each answer with its channel and time, so an attended sitting sees what it takes ahead', async () => {
  const root = project();
  withLane(root);
  await run(root, ['questions', '32']);
  await run(root, ['answer', '32', '32-09-t2', '--option', '1', '--by', 'pane'], { now: () => new Date('2026-01-01T08:22:11Z') });
  const r = await run(root, ['questions', '32']);
  assert.match(r.text, /^ {2}32-09-t2 · decision · answered \(Clerk, pane, 2026-01-01T08:22:11\.000Z\) · unclassified · /m);
  assert.match(r.text, /^ {2}32-10-t3 · human-verify · open · /m);
  await run(root, ['answer', '32', '32-10-t3', '--by', 'session', '--text', 'looks right\n  ship it'], { now: () => new Date('2026-01-01T09:00:00Z') });
  assert.match((await run(root, ['questions', '32'])).text, /^ {2}32-10-t3 · human-verify · answered \(looks right ship it, session, 2026-01-01T09:00:00\.000Z\) · /m);
});
