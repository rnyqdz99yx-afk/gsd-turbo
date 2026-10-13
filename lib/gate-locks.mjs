import fs from 'node:fs';
import path from 'node:path';
import { locksDir } from './paths.mjs';
import { ensureDir, readJson } from './fsx.mjs';
import { GATE_RE } from './config.mjs';

// spec §5 (Stage 4 L1, D13): file mutexes for one-off actions on shared resources (a deploy, a packaged build). One
// file per gate in the control root's locks/gates/, created with wx so two lanes never both take it. A phase's Gates
// line holds its gates for the whole phase without a file (gateDeclaredBy reads them from supervisor.json lanes).
export const gateFile = (root, gate) => path.join(locksDir(root), 'gates', `${gate}.json`);

function checked(gate) {
  if (!GATE_RE.test(String(gate))) throw new Error(`invalid gate name ${JSON.stringify(String(gate))}`);
  return String(gate);
}

export function readGate(root, gate) {
  const rec = readJson(gateFile(root, checked(gate)), null);
  return rec && typeof rec === 'object' && typeof rec.phase === 'string' && rec.phase ? { gate: String(gate), phase: rec.phase, at: typeof rec.at === 'string' ? rec.at : null } : null;
}

// Every lock file; one that cannot be read is held by nobody known (phase null): it still holds its gate.
export function heldGates(root) {
  let names;
  try {
    names = fs.readdirSync(path.join(locksDir(root), 'gates'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.map((n) => /^(.+)\.json$/.exec(n)?.[1]).filter((g) => g && GATE_RE.test(g)).sort()
    .map((gate) => readGate(root, gate) || { gate, phase: null, at: null });
}

// Another running phase lane whose annotation declares the gate (spec §5: a phase's Gates are taken for the whole phase).
export function gateDeclaredBy(sup, gate, phase) {
  for (const l of Object.values(sup?.lanes || {})) {
    if (l && (l.job ?? 'phase') === 'phase' && String(l.phase) !== String(phase) && Array.isArray(l.gates) && l.gates.includes(gate)) return String(l.phase);
  }
  return null;
}

function take(root, gate, phase, at) {
  const file = gateFile(root, gate);
  ensureDir(path.dirname(file));
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, `${JSON.stringify({ gate, phase, at })}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return { acquired: true, already: false };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const cur = readGate(root, gate);
  if (cur?.phase === phase) return { acquired: true, already: true };
  return { acquired: false, holder: { phase: cur?.phase ?? null, at: cur?.at ?? null, by: 'lock' } };
}

// Takes the gate for the phase, waiting up to waitMs (polled every stepMs) while a lock file or another running lane
// holds it. The phase's own earlier lock counts as taken.
export async function acquireGate(root, gate, phase, {
  waitMs = 0, stepMs = 2000, declaredBy = () => null,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), stamp = () => new Date().toISOString(),
} = {}) {
  const g = checked(gate);
  const id = String(phase);
  const end = now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    const lane = declaredBy(g);
    const r = lane ? { acquired: false, holder: { phase: lane, at: null, by: 'lane' } } : take(root, g, id, stamp());
    if (r.acquired) return r;
    const left = end - now();
    if (left <= 0) return r;
    await sleep(Math.min(stepMs, left));
  }
}

// Only the holder releases its lock; a lock file nobody can name (broken) goes for anyone.
export function releaseGate(root, gate, phase) {
  const file = gateFile(root, checked(gate));
  if (!fs.existsSync(file)) return { released: false, why: 'not-held' };
  const cur = readGate(root, gate);
  if (cur && cur.phase !== String(phase)) return { released: false, why: 'other', holder: cur.phase };
  fs.rmSync(file, { force: true });
  return { released: true };
}

// The supervisor, when a lane ends: every lock its phase still holds.
export function releaseGatesOf(root, phase) {
  const freed = [];
  for (const g of heldGates(root)) {
    if (g.phase !== String(phase)) continue;
    fs.rmSync(gateFile(root, g.gate), { force: true });
    freed.push(g.gate);
  }
  return freed;
}
