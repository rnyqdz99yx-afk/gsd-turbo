// One dot-segment of a normalized GSD phase id ("2", "2A"): [integer part, letter suffix].
// The regex always matches, so any other text still yields a total order instead of NaN.
function segment(s) {
  const [, digits, rest] = /^(\d*)(.*)$/s.exec(s);
  return [digits ? Number(digits) : -1, rest.toUpperCase()];
}

// Per dot-segment: integer part numerically, then letter suffix (none first); a missing
// segment sorts first. So "2" < "2.1" < "2A" < "2B" < "3", matching GSD's comparePhaseNum.
export function comparePhase(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const [na, sa] = segment(pa[i]);
    const [nb, sb] = segment(pb[i]);
    if (na !== nb) return na - nb;
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

// Scheduling only: a closed phase is never started again and satisfies the deps on it.
export const isFinished = (p) => Boolean(p.complete || p.closed);

// A run's range { from, to } (turbo-run start --from/--to/--only), inclusive; a null end is open
// and no range is the whole milestone.
export function inRange(number, range) {
  return (range?.from == null || comparePhase(number, range.from) >= 0) && (range?.to == null || comparePhase(number, range.to) <= 0);
}
export const rangeLabel = (range) => `${range.from ?? 'start'}–${range.to ?? 'end'}`;

// A dep outside the milestone counts as satisfied; a dep of the milestone (inside the range or
// outside it) only once it is finished: the run never starts it outside its range.
export function nextPhase(phases, { exclude = [], range = null } = {}) {
  const byNum = new Map(phases.map((p) => [p.number, p]));
  const ready = phases
    .filter((p) => !isFinished(p) && inRange(p.number, range) && !exclude.includes(p.number))
    .filter((p) => p.deps.every((d) => !byNum.has(d) || isFinished(byNum.get(d))))
    .sort((a, b) => comparePhase(a.number, b.number));
  return ready[0] || null;
}

// The first unfinished phase of the range that waits on an unfinished phase of the milestone outside
// the range ({ phase, dep }, the lowest such dep), or null. Such a phase never starts in this run.
export function rangeBlocker(phases, range) {
  if (!range) return null;
  const byNum = new Map(phases.map((p) => [p.number, p]));
  const held = phases
    .filter((p) => !isFinished(p) && inRange(p.number, range))
    .sort((a, b) => comparePhase(a.number, b.number))
    .map((p) => ({ phase: p.number, dep: p.deps.filter((d) => byNum.has(d) && !inRange(d, range) && !isFinished(byNum.get(d))).sort(comparePhase)[0] }))
    .find((x) => x.dep !== undefined);
  return held || null;
}

// A missing or invalid count starts at 0; a missing or invalid limit halts (NaN compares false).
export function relaunchDecision({ restarts, progressed, maxRestarts }) {
  if (progressed) return { action: 'relaunch', restarts: 0 };
  const n = Number(restarts);
  const next = (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0) + 1;
  return { action: next <= Number(maxRestarts) ? 'relaunch' : 'halt', restarts: next };
}

// spec §6.2, §6.3 (Stage 4 L1): a phase without annotation may touch any path.
export const ANY_AREA = Object.freeze(['**']);

// Brace and extglob openers count too: everything after them is not static.
const GLOB_META = /[*?[{(]/;

// spec §6.3: the static part of a path mask, up to its first wildcard: whole segments, then the start of the next one
// (partial: '' when the wildcard starts the segment; null for a mask without wildcards, one exact path). Lower case:
// Windows and macOS do not tell File.ts from file.ts, and a false overlap only costs parallelism. An empty or negated
// mask (!x) is everything; a trailing / is the directory and everything in it.
export function maskPrefix(mask) {
  let m = String(mask ?? '').trim().replace(/\\/g, '/').toLowerCase();
  while (m.startsWith('./')) m = m.slice(2);
  m = m.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  if (!m || m.startsWith('!')) return { segs: [], partial: '' };
  const i = m.search(GLOB_META);
  if (i < 0) return m.endsWith('/') ? { segs: m.slice(0, -1).split('/'), partial: '' } : { segs: m.split('/'), partial: null };
  const parts = m.slice(0, i).split('/');
  const partial = parts.pop();
  return { segs: parts, partial };
}

// Two static parts overlap when the shorter is a prefix of the longer by segments: an exact path that ends first may
// be a directory of the other; a wildcard segment overlaps every segment that starts with its static start.
function prefixOverlap(a, b) {
  const n = Math.min(a.segs.length, b.segs.length);
  for (let i = 0; i < n; i++) if (a.segs[i] !== b.segs[i]) return false;
  if (a.segs.length === b.segs.length) {
    if (a.partial === null || b.partial === null) return true;
    return a.partial.startsWith(b.partial) || b.partial.startsWith(a.partial);
  }
  const [short, long] = a.segs.length < b.segs.length ? [a, b] : [b, a];
  return short.partial === null || long.segs[short.segs.length].startsWith(short.partial);
}

// spec §6.3: whether two phases' Areas may touch one path. Conservative: a non-array is everything, [] is nothing.
export function areasOverlap(a, b) {
  const list = (x) => (Array.isArray(x) ? x : ANY_AREA).map(maskPrefix);
  const pb = list(b);
  return list(a).some((x) => pb.some((y) => prefixOverlap(x, y)));
}

// spec §6.2–§6.4 (D5): one phase's areas and gates from lanes.json (L3's readLanesFile); a phase missing from it, with
// confidence low or without a list of masks is ** (it overlaps every phase). Its gates count whatever its confidence.
export function annotationOf(lanesFile, number) {
  const e = lanesFile?.phases?.[String(number)];
  const gates = Array.isArray(e?.gates) ? e.gates.filter((g) => typeof g === 'string' && g) : [];
  const ok = Boolean(e) && e.confidence !== 'low' && Array.isArray(e.areas) && e.areas.every((m) => typeof m === 'string');
  return { areas: ok ? [...e.areas] : [...ANY_AREA], gates };
}

// spec §5 (D4): per unfinished phase, 1 + the longest chain of unfinished phases that wait on it. A dependency cycle
// is cut where it closes.
export function criticalPath(phases) {
  const open = phases.filter((p) => !isFinished(p));
  const waiting = new Map(open.map((p) => [p.number, []]));
  for (const p of open) for (const d of p.deps) if (waiting.has(d)) waiting.get(d).push(p.number);
  const memo = new Map();
  const len = (n, stack) => {
    if (memo.has(n)) return memo.get(n);
    if (stack.has(n)) return 0;
    stack.add(n);
    const v = 1 + Math.max(0, ...waiting.get(n).map((m) => len(m, stack)));
    stack.delete(n);
    memo.set(n, v);
    return v;
  };
  return new Map(open.map((p) => [p.number, len(p.number, new Set())]));
}

const EVERYWHERE = () => ({ areas: [...ANY_AREA], gates: [] });

// spec §5: the phases to launch now, at most `slots`, in critical-path order: unfinished, in the range, not running or
// excluded, every dependency of the milestone finished, Areas disjoint from every running and picked phase, no Gates
// entry held by one of them or by a lock (heldGates), and with oneLane (no fresh annotation) only while no phase lane
// runs. next: the first ready phase left out and why, else the first one waiting on its dependencies, else null.
export function pickPhases(phases, { range = null, running = [], exclude = [], annotation = EVERYWHERE, heldGates = [], slots = 0, oneLane = false } = {}) {
  const byNum = new Map(phases.map((p) => [p.number, p]));
  const skip = new Set([...exclude.map(String), ...running.map((r) => String(r.phase))]);
  const open = phases.filter((p) => !isFinished(p) && inRange(p.number, range) && !skip.has(p.number));
  const depsOf = (p) => p.deps.filter((d) => byNum.has(d) && !isFinished(byNum.get(d)));
  const cp = criticalPath(phases);
  const order = (a, b) => (cp.get(b.number) ?? 1) - (cp.get(a.number) ?? 1) || comparePhase(a.number, b.number);
  const taken = running.map((r) => ({ phase: String(r.phase), areas: Array.isArray(r.areas) ? r.areas : ANY_AREA, gates: Array.isArray(r.gates) ? r.gates : [] }));
  const picked = [];
  let next = null;
  const miss = (p, why, waitsFor, gate) => { next ??= { phase: p.number, why, waitsFor, ...(gate ? { gate } : {}) }; };
  for (const p of open.filter((x) => !depsOf(x).length).sort(order)) {
    const a = annotation(p.number);
    if (oneLane && taken.length) { miss(p, 'annotation', taken.map((t) => t.phase)); continue; }
    const clash = taken.find((t) => areasOverlap(a.areas, t.areas));
    if (clash) { miss(p, 'areas', [clash.phase]); continue; }
    const holder = taken.find((t) => t.gates.some((g) => a.gates.includes(g)));
    if (holder) { miss(p, 'gates', [holder.phase], holder.gates.find((g) => a.gates.includes(g))); continue; }
    const lock = heldGates.find((h) => a.gates.includes(h.gate));
    if (lock) { miss(p, 'gates', lock.phase ? [String(lock.phase)] : [], lock.gate); continue; }
    if (picked.length >= slots) { miss(p, 'slots', []); continue; }
    picked.push(p);
    taken.push({ phase: p.number, areas: a.areas, gates: a.gates });
  }
  if (!next) {
    const waiting = open.filter((p) => depsOf(p).length).sort(order)[0];
    if (waiting) next = { phase: waiting.number, why: 'deps', waitsFor: depsOf(waiting).sort(comparePhase) };
  }
  return { picked, next };
}
