import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeSlot, gitIn } from './helpers/slots.mjs';
import { DECISION_PLAN, writePhase } from './helpers/plans.mjs';
import { readAnswers, refreshQuestions, withPhaseLock } from '../lib/questions.mjs';
import { answerQuestion, commitAnswerPaths, commitPendingAnswers } from '../lib/answers.mjs';
import { MergeLocked, mergeLockFile, withMergeLock } from '../lib/merge-lock.mjs';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const subject = (dir) => gitIn(dir, 'log', '-1', '--format=%s');
const files = (dir) => gitIn(dir, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n');
function lane() {
  const { control, slot } = fakeSlot();
  writePhase(slot, '32-auth', { '32-09-PLAN.md': DECISION_PLAN });
  refreshQuestions(slot, '32');
  return { control, slot };
}

test('an answer for a lane in a slot is committed in the control root, under the merge lock; the slot never holds it', () => {
  const { control, slot } = lane();
  const r = answerQuestion({ root: slot, phase: '32', id: '32-09-t2', option: 1, by: 'session', now: NOW });
  assert.deepEqual([r.status, r.commit], ['recorded', 'committed']);
  assert.equal(subject(control), 'docs(turbo): owner answer 32-09-t2 (phase 32)');
  assert.deepEqual(files(control), ['.planning/turbo/answers/.gitignore', '.planning/turbo/answers/p32.json']);
  assert.equal(fs.existsSync(path.join(slot, '.planning', 'turbo', 'answers')), false);
  assert.equal(fs.existsSync(mergeLockFile(control)), false, 'the lock is released');
  assert.equal(readAnswers(slot, '32')[0].label, 'Clerk');
});

test('main busy: the answer is recorded, not committed; commitPendingAnswers commits it later', () => {
  const { control, slot } = lane();
  const before = subject(control);
  fs.mkdirSync(path.dirname(mergeLockFile(control)), { recursive: true });
  fs.writeFileSync(mergeLockFile(control), 'held-by-a-merge');
  const r = answerQuestion({ root: slot, phase: '32', id: '32-09-t2', option: 1, by: 'session', now: NOW, commit: (paths, message) => commitAnswerPaths(slot, paths, message, { waitMs: 50 }) });
  assert.equal(r.status, 'recorded');
  assert.match(r.commit, /^not committed: main is busy: another turbo-run holds the merge lock \(merge\); try again$/);
  assert.equal(subject(control), before);
  fs.rmSync(mergeLockFile(control));
  assert.deepEqual(commitPendingAnswers(slot), { committed: true });
  assert.equal(subject(control), 'docs(turbo): owner answers');
  assert.deepEqual(commitPendingAnswers(slot), { committed: false, reason: 'no changes' });
});

test('withMergeLock: one writer at a time; a lock a crash left is taken over after its time; the phase lock still works', () => {
  const { control } = lane();
  assert.equal(withMergeLock(control, () => 'ran'), 'ran');
  assert.equal(fs.existsSync(mergeLockFile(control)), false);
  fs.writeFileSync(mergeLockFile(control), 'crashed');
  assert.throws(() => withMergeLock(control, () => 'no', { waitMs: 30 }), (e) => e instanceof MergeLocked);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(mergeLockFile(control), old, old);
  assert.equal(withMergeLock(control, () => 'taken over', { waitMs: 30 }), 'taken over');
  assert.equal(withPhaseLock(control, '32', () => 'phase'), 'phase');
});

test('withMergeLock: a live owner never loses the lock, however old; a dead owner\'s lock goes only after its time (I3)', () => {
  const { control } = lane();
  fs.mkdirSync(path.dirname(mergeLockFile(control)), { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.writeFileSync(mergeLockFile(control), '4242-11111111-2222-3333-4444-555555555555');
  fs.utimesSync(mergeLockFile(control), old, old);
  const seen = [];
  const live = (pid) => (seen.push(pid), true);
  assert.throws(() => withMergeLock(control, () => 'no', { waitMs: 30, alive: live }), (e) => e instanceof MergeLocked);
  assert.equal(seen[0], 4242, 'the owner pid is read from the lock token');
  assert.equal(fs.existsSync(mergeLockFile(control)), true);
  // the default check: this test's own process is alive
  fs.writeFileSync(mergeLockFile(control), `${process.pid}-11111111-2222-3333-4444-555555555555`);
  fs.utimesSync(mergeLockFile(control), old, old);
  assert.throws(() => withMergeLock(control, () => 'no', { waitMs: 30 }), (e) => e instanceof MergeLocked);
  // a dead owner, but a fresh lock: still waited on
  fs.writeFileSync(mergeLockFile(control), '4242-11111111-2222-3333-4444-555555555555');
  assert.throws(() => withMergeLock(control, () => 'no', { waitMs: 30, alive: () => false }), (e) => e instanceof MergeLocked);
  fs.utimesSync(mergeLockFile(control), old, old);
  assert.equal(withMergeLock(control, () => 'taken over', { waitMs: 30, alive: () => false }), 'taken over');
});
