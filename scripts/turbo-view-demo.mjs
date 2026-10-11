#!/usr/bin/env node
// The turbo-view visual check (spec §9.4: the pane can only be seen in a real terminal). Without arguments it builds
// a demo project and a copy of the mod in a new temporary directory and prints the command that opens them in
// Claude Code. The mod then runs this same file as its turbo-run (TURBO_VIEW_BIN): `view --json` plays a scripted
// run that changes every few reads, and `answer …` records what the pane sends. Nothing outside that directory is
// written; the demo project's state lives in its .planning/turbo/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerToast, bandLine, paneLines, render, toastsFor } from '../mod/hooks/view-model.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.dirname(path.dirname(SELF));
const STATE = 'demo-state.json';
const ANSWERS = 'demo-answers.jsonl';
const CYCLE = 16;
const MIN = 60000;
// What the owner types into Other… for the argument check: quotes, a flag and a trailing backslash must reach
// turbo-run as this one argument, with --by pane (check compares it with what the fake recorded).
export const PROBE = 'a" --by telegram "b \\';

// The scripted run's texts, synthetic, in the language the demo runs in.
const TEXT = {
  en: {
    q1: 'Deploy phase 32 after green CI?', ctx1: 'Users see the change once it is deployed; Stop keeps the phase waiting.', yes: 'Yes, by the gate', stop: 'Stop',
    q2: 'Does the export page look right?', accept: 'Accept if the checks pass', show: 'Stop and show me',
    round: (n) => `Demo, round ${n}`, again: 'The questions are open again; the earlier answers were recorded.',
    commits: ['feat: export page lists every chat', 'fix: the stop reason is kept', 'test: export of an empty chat'],
  },
  ru: {
    q1: 'Деплой фазы 32 после зелёного CI?', ctx1: 'После деплоя изменения увидят пользователи; «Стоп» оставит фазу ждать.', yes: 'Да, по гейту', stop: 'Стоп',
    q2: 'Страница экспорта выглядит верно?', accept: 'Принять, если проверки прошли', show: 'Остановиться и показать мне',
    round: (n) => `Демо, круг ${n}`, again: 'Вопросы снова открыты, прежние ответы записаны.',
    commits: ['экспорт: страница показывает все чаты', 'исправлено: причина остановки сохраняется', 'тесты: экспорт пустого чата'],
  },
};

