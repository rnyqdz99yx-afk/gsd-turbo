import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EOL, EOS, HOME, quietOnClosedPipe, watch } from '../lib/watch.mjs';

test('a closed pipe ends the watch quietly with exit 0 (EPIPE on POSIX, EOF on Windows); other stream errors still throw', () => {
  const stream = new EventEmitter();
  const exits = [];
  quietOnClosedPipe(stream, (code) => exits.push(code));
  stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  stream.emit('error', Object.assign(new Error('write EOF'), { code: 'EOF' }));
  assert.deepEqual(exits, [0, 0]);
  assert.throws(() => stream.emit('error', Object.assign(new Error('disk on fire'), { code: 'EIO' })), /disk on fire/);
});

const NOW = () => new Date(2026, 0, 1, 10, 59, 58);

test('on a terminal every frame is drawn in place from the top, each line and the rest of the screen erased, never the whole screen (no scrollback flood)', async () => {
  const writes = [];
  const sleeps = [];
  let n = 0;
  await watch({ frame: () => ({ text: ++n === 1 ? 'frame 1\nsecond line' : 'frame 2', seconds: n === 1 ? 3 : 5 }), write: (s) => writes.push(s), tty: true, sleep: async (ms) => sleeps.push(ms), now: NOW, rounds: 3 });
  assert.deepEqual(writes, [
    `${HOME}frame 1${EOL}\nsecond line${EOL}\nupdated 10:59:58 · every 3 s · Ctrl+C stops${EOL}\n${EOS}`,
    `${HOME}frame 2${EOL}\nupdated 10:59:58 · every 5 s · Ctrl+C stops${EOL}\n${EOS}`,
    `${HOME}frame 2${EOL}\nupdated 10:59:58 · every 5 s · Ctrl+C stops${EOL}\n${EOS}`,
  ]);
  assert.equal(writes.some((w) => w.includes('\x1b[2J')), false);
  assert.deepEqual(sleeps, [3000, 5000]);
});

test('into a pipe (or mintty without ConPTY) a frame is printed only when the view changed, after a blank line, without escape codes', async () => {
  const writes = [];
  const texts = ['x', 'x', 'y', 'y'];
  let i = 0;
  await watch({ frame: () => ({ text: texts[i++], seconds: 3 }), write: (s) => writes.push(s), tty: false, sleep: async () => {}, now: NOW, rounds: 4 });
  assert.deepEqual(writes, ['x\nupdated 10:59:58 · every 3 s · Ctrl+C stops\n', '\ny\nupdated 10:59:58 · every 3 s · Ctrl+C stops\n']);
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
