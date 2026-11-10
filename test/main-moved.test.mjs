import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { execFileSync } from 'node:child_process';
import { movedNote, movedSince } from '../lib/main-moved.mjs';
import { noteMainMoved } from '../lib/supervisor.mjs';
import { answerWakePrompt } from '../lib/wake.mjs';
import { readInbox } from '../lib/inbox.mjs';

// live run 2026-11-10: a fix landed on the main branch from outside turbo while a slot lane waited for the owner about
// the same failure; the owner answered «fix it» and the lane would have fixed it a second time on a stale base.

test('movedSince: the commits after the time, newest first, without turbo\'s own; [] when git fails', () => {
  const log = ['abc1234\tfix(agent): CB login gate', 'def5678\tdocs(turbo): owner answer ask-2 (phase 33)', '0a1b2c3\tMerge phase 32 (turbo lane 1)', '1122334\tchore(turbo): lean mode GSD settings', '5566778\tMerge main into turbo/p33 (turbo integrate)', '99aabbc\ttest(agent): CF gate'].join('\n');
  let seen = null;
  const git = (root, args) => { seen = args; return `${log}\n`; };
  assert.deepEqual(movedSince('/r', '2026-01-01T10:00:00.000Z', { git }), [{ sha: 'abc1234', subject: 'fix(agent): CB login gate' }, { sha: '99aabbc', subject: 'test(agent): CF gate' }]);
  assert.ok(seen.includes('--since=2026-01-01T10:00:00.000Z'));
  assert.deepEqual(movedSince('/r', 'x', { git: () => { throw new Error('not a git repository'); } }), []);
  // a real repository: a commit after the time is listed
  const repo = tmpGitRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'feat: a'], { cwd: repo });
  assert.deepEqual(movedSince(repo, '2000-01-01T00:00:00.000Z').map((c) => c.subject).slice(0, 1), ['feat: a']);
});

test('movedNote names the commits and says to take in the main branch first, in the project language', () => {
  const c = [{ sha: 'abc1234', subject: 'fix(agent): CB login gate' }];
  assert.match(movedNote(c, '33', 'en'), /^Since this phase asked the owner, the main branch got these commits \(newest first\): abc1234 fix\(agent\): CB login gate\. .*turbo-run integrate 33/);
  assert.match(movedNote(c, '33', 'ru'), /^С тех пор как фаза задала вопрос владельцу, в основную ветку пришли коммиты .*turbo-run integrate 33/);
});

test('noteMainMoved: a slot lane gets the note once per answer set; a checkout lane and an unmoved branch get none', () => {
  const root = tmpDir('moved');
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  const logs = [];
  const calls = [];
  const ctx = { root, config: { lang: 'en' }, deps: { log: (l) => logs.push(l), movedSince: (r, since) => { calls.push(since); return [{ sha: 'abc1234', subject: 'fix(agent): CB login gate' }]; } } };
  const ready = [{ id: 'ask-2', askedAt: '2026-01-01T10:05:00.000Z' }, { id: '33-01-t2', askedAt: '2026-01-01T10:00:00.000Z' }];
  const lane = { phase: '33', slotPath: '/slots/lane-1' };
  assert.equal(noteMainMoved(ctx, lane, ready, 'k1', '2026-01-01T11:00:00.000Z'), 1);
  assert.deepEqual(calls, ['2026-01-01T10:00:00.000Z'], 'from the earliest question');
  const notes = readInbox(root, '33').filter((m) => m.kind === 'note');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].by, 'turbo');
  assert.match(notes[0].text, /abc1234 fix\(agent\): CB login gate/);
  assert.equal(noteMainMoved(ctx, lane, ready, 'k1', '2026-01-01T11:01:00.000Z'), 0, 'the same answers: noted before');
  assert.equal(readInbox(root, '33').length, 1);
  assert.deepEqual(logs, ['phase 33: the main branch got 1 commit since its question; told in its inbox']);
  assert.equal(noteMainMoved(ctx, { phase: '33' }, ready, 'k2', '2026-01-01T11:00:00.000Z'), 0, 'checkout mode');
  const still = { ...ctx, deps: { ...ctx.deps, movedSince: () => [] } };
  assert.equal(noteMainMoved(still, { phase: '33', slotPath: '/s' }, ready, 'k3', '2026-01-01T11:00:00.000Z'), 0);
});

test('the answer wake prompt sends the lane to its inbox first when the main branch moved', () => {
  const p = answerWakePrompt({ phase: '33', turboRun: 'node x', lane: [{ id: 'ask-2', option: 1, label: 'Fix the login' }], moved: 2 });
  assert.match(p, /^First: the main branch got 2 commits since you asked the owner; run node x inbox 33 and read the note before you act on any answer below\. The owner answered the question you asked/);
  assert.doesNotMatch(answerWakePrompt({ phase: '33', turboRun: 'node x', ids: ['33-01-t2'] }), /^First:/);
});
