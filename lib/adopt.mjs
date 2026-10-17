import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { localRunDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { isSentinelPhase, normalizePhaseId, normalizePhases, readVersion } from './gsd.mjs';
import { ANY_AREA, comparePhase, isFinished } from './scheduler.mjs';
import { leanSettings, loadConfig, lanesSettings } from './config.mjs';
import { LEAN_CONTEXT_WINDOW, LEAN_PREV_REL } from './lean.mjs';
import { LANES_REL, ROADMAP_REL, readLanesRaw, readRoadmap, stalePhases } from './lanes-file.mjs';
import { roadmapDigest } from './roadmap-lanes.mjs';
import { findPhaseDir, phaseArtifacts, planOutline } from './phase-files.mjs';
import { planSetCheck } from './cli-phase.mjs';
import { openQuestions } from './view.mjs';
import { agentWorktrees } from './worktrees.mjs';
import { ABSENT, commitPaths, createGsdConfig, gatesLeftovers } from './gates.mjs';
import { listSlots, maxLanes } from './slots.mjs';
import { parseUat } from './uat.mjs';
import { analysisFile, applyAnalysis, previewAnalysis, relaxCard } from './annotate.mjs';
import { DECISIONS_DIR_REL, DECISIONS_FILE_REL, MARKUP_MIN_INDEPENDENT, independentCount } from './prep.mjs';
import { GSD_CONFIG_REL, initChanges, initProject } from './project-init.mjs';
import { forecast, phaseHours, stepsLine } from './adopt-forecast.mjs';

// Stage 5 A (spec §4): /turbo-adopt moves a milestone that runs on plain GSD onto turbo. This module holds its
// deterministic parts; the skill conducts the LLM parts (the lane analyst, the verifiers, AskUserQuestion). Nothing here
// starts a claude session, the supervisor, a lane or a job, makes slots, writes trust or removes a worktree (D2).

export const ADOPT_REL = '.planning/turbo/adopt.json';
export const ADOPT_DIR_REL = '.planning/turbo/adopt';
export const adoptFile = (root) => path.join(root, ...ADOPT_REL.split('/'));
// A4: the outcomes of adopt reverify N until apply commits them (run/, ignored by git).
export const reverifyFile = (root) => path.join(localRunDir(root), 'adopt-reverify.json');
export const readRecord = (root) => {
  const r = readJson(adoptFile(root), null);
  return r && typeof r === 'object' && !Array.isArray(r) && r.v === 1 ? r : null;
};
export const readReverified = (root) => {
  const r = readJson(reverifyFile(root), null);
  return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
};

// spec §4.2: first match wins.
export const STATES = Object.freeze(['done', 'closed-stale', 'verifying', 'executing', 'planned', 'prepped', 'fresh']);
// turbo's run files: a dirty path there never stops adopt (spec §4.1: a cancel changes nothing but run/).
const RUN_FILES = /^\.planning\/turbo\/(run|logs|locks)\//;
const UAT_OPEN = new Set(['pending', 'missing', 'blocked', 'issue']);

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
const firstLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0];

// GSD's current phase: the in_progress phase of .planning/state.json (GSD's published state contract), else
// current_phase of `gsd-tools state json` (read-only); null when neither says. Never init manager's is_active (a file
// of the phase changed in the last 300 s) and never `init progress` (it prunes worktrees).
export function currentPhase(root, gsd) {
  const contract = readJson(path.join(root, '.planning', 'state.json'), null);
  const hit = Array.isArray(contract?.phases) ? contract.phases.find((p) => p?.status === 'in_progress' && p.number != null) : null;
  if (hit) return normalizePhaseId(String(hit.number));
  try {
    const m = /^\s*(?:phase\s+)?([A-Za-z]?\d+[A-Z]?(?:\.\d+)*)/i.exec(String(gsd(['state', 'json'])?.current_phase ?? ''));
    return m ? normalizePhaseId(m[1]) : null;
  } catch {
    return null;
  }
}

// A2: each phase of init manager's raw rows with its state. reverified: the phases adopt reverify looked at, which
// count as closed-stale until apply commits (A4), so a re-verification never changes the plan the owner confirmed.
// current: GSD's current phase (currentPhase).
export function phaseStates(managerJson, { root, reverified = {}, current = null } = {}) {
  const rows = (managerJson?.phases || []).filter((p) => !isSentinelPhase(p.number));
  return rows.map((p) => {
    const n = normalizePhases({ phases: [p] })[0];
    const plans = Number(p.plan_count) || 0;
    const summaries = Number(p.summary_count) || 0;
    const dir = root ? findPhaseDir(root, n.number) : null;
    const outline = dir ? planOutline(dir) : { outlines: [] };
    let state;
    if (n.complete && !Object.hasOwn(reverified, n.number)) state = 'done';
    else if (n.closed || Object.hasOwn(reverified, n.number)) state = 'closed-stale';
    else if (plans > 0 && summaries >= plans) state = 'verifying';
    else if (summaries > 0) state = 'executing';
    else if (plans > 0 || outline.outlines.length) state = 'planned';
    else if (p.has_context === true) state = 'prepped';
    else state = 'fresh';
    const row = { number: n.number, name: n.name, state, active: current !== null && n.number === current, verification: n.verification, plans, summaries };
    // the lane resumes GSD's chunked planning: still planned, the overview says so
    if (state === 'planned' && root && planSetCheck(root, n.number).why) row.planSet = 'incomplete';
    return { row, phase: n };
  });
}

// Open UAT rows of an unfinished phase (GSD's UAT results that still need someone).
function uatOpen(root, number) {
  const dir = findPhaseDir(root, number);
  const file = dir ? phaseArtifacts(dir).uat : null;
  if (!file) return 0;
  try {
    return parseUat(fs.readFileSync(path.join(dir, file), 'utf8')).tests.filter((t) => UAT_OPEN.has(t.result)).length;
  } catch {
    return 0;
  }
}

const tryOr = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

// The changed paths of git status (the new name of a rename), never quoted.
function dirtyPaths(git) {
  return git(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all']).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, ''));
}

// An adopt that stopped before its commit: its record says applying, or applied while adopt.json itself differs from
// HEAD (the commit failed: a hook, signing, a held index.lock). dirty: the changed paths.
export const interrupted = (record, dirty) => Boolean(record) && (record.state === 'applying' || (record.state === 'applied' && dirty.includes(ADOPT_REL)));

// What adopt may find dirty: turbo's run files, the paths of an adopt that stopped before its commit (an entry ending
// in / covers what is under it), and the files adopt reverify left for apply.
function acceptedDirty(root, record, dirty) {
  const own = interrupted(record, dirty) && Array.isArray(record.paths) ? record.paths : [];
  const reverify = Object.values(readReverified(root)).flatMap((r) => (Array.isArray(r?.files) ? r.files : []));
  const list = [...own, ...reverify];
  return (p) => RUN_FILES.test(p) || list.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));
}

