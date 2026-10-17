import fs from 'node:fs';
import path from 'node:path';
import { localRunDir, runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { allPlansSummarized, anySummary, findPhaseDir } from './phase-files.mjs';
import { laneAt } from './lanes-state.mjs';
import { leanSettings, loadConfig } from './config.mjs';

// /turbo-phase pipeline (spec §4.3). Order is fixed; the skill runs nextStep() and records it here.
// integrate (Stage 4 §7.1): a lane in a slot takes in main and hands the phase to the supervisor's merge; outside a slot
// turbo-run phase-step passes it at once
export const STEPS = Object.freeze(['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate', 'uat', 'close', 'integrate']);
// Bounded rounds that are not steps count here too: ci (red-CI fix rounds, push.ci_fix_rounds; spec §6, S2).
// ci: red CI rounds; owner-gaps: the gap rounds the owner chose (v0.3.3); review-diff: the lean fix loop's reviews of
// the fix diff (Stage 6 L2)
const ATTEMPTS = Object.freeze([...STEPS, 'ci', 'owner-gaps', 'review-diff']);

const file = (root, phase) => path.join(runDir(root), `phase-p${phase}.json`);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Only a positive integer under a known step is a count; anything else reads as absent.
const attemptsOf = (raw) => Object.fromEntries(ATTEMPTS.filter((s) => isObj(raw) && Number.isInteger(raw[s]) && raw[s] > 0).map((s) => [s, raw[s]]));

// checks: turbo's own records beside GSD's (checks.plan: the plan-checker's verdict, recordPlanCheck).
const checksOf = (raw) => (isObj(raw?.plan) && Array.isArray(raw.plan.plans) && typeof raw.plan.at === 'string' ? { plan: raw.plan } : {});

export function readProgress(root, phase) {
  const raw = readJson(file(root, phase), null);
  const done = Array.isArray(raw?.done) ? STEPS.filter((s) => raw.done.includes(s)) : [];
  return { phase: String(phase), done, notes: isObj(raw?.notes) ? raw.notes : {}, attempts: attemptsOf(raw?.attempts), checks: checksOf(raw?.checks), updatedAt: raw?.updatedAt || null };
}

export function nextStep(progress) {
  return STEPS.find((s) => !progress.done.includes(s)) ?? null;
}

export function completeStep(root, phase, step, { note = '', now = new Date() } = {}) {
  if (!STEPS.includes(step)) throw new Error(`unknown step: ${step}`);
  const p = readProgress(root, phase);
  const next = nextStep(p);
  if (step !== next) throw new Error(`phase ${phase}: step ${step} is out of order (next is ${next ?? 'none'})`);
  const notes = note ? { ...p.notes, [step]: String(note).slice(0, 500) } : p.notes;
  const out = { phase: String(phase), done: [...p.done, step], notes, attempts: p.attempts, checks: p.checks, updatedAt: now.toISOString() };
  writeJsonAtomic(file(root, phase), out);
  if (step === 'plan') markPlanDone(root, phase, now);
  return out;
}

// The plan step's own record: the plan-checker gave its verdict on these plan files (their names in the phase
// directory). GSD's plan-phase runs its checker after the last plan's commit and records the planning only after it
// (STATE.md, the ROADMAP, and its create-phase-plan commit only with commit_docs); a session cut in between left a whole
// plan set nobody checked. This record holds whatever GSD's config (lib/cli-phase.mjs planCheckState).
export function recordPlanCheck(root, phase, { plans, note = '', now = new Date() } = {}) {
  const p = readProgress(root, phase);
  const plan = { at: now.toISOString(), plans: [...plans].sort(), ...(note ? { note: String(note).slice(0, 500) } : {}) };
  const out = { phase: p.phase, done: p.done, notes: p.notes, attempts: p.attempts, checks: { ...p.checks, plan }, updatedAt: now.toISOString() };
  writeJsonAtomic(file(root, phase), out);
  return plan;
}

// The turbo-phase skill's bounded rounds (gap closure, fix iterations, final-gate rounds, the UAT repeat) count
// here, so a resumed session goes on from the earlier sessions' count instead of starting a fresh budget: each
// round commits, which changes the supervisor's fingerprint and resets its restart counter.
export function countAttempt(root, phase, step, { now = new Date() } = {}) {
  if (!ATTEMPTS.includes(step)) throw new Error(`unknown step: ${step}`);
  const p = readProgress(root, phase);
  const n = (p.attempts[step] || 0) + 1;
  writeJsonAtomic(file(root, phase), { ...p, attempts: { ...p.attempts, [step]: n }, updatedAt: now.toISOString() });
  return n;
}

// The owner's resume: a fresh budget for every step; the steps done stay done.
export function clearAttempts(root, phase) {
  const p = readProgress(root, phase);
  if (!Object.keys(p.attempts).length) return;
  writeJsonAtomic(file(root, phase), { ...p, attempts: {} });
}

export function resetProgress(root, phase) {
  fs.rmSync(file(root, phase), { force: true });
  fs.rmSync(clockFile(root, phase), { force: true });
  fs.rmSync(leanFile(root, phase), { force: true });
}

// Stage 6 L2 (D10): whether phase N runs lean. The pin turbo-run phase-step N --done gates-off writes decides; without
// one, a phase whose execution began (step gates-off done, or a plan SUMMARY: L1's executeBegun) began before lean and
// finishes without it; otherwise lean.enabled. Its own file beside phase-p<N>.json, like plan-clock-p<N>.json.
const leanFile = (root, phase) => path.join(runDir(root), `lean-p${phase}.json`);

export function phaseLean(root, phase, cfg = null) {
  const pin = readJson(leanFile(root, phase), null);
  if (typeof pin?.lean === 'boolean') return pin.lean;
  if (readProgress(root, phase).done.includes('gates-off')) return false;
  const dir = findPhaseDir(root, phase);
  if (dir && anySummary(dir)) return false;
  return leanSettings(cfg ?? loadConfig(root)).enabled;
}

export function pinLean(root, phase, lean, { now = new Date() } = {}) {
  writeJsonAtomic(leanFile(root, phase), { lean: Boolean(lean), at: now.toISOString() });
}

// spec §5.3: the window in which test-changed runs no full suite: a lean phase's turbo-phase run (its progress file) until
// its final-gate is done. null outside it. Outside a lane session (TURBO_LANE, which every process of a lane carries) a
// run whose progress has not moved for LEAN_WINDOW_HOURS is taken for an abandoned one, so a hand run tests in full.
export const LEAN_WINDOW_HOURS = 24;
export function leanDeferral(root, cfg = null, { env = process.env, now = new Date() } = {}) {
  const phase = activePhase(root);
  if (!phase) return null;
  const p = readProgress(root, phase);
  if (!p.updatedAt || p.done.includes('final-gate')) return null;
  if (!env.TURBO_LANE && !(now.getTime() - Date.parse(p.updatedAt) <= LEAN_WINDOW_HOURS * 3600000)) return null;
  return phaseLean(root, phase, cfg) ? { phase } : null;
}

// The phase a lane works on: the supervisor's lane, else the newest unfinished /turbo-phase run.
export function activePhase(root) {
  const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
  // the lane that works in this directory: v0.3's lane in this checkout, or the slot lane whose slot this is
  const here = laneAt(sup, root, root);
  if (here?.job === 'phase' && here.phase) return here.phase;
  // slots mode (Stage 4): while lanes run, none of them works in the main checkout
  if (sup?.lanes && Object.keys(sup.lanes).length) return null;
  let names;
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    return null;
  }
  let best = null;
  for (const n of names) {
    const m = /^phase-p(.+)\.json$/.exec(n);
    if (!m) continue;
    const p = readProgress(root, m[1]);
    if (nextStep(p) === null || !p.updatedAt) continue;
    if (!best || p.updatedAt > best.updatedAt) best = p;
  }
  return best ? best.phase : null;
}

