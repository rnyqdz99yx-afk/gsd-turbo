import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { buildSettings, laneEffort, loadConfig } from './config.mjs';
import { acquireSessionSlot, killTree, resumeSession as resumeHeadless, runSession as runHeadless, sessionSettings } from './headless.mjs';
import { BuildLocked, BuildStateDamaged, createSliceWorktree, loadBuildState, mergeSlice, newBuildState, nextReady, planGraph, removeSliceWorktree, runMergeTests, saveBuildState, setSlice, sliceBranch } from './build-queue.mjs';
import { claimRunner } from './build-lane.mjs';
import { recordSessionUsage } from './cost.mjs';
import { askOwner, liveAnswer, markDelivered, readAnswers, readQuestions } from './questions.mjs';
import { commitPendingAnswers, laneDeliveryMessage, preAnswerText } from './answers.mjs';
import { gsdCoreDir, logsDir, runDir, stateRoot } from './paths.mjs';
import { normalizePhaseId, runGsdJson } from './gsd.mjs';
import { gsdText } from './gates.mjs';
import { writeLaneStatus } from './run-status.mjs';
import { ensureDir } from './fsx.mjs';
import { lintSlices } from './slice-lint.mjs';
import { attendMark } from './attend.mjs';
import { readOwnerStop } from './autostart.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { needsResearch, readPhaseInfo } from './phase-signals.mjs';
import { fillTemplate, rolePrompt } from './roles.mjs';
import { formatProblems } from './slice-lint.mjs';
import { stateSync } from './state-sync.mjs';
import { LEAN_RESEARCH_RULE } from './lane-prompt.mjs';

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
    goOn: { label: 'Go on', description: 'accept it as it is and go to the next step' },
    stop: (n) => ({ label: 'Stop here', description: `the phase waits; \`turbo-run resume ${n}\` starts it again` }),
  },
  ru: {
    question: (n, what) => `Фаза ${n}: ${what}. Что делать сборке?`,
    retry: { label: 'Ещё раз', description: 'сборка повторит этот шаг' },
    goOn: { label: 'Дальше', description: 'принять как есть и перейти к следующему шагу' },
    stop: (n) => ({ label: 'Остановить', description: `фаза ждёт; \`turbo-run resume ${n}\` запустит её снова` }),
  },
};
const haltWhat = (kind, lang) => HALT_WHAT[kind][lang === 'ru' ? 1 : 0];

// The card a halt asks, in the owner's language. -> askOwner input { question, context, options, recommended }
export function haltQuestion(kind, { phase, lang = 'en' }) {
  if (!HALT_KINDS.includes(kind)) throw new Error(`unknown halt kind: ${kind}`);
  const T = HALT_TEXT[lang === 'ru' ? 'ru' : 'en'];
  const options = [T.retry, ...(GO_ON_KINDS.has(kind) ? [T.goOn] : []), T.stop(phase)];
  return { question: T.question(phase, haltWhat(kind, lang)), context: '', options: options.map((o) => ({ ...o })), recommended: 1 };
}