// The project's default branch, { name, sure }: origin's HEAD, else git's init.defaultBranch, else GSD's git.base_branch
// (each only when that branch exists here) are sure; main or master is a guess; null when none is known.
function defaultBranch(git, gsdBase) {
  const exists = (b) => Boolean(b) && Boolean(tryOr(() => git(['rev-parse', '--verify', '-q', `refs/heads/${b}`]).trim(), ''));
  const origin = tryOr(() => git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).trim(), '');
  if (origin) return { name: origin.replace(/^origin\//, ''), sure: true };
  for (const b of [tryOr(() => git(['config', '--get', 'init.defaultBranch']).trim(), ''), gsdBase]) if (exists(b)) return { name: b, sure: true };
  for (const b of ['main', 'master']) if (exists(b)) return { name: b, sure: false };
  return null;
}

// spec §4.2: the overview and the refusals. deps: gsd(args) → JSON (gsd-tools), gsdGet(key) → GSD config value or
// ABSENT, git(args) → text, supervisor() → { alive, pid, lanes: [live lane phases], attended: [phases], why }, doctorMode().
// Returns { refused: [lines], overview, phases (normalized, for the scheduler), dirty (the changed paths outside turbo's
// run files) }; overview null when the phases cannot be read. apply calls it again right before it writes (review 3).
export function scanProject(root, { deps }) {
  const refused = [];
  const record = readRecord(root);
  const hasRoadmap = fs.existsSync(path.join(root, ...ROADMAP_REL.split('/')));
  if (!hasRoadmap) refused.push(`no ${ROADMAP_REL}: this project has no GSD milestone to adopt`);
  if (deps.doctorMode() === 'unsupported') refused.push('turbo-run doctor says unsupported: fix its FAIL lines first (turbo-run doctor)');
  const sup = deps.supervisor();
  if (sup.alive) refused.push(`the supervisor is running${sup.pid ? ` (pid ${sup.pid})` : ''}: stop it first (turbo-run stop)`);
  if (sup.why) refused.push(sup.why);
  for (const p of sup.lanes || []) refused.push(`the lane of phase ${p} still works: stop the run first (turbo-run stop)`);
  for (const p of sup.attended || []) refused.push(`phase ${p} is attended in the owner's session: hand it back first (turbo-run attend ${p} --done)`);
  let git = true;
  let dirty = [];
  try {
    const merge = deps.git(['rev-parse', '--git-path', 'MERGE_HEAD']).trim();
    if (merge && fs.existsSync(path.resolve(root, merge))) refused.push('a git merge is in progress: finish it or abort it first (git merge --abort)');
    dirty = dirtyPaths(deps.git).filter((p) => !RUN_FILES.test(p));
    const ok = acceptedDirty(root, record, dirty);
    const theirs = dirty.filter((p) => !ok(p));
    if (theirs.length) refused.push(`uncommitted changes: ${theirs.join(', ')}: adopt commits nothing of yours; commit them or put them back first`);
  } catch (e) {
    git = false;
    refused.push(`git cannot read this project (${firstLine(e)}): adopt needs a git repository`);
  }
  // review 8: GSD's phase or milestone branching leaves HEAD on its own branch; turbo's lanes branch from the default
  // branch, so adopt starts only there
  const get = (key) => (deps.gsdGet ? tryOr(() => deps.gsdGet(key), null) : null);
  const branching = get('git.branching_strategy');
  const branch = git ? tryOr(() => deps.git(['symbolic-ref', '-q', '--short', 'HEAD']).trim() || null, null) : null;
  const warnings = [];
  if (git && ['phase', 'milestone'].includes(branching)) {
    const base = get('git.base_branch');
    const main = defaultBranch(deps.git, base && base !== ABSENT ? base : null);
    if (main && branch !== main.name) {
      const why = `HEAD is on ${branch ? `GSD's branch ${branch}` : 'no branch (detached)'}; merge it into ${main.name} and switch back (git switch ${main.name})`;
      // a guessed default branch never refuses (review): it warns
      if (main.sure) refused.push(why);
      else warnings.push(`${why}, if ${main.name} is this project's default branch`);
    }
  }
  let config;
  try {
    config = loadConfig(root);
    lanesSettings(config.lanes);
  } catch (e) {
    refused.push(firstLine(e));
    config = null;
  }
  let manager = null;
  if (hasRoadmap) {
    try {
      manager = deps.gsd(['init', 'manager']);
    } catch (e) {
      // review 4: a verifier's new report GSD cannot read (a status outside its set) breaks init manager for every
      // phase; adopt reverify N moves it aside and puts the committed one back
      const unread = dirty.map((p) => /^\.planning\/phases\/([^/]+)\/[^/]*-VERIFICATION\.md$/.exec(p)?.[1]).filter(Boolean).map((d) => normalizePhaseId(/^(?:[A-Z][A-Z0-9_]*-)?(\d+[A-Z]?(?:\.\d+)*)/i.exec(d)?.[1] ?? d));
      refused.push(unread.length
        ? `GSD cannot list the phases (${firstLine(e)}): a re-check report it cannot read may be the cause: run turbo-run adopt reverify ${unread.join(', then turbo-run adopt reverify ')}`
        : `GSD cannot list the phases (${firstLine(e)}): run turbo-run doctor`);
    }
  }
  if (!manager || !config) return { refused, overview: null, phases: [], dirty, config };
  const states = phaseStates(manager, { root, reverified: readReverified(root), current: currentPhase(root, deps.gsd) });
  const phases = states.map((s) => s.phase);
  const rows = states.map((s) => s.row);
  const lanesMode = lanesSettings(config.lanes).mode;
  const unfinished = rows.filter((r) => r.state !== 'done' && r.state !== 'closed-stale');
  // spec §5.5, prep's rule (v0.5.1): stale phases are marked up only with MARKUP_MIN_INDEPENDENT independent phases
  const independent = lanesMode === 'slots' ? independentCount(phases) : null;
  const overview = {
    phases: rows,
    branch,
    warnings,
    staleClosed: rows.filter((r) => r.state === 'closed-stale').map((r) => r.number).sort(comparePhase),
    markup: lanesMode !== 'slots' ? 'off' : !stalePhases(root, phases).length ? 'fresh' : independent >= MARKUP_MIN_INDEPENDENT ? 'needed' : 'few',
    independent,
    lanesMode,
    config: {
      turbo: fs.existsSync(path.join(root, '.planning', 'turbo', 'config.json')),
      testCommand: get('workflow.test_command'),
      chunked: get('planning.chunked_parallel'),
      contextWindow: get('context_window'),
      branching,
    },
    owner: {
      questions: tryOr(() => openQuestions(root).length, 0),
      humanNeeded: unfinished.map((r) => {
        const items = [...(r.verification === 'human_needed' ? ['verification'] : [])];
        const uat = uatOpen(root, r.number);
        if (uat) items.push(`uat:${uat}`);
        return { phase: r.number, items };
      }).filter((x) => x.items.length),
      worktrees: git ? tryOr(() => agentWorktrees(root).map((w) => w.path), []) : [],
      gates: tryOr(() => gatesLeftovers(root).gates, []),
      slotsToMake: lanesMode === 'slots' ? tryOr(() => listSlots(root, config).filter((s) => s.state === 'missing').length, 0) : 0,
      prepPhases: lanesMode === 'slots' ? unfinished.filter((r) => r.state === 'fresh').map((r) => r.number) : [],
    },
    adopted: record ? { at: record.at ?? null, state: record.state ?? null } : null,
  };
  return { refused, overview, phases, dirty, config };
}

// spec §4.2: nothing to adopt once every phase is done.
export const nothingToAdopt = (overview) => overview.phases.every((r) => r.state === 'done');

// "24, 25, 26, 31" → "24–26, 31": a run of three or more consecutive whole numbers becomes a range.
export function phaseList(ids) {
  const sorted = [...ids].map(String).sort(comparePhase);
  const out = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && /^\d+$/.test(sorted[j]) && /^\d+$/.test(sorted[j + 1]) && Number(sorted[j + 1]) === Number(sorted[j]) + 1) j++;
    out.push(j - i >= 2 ? `${sorted[i]}–${sorted[j]}` : sorted.slice(i, j + 1).join(', '));
    i = j + 1;
  }
  return out.join(', ');
}

