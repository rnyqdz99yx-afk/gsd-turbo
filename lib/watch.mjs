import { setTimeout as delay } from 'node:timers/promises';

// Clears a terminal and puts the cursor home before each frame.
export const CLEAR = '\x1b[2J\x1b[H';

// Redraws frame() every few seconds until the process is stopped (Ctrl+C): turbo-run status --watch, the live view
// for terminals without mods (spec §7). frame() returns { text, seconds }; when it throws, its message becomes the
// frame and the loop keeps the last period. A terminal is cleared before each frame; a pipe gets them one by one.
export async function watch({ frame, write, tty, sleep = (ms) => delay(ms), now = () => new Date(), rounds = Infinity }) {
  let seconds = 3;
  for (let i = 0; i < rounds; i++) {
    let text;
    try {
      ({ text, seconds } = frame());
    } catch (e) {
      text = `error: ${String(e?.message ?? e).replace(/\s*\r?\n\s*/g, ' ')}`;
    }
    write(`${tty ? CLEAR : i ? '\n' : ''}${text}\nupdated ${now().toTimeString().slice(0, 8)} · every ${seconds} s · Ctrl+C stops\n`);
    if (i + 1 < rounds) await sleep(seconds * 1000);
  }
}
