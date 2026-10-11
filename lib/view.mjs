import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { attendedPhases } from './attend.mjs';
import { DEFAULTS, viewRefreshSeconds } from './config.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { claudeHome, runDir } from './paths.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
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

// The last commits of the checkout, newest first: [{ sha, at (the commit time, ISO), subject }]; none outside a git
// repository or before the first commit.
export function recentCommits(root, n = COMMITS) {
  // git by its absolute path from PATH, never one placed in the project (whichAbsolute)
  const git = whichAbsolute('git', { exclude: [root] });
  if (!git) return [];
  let text = '';
  try {
    text = execFileSync(git, ['log', `-${n}`, '--format=%h%x1f%cI%x1f%s'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).map((line) => {
    const [sha, at, ...rest] = line.split('\x1f');
    const ms = Date.parse(at);
    return { sha: clean(sha), at: Number.isFinite(ms) ? new Date(ms).toISOString() : null, subject: shown(rest.join(' ')).slice(0, 200) };
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

// The phase's plans and how many have their SUMMARY (GSD's mark of a plan done): { done, total }; null without a single
// phase directory or before any plan.
export function plansOf(root, phase) {
  const dir = findPhaseDir(root, phase);
  const plans = dir ? phaseArtifacts(dir).plans : [];
  return plans.length ? { done: plans.filter((p) => p.hasSummary).length, total: plans.length } : null;
}

// The red-CI fix rounds of the phase: { fixes (counted so far, phase-p<N>.json attempts.ci), rounds (push.ci_fix_rounds,
// what S2 allows) }.
function ciRounds(progress, config) {
  const rounds = config?.push?.ci_fix_rounds;
  return { fixes: progress.attempts.ci || 0, rounds: Number.isInteger(rounds) && rounds >= 0 ? rounds : DEFAULTS.push.ci_fix_rounds };
}

// The attended phases; none when the run directory cannot be read (view only shows: the supervisor reads the marks
// itself and a damaged one still holds its lanes).
function attendedOrNone(root) {
  try {
    return attendedPhases(root).map((a) => clean(a.phase));
  } catch {
    return [];
  }
}

function laneView({ root, lane, home, now, stall, cache, used, config }) {
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
    plans: plansOf(root, phase),
    ci: ciRounds(progress, config),
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
  const lanes = (sup?.lane ? [sup.lane] : []).map((lane) => laneView({ root, lane, home, now, stall, cache, used, config }));
  saveCache(cacheFile, used, cache);
  return {
    v: 1,
    at: now.toISOString(),
    supervisor: sup ? { running: Boolean(running), pid: running ? sup.pid ?? null : null, finished: Boolean(sup.finished), halted: Boolean(sup.halted), failingSince: sup.failingSince || null, updatedAt: sup.updatedAt || null } : null,
    range: sup?.range ? { from: sup.range.from ?? null, to: sup.range.to ?? null } : null,
    lanes,
    questions: openQuestions(root),
    commits: commits(root),
    // phases the owner runs in their own session (turbo-run attend, S4): no lane runs meanwhile
    attended: attendedOrNone(root),
    // what the turbo-view mod (S3) reads from the owner's config: the language it draws in and how often it reads;
    // and the owner's time zone (minutes east of UTC), so its toasts tell the local time whatever zone the mod runs in
    ui: { lang: config?.lang === 'ru' ? 'ru' : 'en', refreshSeconds: viewRefreshSeconds(config), utcOffsetMinutes: -now.getTimezoneOffset() },
  };
}

// The words turbo-run view and status --watch speak: the turbo-view pane's (mod/hooks/view-model.mjs, which the mod
// carries on its own since it is installed apart from turbo-run), in the config's language. test/view.test.mjs holds
// WORDS and TEXT equal to the pane's, function by function, and the text equal to the pane's lines.
export const WORDS = {
  en: {
    step: { freshness: 'freshness check', discuss: 'discussion', prologue: 'planning prep', plan: 'planning', 'gates-off': 'execution prep', execute: 'running plans', restore: 'restoring settings', fanout: 'quality checks', fix: 'fixes', 'final-gate': 'final check', uat: 'acceptance', close: 'wrap-up', ci: 'CI check' },
    agent: { 'gsd-executor': 'Executor', 'gsd-verifier': 'Verifier', 'gsd-code-reviewer': 'Reviewer', 'gsd-code-fixer': 'Fixer', 'gsd-planner': 'Planner', 'gsd-plan-checker': 'Plan checker', 'gsd-phase-researcher': 'Researcher', 'gsd-security-auditor': 'Security auditor', 'gsd-nyquist-auditor': 'Test auditor', 'gsd-integration-checker': 'Integration checker', 'gsd-debugger': 'Debugger', 'turbo-uat': 'Acceptance tester', 'general-purpose': 'Helper', Explore: 'Scout' },
  },
  ru: {
    step: { freshness: 'проверка актуальности', discuss: 'обсуждение', prologue: 'подготовка к планированию', plan: 'планирование', 'gates-off': 'подготовка к выполнению', execute: 'выполняются планы', restore: 'восстановление настроек', fanout: 'проверки качества', fix: 'исправления', 'final-gate': 'финальная проверка', uat: 'приёмка', close: 'завершение', ci: 'проверка CI' },
    // all masculine, so «… молчит — возможно, завис» agrees with each
    agent: { 'gsd-executor': 'Исполнитель', 'gsd-verifier': 'Проверяющий', 'gsd-code-reviewer': 'Ревьюер', 'gsd-code-fixer': 'Исправляющий', 'gsd-planner': 'Планировщик', 'gsd-plan-checker': 'Контролёр плана', 'gsd-phase-researcher': 'Исследователь', 'gsd-security-auditor': 'Аудитор безопасности', 'gsd-nyquist-auditor': 'Аудитор тестов', 'gsd-integration-checker': 'Контролёр связей', 'gsd-debugger': 'Отладчик', 'turbo-uat': 'Приёмщик', 'general-purpose': 'Помощник', Explore: 'Разведчик' },
  },
};

const ruPlural = (n, one, few, many) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

export const TEXT = {
  en: {
    ...WORDS.en,
    allDone: 'all steps done',
    phase: (p) => `Phase ${p}`,
    phaseOnly: (p) => `phase ${p}`,
    plan: (p, task) => `plan ${p}${task ? `, task ${task}` : ''}`,
    plans: (done, total) => `${done} of ${total} plans done`,
    run: 'Run',
    took: (d) => `took ${d}`,
    // a stopped phase names its step as a noun: `step: plan execution`
    stepAt: { execute: 'plan execution' },
    atStep: (s) => `step: ${s}`,
    stoppedAt: (s) => (s ? `stopped at step: ${s}` : 'stopped'),
    verdict: {
      fine: 'all fine', answer: (n) => `needs your answer (${n})`, ciRed: 'CI red — needs your answer', ciFixing: (n, m) => `CI red — the phase fixes it itself (attempt ${n} of ${m}), nothing needed from you`,
      needsOwner: (asked) => (asked ? 'stopped — waits for your answer' : 'stopped — waits for your decision'), failed: 'stopped by a failure',
      quiet: (d) => `silent${d ? ` for ${d}` : ''} — may be stuck`, quietHelper: (who, d, more) => `running, but ⚠️ ${who} silent${d ? ` for ${d}` : ''}${more ? ` (and ${more} more)` : ''}`,
      paused: 'paused: needs a fresh context', done: 'done', halted: 'supervisor stopped', failing: (at) => `supervisor failing${at ? ` since ${at}` : ''}`,
      attended: (p) => `phase ${p} is in your session — new phases wait`, supStopped: 'supervisor not running', finished: 'all phases done', never: 'supervisor never started',
    },
    reason: 'Reason',
    life: (d) => `last activity ${d} ago`,
    doing: { edit: (x) => `editing ${x}`, write: (x) => `writing ${x}`, read: (x) => `reading ${x}`, search: 'searching the code', files: 'looking for files', tests: 'running tests', commit: 'committing', command: (x) => `running a command: ${x}`, helper: 'started a helper', skill: 'using a skill', web: 'searching the web', todo: 'updating its to-do list', message: 'messaging a helper', browser: 'using the browser', working: 'working' },
    state: { completed: 'done', stopped: 'stopped', failed: 'failed' },
    idle: (d) => `silent${d ? ` for ${d}` : ''}`,
    quietAgent: (who, d) => `⚠️ ${who} silent${d ? ` for ${d}` : ''} — may be stuck`,
    helpersDone: (n, more) => `${n} ${more ? 'more ' : ''}${n === 1 ? 'helper' : 'helpers'} finished`,
    askHead: (n) => `Needs your answer (${n}):`,
    holds: 'The phase waits for this answer',
    ahead: (running) => (running ? 'you can answer ahead — the phase is not waiting' : 'you can answer ahead'),
    recommended: 'recommended',
    changes: 'Latest changes:',
    ago: (d) => `${d} ago`,
    justNow: 'just now',
    days: (n) => `${n}d`,
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
    plans: (done, total) => `${done} из ${total} планов готово`,
    run: 'Прогон',
    took: (d) => `заняла ${d}`,
    stepAt: { execute: 'выполнение планов' },
    atStep: (s) => `шаг: ${s}`,
    stoppedAt: (s) => (s ? `остановлена на шаге: ${s}` : 'остановлена'),
    verdict: {
      fine: 'всё в порядке', answer: (n) => `нужен ваш ответ (${n})`, ciRed: 'CI красный — нужен ваш ответ', ciFixing: (n, m) => `CI красный — фаза чинит сама (попытка ${n} из ${m}), от вас ничего не нужно`,
      needsOwner: (asked) => (asked ? 'остановилась — ждёт вашего ответа' : 'остановилась — ждёт вашего решения'), failed: 'остановилась из-за сбоя',
      quiet: (d) => `тишина${d ? ` ${d}` : ''} — возможно, зависла`, quietHelper: (who, d, more) => `идёт, но ⚠️ ${who} молчит${d ? ` ${d}` : ''}${more ? ` (и ещё ${more})` : ''}`,
      paused: 'на паузе: нужен новый контекст', done: 'готова', halted: 'супервизор остановился', failing: (at) => `супервизор сбоит${at ? ` с ${at}` : ''}`,
      attended: (p) => `фаза ${p} у вас в сессии — новые фазы ждут`, supStopped: 'супервизор не работает', finished: 'все фазы готовы', never: 'супервизор не запускался',
    },
    reason: 'Причина',
    life: (d) => `последнее действие ${d} назад`,
    doing: { edit: (x) => `правит ${x}`, write: (x) => `создаёт ${x}`, read: (x) => `читает ${x}`, search: 'ищет в коде', files: 'ищет файлы', tests: 'запустил тесты', commit: 'делает коммит', command: (x) => `выполняет команду: ${x}`, helper: 'запустил помощника', skill: 'запустил навык', web: 'ищет в интернете', todo: 'обновляет список дел', message: 'пишет помощнику', browser: 'работает в браузере', working: 'работает' },
    state: { completed: 'готов', stopped: 'остановлен', failed: 'сбой' },
    idle: (d) => `тишина${d ? ` ${d}` : ''}`,
    quietAgent: (who, d) => `⚠️ ${who} молчит${d ? ` ${d}` : ''} — возможно, завис`,
    helpersDone: (n, more) => `${more ? 'ещё ' : ''}${n} ${ruPlural(n, 'помощник закончил', 'помощника закончили', 'помощников закончили')}`,
    askHead: (n) => `Нужен ваш ответ (${n}):`,
    holds: 'Фаза ждёт этот ответ',
    ahead: (running) => (running ? 'можно ответить заранее — фаза не стоит' : 'можно ответить заранее'),
    recommended: 'рекомендуется',
    changes: 'Последние изменения:',
    ago: (d) => `${d} назад`,
    justNow: 'только что',
    days: (n) => `${n} дн`,
    sup: { running: 'Супервизор работает', stopped: 'Супервизор не работает', finished: 'Супервизор закончил', halted: 'Супервизор остановился', never: 'Супервизор не запускался' },
    phases: (from, to) => `фазы ${from}–${to}`,
    duration: (h, m, s) => (h ? `${h} ч ${m} мин` : m ? `${m} мин` : `${s} с`),
  },
};

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

function agoText(t, from, to) {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms)) return null;
  if (ms < 60000) return t.justNow;
  return t.ago(ms >= 86400000 ? t.days(Math.floor(ms / 86400000)) : duration(t, ms));
}

// HH:MM in this machine's zone (the owner's: turbo-run runs there).
function clockText(iso) {
  const d = new Date(Date.parse(iso));
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;
}

// The pane's laneReason: without /turbo-phase's `owner question <plan>-t<task>`.
const laneReason = (reason) => clean(reason).replace(/^owner questions?\s+[\w.-]+-t\d+\b\s*:?\s*/i, '').trim();

const stepWord = (t, step) => (step == null ? t.allDone : t.step[step] ?? short(step, 40));
const stepNoun = (t, step) => (step == null ? null : t.stepAt[step] ?? stepWord(t, step));
const agentWord = (t, type) => (type ? t.agent[type] ?? short(type, 40) : t.agent['general-purpose']);
const planWords = (t, x) => (x?.plan ? t.plan(x.plan, x.task) : null);
const plansWords = (t, lane) => (lane?.plans?.total > 0 ? t.plans(lane.plans.done, lane.plans.total) : null);

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

// The pane's ciFixing: a red CI the running phase still fixes itself, { n, m }, else null.
function ciFixing(lane) {
  const m = lane?.ci?.rounds;
  const fixes = Number.isInteger(lane?.ci?.fixes) ? lane.ci.fixes : 0;
  if (lane?.push?.ci !== 'red' || lane.status !== 'running' || !Number.isInteger(m) || m < 1 || fixes > m) return null;
  return { n: Math.min(Math.max(1, fixes), m), m };
}

// The pane's verdict, first match: { kind, text }.
function verdictOf(t, v) {
  const lanes = list(v.lanes);
  const sup = v.supervisor;
  const live = Boolean(sup?.running);
  const asked = list(v.questions).length;
  const has = (s) => lanes.some((l) => l.status === s);
  const out = (kind, text = t.verdict[kind]) => ({ kind, text });
  if (sup?.halted) return out('halted');
  if (live && sup.failingSince) return out('failing', t.verdict.failing(clockText(sup.failingSince)));
  const attended = list(v.attended)[0];
  if (attended != null) return out('attended', t.verdict.attended(short(attended, 20)));
  if (sup && !live && !sup.finished) return out('supStopped');
  if (has('failed')) return out('failed');
  if (has('needs-owner')) return out('needsOwner', t.verdict.needsOwner(asked));
  const red = lanes.find((l) => l.push?.ci === 'red');
  const fixing = red ? ciFixing(red) : null;
  if (red && !fixing) return out('ciRed');
  if (asked) return out('answer', t.verdict.answer(asked));
  if (fixing) return out('ciFixing', t.verdict.ciFixing(fixing.n, fixing.m));
  if (live) {
    const quiet = lanes.find((l) => l.quiet && l.status === 'running');
    if (quiet) return out('quiet', t.verdict.quiet(since(t, quiet.lastAt, v.at)));
    const silent = lanes.filter((l) => l.status === 'running').flatMap((l) => list(l.agents)).filter((a) => a.state === 'quiet').sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));
    if (silent.length) return out('quietHelper', t.verdict.quietHelper(agentWord(t, silent[0].type), since(t, silent[0].lastAt, v.at), silent.length - 1));
  }
  if (lanes.length && lanes.every((l) => l.status === 'done')) return out('done');
  if (has('paused-context')) return out('paused');
  if (!sup) return lanes.length ? out('fine') : out('never');
  if (!live) return out('finished');
  return out('fine');
}

function supWord(t, sup) {
  if (!sup) return t.sup.never;
  if (sup.running) return t.sup.running;
  if (sup.halted) return t.sup.halted;
  return sup.finished ? t.sup.finished : t.sup.stopped;
}

// The pane's lane line, in text: running, held by a supervisor that does not run, or stopped/finished/paused.
const LANE_KINDS = { 'needs-owner': 'needsOwner', failed: 'failed', done: 'done', 'paused-context': 'paused' };
function laneLine(t, v, l, verdict, asked) {
  const kind = LANE_KINDS[l.status];
  const held = !kind && v.supervisor && !v.supervisor.running;
  const form = kind ? 'state' : held ? 'held' : 'running';
  const ran = form === 'running' ? l.elapsedMs : Date.parse(l.lastAt) - Date.parse(l.launchedAt);
  const dur = duration(t, Number.isFinite(ran) ? ran : l.elapsedMs);
  const phase = t.phase(short(l.phase, 20));
  const plans = plansWords(t, l);
  const tail = verdict && verdict.kind !== kind ? verdict.text : null;
  if (form === 'running') return [`${phase} — ${stepWord(t, l.step)}`, plans, dur, tail].filter(Boolean).join(' · ');
  if (form === 'held') return [`${phase} ${t.stoppedAt(stepNoun(t, l.step))}`, plans, dur, tail].filter(Boolean).join(' · ');
  const state = kind === 'needsOwner' ? t.verdict.needsOwner(asked) : t.verdict[kind];
  const noun = stepNoun(t, l.step);
  return [`${phase} ${state}`, noun && t.atStep(noun), plans, dur && (l.status === 'done' ? t.took(dur) : dur), tail].filter(Boolean).join(' · ');
}

function agentLine(t, a, at, live) {
  const who = agentWord(t, a.type);
  const plan = planWords(t, a);
  if (a.state === 'quiet' && live) return `${t.quietAgent(who, since(t, a.lastAt, at))}${plan ? ` · ${plan}` : ''}`;
  if (a.state === 'quiet') return [who, plan, t.idle(since(t, a.lastAt, at))].filter(Boolean).join(' · ');
  return [who, plan, doingWords(t, a.action), duration(t, a.elapsedMs)].filter(Boolean).join(' · ');
}

const lastSign = (lane) => {
  const times = [lane.lastAt, ...list(lane.agents).map((a) => a.lastAt)].filter((x) => Number.isFinite(Date.parse(x)));
  return times.length ? times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
};

// The text form of buildView's result, what turbo-run view prints without --json and status --watch redraws: the
// turbo-view pane in plain lines, in the config's language (ui.lang): the verdict line, the sign of life, the reason a
// phase stopped and its helpers, the questions (the ones the phase waits for first) with their options (a terminal has
// no buttons), the latest commits with their age, the supervisor.
export function formatView(v) {
  const t = TEXT[v.ui?.lang === 'ru' ? 'ru' : 'en'];
  const verdict = verdictOf(t, v);
  const live = Boolean(v.supervisor?.running);
  const asked = list(v.questions).length;
  const lanes = list(v.lanes);
  const lines = lanes.length ? [] : [`${t.run} — ${verdict.text}`];
  lanes.forEach((l, i) => {
    lines.push(laneLine(t, v, l, i === 0 ? verdict : null, asked));
    const sign = lastSign(l);
    if (sign) lines.push(`  ${t.life(since(t, sign, v.at) ?? '-')}`);
    // a red CI the verdict does not speak of is said under it all the same (the pane's)
    const fixing = live ? ciFixing(l) : null;
    if (l.push?.ci === 'red' && !(i === 0 && (verdict.kind === 'ciRed' || verdict.kind === 'ciFixing'))) lines.push(`  ${fixing ? t.verdict.ciFixing(fixing.n, fixing.m) : t.verdict.ciRed}`);
    const why = laneReason(l.reason);
    if (why) lines.push(`  ${t.reason}: ${short(why, 200)}`);
    const agents = list(l.agents);
    const working = agents.filter((a) => ACTIVE.has(a.state));
    for (const a of working) lines.push(`  ${agentLine(t, a, v.at, live)}`);
    if (agents.length > working.length) lines.push(`  ${t.helpersDone(agents.length - working.length, working.length > 0)}`);
  });
  const questions = [...list(v.questions)].sort((a, b) => (b?.stopped === true) - (a?.stopped === true));
  if (questions.length) {
    lines.push('', t.askHead(questions.length));
    for (const q of questions) {
      const phase = String(q.phase ?? '');
      const running = live && lanes.some((l) => String(l.phase) === phase && l.status === 'running');
      const where = planWords(t, q) ?? (phase ? t.phaseOnly(phase) : null);
      lines.push(`  ${q.stopped === true ? t.holds : t.ahead(running)}`);
      lines.push(`  ${short(q.question || q.header || '')}${where ? ` (${where})` : ''}`);
      if (q.context) lines.push(`    ${short(q.context, 200)}`);
      list(q.options).forEach((o, n) => {
        const label = short(typeof o === 'string' ? o : o?.label ?? '');
        lines.push(`    ${n + 1}. ${label}${o?.recommended === true ? ` ★ ${t.recommended}` : ''}${o?.description ? ` — ${short(o.description, 200)}` : ''}`);
      });
    }
  }
  const commits = list(v.commits);
  if (commits.length) {
    lines.push('', t.changes);
    for (const c of commits) {
      const ago = agoText(t, c.at, v.at);
      lines.push(ago ? `  ${short(c.subject, 100)} · ${ago}` : `  ${short(c.sha, 12)} ${short(c.subject, 100)}`);
    }
  }
  if (v.supervisor) lines.push('', [supWord(t, v.supervisor), v.range ? t.phases(short(v.range.from ?? '…', 20), short(v.range.to ?? '…', 20)) : null].filter(Boolean).join(' · '));
  // a view built elsewhere (a test, an older cache) is drawn clean as well
  return lines.map(clean).join('\n');
}
