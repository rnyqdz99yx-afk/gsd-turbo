import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLEAR, watch } from '../lib/watch.mjs';

const NOW = () => new Date(2026, 0, 1, 10, 59, 58);

test('on a terminal every frame clears the screen, ends with the time and the period, and the next one waits that long', async () => {
  const writes = [];
  const sleeps = [];
  let n = 0;
  await watch({ frame: () => ({ text: `frame ${++n}`, seconds: n === 1 ? 3 : 5 }), write: (s) => writes.push(s), tty: true, sleep: async (ms) => sleeps.push(ms), now: NOW, rounds: 3 });
  assert.deepEqual(writes, [
    `${CLEAR}frame 1\nupdated 10:59:58 · every 3 s · Ctrl+C stops\n`,
    `${CLEAR}frame 2\nupdated 10:59:58 · every 5 s · Ctrl+C stops\n`,
    `${CLEAR}frame 3\nupdated 10:59:58 · every 5 s · Ctrl+C stops\n`,
  ]);
  assert.deepEqual(sleeps, [3000, 5000]);
});

test('into a pipe the frames follow one another without escape codes', async () => {
  const writes = [];
  await watch({ frame: () => ({ text: 'x', seconds: 3 }), write: (s) => writes.push(s), tty: false, sleep: async () => {}, now: NOW, rounds: 2 });
  assert.deepEqual(writes, ['x\nupdated 10:59:58 · every 3 s · Ctrl+C stops\n', '\nx\nupdated 10:59:58 · every 3 s · Ctrl+C stops\n']);
});

test('a frame that throws shows its error on one line and the watch goes on at the last period', async () => {
  const writes = [];
  const sleeps = [];
  const frames = [() => ({ text: 'ok', seconds: 7 }), () => { throw new Error('invalid turbo config /p/config.json: Unexpected end\n  at x'); }, () => ({ text: 'ok again', seconds: 7 })];
  let i = 0;
  await watch({ frame: () => frames[i++](), write: (s) => writes.push(s), tty: false, sleep: async (ms) => sleeps.push(ms), now: NOW, rounds: 3 });
  assert.equal(writes[1], '\nerror: invalid turbo config /p/config.json: Unexpected end at x\nupdated 10:59:58 · every 7 s · Ctrl+C stops\n');
  assert.deepEqual(sleeps, [7000, 7000]);
  assert.match(writes[2], /^\nok again\n/);
});