// The active phase is at its end once it has plans and every plan has a summary (spec §4.7).
// The rule stops once the lane marks execute done: the fan-out and fixes run targeted tests (spec §4.6).
export function phaseEndState(root) {
  const phase = activePhase(root);
  if (!phase || readProgress(root, phase).done.includes('execute')) return null;
  const dir = findPhaseDir(root, phase);
  return dir && allPlansSummarized(dir) ? { phase } : null;
}

// A note on the step in progress without completing it (S1: how an owner answer reached its agent). It joins the
// step's earlier note; at most 500 characters are kept, from the end.
export function noteStep(root, phase, note, { now = new Date() } = {}) {
  const p = readProgress(root, phase);
  const step = nextStep(p) ?? STEPS[STEPS.length - 1];
  const text = [p.notes[step], String(note)].filter(Boolean).join('; ');
  const notes = { ...p.notes, [step]: text.length > 500 ? text.slice(-500) : text };
  writeJsonAtomic(file(root, phase), { phase: p.phase, done: p.done, notes, attempts: p.attempts, checks: p.checks, updatedAt: now.toISOString() });
  return notes[step];
}

// spec §6.1 (L3, D1): /turbo-prep runs freshness, discuss and prologue of the pipeline above and stops before plan. Its
// record lives in the slot's own run directory (the next prepareSlot wipes it), apart from the phase's phase-p<N>.json,
// so the phase's lane runs those steps again on the main branch it starts from.
export const PREP_STEPS = Object.freeze(['freshness', 'discuss', 'prologue']);
const prepFile = (root, phase) => path.join(localRunDir(root), `prep-p${phase}.json`);