// A7: every owner-facing line. Phase numbers and counts only in the questions; the change list and the report may name
// files and commands in backticks.
export const ADOPT_TEXT = {
  en: {
    state: {
      done: 'done',
      'closed-stale': 'closed, verification stale',
      verifying: 'built, waiting for verification',
      executing: 'being built',
      planned: 'planned',
      prepped: 'discussed, not planned yet',
      fresh: 'not started',
    },
    planSetIncomplete: 'planning not finished',
    phasesHead: 'phases:',
    active: (n) => `active phase: ${n}`,
    adopted: (at) => `adopted ${at}`,
    nothing: 'nothing to adopt: every phase is done',
    questions: (n) => `open turbo questions: ${n} (answer: /turbo-autonomous answer)`,
    humanVerification: 'verification needs a person',
    humanUat: (n) => `${n} UAT ${n === 1 ? 'item' : 'items'} open`,
    human: (p, items) => `phase ${p} needs you: ${items}`,
    worktree: (w) => `an agent's working copy is left: ${w} (look first: \`turbo-run worktrees prune "${w}" --dry-run\`)`,
    gatesOff: (p) => `GSD's checks are off for phase ${p} (\`turbo-run gates restore ${p}\`)`,
  },
  ru: {
    state: {
      done: 'сделаны',
      'closed-stale': 'закрыты, проверка устарела',
      verifying: 'собраны, ждут проверки',
      executing: 'в работе',
      planned: 'спланированы',
      prepped: 'обсуждены, ещё без планов',
      fresh: 'не начаты',
    },
    planSetIncomplete: 'планирование не закончено',
    phasesHead: 'фазы:',
    active: (n) => `сейчас идёт фаза ${n}`,
    adopted: (at) => `adopted ${at}`,
    nothing: 'nothing to adopt: every phase is done',
    questions: (n) => `открытых вопросов turbo: ${n} (ответить: /turbo-autonomous answer)`,
    humanVerification: 'проверке нужен человек',
    humanUat: (n) => `открытых пунктов приёмки: ${n}`,
    human: (p, items) => `фазе ${p} нужны вы: ${items}`,
    worktree: (w) => `осталась рабочая копия агента: ${w} (сначала посмотреть: \`turbo-run worktrees prune "${w}" --dry-run\`)`,
    gatesOff: (p) => `проверки GSD выключены у фазы ${p} (\`turbo-run gates restore ${p}\`)`,
  },
};
export const textFor = (lang) => (lang === 'ru' ? ADOPT_TEXT.ru : ADOPT_TEXT.en);

const humanItems = (t, items) => items.map((i) => (i === 'verification' ? t.humanVerification : t.humanUat(Number(i.split(':')[1])))).join(', ');

// One line per state with its phases (closed-stale named explicitly), the active phase, the markup and adopt marks (the
// skill reads `markup: needed`), what is open for the owner.
export function formatOverview(overview, lang = 'en') {
  const t = textFor(lang);
  const lines = [t.phasesHead];
  for (const s of STATES) {
    const rows = overview.phases.filter((r) => r.state === s);
    if (!rows.length) continue;
    const list = phaseList(rows.map((r) => r.number));
    const half = rows.filter((r) => r.planSet === 'incomplete').map((r) => r.number);
    lines.push(`  ${t.state[s]}: ${list}${half.length ? ` (${t.planSetIncomplete}: ${phaseList(half)})` : ''}`);
  }
  const active = overview.phases.filter((r) => r.active).map((r) => r.number);
  if (active.length) lines.push(t.active(phaseList(active)));
  if (overview.branch) lines.push(`branch: ${overview.branch}`);
  lines.push(overview.markup === 'few'
    ? `markup: few (${overview.independent} independent phase${overview.independent === 1 ? '' : 's'}, needs ${MARKUP_MIN_INDEPENDENT})`
    : `markup: ${overview.markup}`);
  for (const w of overview.warnings ?? []) lines.push(`warn: ${w}`);
  if (overview.adopted?.state === 'applied') lines.push(t.adopted(overview.adopted.at));
  const o = overview.owner;
  if (o.questions) lines.push(t.questions(o.questions));
  for (const h of o.humanNeeded) lines.push(t.human(h.phase, humanItems(t, h.items)));
  for (const w of o.worktrees) lines.push(t.worktree(w));
  for (const p of o.gates) lines.push(t.gatesOff(p));
  if (nothingToAdopt(overview)) lines.push(t.nothing);
  return lines;
}

// The supervisor's side of the refusals, from supervisor.json, the attend marks and the session list: { alive, pid,
// lanes, attended, why }. listAgents() → claude's agents (isAgentAlive decides), asked only when a lane is recorded.
export function supervisorState({ sup, alive, attended = [], listAgents, isAlive }) {
  const recorded = Object.values(sup?.lanes || {}).filter((l) => l && typeof l === 'object' && l.sessionId);
  let lanes = [];
  let why = null;
  if (recorded.length) {
    try {
      const agents = listAgents();
      const live = new Set(agents.filter((a) => isAlive(a)).map((a) => a.id));
      lanes = recorded.filter((l) => live.has(l.sessionId)).map((l) => String(l.phase ?? l.job ?? '?'));
    } catch (e) {
      why = `cannot tell whether the lanes of the last run still work (claude agents failed: ${firstLine(e)}): stop the run first (turbo-run stop)`;
    }
  }
  return { alive, pid: sup?.pid ?? null, lanes, attended: attended.map((a) => a.phase ?? a), why };
}

// --- questions, changes, plan digest (spec §4.3, §4.4; A3–A5) ---------------------------------------------------------

export class AdoptUsage extends Error {}
export const ANSWERS_USAGE = '--answers stale-closed=keep|reverify,relax=all|none|r1+r2';
const RELAX_VALUE = /^(all|none|r\d+(\+r\d+)*)$/;

// A3: "stale-closed=keep,relax=r1+r3" → { 'stale-closed': 'keep', relax: ['r1', 'r3'] }; '' → {}. Anything else throws
// AdoptUsage (exit 2).
export function parseAnswers(text) {
  const out = {};
  for (const pair of String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z-]+)=(.+)$/.exec(pair);
    if (!m || Object.hasOwn(out, m[1])) throw new AdoptUsage(`answer "${pair}": ${m ? 'given twice' : 'not <id>=<value>'} (${ANSWERS_USAGE})`);
    const [, id, v] = m;
    if (id === 'stale-closed' && ['keep', 'reverify'].includes(v)) out[id] = v;
    else if (id === 'relax' && RELAX_VALUE.test(v)) out[id] = v === 'all' || v === 'none' ? v : v.split('+');
    else throw new AdoptUsage(`answer "${pair}": unknown question or value (${ANSWERS_USAGE})`);
  }
  return out;
}
const answerText = (id, v) => `${id}=${Array.isArray(v) ? v.join('+') : v}`;