// The view a scripted run shows at its tick-th read (1-based, repeating every 16 reads): the second question
// appears at read 4, CI turns red at 7, the lane stops for the owner at 10 and is done at 13. From the second round on
// the questions say so (the round in the question, a context line), so a question answered before and back again is
// never taken for a lost answer.
export function demoView({ tick, lang = 'en', startedAt, now, answered = {} }) {
  const t = TEXT[lang === 'ru' ? 'ru' : 'en'];
  const s = ((tick - 1) % CYCLE) + 1;
  const round = Math.floor((tick - 1) / CYCLE) + 1;
  const ask = (text) => (round > 1 ? `${t.round(round)}: ${text}` : text);
  const context = (text) => (round > 1 ? `${t.again}${text ? ` ${text}` : ''}` : text);
  const iso = (ms) => new Date(ms).toISOString();
  const status = s >= 13 ? 'done' : s >= 10 ? 'needs-owner' : 'running';
  const agent = (id, type, plan, task, state, action, fromMs, tokens) => ({ agentId: id, type, description: '', plan, task, model: 'opus', worktreeBranch: null, state, action, startedAt: iso(fromMs), lastAt: iso(state === 'quiet' ? now - 16 * MIN : now), elapsedMs: (state === 'quiet' ? now - 16 * MIN : now) - fromMs, tokens, sessionId: 'demo', transcript: 'demo' });
  const questions = [
    { id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: ask(t.q1), context: context(t.ctx1), options: [{ label: t.yes, recommended: true }, { label: t.stop }], allowOther: true, state: 'open', rev: 1 },
    ...(s >= 4 ? [{ id: 'q2', phase: '32', plan: '32-10', task: '1', kind: 'human-verify', header: 'Check', question: ask(t.q2), context: context(''), options: [{ label: t.accept }, { label: t.show }], allowOther: true, state: 'open', rev: 1 }] : []),
  ].filter((q) => !answered[q.id]);
  return {
    v: 1,
    at: iso(now),
    supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: iso(now) },
    range: { from: '32', to: '34' },
    lanes: [{
      phase: '32', step: status === 'done' ? null : 'execute', done: [], notes: {}, status, reason: status === 'needs-owner' ? 'owner question q1' : '', sessionId: 'demo0001', mode: 'full',
      launchedAt: iso(startedAt - 72 * MIN), elapsedMs: now - startedAt + 72 * MIN, transcript: null, lastAt: iso(now), quiet: false,
      agents: status === 'running' ? [
        agent('a1', 'gsd-executor', '32-07', '2', 'running', { tool: 'Edit', detail: 'lib/export.mjs' }, startedAt - 6 * MIN, 120000 + tick * 1500),
        agent('a2', 'gsd-executor', '32-08', null, 'running', { tool: 'Bash', detail: 'node --test test/export.test.mjs' }, startedAt - 2 * MIN, 41000 + tick * 900),
        agent('a3', 'gsd-verifier', null, null, 'quiet', { tool: 'Bash', detail: 'npm test' }, startedAt - 30 * MIN, 88000),
        agent('a4', 'gsd-executor', '32-06', null, 'completed', { tool: 'Bash', detail: 'git commit' }, startedAt - 40 * MIN, 150000),
      ] : [agent('a4', 'gsd-executor', '32-06', null, 'completed', { tool: 'Bash', detail: 'git commit' }, startedAt - 40 * MIN, 150000)],
      push: { outcome: 'pushed', sha: s >= 7 ? 'b2c3d4e' : 'a1b2c3d', at: iso(now), ci: s >= 7 ? 'red' : 'green' },
    }],
    questions,
    commits: ['b2c3d4e', 'a1b2c3d', '9f8e7d6'].map((sha, i) => ({ sha, subject: t.commits[i] })),
    ui: { lang: lang === 'ru' ? 'ru' : 'en', refreshSeconds: 3 },
  };
}

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// The fake turbo-run, called by the mod in the demo project: view --json and answer. Returns { code, stdout, stderr }.
// Arguments read in order, as turbo-run reads them: a value flag takes the next argument whatever it says, so an
// answer text that reads --by or --project stays the text. Returns { flags, positional }.
const VALUE_FLAGS = new Set(['--project', '--option', '--text', '--by', '--rev']);
function readArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) flags[args[i]] ??= args[++i];
    else if (!args[i].startsWith('--')) positional.push(args[i]);
  }
  return { flags, positional };
}