export function readPrepProgress(root, phase) {
  const raw = readJson(prepFile(root, phase), null);
  const done = Array.isArray(raw?.done) ? PREP_STEPS.filter((s) => raw.done.includes(s)) : [];
  return { phase: String(phase), done, notes: isObj(raw?.notes) ? raw.notes : {}, updatedAt: raw?.updatedAt || null };
}

export const nextPrepStep = (progress) => PREP_STEPS.find((s) => !progress.done.includes(s)) ?? null;

export function completePrepStep(root, phase, step, { note = '', now = new Date() } = {}) {
  if (!PREP_STEPS.includes(step)) throw new Error(`unknown prep step: ${step} (prep runs ${PREP_STEPS.join(', ')})`);
  const p = readPrepProgress(root, phase);
  const next = nextPrepStep(p);
  if (step !== next) throw new Error(`phase ${phase}: prep step ${step} is out of order (next is ${next ?? 'none'})`);
  const notes = note ? { ...p.notes, [step]: String(note).slice(0, 500) } : p.notes;
  const out = { phase: String(phase), done: [...p.done, step], notes, updatedAt: now.toISOString() };
  writeJsonAtomic(prepFile(root, phase), out);
  return out;
}

// Stage 5 §5.8 (B12): the plan step's wall clock, the planning time the owner compares with plan drafts on and off.
// started: the first time phase-step N named plan as the next step (a resumed session keeps it); done: when the step was
// marked done. Its own file beside phase-p<N>.json, so no writer of that file has to carry it.
const clockFile = (root, phase) => path.join(runDir(root), `plan-clock-p${phase}.json`);

export function planTiming(root, phase) {
  const raw = readJson(clockFile(root, phase), null);
  const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
  const started = iso(raw?.started);
  const done = iso(raw?.done);
  return { started, done, ms: started && done ? Math.max(0, Date.parse(done) - Date.parse(started)) : null };
}

export function markPlanStarted(root, phase, { now = new Date() } = {}) {
  const t = planTiming(root, phase);
  if (!t.started) writeJsonAtomic(clockFile(root, phase), { started: now.toISOString(), done: null });
}

function markPlanDone(root, phase, now) {
  writeJsonAtomic(clockFile(root, phase), { started: planTiming(root, phase).started, done: now.toISOString() });
}

// A step's note with text put before what the lane wrote (the measurement line before the lane's own note); every other
// field of the progress file is kept as it is.
export function prefixStepNote(root, phase, step, text) {
  const raw = readJson(file(root, phase), null);
  if (!isObj(raw)) return;
  const notes = isObj(raw.notes) ? raw.notes : {};
  const joined = [String(text), notes[step]].filter(Boolean).join('; ');
  writeJsonAtomic(file(root, phase), { ...raw, notes: { ...notes, [step]: joined.slice(0, 500) } });
}
