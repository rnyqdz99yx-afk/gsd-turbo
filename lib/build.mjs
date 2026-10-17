import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { buildSettings, laneEffort, loadConfig } from './config.mjs';
import { acquireSessionSlot, killTree, removeSessionSettings, resumeSession as resumeHeadless, runSession as runHeadless, sessionSettings } from './headless.mjs';
import { BuildLocked, BuildStateDamaged, createSliceWorktree, loadBuildState, mergeSlice, newBuildState, nextReady, planGraph, reconcileBuildState, removeSliceWorktree, runMergeTests, saveBuildState, setSlice, sliceBranch, sliceWorktreePath } from './build-queue.mjs';
import { claimRunner } from './build-lane.mjs';
import { processAlive } from './merge-lock.mjs';
import { recordSessionUsage } from './cost.mjs';
import { askOwner, dropLaneQuestions, liveAnswer, markDelivered, readAnswers, readQuestions } from './questions.mjs';
import { commitPendingAnswers, laneDeliveryMessage, preAnswerText } from './answers.mjs';
import { gsdCoreDir, logsDir, runDir, stateRoot } from './paths.mjs';
import { normalizePhaseId, runGsdJson } from './gsd.mjs';
import { gsdText } from './gates.mjs';
import { writeLaneStatus } from './run-status.mjs';
import { ensureDir, readJson } from './fsx.mjs';
import { mergeFile } from './merge.mjs';
import { lintSlices, slicePathProblem } from './slice-lint.mjs';
import { frontList } from './plan-drafts.mjs';
import { attendMark } from './attend.mjs';
import { readOwnerStop } from './autostart.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { needsResearch, needsSecurity, readPhaseInfo } from './phase-signals.mjs';
import { reviewDiffText, reviewFindings } from './review-loop.mjs';
import { gapRounds } from './gap-rounds.mjs';
import { fillTemplate, rolePrompt } from './roles.mjs';
import { formatProblems } from './slice-lint.mjs';
import { stateSync } from './state-sync.mjs';
import { LEAN_RESEARCH_RULE } from './lane-prompt.mjs';
import { parseUat, retestRows } from './uat.mjs';
import { itemText } from './uat-classify.mjs';
import { pushSettings } from './config.mjs';
import { formatInboxMessage, markRead, unreadInbox } from './inbox.mjs';
import { integrateMain, readyRecord, setMergeHold } from './integrate.mjs';
import { readLaneStatus } from './run-status.mjs';
import { askNamed } from './questions.mjs';
import { isSlot } from './paths.mjs';
import { logPhaseCost } from './cost.mjs';
import { buildPathFor } from './build-lane.mjs';

// Stage 6 B4 (spec docs/specs/2026-10-17-stage-6-lean-design.md §6.1, §6.3–§6.7): `turbo-run build N` runs one GSD
// phase by code. Each step is idempotent and recorded in run/build-p<N>.json next to B2's fields; model work runs only
// in short headless sessions (B1) with the roles' prompts (B3), GSD's agents (--agent) and GSD's workflows. Long
// commands (tests, turbo-run) run as child processes: the sessions' watchdogs and slot heartbeats need a free event
// loop; git and gsd-tools calls in between are short.

export const BUILD_STEPS = Object.freeze(['begin', 'discuss', 'research', 'slice', 'build', 'review', 'verify', 'security', 'uat', 'tests', 'close']);
export const STEP_STATES = Object.freeze(['running', 'done', 'skipped', 'owner', 'stopped']);
export const HALT_KINDS = Object.freeze(['slices', 'slice', 'red', 'review', 'verify', 'security', 'ci', 'session', 'integrate']);
export const BUILD_USAGE = 'usage: turbo-run build <phase> [--resume] [--json]';
export class BuildFailed extends Error {}
// internal control flow: the owner paused the build (attend, stop) / stopped a step at a halt card
class Paused extends Error {}
class Stopped extends Error {}

export const EMPTY_GRAPH = Object.freeze({ nodes: [], edges: [], order: [], dropped: [], graphSha: null });
const TREE_TIMEOUT = fileURLToPath(new URL('./tree-timeout.mjs', import.meta.url));
const TURBO_RUN = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));
const ROLES_DIR = fileURLToPath(new URL('../roles/', import.meta.url));
const LANG_NAMES = { en: 'English', ru: 'Russian' };
const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
const posix = (p) => p.split(path.sep).join('/');

// --- the step record -------------------------------------------------------------------------------------------------

// The step's record patched and stamped; running and owner make it the current step. -> state.steps[step]
export function setStep(state, step, patch = {}, now = new Date()) {
  if (!BUILD_STEPS.includes(step)) throw new Error(`unknown build step: ${step}`);
  if (patch.state !== undefined && !STEP_STATES.includes(patch.state)) throw new Error(`unknown step state: ${patch.state}`);
  state.steps ??= {};
  const rec = { ...(state.steps[step] ?? {}), ...patch, at: iso(now) };
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  state.steps[step] = rec;
  if (patch.state === 'running' || patch.state === 'owner') state.step = step;
  return rec;
}

// --- halt cards (spec §6.3: "then the owner") ----------------------------------------------------------------------

const HALT_WHAT = {
  slices: ['the automatic check of the work plan still finds problems after one correction', 'автоматическая проверка плана работ всё ещё находит ошибки после одного исправления'],
  slice: ['one part of the work did not get built after two tries', 'одна часть работы не собралась за две попытки'],
  red: ['the tests stay red after one fix', 'тесты остаются красными после одного исправления'],
  review: ['the code review still finds a serious problem after the fixes', 'ревью кода после исправлений всё ещё находит серьёзную ошибку'],
  verify: ['the check against the phase goals still finds gaps after the extra rounds', 'сверка с целями фазы всё ещё находит пробелы после дополнительных кругов'],
  security: ['the security check still finds an open threat after one fix', 'проверка безопасности всё ещё находит открытую угрозу после одного исправления'],
  ci: ['CI stays red after the allowed fix rounds', 'CI остаётся красным после разрешённых кругов исправлений'],
  session: ['a step of the build failed twice (no answer, a stall or an error)', 'шаг сборки дважды не получился (нет ответа, зависание или ошибка)'],
  integrate: ['the main branch changed the same places and the merge could not be resolved', 'основная ветка изменила те же места, и слияние не удалось разрешить'],
};
const GO_ON_KINDS = new Set(['slices', 'review', 'verify', 'security']);
const HALT_TEXT = {
  en: {
    question: (n, what) => `Phase ${n}: ${what}. What should the build do?`,
    retry: { label: 'Try again', description: 'the build runs this step once more' },
    // verify at the gap-round limit (B5): the same check again finds the same gaps
    retryGaps: { label: 'Try again', description: 'the build runs one more round of fixes for the gaps, then checks again' },
    goOn: { label: 'Go on', description: 'accept it as it is and go to the next step' },
    stop: (n) => ({ label: 'Stop here', description: `the phase waits; \`turbo-run resume ${n}\` starts it again` }),
  },
  ru: {
    question: (n, what) => `Фаза ${n}: ${what}. Что делать сборке?`,
    retry: { label: 'Ещё раз', description: 'сборка повторит этот шаг' },
    retryGaps: { label: 'Ещё раз', description: 'сборка проведёт ещё один круг доработки и проверит снова' },
    goOn: { label: 'Дальше', description: 'принять как есть и перейти к следующему шагу' },
    stop: (n) => ({ label: 'Остановить', description: `фаза ждёт; \`turbo-run resume ${n}\` запустит её снова` }),
  },
};
const haltWhat = (kind, lang) => HALT_WHAT[kind][lang === 'ru' ? 1 : 0];

// The card a halt asks, in the owner's language. -> askOwner input { question, context, options, recommended }
export function haltQuestion(kind, { phase, lang = 'en' }) {
  if (!HALT_KINDS.includes(kind)) throw new Error(`unknown halt kind: ${kind}`);
  const T = HALT_TEXT[lang === 'ru' ? 'ru' : 'en'];
  const options = [kind === 'verify' ? T.retryGaps : T.retry, ...(GO_ON_KINDS.has(kind) ? [T.goOn] : []), T.stop(phase)];
  return { question: T.question(phase, haltWhat(kind, lang)), context: '', options: options.map((o) => ({ ...o })), recommended: 1 };
}

// What the owner chose on a halt card: retry, go-on, or stop (the last option, or the owner's own words).
function haltChoice(q, r) {
  // the card's option, else the label the answer kept (a delivered lane card leaves the questions file)
  const label = (Number.isInteger(r?.option) ? q.options?.[r.option - 1]?.label : null) ?? (typeof r?.label === 'string' ? r.label : null);
  if (label === HALT_TEXT.en.retry.label || label === HALT_TEXT.ru.retry.label) return 'retry';
  if (label === HALT_TEXT.en.goOn.label || label === HALT_TEXT.ru.goOn.label) return 'go-on';
  return 'stop';
}

// --- the run context -----------------------------------------------------------------------------------------------

function git(root, args) {
  return String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 })).replace(/\r?\n$/, '');
}
const head = (root) => git(root, ['rev-parse', 'HEAD']);

