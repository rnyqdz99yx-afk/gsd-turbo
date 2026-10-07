import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePhase, nextPhase, relaunchDecision, isFinished } from '../lib/scheduler.mjs';

const P = (number, deps = [], complete = false) => ({ number, deps, complete });
// checked off in the ROADMAP and fully implemented, but GSD reports it unfinished (verification stale)
const C = (number, deps = []) => ({ number, deps, complete: false, closed: true });

test('comparePhase orders decimals numerically', () => {
  const sorted = ['10', '2', '2.1', '2.10', '2.2', '1'].sort(comparePhase);
  assert.deepEqual(sorted, ['1', '2', '2.1', '2.2', '2.10', '10']);
});

test('comparePhase puts decimal sub-phases before letter-suffixed inserts, like GSD', () => {
  const sorted = ['3', '2A', '2', '2.1', '2B'].sort(comparePhase);
  assert.deepEqual(sorted, ['2', '2.1', '2A', '2B', '3']);
});

test('nextPhase picks lowest incomplete phase with satisfied deps', () => {
  const phases = [P('1', [], true), P('3', ['2']), P('2', ['1']), P('2.1', ['2'])];
  assert.equal(nextPhase(phases).number, '2');
});

test('deps outside the milestone count as satisfied', () => {
  assert.equal(nextPhase([P('5', ['0', '4'])]).number, '5');
});

test('nextPhase respects exclude and returns null when nothing is ready', () => {
  const phases = [P('1', [], true), P('2', ['1']), P('3', ['2'])];
  assert.equal(nextPhase(phases, { exclude: ['2'] }), null);
  assert.equal(nextPhase([P('1', [], true)]), null);
});

test('a closed phase is never started again and satisfies the deps on it', () => {
  assert.equal(nextPhase([C('1'), P('2', ['1']), P('3', ['2'])]).number, '2');
  assert.equal(nextPhase([C('1'), C('2', ['1'])]), null);
  assert.deepEqual([P('1', [], true), C('2'), P('3'), { number: '4', deps: [] }].map(isFinished), [true, true, false, false]);
});

test('relaunchDecision resets on progress and halts after max no-progress restarts', () => {
  assert.deepEqual(relaunchDecision({ restarts: 2, progressed: true, maxRestarts: 3 }), { action: 'relaunch', restarts: 0 });
  assert.deepEqual(relaunchDecision({ restarts: 0, progressed: false, maxRestarts: 3 }), { action: 'relaunch', restarts: 1 });
  assert.deepEqual(relaunchDecision({ restarts: 3, progressed: false, maxRestarts: 3 }), { action: 'halt', restarts: 4 });
});

// supervisor.json is hand-editable and resume rewrites the lane: a bad count must never
// make the no-progress bound disappear.
test('relaunchDecision: a missing or invalid count starts at 0; a missing or invalid limit halts', () => {
  for (const restarts of [undefined, null, NaN, 'x', -2]) {
    assert.deepEqual(relaunchDecision({ restarts, progressed: false, maxRestarts: 3 }), { action: 'relaunch', restarts: 1 }, String(restarts));
  }
  assert.deepEqual(relaunchDecision({ restarts: '2', progressed: false, maxRestarts: 3 }), { action: 'relaunch', restarts: 3 });
  assert.deepEqual(relaunchDecision({ restarts: 1.7, progressed: false, maxRestarts: 3 }), { action: 'relaunch', restarts: 2 });
  for (const maxRestarts of [undefined, NaN, 'x']) {
    assert.equal(relaunchDecision({ restarts: 0, progressed: false, maxRestarts }).action, 'halt', String(maxRestarts));
  }
});
