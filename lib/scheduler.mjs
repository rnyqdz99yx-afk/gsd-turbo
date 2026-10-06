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

export function nextPhase(phases, { exclude = [] } = {}) {
  const byNum = new Map(phases.map((p) => [p.number, p]));
  const ready = phases
    .filter((p) => !p.complete && !exclude.includes(p.number))
    .filter((p) => p.deps.every((d) => !byNum.has(d) || byNum.get(d).complete))
    .sort((a, b) => comparePhase(a.number, b.number));
  return ready[0] || null;
}

export function relaunchDecision({ restarts, progressed, maxRestarts }) {
  if (progressed) return { action: 'relaunch', restarts: 0 };
  const next = restarts + 1;
  return { action: next > maxRestarts ? 'halt' : 'relaunch', restarts: next };
}
