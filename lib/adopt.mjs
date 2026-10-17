import fs from 'node:fs';
import path from 'node:path';
import { localRunDir } from './paths.mjs';
import { readJson } from './fsx.mjs';
import { isSentinelPhase, normalizePhaseId, normalizePhases } from './gsd.mjs';
import { comparePhase } from './scheduler.mjs';
import { loadConfig, lanesSettings } from './config.mjs';
import { ROADMAP_REL, stalePhases } from './lanes-file.mjs';
import { findPhaseDir, phaseArtifacts, planOutline } from './phase-files.mjs';
import { planSetCheck } from './cli-phase.mjs';
import { openQuestions } from './view.mjs';
import { agentWorktrees } from './worktrees.mjs';
import { gatesLeftovers } from './gates.mjs';
import { listSlots } from './slots.mjs';
import { parseUat } from './uat.mjs';

// Stage 5 A (spec §4): /turbo-adopt moves a milestone that runs on plain GSD onto turbo. This module holds its
// deterministic parts; the skill conducts the LLM parts (the lane analyst, the verifiers, AskUserQuestion). Nothing here
// spawns claude, starts the supervisor, a lane or a job, makes slots, writes trust or removes a worktree (D2).

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

// What adopt may find dirty: turbo's run files, the paths of an adopt that stopped before its commit (an entry ending
// in / covers what is under it), and the files adopt reverify left for apply.
function acceptedDirty(root, record) {
  const own = record?.state === 'applying' && Array.isArray(record.paths) ? record.paths : [];
  const reverify = Object.values(readReverified(root)).flatMap((r) => (Array.isArray(r?.files) ? r.files : []));
  const list = [...own, ...reverify];
  return (p) => RUN_FILES.test(p) || list.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));
}

// The project's default branch: origin's HEAD, else main, else master; null when none is known.
function defaultBranch(git) {
  const origin = tryOr(() => git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']).trim(), '');
  if (origin) return origin.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (tryOr(() => git(['rev-parse', '--verify', '-q', `refs/heads/${b}`]).trim(), '')) return b;
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
    const ok = acceptedDirty(root, record);
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
  if (git && ['phase', 'milestone'].includes(branching)) {
    const main = defaultBranch(deps.git);
    if (main && branch !== main) refused.push(`HEAD is on ${branch ? `GSD's branch ${branch}` : 'no branch (detached)'}; merge it into ${main} and switch back (git switch ${main})`);
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
      refused.push(`GSD cannot list the phases (${firstLine(e)}): run turbo-run doctor`);
    }
  }
  if (!manager || !config) return { refused, overview: null, phases: [], dirty, config };
  const states = phaseStates(manager, { root, reverified: readReverified(root), current: currentPhase(root, deps.gsd) });
  const phases = states.map((s) => s.phase);
  const rows = states.map((s) => s.row);
  const lanesMode = lanesSettings(config.lanes).mode;
  const unfinished = rows.filter((r) => r.state !== 'done' && r.state !== 'closed-stale');
  const overview = {
    phases: rows,
    branch,
    staleClosed: rows.filter((r) => r.state === 'closed-stale').map((r) => r.number).sort(comparePhase),
    markup: lanesMode !== 'slots' ? 'off' : stalePhases(root, phases).length ? 'needed' : 'fresh',
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
  lines.push(`markup: ${overview.markup}`);
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

export { rel as relTo };
