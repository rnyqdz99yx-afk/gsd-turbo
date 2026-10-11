import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULTS, viewRefreshSeconds } from './config.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { claudeHome, runDir } from './paths.mjs';
import { nextStep, readProgress } from './phase-progress.mjs';
import { readLaneStatus } from './run-status.mjs';
import { comparePhase } from './scheduler.mjs';
import { maskSecrets } from './secrets.mjs';
import { laneAgents, laneTranscript, projectDirs } from './transcripts.mjs';
import { whichAbsolute } from './which.mjs';

// What view keeps between calls (git-ignored run directory): per transcript file, the transcript layer's last result.
const CACHE_FILE = 'view-cache.json';
const CACHE_VERSION = 1;
const COMMITS = 5;
const GIT_TIMEOUT_MS = 5000;
const QUESTIONS_RE = /^p([A-Za-z0-9._-]+)-questions\.json$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Minutes without a transcript write before a subagent or a lane reads as quiet (config stall_minutes, at least 1).
export function stallMs(config) {
  const n = Math.floor(Number(config?.stall_minutes));
  return (Number.isFinite(n) && n >= 1 ? n : DEFAULTS.stall_minutes) * 60000;
}

// Repository data (commit subjects, reasons, questions, agent actions) can hold terminal escapes and bidi controls:
// OSC 52 rewrites the clipboard, ESC[2J clears the screen, U+202E reverses what follows. clean drops escape
// sequences, C0/C1 controls except tab and newline, and bidi overrides and isolates, where view reads the text, so
// view --json, view and status --watch never pass them on (the turbo-view mod cleans again on its side).
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
export const clean = (text) => String(text ?? '').replace(ESCAPES, '').replace(CONTROLS, '');
// what view shows of a text from the repository: cleaned, then secrets masked
const shown = (text) => maskSecrets(clean(text));

// The text of a question as view shows it: cleaned and secrets masked in what is read (question, context, header,
// condition, an option's label, description and signal). view only displays: an answer is taken from the questions
// file. Ids, rev, state, plan, task and agentId stay as written, so a button in the view still names its question.
const QUESTION_TEXT = ['question', 'context', 'header', 'condition'];
const OPTION_TEXT = ['label', 'description', 'signal'];
const maskFields = (o, keys) => ({ ...o, ...Object.fromEntries(keys.filter((k) => typeof o[k] === 'string').map((k) => [k, shown(o[k])])) });

function shownQuestion(q) {
  const out = maskFields(q, QUESTION_TEXT);
  if (Array.isArray(q.options)) out.options = q.options.map((o) => (isObj(o) ? maskFields(o, OPTION_TEXT) : o));
  return out;
}

// The owner questions still open, in phase order, their text masked (shownQuestion). S1 writes them to
// run/p<N>-questions.json as a JSON array of question objects whose state is "open" until answered; any other file
// content is skipped.
export function openQuestions(root) {
  let names = [];
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    return [];
  }
  const files = names.map((n) => QUESTIONS_RE.exec(n)).filter(Boolean).sort((a, b) => comparePhase(a[1], b[1]));
  const out = [];
  for (const m of files) {
    const list = readJson(path.join(runDir(root), m[0]), null);
    if (Array.isArray(list)) for (const q of list) if (isObj(q) && q.state === 'open' && typeof q.id === 'string') out.push(shownQuestion(q));
  }
  return out;
}

