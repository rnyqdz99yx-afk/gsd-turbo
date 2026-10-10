import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { ACTION_PLAN, DECISION_PLAN, VERIFY_PLAN, writePhase } from './helpers/plans.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { readAnswers } from '../lib/questions.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';

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

test('two channels answer the same question at the same moment: one record, the other process reads already answered (Review Focus 1)', async () => {
  const root = project(tmpGitRepo());
  await run(root, ['questions', '32']);
  const CLI = path.resolve('bin/turbo-run.mjs');
  const answer = (k, by) => new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, 'answer', '32', '32-09-t2', '--option', String(k), '--by', by, '--project', root], { cwd: root, env: { ...process.env, TURBO_LANE: '' }, windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  const both = await Promise.all([answer(1, 'session'), answer(2, 'telegram')]);
  assert.deepEqual(both.map((x) => x.code).sort(), [0, 3], JSON.stringify(both));
  assert.equal(readAnswers(root, '32').length, 1);
});
