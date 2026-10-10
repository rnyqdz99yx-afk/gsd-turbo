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
import { bandLine, render } from '../mod/hooks/view-model.mjs';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.dirname(path.dirname(SELF));
const STATE = 'demo-state.json';
const ANSWERS = 'demo-answers.jsonl';
const CYCLE = 16;
const MIN = 60000;

const TEXT = {
  en: { q1: 'Deploy after green CI?', yes: 'Yes, by the gate', stop: 'Stop', q2: 'Does the export page look right?', accept: 'Accept if the checks pass', show: 'Stop and show me', reason: 'checkpoint 32-09 Task 3: deploy needs your answer' },
  ru: { q1: 'Деплой после зелёного CI?', yes: 'Да, по гейту', stop: 'Стоп', q2: 'Страница экспорта выглядит верно?', accept: 'Принять, если проверки прошли', show: 'Остановиться и показать мне', reason: 'чекпоинт 32-09 Task 3: для деплоя нужен твой ответ' },
};

// The view a scripted run shows at its tick-th read (1-based, repeating every 16 reads): the second question
// appears at read 4, CI turns red at 7, the lane stops for the owner at 10 and is done at 13.
export function demoView({ tick, lang = 'en', startedAt, now, answered = {} }) {
  const t = TEXT[lang === 'ru' ? 'ru' : 'en'];
  const s = ((tick - 1) % CYCLE) + 1;
  const iso = (ms) => new Date(ms).toISOString();
  const status = s >= 13 ? 'done' : s >= 10 ? 'needs-owner' : 'running';
  const agent = (id, type, plan, task, state, action, fromMs, tokens) => ({ agentId: id, type, description: '', plan, task, model: 'opus', worktreeBranch: null, state, action, startedAt: iso(fromMs), lastAt: iso(state === 'quiet' ? now - 16 * MIN : now), elapsedMs: (state === 'quiet' ? now - 16 * MIN : now) - fromMs, tokens, sessionId: 'demo', transcript: 'demo' });
  const questions = [
    { id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: t.q1, options: [{ label: t.yes }, { label: t.stop }], allowOther: true, state: 'open', rev: 1 },
    ...(s >= 4 ? [{ id: 'q2', phase: '32', plan: '32-10', task: '1', kind: 'human-verify', header: 'Check', question: t.q2, options: [{ label: t.accept }, { label: t.show }], allowOther: true, state: 'open', rev: 1 }] : []),
  ].filter((q) => !answered[q.id]);
  return {
    v: 1,
    at: iso(now),
    supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: iso(now) },
    range: { from: '32', to: '34' },
    lanes: [{
      phase: '32', step: status === 'done' ? null : 'execute', done: [], notes: {}, status, reason: status === 'needs-owner' ? t.reason : '', sessionId: 'demo0001', mode: 'full',
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
    commits: [{ sha: 'b2c3d4e', subject: 'feat: export page lists every chat' }, { sha: 'a1b2c3d', subject: 'fix: lane record keeps the reason' }, { sha: '9f8e7d6', subject: 'test: export of an empty chat' }],
    ui: { lang: lang === 'ru' ? 'ru' : 'en', refreshSeconds: 3 },
  };
}

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// The fake turbo-run, called by the mod in the demo project: view --json and answer. Returns { code, stdout, stderr }.
export function fakeTurboRun(args, cwd, now = Date.now()) {
  const dir = path.join(cwd, '.planning', 'turbo');
  const file = path.join(dir, STATE);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args[0] === 'view') {
    state.tick += 1;
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

// What the owner runs and checks; the expected pane and band texts come from the mod's own view model.
export function instructions({ dir, project, mod, lang = 'en', self = SELF }) {
  const win = (p) => p.replace(/\//g, '\\');
  const first = demoView({ tick: 1, lang, startedAt: 0, now: 0 });
  const model = render(first);
  const q = model.rows.find((r) => r.kind === 'question');
  const buttons = `[${[...q.options.map((o) => o.label), q.otherLabel].join('] [')}]`;
  const labels = first.questions[0].options.map((o) => o.label);
  const choices = labels.map((l, i) => `${i + 1}. ${l}`).join('  ');
  return [
    `turbo-view visual check — demo in ${dir}`,
    '',
    'Open it in Claude Code (2.1.290 or newer), in a terminal at least 144 columns wide:',
    `  bash / Git Bash:  cd "${project}" && TURBO_VIEW_BIN="${self}" claude --plugin-dir "${mod}"`,
    `  PowerShell:       cd "${win(project)}"; $env:TURBO_VIEW_BIN = "${win(self)}"; claude --plugin-dir "${win(mod)}"`,
    'Accept the trust prompt for the demo folder. Then check:',
    `  1. Within 3 s the pane opens by itself on the right: "${model.rows[0].text}", lane p32 execute, two running`,
    '     agents whose time and tokens grow every 3 s, a quiet gsd-verifier row with ⚠, one finished row,',
    `     one question with its options listed in full (${choices}) above the buttons ${buttons}, and three commits.`,
    `  2. The band above the prompt reads "${bandLine(first)}".`,
    '  3. Over the next 40 s, toasts: a new question (read 4), CI red (read 7; the band then shows CI ✗), phase 32',
    '     stopped: needs-owner (read 10), phase 32 done (read 13). The script repeats every 16 reads.',
    `  4. Focus the pane (click it, or Ctrl+X then Tab), Tab to [${q.options[1].label}], press Enter: a toast`,
    `     "answered q1: ${labels[1]}, pane, <time>", and the question leaves the pane within 3 s.`,
    `  5. On the second question press [${q.otherLabel}] and type, slowly over a few seconds: проверка 👍 — the text stays`,
    '     while the pane redraws every 3 s. Then Enter: a toast with that text.',
    `     Both answers are in ${path.join(project, '.planning', 'turbo', ANSWERS)}.`,
    '  6. Close the pane (Ctrl+X then X): it does not come back by itself; /turbo-view opens it again.',
    '  7. In a new session in a terminal narrower than 110 columns the pane does not open by itself; /turbo-view opens it.',
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

if (isMain()) {
  const args = process.argv.slice(2);
  if (args[0] === 'view' || args[0] === 'answer') {
    const r = fakeTurboRun(args, process.cwd());
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.code;
  } else {
    const lang = flag(args, '--lang') === 'ru' ? 'ru' : 'en';
    const dir = flag(args, '--dir') ? path.resolve(flag(args, '--dir')) : fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-view-demo-'));
    process.stdout.write(`${instructions({ dir, lang, ...setupDemo({ dir, lang }) })}\n`);
  }
}