const jsonOf = (text) => {
  const s = String(text ?? '');
  const at = s.search(/[{[]/);
  if (at < 0) return null;
  try {
    return JSON.parse(s.slice(at));
  } catch {
    return null;
  }
};

// turbo-run <args> --project <root> as a child under a time limit that ends its tree; NODE_TEST_CONTEXT removed (a
// nested node --test that inherits it skips every file). -> { code, out }
function turboRunner(root) {
  return (args, { env = {}, logFile = null, timeoutMin = 60 } = {}) => new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    let out = '';
    const child = spawn(process.execPath, [TREE_TIMEOUT, String(timeoutMin * 60000), process.execPath, TURBO_RUN, ...args, '--project', root], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const take = (d) => {
      out += d;
      if (logFile) {
        try {
          fs.appendFileSync(logFile, d);
        } catch { /* the log is a convenience */ }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => resolve({ code: 127, out: `${out}${err.message}\n` }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

function defaultDeps(root, deps) {
  const core = 'core' in deps ? deps.core : gsdCoreDir(root);
  const needCore = () => {
    if (!core) throw new BuildFailed('gsd-core not found');
    return core;
  };
  return {
    core,
    gsd: (args, { json = true } = {}) => (json ? runGsdJson(needCore(), args, { cwd: root }) : gsdText(needCore(), root, args)),
    lint: (r, phase, opts) => lintSlices(r, phase, opts),
    runSession: (opts) => runHeadless(opts),
    resumeSession: (id, answer, opts) => resumeHeadless(id, answer, opts),
    slot: (o) => acquireSessionSlot(o),
    turbo: turboRunner(root),
    integrate: null,
    now: () => new Date(),
    sleep: (ms) => sleepMs(ms),
    pollMs: 5000,
    log: (line) => process.stdout.write(`${line}\n`),
    checkpoint: () => {},
    ...deps,
  };
}

// The phase's build opened: the runner claimed (busy -> BuildFailed with .busy), the state loaded or created with B4's
// fields. -> ctx; ctx.release() frees the runner.
export async function openBuild(root, phase, { resume = false, deps = {} } = {}) {
  phase = normalizePhaseId(phase);
  const claim = claimRunner(root, phase);
  if (claim.busy) {
    const e = new BuildFailed(`phase ${phase}: a build runs already (pid ${claim.busy.pid})`);
    e.busy = claim.busy;
    throw e;
  }
  try {
    const d = defaultDeps(root, deps);
    const config = loadConfig(root);
    const settings = buildSettings(config);
    const dir = runDir(root);
    let state;
    try {
      state = loadBuildState(dir, phase);
    } catch (err) {
      if (err instanceof BuildStateDamaged) throw new BuildFailed(`the build state is damaged: ${err.message}`);
      throw err;
    }
    const resumed = Boolean(state);
    if (!state) {
      const init = d.gsd(['init', 'phase-op', phase]);
      const info = { name: String(init?.phase_name ?? ''), padded: String(init?.padded_phase ?? phase) };
      state = { ...newBuildState({ phase, graph: EMPTY_GRAPH, head: head(root), maxBuilders: settings.maxBuilders, now: d.now() }), step: 'begin', steps: {}, base: null, roundBase: null, gapRounds: 0, info };
      saveBuildState(dir, phase, state);
    }
    state.steps ??= {};
    const ctx = {
      root, phase, control: stateRoot(root), runDir: dir, config, settings, lang: config.lang === 'ru' ? 'ru' : 'en', core: d.core, state, deps: d,
      startedAt: d.now(), dead: false, resumed, resume,
      save: () => {
        if (!ctx.dead) saveBuildState(dir, phase, ctx.state);
      },
      log: (line) => {
        const text = `${iso(d.now())} phase ${phase} build: ${line}`;
        try {
          d.log(text);
        } catch { /* a closed stdout */ }
        try {
          ensureDir(logsDir(root));
          fs.appendFileSync(path.join(logsDir(root), 'supervisor.log'), `${text}\n`);
        } catch { /* the log is a convenience */ }
      },
      release: () => claim.release(),
    };
    return ctx;
  } catch (err) {
    claim.release();
    throw err;
  }
}

// The current round's plans as B2's graph fields; B4's fields and hold kept; saved.
export function adoptRound(ctx, { round }) {
  const graph = planGraph(ctx.root, ctx.phase, { gaps: round > 0 });
  const fresh = newBuildState({ phase: ctx.phase, graph, head: head(ctx.root), maxBuilders: ctx.settings.maxBuilders, round, now: ctx.deps.now() });
  for (const k of ['round', 'head0', 'graphSha', 'edges', 'order', 'red', 'slices']) ctx.state[k] = fresh[k];
  ctx.state.roundBase = fresh.head0;
  ctx.save();
  return ctx.state;
}

// --- sessions --------------------------------------------------------------------------------------------------------

const failedRun = (r) => Boolean(r.timedOut || r.stalled || r.isError);
const sessionOf = (ctx, where) => (where.slice ? ctx.state.slices[where.slice]?.sessions?.at(-1) : ctx.state.steps[where.step]?.session) ?? null;

// The settings file of a session key: the one recorded when it still exists (a resume keeps the same guard), else new.
function settingsFor(ctx, { key, cwd, recorded }) {
  if (recorded && fs.existsSync(recorded)) return recorded;
  return sessionSettings({ root: ctx.control, key, cwd, controlRoot: ctx.control, guard: ctx.config.lanes?.write_guard !== false }).settingsFile;
}

const effortOf = (ctx, effortKey) => (effortKey === 'lane' ? laneEffort(ctx.config) : ctx.settings.effort[effortKey]);

function recordCost(ctx, step, role, r) {
  try {
    recordSessionUsage(ctx.runDir, ctx.phase, { step, role, sessionId: r.sessionId ?? null, usage: r.usage ?? {}, wallMs: r.wallMs ?? 0 });
  } catch (err) {
    ctx.log(`warn: cost record: ${err?.message ?? err}`);
  }
}

// One session of a step (or of a slice: `slice`), under a machine slot (build.max_sessions); its record written when it
// starts; its usage recorded. -> SessionResult
export async function stepSession(ctx, { step, role, effortKey, cwd, prompt, agent, key, slice = null }) {
  const { state } = ctx;
  // a step's new session waits for the owner's pause to end (slices: the build loop dispatches nothing on hold)
  if (!slice) pauseIfHeld(ctx);
  const release = await ctx.deps.slot({ max: ctx.settings.maxSessions, label: `p${ctx.phase} ${role}` });
  let r;
  let started = null;
  try {
    const recorded = slice ? null : state.steps[step]?.session?.key === key ? state.steps[step].session.settings : null;
    const settingsFile = settingsFor(ctx, { key, cwd, recorded });
    const effort = effortOf(ctx, effortKey);
    const onStart = ({ sessionId, pid, transcript }) => {
      if (ctx.dead) return;
      started = pid;
      const at = iso(ctx.deps.now());
      const rec = { id: sessionId, role, transcript, pid, settings: settingsFile, at, effortKey, cwd, key, ...(agent ? { agent } : {}) };
      if (slice) {
        const s = setSlice(state, slice, 'running', { pid, session: { id: sessionId, role, at } }, ctx.deps.now());
        Object.assign(s.sessions.at(-1), rec);
      } else {
        setStep(state, step, { session: rec }, ctx.deps.now());
      }
      ctx.save();
    };
    r = await ctx.deps.runSession({ cwd, role, prompt, effort, ...(agent ? { agent } : {}), settingsFile, timeoutMin: ctx.settings.timeoutMin, stallMin: ctx.settings.stallMin, env: process.env, onStart });
  } finally {
    release();
  }
  if (!ctx.dead) {
    endedPid(ctx, slice ? { slice } : { step }, started);
    recordCost(ctx, step, role, r);
  }
  return r;
}

// The owner's pause seen at a boundary (a step, a new session): recorded (turbo-run stop reads it) and the step paused.
function pauseIfHeld(ctx) {
  const hold = holdOf(ctx);
  if (!hold) return;
  ctx.state.hold = hold;
  ctx.save();
  throw new Paused(hold.reason);
}

// A session that ended leaves no pid behind: a later --resume never ends a process that reused it.
function endedPid(ctx, where, pid) {
  if (!pid) return;
  const s = where.slice ? ctx.state.slices[where.slice] : null;
  const rec = sessionOf(ctx, where);
  if (s?.pid === pid) s.pid = null;
  if (rec?.pid === pid) rec.pid = null;
  ctx.save();
}

// The same session continued with text (an answer, a correction), under a slot; its usage recorded. -> SessionResult
async function resumeIn(ctx, where, text) {
  const rec = sessionOf(ctx, where);
  if (!rec?.id) throw new BuildFailed(`no session to continue for ${where.slice ? `slice ${where.slice}` : `step ${where.step}`}`);
  const step = where.slice ? 'build' : where.step;
  const release = await ctx.deps.slot({ max: ctx.settings.maxSessions, label: `p${ctx.phase} ${rec.role}` });
  let r;
  let started = null;
  try {
    const cwd = rec.cwd ?? ctx.root;
    const settingsFile = settingsFor(ctx, { key: rec.key, cwd, recorded: rec.settings });
    const onStart = ({ pid }) => {
      if (ctx.dead) return;
      started = pid;
      rec.pid = pid;
      if (where.slice) {
        const s = ctx.state.slices[where.slice];
        if (s.state !== 'running') setSlice(ctx.state, where.slice, 'running', { pid }, ctx.deps.now());
        else s.pid = pid;
      }
      ctx.save();
    };
    r = await ctx.deps.resumeSession(rec.id, text, { cwd, role: rec.role, effort: effortOf(ctx, rec.effortKey ?? 'builder'), ...(rec.agent ? { agent: rec.agent } : {}), settingsFile, timeoutMin: ctx.settings.timeoutMin, stallMin: ctx.settings.stallMin, env: process.env, onStart });
  } finally {
    release();
  }
  if (!ctx.dead) {
    endedPid(ctx, where, started);
    recordCost(ctx, step, rec.role, r);
  }
  return r;
}

// --- owner cards -----------------------------------------------------------------------------------------------------

const askInput = (oq) => {
  const options = (oq.options ?? []).map(({ label, description }) => ({ label, description }));
  const rec = (oq.options ?? []).findIndex((o) => o.recommended);
  return { question: oq.question, context: oq.context ?? '', options, recommended: rec >= 0 ? rec + 1 : 1 };
};
const whereText = (where) => (where.slice ? `slice ${where.slice}` : `step ${where.step}`);

// The session's OWNER QUESTION as a held card (keepRunning: it holds only what needs its answer). A card the questions
// module refuses goes back to the same session once with the reason. -> 'asked' | throws BuildFailed
export async function ownerAsk(ctx, r, where) {
  const ask = (oq) => askOwner(ctx.root, ctx.phase, askInput(oq), { lang: ctx.lang, keepRunning: true, now: ctx.deps.now() }).question;
  let oq = r.ownerQuestion;
  let q;
  try {
    q = ask(oq);
  } catch (err) {
    const again = await resumeIn(ctx, where, `Your OWNER QUESTION could not be asked: ${err.message}. Write the block again, corrected, as the last thing in your reply.`);
    if (!again.ownerQuestion) throw new BuildFailed(`owner question refused twice: ${err.message}`);
    oq = again.ownerQuestion;
    try {
      q = ask(oq);
    } catch (err2) {
      throw new BuildFailed(`owner question refused twice: ${err2.message}`);
    }
  }
  if (where.slice) setSlice(ctx.state, where.slice, 'owner', { question: q.id, ownerQuestion: oq, pid: null }, ctx.deps.now());
  else setStep(ctx.state, where.step, { state: 'owner', question: q.id }, ctx.deps.now());
  ctx.save();
  ctx.log(`asked ${q.id} (${whereText(where)})`);
  ctx.deps.checkpoint(`owner:${q.id}`);
  return 'asked';
}

// Where the card waits: the step or the slice in state owner with this question.
function waiterOf(ctx, id) {
  for (const [sid, s] of Object.entries(ctx.state.slices ?? {})) if (s.state === 'owner' && s.question === id) return { slice: sid };
  for (const [step, rec] of Object.entries(ctx.state.steps ?? {})) if (rec?.state === 'owner' && rec.question === id && !rec.halt) return { step };
  return null;
}

// An answered card goes to the same session once: marked delivered first (in flight from here), then the session is
// resumed with the lane's delivery message. -> SessionResult | null (not answered yet, or nothing waits for it)
export async function takeAnswer(ctx, id) {
  const where = waiterOf(ctx, id);
  if (!where) return null;
  const q = readQuestions(ctx.root, ctx.phase).find((x) => x.id === id);
  const answer = liveAnswer(readAnswers(ctx.root, ctx.phase), id);
  if (!answer || !(q?.state === 'answered' || q?.state === 'delivered' || !q)) return null;
  const card = q ?? cardOf(id, answer);
  // answering (a step) and answered (a slice: B2's reconcile clears question) keep the answer through a crash of the
  // continuation: a step resumes the same session with it again, a rebuilt slice gets it in its prompt. Saved before the
  // card is marked delivered.
  if (where.slice) {
    const s = setSlice(ctx.state, where.slice, 'running', {}, ctx.deps.now());
    s.answered = [...new Set([...(s.answered ?? []), id])];
  } else {
    setStep(ctx.state, where.step, { state: 'running', answering: id }, ctx.deps.now());
  }
  ctx.save();
  if (q?.state === 'answered') markDelivered(ctx.root, ctx.phase, id, 'lane', { now: ctx.deps.now() });
  ctx.log(`answer ${id} goes to ${whereText(where)}`);
  const r = await resumeIn(ctx, where, laneDeliveryMessage(card, answer));
  if (!ctx.dead && where.step) {
    setStep(ctx.state, where.step, { answering: undefined }, ctx.deps.now());
    ctx.save();
  }
  return r;
}

// The delivery message of an answered card (data for the session that asked it), or null.
function deliveryOf(ctx, id) {
  const answer = liveAnswer(readAnswers(ctx.root, ctx.phase), id);
  if (!answer) return null;
  const q = readQuestions(ctx.root, ctx.phase).find((x) => x.id === id) ?? cardOf(id, answer);
  return laneDeliveryMessage(q, answer);
}

// A delivered lane card leaves the questions file: its chosen option rebuilt from the answer's label.
function cardOf(id, answer) {
  const options = [];
  if (Number.isInteger(answer?.option) && answer.option >= 1) options[answer.option - 1] = { label: String(answer.label ?? answer.answer ?? ''), description: '' };
  return { id, options };
}

// The owner's answers a slice took before (s.answered), for a builder that starts the slice again: the question it
// asked and the answer, as data under the prompt's owner answers.
function answeredText(ctx, s) {
  const lines = [];
  for (const id of s.answered ?? []) {
    const msg = deliveryOf(ctx, id);
    if (!msg) continue;
    const q = readQuestions(ctx.root, ctx.phase).find((x) => x.id === id);
    lines.push(`- Earlier in this slice its builder asked the owner${q?.question ? `: "${q.question}"` : ` (${id})`}. ${msg}`);
  }
  return lines.join('\n');
}

// The owner's pause: attend, or an owner-stop mark newer than this run. -> { reason, at } | null
function holdOf(ctx) {
  const mark = attendMark(ctx.root, ctx.phase);
  if (mark) return { reason: 'attend', at: mark.at ?? iso(ctx.deps.now()) };
  const stop = readOwnerStop(ctx.control);
  const at = Date.parse(stop?.at);
  if (Number.isFinite(at) && at >= ctx.startedAt.getTime()) return { reason: 'stop', at: stop.at };
  return null;
}

// Waits for the step's card and resumes its session with the answer. A pause ends the wait (the card stays open).
async function waitAnswer(ctx, id) {
  for (;;) {
    pauseIfHeld(ctx);
    const r = await takeAnswer(ctx, id);
    if (r) return r;
    if (!waiterOf(ctx, id)) throw new BuildFailed(`card ${id} has nothing waiting for it`);
    await ctx.deps.sleep(ctx.deps.pollMs);
  }
}

// The answer to a halt card, once answered: 'retry' | 'go-on' | 'stop' (the card then delivered); null while open.
function haltAnswer(ctx, id) {
  const q = readQuestions(ctx.root, ctx.phase).find((x) => x.id === id);
  const answer = liveAnswer(readAnswers(ctx.root, ctx.phase), id);
  if (!answer || (q && q.state === 'open')) return null;
  if (q?.state === 'answered') markDelivered(ctx.root, ctx.phase, id, 'lane', { now: ctx.deps.now() });
  return haltChoice(q ?? { options: [] }, answer);
}

function askHalt(ctx, kind) {
  const q = askOwner(ctx.root, ctx.phase, haltQuestion(kind, { phase: ctx.phase, lang: ctx.lang }), { lang: ctx.lang, keepRunning: true, now: ctx.deps.now() }).question;
  ctx.log(`asked ${q.id} (halt: ${kind})`);
  return q.id;
}

// The step stopped at the owner's word: recorded, the lane status failed with the reason. Throws Stopped.
function stopAt(ctx, step, kind) {
  setStep(ctx.state, step, { state: 'stopped', halt: kind }, ctx.deps.now());
  ctx.save();
  const reason = `phase ${ctx.phase} build stopped at step ${step}: ${haltWhat(kind, 'en')}`;
  writeLaneStatus(ctx.root, ctx.phase, 'failed', { reason, at: iso(ctx.deps.now()) });
  ctx.log(reason);
  throw new Stopped(reason);
}

// A step that cannot go on alone asks the owner (a held card) and waits: -> 'retry' | 'go-on'; stop throws Stopped.
async function halt(ctx, kind, { step }) {
  const rec = ctx.state.steps[step];
  let id = rec?.state === 'owner' && rec.halt === kind && rec.question ? rec.question : null;
  if (!id) {
    id = askHalt(ctx, kind);
    setStep(ctx.state, step, { state: 'owner', question: id, halt: kind }, ctx.deps.now());
    ctx.save();
    ctx.deps.checkpoint(`owner:${id}`);
  }
  for (;;) {
    const choice = haltAnswer(ctx, id);
    if (choice === 'stop') stopAt(ctx, step, kind);
    if (choice) {
      setStep(ctx.state, step, { state: 'running', halt: undefined, question: undefined, lastCard: id }, ctx.deps.now());
      ctx.save();
      return choice;
    }
    pauseIfHeld(ctx);
    await ctx.deps.sleep(ctx.deps.pollMs);
  }
}

// A step's session to its end: its owner questions asked and answered in the same session, one fresh try after a
// failure (no answer, a stall, an error), then the owner. A step waiting on its card (after a restart) waits first.
async function converse(ctx, spec) {
  const { step } = spec;
  for (;;) {
    let r = null;
    let tries = 0;
    const rec = ctx.state.steps[step];
    const own = rec?.session?.key === spec.key;
    if (rec?.state === 'owner' && rec.question && !rec.halt && !own) {
      // a card of another session of this step (a restart went on elsewhere): it goes, a new session asks again
      ctx.log(`card ${rec.question} of step ${step} belonged to another session: dropped`);
      try {
        dropLaneQuestions(ctx.root, ctx.phase, { ids: [rec.question] });
      } catch { /* gone already */ }
      setStep(ctx.state, step, { state: 'running', question: undefined }, ctx.deps.now());
      ctx.save();
    } else if (rec?.state === 'owner' && rec.question && !rec.halt) r = await waitAnswer(ctx, rec.question);
    else if (rec?.answering && rec.session?.id && !own) {
      setStep(ctx.state, step, { answering: undefined }, ctx.deps.now());
      ctx.save();
    } else if (rec?.answering && rec.session?.id) {
      // the run before died while the session took an answer: the same session gets it again, never a new question
      const msg = deliveryOf(ctx, rec.answering);
      if (msg) {
        pauseIfHeld(ctx);
        ctx.log(`answer ${rec.answering} goes to step ${step} again (the run before stopped while it was being taken)`);
        r = await resumeIn(ctx, { step }, msg);
      }
      setStep(ctx.state, step, { answering: undefined }, ctx.deps.now());
      ctx.save();
    }
    for (;;) {
      r ??= await stepSession(ctx, spec);
      while (r.ownerQuestion && !failedRun(r)) {
        await ownerAsk(ctx, r, { step });
        r = await waitAnswer(ctx, ctx.state.steps[step].question);
      }
      if (!failedRun(r)) return r;
      ctx.log(`${spec.role} session ended without an answer (${r.timedOut ? 'timed out' : r.stalled ? 'stalled' : `exit ${r.exitCode}`})`);
      r = null;
      if (++tries >= 2) break;
    }
    await halt(ctx, 'session', { step });
  }
}

// The owner questions of a session that already ran, each asked and answered in that same session. -> SessionResult
async function finishSession(ctx, where, r) {
  while (r.ownerQuestion && !failedRun(r)) {
    await ownerAsk(ctx, r, where);
    r = await waitAnswer(ctx, where.slice ? ctx.state.slices[where.slice].question : ctx.state.steps[where.step].question);
  }
  return r;
}

// --- prompts ---------------------------------------------------------------------------------------------------------

function ownerFragment(lang, beforeAsking) {
  return fillTemplate(fs.readFileSync(path.join(ROLES_DIR, 'owner-question.md'), 'utf8'), { lang: LANG_NAMES[lang] ?? lang, beforeAsking }).trimEnd();
}

const SECURITY_CONSTRAINTS = 'register_authored_at_plan_time: false — Retroactive-STRIDE: build a STRIDE register from implementation files first, then verify mitigations. Never modify implementation files. Return a structured verdict only (## SECURED, ## OPEN_THREATS or ## ESCALATE) with threats_open; do not write SECURITY.md.';

// The prompts of the GSD agents and workflows the build path runs (GSD 1.17's own spawn prompts, B4's plan).
// kind: discuss | research | review | verify | security | uat | verify-work | integrate
export function stepPrompt(kind, v) {
  switch (kind) {
    case 'discuss':
      return `Read and execute ${posix(v.core)}/workflows/discuss-phase-assumptions.md with the arguments "${v.phase} --auto". You run headless in gsd-turbo's build path: there is no AskUserQuestion; wherever the workflow would ask, take its recommended option. Stop once CONTEXT.md is written and committed: skip the workflow's auto_advance step and never start plan-phase or any other GSD command.\n\n${ownerFragment(v.lang, 'Before you ask, write down what is already decided.')}\n`;
    case 'research':
      return [
        '<objective>', `Research how to implement Phase ${v.phase}: ${v.name}`, 'Answer: "What do I need to know to PLAN this phase well?"', '</objective>', '',
        '<required_reading>', `- ${v.phaseDir}/${v.padded}-CONTEXT.md (USER DECISIONS)`, '- .planning/REQUIREMENTS.md', '- .planning/STATE.md', '</required_reading>', '',
        '<additional_context>', `**Phase description:** ${v.section}`, `**Phase requirement IDs (MUST address):** ${v.reqIds.join(', ')}`, '</additional_context>', '',
        '<output>', `Write to: ${v.phaseDir}/${v.padded}-RESEARCH.md`, '</output>', '',
        `${LEAN_RESEARCH_RULE} Keep RESEARCH.md under 25 KB. Do not commit.`, '',
      ].join('\n');
    case 'review':
      return [
        '<config>', 'depth: standard', `phase_dir: ${v.phaseDir}`, `review_path: ${v.reviewPath}`, `diff_base: ${v.base}`, 'files:', ...v.files.map((f) => `  - ${f}`), '</config>', '',
        `Review the listed source files at standard depth. Write findings to ${v.reviewPath}.`, 'Do NOT commit the output — the orchestrator handles that.',
        ...(v.paragraph ? [v.paragraph] : []), '',
      ].join('\n');
    case 'verify':
      return `Verify phase ${v.phase} goal achievement.\nPhase directory: ${v.phaseDir}\nPhase goal: ${v.goal}\nPhase requirement IDs: ${v.reqIds.join(', ')}\nCheck must_haves against actual codebase.\nCross-reference requirement IDs from PLAN frontmatter against REQUIREMENTS.md — every ID MUST be accounted for.\nCreate VERIFICATION.md.\n\n<required_reading>\nRead these files before verification:\n- ${v.phaseDir}/*-PLAN.md (All plans — understand intent, check must_haves)\n- ${v.phaseDir}/*-SUMMARY.md (All summaries — cross-reference claimed vs actual)\n- .planning/REQUIREMENTS.md (Requirement traceability)\n</required_reading>`;
    case 'security':
      return [
        'Read $HOME/.claude/agents/gsd-security-auditor.md for instructions.', '', '<required_reading>', `- ${v.phaseDir}/*-PLAN.md`, `- ${v.phaseDir}/*-SUMMARY.md`, ...v.files.map((f) => `- ${f}`), '</required_reading>',
        '<threat_register>none at plan time</threat_register>', `<config>asvs_level: ${v.asvs}, block_on: ${v.blockOn}</config>`, `<constraints>${SECURITY_CONSTRAINTS}</constraints>`,
      ].join('\n');
    case 'uat':
      return `Phase ${v.phase}. Phase directory: ${v.phaseDir}. Run your procedure and reply with your report.`;
    case 'verify-work':
      return `In this repository run Skill(skill="gsd-verify-work", args="${v.phase}") and nothing else. Answer every question with its recommended option. Do not edit source files, commit or push.`;
    case 'integrate':
      return `The merge of the main branch into this phase's branch stopped with conflicts in: ${v.files.join(', ')}. Resolve each file within this phase's scope: keep what the main branch changed and redo this phase's change on top of it; never drop the other side's change. git add each file you resolved, change nothing else and do not commit: code commits the merge. When a conflict cannot be resolved that way, ask the owner.\n\n${ownerFragment(v.lang, 'Before you ask, leave the files you could not resolve as they are.')}\n`;
    default:
      throw new Error(`unknown step prompt: ${kind}`);
  }
}

// --- files of the phase ------------------------------------------------------------------------------------------------

function phaseFiles(ctx) {
  const dir = findPhaseDir(ctx.root, ctx.phase);
  if (!dir) return { dir: null, rel: null, art: { plans: [] } };
  return { dir, rel: posix(path.relative(ctx.root, dir)), art: phaseArtifacts(dir) };
}

// Whether a project file is committed as it is on disk.
function committedAsIs(root, rel) {
  try {
    git(root, ['ls-files', '--error-unmatch', '--', rel]);
  } catch {
    return false;
  }
  return git(root, ['status', '--porcelain', '--', rel]) === '';
}

// Plan files of the phase directory that are not committed as they are (new or changed).
function uncommittedPlans(ctx, rel) {
  const out = git(ctx.root, ['status', '--porcelain', '--untracked-files=all', '--', rel]);
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((f) => f.endsWith('-PLAN.md'));
}

// gsd-tools commit <message> --files … (GSD's own commit). -> its answer
function gsdCommit(ctx, message, files) {
  const r = jsonOf(ctx.deps.gsd(['commit', message, '--files', ...files], { json: false }));
  if (!r || (!r.committed && !r.skipped && r.reason !== 'nothing_to_commit')) throw new BuildFailed(`gsd-tools commit "${message}": ${r?.reason ?? r?.error ?? 'no answer'}`);
  if (r.committed) ctx.log(`committed ${message}`);
  return r;
}

const gsdJson = (ctx) => (args) => jsonOf(ctx.deps.gsd(args, { json: false }));

function syncStateWarn(ctx) {
  try {
    stateSync({ root: ctx.root, phase: ctx.phase, gsd: gsdJson(ctx) });
  } catch (err) {
    ctx.log(`warn: state-sync: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
}

// --- steps begin, discuss, research, slice -------------------------------------------------------------------------

async function stepBegin(ctx) {
  const { state, root, phase } = ctx;
  if (!state.base) {
    state.base = head(root);
    ctx.save();
  }
  const { art } = phaseFiles(ctx);
  try {
    // text: GSD answers it with --raw as a bare true; a failure throws
    ctx.deps.gsd(['query', 'state.begin-phase', '--phase', phase, '--name', state.info?.name ?? '', '--plans', String(art.plans.length)], { json: false });
  } catch (err) {
    ctx.log(`warn: state.begin-phase: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
  syncStateWarn(ctx);
  try {
    gsdCommit(ctx, `docs(phase-${phase}): begin (build path)`, ['.planning/STATE.md']);
  } catch (err) {
    ctx.log(`warn: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
  return { result: 'done' };
}

async function stepDiscuss(ctx) {
  if (phaseFiles(ctx).art.context) return { result: 'skipped', why: 'CONTEXT.md exists' };
  await converse(ctx, { step: 'discuss', role: 'discuss', effortKey: 'lane', cwd: ctx.root, key: `${ctx.phase}-discuss`, prompt: stepPrompt('discuss', { core: ctx.core ?? '', phase: ctx.phase, lang: ctx.lang }) });
  const { rel, art } = phaseFiles(ctx);
  if (!art.context) throw new BuildFailed('discuss produced no CONTEXT.md');
  if (!committedAsIs(ctx.root, `${rel}/${art.context}`)) gsdCommit(ctx, `docs(phase-${ctx.phase}): context`, [`${rel}/${art.context}`]);
  return { result: 'done' };
}

async function stepResearch(ctx) {
  const { root, phase, state } = ctx;
  let { rel, art } = phaseFiles(ctx);
  if (art.research) {
    if (committedAsIs(root, `${rel}/${art.research}`)) return { result: 'skipped', why: 'RESEARCH.md exists' };
    gsdCommit(ctx, `docs(phase-${phase}): research`, [`${rel}/${art.research}`]);
    return { result: 'done' };
  }
  const info = readPhaseInfo(root, phase);
  const need = needsResearch(info);
  if (!need.yes) return { result: 'skipped', why: need.why };
  if (!rel) throw new BuildFailed(`phase ${phase} has no directory to research for`);
  let section = '';
  try {
    section = String(ctx.deps.gsd(['roadmap', 'get-phase', phase, '--pick', 'section'], { json: false }) ?? '').trim();
  } catch (err) {
    ctx.log(`warn: roadmap get-phase: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
  const padded = state.info?.padded || path.basename(rel).split('-')[0];
  const prompt = stepPrompt('research', { phase, name: state.info?.name ?? '', phaseDir: rel, padded, section: section || info.goal || '', reqIds: (info.requirements ?? []).map((r) => r.id) });
  await converse(ctx, { step: 'research', role: 'researcher', effortKey: 'researcher', agent: 'gsd-phase-researcher', cwd: root, key: `${phase}-research`, prompt });
  ({ rel, art } = phaseFiles(ctx));
  if (!art.research) throw new BuildFailed('research produced no RESEARCH.md');
  gsdCommit(ctx, `docs(phase-${phase}): research`, [`${rel}/${art.research}`]);
  return { result: 'done' };
}

// A lint problem the slicer cannot fix: GSD could not read the CONTEXT decisions (B3: not a citation gap).
const ownerProblem = (p) => p.kind === 'decisions' && p.plan === null && !/ is cited by no slice$/.test(String(p.detail));

// One round's slices: the slicer's session (its owner questions answered in it), the code check, one revision by the
// same session, then the owner; the plans committed and taken as the round's graph. step: the step it runs in (slice,
// or verify / uat for a gap round). -> 'done' (plans committed and adopted)
async function sliceRound(ctx, { step, round, findingsPath = null }) {
  const { root, phase } = ctx;
  const { rel, art } = phaseFiles(ctx);
  if (!rel || !art.context) throw new BuildFailed(`phase ${phase} has no CONTEXT.md to slice from`);
  const message = round > 0 ? `docs(phase-${phase}): gap slices (round ${round})` : `docs(phase-${phase}): slice plans`;
  const key = `${phase}-slice-r${round}`;
  const commitRound = () => {
    const files = uncommittedPlans(ctx, rel);
    if (files.length) gsdCommit(ctx, message, files);
    adoptRound(ctx, { round });
    return 'done';
  };
  const lint = () => {
    const l = ctx.deps.lint(root, phase, { core: ctx.core });
    const gsdProblems = (l.problems ?? []).filter((p) => p.kind === 'gsd');
    if (gsdProblems.length) throw new BuildFailed(`gsd-tools could not check the slices: ${gsdProblems.map((p) => p.detail).join('; ')}`);
    return l;
  };
  // plans the slicer wrote before a restart: kept when they pass, else sliced again
  if (uncommittedPlans(ctx, rel).length && ctx.state.steps[step]?.state !== 'owner') {
    if (lint().ok) return commitRound();
    removePlans(ctx, rel);
  }
  for (;;) {
    let problems = null;
    if (ctx.state.steps[step]?.state === 'owner' && ctx.state.steps[step].halt === 'slices') {
      problems = []; // the halt card is asked already: wait for it below
    } else {
      setStep(ctx.state, step, { revised: false }, ctx.deps.now());
      const prompt = rolePrompt('slicer', { root, phase, contextPath: `${rel}/${art.context}`, ...(art.research ? { researchPath: `${rel}/${art.research}` } : {}), ...(findingsPath ? { findingsPath } : {}), lang: ctx.lang });
      const spec = { step, role: 'slicer', effortKey: 'slicer', cwd: root, key, prompt };
      await converse(ctx, spec);
      let l = lint();
      if (l.ok) return commitRound();
      if (!l.problems.some(ownerProblem)) {
        const r = await finishSession(ctx, { step }, await resumeIn(ctx, { step }, formatProblems(l.problems)));
        setStep(ctx.state, step, { revised: true }, ctx.deps.now());
        ctx.save();
        if (failedRun(r)) ctx.log('the slicer\'s revision ended without an answer');
        l = lint();
        if (l.ok) return commitRound();
      }
      problems = l.problems;
      ctx.log(`the slices still have problems: ${problems.map((p) => `${p.plan ?? 'phase'} ${p.kind}`).join(', ')}`);
    }
    const choice = await halt(ctx, 'slices', { step });
    if (choice === 'go-on') return commitRound();
    removePlans(ctx, rel);
  }
}

// The round's plan files that are not committed, removed (a new slicer session starts from the committed ones).
function removePlans(ctx, rel) {
  for (const f of uncommittedPlans(ctx, rel)) {
    try {
      git(ctx.root, ['checkout', '--', f]);
    } catch {
      fs.rmSync(path.join(ctx.root, ...f.split('/')), { force: true });
    }
  }
}

async function stepSlice(ctx) {
  const { rel, art } = phaseFiles(ctx);
  const committed = rel ? art.plans.filter((p) => committedAsIs(ctx.root, `${rel}/${p.file}`)) : [];
  if (committed.length && !uncommittedPlans(ctx, rel).length && ctx.state.steps.slice?.state !== 'owner') {
    adoptRound(ctx, { round: 0 });
    if (ctx.settings.adoptPlans) return { result: 'skipped', why: `GSD plans adopted (${committed.length})` };
    return { result: 'done' };
  }
  await sliceRound(ctx, { step: 'slice', round: 0 });
  return { result: 'done' };
}

// --- step build: the ready queue (spec §6.3 step 5, §6.4) ------------------------------------------------------------

// 2026-10-17T12:00:00.000Z -> 20261017T120000Z
const utcStamp = (d) => iso(d).replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
const hasBranch = (root, b) => {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
    return true;
  } catch {
    return false;
  }
};

// A slice's worktree removed and its branch parked as turbo-salvage/<id>-<UTC> when it holds commits not on HEAD (else
// deleted), so that a new worktree on turbo-build/<id> can start from the current HEAD.
// -> true when the slice can start again; false when its worktree stays (Windows keeps one a process stands in) or git
// refused: its branch is then left alone and the slice waits for the owner.
function parkSlice(ctx, id) {
  const s = ctx.state.slices[id];
  const branch = s.branch ?? sliceBranch(id);
  try {
    const r = s.worktree ? removeSliceWorktree(ctx.root, { path: s.worktree, branch, deleteBranch: false }) : { leftover: null };
    if (r.leftover) {
      s.leftover = r.leftover;
      ctx.log(`slice ${id}: its worktree could not be removed (${r.why ?? r.leftover}); it waits for the owner`);
      return false;
    }
    if (!hasBranch(ctx.root, branch)) return true;
    if (git(ctx.root, ['rev-list', '--count', `HEAD..refs/heads/${branch}`]) === '0') {
      git(ctx.root, ['branch', '-q', '-D', branch]);
      return true;
    }
    const stem = `turbo-salvage/${id}-${utcStamp(ctx.deps.now())}`;
    let name = stem;
    for (let i = 2; hasBranch(ctx.root, name); i++) name = `${stem}-${i}`;
    git(ctx.root, ['branch', '-m', branch, name]);
    s.salvage = [...(s.salvage ?? []), name];
    ctx.log(`slice ${id}: its work is kept on ${name}`);
    return true;
  } catch (err) {
    ctx.log(`slice ${id}: its branch was not set aside: ${String(err?.message ?? err).split(/\r?\n/)[0]}; it waits for the owner`);
    return false;
  }
}

// The SUMMARY on the slice's branch says status: blocked (B3: the builder could not finish within its files).
function summaryBlocked(ctx, id) {
  const s = ctx.state.slices[id];
  try {
    return /^status:\s*blocked\s*$/m.test(git(ctx.root, ['show', `refs/heads/${s.branch ?? sliceBranch(id)}:${s.summary}`]));
  } catch {
    return false;
  }
}

// The files a blocked builder names in its SUMMARY (B3: `Blocked: needs <path> because <why>`).
function blockedNeeds(ctx, id) {
  const s = ctx.state.slices[id];
  let text = '';
  try {
    text = git(ctx.root, ['show', `refs/heads/${s.branch ?? sliceBranch(id)}:${s.summary}`]);
  } catch {
    return [];
  }
  const out = [];
  for (const m of text.matchAll(/^Blocked:\s*needs\s+`?([^\s`]+?)`?[,;:.]?(?=\s|$)/gm)) out.push(path.posix.normalize(m[1].replace(/\\/g, '/')));
  return [...new Set(out)];
}

// B5 (A/B on a real phase): a slicer cannot foresee every file. A blocked builder's needed files that the slice check
// allows and that no other slice still to be merged lists join the slice's files_modified (one plan commit, the
// slicer's inline list only), and the round's graph is read again; once per slice. -> the paths taken
function widenSlice(ctx, id) {
  const { root, phase, state } = ctx;
  const s = state.slices[id];
  if (s.widened || !s.plan) return [];
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    } catch {
      return null;
    }
  };
  const listed = (text) => [...(frontList(text, 'files_modified') ?? []), ...(frontList(text, 'files_deleted') ?? [])].map((f) => path.posix.normalize(f));
  const planText = read(s.plan);
  const line = planText && /^files_modified:[ \t]*\[(.*)\][ \t]*$/m.exec(planText);
  if (!line) return [];
  const own = new Set(listed(planText));
  const others = new Set();
  for (const [oid, o] of Object.entries(state.slices)) {
    if (oid === id || ['merged', 'done-before'].includes(o.state) || !o.plan) continue;
    for (const f of listed(read(o.plan) ?? '')) others.add(f);
  }
  const phaseDir = path.posix.dirname(s.plan);
  const take = blockedNeeds(ctx, id).filter((p) => !own.has(p) && !others.has(p) && !slicePathProblem(p, phaseDir));
  if (!take.length) return [];
  const items = [...line[1].split(',').map((x) => x.trim()).filter(Boolean), ...take];
  fs.writeFileSync(path.join(root, ...s.plan.split('/')), planText.replace(line[0], `files_modified: [${items.join(', ')}]`));
  gsdCommit(ctx, `docs(phase-${phase}): slice ${id} takes ${take.join(', ')}`, [s.plan]);
  s.widened = take;
  try {
    const g = planGraph(root, phase, { gaps: (state.round ?? 0) > 0 });
    Object.assign(state, { edges: g.edges, order: g.order, graphSha: g.graphSha });
  } catch (err) {
    ctx.log(`warn: the graph after slice ${id} took ${take.join(', ')}: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
  ctx.save();
  return take;
}

async function stepBuild(ctx) {
  const { root, phase, state } = ctx;
  const { rel, art } = phaseFiles(ctx);
  const contextPath = rel && art.context ? `${rel}/${art.context}` : null;
  const now = () => ctx.deps.now();
  const inFlight = new Map();
  const ended = [];
  const mergeQueue = [];
  let stopping = null;
  const save = () => ctx.save();
  const budget = (s) => 1 + (s.ownerRetries ?? 0);

  const start = (id, run) => {
    const p = Promise.resolve().then(run).then((r) => ({ id, r }), (err) => ({ id, err }));
    inFlight.set(id, p);
    p.then((x) => {
      inFlight.delete(id);
      if (!ctx.dead) ended.push(x);
    });
  };
  // a slice that cannot go on alone: its own held card (other slices go on)
  const haltSlice = (id, to, reason) => {
    const s = state.slices[id];
    moveSlice(id, to, { reason });
    s.halt = { kind: 'slice', question: askHalt(ctx, 'slice') };
    save();
  };
  // through the moves B2 allows, to failed or blocked from wherever the slice is
  const moveSlice = (id, to, fields = {}) => {
    const s = state.slices[id];
    if (s.state === 'waiting') setSlice(state, id, 'dispatched', {}, now());
    if (s.state === 'dispatched' || s.state === 'owner') setSlice(state, id, 'running', {}, now());
    setSlice(state, id, to, { pid: null, ...fields }, now());
  };
  const failSlice = (id, reason) => {
    const s = state.slices[id];
    ctx.log(`slice ${id} failed: ${reason}`);
    moveSlice(id, 'failed', { reason });
    if (s.retries < budget(s) && requeue(id)) return;
    s.halt = { kind: 'slice', question: askHalt(ctx, 'slice') };
    save();
  };
  // a failed or blocked slice back to waiting, its worktree removed and its branch set aside; false when that failed
  const requeue = (id) => {
    if (!parkSlice(ctx, id)) return false;
    setSlice(state, id, 'waiting', { worktree: null, branch: null, base: null, links: [] }, now());
    save();
    return true;
  };
  const dispatch = (id) => {
    const s = state.slices[id];
    const base = head(root);
    let wt;
    try {
      // a worktree a removal left behind (B2: a leftover, tried again later) is removed first; its branch stays
      const left = sliceWorktreePath(root, id);
      if (fs.existsSync(left)) removeSliceWorktree(root, { path: left, branch: null, deleteBranch: false });
      wt = createSliceWorktree(root, { phase, id, baseSha: base });
    } catch (err) {
      failSlice(id, `its worktree could not be made: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
      return;
    }
    setSlice(state, id, 'dispatched', { worktree: wt.path, branch: wt.branch, base, links: wt.links, reason: null }, now());
    save();
    ctx.log(`dispatch ${id}`);
    const preanswers = [preAnswerText(root, phase, id), answeredText(ctx, s)].filter(Boolean).join('\n');
    const prompt = rolePrompt('builder', { root, phase, contextPath, planPath: s.plan, preanswers, lang: ctx.lang });
    start(id, () => stepSession(ctx, { step: 'build', role: 'builder', effortKey: 'builder', cwd: wt.path, key: `${phase}-${id}`, prompt, slice: id }));
  };
  const onEnded = async ({ id, r, err }) => {
    const s = state.slices[id];
    if (!err && !r) return; // nothing waited for the answer
    if (err) {
      if (!(err instanceof BuildFailed) && !/claude -p failed|headless:/.test(String(err?.message))) throw err;
      failSlice(id, String(err.message).split(/\r?\n/)[0]);
      return;
    }
    if (r.ownerQuestion && !failedRun(r)) {
      try {
        await ownerAsk(ctx, r, { slice: id });
      } catch (e) {
        if (!(e instanceof BuildFailed)) throw e;
        failSlice(id, e.message);
      }
      return;
    }
    if (failedRun(r)) {
      failSlice(id, r.timedOut ? 'the builder timed out' : r.stalled ? 'the builder stalled' : `the builder ended with exit ${r.exitCode}`);
      return;
    }
    if (summaryBlocked(ctx, id)) {
      const taken = widenSlice(ctx, id);
      if (taken.length) {
        // the slice with its new files is built again (that build is its retry)
        ctx.log(`slice ${id}: its builder needed ${taken.join(', ')}: the slice takes them and is built again`);
        moveSlice(id, 'failed', { reason: `blocked: needs ${taken.join(', ')}` });
        if (!requeue(id)) {
          state.slices[id].halt = { kind: 'slice', question: askHalt(ctx, 'slice') };
          save();
        }
        return;
      }
      failSlice(id, 'the builder wrote status: blocked');
      return;
    }
    if (s.state !== 'running') setSlice(state, id, 'running', {}, now());
    mergeQueue.push(id);
  };
  const testMerge = async (id) => {
    const s = state.slices[id];
    const t = await runMergeTests(root, ctx.runDir, phase, { sha: s.merge });
    if (ctx.dead) return;
    if (t.green) {
      s.tests = 'green';
      save();
      try {
        ctx.deps.gsd(['roadmap', 'update-plan-progress', phase], { json: false });
        gsdCommit(ctx, `docs(phase-${phase}): progress`, ['.planning/ROADMAP.md']);
      } catch (err) {
        ctx.log(`warn: progress: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
      }
      return;
    }
    s.tests = 'red';
    state.red = { after: id, merge: s.merge, line: t.line, log: t.log, at: iso(now()), fixed: false, question: null };
    save();
    ctx.log(`tests red after ${id}: ${t.line}`);
  };
  const mergeOne = async (id) => {
    const s = state.slices[id];
    let m;
    try {
      m = mergeSlice(root, { phase, id, path: s.worktree, branch: s.branch ?? sliceBranch(id) });
    } catch (err) {
      if (!(err instanceof BuildLocked)) throw err;
      m = { blocked: true, kind: 'lock', reason: err.message };
    }
    if (!m.blocked) {
      setSlice(state, id, 'merged', { merge: m.sha, tests: null, pid: null, worktree: null, branch: null, leftover: m.leftover ?? null }, now());
      save();
      ctx.log(`merged ${id} (${m.sha.slice(0, 7)})`);
      ctx.deps.checkpoint(`merged:${id}`);
      await testMerge(id);
      return;
    }
    ctx.log(`merge of ${id} blocked (${m.kind}): ${m.reason}`);
    if (m.kind === 'conflict') {
      if (s.rebuilds < budget(s)) {
        moveSlice(id, 'blocked', { reason: `conflict: ${m.reason}` });
        if (requeue(id)) return;
        s.halt = { kind: 'slice', question: askHalt(ctx, 'slice') };
        save();
        return;
      }
      haltSlice(id, 'blocked', `conflict: ${m.reason}`);
      return;
    }
    if (m.kind === 'artifacts' || m.kind === 'dirty') {
      if (!s.told) {
        s.told = true;
        save();
        start(id, () => resumeIn(ctx, { slice: id }, `The merge found: ${m.reason}. Finish the slice: commit your work and the SUMMARY as your prompt says.`));
        return;
      }
      haltSlice(id, 'blocked', `${m.kind}: ${m.reason}`);
      return;
    }
    if (m.kind === 'checkout' || m.kind === 'lock') {
      s.mergeTries = (s.mergeTries ?? 0) + 1;
      save();
      if (m.kind === 'checkout') {
        try {
          commitPendingAnswers(root);
        } catch { /* the owner's answers, committed later */ }
      }
      if (s.mergeTries < 3) {
        retryLater.push(id);
        return;
      }
    }
    haltSlice(id, 'blocked', `${m.kind}: ${m.reason}`);
  };
  // red with nothing in flight: one fixer, the retest; still red -> the owner's card
  const fixRed = async () => {
    const red = state.red;
    if (!red.fixed) {
      ctx.log(`fixing the red tests after ${red.after}`);
      await converse(ctx, { step: 'build', role: 'fixer', effortKey: 'fixer', cwd: root, key: `${phase}-fix-red`, prompt: rolePrompt('fixer', { root, phase, contextPath, findingsPath: red.log, lang: ctx.lang }) });
      red.fixed = true;
      save();
    }
    const t = await runMergeTests(root, ctx.runDir, phase, { sha: null });
    if (t.green) {
      for (const s of Object.values(state.slices)) if (s.state === 'merged' && s.tests === 'red') s.tests = 'green';
      state.red = null;
      save();
      ctx.log('the retest is green');
      return;
    }
    red.retest = t.log;
    red.question = askHalt(ctx, 'red');
    save();
  };
  let retryLater = [];
  let picked = false;

  try {
    for (;;) {
      const hold = holdOf(ctx);
      if (JSON.stringify(hold) !== JSON.stringify(state.hold ?? null)) {
        state.hold = hold;
        save();
        if (hold) ctx.log(`the build pauses (${hold.reason}): running sessions finish, nothing new starts`);
      }
      while (ended.length) await onEnded(ended.shift());
      mergeQueue.push(...retryLater);
      retryLater = [];
      // the owner's answers: a slice's question resumes its session; a halt card retries or stops
      for (const [id, s] of Object.entries(state.slices)) {
        if (s.halt?.question) {
          const choice = haltAnswer(ctx, s.halt.question);
          if (choice) {
            // Try again: one more attempt; Stop here: the same, but only at the next --resume (nothing new starts now)
            s.ownerRetries = (s.ownerRetries ?? 0) + 1;
            s.halt = null;
            if (choice === 'stop') stopping ??= 'slice';
            if ((s.state === 'failed' || s.state === 'blocked') && !requeue(id)) s.halt = { kind: 'slice', question: askHalt(ctx, 'slice') };
            save();
          }
        } else if ((s.state === 'blocked' || s.state === 'failed') && !inFlight.has(id)) {
          // left so by the reconcile after a restart (B2: a merge it could not make, a salvage that failed)
          const rebuild = s.state === 'blocked' && /^conflict/.test(String(s.reason)) && s.rebuilds < budget(s);
          if (!rebuild || !requeue(id)) s.halt = { kind: 'slice', question: askHalt(ctx, 'slice') };
          save();
        } else if (s.state === 'owner' && !state.hold && !stopping && !inFlight.has(id) && answeredCard(ctx, s.question)) {
          start(id, () => takeAnswer(ctx, s.question));
          picked = true;
        }
      }
      // a picked answer takes its seat (owner -> running) before this round dispatches
      if (picked) {
        picked = false;
        await null;
      }
      if (state.red?.question) {
        const choice = haltAnswer(ctx, state.red.question);
        if (choice) {
          // Try again: one more fixer and retest; Stop here: the same at the next --resume
          Object.assign(state.red, { fixed: false, question: null });
          if (choice === 'stop') stopping ??= 'red';
          save();
        }
      }
      if (!state.red) {
        while (mergeQueue.length && !state.red) await mergeOne(mergeQueue.shift());
        for (const [id, s] of Object.entries(state.slices)) if (!state.red && s.state === 'merged' && s.tests === null) await testMerge(id);
      }
      if (state.red && !state.red.question && !inFlight.size && !stopping && !state.hold) await fixRed();
      if (!state.red && !state.hold && !stopping) for (const id of nextReady(state, { maxBuilders: ctx.settings.maxBuilders })) dispatch(id);
      const queued = mergeQueue.length > 0 || retryLater.length > 0;
      if (!inFlight.size && !ended.length && (!queued || (state.red && (stopping || state.hold)))) {
        if (stopping) stopAt(ctx, 'build', stopping);
        const all = Object.values(state.slices);
        if (!state.red && all.every((s) => (s.state === 'merged' && s.tests === 'green') || s.state === 'done-before')) {
          syncStateWarn(ctx);
          return { result: 'done' };
        }
        if (state.hold) {
          save();
          ctx.log(`paused (${state.hold.reason})`);
          return { result: 'paused' };
        }
      }
      if (ended.length) continue;
      await Promise.race([...inFlight.values(), ctx.deps.sleep(ctx.deps.pollMs)]);
    }
  } catch (err) {
    if (!(err instanceof Paused) && !(err instanceof Stopped)) ctx.dead = true;
    throw err;
  }
}

// A card the owner answered (or one already on its way): its answer is in the answers file and it is not open.
function answeredCard(ctx, id) {
  if (!id) return false;
  const q = readQuestions(ctx.root, ctx.phase).find((x) => x.id === id);
  if (q?.state === 'open') return false;
  return Boolean(liveAnswer(readAnswers(ctx.root, ctx.phase), id));
}

// --- steps review, verify, security (spec §6.3 steps 6–8, §5.3) ----------------------------------------------------

// Code files changed between two commits (.planning/ left out).
function changedCode(root, from, to = 'HEAD') {
  if (!from) return [];
  return git(root, ['diff', '--name-only', `${from}..${to}`]).split(/\r?\n/).filter((f) => f && !f.startsWith('.planning/'));
}
const flatTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const padOf = (ctx, rel) => ctx.state.info?.padded || path.posix.basename(rel).split('-')[0];
const readRel = (root, rel) => {
  try {
    return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  } catch {
    return '';
  }
};
const contextOf = (ctx) => {
  const { rel, art } = phaseFiles(ctx);
  return { rel, contextPath: art.context ? `${rel}/${art.context}` : `${rel}/${padOf(ctx, rel)}-CONTEXT.md` };
};

// The retest after a fixer (a plain test-changed); red -> the owner's card for this step (retry runs the fix again).
async function retestAfterFix(ctx, step) {
  const t = await runMergeTests(ctx.root, ctx.runDir, ctx.phase, { sha: null });
  if (t.green) return true;
  ctx.log(`tests red after the ${step} fixes: ${t.line}`);
  await halt(ctx, 'red', { step });
  return false;
}

async function stepReview(ctx) {
  const { root, phase, state } = ctx;
  const base = state.roundBase ?? state.base;
  const { rel, contextPath } = contextOf(ctx);
  const padded = padOf(ctx, rel);
  const reviewRel = `${rel}/${padded}-REVIEW.md`;
  let rec = state.steps.review;
  const patch = (p) => {
    rec = setStep(state, 'review', p, ctx.deps.now());
    ctx.save();
  };
  if (!rec.phase) {
    const files = changedCode(root, base);
    if (!files.length) return { result: 'skipped', why: 'no code changed in this phase' };
    patch({ phase: 'review', rounds: 0, seen: [] });
  }
  const review = async (files, paragraph = null) => {
    const prompt = stepPrompt('review', { phaseDir: rel, reviewPath: reviewRel, base, files, paragraph });
    await converse(ctx, { step: 'review', role: 'reviewer', effortKey: 'reviewer', agent: 'gsd-code-reviewer', cwd: root, key: `${phase}-review`, prompt });
    if (!fs.existsSync(path.join(root, ...reviewRel.split('/')))) throw new BuildFailed(`the code review wrote no ${path.posix.basename(reviewRel)}`);
    gsdCommit(ctx, `docs(phase-${phase}): code review`, [reviewRel]);
    return reviewFindings(readRel(root, reviewRel)).filter((f) => f.severity === 'critical' || f.severity === 'warning');
  };
  for (;;) {
    if (rec.phase === 'review') {
      const found = await review(changedCode(root, base));
      if (!found.length) return { result: 'done' };
      patch({ phase: 'fix', since: null, findings: found.map(({ code, severity, title, files }) => ({ code, severity, title, files })), findingIds: null, seen: found.filter((f) => f.severity === 'critical').map((f) => flatTitle(f.title)) });
      ctx.deps.checkpoint('review:reviewed');
    }
    if (rec.phase === 'fix') {
      if (!rec.since) patch({ since: head(root) });
      const r = await converse(ctx, {
        step: 'review', role: 'fixer', effortKey: 'fixer', cwd: root, key: `${phase}-fix-review`,
        prompt: rolePrompt('fixer', { root, phase, contextPath, findingsPath: reviewRel, diffRange: `${base}..${rec.since}`, ...(rec.findingIds ? { findingIds: rec.findingIds } : {}), lang: ctx.lang }),
      });
      // the fixer's report kept: a restart after it goes on with the retest, never a second fixer
      patch({ phase: 'retest', fixerResult: String(r.result ?? '') });
    }
    if (rec.phase === 'retest') {
      if (!(await retestAfterFix(ctx, 'review'))) {
        patch({ phase: 'fix' });
        continue;
      }
      const notFixed = new Set([...String(rec.fixerResult ?? '').matchAll(/^\s*`?([A-Z0-9]+(?:-[A-Z0-9]+)*-\d+)`?\s*[—–-]+\s*not fixed/gim)].map((m) => m[1].toUpperCase()));
      const subjects = git(root, ['log', '--format=%s', `${rec.since}..HEAD`]).split(/\r?\n/);
      const fixedBy = (code) => subjects.some((s) => s.toLowerCase().startsWith(`fix(${padded}): ${code}`.toLowerCase()));
      const open = rec.findings.filter((f) => notFixed.has(f.code.toUpperCase()) || !fixedBy(f.code)).map(({ code, severity, title, files }) => ({ code, severity, title, files, why: 'the fixer did not fix it' }));
      patch({ phase: 'rereview', open, rounds: (rec.rounds ?? 0) + 1 });
    }
    if (rec.phase === 'rereview') {
      const files = [...new Set([...changedCode(root, rec.since), ...rec.open.flatMap((f) => f.files ?? [])])].filter((f) => !f.startsWith('.planning/'));
      const found = await review(files.length ? files : changedCode(root, base), reviewDiffText({ since: rec.since, open: rec.open.map(({ code, severity, title, why }) => ({ code, severity, title, why })) }));
      const critical = found.filter((f) => f.severity === 'critical');
      const seen = new Set(rec.seen ?? []);
      const old = critical.filter((f) => seen.has(flatTitle(f.title)));
      const fresh = critical.filter((f) => !seen.has(flatTitle(f.title)));
      if (!old.length && fresh.length && rec.rounds < 2) {
        patch({ phase: 'fix', since: null, findings: fresh.map(({ code, severity, title, files }) => ({ code, severity, title, files })), findingIds: fresh.map((f) => f.code), seen: [...seen, ...fresh.map((f) => flatTitle(f.title))] });
        continue;
      }
      if (!old.length && !fresh.length) return { result: 'done' };
      ctx.log(`the review still finds ${critical.map((f) => f.code).join(', ')}`);
      const choice = await halt(ctx, 'review', { step: 'review' });
      if (choice === 'go-on') {
        patch({ accepted: state.steps.review.lastCard });
        return { result: 'done' };
      }
      patch({ phase: 'fix', since: null, findings: critical.map(({ code, severity, title, files }) => ({ code, severity, title, files })), findingIds: critical.map((f) => f.code) });
    }
  }
}

// One round more of slices for the gaps a verification or a UAT found (spec §6.3 step 7): the slicer with the report,
// the plans committed, the steps after the slice step cleared; the driver goes back to build. -> { result: 'gap' }
async function gapRound(ctx, step, findingsPath) {
  const { state } = ctx;
  const rec = state.steps[step];
  if (rec.phase !== 'slice') {
    state.gapRounds = (state.gapRounds ?? 0) + 1;
    setStep(state, step, { phase: 'slice', gapRound: (state.round ?? 0) + 1, findingsPath }, ctx.deps.now());
    ctx.save();
  }
  const round = state.steps[step].gapRound;
  ctx.log(`gap round ${round} from ${findingsPath}`);
  await sliceRound(ctx, { step, round, findingsPath });
  // B5: the slicer has read the UAT issues; they go back to pending, so the next UAT step re-tests them (uatPlan plans
  // only pending rows: an issue row would otherwise stay an issue after the round that fixed it)
  if (step === 'uat' && findingsPath) {
    const abs = path.join(ctx.root, ...findingsPath.split('/'));
    const r = retestRows(fs.readFileSync(abs, 'utf8'), { round, now: ctx.deps.now() });
    if (r.retest.length) {
      fs.writeFileSync(abs, r.text);
      gsdCommit(ctx, `test(phase-${ctx.phase}): UAT issues back to pending for the re-test after gap round ${round}`, [findingsPath]);
    }
  }
  for (const s of ['build', 'review', 'verify', 'security', 'uat', 'tests']) delete state.steps[s];
  state.step = 'build';
  ctx.save();
  return { result: 'gap' };
}

const verificationRel = (ctx) => {
  const { rel, art } = phaseFiles(ctx);
  return art.verification ? `${rel}/${art.verification}` : null;
};
const verificationStatus = (ctx, rel) => String(ctx.deps.gsd(['verification', 'status', rel])?.status ?? 'missing');
// passed, or the gaps the owner accepted at the verify card (Go on)
const verifiedOk = (ctx, status) => status === 'passed' || (status === 'gaps_found' && Boolean(ctx.state.steps.verify?.accepted) && ctx.state.steps.verify.acceptedOn === verificationDigest(ctx));
// the VERIFICATION.md the owner's Go on was given on (a later verification with new gaps is not covered by it)
const verificationDigest = (ctx) => {
  const rel = verificationRel(ctx);
  return rel ? createHash('sha256').update(readRel(ctx.root, rel).replace(/\r\n/g, '\n')).digest('hex') : null;
};

async function stepVerify(ctx) {
  const { root, phase, state } = ctx;
  const { rel } = phaseFiles(ctx);
  let rec = state.steps.verify;
  if (rec.phase === 'slice') return gapRound(ctx, 'verify', rec.findingsPath);
  for (;;) {
    if (rec.phase !== 'verified') {
      const info = readPhaseInfo(root, phase);
      const prompt = stepPrompt('verify', { phase, phaseDir: rel, goal: info.goal ?? '', reqIds: (info.requirements ?? []).map((r) => r.id) });
      await converse(ctx, { step: 'verify', role: 'verifier', effortKey: 'verifier', agent: 'gsd-verifier', cwd: root, key: `${phase}-verify`, prompt });
      const vrel = verificationRel(ctx);
      if (!vrel) throw new BuildFailed('the verifier wrote no VERIFICATION.md');
      gsdCommit(ctx, `docs(phase-${phase}): verification`, [vrel]);
      rec = setStep(state, 'verify', { phase: 'verified' }, ctx.deps.now());
      ctx.save();
    }
    const status = verificationStatus(ctx, rel);
    rec = setStep(state, 'verify', { status }, ctx.deps.now());
    ctx.save();
    if (status === 'passed' || status === 'human_needed') return { result: 'done' };
    if (status !== 'gaps_found') throw new BuildFailed(`verification status ${status}`);
    if ((state.gapRounds ?? 0) < gapRounds(ctx.config)) return gapRound(ctx, 'verify', verificationRel(ctx));
    const choice = await halt(ctx, 'verify', { step: 'verify' });
    if (choice === 'go-on') {
      setStep(state, 'verify', { accepted: state.steps.verify.lastCard, acceptedOn: verificationDigest(ctx) }, ctx.deps.now());
      return { result: 'done' };
    }
    // Try again past gap_rounds: one more gap round, the owner's (the same check would find the same gaps)
    return gapRound(ctx, 'verify', verificationRel(ctx));
  }
}

// The auditor's structured verdict: { status: secured | open | escalate, threatsOpen, blocking: [threat ids] }.
function securityVerdict(text) {
  const t = String(text ?? '');
  const status = /^##\s*ESCALATE\b/m.test(t) ? 'escalate' : /^##\s*OPEN_THREATS\b/m.test(t) ? 'open' : /^##\s*SECURED\b/m.test(t) ? 'secured' : 'escalate';
  const n = /threats_open:?\**:?\s*(\d+)/i.exec(t);
  const blocking = [];
  let inOpen = false;
  for (const line of t.split(/\r?\n/)) {
    if (/^#{2,4}\s/.test(line)) inOpen = /^#{2,4}\s+Open \(blocking/i.test(line);
    else if (inOpen && line.trim().startsWith('|')) {
      const id = line.split('|')[1]?.trim();
      if (id && /^[A-Z][A-Z0-9]*-[\w.-]+$/.test(id)) blocking.push(id);
    }
  }
  const threatsOpen = n ? Number(n[1]) : status === 'secured' ? 0 : blocking.length;
  // GSD's gate is threats_open, the open threats at or above block_on: an OPEN_THREATS verdict with none of them is
  // secured (secure-phase.md: below-threshold open threats may remain and are non-blocking)
  return { status: status === 'open' && threatsOpen === 0 ? 'secured' : status, threatsOpen, blocking };
}

// SECURITY.md written by the build path from the auditor's verdict (GSD's orchestrator owns the file; the agent has no
// Write tool).
export function securityReport({ phase, slug, verdict, asvs, now = new Date() }) {
  const v = securityVerdict(verdict);
  return [
    '---', `phase: "${phase}"`, `slug: "${slug}"`, `status: ${v.status}`, `threats_open: ${v.threatsOpen}`, `asvs_level: ${asvs}`, `created: "${iso(now).slice(0, 10)}"`, '---', '',
    `# Phase ${phase} — Security`, '', '## Threat Register', '', String(verdict ?? '').trim(), '', '## Audit Trail', '',
    '| When | Who | Result |', '|------|-----|--------|', `| ${iso(now)} | gsd-security-auditor (build path) | threats_open ${v.threatsOpen} |`, '',
  ].join('\n');
}

// GSD's own switch, workflow.security_enforcement (on unless set false; lean mode sets it false): while it is on, GSD's
// verify-work stops before it passes a phase without SECURITY.md, so the audit is no longer by condition. config-get
// without --default prints GSD's effective value.
function gsdEnforcesSecurity(ctx) {
  try {
    return String(ctx.deps.gsd(['config-get', 'workflow.security_enforcement'], { json: false }) ?? '').trim() === 'true';
  } catch (err) {
    ctx.log(`warn: config-get workflow.security_enforcement: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
    return false;
  }
}

async function stepSecurity(ctx) {
  const { root, phase, state } = ctx;
  const sec = needsSecurity(readPhaseInfo(root, phase));
  if (!sec.yes && !gsdEnforcesSecurity(ctx)) return { result: 'skipped', why: sec.why };
  if (!sec.yes) ctx.log('security: GSD\'s workflow.security_enforcement is on: the audit runs (GSD\'s verify-work needs SECURITY.md)');
  const { rel, contextPath } = contextOf(ctx);
  const padded = padOf(ctx, rel);
  const secRel = `${rel}/${padded}-SECURITY.md`;
  const cfg = (key, def) => String(ctx.deps.gsd(['config-get', key, '--default', def], { json: false }) ?? '').trim() || def;
  const asvs = cfg('workflow.security_asvs_level', '1');
  const blockOn = cfg('workflow.security_block_on', 'high');
  const files = changedCode(root, state.base);
  let rec = state.steps.security;
  const audit = async () => {
    const r = await converse(ctx, { step: 'security', role: 'security', effortKey: 'reviewer', agent: 'gsd-security-auditor', cwd: root, key: `${phase}-security`, prompt: stepPrompt('security', { phase, phaseDir: rel, files, asvs, blockOn }) });
    fs.writeFileSync(path.join(root, ...secRel.split('/')), securityReport({ phase, slug: path.posix.basename(rel).replace(/^[\d.]+-/, ''), verdict: r.result, asvs, now: ctx.deps.now() }));
    gsdCommit(ctx, `docs(phase-${phase}): security audit`, [secRel]);
    return securityVerdict(r.result);
  };
  const patch = (p) => {
    rec = setStep(state, 'security', p, ctx.deps.now());
    ctx.save();
  };
  for (;;) {
    if (rec.phase === 'fix') {
      await converse(ctx, { step: 'security', role: 'fixer', effortKey: 'fixer', cwd: root, key: `${phase}-fix-security`, prompt: rolePrompt('fixer', { root, phase, contextPath, findingsPath: secRel, ...(rec.blocking?.length ? { findingIds: rec.blocking } : {}), lang: ctx.lang }) });
      patch({ phase: 'retest', fixed: true });
    }
    if (rec.phase === 'retest') {
      // red after the fix and the owner's Try again: the fixer once more
      if (!(await retestAfterFix(ctx, 'security'))) {
        patch({ phase: 'fix' });
        continue;
      }
      patch({ phase: 'audit' });
    }
    const v = await audit();
    if (v.status === 'secured' && v.threatsOpen === 0) return { result: 'done' };
    if (v.status === 'open' && !rec.fixed) {
      patch({ phase: 'fix', blocking: v.blocking });
      continue;
    }
    const choice = await halt(ctx, 'security', { step: 'security' });
    if (choice === 'go-on') {
      setStep(state, 'security', { accepted: state.steps.security.lastCard }, ctx.deps.now());
      return { result: 'done' };
    }
    patch({ fixed: false, phase: 'audit' });
  }
}

// --- steps uat, tests, close (spec §6.3 steps 9–11) -----------------------------------------------------------------

// turbo-run <args> through deps.turbo; a failing exit -> BuildFailed with its last line (allowed: exits it may return).
async function turboOk(ctx, args, { allow = [0], ...o } = {}) {
  const r = await ctx.deps.turbo(args, o);
  if (!allow.includes(r.code)) throw new BuildFailed(`turbo-run ${args.join(' ')}: ${String(r.out ?? '').trim().split(/\r?\n/).at(-1) || `exit ${r.code}`}`);
  return r;
}

// One verifier pass in a later step (a stale report after UAT or after taking in the main branch). -> the new status
async function verifyAgain(ctx, step) {
  const { root, phase } = ctx;
  const { rel } = phaseFiles(ctx);
  const info = readPhaseInfo(root, phase);
  await converse(ctx, { step, role: 'verifier', effortKey: 'verifier', agent: 'gsd-verifier', cwd: root, key: `${phase}-verify`, prompt: stepPrompt('verify', { phase, phaseDir: rel, goal: info.goal ?? '', reqIds: (info.requirements ?? []).map((r) => r.id) }) });
  const vrel = verificationRel(ctx);
  if (vrel) gsdCommit(ctx, `docs(phase-${phase}): verification`, [vrel]);
  return verificationStatus(ctx, rel);
}

// The verifier's human items (VERIFICATION.md frontmatter human_verification: - test / expected) as GSD's UAT file,
// the shape execute-phase persists when verification is human_needed (the build path runs no execute-phase).
function seedUat(ctx, rel, padded) {
  const text = readRel(ctx.root, verificationRel(ctx) ?? '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const unq = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '');
  const items = [];
  let inHuman = false;
  for (const line of fm.split(/\r?\n/)) {
    if (/^human_verification:/.test(line)) inHuman = true;
    else if (/^\S/.test(line)) inHuman = false;
    else if (inHuman) {
      const t = /^\s*-\s*test:\s*(.*)$/.exec(line);
      const e = /^\s*expected:\s*(.*)$/.exec(line);
      if (t) items.push({ test: unq(t[1]), expected: '' });
      else if (e && items.length) items.at(-1).expected = unq(e[1]);
    }
  }
  if (!items.length) return null;
  const now = iso(ctx.deps.now());
  const name = `${padded}-UAT.md`;
  const body = [
    '---', 'status: testing', `phase: ${path.posix.basename(rel)}`, `source: [${padded}-VERIFICATION.md]`, `started: ${now}`, `updated: ${now}`, '---', '',
    '## Current Test', '', 'number: 1', `name: ${items[0].test}`, 'expected: |', `  ${items[0].expected}`, 'awaiting: user response', '', '## Tests', '',
    ...items.flatMap((it, i) => [`### ${i + 1}. ${it.test}`, `expected: ${it.expected}`, 'result: [pending]', '']),
    '## Summary', '', `total: ${items.length}`, 'passed: 0', 'issues: 0', `pending: ${items.length}`, 'skipped: 0', 'blocked: 0', '', '## Gaps', '',
  ].join('\n');
  fs.writeFileSync(path.join(ctx.root, ...rel.split('/'), name), body);
  gsdCommit(ctx, `test(${padded}): persist human verification items as UAT`, [`${rel}/${name}`]);
  return `${rel}/${name}`;
}

// A stand turbo-uat left (its stand.pid alive): only that process tree ends (the turbo-phase skill's rule).
function stopLeftStand(ctx) {
  const file = path.join(ctx.runDir, `uat-p${ctx.phase}`, 'stand.pid');
  let pid;
  try {
    pid = Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  killTree(pid);
}

const SIGN_TEXT = {
  en: (n) => `Phase ${n}: please check these items yourself and accept them.`,
  ru: (n) => `Фаза ${n}: проверьте эти пункты сами и примите их.`,
};

async function stepUat(ctx) {
  const { root, phase, state } = ctx;
  if (state.steps.uat.phase === 'slice') return gapRound(ctx, 'uat', state.steps.uat.findingsPath);
  const { rel } = phaseFiles(ctx);
  const padded = padOf(ctx, rel);
  let status = verificationStatus(ctx, rel);
  let uatRel = phaseFiles(ctx).art.uat ? `${rel}/${phaseFiles(ctx).art.uat}` : null;
  if (verifiedOk(ctx, status) && !uatRel) return { result: 'skipped', why: status === 'passed' ? 'verification passed: nothing to check by hand' : 'verification gaps accepted by the owner: nothing to check by hand' };
  if (!uatRel && status === 'human_needed') uatRel = seedUat(ctx, rel, padded);
  for (;;) {
    const plan = jsonOf((await turboOk(ctx, ['uat', 'plan', phase], { allow: [0, 1] })).out) ?? {};
    uatRel ??= plan.uatFile ?? null;
    if (Array.isArray(plan.items) && plan.items.length && plan.stand?.ok !== false) {
      await converse(ctx, { step: 'uat', role: 'uat', effortKey: 'verifier', agent: 'turbo-uat', cwd: root, key: `${phase}-uat`, prompt: stepPrompt('uat', { phase, phaseDir: rel }) });
      stopLeftStand(ctx);
      await turboOk(ctx, ['uat', 'stand', phase, 'cleanup']);
    }
    await turboOk(ctx, ['uat', 'defer', phase, '--rulings']);
    if (uatRel && !committedAsIs(root, uatRel)) gsdCommit(ctx, `test(phase-${phase}): owner-ruled UAT rows as deferred follow-ups`, [uatRel]);
    const req = jsonOf((await turboOk(ctx, ['uat', 'owner-request', phase, '--json'])).out) ?? {};
    if (req.needsOwner) {
      if (!Array.isArray(req.sign) || !req.sign.length) {
        const reason = `phase ${phase} build stopped at step uat: ${req.reason || 'the owner checks these items'}`;
        setStep(state, 'uat', { state: 'stopped' }, ctx.deps.now());
        ctx.save();
        writeLaneStatus(root, phase, 'failed', { reason, at: iso(ctx.deps.now()) });
        throw new Stopped(reason);
      }
      if (await signCard(ctx, req.sign, uatRel)) continue;
    }
    const issues = parseUat(readRel(root, uatRel ?? '')).tests.filter((t) => t.result === 'issue');
    if (issues.length) {
      if ((state.gapRounds ?? 0) < gapRounds(ctx.config)) return gapRound(ctx, 'uat', uatRel);
      // Try again past gap_rounds: one more gap round, the owner's (the same UAT would find the same issues)
      if ((await halt(ctx, 'verify', { step: 'uat' })) === 'retry') return gapRound(ctx, 'uat', uatRel);
    }
    await turboOk(ctx, ['uat', 'settle', phase]);
    if (uatRel) ctx.deps.gsd(['query', 'uat.complete-session', uatRel, '--message', `test(${phase}): complete UAT`]);
    status = verificationStatus(ctx, rel);
    if (status === 'stale') status = await verifyAgain(ctx, 'uat');
    if (status === 'human_needed') status = canonicalVerification(ctx, rel) ?? status;
    if (!verifiedOk(ctx, status)) throw new BuildFailed(`verification ${status} after UAT`);
    return { result: 'done' };
  }
}

// GSD's verify-work canonicalization (verify-work.md, #4663) without a verify-work session: B5's A/B showed that
// session stopping in its verify:pre and verify:post hooks (an API coverage matrix, SECURITY.md) on files the build
// path does not write. A report that waits only on human UAT, with GSD's own UAT predicate (phase uat-passed N
// --uat-only: exit 0 passed, exit 1 not yet) passing, gets status passed (one commit). -> the new status | null
function canonicalVerification(ctx, rel) {
  const vrel = verificationRel(ctx);
  if (!vrel) return null;
  let verdict = null;
  try {
    verdict = jsonOf(String(ctx.deps.gsd(['phase', 'uat-passed', ctx.phase, '--uat-only'], { json: false }) ?? ''));
  } catch (err) {
    ctx.log(`UAT does not pass GSD's predicate yet: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
    return null;
  }
  if (verdict?.passed !== true) {
    ctx.log(`UAT does not pass GSD's predicate yet: ${(verdict?.blockers ?? []).length} row(s) blocked or not passing`);
    return null;
  }
  ctx.deps.gsd(['query', 'frontmatter.set', vrel, '--field', 'status', '--value', 'passed'], { json: false });
  gsdCommit(ctx, `docs(phase-${ctx.phase}): verification passed after UAT`, [vrel]);
  return verificationStatus(ctx, rel);
}

// The owner's sign-off card for UAT rows (held): accept signs exactly those rows; not now stops the step.
// -> true (signed: the step starts again) | throws Stopped
async function signCard(ctx, sign, uatRel) {
  const { root, phase, state } = ctx;
  let id = state.steps.uat.sign;
  if (!id) {
    const tests = parseUat(readRel(root, uatRel ?? '')).tests;
    const signText = sign.map((n) => itemText(tests.find((t) => t.number === n) ?? { name: `row ${n}` }));
    id = askOwner(root, phase, { question: SIGN_TEXT[ctx.lang](phase), context: '', sign, signText }, { lang: ctx.lang, keepRunning: true, now: ctx.deps.now() }).question.id;
    setStep(state, 'uat', { sign: id }, ctx.deps.now());
    ctx.save();
    ctx.log(`asked ${id} (sign-off of UAT rows ${sign.join(', ')})`);
  }
  for (;;) {
    const q = readQuestions(root, phase).find((x) => x.id === id);
    const answer = liveAnswer(readAnswers(root, phase), id);
    if (answer && q?.state !== 'open') {
      setStep(state, 'uat', { sign: undefined }, ctx.deps.now());
      ctx.save();
      if (answer.option === 1) {
        await turboOk(ctx, ['uat', 'sign', phase, '--answer', id]);
        if (uatRel && !committedAsIs(root, uatRel)) gsdCommit(ctx, `test(phase-${phase}): owner sign-off from the question card`, [uatRel]);
        if (q?.state === 'answered') markDelivered(root, phase, id, 'lane', { now: ctx.deps.now() });
        return true;
      }
      if (q?.state === 'answered') markDelivered(root, phase, id, 'lane', { now: ctx.deps.now() });
      const reason = `phase ${phase} build stopped at step uat: the owner checks these items later; turbo-run resume ${phase} goes on`;
      setStep(state, 'uat', { state: 'stopped' }, ctx.deps.now());
      ctx.save();
      writeLaneStatus(root, phase, 'failed', { reason, at: iso(ctx.deps.now()) });
      throw new Stopped(reason);
    }
    const hold = holdOf(ctx);
    if (hold) throw new Paused(hold.reason);
    await ctx.deps.sleep(ctx.deps.pollMs);
  }
}

// The full test run (test.full) with one fixer on red, then the owner. -> true when green
async function fullTests(ctx, step) {
  const { root, phase } = ctx;
  const { contextPath } = contextOf(ctx);
  const dir = path.join(ctx.runDir, `build-p${phase}`);
  ensureDir(dir);
  for (let fixed = false; ;) {
    const logFile = path.join(dir, `tests-full-${Date.now()}.log`);
    const t = await ctx.deps.turbo(['test-changed'], { env: { TURBO_FULL: '1' }, logFile, timeoutMin: ctx.settings.timeoutMin });
    if (t.code === 0) return true;
    try {
      if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, String(t.out ?? ''));
    } catch { /* the fixer reads what there is */ }
    ctx.log(`the full test run is red (exit ${t.code})`);
    if (!fixed) {
      await converse(ctx, { step, role: 'fixer', effortKey: 'fixer', cwd: root, key: `${phase}-fix-full`, prompt: rolePrompt('fixer', { root, phase, contextPath, findingsPath: logFile, lang: ctx.lang }) });
      fixed = true;
      continue;
    }
    await halt(ctx, 'red', { step });
    fixed = false;
  }
}

async function stepTests(ctx) {
  const { root, phase, state } = ctx;
  let rec = state.steps.tests;
  if (rec.phase !== 'push') {
    await fullTests(ctx, 'tests');
    rec = setStep(state, 'tests', { phase: 'push', ciRounds: rec.ciRounds ?? 0 }, ctx.deps.now());
    ctx.save();
  }
  const push = pushSettings(ctx.config.push);
  if (push.mode === 'off') return { result: 'done', why: 'push.mode off: nothing pushed' };
  const { contextPath } = contextOf(ctx);
  for (let i = 0; i < 40; i++) {
    const red = unreadInbox(root, phase).filter((m) => m.kind === 'ci-red');
    if (red.length) {
      const m = red.at(-1);
      if ((state.steps.tests.ciRounds ?? 0) >= push.ci_fix_rounds) {
        await halt(ctx, 'ci', { step: 'tests' });
        setStep(state, 'tests', { ciRounds: 0 }, ctx.deps.now());
      }
      const file = path.join(ctx.runDir, `build-p${phase}`, `ci-red-${m.seq}.md`);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, `${formatInboxMessage(m, { phase, ciFixRounds: push.ci_fix_rounds })}\n`);
      ctx.log(`CI is red (run ${m.run ?? '?'}): one fix round`);
      await converse(ctx, { step: 'tests', role: 'fixer', effortKey: 'fixer', cwd: root, key: `${phase}-fix-ci`, prompt: rolePrompt('fixer', { root, phase, contextPath, findingsPath: file, lang: ctx.lang }) });
      markRead(root, phase, m.seq);
      setStep(state, 'tests', { ciRounds: (state.steps.tests.ciRounds ?? 0) + 1 }, ctx.deps.now());
      ctx.save();
      await fullTests(ctx, 'tests');
    }
    const p = await ctx.deps.turbo(['push-request', phase, '--at', 'phase', '--wait'], { timeoutMin: 15 });
    if (p.code === 0) return { result: 'done' };
    if (p.code === 3) continue;
    if (p.code === 1 && unreadInbox(root, phase).some((m) => m.kind === 'ci-red')) continue;
    throw new BuildFailed(`turbo-run push-request ${phase}: ${String(p.out ?? '').trim().split(/\r?\n/).at(-1) || `exit ${p.code}`}`);
  }
  throw new BuildFailed(`turbo-run push-request ${phase}: no result after 40 rounds`);
}

// The supervisor's merge-rounds card (main moved too often), named by a needs-owner lane record: Wait sets the merge
// The supervisor's merge-rounds card (main moved too often: lib/merge.mjs records needs-owner with the card in its merge
// record, and the lane record until the relaunch writes running), answered and not yet acted on. -> its id | null
function mergeRoundsCard(ctx) {
  const { root, phase } = ctx;
  const merge = readJson(mergeFile(root, phase), null);
  const lane = readLaneStatus(root, phase);
  const id = (merge?.state === 'needs-owner' ? /owner question (ask-\d+)/.exec(String(merge.reason ?? ''))?.[1] : null)
    ?? (lane?.status === 'needs-owner' ? askNamed(lane.reason) : null);
  if (!id || (ctx.state.handledCards ?? []).includes(id) || waiterOf(ctx, id) || Object.values(ctx.state.steps).some((s) => s?.question === id)) return null;
  const q = readQuestions(root, phase).find((x) => x.id === id);
  return liveAnswer(readAnswers(root, phase), id) && q?.state !== 'open' ? id : null;
}

// That card's answer: Wait sets the merge hold and integrates again; I merge it myself hands the phase to the owner.
// -> 'again' | 'owner' | null (none)
function mergeRoundsAnswer(ctx) {
  const { root, phase } = ctx;
  const id = mergeRoundsCard(ctx);
  if (!id) return null;
  const q = readQuestions(root, phase).find((x) => x.id === id);
  const answer = liveAnswer(readAnswers(root, phase), id);
  if (q?.state === 'answered') markDelivered(root, phase, id, 'lane', { now: ctx.deps.now() });
  ctx.state.handledCards = [...(ctx.state.handledCards ?? []), id];
  ctx.save();
  if (answer.option === 1) {
    setMergeHold(root, phase, { now: ctx.deps.now() });
    ctx.log(`${id}: the owner waits; the merge hold is set`);
    return 'again';
  }
  writeLaneStatus(root, phase, 'needs-owner', { reason: `the owner merges phase ${phase} by hand`, at: iso(ctx.deps.now()) });
  return 'owner';
}

async function stepClose(ctx) {
  const { root, phase, state } = ctx;
  if (!isSlot(root)) {
    ctx.deps.gsd(['query', 'phase.complete', phase]);
    syncStateWarn(ctx);
    gsdCommit(ctx, `docs(phase-${phase}): complete phase (build path)`, ['.planning/ROADMAP.md', '.planning/STATE.md', '.planning/REQUIREMENTS.md']);
    try {
      commitPendingAnswers(root);
    } catch (err) {
      ctx.log(`warn: owner answers: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
    }
    writeLaneStatus(root, phase, 'done', { reason: 'build path: phase complete', at: iso(ctx.deps.now()) });
    if (!process.env.TURBO_BUILD_LANE) {
      try {
        logPhaseCost({ root, phase });
      } catch (err) {
        ctx.log(`warn: cost line: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
      }
    }
    return { result: 'done' };
  }
  if (mergeRoundsAnswer(ctx) === 'owner') return { result: 'paused' };
  const integrate = ctx.deps.integrate ?? ((r, p) => integrateMain(r, p, { now: ctx.deps.now() }));
  for (let resolved = false; ;) {
    const r = integrate(root, phase);
    if (r.state === 'conflicts') {
      if (!resolved) {
        ctx.log(`integrate: conflicts in ${r.conflicts.join(', ')}`);
        await converse(ctx, { step: 'close', role: 'integrate', effortKey: 'fixer', cwd: root, key: `${phase}-integrate`, prompt: stepPrompt('integrate', { files: r.conflicts, lang: ctx.lang }) });
        resolved = true;
        continue;
      }
      await halt(ctx, 'integrate', { step: 'close' });
      resolved = false;
      continue;
    }
    if (!r.base) throw new BuildFailed(`turbo-run integrate ${phase}: ${r.state}`);
    await fullTests(ctx, 'close');
    const { rel } = phaseFiles(ctx);
    let status = verificationStatus(ctx, rel);
    if (status === 'stale') status = await verifyAgain(ctx, 'close');
    if (!verifiedOk(ctx, status)) throw new BuildFailed(`verification ${status} after taking in the main branch`);
    writeLaneStatus(root, phase, 'ready', { fields: readyRecord(root, phase, { base: r.base }), at: iso(ctx.deps.now()) });
    ctx.log(`ready to merge (base ${r.base.slice(0, 7)})`);
    return { result: 'done' };
  }
}

const STEP_FNS = { begin: stepBegin, discuss: stepDiscuss, research: stepResearch, slice: stepSlice, build: stepBuild, review: stepReview, verify: stepVerify, security: stepSecurity, uat: stepUat, tests: stepTests, close: stepClose };

// One step of the phase, idempotent: a step already done or skipped answers so at once; a stopped one is tried afresh.
// -> 'done' | 'skipped' | 'gap' | 'paused' | 'stopped'
export async function runStep(ctx, step) {
  if (!BUILD_STEPS.includes(step)) throw new Error(`unknown build step: ${step}`);
  const rec = ctx.state.steps[step];
  if (rec?.state === 'done' || rec?.state === 'skipped') return rec.state;
  if (rec?.state === 'owner') ctx.state.step = step;
  else setStep(ctx.state, step, { state: 'running', why: undefined, halt: undefined, question: undefined }, ctx.deps.now());
  ctx.save();
  try {
    const out = await STEP_FNS[step](ctx);
    if (out.result === 'gap' || out.result === 'paused') return out.result;
    setStep(ctx.state, step, { state: out.result, ...(out.why ? { why: out.why } : {}) }, ctx.deps.now());
    ctx.save();
    ctx.log(`step ${step} ${out.result}${out.why ? `: ${out.why}` : ''}`);
    return out.result;
  } catch (err) {
    if (err instanceof Paused) {
      ctx.save();
      return 'paused';
    }
    if (err instanceof Stopped) {
      ctx.stopped = err.message;
      return 'stopped';
    }
    throw err;
  }
}

// --- the driver ------------------------------------------------------------------------------------------------------

// A recorded session that may still run: its pid alive and its transcript written lately, or started within the
// session time limit (Windows reuses pids: an old record never names a stranger's process).
function sessionLive(ctx, rec) {
  if (!Number.isInteger(rec?.pid) || rec.pid < 1) return false;
  try {
    process.kill(rec.pid, 0);
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
  }
  const now = Date.now();
  let lastMs = Date.parse(rec.at);
  try {
    if (rec.transcript) lastMs = Math.max(lastMs, fs.statSync(rec.transcript).mtimeMs);
  } catch { /* no transcript yet */ }
  return Number.isFinite(lastMs) && now - lastMs < ctx.settings.timeoutMin * 60000;
}

// --resume (spec §6.6): the sessions of the dead run end first (their output cannot be read again); the slices are
// checked against git and the disk (B2's reconcile: nothing merged twice, partial work salvaged); cards the questions
// file lost are asked again; an unread reintegrate or ci-red opens close or tests again.
// Steps opened again (an inbox message, a card): their records go, and the build goes back to the first of them.
function reopenSteps(ctx, steps) {
  for (const s of steps) delete ctx.state.steps[s];
  const first = BUILD_STEPS.find((s) => steps.includes(s));
  if (BUILD_STEPS.indexOf(ctx.state.step) > BUILD_STEPS.indexOf(first) || !ctx.state.step) ctx.state.step = first;
}

async function resumeState(ctx) {
  const { root, phase } = ctx;
  // the run before's hold is no pause of this run (turbo-run stop must not read it as a second stop)
  ctx.state.hold = null;
  ctx.save();
  const ended = [];
  for (const rec of Object.values(ctx.state.steps)) {
    if (rec?.session && sessionLive(ctx, rec.session)) {
      ctx.log(`ends session ${rec.session.id} (pid ${rec.session.pid}) of the run before`);
      killTree(rec.session.pid);
      ended.push(rec.session.pid);
    }
  }
  for (const [id, s] of Object.entries(ctx.state.slices ?? {})) {
    const last = s.sessions?.at(-1);
    if (s.pid && sessionLive(ctx, { ...last, pid: s.pid, at: last?.at ?? s.at?.running })) {
      ctx.log(`ends the builder of ${id} (pid ${s.pid}) of the run before`);
      killTree(s.pid);
      ended.push(s.pid);
    }
  }
  // their worktrees are removed below: a process still in one keeps it on Windows
  for (const pid of ended) {
    for (let i = 0; i < 50 && processAlive(pid); i++) await ctx.deps.sleep(100);
  }
  const sliced = ['done', 'skipped'].includes(ctx.state.steps.slice?.state);
  if (sliced && ctx.state.steps.build?.state !== 'done') {
    const { state, actions } = reconcileBuildState(root, ctx.runDir, phase, { alive: () => false, now: ctx.deps.now() });
    ctx.state = state;
    for (const a of actions) {
      ctx.log(`reconcile: ${a.id ?? 'phase'} ${a.action}${a.detail ? ` (${a.detail})` : ''}`);
      if (a.action !== 'reask') continue;
      const s = state.slices[a.id];
      try {
        s.question = askOwner(root, phase, askInput(s.ownerQuestion), { lang: ctx.lang, keepRunning: true, now: ctx.deps.now() }).question.id;
      } catch (err) {
        ctx.log(`slice ${a.id}: its question could not be asked again: ${err.message}`);
        setSlice(state, a.id, 'waiting', { question: null, ownerQuestion: null }, ctx.deps.now());
      }
    }
    ctx.save();
  }
  // a fresh run decides its own pause (holdOf); an old hold must not read as the owner's second stop
  ctx.state.hold = null;
  if (ctx.state.steps.close && mergeRoundsCard(ctx)) reopenSteps(ctx, ['close']);
  const unread = unreadInbox(root, phase);
  const reopen = (steps) => reopenSteps(ctx, steps);
  if (unread.some((m) => m.kind === 'ci-red') && ctx.state.steps.tests) reopen(['tests', 'close']);
  const again = unread.filter((m) => m.kind === 'reintegrate');
  if (again.length && ctx.state.steps.close) {
    reopen(['close']);
    markRead(root, phase, Math.max(...again.map((m) => m.seq)));
  }
  ctx.save();
}

const slicesOf = (state) => {
  const all = Object.values(state.slices ?? {});
  return { total: all.length, merged: all.filter((s) => s.state === 'merged' || s.state === 'done-before').length };
};

// The session settings and temp directories of a closed build (lib/headless.mjs sessionSettings), by their keys.
function removeSettings(ctx) {
  const keys = new Set([
    ...Object.values(ctx.state.steps).map((s) => s?.session?.key),
    ...Object.values(ctx.state.slices ?? {}).flatMap((s) => (s.sessions ?? []).map((x) => x.key)),
  ].filter(Boolean));
  for (const key of keys) {
    try {
      removeSessionSettings({ root: ctx.control, key });
    } catch { /* in use, or gone already */ }
  }
}

// The phase by its steps, from the recorded one. -> { outcome: 'closed'|'paused'|'failed', step, why, slices }
export async function runBuild({ root, phase, resume = false, deps = {} }) {
  const ctx = await openBuild(root, phase, { resume, deps });
  const N = ctx.phase;
  try {
    if (ctx.resumed && !resume) {
      const e = new BuildFailed(`phase ${N} has a build in progress (step ${ctx.state.step}): turbo-run build ${N} --resume continues it`);
      e.refused = true;
      throw e;
    }
    ctx.log(resume ? `resumes at step ${ctx.state.step}` : 'starts');
    if (resume) await resumeState(ctx);
    for (let i = Math.max(0, BUILD_STEPS.indexOf(ctx.state.step)); i < BUILD_STEPS.length;) {
      const step = BUILD_STEPS[i];
      // the owner's pause (attend, stop) between steps: nothing new starts
      const hold = holdOf(ctx);
      if (hold) {
        ctx.state.hold = hold;
        ctx.save();
        ctx.log(`paused (${hold.reason}) before step ${step}`);
        return { outcome: 'paused', step, why: hold.reason, slices: slicesOf(ctx.state) };
      }
      const out = await runStep(ctx, step);
      if (out === 'done' || out === 'skipped') {
        ctx.deps.checkpoint(`step:${step}`);
        i += 1;
        continue;
      }
      if (out === 'gap') {
        i = BUILD_STEPS.indexOf('build');
        continue;
      }
      if (out === 'paused') return { outcome: 'paused', step, why: ctx.state.hold?.reason ?? readLaneStatus(root, N)?.reason ?? '', slices: slicesOf(ctx.state) };
      return { outcome: 'failed', step, why: ctx.stopped ?? '', slices: slicesOf(ctx.state) };
    }
    ctx.log('closed');
    removeSettings(ctx);
    return { outcome: 'closed', step: 'close', why: '', slices: slicesOf(ctx.state) };
  } catch (err) {
    if (err instanceof BuildFailed && !err.refused) {
      ctx.log(`failed: ${err.message}`);
      writeLaneStatus(root, N, 'failed', { reason: err.message, at: iso(ctx.deps.now()) });
      ctx.save();
      return { outcome: 'failed', step: ctx.state.step, why: err.message, slices: slicesOf(ctx.state) };
    }
    ctx.dead = true;
    throw err;
  } finally {
    ctx.release();
  }
}

// turbo-run build <N> [--resume] [--json]: exit 0 closed, 1 failed, 2 usage or refused, 3 paused or already running.
export async function runBuildCommand(args, { root, out, err, env = process.env, deps }) {
  let resume = false;
  let json = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--resume') resume = true;
    else if (a === '--json') json = true;
    else if (a === '--project') i += 1;
    else pos.push(a);
  }
  if (pos.length !== 1 || !/^[A-Za-z0-9._-]+$/.test(pos[0]) || pos[0].startsWith('-')) {
    err(BUILD_USAGE);
    return 2;
  }
  const N = normalizePhaseId(pos[0]);
  const pick = buildPathFor(root, N);
  if (!pick.build) {
    err(`refused: ${pick.why}; phase ${N} runs the lean path (/turbo-phase)`);
    if (env.TURBO_BUILD_LANE) writeLaneStatus(root, N, 'failed', { reason: `build refused: ${pick.why}` });
    return 2;
  }
  let r;
  try {
    // --json keeps stdout for the outcome: the build's lines go to stderr
    r = await runBuild({ root, phase: N, resume, deps: { ...(json ? { log: (l) => process.stderr.write(`${l}\n`) } : {}), ...deps } });
  } catch (e) {
    if (e instanceof BuildFailed && e.busy) {
      err(e.message);
      return 3;
    }
    if (e instanceof BuildFailed && e.refused) {
      err(e.message);
      return 2;
    }
    throw e;
  }
  if (json) out(JSON.stringify({ phase: N, ...r }));
  else if (r.outcome === 'closed') out(`phase ${N}: build closed`);
  else if (r.outcome === 'paused') out(`phase ${N}: build paused (${r.why || 'paused'})`);
  else out(`phase ${N}: build failed: ${r.why}`);
  return r.outcome === 'closed' ? 0 : r.outcome === 'paused' ? 3 : 1;
}