const QUESTION_TEXT = {
  en: {
    staleHeader: 'Closed',
    stale: (ids, one) => `${one ? `Phase ${ids} is checked off as done, but its verification is` : `Phases ${ids} are checked off as done, but their verification is`} stale: code ${one ? 'it' : 'they'} checked changed later. Turbo does not run ${one ? 'it' : 'them'}. What should happen to ${one ? 'it' : 'them'}?`,
    staleContext: 'GSD on its own would run such phases again; turbo skips them. A re-check runs only the verifier, never plans or code.',
    keep: { label: 'Keep closed', description: 'Run nothing; the report marks them as closed without a fresh verification.' },
    reverify: { label: 'Re-check', description: 'One pass of the verifier per phase over the code as it is now, no tests or review again; the phase stays closed and any differences go into the report; about 5 to 10 minutes a phase.' },
    relaxHeader: 'Waits',
  },
  ru: {
    staleHeader: 'Закрытые',
    stale: (ids, one) => `${one ? `Фаза ${ids} отмечена сделанной, но её проверка устарела: позже менялся код, который она проверяла. turbo её не запускает. Что с ней сделать?` : `Фазы ${ids} отмечены сделанными, но их проверка устарела: позже менялся код, который они проверяли. turbo их не запускает. Что с ними сделать?`}`,
    staleContext: 'Обычный GSD запустил бы такие фазы заново, turbo их пропускает. Перепроверка запускает только проверяющего агента, ничего не планирует и не пишет код.',
    keep: { label: 'Оставить закрытыми', description: 'Ничего не запускать; в отчёте они будут отмечены как закрытые без свежей проверки.' },
    reverify: { label: 'Перепроверить', description: 'По каждой фазе один проход проверяющего агента по нынешнему коду, без тестов и ревью заново; фаза остаётся закрытой, расхождения — в отчёт; ~5–10 мин на фазу.' },
    relaxHeader: 'Ожидания',
  },
};

// A5: a question goes again only for phases its last answer did not cover.
const covers = (set, ids) => Array.isArray(set) && ids.every((x) => set.includes(x));

// Review 2: the closed phases with a stale verification the owner has not decided on. adopt.json records every phase
// finished at adopt time (finished) as decided; a phase that finished after it is the run's normal life (its
// verification goes stale as later phases change its files) and is never asked about or named again. Without a record:
// all of them.
export function undecidedStale(record, stale) {
  if (!record) return stale;
  if (Array.isArray(record.finished)) return [];
  const decided = new Set([...(record.staleClosed ?? []), ...(record.answers?.['stale-closed']?.set ?? [])]);
  return stale.filter((n) => !decided.has(n));
}

// spec §4.3: the questions not answered yet, in the shape of questions --open --json. relax: previewAnalysis's
// relaxations; autonomy max applies them without a question.
export function adoptQuestions(overview, { relax = [], record = null, lang = 'en', autonomy = 'standard', roadmapSha = null } = {}) {
  const t = QUESTION_TEXT[lang === 'ru' ? 'ru' : 'en'];
  const out = [];
  const stale = undecidedStale(record, overview.staleClosed);
  if (stale.length) {
    out.push({
      id: 'stale-closed', header: t.staleHeader, question: t.stale(phaseList(stale), stale.length === 1), context: t.staleContext,
      options: [{ ...t.keep, recommended: true }, { ...t.reverify, recommended: false }], allowOther: false,
    });
  }
  const ids = relax.map((r) => r.id);
  const answered = record?.answers?.relax;
  if (relax.length && autonomy !== 'max' && !(answered && answered.roadmap_sha256 === roadmapSha && covers(answered.ids, ids))) {
    const c = relaxCard(relax, lang);
    out.push({
      id: 'relax', header: t.relaxHeader, question: c.question, context: c.context,
      options: c.options.map((o, i) => ({ ...o, recommended: i === 0 })), allowOther: true,
      // own words name proposals: the skill maps them to relax=r1+r2 (the ids never reach the owner's text)
      proposals: relax.map((r, i) => ({ id: r.id, text: c.lines[i] })),
    });
  }
  return out;
}

// The plan digest (A4): sha256 over the canonical JSON of the answers and the changes, a re-verification by its phase
// only. No timestamps go in (review 14).
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
export function planDigest(answers, changes) {
  const list = changes.map((c) => (c.kind === 'reverify' ? { kind: c.kind, value: c.value } : { kind: c.kind, paths: c.paths, value: c.value }));
  return crypto.createHash('sha256').update(canon({ answers, changes: list })).digest('hex');
}

const sha = (text) => (text === null ? null : roadmapDigest(text));
const reportRel = (n) => `${ADOPT_DIR_REL}/reverify-p${n}.md`;
const verificationRel = (root, n) => {
  const dir = findPhaseDir(root, n);
  const f = dir ? phaseArtifacts(dir).verification : null;
  return f ? rel(root, path.join(dir, f)) : null;
};
const decisionsWhere = (root) => (fs.existsSync(path.join(root, ...DECISIONS_DIR_REL.split('/'))) ? `${DECISIONS_DIR_REL}/` : DECISIONS_FILE_REL);

// lean's keys as the change list names them; context_window with the value lean gives GSD
const leanKeys = (keys) => keys.map((k) => (k === 'context_window' ? `\`${k}\` ${LEAN_CONTEXT_WINDOW}` : `\`${k}\``)).join(', ');
const CHANGE_TEXT = {
  en: {
    resume: (paths) => `finish the adopt that stopped before its commit: ${paths.map((p) => `\`${p}\``).join(', ')}`,
    'turbo-config': () => "turbo's own settings and their git rules (`.planning/turbo/config.json`, `.planning/turbo/.gitignore`)",
    'test-command': (v) => `GSD's test command runs only the tests a change touches (\`turbo-run test-changed\`); the full run stays: \`${typeof v === 'string' ? v : JSON.stringify(v)}\``,
    'context-window': (v, c) => `GSD's context window: ${v} tokens (\`.planning/config.json\`)${c.turbo ? `, lean mode's value for sizing GSD's prompts; turbo keeps ${c.turbo} for its pauses (\`.planning/turbo/config.json\`)` : ''}`,
    chunked: () => "GSD writes a phase's plans in parallel (`planning.chunked_parallel` in `.planning/config.json`)",
    branching: (v) => `GSD stops making its own branch per ${v.from} (\`git.branching_strategy\`: none): turbo's lanes branch themselves`,
    lean: (v) => `lean mode: ${v.length} GSD settings for a faster phase (${leanKeys(v)} in \`.planning/config.json\`, the previous values in \`.planning/turbo/lean-prev.json\`); GSD's planner and assumptions analyzer think at effort high, its researcher at medium (on this machine, for every project)`,
    markup: (v) => `lanes markup of phase ${phaseList(v.targets)} in the ROADMAP and \`.planning/turbo/lanes.json\`${v.relax.length ? `; waits removed: ${v.relax.join(', ')}, with a decision record` : ''}`,
    reverify: (v) => `re-check phase ${v}: a passing fresh report goes in; otherwise it is kept aside in \`${reportRel(v)}\` and the phase stays closed`,
    'reverify-drop': (v) => `put back the re-check reports of phase ${phaseList(v)} (you chose to keep them closed)`,
    record: (v) => (v === 'first' ? "turbo is already set up; adopt's record written (`.planning/turbo/adopt.json`)" : "adopt's record (`.planning/turbo/adopt.json`): your answers, so they are not asked again"),
  },
  ru: {
    resume: (paths) => `завершить прерванный adopt: ${paths.map((p) => `\`${p}\``).join(', ')}`,
    'turbo-config': () => 'настройки turbo и его правила для git (`.planning/turbo/config.json`, `.planning/turbo/.gitignore`)',
    'test-command': (v) => `команда тестов GSD запускает только тесты, которых касается изменение (\`turbo-run test-changed\`); полный прогон остаётся: \`${typeof v === 'string' ? v : JSON.stringify(v)}\``,
    'context-window': (v, c) => `окно контекста GSD: ${v} токенов (\`.planning/config.json\`)${c.turbo ? ` — значение облегчённого режима для размера промптов GSD; паузы turbo считает по ${c.turbo} (\`.planning/turbo/config.json\`)` : ''}`,
    chunked: () => 'GSD пишет планы фазы параллельно (`planning.chunked_parallel` в `.planning/config.json`)',
    branching: (v) => `GSD больше не заводит свою ветку на ${v.from === 'phase' ? 'фазу' : 'майлстоун'} (\`git.branching_strategy\`: none): ветки ведут полосы turbo`,
    lean: (v) => `облегчённый режим: ${v.length} настроек GSD для быстрой фазы (${leanKeys(v)} в \`.planning/config.json\`, прежние значения — в \`.planning/turbo/lean-prev.json\`); планировщик и анализатор допущений GSD думают с усилием high, исследователь — medium (на этой машине, во всех проектах)`,
    markup: (v) => `разметка полос фаз ${phaseList(v.targets)} в ROADMAP и \`.planning/turbo/lanes.json\`${v.relax.length ? `; убраны ожидания ${v.relax.join(', ')}, с записью решения` : ''}`,
    reverify: (v) => `перепроверить фазу ${v}: свежий отчёт с успехом войдёт в коммит; иначе он ляжет отдельно в \`${reportRel(v)}\`, фаза останется закрытой`,
    'reverify-drop': (v) => `вернуть как было отчёты перепроверки фаз ${phaseList(v)} (вы решили оставить их закрытыми)`,
    record: (v) => (v === 'first' ? 'turbo уже настроен; записал adopt (`.planning/turbo/adopt.json`)' : 'запись adopt (`.planning/turbo/adopt.json`): ваши ответы, чтобы не спрашивать снова'),
  },
};
const changeText = (c, lang) => CHANGE_TEXT[lang === 'ru' ? 'ru' : 'en'][c.kind](c.kind === 'resume' ? c.paths : c.value, c);

