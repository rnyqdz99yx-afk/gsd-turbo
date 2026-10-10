import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { allPlansSummarized, findPhaseDir } from './phase-files.mjs';

// /turbo-phase pipeline (spec §4.3). Order is fixed; the skill runs nextStep() and records it here.
export const STEPS = Object.freeze(['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate', 'uat', 'close']);
// Bounded rounds that are not steps count here too: ci (red-CI fix rounds, push.ci_fix_rounds; spec §6, S2).
const ATTEMPTS = Object.freeze([...STEPS, 'ci']);

const file = (root, phase) => path.join(runDir(root), `phase-p${phase}.json`);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Only a positive integer under a known step is a count; anything else reads as absent.
const attemptsOf = (raw) => Object.fromEntries(ATTEMPTS.filter((s) => isObj(raw) && Number.isInteger(raw[s]) && raw[s] > 0).map((s) => [s, raw[s]]));

export function readProgress(root, phase) {
  const raw = readJson(file(root, phase), null);
  const done = Array.isArray(raw?.done) ? STEPS.filter((s) => raw.done.includes(s)) : [];
  return { phase: String(phase), done, notes: isObj(raw?.notes) ? raw.notes : {}, attempts: attemptsOf(raw?.attempts), updatedAt: raw?.updatedAt || null };
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
  const out = { phase: String(phase), done: [...p.done, step], notes, attempts: p.attempts, updatedAt: now.toISOString() };
  writeJsonAtomic(file(root, phase), out);
  return out;
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
}

// The phase a lane works on: the supervisor's lane, else the newest unfinished /turbo-phase run.
export function activePhase(root) {
  const sup = readJson(path.join(runDir(root), 'supervisor.json'), null);
  if (sup?.lane?.phase != null && String(sup.lane.phase)) return String(sup.lane.phase);
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
  writeJsonAtomic(file(root, phase), { phase: p.phase, done: p.done, notes, attempts: p.attempts, updatedAt: now.toISOString() });
  return notes[step];
}
