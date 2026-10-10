// turbo-view: the gsd-turbo live view (spec §7). A thin shell over view-model.mjs: it finds the project's
// .planning/turbo/, reads `turbo-run view --json` on a clock, draws the pane and the band above the prompt, shows
// toasts, and sends pane answers to `turbo-run answer … --by pane --rev <n>`. Module state is lost on a reload; the
// next read rebuilds it.
import { BACKGROUND_MS, NO_FIELD, PANE_ID, PANE_TITLE, afterAnswer, ancestorDirs, answerArgv, bandLine, firstLine, joinPath, keepDraft, openField, parseView, refreshMs, render, shouldAutoOpen, toastsFor, turboRunPath } from './view-model.mjs';

const VIEW_TIMEOUT_MS = 10000;
const ANSWER_TIMEOUT_MS = 30000;
const TOAST_MS = 8000;
const TONES = { title: { bold: true }, normal: {}, dim: { dimColor: true }, warn: { color: 'yellow' }, error: { color: 'red' } };

let root = null; // the project directory whose .planning/ holds turbo/, or null
let bin = null; // turbo-run.mjs
let view = null; // the last view read
let error = null; // why the last read failed
let busy = false; // a read is running
let again = false; // a forced read was asked for while one was running
let timer = null;
let period = 0;
let opened = false; // the pane was opened once in this module's life; the clock never reopens a closed pane
// The "Other…" field (view-model.mjs): every read redraws the pane, so what is typed is kept here and drawn back.
let field = NO_FIELD;
const sending = new Set(); // questions with an answer on its way

// The first directory up from the session's that has .planning/ (the project turbo-run finds), if it has turbo/.
async function locate($) {
  root = null;
  for (const dir of ancestorDirs(await $.session.cwd())) {
    if (!(await $.fs.exists(joinPath(dir, '.planning')))) continue;
    if (await $.fs.exists(joinPath(dir, '.planning', 'turbo'))) root = dir;
    return;
  }
}

async function findBin($) {
  return turboRunPath({ bin: await $.env.get('TURBO_VIEW_BIN'), configDir: await $.env.get('CLAUDE_CONFIG_DIR'), home: (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) });
}

// One clock for every read: view.refresh_seconds while a surface is attached, 15 s otherwise and outside turbo.
async function arm($) {
  const surfaces = await $.session.surfaces();
  const ms = root ? refreshMs(view, surfaces.length > 0) : BACKGROUND_MS;
  if (ms === period) return;
  if (timer) timer.cancel();
  period = ms;
  timer = $.clock.every(ms, () => {
    void refresh($, false);
  });
}

// Reads the view once: finds the project first, then runs turbo-run view --json in it.
async function read($) {
  if (!root) await locate($);
  if (!root) {
    view = null;
    error = null;
    return;
  }
  bin = bin || (await findBin($));
  if (!bin) throw new Error('cannot find turbo-run: neither CLAUDE_CONFIG_DIR nor a home directory is set');
  const r = await $.process.run(['node', bin, 'view', '--json'], { cwd: root, timeoutMs: VIEW_TIMEOUT_MS });
  if (r.exitCode !== 0) throw new Error(firstLine(r.stderr) || `turbo-run view exited with ${r.exitCode}`);
  const next = parseView(r.stdout);
  for (const text of toastsFor(view, next)) $.ui.toast(text, { timeoutMs: TOAST_MS });
  view = next;
  error = null;
  field = keepDraft(field, next);
}

// force: read again right after a read that is already running (after an answer), instead of skipping.
async function refresh($, force) {
  if (busy) {
    if (force) again = true;
    return;
  }
  busy = true;
  try {
    await read($);
  } catch (err) {
    error = firstLine(err?.message ?? err) || 'unknown error';
  } finally {
    busy = false;
  }
  if (!opened && shouldAutoOpen(view)) {
    opened = true;
    try {
      await $.ui.open({ id: PANE_ID, title: PANE_TITLE });
    } catch (err) {
      $.ui.log(`turbo-view: pane not opened: ${firstLine(err?.message ?? err)}`);
    }
  }
  try {
    await arm($);
  } catch (err) {
    $.ui.log(`turbo-view: clock not set: ${firstLine(err?.message ?? err)}`);
  }
  $.ui.invalidate('ui.render');
  if (again) {
    again = false;
    await refresh($, false);
  }
}