export function fakeTurboRun(argv, cwd, now = Date.now()) {
  const { flags, positional: args } = readArgs(argv);
  const flag = (_, name) => flags[name];
  // the mod names the project with --project and runs this script in the clone
  const dir = path.join(flags['--project'] ?? cwd, '.planning', 'turbo');
  const file = path.join(dir, STATE);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args[0] === 'view') {
    state.tick += 1;
    // a new round of the script brings the answered questions back, so the owner can answer again
    if (state.tick > 1 && (state.tick - 1) % CYCLE === 0) state.answered = {};
    fs.writeFileSync(file, JSON.stringify(state));
    return { code: 0, stdout: JSON.stringify(demoView({ tick: state.tick, lang: state.lang, startedAt: state.startedAt, now, answered: state.answered })), stderr: '' };
  }
  // the replies of S1's arbiter (docs/plans/2026-10-11-stage-3-s1-owner-channel.md, Contracts), one line on stdout:
  // exit 0 answered, 3 already answered (checked before --rev), 4 changed since it was shown, 1 refused, 2 usage
  if (args[0] === 'answer') {
    const [, , id] = args;
    const option = flag(args, '--option');
    const text = flag(args, '--text');
    const by = flag(args, '--by') ?? 'session';
    const q = demoView({ tick: state.tick, lang: state.lang, startedAt: state.startedAt, now }).questions.find((x) => x.id === id);
    if (!q) return { code: 1, stdout: `refused: no question ${id}\n`, stderr: '' };
    const prior = state.answered[id];
    if (prior) return { code: 3, stdout: `already answered: ${prior.answer}, ${prior.by}, ${prior.at}\n`, stderr: '' };
    const shown = flag(args, '--rev');
    if (shown !== undefined && Number(shown) !== q.rev) return { code: 4, stdout: `changed: question ${id} changed since it was shown (now rev ${q.rev}, shown rev ${shown}); read it again and answer the new version\n`, stderr: '' };
    const answer = text ?? q.options[Number(option) - 1]?.label;
    if (!answer) return { code: 2, stdout: `usage: question ${id} has no option ${option}\n`, stderr: '' };
    const at = new Date(now).toISOString();
    state.answered[id] = { answer, by, at };
    fs.writeFileSync(file, JSON.stringify(state));
    fs.appendFileSync(path.join(dir, ANSWERS), `${JSON.stringify({ id, option: option ?? null, text: text ?? null, by, at })}\n`);
    return { code: 0, stdout: `answered ${id}: ${answer}, ${by}, ${at}\n`, stderr: '' };
  }
  return { code: 2, stdout: '', stderr: 'the demo turbo-run knows view --json and answer only\n' };
}

// The demo directory: project/.planning/turbo/ with the scripted run's state, and turbo-view/, a copy of the mod
// without its tests (Claude Code writes type files into a mod loaded with --plugin-dir; they land there).
export function setupDemo({ dir, lang = 'en', repoDir = REPO, now = Date.now() }) {
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(project, '.planning', 'turbo', 'config.json'), `${JSON.stringify({ lang, view: { refresh_seconds: 3 } }, null, 2)}\n`);
  fs.writeFileSync(path.join(project, '.planning', 'turbo', STATE), JSON.stringify({ tick: 0, lang, startedAt: now, answered: {} }));
  const mod = path.join(dir, 'turbo-view');
  fs.cpSync(path.join(repoDir, 'mod'), mod, { recursive: true, filter: (src) => !/\.test\.[cm]?[jt]sx?$/.test(src) });
  return { project, mod };
}

