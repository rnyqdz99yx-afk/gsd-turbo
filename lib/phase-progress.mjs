import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

// /turbo-phase pipeline (spec §4.3). Order is fixed; the skill runs nextStep() and records it here.
export const STEPS = Object.freeze(['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate', 'uat', 'close']);

const file = (root, phase) => path.join(runDir(root), `phase-p${phase}.json`);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function readProgress(root, phase) {
  const raw = readJson(file(root, phase), null);
  const done = Array.isArray(raw?.done) ? STEPS.filter((s) => raw.done.includes(s)) : [];
  return { phase: String(phase), done, notes: isObj(raw?.notes) ? raw.notes : {}, updatedAt: raw?.updatedAt || null };
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
  const out = { phase: String(phase), done: [...p.done, step], notes, updatedAt: now.toISOString() };
  writeJsonAtomic(file(root, phase), out);
  return out;
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
