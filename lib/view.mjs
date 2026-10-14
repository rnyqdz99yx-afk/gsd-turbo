import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { attendedPhases } from './attend.mjs';
import { readOwnerStop } from './autostart.mjs';
import { DEFAULTS, viewRefreshSeconds } from './config.mjs';
import { autoAnswers, readAway } from './away-state.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { claudeHome, runDir } from './paths.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { STEPS, nextStep, readProgress } from './phase-progress.mjs';
import { readLaneStatus } from './run-status.mjs';
import { laneCwd, recordKey, supervisorLanes } from './lanes-state.mjs';
import { comparePhase } from './scheduler.mjs';
import { maskSecrets } from './secrets.mjs';
import { laneAgents, laneTranscript, projectDirs } from './transcripts.mjs';
import { MAX_STALL_WAKES, liveness, longCall } from './liveness.mjs';
import { whichAbsolute } from './which.mjs';

// What view keeps between calls (git-ignored run directory): per transcript file, the transcript layer's last result.
const CACHE_FILE = 'view-cache.json';
const CACHE_VERSION = 1;
const COMMITS = 5;
const GIT_TIMEOUT_MS = 5000;
const QUESTIONS_RE = /^p([A-Za-z0-9._-]+)-questions\.json$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Minutes without a transcript write before a subagent or a lane reads as quiet (config stall_minutes, at least 1),
// unless a command of it is in flight within its timeout (lib/liveness.mjs).
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
// A phases directory that cannot be read (EACCES, ENOTDIR) counts nothing: view only shows.
export function plansOf(root, phase) {
  try {
    const dir = findPhaseDir(root, phase);
    const plans = dir ? phaseArtifacts(dir).plans : [];
    return plans.length ? { done: plans.filter((p) => p.hasSummary).length, total: plans.length } : null;
  } catch {
    return null;
  }
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

// Stage 4 (reconcile R4): why the next phase waits is the scheduler's (supervisor.json next, written every tick:
// { phase, why, waitsFor, gate? }); the view carries it cleaned and never computes it again. null for a finished run,
// a reason this view does not know, or anything it cannot show.
export const WAIT_KINDS = Object.freeze(['deps', 'areas', 'gates', 'slots', 'annotation', 'merge']);
const idText = (v) => (typeof v === 'string' || typeof v === 'number' ? clean(String(v)) : '');
export function shownNext(sup) {
  const next = isObj(sup) && !sup.finished ? sup.next : null;
  if (!isObj(next) || !WAIT_KINDS.includes(next.why)) return null;
  const phase = idText(next.phase);
  if (!phase) return null;
  const gate = idText(next.gate);
  return { phase, why: next.why, waitsFor: list(next.waitsFor).map(idText).filter(Boolean), gate: gate || null };
}

// One lane of the view (Stage 4: supervisorLanes' entry). Its run files (progress, lane record, push) are the control
// root's; its phase files and its Claude Code transcripts are in the directory it works in (laneCwd: its slot, root
// in checkout mode). The record follows L1's recordKey: p<N>.json for a phase and its prep, pannotate.json for the
// annotation, which has no phase, steps, plans or push. agents false reads no transcript.
// Liveness (lib/liveness.mjs) is the lane's whole session tree, its own transcript and every subagent's: lastAt is its
// newest write, quiet means silent with no helper at work (as the supervisor reads it), busy ({ since }) a long command
// in flight within its timeout while the lane runs; the count starts again at the lane's launch and at the
// supervisor's last stall wake, as the supervisor counts it. wake is what the supervisor did about a silence
// (supervisor.json lane.stall): { count, how (woke, restarted: a new session in place of one that did not wake, tried:
// it could neither wake nor replace it), told (it wakes no more: it told the owner, or does at its next check) },
// null while it did nothing.
// The lanes the view shows: supervisorLanes' entries a lane can be drawn for (a phase job needs its phase); a slotPath
// that is not a path (hand-edited) reads as none, so the lane is shown and nothing throws.
const viewLanes = (sup, root) => supervisorLanes(sup, root)
  .filter((l) => l.job === 'annotate' || l.phase)
  .map((l) => (l.slotPath == null || typeof l.slotPath === 'string' ? l : { ...l, slotPath: null }));

function laneView({ root, lane, home, now, stall, cache, used, config, agents = true }) {
  const phase = lane.job === 'annotate' || lane.phase == null ? null : clean(lane.phase);
  const dir = laneCwd(root, lane);
  const progress = readProgress(root, phase ?? 'annotate');
  const record = readLaneStatus(root, recordKey(lane));
  // a lane record counts only when written since this lane's launch, as the supervisor reads it
  const fresh = Boolean(record && lane.launchedAt && Date.parse(record.at) >= Date.parse(lane.launchedAt));
  // a lane's sessionId is the background job id claude --bg printed; the job state names the transcript
  const sessionId = typeof lane.sessionId === 'string' ? lane.sessionId : '';
  const main = agents && sessionId ? laneTranscript({ home, root: dir, jobId: sessionId }) : null;
  const t = agents ? laneAgents({ dirs: projectDirs(home, dir), main, root: dir, now, stallMs: stall, cache, used }) : { transcript: null, lastAt: null, agents: [] };
  const launched = Date.parse(lane.launchedAt);
  const nowMs = now.getTime();
  const wake = wakeOf(lane);
  const floorMs = Math.max(Number.isFinite(launched) ? launched : 0, wake ? Date.parse(lane.stall.at) || 0 : 0);
  const live = t.tree ? liveness({ lastMs: t.tree.lastMs, calls: t.tree.calls, nowMs, stallMs: stall, floorMs }) : null;
  const lastMs = Number.isFinite(t.tree?.lastMs) ? t.tree.lastMs : Date.parse(t.lastAt);
  const status = fresh ? clean(record.status) : 'running';
  return {
    key: clean(lane.key),
    job: lane.job,
    // the lane's slot (1, 2, …); 0 for v0.3's lane in the main checkout
    slot: Number.isInteger(lane.slot) && lane.slot >= 0 ? lane.slot : 0,
    phase,
    step: phase === null ? null : nextStep(progress),
    done: progress.done,
    notes: Object.fromEntries(Object.entries(progress.notes).map(([k, v]) => [k, shown(v)])),
    status,
    reason: fresh ? shown(record.reason || '') : '',
    sessionId,
    mode: lane.mode === 'full' ? 'full' : 'safe',
    launchedAt: lane.launchedAt || null,
    elapsedMs: Number.isFinite(launched) ? Math.max(0, now.getTime() - launched) : null,
    transcript: t.transcript,
    lastAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
    quiet: live?.state === 'silent' && !t.agents.some((a) => a.state === 'running'),
    busy: status === 'running' ? longCall(live, nowMs) : null,
    wake,
    agents: t.agents.map(shownAgent),
    push: phase === null ? null : pushOf(root, phase),
    plans: phase === null ? null : plansOf(dir, phase),
    ci: ciRounds(progress, config),
    // the supervisor holds the lane until full mode is back (holdDowngradedLane): it waits for the owner
    held: lane.notified?.downgraded ? 'fullMode' : null,
    // Stage 4: the supervisor stopped this lane alone (L1's haltLane); the other lanes go on
    halted: isObj(lane.halted) || lane.halted === true ? { at: idText(lane.halted?.at) || null } : null,
  };
}

// supervisor.json lane.stall (lib/supervisor.mjs checkStall) as the view tells it; null before any stall wake.
function wakeOf(lane) {
  const s = lane.stall;
  if (!isObj(s) || !Number.isInteger(s.count) || s.count < 1) return null;
  const how = s.relaunched === true ? 'restarted' : s.missed === true ? 'tried' : 'woke';
  return { count: s.count, how, told: lane.notified?.stalled === true || s.count >= MAX_STALL_WAKES };
}

const ownerStopped = (root) => {
  try {
    return Boolean(readOwnerStop(root));
  } catch {
    return false;
  }
};

// Everything turbo-run view shows (spec §4; Stage 4 §8) as one JSON-ready object: supervisor, range, the lanes (each
// with its key, job, slot, step and subagents), the next phase and why it waits, open questions, the last commits. sup
// is supervisor.json (null when absent); running says whether its daemon is alive (the caller owns the heartbeat
// rules). agents false reads no transcript (the notifications' run line). damaged: supervisor.json exists but holds no
// state ({ why, at }, lib/sup-state.mjs readSupervisor): the supervisor is shown damaged, never as never started.
export function buildView({ root, sup, damaged = null, running = false, config = {}, env = process.env, now = new Date(), commits = recentCommits, agents = true }) {
  const home = claudeHome(env);
  const stall = stallMs(config);
  const cacheFile = path.join(runDir(root), CACHE_FILE);
  const cache = agents ? loadCache(cacheFile) : {};
  const used = {};
  const lanes = viewLanes(sup, root).map((lane) => laneView({ root, lane, home, now, stall, cache, used, config, agents }));
  if (agents) saveCache(cacheFile, used, cache);
  return {
    v: 1,
    at: now.toISOString(),
    // stoppedByOwner (Gap 1): turbo-run stop's mark stands; the turbo-view mod then opens the pane only for a question
    supervisor: damaged && !sup ? { running: false, pid: null, finished: false, halted: false, failingSince: null, updatedAt: null, damaged: { why: String(damaged.why ?? ''), at: damaged.at ?? null } } : sup ? { running: Boolean(running), pid: running ? sup.pid ?? null : null, finished: Boolean(sup.finished), halted: Boolean(sup.halted), failingSince: sup.failingSince || null, updatedAt: sup.updatedAt || null, ...(!running && ownerStopped(root) ? { stoppedByOwner: true } : {}) } : null,
    range: sup?.range ? { from: sup.range.from ?? null, to: sup.range.to ?? null } : null,
    lanes,
    // Stage 4: the next phase and why it waits, as the scheduler wrote it (null: none, or checkout mode)
    next: running ? shownNext(sup) : null,
    // the run's unfinished phases as the supervisor last read them (supervisor.json remaining): the chain of the last one
    // ends with the end of the run, also without a range; null from a supervisor that never wrote them
    remaining: Array.isArray(sup?.remaining) ? sup.remaining.map(idText).filter(Boolean) : null,
    questions: openQuestions(root),
    commits: commits(root),
    // phases the owner runs in their own session (turbo-run attend, S4): no lane runs meanwhile
    attended: attendedOrNone(root),
    // v0.4.0: sleep mode (turbo-run away --set; null: the owner is here) and the answers turbo took itself since the owner
    // last came back (turbo-run back), newest first, at most AUTO_SHOWN
    ...awayView(root),
    // what the turbo-view mod (S3) reads from the owner's config: the language it draws in and how often it reads;
    // and the owner's time zone (minutes east of UTC), so its toasts tell the local time whatever zone the mod runs in
    ui: { lang: config?.lang === 'ru' ? 'ru' : 'en', refreshSeconds: viewRefreshSeconds(config), utcOffsetMinutes: -now.getTimezoneOffset() },
  };
}

const AUTO_SHOWN = 5;
function awayView(root) {
  const away = readAway(root);
  const auto = autoAnswers(root, { after: away.ackAt }).slice(0, AUTO_SHOWN).map((a) => ({ phase: a.phase, id: a.id, question: shown(a.question), option: shown(a.option), at: a.at, undo: a.undo }));
  return { away: away.since ? { since: away.since } : null, autoAnswered: auto };
}

// The words turbo-run view and status --watch speak: the turbo-view pane's (mod/hooks/view-model.mjs, which the mod
// carries on its own since it is installed apart from turbo-run), in the config's language. test/view.test.mjs holds
// WORDS and TEXT equal to the pane's, function by function, and the text equal to the pane's lines.
export const WORDS = {
  en: {
    step: { freshness: 'freshness check', discuss: 'discussion', prologue: 'planning prep', plan: 'planning', 'gates-off': 'execution prep', execute: 'running plans', restore: 'restoring settings', fanout: 'quality checks', fix: 'fixes', 'final-gate': 'final check', uat: 'acceptance', close: 'wrap-up', integrate: 'merge into main', ci: 'CI check' },
    agent: { 'gsd-executor': 'Executor', 'gsd-verifier': 'Verifier', 'gsd-code-reviewer': 'Reviewer', 'gsd-code-fixer': 'Fixer', 'gsd-planner': 'Planner', 'gsd-plan-checker': 'Plan checker', 'gsd-phase-researcher': 'Researcher', 'gsd-security-auditor': 'Security auditor', 'gsd-nyquist-auditor': 'Test auditor', 'gsd-integration-checker': 'Integration checker', 'gsd-debugger': 'Debugger', 'turbo-uat': 'Acceptance tester', 'general-purpose': 'Helper', Explore: 'Scout' },
  },
  ru: {
    step: { freshness: 'проверка актуальности', discuss: 'обсуждение', prologue: 'подготовка к планированию', plan: 'планирование', 'gates-off': 'подготовка к выполнению', execute: 'выполняются планы', restore: 'восстановление настроек', fanout: 'проверки качества', fix: 'исправления', 'final-gate': 'финальная проверка', uat: 'приёмка', close: 'завершение', integrate: 'слияние с основной веткой', ci: 'проверка CI' },
    // all masculine, so «… молчит» and «… закончил» agree with each
    agent: { 'gsd-executor': 'Исполнитель', 'gsd-verifier': 'Проверяющий', 'gsd-code-reviewer': 'Ревьюер', 'gsd-code-fixer': 'Исправляющий', 'gsd-planner': 'Планировщик', 'gsd-plan-checker': 'Контролёр плана', 'gsd-phase-researcher': 'Исследователь', 'gsd-security-auditor': 'Аудитор безопасности', 'gsd-nyquist-auditor': 'Аудитор тестов', 'gsd-integration-checker': 'Контролёр связей', 'gsd-debugger': 'Отладчик', 'turbo-uat': 'Приёмщик', 'general-purpose': 'Помощник', Explore: 'Разведчик' },
  },
};

const ruPlural = (n, one, few, many) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
// Phase ids as words: `phase 34`, `phases 33, 34` (one and many name the word in the case the phrase needs).
const ids = (l) => [].concat(l ?? []).map(String);
const idList = (l, one, many) => (ids(l).length > 1 ? `${many} ${ids(l).join(', ')}` : `${one} ${ids(l)[0] ?? ''}`.trim());

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
      fine: 'all fine', answer: (n) => `needs your answer (${n})`, ciRed: (asked) => (asked ? 'CI red — needs your answer' : 'CI red — needs your decision'), ciFixing: (n, m) => `CI red — the phase fixes it itself (attempt ${n} of ${m}), nothing needed from you`,
      ciLast: "CI red — the phase's last attempt; if it fails, it will ask you", fullMode: 'waits for you: its final checks need full mode',
      needsOwner: (asked) => (asked ? 'stopped — waits for your answer' : 'stopped — waits for your decision'), failed: 'stopped by a failure',
      // a silent lane says what turbo did about it (lane.wake): it wakes the session, woke, restarted or could not wake it
  // before, or gave up
      quiet: (d) => `silent${d ? ` for ${d}` : ''} — turbo is waking the session`, quietAgain: (d, how) => `silent${d ? ` for ${d}` : ''} — ${how === 'restarted' ? 'restarted the session' : how === 'tried' ? 'could not wake the session' : 'woke the session'}, waking it again`,
      quietTold: (d) => `silent${d ? ` for ${d}` : ''} — waking the session did not help: needs you`, quietHelper: (who, d, more) => `running, but ⚠️ ${who} silent${d ? ` for ${d}` : ''}${more ? ` (and ${more} more)` : ''}`,
      paused: 'paused: needs a fresh context', done: 'done', halted: 'supervisor stopped', failing: (at) => `supervisor failing${at ? ` since ${at}` : ''}`,
      attended: (p) => `phase ${p} is running in your session`, supStopped: 'supervisor not running', finished: 'all phases done', never: 'supervisor never started',
      // Stage 4: a lane the supervisor stopped alone; a lane whose turn ended and that is merged into main
      laneHalted: 'a lane stopped — the other lanes go on', merging: 'done — being merged into the main branch',
      // supervisor.json exists but holds no state (lib/sup-state.mjs): never «never started»
      damaged: 'supervisor state damaged (likely a machine crash) — run turbo-run start, it rebuilds the lanes',
    },
    reason: 'Reason',
    life: (d) => `last activity ${d} ago`,
    doing: { edit: (x) => `editing ${x}`, write: (x) => `writing ${x}`, read: (x) => `reading ${x}`, search: 'searching the code', files: 'looking for files', tests: 'running tests', commit: 'committing', command: (x) => `running a command: ${x}`, helper: 'started a helper', skill: 'using a skill', web: 'searching the web', todo: 'updating its to-do list', message: 'messaging a helper', browser: 'using the browser', working: 'working' },
    state: { completed: 'done', stopped: 'stopped', failed: 'failed' },
    idle: (d) => `silent${d ? ` for ${d}` : ''}`,
    quietAgent: (who, d) => `⚠️ ${who} silent${d ? ` for ${d}` : ''}`,
    // a command in flight within its timeout: busy, never silent (lib/liveness.mjs)
    busy: (d) => `a long command is running${d ? ` · ${d}` : ''}`,
    helpersDone: (n, more) => `${n} ${more ? 'more ' : ''}${n === 1 ? 'helper' : 'helpers'} finished`,
    askHead: (n) => `Needs your answer (${n}):`,
    // v0.4.0: sleep mode and the answers turbo took itself (lib/auto-answer.mjs)
    awayOn: 'Away mode — turbo takes the safe questions itself; when you are back: turbo-run back',
    autoHead: (n) => `Accepted automatically while you were away (${n}):`,
    undo: 'undo',
    holds: 'The phase waits for this answer',
    ahead: (running) => (running ? 'you can answer ahead — the phase is not waiting' : 'you can answer ahead'),
    recommended: 'recommended',
    changes: 'Latest changes:',
    ago: (d) => `${d} ago`,
    justNow: 'just now',
    days: (n) => `${n}d`,
    sup: { running: 'Supervisor running', stopped: 'Supervisor not running', finished: 'Supervisor finished', halted: 'Supervisor stopped', never: 'Supervisor never started', damaged: 'Supervisor state damaged' },
    phases: (from, to) => `phases ${from}–${to}`,
    duration: (h, m, s) => (h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`),
    // v0.3.3: what the phase does now, its steps, what comes next, when the owner is needed, the commits by kind
    nowHead: 'Now',
    now: {
      ciFix: (n, m) => `fixing the red CI — attempt ${n} of ${m}`, ciLast: 'fixing the red CI — the last attempt', ciWait: 'waiting for CI',
      executors: (n) => (n > 1 ? `writing code for ${n} plans at once` : 'writing code for a plan'), helpers: (n) => `${n} ${n === 1 ? 'helper' : 'helpers'} at work`,
      agent: { 'gsd-code-fixer': 'fixing what the review found', 'gsd-debugger': 'looking for the cause of a failure', 'gsd-code-reviewer': 'reviewing the code', 'gsd-security-auditor': 'checking security', 'gsd-nyquist-auditor': 'checking the tests cover the work', 'gsd-integration-checker': 'checking the parts fit together', 'gsd-verifier': 'checking the phase reached its goal', 'turbo-uat': 'acceptance: checking the items itself', 'gsd-planner': 'writing the plans', 'gsd-plan-checker': 'checking the plans', 'gsd-phase-researcher': 'researching how to build the phase' },
      step: { freshness: 'checking the plans are still current', discuss: 'thinking the phase through', prologue: 'preparing the planning', plan: 'planning', 'gates-off': 'preparing to run the plans', execute: 'running the plans', restore: 'restoring settings', fanout: 'starting the quality checks', fix: 'fixing what the checks found', 'final-gate': 'running the final tests', uat: 'acceptance', close: 'wrapping up the phase', integrate: 'merging the phase into the main branch' },
      gapPlan: 'writing plans to close the gaps the checks found',
    },
    // a lane past its planning whose planner works again: it plans the closing of the gaps a check found
    gapPlan: 'planning gap fixes',
    // a phase the owner attends (turbo-run attend N): it runs in their own session, not in its lane
    inSession: 'is running in your session',
    stepsHead: 'Phase steps:',
    stepNow: (s) => `${s} — now`,
    stepStopped: (s) => `${s} — stopped here`,
    nextHead: 'What comes next:',
    nextPhase: 'next phase',
    runEnd: 'end of the run',
    need: {
      none: 'Nothing needed from you now', held: 'Needed from you: answer the question above — the phase waits for it', ahead: (n) => `You can answer ${n === 1 ? 'the question' : `the ${n} questions`} above ahead`,
      decide: 'Needed from you: the phase waits for your decision — the reason is above', failed: 'Needed from you: the phase stopped by a failure and will not go on by itself', fullMode: 'Needed from you: its final checks need full mode',
      ciLast: 'If the last CI attempt fails, the phase will ask you',
      halted: 'Needed from you: a stopped lane waits for you to resume it',
      stalled: (id) => `Needed from you: the phase stays silent after turbo woke it — to look inside: claude attach ${id}`,
    },
    kind: {
      feat: (n) => `${n} new ${n === 1 ? 'feature' : 'features'}`, fix: (n) => `${n} ${n === 1 ? 'fix' : 'fixes'}`, refactor: (n) => `${n} ${n === 1 ? 'code rework' : 'code reworks'}`,
      test: (n) => `${n} test ${n === 1 ? 'change' : 'changes'}`, docs: (n) => `${n} docs ${n === 1 ? 'change' : 'changes'}`, other: (n) => `${n} other ${n === 1 ? 'change' : 'changes'}`,
    },
    lastAgo: (ago) => `latest ${ago}`,
    // Stage 4: several lanes (spec §8): a lane's slot, what a prep or annotate lane does, the summary line, why the next
    // phase waits (supervisor.json next: its why, the phases it waits for, a shared resource by name)
    lane: (k) => `lane ${k}`,
    // reconcile R12: the annotate job's questions (pseudo-phase annotate)
    markup: 'lane markup',
    stoppedLane: 'stopped — the other lanes go on',
    laneHead: (k) => `Lane ${k}`,
    lanesCount: (n) => `${n} ${n === 1 ? 'lane' : 'lanes'}`,
    questionsCount: (n) => `${n} ${n === 1 ? 'question' : 'questions'}`,
    job: { prep: (s) => `getting ready ahead: ${s}`, annotate: 'working out which phases can run together' },
    gate: { 'prod-deploy': 'the deploy', 'owner-live': 'your live check', 'owner-signature': 'your signature', 'packaged-build': 'the packaged build' },
    waits: {
      deps: (p, l) => `next: phase ${p} waits for ${idList(l, 'phase', 'phases')}`,
      areas: (p, l) => `next: phase ${p} waits for ${idList(l, 'phase', 'phases')} — they change the same files`,
      gates: (p, l, g) => (ids(l).length ? `next: phase ${p} waits for ${idList(l, 'phase', 'phases')} — both need ${g}` : `next: phase ${p} waits its turn for ${g}`),
      slots: (p) => `next: phase ${p} waits for a free lane`,
      annotation: (p) => `next: phase ${p} waits until turbo knows which phases can run together`,
      merge: (p, l) => `next: phase ${p} waits for ${idList(l, 'phase', 'phases')} to be merged`,
    },
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
      fine: 'всё в порядке', answer: (n) => `нужен ваш ответ (${n})`, ciRed: (asked) => (asked ? 'CI красный — нужен ваш ответ' : 'CI красный — нужно ваше решение'), ciFixing: (n, m) => `CI красный — фаза чинит сама (попытка ${n} из ${m}), от вас ничего не нужно`,
      ciLast: 'CI красный — последняя попытка фазы; если не выйдет, она спросит вас', fullMode: 'ждёт вас: для финальных проверок нужен полный режим',
      needsOwner: (asked) => (asked ? 'остановилась — ждёт вашего ответа' : 'остановилась — ждёт вашего решения'), failed: 'остановилась из-за сбоя',
      quiet: (d) => `тишина${d ? ` ${d}` : ''} — turbo будит сессию`, quietAgain: (d, how) => `тишина${d ? ` ${d}` : ''} — ${how === 'restarted' ? 'перезапустил сессию' : how === 'tried' ? 'не смог разбудить сессию' : 'разбудил сессию'}, будит ещё раз`,
      quietTold: (d) => `тишина${d ? ` ${d}` : ''} — разбудить сессию не вышло: нужны вы`, quietHelper: (who, d, more) => `идёт, но ⚠️ ${who} молчит${d ? ` ${d}` : ''}${more ? ` (и ещё ${more})` : ''}`,
      paused: 'на паузе: нужен новый контекст', done: 'готова', halted: 'супервизор остановился', failing: (at) => `супервизор сбоит${at ? ` с ${at}` : ''}`,
      attended: (p) => `фаза ${p} идёт у вас в этой сессии`, supStopped: 'супервизор не работает', finished: 'все фазы готовы', never: 'супервизор не запускался',
      laneHalted: 'полоса остановилась — остальные идут дальше', merging: 'готова — вливается в основную ветку',
      damaged: 'состояние супервизора повреждено (вероятно, сбой машины) — запустите turbo-run start, он восстановит полосы',
    },
    reason: 'Причина',
    life: (d) => `последнее действие ${d} назад`,
    doing: { edit: (x) => `правит ${x}`, write: (x) => `создаёт ${x}`, read: (x) => `читает ${x}`, search: 'ищет в коде', files: 'ищет файлы', tests: 'запустил тесты', commit: 'делает коммит', command: (x) => `выполняет команду: ${x}`, helper: 'запустил помощника', skill: 'запустил навык', web: 'ищет в интернете', todo: 'обновляет список дел', message: 'пишет помощнику', browser: 'работает в браузере', working: 'работает' },
    state: { completed: 'готов', stopped: 'остановлен', failed: 'сбой' },
    idle: (d) => `тишина${d ? ` ${d}` : ''}`,
    quietAgent: (who, d) => `⚠️ ${who} молчит${d ? ` ${d}` : ''}`,
    busy: (d) => `идёт долгая команда${d ? ` · ${d}` : ''}`,
    helpersDone: (n, more) => `${more ? 'ещё ' : ''}${n} ${ruPlural(n, 'помощник закончил', 'помощника закончили', 'помощников закончили')}`,
    askHead: (n) => `Нужен ваш ответ (${n}):`,
    awayOn: 'Режим «ушёл» — безопасные вопросы turbo решает сам; когда вернётесь: turbo-run back',
    autoHead: (n) => `Принято автоматически, пока вас не было (${n}):`,
    undo: 'отменить',
    holds: 'Фаза ждёт этот ответ',
    ahead: (running) => (running ? 'можно ответить заранее — фаза не стоит' : 'можно ответить заранее'),
    recommended: 'рекомендуется',
    changes: 'Последние изменения:',
    ago: (d) => `${d} назад`,
    justNow: 'только что',
    days: (n) => `${n} дн`,
    sup: { running: 'Супервизор работает', stopped: 'Супервизор не работает', finished: 'Супервизор закончил', halted: 'Супервизор остановился', never: 'Супервизор не запускался', damaged: 'Состояние супервизора повреждено' },
    phases: (from, to) => `фазы ${from}–${to}`,
    duration: (h, m, s) => (h ? `${h} ч ${m} мин` : m ? `${m} мин` : `${s} с`),
    nowHead: 'Сейчас',
    now: {
      ciFix: (n, m) => `чинит красный CI — попытка ${n} из ${m}`, ciLast: 'чинит красный CI — последняя попытка', ciWait: 'ждёт результат CI',
      executors: (n) => (n > 1 ? `пишет код по ${n} планам сразу` : 'пишет код по плану'), helpers: (n) => `работают помощники: ${n}`,
      agent: { 'gsd-code-fixer': 'исправляет найденное ревью', 'gsd-debugger': 'ищет причину сбоя', 'gsd-code-reviewer': 'идёт ревью кода', 'gsd-security-auditor': 'проверяет безопасность', 'gsd-nyquist-auditor': 'проверяет, хватает ли тестов', 'gsd-integration-checker': 'проверяет, как части работают вместе', 'gsd-verifier': 'проверяет, достигнута ли цель фазы', 'turbo-uat': 'приёмка: проверяет пункты сама', 'gsd-planner': 'пишет планы', 'gsd-plan-checker': 'проверяет планы', 'gsd-phase-researcher': 'изучает, как сделать фазу' },
      step: { freshness: 'проверяет, не устарели ли планы', discuss: 'обдумывает фазу', prologue: 'готовит планирование', plan: 'планирует', 'gates-off': 'готовится выполнять планы', execute: 'выполняет планы', restore: 'возвращает настройки', fanout: 'запускает проверки качества', fix: 'исправляет найденное проверками', 'final-gate': 'гоняет финальные тесты', uat: 'приёмка', close: 'завершает фазу', integrate: 'вливает фазу в основную ветку' },
      gapPlan: 'пишет планы доработок по итогам проверки',
    },
    gapPlan: 'планирование доработок',
    inSession: 'идёт у вас в этой сессии',
    stepsHead: 'Шаги фазы:',
    stepNow: (s) => `${s} — сейчас`,
    stepStopped: (s) => `${s} — остановилась здесь`,
    nextHead: 'Что дальше:',
    nextPhase: 'следующая фаза',
    runEnd: 'конец прогона',
    need: {
      none: 'От вас сейчас ничего не нужно', held: 'Нужны вы: ответить на вопрос выше — фаза ждёт его', ahead: (n) => (n === 1 ? 'На вопрос выше можно ответить заранее' : `На вопросы выше (${n}) можно ответить заранее`),
      decide: 'Нужны вы: фаза ждёт вашего решения — причина выше', failed: 'Нужны вы: фаза остановилась из-за сбоя и сама не продолжит', fullMode: 'Нужны вы: финальным проверкам нужен полный режим',
      ciLast: 'Если последняя попытка починить CI не выйдет, фаза спросит вас',
      halted: 'Нужны вы: остановленная полоса ждёт, что вы её возобновите',
      stalled: (id) => `Нужны вы: фаза молчит и после пробуждений — посмотреть: claude attach ${id}`,
    },
    kind: {
      feat: (n) => `${n} ${ruPlural(n, 'новая возможность', 'новые возможности', 'новых возможностей')}`, fix: (n) => `${n} ${ruPlural(n, 'исправление', 'исправления', 'исправлений')}`, refactor: (n) => `${n} ${ruPlural(n, 'переделка кода', 'переделки кода', 'переделок кода')}`,
      test: (n) => `${n} ${ruPlural(n, 'правка тестов', 'правки тестов', 'правок тестов')}`, docs: (n) => `${n} ${ruPlural(n, 'правка документов', 'правки документов', 'правок документов')}`, other: (n) => `${n} ${ruPlural(n, 'служебное изменение', 'служебных изменения', 'служебных изменений')}`,
    },
    lastAgo: (ago) => `последнее ${ago}`,
    lane: (k) => `полоса ${k}`,
    markup: 'разметка полос',
    stoppedLane: 'остановилась — остальные полосы идут дальше',
    laneHead: (k) => `Полоса ${k}`,
    lanesCount: (n) => `${n} ${ruPlural(n, 'полоса', 'полосы', 'полос')}`,
    questionsCount: (n) => `${n} ${ruPlural(n, 'вопрос', 'вопроса', 'вопросов')}`,
    job: { prep: (s) => `готовится заранее: ${s}`, annotate: 'разбирает, какие фазы могут идти вместе' },
    // the case after «используют» and «очереди на»
    gate: { 'prod-deploy': 'деплой', 'owner-live': 'вашу живую проверку', 'owner-signature': 'вашу подпись', 'packaged-build': 'сборку пакета' },
    waits: {
      deps: (p, l) => `следующая: фаза ${p} ждёт ${idList(l, 'фазу', 'фазы')}`,
      areas: (p, l) => `следующая: фаза ${p} ждёт ${idList(l, 'фазу', 'фазы')} — они меняют одни и те же файлы`,
      gates: (p, l, g) => (ids(l).length ? `следующая: фаза ${p} ждёт ${idList(l, 'фазу', 'фазы')} — обе используют ${g}` : `следующая: фаза ${p} ждёт своей очереди на ${g}`),
      slots: (p) => `следующая: фаза ${p} ждёт свободную полосу`,
      annotation: (p) => `следующая: фаза ${p} ждёт, пока turbo разберёт, какие фазы могут идти вместе`,
      merge: (p, l) => `следующая: фаза ${p} ждёт слияния ${idList(l, 'фазы', 'фаз')}`,
    },
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
const laneReason = (reason) => clean(reason).replace(/^owner questions?\s+(?:[\w.-]+-t\d+|ask-\d+)\b\s*:?\s*/i, '').trim();

const stepWord = (t, step) => (step == null ? t.allDone : t.step[step] ?? short(step, 40));
const stepNoun = (t, step) => (step == null ? null : t.stepAt[step] ?? stepWord(t, step));
const agentWord = (t, type) => (type ? t.agent[type] ?? short(type, 40) : t.agent['general-purpose']);
const planWords = (t, x) => (x?.plan ? t.plan(x.plan, x.task) : null);
const plansWords = (t, lane) => (lane?.plans?.total > 0 ? t.plans(lane.plans.done, lane.plans.total) : null);

// The pane's slotOf, laneHeadText, stepText, gateWord, waitsWords and summaryLine (Stage 4 L4).
const slotOf = (lane) => (Number.isInteger(lane?.slot) && lane.slot >= 1 ? lane.slot : null);
const laneHeadText = (t, lane) => (lane.job === 'annotate' ? t.laneHead(slotOf(lane) ?? '–') : `${t.phase(short(lane.phase, 20))}${slotOf(lane) ? ` · ${t.lane(slotOf(lane))}` : ''}`);
// The pane's gapPlanning and attendedLane.
const GAP_PLANNERS = new Set(['gsd-planner', 'gsd-plan-checker']);
const gapPlanning = (lane) => (lane?.job ?? 'phase') === 'phase' && STEPS.indexOf(lane?.step) > STEPS.indexOf('plan')
  && list(lane?.agents).some((a) => ACTIVE.has(a?.state) && GAP_PLANNERS.has(a.type));
const stepText = (t, lane) => (lane.job === 'annotate' ? t.job.annotate : lane.job === 'prep' ? t.job.prep(stepWord(t, lane.step)) : gapPlanning(lane) ? t.gapPlan : stepWord(t, lane.step));
const attendedLane = (v, lane) => (lane?.job ?? 'phase') === 'phase' && lane?.phase != null && list(v?.attended).some((p) => String(p) === String(lane.phase));
const waitsFor = (v, q) => q?.stopped === true && !list(v?.attended).some((p) => String(p) === String(q.phase ?? ''));
const gateWord = (t, g) => (Object.hasOwn(t.gate, String(g)) ? t.gate[String(g)] : short(g, 30));
const NAMES_FOR = new Set(['deps', 'areas', 'merge']);
function waitsWords(t, next) {
  if (!next || next.phase == null || !Object.hasOwn(t.waits, String(next.why))) return null;
  const all = list(next.waitsFor);
  const on = [...all.slice(0, 3).map((x) => short(x, 20)), ...(all.length > 3 ? ['…'] : [])];
  if (NAMES_FOR.has(next.why) && !on.length) return null;
  if (next.why === 'gates' && (next.gate == null || next.gate === '')) return null;
  return t.waits[next.why](short(next.phase, 20), on, next.gate == null ? '' : gateWord(t, next.gate));
}
function summaryLine(t, view) {
  const asked = list(view?.questions).length;
  return [t.lanesCount(list(view?.lanes).length), asked ? t.questionsCount(asked) : null, waitsWords(t, view?.next)].filter(Boolean).join(' · ');
}
const textFor = (lang) => TEXT[lang === 'ru' ? 'ru' : 'en'];
// The run's summary line while two or more lanes run (the notifications carry it), else null.
export const runLine = (view) => (list(view?.lanes).length > 1 ? clean(summaryLine(textFor(view?.ui?.lang), view)) : null);
// reconcile R4: a Next (supervisor.json next) in the owner's words, `next: phase 36 waits for phase 34`; null for none
// or a reason this view does not know. A formatter only: the scheduler decides.
export function waitReason(next, lang = 'en') {
  const s = waitsWords(textFor(lang), next);
  return s === null ? null : clean(s);
}

// A notification with the run's summary line under its body (Stage 4 D11); unchanged without one.
export const withRunLine = (note, line) => (line ? { ...note, body: note.body ? `${note.body}\n${line}` : line } : note);

// The summary line for a notification the supervisor sends now: supervisor.json read fresh, no transcript read, no
// commit listed; null with fewer than two lanes or anything unreadable (a notification never fails for it).
export function runLineFor(root, config, { env = process.env, now = new Date(), leaving = null } = {}) {
  try {
    const read = readJson(path.join(runDir(root), 'supervisor.json'), null);
    // a lane whose end this notification tells (phaseDone) is still in supervisor.json: it is left out
    const gone = (l) => leaving != null && l.job === 'phase' && l.phase === String(leaving);
    const sup = isObj(read?.lanes) ? { ...read, lanes: Object.fromEntries(Object.entries(read.lanes).filter(([k, l]) => !(isObj(l) && gone({ job: l.job ?? 'phase', phase: String(l.phase ?? k) })))) } : read;
    if (viewLanes(sup, root).length < 2) return null;
    return runLine(buildView({ root, sup, running: true, config: config ?? {}, env, now, commits: () => [], agents: false }));
  } catch {
    return null;
  }
}

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
  if (lane?.push?.ci !== 'red' || lane.status !== 'running' || lane.held || !Number.isInteger(m) || m < 1) return null;
  // at the bound or past it the run in progress is the last one: never "nothing needed from you"
  return { n: Math.min(Math.max(1, fixes), m), m, last: fixes >= m };
}

const ciWords = (t, fix) => (fix.last ? t.verdict.ciLast : t.verdict.ciFixing(fix.n, fix.m));

// The pane's selfFixing: the one condition of Now and the red-CI line.
const selfFixing = (v, l) => (v.supervisor?.running ? ciFixing(l) : null);

// The pane's quietWords and gaveUp: a silent lane in words with what the supervisor did about it (lane.wake), and a
// silent lane the supervisor gave up waking (it told the owner).
function quietWords(t, l, at) {
  const d = since(t, l.lastAt, at);
  if (l.wake?.told) return t.verdict.quietTold(d);
  return l.wake?.count > 0 ? t.verdict.quietAgain(d, l.wake.how) : t.verdict.quiet(d);
}
const gaveUp = (v, l) => Boolean(v?.supervisor?.running) && l?.status === 'running' && Boolean(l.quiet) && l.wake?.told === true;

// The pane's verdict, first match: { kind, text }.
function verdictOf(t, v) {
  const lanes = list(v.lanes).filter((l) => !attendedLane(v, l));
  const sup = v.supervisor;
  const live = Boolean(sup?.running);
  const asked = list(v.questions).length;
  const has = (s) => lanes.some((l) => l.status === s);
  const out = (kind, text = t.verdict[kind]) => ({ kind, text });
  if (sup?.damaged) return out('damaged');
  if (sup?.halted) return out('halted');
  if (live && sup.failingSince) return out('failing', t.verdict.failing(clockText(sup.failingSince)));
  const attended = list(v.attended)[0];
  if (attended != null && !lanes.length) return out('attended', t.verdict.attended(short(attended, 20)));
  if (sup && !live && !sup.finished) return out('supStopped');
  if (has('failed')) return out('failed');
  if (lanes.some((l) => l.halted)) return out('laneHalted');
  if (has('needs-owner')) return out('needsOwner', t.verdict.needsOwner(asked));
  if (lanes.some((l) => l.held === 'fullMode')) return out('fullMode');
  const red = lanes.find((l) => l.push?.ci === 'red');
  const fixing = red ? ciFixing(red) : null;
  if (red && !fixing) return out('ciRed', t.verdict.ciRed(asked));
  if (asked) return out('answer', t.verdict.answer(asked));
  if (fixing) return out('ciFixing', ciWords(t, fixing));
  if (live) {
    const quiet = lanes.find((l) => l.quiet && l.status === 'running');
    if (quiet) return out('quiet', quietWords(t, quiet, v.at));
    const silent = lanes.filter((l) => l.status === 'running').flatMap((l) => list(l.agents)).filter((a) => a.state === 'quiet').sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));
    if (silent.length) return out('quietHelper', t.verdict.quietHelper(agentWord(t, silent[0].type), since(t, silent[0].lastAt, v.at), silent.length - 1));
  }
  if (lanes.length && lanes.every((l) => l.status === 'done')) return attended != null ? out('attended', t.verdict.attended(short(attended, 20))) : out('done');
  if (has('paused-context')) return out('paused');
  if (!sup) return lanes.length ? out('fine') : out('never');
  if (!live) return out('finished');
  return out('fine');
}

function supWord(t, sup) {
  if (!sup) return t.sup.never;
  if (sup.damaged) return t.sup.damaged;
  if (sup.running) return t.sup.running;
  if (sup.halted) return t.sup.halted;
  return sup.finished ? t.sup.finished : t.sup.stopped;
}

// The pane's lane line, in text: running, held by a supervisor that does not run, or stopped/finished/paused.
const LANE_KINDS = { 'needs-owner': 'needsOwner', failed: 'failed', done: 'done', 'paused-context': 'paused', ready: 'merging', prepped: 'merging', annotated: 'merging' };
const kindOfLane = (v, l) => (attendedLane(v, l) ? 'attended' : l.halted ? 'laneHalted' : l.held === 'fullMode' ? 'fullMode' : LANE_KINDS[l.status]);
function laneLine(t, v, l, verdict, asked) {
  const kind = kindOfLane(v, l);
  const held = !kind && v.supervisor && !v.supervisor.running;
  const form = kind ? 'state' : held ? 'held' : 'running';
  const ran = form === 'running' ? l.elapsedMs : Date.parse(l.lastAt) - Date.parse(l.launchedAt);
  const dur = kind === 'attended' ? null : duration(t, Number.isFinite(ran) ? ran : l.elapsedMs);
  const head = laneHeadText(t, l);
  const plans = plansWords(t, l);
  const tail = verdict && verdict.kind !== kind ? verdict.text : null;
  if (form === 'running') return [`${head} — ${stepText(t, l)}`, plans, dur, tail].filter(Boolean).join(' · ');
  if (form === 'held') return [`${head} ${t.stoppedAt(stepNoun(t, l.step))}`, plans, dur, tail].filter(Boolean).join(' · ');
  const state = kind === 'attended' ? t.inSession : kind === 'laneHalted' ? t.stoppedLane : kind === 'needsOwner' ? t.verdict.needsOwner(asked) : t.verdict[kind];
  const noun = stepNoun(t, l.step);
  return [`${head} ${state}`, noun && t.atStep(noun), plans, dur && (l.status === 'done' ? t.took(dur) : dur), tail].filter(Boolean).join(' · ');
}

// The pane's laneAlert and laneSlot (Stage 4 D7, D10).
function laneAlert(v, l) {
  const attended = attendedLane(v, l);
  if (!attended && (l.held === 'fullMode' || l.halted || l.status === 'needs-owner' || l.status === 'failed' || l.status === 'paused-context')) return true;
  if (l.push?.ci === 'red') return true;
  const own = l.job === 'annotate' ? 'annotate' : l.phase;
  if (own != null && list(v?.questions).some((q) => String(q?.phase ?? '') === String(own))) return true;
  return !attended && Boolean(v?.supervisor?.running) && l.status === 'running' && (Boolean(l.quiet) || list(l.agents).some((a) => a.state === 'quiet'));
}
const laneSlot = (v, phase) => {
  const of = (job) => list(v?.lanes).find((l) => (l.job ?? 'phase') === job && String(l.phase) === String(phase) && slotOf(l));
  return slotOf(of('phase') ?? of('prep'));
};

function agentLine(t, a, at, live) {
  const who = agentWord(t, a.type);
  const plan = planWords(t, a);
  if (a.state === 'quiet' && live) return `${t.quietAgent(who, since(t, a.lastAt, at))}${plan ? ` · ${plan}` : ''}`;
  if (a.state === 'quiet') return [who, plan, t.idle(since(t, a.lastAt, at))].filter(Boolean).join(' · ');
  // a long command in flight: calm, its time since it started
  if (a.busy) return [who, plan, t.busy(since(t, a.busy.since, at))].filter(Boolean).join(' · ');
  return [who, plan, doingWords(t, a.action), duration(t, a.elapsedMs)].filter(Boolean).join(' · ');
}

const lastSign = (lane) => {
  const times = [lane.lastAt, ...list(lane.agents).map((a) => a.lastAt)].filter((x) => Number.isFinite(Date.parse(x)));
  return times.length ? times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
};

// The pane's tones (mod/hooks/view-model.mjs TONES) for the verdict kinds and the lane states; formatView colours a line
// by them when asked (status --watch on a terminal).
const VERDICT_TONES = { damaged: 'bad', laneHalted: 'bad', halted: 'bad', failing: 'bad', attended: 'plain', supStopped: 'warn', failed: 'bad', needsOwner: 'bad', fullMode: 'bad', ciRed: 'bad', answer: 'warn', ciFixing: 'warn', quiet: 'warn', quietHelper: 'warn', done: 'ok', paused: 'warn', never: 'dim', fine: 'ok', finished: 'ok' };
const STATE_TONES = { needsOwner: 'bad', failed: 'bad', done: 'ok', paused: 'warn', fullMode: 'bad', laneHalted: 'bad', merging: 'ok' };
// SGR codes of each tone: green, amber (yellow), red, dim, bold; plain lines stay bare.
const SGR = { ok: '32', warn: '33', bad: '31', dim: '2', bold: '1' };

// The pane's laneForm: 'state' (it stopped, finished or pauses), 'held' (the supervisor does not run), else 'running'.
function laneForm(v, l) {
  if (attendedLane(v, l) || l.held === 'fullMode' || l.halted || LANE_KINDS[l.status]) return 'state';
  return v.supervisor && !v.supervisor.running ? 'held' : 'running';
}

// The pane's nowOf (v0.3.3 D2): what the running phase does now, { tone, text }, or null.
const NOW_ORDER = ['gsd-code-fixer', 'gsd-debugger', 'gsd-code-reviewer', 'gsd-security-auditor', 'gsd-nyquist-auditor', 'gsd-integration-checker', 'gsd-verifier', 'turbo-uat', 'gsd-executor', 'gsd-planner', 'gsd-plan-checker', 'gsd-phase-researcher'];
function nowOf(t, v, l) {
  if (!l || laneForm(v, l) !== 'running') return null;
  const fix = selfFixing(v, l);
  if (fix) return { tone: 'warn', text: fix.last ? t.now.ciLast : t.now.ciFix(fix.n, fix.m) };
  const plain = (s) => ({ tone: 'plain', text: s });
  const working = list(l.agents).filter((a) => a.state === 'running');
  if (l.job === 'annotate' && !working.length) return null;
  if (working.length) {
    const type = NOW_ORDER.find((x) => working.some((a) => a.type === x));
    if (type === 'gsd-executor') return plain(t.now.executors(working.filter((a) => a.type === type).length));
    if (type === 'gsd-planner' && gapPlanning(l)) return plain(t.now.gapPlan);
    return plain(type ? t.now.agent[type] : t.now.helpers(working.length));
  }
  if (l.push?.ci === 'pending') return plain(t.now.ciWait);
  return plain(l.step == null ? t.allDone : t.now.step[l.step] ?? short(l.step, 40));
}

// The pane's phaseSteps (D5): [{ step, state }], GSD's gates switching steps and integrate (a slot lane's merge, Stage 4)
// left out unless the lane is at one.
const GATE_STEPS = new Set(['gates-off', 'restore', 'integrate']);
function phaseSteps(l) {
  if (!l || l.status === 'done' || l.job === 'annotate') return [];
  const at = l.step == null ? STEPS.length : STEPS.indexOf(l.step);
  if (at < 0) return [{ step: l.step, state: 'now' }];
  return STEPS.map((step, i) => ({ step, state: i < at ? 'done' : i === at ? 'now' : 'ahead' })).filter((s) => s.state === 'now' || !GATE_STEPS.has(s.step));
}

// The pane's stepHalt (F4: a lane the supervisor merges goes on).
const MERGING = new Set(['ready', 'prepped', 'annotated']);
function stepHalt(v, l) {
  if (laneForm(v, l) === 'running' || attendedLane(v, l)) return null;
  const asks = list(v?.questions).some((q) => String(q?.phase ?? '') === String(l.phase));
  if (MERGING.has(l.status) && !l.halted && l.held !== 'fullMode' && v?.supervisor?.running && !asks) return null;
  return l.status === 'needs-owner' || l.status === 'failed' || l.held === 'fullMode' || l.halted ? 'bad' : 'warn';
}

// The pane's nextOf (D4): { chain, needs: [{ tone, text }] }, or null.
function nextOf(t, v, l) {
  if (!l || l.status === 'done' || l.job === 'annotate') return null;
  const ahead = phaseSteps(l).filter((s) => s.state === 'ahead').map((s) => stepWord(t, s.step));
  const last = lastPhase(v, l);
  const questions = list(v.questions);
  const held = questions.filter((q) => waitsFor(v, q)).length;
  const needs = [];
  const need = (tone, s) => needs.push({ tone, text: s });
  const own = !attendedLane(v, l);
  if (held) need('bad', t.need.held);
  else if (own && l.status === 'needs-owner') need('bad', t.need.decide);
  if (own && l.status === 'failed') need('bad', t.need.failed);
  if (own && l.held === 'fullMode') need('bad', t.need.fullMode);
  if (own && l.halted) need('bad', t.need.halted);
  if (own && gaveUp(v, l)) need('bad', t.need.stalled(short(l.sessionId ?? '', 64)));
  if (questions.length > held) need('warn', t.need.ahead(questions.length - held));
  if (selfFixing(v, l)?.last) need('warn', t.need.ciLast);
  if (!needs.length) need('ok', t.need.none);
  return { chain: [...ahead, last ? t.runEnd : t.nextPhase].join(' → '), needs };
}

// The pane's lastPhase.
function lastPhase(v, l) {
  const id = String(l.phase);
  if (v?.range?.to != null && String(v.range.to) === id) return true;
  return Array.isArray(v?.remaining) && v.remaining.length > 0 && v.remaining.every((p) => String(p) === id);
}

// The pane's nextOfRun (Stage 4 D7).
function nextOfRun(t, v) {
  const lanes = list(v?.lanes).filter((l) => !attendedLane(v, l));
  const questions = list(v?.questions);
  const held = questions.filter((q) => waitsFor(v, q)).length;
  const needs = [];
  const need = (tone, s) => needs.push({ tone, text: s });
  if (held) need('bad', t.need.held);
  else if (lanes.some((l) => l.status === 'needs-owner')) need('bad', t.need.decide);
  if (lanes.some((l) => l.status === 'failed')) need('bad', t.need.failed);
  if (lanes.some((l) => l.held === 'fullMode')) need('bad', t.need.fullMode);
  if (lanes.some((l) => l.halted)) need('bad', t.need.halted);
  const stalled = lanes.find((l) => gaveUp(v, l));
  if (stalled) need('bad', t.need.stalled(short(stalled.sessionId ?? '', 64)));
  if (questions.length > held) need('warn', t.need.ahead(questions.length - held));
  if (lanes.some((l) => selfFixing(v, l)?.last)) need('warn', t.need.ciLast);
  if (!needs.length) need('ok', t.need.none);
  return { chain: null, needs };
}

// The pane's commitsOf (D3): the latest commits counted by their conventional-commit type, never a subject.
const KINDS = ['feat', 'fix', 'refactor', 'test', 'docs', 'other'];
const kindOf = (subject) => {
  const k = /^([A-Za-z]+)(?:\([^)]*\))?!?:/.exec(clean(subject).trim())?.[1].toLowerCase();
  return KINDS.includes(k) ? k : 'other';
};
function commitsOf(t, v) {
  const commits = list(v.commits);
  if (!commits.length) return null;
  const counts = new Map();
  for (const c of commits) {
    const k = kindOf(c?.subject);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const kinds = [...counts].sort((a, b) => b[1] - a[1] || KINDS.indexOf(a[0]) - KINDS.indexOf(b[0])).map(([k, n]) => t.kind[k](n)).join(', ');
  const ago = agoText(t, commits[0]?.at, v.at);
  return { kinds, last: ago ? t.lastAgo(ago) : null };
}

// The text form of buildView's result, what turbo-run view prints without --json and status --watch redraws: the
// turbo-view pane in plain lines, in the config's language (ui.lang): the verdict line, what the phase does now, the
// sign of life, the reason a phase stopped and its helpers, the questions (the ones the phase waits for first) with
// their options (a terminal has no buttons), what comes next and when the owner is needed, the phase's steps, the
// latest commits by kind, the supervisor. Several lanes (Stage 4 D7): the verdict and the summary line on top, a
// block per lane (past two lanes a calm one is its line), the owner's needs across lanes, no steps. color: each line
// in the SGR of its tone (the pane's colours), reset at its end; a line is cleaned before it is coloured, so
// repository text never brings its own escapes.
export function formatView(v, { color = false } = {}) {
  const t = TEXT[v.ui?.lang === 'ru' ? 'ru' : 'en'];
  const verdict = verdictOf(t, v);
  const live = Boolean(v.supervisor?.running);
  const asked = list(v.questions).length;
  const lanes = list(v.lanes);
  const multi = lanes.length > 1;
  const lines = [];
  const say = (text, tone = null) => lines.push([text, tone]);
  if (!lanes.length || multi) say(`${t.run} — ${verdict.text}`, VERDICT_TONES[verdict.kind]);
  if (multi) say(summaryLine(t, v));
  lanes.forEach((l, i) => {
    const kind = kindOfLane(v, l);
    const first = !multi && i === 0;
    say(laneLine(t, v, l, first ? verdict : null, asked), first ? VERDICT_TONES[verdict.kind] : STATE_TONES[kind] ?? null);
    if (lanes.length > 2 && !laneAlert(v, l)) return;
    // the pane's: an attended lane keeps only a red CI under its line
    if (kind === 'attended') {
      if (l.push?.ci === 'red') say(`  ${t.verdict.ciRed(asked)}`, 'bad');
      return;
    }
    const now = nowOf(t, v, l);
    if (now) say(`  ${t.nowHead}: ${now.text}`, now.tone === 'plain' ? null : now.tone);
    const sign = lastSign(l);
    // a long command in flight takes the place of the last activity, calm: the lane is busy, not silent
    if (l.busy) say(`  ${t.busy(since(t, l.busy.since, v.at))}`, 'dim');
    else if (sign) say(`  ${t.life(since(t, sign, v.at) ?? '-')}`, live && l.quiet ? 'warn' : 'dim');
    // a red CI the verdict does not speak of is said under it all the same, unless Now says the phase fixes it (the pane's)
    const fixing = selfFixing(v, l);
    if (l.push?.ci === 'red' && !fixing && !(first && (verdict.kind === 'ciRed' || verdict.kind === 'ciFixing'))) say(`  ${t.verdict.ciRed(asked)}`, 'bad');
    const why = laneReason(l.reason);
    if (why) say(`  ${t.reason}: ${short(why, 200)}`, l.status === 'needs-owner' || l.status === 'failed' ? 'bad' : 'dim');
    const agents = list(l.agents);
    const working = agents.filter((a) => ACTIVE.has(a.state));
    for (const a of working) say(`  ${agentLine(t, a, v.at, live)}`, a.state === 'quiet' ? (live ? 'warn' : 'dim') : live ? null : 'dim');
    if (agents.length > working.length) say(`  ${t.helpersDone(agents.length - working.length, working.length > 0)}`, 'dim');
  });
  const questions = [...list(v.questions)].sort((a, b) => waitsFor(v, b) - waitsFor(v, a));
  if (questions.length) {
    say('');
    say(t.askHead(questions.length), 'warn');
    for (const q of questions) {
      const phase = String(q.phase ?? '');
      const running = live && lanes.some((l) => String(l.phase) === phase && l.status === 'running');
      const slot = laneSlot(v, phase);
      const where = [planWords(t, q) ?? (phase === 'annotate' ? t.markup : phase ? t.phaseOnly(phase) : null), slot ? t.lane(slot) : null].filter(Boolean).join(' · ') || null;
      say(`  ${waitsFor(v, q) ? t.holds : t.ahead(running)}`, waitsFor(v, q) ? 'bad' : 'dim');
      say(`  ${short(q.question || q.header || '')}${where ? ` (${where})` : ''}`, 'bold');
      if (q.context) say(`    ${short(q.context, 200)}`, 'dim');
      list(q.options).forEach((o, n) => {
        const label = short(typeof o === 'string' ? o : o?.label ?? '');
        say(`    ${n + 1}. ${label}${o?.recommended === true ? ` ★ ${t.recommended}` : ''}${o?.description ? ` — ${short(o.description, 200)}` : ''}`);
      });
    }
  }
  // v0.4.0: away mode and the answers turbo took itself (the pane's awaySection)
  const auto = list(v.autoAnswered);
  if (v.away || auto.length) {
    say('');
    if (v.away) say(t.awayOn, 'warn');
    if (auto.length) say(t.autoHead(auto.length), 'warn');
    for (const a of auto) {
      say(`  ${short(a?.question ?? '', 300)} → ${short(a?.option ?? '', 80)}`);
      say(`    ${t.undo}: ${short(a?.undo ?? '', 200)}`, 'dim');
    }
  }
  const lane = lanes[0] ?? null;
  const next = multi || lane?.job === 'prep' ? nextOfRun(t, v) : nextOf(t, v, lane);
  if (next) {
    say('');
    say(t.nextHead, 'bold');
    if (next.chain) say(`  ${next.chain}`);
    for (const n of next.needs) say(`  ${n.text}`, n.tone);
  }
  const steps = multi || lane?.job === 'prep' ? [] : phaseSteps(lane);
  if (steps.length) {
    const halt = stepHalt(v, lane);
    say('');
    say(t.stepsHead, 'bold');
    for (const s of steps) {
      const word = stepWord(t, s.step);
      if (s.state === 'done') say(`  ✓ ${word}`, 'dim');
      else if (s.state === 'ahead') say(`  · ${word}`, 'dim');
      else if (halt) say(`  ■ ${t.stepStopped(word)}`, halt);
      else say(`  ▶ ${t.stepNow(word)}`, 'bold');
    }
  }
  const changes = commitsOf(t, v);
  if (changes) {
    say('');
    say(`${t.changes} ${changes.kinds}${changes.last ? ` · ${changes.last}` : ''}`);
  }
  if (v.supervisor) {
    say('');
    say([supWord(t, v.supervisor), v.range ? t.phases(short(v.range.from ?? '…', 20), short(v.range.to ?? '…', 20)) : null].filter(Boolean).join(' · '), 'dim');
  }
  // a view built elsewhere (a test, an older cache) is drawn clean as well; the colour goes on after
  return lines.map(([text, tone]) => {
    const line = clean(text);
    return color && line && SGR[tone] ? `\x1b[${SGR[tone]}m${line}\x1b[0m` : line;
  }).join('\n');
}