// The effective answers: the given one for each asked question, else the record's (A5); a question asked without an
// answer takes its recommended option (assumed: the skill always passes them). Missing ones with --answers given, an
// unknown relaxation id: AdoptUsage.
function effectiveAnswers(questions, given, record, relax) {
  const out = {};
  const asked = new Set(questions.map((q) => q.id));
  let assumed = false;
  for (const id of ['stale-closed', 'relax']) {
    if (asked.has(id)) {
      if (given && Object.hasOwn(given, id)) out[id] = given[id];
      else if (given) throw new AdoptUsage(`no answer to the question ${id} (${ANSWERS_USAGE})`);
      else {
        out[id] = id === 'stale-closed' ? 'keep' : 'all';
        assumed = true;
      }
    } else if (record?.answers?.[id]?.value !== undefined) out[id] = record.answers[id].value;
  }
  if (Array.isArray(out.relax)) {
    const unknown = out.relax.filter((x) => !relax.some((r) => r.id === x));
    if (unknown.length && asked.has('relax')) throw new AdoptUsage(`relax: no proposal ${unknown.join(', ')} (the proposals are ${relax.map((r) => r.id).join(', ')})`);
  }
  return { answers: out, assumed, fresh: questions.length > 0 && Boolean(given) };
}

// The annotation the forecast schedules with: the valid analysis for its targets, else lanes.json (fresh or not, the
// way the scheduler reads it), else everything.
function forecastAnnotation(root, analysisData) {
  const raw = readLanesRaw(root);
  const given = new Map(Object.entries(analysisData?.phases ?? {}).map(([n, e]) => [normalizePhaseId(String(n)), e]));
  return (n) => {
    const e = given.get(n) ?? raw?.phases?.[n];
    const gates = Array.isArray(e?.gates) ? e.gates : [];
    const ok = e && e.confidence === 'high' && Array.isArray(e.areas) && e.areas.length;
    return { areas: ok ? [...e.areas] : [...ANY_AREA], gates };
  };
}

// spec §4.4, §4.7: everything adopt would do now. deps as scanProject's, plus core (the GSD core) and exec. Returns
// { refused } or { questions, analysis, problems, changes, reverify, forecast, owner, plan, answers, overview, … }.
export function adoptPlan(root, { answers: given = null, lang: langArg = 'en', deps }) {
  const scan = scanProject(root, { deps });
  if (scan.refused.length) return { refused: scan.refused };
  const { overview, phases, config } = scan;
  const record = readRecord(root);
  const lang = overview.config.turbo ? (config.lang === 'ru' ? 'ru' : 'en') : langArg === 'ru' ? 'ru' : 'en';
  const roadmapSha = sha(readRoadmap(root));
  let analysis = 'none';
  let problems = [];
  let relax = [];
  let targets = [];
  let analysisData = null;
  if (overview.markup === 'needed' && fs.existsSync(analysisFile(root))) {
    const data = readJson(analysisFile(root), null);
    const pv = previewAnalysis(root, data, { phases, config });
    if (pv.problems.length) [analysis, problems] = ['refused', pv.problems];
    else [analysis, relax, targets, analysisData] = ['valid', pv.relax, pv.targets, data];
  }
  const autonomy = config.autonomy === 'max' ? 'max' : 'standard';
  const questions = adoptQuestions(overview, { relax, record, lang, autonomy, roadmapSha });
  const eff = effectiveAnswers(questions, given, record, relax);
  const accepted = !relax.length ? [] : autonomy === 'max' ? relax.map((r) => r.id) : eff.answers.relax === 'all' ? relax.map((r) => r.id) : eff.answers.relax === 'none' || eff.answers.relax === undefined ? [] : eff.answers.relax;
  const changes = [];
  const outcomes = readReverified(root);
  if (interrupted(record, scan.dirty)) {
    const ok = new Set(scan.dirty);
    const left = (record.paths || []).filter((p) => (p.endsWith('/') ? scan.dirty.some((d) => d.startsWith(p)) : ok.has(p)));
    const paths = [...new Set([...left.flatMap((p) => (p.endsWith('/') ? scan.dirty.filter((d) => d.startsWith(p)) : [p]))])].sort();
    changes.push({ kind: 'resume', paths, value: null });
  }
  try {
    for (const c of initChanges(root, { core: deps.core, exec: deps.exec })) changes.push({ kind: c.kind, paths: c.paths, value: c.value });
  } catch (e) {
    return { refused: [firstLine(e)] };
  }
  if (deps.core && overview.config.chunked === ABSENT) changes.push({ kind: 'chunked', paths: [GSD_CONFIG_REL], value: true });
  if (overview.lanesMode === 'slots' && ['phase', 'milestone'].includes(overview.config.branching)) changes.push({ kind: 'branching', paths: [GSD_CONFIG_REL], value: { from: overview.config.branching, to: 'none' } });
  // Stage 6 §5.1: lean mode's GSD keys while lean is on (never while a phase has GSD's gates off: lean would refuse)
  if (deps.lean) {
    try {
      if (leanSettings(config).enabled && !gatesLeftovers(root).gates.length) {
        const keys = deps.lean.changes().map((c) => c.key);
        if (keys.length) changes.push({ kind: 'lean', paths: [GSD_CONFIG_REL, LEAN_PREV_REL], value: keys });
        // v0.5.1: init's context window is set first, then lean's: the line shows what GSD's config ends with
        const cw = keys.includes('context_window') ? changes.find((c) => c.kind === 'context-window') : null;
        if (cw) Object.assign(cw, { value: LEAN_CONTEXT_WINDOW, turbo: cw.value });
      }
    } catch (e) {
      return { refused: [firstLine(e)] };
    }
  }
  if (analysis === 'valid') changes.push({ kind: 'markup', paths: [ROADMAP_REL, LANES_REL, ...(accepted.length ? [decisionsWhere(root)] : [])], value: { targets, relax: accepted } });
  // re-checks only for the phases the question was about (review 2: decided ones are never re-checked again)
  const asked = questions.some((q) => q.id === 'stale-closed');
  const reverify = asked && eff.answers['stale-closed'] === 'reverify' ? undecidedStale(record, overview.staleClosed) : [];
  for (const n of reverify) changes.push({ kind: 'reverify', paths: [verificationRel(root, n), reportRel(n)].filter(Boolean), value: n });
  // review 3: re-check reports nobody chose (the answer is keep) are put back by apply
  const drop = Object.keys(outcomes).filter((n) => !reverify.includes(n)).sort(comparePhase);
  if (drop.length) changes.push({ kind: 'reverify-drop', paths: [...new Set(drop.flatMap((n) => outcomes[n]?.files ?? []))].sort(), value: drop });
  const newAnswers = Object.keys(eff.answers).some((id) => !record?.answers?.[id] || canon(record.answers[id].value) !== canon(eff.answers[id])) || (eff.fresh && questions.length > 0);
  // a first adopt always writes its record, so the closed-phases line and the questions stop (review: not "already adopted")
  if (changes.length || newAnswers || !record) changes.push({ kind: 'record', paths: [ADOPT_REL], value: !record && !changes.length ? 'first' : null });
  for (const c of changes) c.text = changeText(c, lang);
  // the forecast: relaxations in the deps, the markup's areas and gates, slots by lanes.mode, the milestone's pace
  const dropped = new Map(relax.filter((r) => accepted.includes(r.id)).map((r) => [r.phase, r.drop]));
  const fphases = phases.map((p) => ({ ...p, deps: p.deps.filter((d) => !(dropped.get(p.number) ?? []).includes(d)) }));
  const hours = phaseHours(phases, { git: deps.git, phaseDirOf: (n) => { const d = findPhaseDir(root, n); return d ? rel(root, d) : null; } });
  const fc = forecast({ phases: fphases, annotation: forecastAnnotation(root, analysisData), slots: overview.lanesMode === 'slots' ? maxLanes(config) : 1, hours });
  const annotation = forecastAnnotation(root, analysisData);
  const ownerGates = phases.filter((p) => !isFinished(p)).map((p) => ({ phase: p.number, gates: annotation(p.number).gates.filter((g) => OWNER_GATES.includes(g)) })).filter((x) => x.gates.length);
  return {
    questions, analysis, problems, changes, reverify, reverifyPending: reverify.filter((n) => !Object.hasOwn(outcomes, n)), forecast: fc, assumed: eff.assumed,
    owner: { ...overview.owner, ownerGates }, plan: planDigest(eff.answers, changes), answers: eff.answers,
    overview, phases, config, lang, relax, accepted, analysisData, roadmapSha, dirty: scan.dirty,
  };
}
const OWNER_GATES = ['owner-live', 'owner-signature'];