// What the owner runs and checks; the expected pane, band and toast texts come from the mod's own view model.
export function instructions({ dir, project, mod, lang = 'en', self = SELF }) {
  const win = (p) => p.replace(/\//g, '\\');
  const first = demoView({ tick: 1, lang, startedAt: 0, now: 0 });
  const pane = paneLines(render(first)).map((l) => (l ? `       ${l}` : ''));
  const buttons = pane.find((l) => l.includes('[')).trim().replace(/^│\s*/, '');
  const other = buttons.split('  ').at(-1);
  const labels = first.questions[0].options.map((o) => o.label);
  // the toasts of the first 13 reads, as the mod raises them (nothing is answered in this run of the script)
  const reads = Array.from({ length: 13 }, (_, i) => demoView({ tick: i + 1, lang, startedAt: 0, now: (i + 1) * 3000 }));
  const toasts = reads.flatMap((v, i) => toastsFor(reads[i - 1] ?? null, v).map((x) => `     read ${i + 1}: "${x}"`));
  const again = demoView({ tick: CYCLE + 1, lang, startedAt: 0, now: 0 }).questions[0].question;
  return [
    `turbo-view visual check — demo in ${dir}`,
    '',
    'Open it in Claude Code (2.1.290 or newer), in a terminal at least 144 columns wide:',
    // TURBO_VIEW_BIN is set for that one claude only: a later claude in the same window must run the real turbo-run
    `  bash / Git Bash:  (cd "${project}" && TURBO_VIEW_BIN="${self}" claude --plugin-dir "${mod}")`,
    `  PowerShell:       Push-Location "${win(project)}"; try { $env:TURBO_VIEW_BIN = "${win(self)}"; claude --plugin-dir "${win(mod)}" } finally { Remove-Item Env:TURBO_VIEW_BIN; Pop-Location }`,
    'Accept the trust prompt for the demo folder. Then check:',
    '  1. Within 3 s the pane opens by itself on the right and reads as below (the times grow every 3 s): the verdict',
    '     line first, its phase in bold and "needs your answer" in amber; the helpers indented under it, the silent one',
    '     amber with ⚠️ and the finished one dim; the question in a rounded amber card, bold, its context dim, the',
    '     recommended option ★ in the accent colour; then the latest changes and the supervisor, dim:',
    ...pane,
    `  2. The band above the prompt reads "${bandLine(first)}", in amber.`,
    '  3. Over the next 40 s, these toasts (the band turns red with CI red at read 7):',
    ...toasts,
    `     The script repeats every 16 reads: from read 17 each question says "${again}"`,
    '     and its context says the questions are open again, so an answered question that is back is no lost answer.',
    `  4. Focus the pane (click it, or Ctrl+X then Tab), Tab to [${buttons.split('  ')[1].slice(1, -1)}], press Enter: a toast`,
    `     "${answerToast(first, { code: 0, sent: labels[1] })} · <local time HH:MM>", and the question leaves the pane within 3 s.`,
    `  5. On the second question press ${other} and type, slowly over a few seconds: проверка 👍 — the text stays`,
    `     while the pane redraws every 3 s. Then Enter: "${answerToast(first, { code: 0, sent: 'проверка 👍' })} · <local time>".`,
    `     Both answers are in ${path.join(project, '.planning', 'turbo', ANSWERS)}.`,
    '  6. The argument check. When the script repeats (read 17, about 50 s in), the first question is back: press',
    `     ${other} on it, type exactly the next line, and press Enter:`,
    `     ${PROBE}`,
    `     Then, in another terminal, run:  node "${self}" check "${project}"`,
    '     It prints "ok: the answer arrived as one argument, by pane" when the text reached turbo-run unchanged.',
    '  7. Close the pane (Ctrl+X then X): it does not come back by itself; /turbo-view opens it again.',
    '  8. In a new session in a terminal narrower than 110 columns the pane does not open by itself; /turbo-view opens it.',
    `For the ${lang === 'ru' ? 'English' : 'Russian'} texts run this script again with --lang ${lang === 'ru' ? 'en' : 'ru'}. When done, exit Claude Code and delete the demo folder.`,
  ].join('\n');
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
}

// The argument check: whether the fake turbo-run recorded PROBE, as one argument and by the pane, in the project.
export function checkProbe(project) {
  let answers = [];
  try {
    answers = fs.readFileSync(path.join(project, '.planning', 'turbo', ANSWERS), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    // nothing answered yet
  }
  if (answers.some((a) => a.text === PROBE && a.by === 'pane')) return { code: 0, stdout: `ok: the answer arrived as one argument, by pane: ${JSON.stringify(PROBE)}\n` };
  const got = answers.filter((a) => a.text !== null).map((a) => `${JSON.stringify(a.text)} by ${a.by}`);
  return { code: 1, stdout: `MISMATCH: no answer with the text ${JSON.stringify(PROBE)} by pane; recorded: ${got.join('; ') || 'none'}\n` };
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args[0] === 'view' || args[0] === 'answer' || args[0] === 'check') {
    const r = args[0] === 'check' ? { stderr: '', ...checkProbe(path.resolve(args[1] ?? '.')) } : fakeTurboRun(args, process.cwd());
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.code;
  } else {
    const lang = flag(args, '--lang') === 'ru' ? 'ru' : 'en';
    const dir = flag(args, '--dir') ? path.resolve(flag(args, '--dir')) : fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-view-demo-'));
    process.stdout.write(`${instructions({ dir, lang, ...setupDemo({ dir, lang }) })}\n`);
  }
}
