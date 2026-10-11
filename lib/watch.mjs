import { setTimeout as delay } from 'node:timers/promises';

// A terminal frame is drawn in place: cursor home, each line erased to its end, then the rest of the screen erased.
// Never ESC[2J, which pushes a whole screen into the scrollback of Windows Terminal on every frame.
export const HOME = '\x1b[H';
export const EOL = '\x1b[K';
export const EOS = '\x1b[J';

// A reader that went away (turbo-run status --watch | head) ends the watch quietly: exit 0, no stack. A closed pipe is
// EPIPE, or EOF on Windows; any other error of the stream still throws.
export function quietOnClosedPipe(stream, exit = (code) => process.exit(code)) {
  stream.on('error', (err) => {
    if (err?.code === 'EPIPE' || err?.code === 'EOF') exit(0);
    else throw err;
  });
}

// The footer under each frame, in the view's language (the config's lang).
const FOOTER = {
  en: { updated: (time, seconds) => `updated ${time} · every ${seconds} s · Ctrl+C stops`, error: (why) => `error: ${why}` },
  ru: { updated: (time, seconds) => `обновлено ${time} · каждые ${seconds} с · Ctrl+C — выход`, error: (why) => `ошибка: ${why}` },
};

// Redraws frame() every few seconds until the process is stopped (Ctrl+C): turbo-run status --watch, the live view
// for terminals without mods (spec §7). frame() returns { text, seconds, lang }; when it throws, its message becomes
// the frame and the loop keeps the last period and language. A terminal gets every frame drawn in place; a pipe, a
// file or Git Bash's mintty without ConPTY (not a TTY to Node) gets a frame only when the view changed, after a blank
// line.
export async function watch({ frame, write, tty, sleep = (ms) => delay(ms), now = () => new Date(), rounds = Infinity }) {
  let seconds = 3;
  let lang = 'en';
  let last = null;
  for (let i = 0; i < rounds; i++) {
    let text;
    try {
      const f = frame();
      ({ text, seconds } = f);
      if (f.lang) lang = f.lang;
    } catch (e) {
      text = (FOOTER[lang] ?? FOOTER.en).error(String(e?.message ?? e).replace(/\s*\r?\n\s*/g, ' '));
    }
    const body = `${text}\n${(FOOTER[lang] ?? FOOTER.en).updated(now().toTimeString().slice(0, 8), seconds)}`;
    if (tty) write(`${HOME}${body.split('\n').map((line) => `${line}${EOL}`).join('\n')}\n${EOS}`);
    else if (text !== last) write(`${last === null ? '' : '\n'}${body}\n`);
    last = text;
    if (i + 1 < rounds) await sleep(seconds * 1000);
  }
}
