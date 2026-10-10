// turbo-view: the gsd-turbo live view (spec §7). A thin shell over view-model.mjs: it finds the project's
// .planning/turbo/, reads `turbo-run view --json` on a clock, draws the pane and the band above the prompt, shows
// toasts, and sends pane answers to `turbo-run answer … --by pane --rev <n>`. Module state is lost on a reload; the
// next read rebuilds it.
import { BACKGROUND_MS, NO_FIELD, PANE_ID, PANE_TITLE, afterAnswer, ancestorDirs, answerArgv, bandLine, diffViews, firstLine, isWindowsPath, joinPath, keepDraft, nodeCandidates, openField, parseView, refreshMs, render, shouldAutoOpen, turboRunPath } from './view-model.mjs';

const VIEW_TIMEOUT_MS = 10000;
const ANSWER_TIMEOUT_MS = 30000;
const TOAST_MS = 8000;
const TONES = { title: { bold: true }, normal: {}, dim: { dimColor: true }, warn: { color: 'yellow' }, error: { color: 'red' } };

let root = null; // the project directory whose .planning/ holds turbo/, or null
let bin = null; // turbo-run.mjs
let node = null; // the absolute node that runs it (findNode)
let view = null; // the last view read
let seen = {}; // each lane as last seen, for the toasts (view-model.mjs diffViews)
let error = null; // why the last read failed
let busy = false; // a read is running
let again = false; // a forced read was asked for while one was running
let timer = null;
let period = 0;
let clockError = null; // why the clock last failed to start, logged once
let live = false; // an interactive session started: the mod reads (a -p run never does)
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

// The absolute node every child process of the mod runs with: the first absolute PATH directory that has it. A bare
// `node` would be looked up in the project (the child's working directory) first on Windows.
async function findNode($) {
  const pathVar = (await $.env.get('PATH')) || (await $.env.get('Path')) || '';
  for (const file of nodeCandidates({ pathVar, windows: isWindowsPath(root) })) {
    if (await $.fs.exists(file)) return file;
  }
  throw new Error('node not found in PATH');
}

// One clock for every read: view.refresh_seconds while a surface is attached (also when the surfaces cannot be
// read), 15 s otherwise and outside turbo. A clock that failed to start stays null, so the next call starts it.
async function arm($) {
  let foreground = true;
  try {
    foreground = (await $.session.surfaces()).length > 0;
  } catch {
    // unknown: read as often as an attached session does
  }
  const ms = root ? refreshMs(view, foreground) : BACKGROUND_MS;
  if (timer && ms === period) return;
  if (timer) timer.cancel();
  timer = null;
  timer = $.clock.every(ms, () => {
    void refresh($, false);
  });
  period = ms;
}

// arm, with a failure logged once until the clock runs again: the band retries it on every draw.
async function keepClock($) {
  try {
    await arm($);
    clockError = null;
  } catch (err) {
    const why = firstLine(err?.message ?? err);
    if (why !== clockError) $.ui.log(`turbo-view: clock not set: ${why}`);
    clockError = why;
  }
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
  // checked on every read: node run on a missing script prints only its loader's stack
  if (!(await $.fs.exists(bin))) throw new Error(`turbo-run not found at ${bin}`);
  node = node || (await findNode($));
  let r;
  try {
    r = await $.process.run([node, bin, 'view', '--json'], { cwd: root, timeoutMs: VIEW_TIMEOUT_MS });
  } catch (err) {
    node = null; // looked up again at the next read: node moved, or a version manager switched it
    throw err;
  }
  if (r.exitCode !== 0) throw new Error(firstLine(r.stderr) || `turbo-run view exited with ${r.exitCode}`);
  const next = parseView(r.stdout);
  const changes = diffViews(view, next, seen);
  for (const text of changes.toasts) $.ui.toast(text, { timeoutMs: TOAST_MS });
  seen = changes.seen;
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
  await keepClock($);
  $.ui.invalidate('ui.render');
  if (again) {
    again = false;
    await refresh($, false);
  }
}

// One answer per question at a time. S1's arbiter prints one line on stdout for every outcome (answered, already
// answered, changed since it was shown, refused); that line is the toast. The pane reads the run again at once.
async function send($, q, choice) {
  if (sending.has(q.id) || !bin || !node || !root) return;
  sending.add(q.id);
  try {
    const r = await $.process.run(answerArgv({ node, turboRun: bin, question: q, ...choice }), { cwd: root, timeoutMs: ANSWER_TIMEOUT_MS });
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
    live = true;
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
    try {
      await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true });
    } catch (err) {
      // Claude Code names the mod in the message already: "turbo-view: $.ui.open: <reason>"
      $.ui.toast(`turbo-view: pane not opened: ${firstLine(err?.message ?? err).replace(/^turbo-view: /, '')}`, { timeoutMs: TOAST_MS });
    }
    // reads at once, and starts the clock again if it failed to start
    void refresh($, true);
    return {};
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // the clock failed to start: every draw of the band tries again, so the view never stops reading
    if (live && !timer) void keepClock($);
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
      // the question and its numbered options wrap, so all of them is read before a numbered button is pressed
      const lines = [row.text, ...row.choices].map((text) => Text({ children: [text], wrap: 'wrap' }));
      return Box({ flexDirection: 'column', children: [...lines, Box({ flexDirection: 'row', columnGap: 1, flexWrap: 'wrap', children: controls })] });
    });
    return Box({ flexDirection: 'column', children });
  });
}
