import path from 'node:path';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { normalizePhaseId } from './gsd.mjs';
import { runDir as runDirOf } from './paths.mjs';
import { findPhaseDir, planFileNames } from './phase-files.mjs';
import { readProgress } from './phase-progress.mjs';

// Stage 6 M (spec §7): how long a phase took and how many tokens it used, by step and role, for both phase paths.
// Path B (the build path): run/cost-p<N>.json, one record per headless session (recordSessionUsage). Path L (lanes):
// the phase's lane transcripts and their subagents. Both are merged into one cost object.

// ≈IEU, input-equivalent units: Anthropic's price ratios. Every cache write weighs 1.25 (the 1h cache's ×2 is not
// used: the build path's usage has no 1h split, and both paths must be on one scale).
export const IEU_WEIGHTS = Object.freeze({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
// A gap between two transcript entries counts at most this long (an idle session is not working).
export const GAP_CAP_MS = 5 * 60 * 1000;

const USAGE_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const PHASE_RE = /^[A-Za-z0-9._-]+$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

// IEU of one usage, or of summed fields: never a sum of rounded parts.
export function ieuOf(usage) {
  const u = isObj(usage) ? usage : {};
  const [input, write, read, output] = USAGE_FIELDS.map((k) => count(u[k]));
  return Math.round(input * IEU_WEIGHTS.input + write * IEU_WEIGHTS.cacheWrite + read * IEU_WEIGHTS.cacheRead + output * IEU_WEIGHTS.output);
}

const costFile = (runDir, phase) => path.join(runDir, `cost-p${phase}.json`);

// The first field of a session record that is not valid, as '<field> <why>', or null.
function badField({ step, role, sessionId, usage, wallMs }) {
  if (typeof step !== 'string' || !LABEL_RE.test(step)) return 'step must match [A-Za-z0-9._:-]{1,64}';
  if (typeof role !== 'string' || !LABEL_RE.test(role)) return 'role must match [A-Za-z0-9._:-]{1,64}';
  if (sessionId !== null && (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId))) return 'sessionId must be null or match [A-Za-z0-9_-]{1,64}';
  if (!isObj(usage)) return 'usage must be an object';
  for (const k of USAGE_FIELDS) if (usage[k] !== undefined && !(Number.isFinite(usage[k]) && usage[k] >= 0)) return `usage.${k} must be a finite number >= 0`;
  if (!(Number.isFinite(wallMs) && wallMs >= 0)) return 'wallMs must be a finite number >= 0';
  return null;
}

// Appends one headless session's usage to run/cost-p<N>.json and returns the record written. Synchronous and without a
// lock: one writer per phase (the build process). A file that does not parse counts as empty. A bad value throws a
// TypeError naming the field before anything is written.
export function recordSessionUsage(runDir, phase, { step, role, sessionId = null, usage, wallMs }, { now = new Date() } = {}) {
  if (!PHASE_RE.test(String(phase ?? ''))) throw new TypeError(`cost record: phase must match [A-Za-z0-9._-]+ (got ${JSON.stringify(phase)})`);
  const why = badField({ step, role, sessionId, usage, wallMs });
  if (why) throw new TypeError(`cost record: ${why}`);
  const id = normalizePhaseId(phase);
  const record = { step, role, sessionId, usage: Object.fromEntries(USAGE_FIELDS.map((k) => [k, usage[k] ?? 0])), wallMs, at: now.toISOString() };
  const file = costFile(runDir, id);
  const raw = readJson(file, null);
  const sessions = isObj(raw) && Array.isArray(raw.sessions) ? raw.sessions : [];
  writeJsonAtomic(file, { v: 1, phase: id, sessions: [...sessions, record] });
  return record;
}

// A per-(step, role) accumulator: summed usage fields, time, its sessions and its first moment.
const newRow = (step, role) => ({ step, role, in: 0, cc: 0, cr: 0, out: 0, wallMs: 0, sessions: 0, firstMs: Infinity });
const addUsage = (acc, u) => {
  acc.in += count(u.input_tokens);
  acc.cc += count(u.cache_creation_input_tokens);
  acc.cr += count(u.cache_read_input_tokens);
  acc.out += count(u.output_tokens);
};
const rowKey = (step, role) => `${step}\0${role}`;
const rowOf = (rows, step, role) => {
  const key = rowKey(step, role);
  if (!rows.has(key)) rows.set(key, newRow(step, role));
  return rows.get(key);
};

// The total length of a set of [start, end] intervals, overlaps counted once.
function unionMs(intervals) {
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of [...intervals].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

// Path B: the valid records of run/cost-p<N>.json. rows: per (step, role) the summed fields and session time, sessions
// = distinct session ids (a null one counts alone); wall clock (total and per step) = the union of [at - wallMs, at].
function buildSource(runDir, phase) {
  const raw = readJson(costFile(runDir, phase), null);
  const records = (isObj(raw) && Array.isArray(raw.sessions) ? raw.sessions : [])
    .filter((r) => isObj(r) && badField({ ...r, sessionId: r.sessionId ?? null }) === null && Number.isFinite(Date.parse(r.at)));
  const rows = new Map();
  const ids = new Map();
  const spans = new Map();
  const all = new Set();
  let anonymous = 0;
  for (const r of records) {
    const end = Date.parse(r.at);
    const start = end - r.wallMs;
    const row = rowOf(rows, r.step, r.role);
    addUsage(row, r.usage);
    row.wallMs += r.wallMs;
    row.firstMs = Math.min(row.firstMs, start);
    const key = rowKey(r.step, r.role);
    if (!ids.has(key)) ids.set(key, new Set());
    const sid = r.sessionId ?? `\0${anonymous++}`;
    ids.get(key).add(sid);
    all.add(sid);
    if (!spans.has(r.step)) spans.set(r.step, []);
    spans.get(r.step).push([start, end]);
  }
  for (const [key, set] of ids) rows.get(key).sessions = set.size;
  const stepWall = new Map([...spans].map(([step, list]) => [step, unionMs(list)]));
  return {
    rows,
    stepWall,
    stepFirst: new Map([...spans].map(([step, list]) => [step, Math.min(...list.map((x) => x[0]))])),
    wallMs: unionMs([...spans.values()].flat()),
    sessions: all.size,
    records: records.length,
    fixers: records.filter((r) => r.role === 'fixer').length,
  };
}

// The phase's PLAN files (the slices of either path); 0 without a phase directory.
function sliceCount(root, phase) {
  try {
    const dir = findPhaseDir(root, phase);
    return dir ? planFileNames(dir).length : 0;
  } catch {
    return 0;
  }
}

const shown = (acc) => ({ out: acc.out, inCreate: acc.in + acc.cc, cacheRead: acc.cr, ieu: ieuOf({ input_tokens: acc.in, cache_creation_input_tokens: acc.cc, cache_read_input_tokens: acc.cr, output_tokens: acc.out }) });

// Merges the sources into the cost object: rows ordered by their first moment, then step, then role; steps in the
// order they first appear; total over everything. Wall clock of the total and of each step: lane + build.
function merge(phase, sources) {
  const rows = new Map();
  const steps = new Map();
  const total = newRow('', '');
  let wallMs = 0;
  let sessions = 0;
  for (const src of sources) {
    for (const [key, r] of src.rows) {
      if (!rows.has(key)) rows.set(key, newRow(r.step, r.role));
      const m = rows.get(key);
      for (const f of ['in', 'cc', 'cr', 'out', 'wallMs', 'sessions']) m[f] += r[f];
      m.firstMs = Math.min(m.firstMs, r.firstMs);
      if (!steps.has(r.step)) steps.set(r.step, { ...newRow(r.step, ''), wallMs: 0 });
      const s = steps.get(r.step);
      for (const f of ['in', 'cc', 'cr', 'out']) s[f] += r[f];
      s.firstMs = Math.min(s.firstMs, r.firstMs);
      for (const f of ['in', 'cc', 'cr', 'out']) total[f] += r[f];
    }
    for (const [step, ms] of src.stepWall) {
      if (!steps.has(step)) steps.set(step, newRow(step, ''));
      steps.get(step).wallMs += ms;
      steps.get(step).firstMs = Math.min(steps.get(step).firstMs, src.stepFirst.get(step) ?? Infinity);
    }
    wallMs += src.wallMs;
    sessions += src.sessions;
  }
  const order = (a, b) => a.firstMs - b.firstMs || a.step.localeCompare(b.step) || a.role.localeCompare(b.role);
  return {
    phase,
    rows: [...rows.values()].sort(order).map((r) => ({ step: r.step, role: r.role, sessions: r.sessions, wallMs: r.wallMs, ...shown(r) })),
    total: { sessions, wallMs, ...shown(total) },
    steps: [...steps.values()].sort(order).map((s) => ({ step: s.step, wallMs: s.wallMs, ieu: shown(s).ieu })),
  };
}

// The cost of phase N: { phase, rows: [{ step, role, sessions, wallMs, out, inCreate, cacheRead, ieu }], total,
// steps: [{ step, wallMs, ieu }], sources: { lane, build } (transcripts read, valid records), slices, fixRounds }.
// slices: the phase's PLAN files; fixRounds: the build path's fixer sessions, else the lane's --attempt fix count.
// Missing files read as no data; it never writes.
export function phaseCost({ root, phase, env = process.env }) {
  if (!PHASE_RE.test(String(phase ?? ''))) throw new TypeError(`phase cost: phase must match [A-Za-z0-9._-]+ (got ${JSON.stringify(phase)})`);
  const id = normalizePhaseId(phase);
  const build = buildSource(runDirOf(root), id);
  const cost = merge(id, [build]);
  let fixRounds = build.fixers;
  if (!build.records) {
    try {
      fixRounds = readProgress(root, id).attempts.fix ?? 0;
    } catch {
      fixRounds = 0;
    }
  }
  return { ...cost, sources: { lane: 0, build: build.records }, slices: sliceCount(root, id), fixRounds };
}