// The last commits of the checkout, newest first: [{ sha, subject }]; none outside a git repository or before the
// first commit.
export function recentCommits(root, n = COMMITS) {
  // git by its absolute path from PATH, never one placed in the project (whichAbsolute)
  const git = whichAbsolute('git', { exclude: [root] });
  if (!git) return [];
  let text = '';
  try {
    text = execFileSync(git, ['log', `-${n}`, '--format=%h%x1f%s'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((line) => {
    const [sha, ...rest] = line.split('\x1f');
    return { sha: clean(sha), subject: shown(rest.join(' ')).slice(0, 200) };
  });
}

function loadCache(file) {
  const c = readJson(file, null);
  return isObj(c) && c.v === CACHE_VERSION && isObj(c.files) ? c.files : {};
}

// Written only where the run directory already exists: view never creates turbo's directories in a project. The
// cache is an optimization, so a failed write changes nothing.
function saveCache(file, files, before) {
  if (!fs.existsSync(path.dirname(file)) || JSON.stringify(files) === JSON.stringify(before)) return;
  try {
    writeJsonAtomic(file, { v: CACHE_VERSION, files });
  } catch { /* next call reads the transcripts again */ }
}

// The phase's push as the supervisor recorded it (S2: run/p<N>-push.json, written by lib/push.mjs), reduced to what
// the live view shows. S2 keeps the latest request's outcome and time at the top and the last push with its CI watch
// in lastPush, which later requests carry over: { outcome, at (the latest request's), sha (7 characters), ci (the CI
// state) of the last push, or null before any push }; null without a readable record.
const PUSH_OUTCOMES = new Set(['pushed', 'refused', 'diverged', 'failed']);
export function pushOf(root, phase) {
  const rec = readJson(path.join(runDir(root), `p${phase}-push.json`), null);
  if (!isObj(rec) || !PUSH_OUTCOMES.has(rec.outcome)) return null;
  const text = (v) => (typeof v === 'string' && v ? clean(v) : null);
  const last = isObj(rec.lastPush) ? rec.lastPush : null;
  return { outcome: rec.outcome, at: text(rec.at), sha: text(last?.sha)?.slice(0, 7) ?? null, ci: isObj(last?.ci) ? text(last.ci.state) : null };
}

// A subagent as view shows it: the text read from its transcript (type, description, plan, task, action) cleaned.
const textOrNull = (v) => (typeof v === 'string' ? clean(v) : v);
function shownAgent(a) {
  const out = { ...a, type: textOrNull(a.type), description: textOrNull(a.description), plan: textOrNull(a.plan), task: textOrNull(a.task) };
  if (isObj(a.action)) out.action = { ...a.action, tool: textOrNull(a.action.tool), detail: textOrNull(a.action.detail) };
  return out;
}

function laneView({ root, lane, home, now, stall, cache, used }) {
  const phase = String(lane.phase);
  const progress = readProgress(root, phase);
  const record = readLaneStatus(root, phase);
  // a lane record counts only when written since this lane's launch, as the supervisor reads it
  const fresh = Boolean(record && lane.launchedAt && Date.parse(record.at) >= Date.parse(lane.launchedAt));
  // supervisor.json lane.sessionId is the background job id claude --bg printed; the job state names the transcript
  const sessionId = typeof lane.sessionId === 'string' ? lane.sessionId : '';
  const main = sessionId ? laneTranscript({ home, root, jobId: sessionId }) : null;
  const t = laneAgents({ dirs: projectDirs(home, root), main, root, now, stallMs: stall, cache, used });
  const launched = Date.parse(lane.launchedAt);
  return {
    phase,
    step: nextStep(progress),
    done: progress.done,
    notes: Object.fromEntries(Object.entries(progress.notes).map(([k, v]) => [k, shown(v)])),
    status: fresh ? clean(record.status) : 'running',
    reason: fresh ? shown(record.reason || '') : '',
    sessionId,
    mode: lane.mode === 'full' ? 'full' : 'safe',
    launchedAt: lane.launchedAt || null,
    elapsedMs: Number.isFinite(launched) ? Math.max(0, now.getTime() - launched) : null,
    transcript: t.transcript,
    lastAt: t.lastAt,
    quiet: t.lastAt ? now.getTime() - Date.parse(t.lastAt) > stall : false,
    agents: t.agents.map(shownAgent),
    push: pushOf(root, phase),
  };
}

// Everything turbo-run view shows (spec §4) as one JSON-ready object: supervisor, range, lanes with their step and
// subagents, open questions, the last commits. sup is supervisor.json (null when absent); running says whether its
// daemon is alive (the caller owns the heartbeat rules).
export function buildView({ root, sup, running = false, config = {}, env = process.env, now = new Date(), commits = recentCommits }) {
  const home = claudeHome(env);
  const stall = stallMs(config);
  const cacheFile = path.join(runDir(root), CACHE_FILE);
  const cache = loadCache(cacheFile);
  const used = {};
  const lanes = (sup?.lane ? [sup.lane] : []).map((lane) => laneView({ root, lane, home, now, stall, cache, used }));
  saveCache(cacheFile, used, cache);
  return {
    v: 1,
    at: now.toISOString(),
    supervisor: sup ? { running: Boolean(running), pid: running ? sup.pid ?? null : null, finished: Boolean(sup.finished), halted: Boolean(sup.halted), failingSince: sup.failingSince || null, updatedAt: sup.updatedAt || null } : null,
    range: sup?.range ? { from: sup.range.from ?? null, to: sup.range.to ?? null } : null,
    lanes,
    questions: openQuestions(root),
    commits: commits(root),
    // what the turbo-view mod (S3) reads from the owner's config: the language it draws in and how often it reads;
    // and the owner's time zone (minutes east of UTC), so its toasts tell the local time whatever zone the mod runs in
    ui: { lang: config?.lang === 'ru' ? 'ru' : 'en', refreshSeconds: viewRefreshSeconds(config), utcOffsetMinutes: -now.getTimezoneOffset() },
  };
}

// The words turbo-run view and status --watch speak: the turbo-view pane's (mod/hooks/view-model.mjs, which the mod
// carries on its own), in the config's language. test/view.test.mjs holds the tables and the text equal to the pane's.
export const WORDS = {
  en: {
    step: { freshness: 'freshness check', discuss: 'discussion', prologue: 'planning prep', plan: 'planning', 'gates-off': 'execution prep', execute: 'running plans', restore: 'restoring settings', fanout: 'quality checks', fix: 'fixes', 'final-gate': 'final check', uat: 'acceptance', close: 'wrap-up', ci: 'CI check' },
    agent: { 'gsd-executor': 'Executor', 'gsd-verifier': 'Verifier', 'gsd-code-reviewer': 'Reviewer', 'gsd-code-fixer': 'Fixer', 'gsd-planner': 'Planner', 'gsd-plan-checker': 'Plan checker', 'gsd-phase-researcher': 'Researcher', 'gsd-security-auditor': 'Security auditor', 'gsd-nyquist-auditor': 'Test auditor', 'gsd-integration-checker': 'Integration checker', 'gsd-debugger': 'Debugger', 'turbo-uat': 'Acceptance tester', 'general-purpose': 'Helper', Explore: 'Scout' },
  },
  ru: {
    step: { freshness: 'проверка актуальности', discuss: 'обсуждение', prologue: 'подготовка к планированию', plan: 'планирование', 'gates-off': 'подготовка к выполнению', execute: 'выполняются планы', restore: 'восстановление настроек', fanout: 'проверки качества', fix: 'исправления', 'final-gate': 'финальная проверка', uat: 'приёмка', close: 'завершение', ci: 'проверка CI' },
    agent: { 'gsd-executor': 'Исполнитель', 'gsd-verifier': 'Проверяющий', 'gsd-code-reviewer': 'Ревьюер', 'gsd-code-fixer': 'Исправляющий', 'gsd-planner': 'Планировщик', 'gsd-plan-checker': 'Контролёр плана', 'gsd-phase-researcher': 'Исследователь', 'gsd-security-auditor': 'Аудитор безопасности', 'gsd-nyquist-auditor': 'Аудитор тестов', 'gsd-integration-checker': 'Контролёр связей', 'gsd-debugger': 'Отладчик', 'turbo-uat': 'Приёмщик', 'general-purpose': 'Помощник', Explore: 'Разведчик' },
  },
};

const ruPlural = (n, one, few, many) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

const TEXT = {
  en: {
    ...WORDS.en,
    allDone: 'all steps done',
    phase: (p) => `Phase ${p}`,
    phaseOnly: (p) => `phase ${p}`,
    plan: (p, task) => `plan ${p}${task ? `, task ${task}` : ''}`,
    run: 'Run',
    going: (d) => `${d} so far`,
    took: (d) => `took ${d}`,
    verdict: { fine: 'all fine', answer: (n) => `needs your answer (${n})`, ciRed: 'CI red', needsOwner: 'stopped — waits for your decision', failed: 'stopped by a failure', quiet: (d) => `silent${d ? ` for ${d}` : ''} — may be stuck`, paused: 'restarting with a fresh context', done: 'done', halted: 'supervisor stopped', supStopped: 'supervisor not running', finished: 'all phases done', never: 'supervisor never started' },
    reason: 'Reason',
    doing: { edit: (x) => `editing ${x}`, write: (x) => `writing ${x}`, read: (x) => `reading ${x}`, search: 'searching the code', files: 'looking for files', tests: 'running tests', commit: 'committing', command: (x) => `running a command: ${x}`, helper: 'started a helper', skill: 'using a skill', web: 'searching the web', todo: 'updating its to-do list', message: 'messaging a helper', browser: 'using the browser', working: 'working' },
    state: { completed: 'done', stopped: 'stopped', failed: 'failed' },
    quietAgent: (who, d) => `⚠ ${who} silent${d ? ` for ${d}` : ''} — may be stuck`,
    moreDone: (n) => `+ ${n} more done`,
    askHead: (n) => `Needs your answer (${n}):`,
    recommended: 'recommended',
    changes: 'Latest changes:',
    sup: { running: 'Supervisor running', stopped: 'Supervisor not running', finished: 'Supervisor finished', halted: 'Supervisor stopped', never: 'Supervisor never started' },
    phases: (from, to) => `phases ${from}–${to}`,
    duration: (h, m, s) => (h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`),
  },
  ru: {
    ...WORDS.ru,
    allDone: 'все шаги пройдены',
    phase: (p) => `Фаза ${p}`,
    phaseOnly: (p) => `фаза ${p}`,
    plan: (p, task) => `план ${p}${task ? `, задача ${task}` : ''}`,
    run: 'Прогон',
    going: (d) => `идёт ${d}`,
    took: (d) => `заняла ${d}`,
    verdict: { fine: 'всё в порядке', answer: (n) => `нужен ваш ответ (${n})`, ciRed: 'CI красный', needsOwner: 'остановилась — ждёт вашего решения', failed: 'остановилась из-за сбоя', quiet: (d) => `тишина${d ? ` ${d}` : ''} — возможно, зависла`, paused: 'перезапускается с чистым контекстом', done: 'готова', halted: 'супервизор остановился', supStopped: 'супервизор не работает', finished: 'все фазы готовы', never: 'супервизор не запускался' },
    reason: 'Причина',
    doing: { edit: (x) => `правит ${x}`, write: (x) => `создаёт ${x}`, read: (x) => `читает ${x}`, search: 'ищет в коде', files: 'ищет файлы', tests: 'запустил тесты', commit: 'делает коммит', command: (x) => `выполняет команду: ${x}`, helper: 'запустил помощника', skill: 'запустил навык', web: 'ищет в интернете', todo: 'обновляет список дел', message: 'пишет помощнику', browser: 'работает в браузере', working: 'работает' },
    state: { completed: 'готов', stopped: 'остановлен', failed: 'сбой' },
    quietAgent: (who, d) => `⚠ ${who} молчит${d ? ` ${d}` : ''} — возможно, завис`,
    moreDone: (n) => `+ ещё ${n} ${ruPlural(n, 'готовый', 'готовых', 'готовых')}`,
    askHead: (n) => `Нужен ваш ответ (${n}):`,
    recommended: 'рекомендуется',
    changes: 'Последние изменения:',
    sup: { running: 'Супервизор работает', stopped: 'Супервизор не работает', finished: 'Супервизор закончил', halted: 'Супервизор остановился', never: 'Супервизор не запускался' },
    phases: (from, to) => `фазы ${from}–${to}`,
    duration: (h, m, s) => (h ? `${h} ч ${m} мин` : m ? `${m} мин` : `${s} с`),
  },
};

const FINISHED_SHOWN = 3;
const ACTIVE = new Set(['running', 'quiet']);
const list = (v) => (Array.isArray(v) ? v : []);

// One line: whitespace collapsed, at most max code points, ended with … when cut.
function short(text, max = Infinity) {
  const s = clean(text).replace(/\s+/g, ' ').trim();
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
}

function duration(t, ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return t.duration(Math.floor(m / 60), m % 60, s);
}
const since = (t, from, to) => duration(t, Date.parse(to) - Date.parse(from));

const stepWord = (t, step) => (step == null ? t.allDone : t.step[step] ?? short(step, 40));
const agentWord = (t, type) => (type ? t.agent[type] ?? short(type, 40) : t.agent['general-purpose']);
const planWords = (t, x) => (x?.plan ? t.plan(x.plan, x.task) : null);

const TEST_RUN = /\b(?:node\s+--test|npm\s+(?:run\s+)?test|npx\s+(?:jest|vitest|mocha)|jest|vitest|mocha|pytest|go\s+test|cargo\s+test|test-changed|plugin\s+test)\b/;
const COMMIT = /\bgit\b.*\bcommit\b/;
const EDITS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);

function doingWords(t, action) {
  const d = t.doing;
  if (!action) return d.working;
  const tool = String(action.tool ?? '');
  const raw = String(action.detail ?? '');
  const x = short(raw, 60);
  if (EDITS.has(tool)) return d.edit(x).trim();
  if (tool === 'Write') return d.write(x).trim();
  if (tool === 'Read') return d.read(x).trim();
  if (tool === 'Grep') return d.search;
  if (tool === 'Glob' || tool === 'LS') return d.files;
  if (tool === 'Bash' || tool === 'PowerShell') return TEST_RUN.test(raw) ? d.tests : COMMIT.test(raw) ? d.commit : d.command(short(raw, 50)).trim();
  if (tool === 'Agent' || tool === 'Task') return d.helper;
  if (tool === 'Skill') return d.skill;
  if (tool === 'WebFetch' || tool === 'WebSearch') return d.web;
  if (tool === 'TodoWrite') return d.todo;
  if (tool === 'SendMessage') return d.message;
  if (/^mcp__.*(?:playwright|browser|chrome)/i.test(tool)) return d.browser;
  return `${short(tool, 40)} ${x}`.trim();
}

// The run's one verdict, first match (the pane's): the supervisor stopped, a failed or stopped phase, CI red,
// questions waiting, a silent phase, a phase done, a phase restarting for its context, then the supervisor's state.
function verdictText(t, v) {
  const lanes = list(v.lanes);
  const sup = v.supervisor;
  const asked = list(v.questions).length;
  const has = (s) => lanes.some((l) => l.status === s);
  const quiet = lanes.find((l) => l.quiet && l.status === 'running');
  if (sup?.halted) return t.verdict.halted;
  if (has('failed')) return t.verdict.failed;
  if (has('needs-owner')) return t.verdict.needsOwner;
  if (lanes.some((l) => l.push?.ci === 'red')) return t.verdict.ciRed;
  if (asked) return t.verdict.answer(asked);
  if (quiet) return t.verdict.quiet(since(t, quiet.lastAt, v.at));
  if (lanes.length && lanes.every((l) => l.status === 'done')) return t.verdict.done;
  if (has('paused-context')) return t.verdict.paused;
  if (!sup) return lanes.length ? t.verdict.fine : t.verdict.never;
  if (!sup.running) return sup.finished ? t.verdict.finished : t.verdict.supStopped;
  return t.verdict.fine;
}

function supWord(t, sup) {
  if (!sup) return t.sup.never;
  if (sup.running) return t.sup.running;
  if (sup.halted) return t.sup.halted;
  return sup.finished ? t.sup.finished : t.sup.stopped;
}

function agentLine(t, a, at) {
  const who = agentWord(t, a.type);
  const plan = planWords(t, a);
  if (a.state === 'quiet') return `${t.quietAgent(who, since(t, a.lastAt, at))}${plan ? ` · ${plan}` : ''}`;
  const d = duration(t, a.elapsedMs);
  if (a.state !== 'running') return [who, plan, t.state[a.state] ?? short(a.state, 20), d].filter(Boolean).join(' · ');
  return [who, plan, doingWords(t, a.action), d].filter(Boolean).join(' · ');
}

// The text form of buildView's result, what turbo-run view prints without --json and status --watch redraws: the
// turbo-view pane in plain lines, in the config's language (ui.lang): the verdict line, the reason a phase stopped
// and its helpers, the questions waiting with their options (a terminal has no buttons), the latest commits, the
// supervisor.
export function formatView(v) {
  const t = TEXT[v.ui?.lang === 'ru' ? 'ru' : 'en'];
  const verdict = verdictText(t, v);
  const lanes = list(v.lanes);
  const lines = lanes.length ? [] : [`${t.run} — ${verdict}`];
  lanes.forEach((l, i) => {
    const d = duration(t, l.elapsedMs);
    lines.push([`${t.phase(short(l.phase, 20))} — ${stepWord(t, l.step)}`, d && (l.status === 'done' ? t.took(d) : t.going(d)), i === 0 ? verdict : null].filter(Boolean).join(' · '));
    if (l.reason) lines.push(`  ${t.reason}: ${short(l.reason, 200)}`);
    const agents = list(l.agents);
    const finished = agents.filter((a) => !ACTIVE.has(a.state));
    for (const a of [...agents.filter((x) => ACTIVE.has(x.state)), ...finished.slice(0, FINISHED_SHOWN)]) lines.push(`  ${agentLine(t, a, v.at)}`);
    if (finished.length > FINISHED_SHOWN) lines.push(`  ${t.moreDone(finished.length - FINISHED_SHOWN)}`);
  });
  const questions = list(v.questions);
  if (questions.length) {
    lines.push('', t.askHead(questions.length));
    for (const q of questions) {
      const where = planWords(t, q) ?? (q.phase != null && q.phase !== '' ? t.phaseOnly(q.phase) : null);
      lines.push(`  ${short(q.question || q.header || '')}${where ? ` (${where})` : ''}`);
      if (q.context) lines.push(`    ${short(q.context, 200)}`);
      list(q.options).forEach((o, n) => {
        const label = short(typeof o === 'string' ? o : o?.label ?? '');
        lines.push(`    ${n + 1}. ${label}${o?.recommended === true ? ` ★ ${t.recommended}` : ''}${o?.description ? ` — ${short(o.description, 200)}` : ''}`);
      });
    }
  }
  const commits = list(v.commits);
  if (commits.length) lines.push('', t.changes, ...commits.map((c) => `  ${short(c.sha, 12)} ${short(c.subject, 100)}`));
  if (v.supervisor) lines.push('', [supWord(t, v.supervisor), v.range ? t.phases(v.range.from ?? '…', v.range.to ?? '…') : null].filter(Boolean).join(' · '));
  // a view built elsewhere (a test, an older cache) is drawn clean as well
  return lines.map(clean).join('\n');
}