// What the owner chose on a halt card: retry, go-on, or stop (the last option, or the owner's own words).
function haltChoice(q, r) {
  const label = Number.isInteger(r?.option) ? q.options?.[r.option - 1]?.label : null;
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
  const release = await ctx.deps.slot({ max: ctx.settings.maxSessions, label: `p${ctx.phase} ${role}` });
  let r;
  try {
    const recorded = slice ? null : state.steps[step]?.session?.key === key ? state.steps[step].session.settings : null;
    const settingsFile = settingsFor(ctx, { key, cwd, recorded });
    const effort = effortOf(ctx, effortKey);
    const onStart = ({ sessionId, pid, transcript }) => {
      if (ctx.dead) return;
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
  if (!ctx.dead) recordCost(ctx, step, role, r);
  return r;
}

// The same session continued with text (an answer, a correction), under a slot; its usage recorded. -> SessionResult
async function resumeIn(ctx, where, text) {
  const rec = sessionOf(ctx, where);
  if (!rec?.id) throw new BuildFailed(`no session to continue for ${where.slice ? `slice ${where.slice}` : `step ${where.step}`}`);
  const step = where.slice ? 'build' : where.step;
  const release = await ctx.deps.slot({ max: ctx.settings.maxSessions, label: `p${ctx.phase} ${rec.role}` });
  let r;
  try {
    const cwd = rec.cwd ?? ctx.root;
    const settingsFile = settingsFor(ctx, { key: rec.key, cwd, recorded: rec.settings });
    const onStart = ({ pid }) => {
      if (ctx.dead) return;
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
  if (!ctx.dead) recordCost(ctx, step, rec.role, r);
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
  if (q?.state === 'answered') markDelivered(ctx.root, ctx.phase, id, 'lane', { now: ctx.deps.now() });
  const card = q ?? { id, options: [] };
  if (where.slice) setSlice(ctx.state, where.slice, 'running', {}, ctx.deps.now());
  else setStep(ctx.state, where.step, { state: 'running' }, ctx.deps.now());
  ctx.save();
  ctx.log(`answer ${id} goes to ${whereText(where)}`);
  return resumeIn(ctx, where, laneDeliveryMessage(card, answer));
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
    const r = await takeAnswer(ctx, id);
    if (r) return r;
    if (!waiterOf(ctx, id)) throw new BuildFailed(`card ${id} has nothing waiting for it`);
    const hold = holdOf(ctx);
    if (hold) throw new Paused(hold.reason);
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
      setStep(ctx.state, step, { state: 'running', halt: undefined, question: undefined }, ctx.deps.now());
      ctx.save();
      return choice;
    }
    const hold = holdOf(ctx);
    if (hold) throw new Paused(hold.reason);
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
    if (rec?.state === 'owner' && rec.question && !rec.halt) r = await waitAnswer(ctx, rec.question);
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
    ctx.deps.gsd(['query', 'state.begin-phase', '--phase', phase, '--name', state.info?.name ?? '', '--plans', String(art.plans.length)]);
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
function parkSlice(ctx, id) {
  const s = ctx.state.slices[id];
  const branch = s.branch ?? sliceBranch(id);
  const r = s.worktree ? removeSliceWorktree(ctx.root, { path: s.worktree, branch, deleteBranch: false }) : { leftover: null };
  if (r.leftover) s.leftover = r.leftover;
  if (!hasBranch(ctx.root, branch)) return;
  if (git(ctx.root, ['rev-list', '--count', `HEAD..refs/heads/${branch}`]) === '0') {
    git(ctx.root, ['branch', '-q', '-D', branch]);
    return;
  }
  const stem = `turbo-salvage/${id}-${utcStamp(ctx.deps.now())}`;
  let name = stem;
  for (let i = 2; hasBranch(ctx.root, name); i++) name = `${stem}-${i}`;
  git(ctx.root, ['branch', '-m', branch, name]);
  s.salvage = [...(s.salvage ?? []), name];
  ctx.log(`slice ${id}: its work is kept on ${name}`);
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
    if (s.retries < budget(s)) {
      parkSlice(ctx, id);
      setSlice(state, id, 'waiting', { worktree: null, branch: null, base: null, links: [] }, now());
      save();
      return;
    }
    s.halt = { kind: 'slice', question: askHalt(ctx, 'slice') };
    save();
  };
  const dispatch = (id) => {
    const s = state.slices[id];
    const base = head(root);
    let wt;
    try {
      wt = createSliceWorktree(root, { phase, id, baseSha: base });
    } catch (err) {
      failSlice(id, `its worktree could not be made: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
      return;
    }
    setSlice(state, id, 'dispatched', { worktree: wt.path, branch: wt.branch, base, links: wt.links, reason: null }, now());
    save();
    ctx.log(`dispatch ${id}`);
    const prompt = rolePrompt('builder', { root, phase, contextPath, planPath: s.plan, preanswers: preAnswerText(root, phase, id), lang: ctx.lang });
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
        parkSlice(ctx, id);
        setSlice(state, id, 'waiting', { worktree: null, branch: null, base: null, links: [] }, now());
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
          if (choice === 'stop') stopping ??= 'slice';
          else if (choice) {
            s.ownerRetries = (s.ownerRetries ?? 0) + 1;
            s.halt = null;
            if (s.state === 'failed' || s.state === 'blocked') {
              parkSlice(ctx, id);
              setSlice(state, id, 'waiting', { worktree: null, branch: null, base: null, links: [] }, now());
            }
            save();
          }
        } else if (s.state === 'owner' && !state.hold && !stopping && !inFlight.has(id) && answeredCard(ctx, s.question)) {
          start(id, () => takeAnswer(ctx, s.question));
        }
      }
      if (state.red?.question) {
        const choice = haltAnswer(ctx, state.red.question);
        if (choice === 'stop') stopping ??= 'red';
        else if (choice) {
          Object.assign(state.red, { fixed: false, question: null });
          save();
        }
      }
      if (!state.red) {
        while (mergeQueue.length && !state.red) await mergeOne(mergeQueue.shift());
        for (const [id, s] of Object.entries(state.slices)) if (!state.red && s.state === 'merged' && s.tests === null) await testMerge(id);
      }
      if (state.red && !state.red.question && !inFlight.size && !stopping) await fixRed();
      if (!state.red && !state.hold && !stopping) for (const id of nextReady(state, { maxBuilders: ctx.settings.maxBuilders })) dispatch(id);
      if (!inFlight.size && !ended.length && !mergeQueue.length && !retryLater.length) {
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

const STEP_FNS = { begin: stepBegin, discuss: stepDiscuss, research: stepResearch, slice: stepSlice, build: stepBuild };

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
    if (err instanceof Stopped) return 'stopped';
    throw err;
  }
}