// The plan as text: the questions not answered yet, the changes, the re-checks, the forecast, the digest.
export function formatPlan(p) {
  const r = REPORT_TEXT[p.lang];
  const lines = [];
  for (const q of p.questions) lines.push(`question ${q.id}: ${q.question}`, ...q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.recommended ? ` (${r.recommended})` : ''} — ${o.description}`));
  if (p.analysis === 'refused') lines.push(`markup refused: ${p.problems.join('; ')}`);
  lines.push('changes:');
  for (const c of p.changes) lines.push(`  - ${c.text}`);
  if (!p.changes.length) lines.push('  (none)');
  if (p.reverify.length) lines.push(`reverify: ${p.reverify.join(' ')}`, `reverify pending: ${p.reverifyPending.join(' ') || 'none'}`);
  lines.push('forecast:', ...forecastLines(p.forecast, r).map((l) => `  ${l}`));
  lines.push(`plan: ${p.plan}`);
  return lines;
}

// --- re-verification (spec §4.5; A6) ----------------------------------------------------------------------------------

export class AdoptRefused extends Error {}

const changedInTree = (git, relPath) => git(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all', '--', relPath]).trim() !== '';
// "HEAD:./<path>" resolves against the project root, which may sit below the repository root (as lib/gates.mjs does)
const inHead = (git, relPath) => {
  try {
    git(['cat-file', '-e', `HEAD:./${relPath}`]);
    return true;
  } catch {
    return false;
  }
};
// Back to its committed bytes, or gone when it was never committed.
function restore(root, git, relPath) {
  if (inHead(git, relPath)) git(['checkout', 'HEAD', '--', relPath]);
  else fs.rmSync(path.join(root, ...relPath.split('/')), { force: true });
}
// The new report goes aside to .planning/turbo/adopt/reverify-p<N>.md; the phase's report goes back to its committed bytes.
function setAside(root, git, n, verRel) {
  const report = reportRel(n);
  fs.mkdirSync(path.join(root, ...ADOPT_DIR_REL.split('/')), { recursive: true });
  fs.copyFileSync(path.join(root, ...verRel.split('/')), path.join(root, ...report.split('/')));
  restore(root, git, verRel);
  return report;
}

// Whether phase n is closed (checked off, every plan with its SUMMARY), from init manager; when GSD cannot list the phases
// (another verifier's report it cannot read yet), from the disk: every plan of the phase has its SUMMARY.
function isClosed(root, n, gsd) {
  try {
    return normalizePhases(gsd(['init', 'manager'])).find((p) => p.number === n)?.closed === true;
  } catch {
    const dir = findPhaseDir(root, n);
    const plans = dir ? phaseArtifacts(dir).plans : [];
    return plans.length > 0 && plans.every((p) => p.hasSummary);
  }
}

// After the verifier of a closed phase returned: GSD's verdict on the report it wrote, read first (review 4: a report
// GSD cannot read makes init manager fail for every phase). passed: the fresh report stays for apply's commit.
// Otherwise, a report GSD cannot read included, the new report moves to .planning/turbo/adopt/reverify-p<N>.md and the
// phase's report goes back to its committed bytes (the phase stays closed); no new report: nothing moves. Then the phase
// must be a closed one (checked off, all SUMMARY; a fresh passing report makes GSD count it complete). The outcome goes to
// run/adopt-reverify.json. others: any other changed path that is not adopt's (a verifier's test leftovers) — apply
// refuses until the owner decides about them.
export function reverifyResult(root, phase, { deps }) {
  const n = normalizePhaseId(String(phase));
  const dir = findPhaseDir(root, n);
  if (!dir) throw new AdoptRefused(`phase ${n} has no single phase directory under .planning/phases`);
  const verRel = verificationRel(root, n);
  const fresh = verRel !== null && changedInTree(deps.git, verRel);
  let status;
  let reason = null;
  let report = null;
  try {
    status = String(deps.gsd(['verification', 'status', dir])?.status || 'missing');
  } catch (e) {
    status = 'unreadable';
    reason = `GSD cannot read the new report: ${firstLine(e)}`;
    if (fresh) report = setAside(root, deps.git, n, verRel);
  }
  if (!isClosed(root, n, deps.gsd)) {
    if (report) fs.rmSync(path.join(root, ...report.split('/')), { force: true });
    throw new AdoptRefused(`phase ${n} is not a closed phase with a stale verification`);
  }
  let files = report ? [report] : [];
  if (!report) {
    if (status === 'passed' && fresh) files = [verRel];
    else if (fresh) {
      report = setAside(root, deps.git, n, verRel);
      files = [report];
    } else {
      if (status === 'passed') status = 'unchanged';
      reason ??= 'the verifier wrote no new report';
    }
  }
  const all = readReverified(root);
  all[n] = { status, files, ...(report ? { report } : {}), ...(reason ? { reason } : {}) };
  writeJsonAtomic(reverifyFile(root), all);
  const dirty = dirtyPaths(deps.git);
  const ok = acceptedDirty(root, readRecord(root), dirty);
  const others = dirty.filter((p) => !RUN_FILES.test(p) && !ok(p));
  return { phase: n, status, kept: status === 'passed', report, reason, others };
}

// --- apply, the record, the report (spec §4.4, §4.8, §4.9) ------------------------------------------------------------

const turboVersion = () => readJson(new URL('../package.json', import.meta.url), null)?.version ?? null;

// Writes the changes, the record, and makes the one commit chore(turbo): adopt with exactly their paths. Recomputes the
// plan first, which runs every refusal again right before anything is written (review 3); a digest that differs from the
// one the owner confirmed refuses. Returns { refused } | { committed: sha|null, noChanges, paths, report }.
export function applyAdopt(root, { answers = null, plan, lang = 'en', deps, now = new Date() }) {
  const p = adoptPlan(root, { answers, lang, deps });
  if (p.refused) return { refused: p.refused };
  if (p.plan !== plan) return { refused: [`the plan changed since it was shown (plan ${p.plan}); show it again`] };
  const record = readRecord(root);
  if (!p.changes.length) return { committed: null, noChanges: true, paths: [], report: adoptReport(root, { plan: p, record, commit: null }) };
  const outcomes = readReverified(root);
  const expected = [...new Set(p.changes.flatMap((c) => (c.kind === 'reverify' ? outcomes[c.value]?.files ?? [] : c.kind === 'reverify-drop' ? [] : c.paths)))];
  const base = {
    v: 1, at: now.toISOString(), turbo: turboVersion(), gsd: deps.core ? readVersion(deps.core) : null,
    answers: record?.answers ?? {}, staleClosed: record?.staleClosed ?? [], reverified: record?.reverified ?? {},
    roadmap_sha256: p.roadmapSha, forecast: summaryOf(p.forecast), plan: p.plan,
  };
  writeJsonAtomic(adoptFile(root), { ...base, state: 'applying', paths: [...new Set([...expected, ...(interrupted(record, p.dirty) ? record.paths ?? [] : [])])].sort() });
  const written = new Set(expected.filter((x) => !x.endsWith('/')));
  const kinds = new Set(p.changes.map((c) => c.kind));
  if (['turbo-config', 'test-command', 'context-window'].some((k) => kinds.has(k))) {
    // only turbo's own files when GSD's config has nothing to change (review: no config-set behind the list's back)
    const gsd = kinds.has('test-command') || kinds.has('context-window');
    initProject(root, { lang: p.lang, core: deps.core, exec: deps.exec, inherit: false, gsd });
  }
  const cfg = deps.core ? createGsdConfig({ root, core: deps.core, ...(deps.exec ? { exec: deps.exec } : {}) }) : null;
  // ensureChunkedParallel's rule without its own commit
  if (kinds.has('chunked')) cfg.set('planning.chunked_parallel', 'true');
  if (kinds.has('branching')) cfg.set('git.branching_strategy', 'none');
  // lean's keys and lean-prev.json go into adopt's one commit (no commit of their own)
  if (kinds.has('lean')) for (const x of deps.lean.apply().paths ?? []) written.add(x);
  if (kinds.has('markup')) {
    const r = applyAnalysis(root, p.analysisData, { phases: p.phases, config: p.config, now, commit: null, relax: p.config.autonomy === 'max' ? undefined : p.accepted });
    for (const x of r.paths) written.add(x);
  }
  for (const n of p.changes.find((c) => c.kind === 'reverify-drop')?.value ?? []) for (const f of outcomes[n]?.files ?? []) restore(root, deps.git, f);
  const reverified = { ...base.reverified };
  for (const c of p.changes.filter((x) => x.kind === 'reverify')) reverified[c.value] = outcomes[c.value]?.status ?? 'not run';
  const relaxRecord = p.relax.length ? { value: p.answers.relax ?? 'all', roadmap_sha256: sha(readRoadmap(root)), ids: p.relax.map((r) => r.id) } : record?.answers?.relax;
  const asked = undecidedStale(record, p.overview.staleClosed);
  const staleRecord = asked.length ? { value: p.answers['stale-closed'] ?? 'keep', set: [...new Set([...(record?.answers?.['stale-closed']?.set ?? []), ...asked])].sort(comparePhase) } : record?.answers?.['stale-closed'];
  const paths = [...written, ADOPT_REL].filter((x, i, a) => a.indexOf(x) === i).sort();
  const final = {
    ...base, state: 'applied',
    answers: { ...(staleRecord ? { 'stale-closed': staleRecord } : {}), ...(relaxRecord ? { relax: relaxRecord } : {}) },
    // review 6: the phases the owner decided on, re-checked ones included, so start and status stop naming them
    staleClosed: [...new Set([...base.staleClosed, ...p.overview.staleClosed])].sort(comparePhase),
    // review 2: every phase finished at adopt time counts as decided; one that finishes later is never named again
    finished: [...new Set([...(record?.finished ?? []), ...p.overview.phases.filter((r) => r.state === 'done' || r.state === 'closed-stale').map((r) => r.number)])].sort(comparePhase),
    reverified, roadmap_sha256: sha(readRoadmap(root)), paths,
  };
  writeJsonAtomic(adoptFile(root), final);
  // the outcomes are in the record now; a commit that fails leaves them to the record (review 1)
  fs.rmSync(reverifyFile(root), { force: true });
  let c;
  try {
    c = commitPaths(root, paths, 'chore(turbo): adopt');
  } catch (e) {
    // review 1: a hook, signing or a held index.lock; the next /turbo-adopt finishes it (interrupted)
    return { refused: [`${firstLine(e)}; run /turbo-adopt again to finish`] };
  }
  const head = c.committed ? deps.git(['rev-parse', '--short', 'HEAD']).trim() : null;
  return { committed: head, noChanges: false, commit: c, paths, report: adoptReport(root, { plan: p, record: final, commit: head, why: c.committed ? null : c.reason }) };
}

// Russian plural: 1 фаза, 2–4 фазы, 5+ фаз (11–14 фаз).
const phasesRu = (n) => {
  const d = n % 10;
  const dd = n % 100;
  return d === 1 && dd !== 11 ? 'фаза' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? 'фазы' : 'фаз';
};

const summaryOf = (f) => ({ unit: f.unit, before: f.before, after: f.after, factor: f.factor });

const REPORT_TEXT = {
  en: {
    recommended: 'recommended',
    where: 'Where the project is',
    closed: 'Closed phases without a fresh verification',
    closedKept: (ids) => `${ids}: kept closed (your answer); turbo does not run them`,
    reverified: (n, s, f) => (s === 'passed' ? `phase ${n}: re-checked, passed; the fresh report is committed` : `phase ${n}: re-checked, ${s}; the differences were most likely made by later phases; the phase stays closed${f ? `; report: \`${f}\`` : ''}`),
    lanes: 'Lanes and the critical path',
    before: (b, u) => `plain GSD: ${b.phases} phases one after another${u === 'hour' ? ` (~${round(b.hours)} h)` : ''}`,
    after: (a, s, u) => `turbo lanes: ${a.steps.length} steps: ${stepsLine(a.steps)}${u === 'hour' ? ` (~${round(a.hours)} h)` : ''}${s ? `, ×${round(s)}` : ''}`,
    inPhase: (w, s, k, u) => `with turbo's speed-up inside a phase (an estimate, ×${k}): ${u === 'hour' ? `~${round(w.hours)} h` : `${round(w.hours)} phase lengths`}${s ? `, ×${round(s)} in all` : ''}`,
    noPace: 'no done phase with a history: counted in phases',
    changed: 'What changed',
    commit: (sha) => `commit ${sha} chore(turbo): adopt; to undo: \`git revert ${sha}\``,
    noCommit: 'no changes: already adopted',
    notCommitted: (why) => `not committed: ${why}`,
    owner: 'What is left for you',
    ownerGate: (p, g) => `phase ${p} needs you (${g.join(', ')}): its lane waits for you there`,
    worktree: (w) => `an agent's working copy is left: \`turbo-run worktrees prune "${w}" --dry-run\` shows what would go`,
    gatesOff: (p) => `GSD's checks are off for phase ${p}: \`turbo-run gates restore ${p}\``,
    firstRun: (n, m) => `the first run makes ${n} ${n === 1 ? 'copy' : 'copies'} of the project next to it${m ? ` and prepares ${m} ${m === 1 ? 'phase' : 'phases'} ahead` : ''}`,
    nothingLeft: 'nothing',
    launch: 'Start',
  },
  ru: {
    recommended: 'рекомендуется',
    where: 'Где проект',
    closed: 'Закрытые фазы без свежей проверки',
    closedKept: (ids) => `${ids}: оставлены закрытыми (ваш ответ); turbo их не запускает`,
    reverified: (n, s, f) => (s === 'passed' ? `фаза ${n}: перепроверена, проверка пройдена; свежий отчёт в коммите` : `фаза ${n}: перепроверена, итог ${s}; расхождения, скорее всего, внесли следующие фазы; фаза остаётся закрытой${f ? `; отчёт: \`${f}\`` : ''}`),
    lanes: 'Полосы и критический путь',
    before: (b, u) => `обычный GSD: ${b.phases} ${phasesRu(b.phases)} подряд${u === 'hour' ? ` (~${round(b.hours)} ч)` : ''}`,
    after: (a, s, u) => `полосы turbo: шагов ${a.steps.length}: ${stepsLine(a.steps)}${u === 'hour' ? ` (~${round(a.hours)} ч)` : ''}${s ? `, ×${round(s)}` : ''}`,
    inPhase: (w, s, k, u) => `с ускорением внутри фазы (оценка, ×${k}): ${u === 'hour' ? `~${round(w.hours)} ч` : `${round(w.hours)} длины фазы`}${s ? `, всего ×${round(s)}` : ''}`,
    noPace: 'нет сделанных фаз с историей: счёт в фазах',
    changed: 'Что изменено',
    commit: (sha) => `коммит ${sha} chore(turbo): adopt; откатить: \`git revert ${sha}\``,
    noCommit: 'no changes: already adopted',
    notCommitted: (why) => `не закоммичено: ${why}`,
    owner: 'Что остаётся вам',
    ownerGate: (p, g) => `фазе ${p} нужны вы (${g.join(', ')}): её полоса подождёт вас`,
    worktree: (w) => `осталась рабочая копия агента: \`turbo-run worktrees prune "${w}" --dry-run\` покажет, что уйдёт`,
    gatesOff: (p) => `проверки GSD выключены у фазы ${p}: \`turbo-run gates restore ${p}\``,
    firstRun: (n, m) => `первый запуск сделает рядом копий проекта: ${n}${m ? `, и заранее подготовит фаз: ${m}` : ''}`,
    nothingLeft: 'ничего',
    launch: 'Запуск',
  },
};
const round = (x) => Math.round(x * 10) / 10;

