import { ANY_AREA, comparePhase, isFinished, pickPhases } from './scheduler.mjs';

// spec §4.7: what turbo's lanes would do with the phases left, by the scheduler's own rules (pickPhases), without an
// LLM. Every phase lasts the same: the median of the milestone's last done phases (phaseHours), or one unit.

// The main spec's estimate (§10): turbo's work inside a phase (parallel plans, targeted tests, gates fanned out) makes a
// phase about 2–2.5 times faster. An estimate, and the report says so.
export const IN_PHASE_FACTOR = 0.45;
const RECENT = 5;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// A9: per done phase of the milestone (the newest five by phase order) the span from the first to the last commit that
// touched its directory, in hours; the median, one decimal. git(args) → text; phaseDirOf(number) → the directory
// relative to the project root, or null. A phase with fewer than two commits says nothing. None: null.
export function phaseHours(phases, { git, phaseDirOf }) {
  const done = phases.filter((p) => p.complete).sort((a, b) => comparePhase(a.number, b.number)).slice(-RECENT);
  const spans = [];
  for (const p of done) {
    const dir = phaseDirOf(p.number);
    if (!dir) continue;
    let times = [];
    try {
      times = git(['log', '--format=%ct', '--', dir]).split(/\r?\n/).filter(Boolean).map(Number).filter(Number.isFinite);
    } catch {
      continue;
    }
    if (times.length < 2) continue;
    spans.push((Math.max(...times) - Math.min(...times)) / 3600);
  }
  return spans.length ? Math.round(median(spans) * 10) / 10 : null;
}

const EVERYWHERE = () => ({ areas: [...ANY_AREA], gates: [] });

// An event simulation with the real scheduler: at each event time the phases pickPhases starts (one step), each lasting
// one unit (hours, or 1); the earliest end finishes its phases, which then satisfy the deps on them. phases: normalized
// (number, deps, complete, closed), relaxations already in deps. slots: max_lanes (1 for checkout). Phases that never
// become ready (a dependency cycle) end the simulation.
export function forecast({ phases, annotation = EVERYWHERE, slots = 3, hours = null }) {
  const unit = hours ?? 1;
  const copy = phases.map((p) => ({ ...p, deps: [...(p.deps || [])] }));
  const open = copy.filter((p) => !isFinished(p));
  const steps = [];
  let running = [];
  let t = 0;
  for (;;) {
    const free = slots - running.length;
    const { picked } = free > 0 ? pickPhases(copy, { running: running.map((r) => ({ phase: r.phase, ...annotation(r.phase) })), annotation, slots: free }) : { picked: [] };
    if (picked.length) {
      steps.push(picked.map((p) => p.number));
      running.push(...picked.map((p) => ({ phase: p.number, end: t + unit })));
    }
    if (!running.length) break;
    t = Math.min(...running.map((r) => r.end));
    for (const r of running.filter((x) => x.end === t)) copy.find((p) => p.number === r.phase).complete = true;
    running = running.filter((x) => x.end !== t);
  }
  const before = open.length * unit;
  const ratio = (a, b) => (b > 0 ? a / b : null);
  return {
    unit: hours === null ? 'phase' : 'hour',
    before: { phases: open.length, hours: before },
    after: { steps, hours: t },
    withPhaseSpeedUp: { hours: t * IN_PHASE_FACTOR },
    speedUp: { lanes: ratio(before, t), total: ratio(before, t * IN_PHASE_FACTOR) },
    left: copy.filter((p) => !isFinished(p)).map((p) => p.number),
    factor: IN_PHASE_FACTOR,
  };
}

// "32 → 33 ∥ 35 → 34": the steps of a forecast.
export const stepsLine = (steps) => steps.map((s) => s.join(' ∥ ')).join(' → ');