// One answer per question at a time. S1's arbiter prints one line on stdout for every outcome (answered, already
// answered, changed since it was shown, refused); that line is the toast. The pane reads the run again at once.
async function send($, q, choice) {
  if (sending.has(q.id) || !bin || !root) return;
  sending.add(q.id);
  try {
    const r = await $.process.run(answerArgv({ turboRun: bin, question: q, ...choice }), { cwd: root, timeoutMs: ANSWER_TIMEOUT_MS });
    $.ui.toast(firstLine(r.stdout) || firstLine(r.stderr) || `turbo-run answer exited with ${r.exitCode}`, { timeoutMs: TOAST_MS });
    field = afterAnswer(field, q.id, r.exitCode);
  } catch (err) {
    $.ui.toast(`turbo-run answer failed: ${firstLine(err?.message ?? err)}`, { timeoutMs: TOAST_MS });
  } finally {
    sending.delete(q.id);
  }
  await refresh($, true);
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    // a -p run draws nowhere and nobody answers there: the mod stays idle
    if (!e.isInteractive) return next(e);
    try {
      await $.command.register({ name: 'turbo-view', description: 'Open the gsd-turbo live view: lanes, subagents, questions, commits', immediate: true });
    } catch (err) {
      $.ui.log(`turbo-view: /turbo-view not registered: ${firstLine(err?.message ?? err)}`);
    }
    void refresh($, false);
    return next(e);
  });

  on('command.run', { command: 'turbo-view' }, async ($) => {
    if (!root) await locate($);
    if (!root) return { text: 'turbo-view: no .planning/turbo/ in this directory or above it' };
    opened = true;
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true });
    void refresh($, true);
    return {};
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = bandLine(view, { error });
    if (!line) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const mine = Text({ children: [line], wrap: 'truncate-end', dimColor: true });
    const theirs = await next(e);
    return theirs ? Box({ flexDirection: 'column', children: [mine, theirs] }) : mine;
  });

  on('ui.render', { component: 'Pane', requestId: 'turbo-view' }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e);
    const children = render(view, { error }).rows.map((row) => {
      if (row.kind === 'text') return Text({ children: [row.text], wrap: 'truncate-end', ...TONES[row.tone] });
      const controls = row.options.map((o) =>
        Button({
          key: o.key,
          label: o.label,
          onPress: () => {
            void send($, row, { option: o.option });
          },
        }),
      );
      if (row.other && field.inputFor === row.id) {
        controls.push(
          Input({
            key: row.inputKey,
            label: row.inputLabel,
            placeholder: row.inputHint,
            value: field.draft,
            submitLabel: row.submitLabel,
            autoFocus: true,
            onInput: (value) => {
              field = { ...field, draft: value, draftFor: row.id };
            },
            onSubmit: (value) => {
              const text = value.trim();
              if (text) {
                // kept if the answer is refused or the question changed meanwhile
                field = { ...field, draft: value, draftFor: row.id };
                void send($, row, { text });
                return;
              }
              field = NO_FIELD;
              $.ui.invalidate('ui.render');
            },
          }),
        );
      } else if (row.other) {
        controls.push(
          Button({
            key: row.otherKey,
            label: row.otherLabel,
            onPress: () => {
              field = openField(field, row.id);
              $.ui.invalidate('ui.render');
            },
          }),
        );
      }
      return Box({ flexDirection: 'column', children: [Text({ children: [row.text], wrap: 'truncate-end' }), Box({ flexDirection: 'row', columnGap: 1, flexWrap: 'wrap', children: controls })] });
    });
    return Box({ flexDirection: 'column', children });
  });
}
