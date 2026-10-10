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