function forecastLines(f, r) {
  return [
    r.before(f.before, f.unit),
    r.after(f.after, f.speedUp.lanes, f.unit),
    r.inPhase(f.withPhaseSpeedUp, f.speedUp.total, f.factor, f.unit),
    ...(f.unit === 'phase' ? [r.noPace] : []),
  ];
}

// spec §4.8: the report, in six sections, ending with the command that starts the run (review 7: plain
// /turbo-autonomous). plan: adoptPlan's result; record: the adopt record written; commit: the short sha or null.
export function adoptReport(root, { plan: p, record, commit, why = null }) {
  const r = REPORT_TEXT[p.lang];
  const t = textFor(p.lang);
  const ov = p.overview;
  const lines = [`## ${r.where}`, ...formatOverview(ov, p.lang).filter((l) => !/^(markup|branch): /.test(l) && l !== t.nothing)];
  lines.push('', `## ${r.closed}`);
  const decided = record?.staleClosed ?? [];
  const reverified = record?.reverified ?? {};
  const kept = decided.filter((n) => !Object.hasOwn(reverified, n));
  if (kept.length) lines.push(r.closedKept(phaseList(kept)));
  for (const [n, s] of Object.entries(reverified).sort(([a], [b]) => comparePhase(a, b))) lines.push(r.reverified(n, s, s === 'passed' ? null : reportRel(n)));
  if (!kept.length && !Object.keys(reverified).length) lines.push(r.nothingLeft);
  lines.push('', `## ${r.lanes}`, ...forecastLines(p.forecast, r));
  lines.push('', `## ${r.changed}`, ...p.changes.map((c) => `- ${c.text}`), commit ? r.commit(commit) : why ? r.notCommitted(why) : r.noCommit);
  lines.push('', `## ${r.owner}`);
  const o = p.owner;
  const owner = [
    ...o.ownerGates.map((g) => r.ownerGate(g.phase, g.gates)),
    ...(o.questions ? [t.questions(o.questions)] : []),
    ...o.humanNeeded.map((h) => t.human(h.phase, humanItems(t, h.items))),
    ...o.worktrees.map((w) => r.worktree(w)),
    ...o.gates.map((g) => r.gatesOff(g)),
    ...(o.slotsToMake ? [r.firstRun(o.slotsToMake, o.prepPhases.length)] : []),
  ];
  lines.push(...(owner.length ? owner : [r.nothingLeft]));
  lines.push('', `## ${r.launch}`, '/turbo-autonomous');
  return lines;
}

// --- outside adopt: start and status (spec §4.10) ---------------------------------------------------------------------

// The closed phases with a stale verification that start and status name (spec §4.10): without adopt.json, every one
// whose turbo lane did not finish it; with adopt.json, only those the owner has not decided on (review 2: after an adopt
// that recorded the phases finished at its time, none: a phase that finishes later is the run's normal life). phases:
// normalized (closed, complete).
export function staleClosedIds(root, phases, { laneDone = () => false } = {}) {
  const ids = phases.filter((p) => p.closed && !p.complete && !laneDone(p.number)).map((p) => p.number).sort(comparePhase);
  return undecidedStale(readRecord(root), ids);
}
export const staleClosedLine = (root, phases, lang = 'en', opts = {}) => closedLine(staleClosedIds(root, phases, opts), lang);

// The line itself, or null without phases.
export function closedLine(ids, lang = 'en') {
  if (!ids.length) return null;
  const list = phaseList(ids);
  return lang === 'ru'
    ? `закрытые фазы без свежей проверки: ${list} (отмечены сделанными, проверка устарела; turbo их пропускает) · /turbo-adopt`
    : `closed phases not re-verified: ${list} (checked off, verification stale; turbo skips them) · /turbo-adopt`;
}
