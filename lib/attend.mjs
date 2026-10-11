import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { comparePhase } from './scheduler.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { readQuestions, withPhaseLock, writeQuestions } from './questions.mjs';
import { STEPS } from './phase-progress.mjs';
import { isAgentAlive } from './run-status.mjs';

// spec §8 (S4): run/p<N>-attend.json marks a phase the owner runs in their own session (turbo-run attend N). The
// file's existence is the mark: an empty or broken one still holds every lane, so a damaged mark never lets a lane
// start next to the owner. Its content ({ phase, at, sessionId }) only informs.
const MARK_RE = /^p(.+)-attend\.json$/;
export const attendFile = (root, phase) => path.join(runDir(root), `p${phase}-attend.json`);

// Writes the mark; an earlier mark of the phase keeps its time and its session.
export function writeAttend(root, phase, { sessionId = null, now = new Date() } = {}) {
  const prev = readJson(attendFile(root, phase), null);
  const rec = {
    phase: String(phase),
    at: typeof prev?.at === 'string' ? prev.at : now.toISOString(),
    sessionId: typeof prev?.sessionId === 'string' && prev.sessionId ? prev.sessionId : sessionId,
  };
  writeJsonAtomic(attendFile(root, phase), rec);
  return rec;
}

// Removes the mark; true when there was one.
export function clearAttend(root, phase) {
  const file = attendFile(root, phase);
  const had = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return had;
}

// Every attended phase in GSD's phase order: [{ phase, at }], at null when the mark cannot be read.
export function attendedPhases(root) {
  let names;
  try {
    names = fs.readdirSync(runDir(root));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.map((n) => MARK_RE.exec(n)?.[1]).filter(Boolean).sort(comparePhase).map((phase) => {
    const rec = readJson(attendFile(root, phase), null);
    return { phase, at: typeof rec?.at === 'string' ? rec.at : null };
  });
}

// spec §8 with §4.3: what the owner's sitting does with GSD's own gates (code review, security, nyquist, UI review),
// from the lane's mode and its next /turbo-phase step (turbo-run phase-step N). Off only while the lane's restore and
// fan-out still lie ahead: they run the gates over the sitting's plans after the hand-back. Past the fan-out (fix,
// final-gate, uat: gap plans) and in a safe-mode lane (gsd-autonomous) nothing would run them later, so they stay
// on and GSD runs them in the sitting. Before gates-off the plans are not checked yet: refused.
const FIRST_ATTENDABLE = STEPS.indexOf('gates-off');
const GATES_OFF_UNTIL = STEPS.indexOf('restore');
export function attendGates({ mode, next }) {
  if (mode !== 'full') return { gates: 'on', why: 'a safe-mode lane runs gsd-autonomous: GSD runs its own gates in this session' };
  const at = next == null ? STEPS.length : STEPS.indexOf(next);
  if (at >= 0 && at < FIRST_ATTENDABLE) return { refuse: `its lane's next turbo-phase step is ${next}, so its plans are not checked yet (attend takes a lane over from its gates-off step on)` };
  if (at >= FIRST_ATTENDABLE && at <= GATES_OFF_UNTIL) return { gates: 'off', why: `next step ${next}: the lane's restore and fan-out run GSD's gates over these plans after the hand-back` };
  return { gates: 'on', why: `next step ${next ?? 'none'}: the lane is past its fan-out, so GSD runs its own gates in this session` };
}

// spec §8 with §5.5: a supervisor killed in the middle of a lane launch or wake can leave its claude --bg (--resume)
// child running (on Windows the kill ends the daemon only), and that child may register a lane session after attend
// stopped the listed ones. Until settleMs have passed by the clock (a slow session list eats into the window, it never
// stretches it), every stepMs: list the sessions again and stop each live lane session that appeared. A stop that
// fails is tried again at the next list; what still fails at the end is reported.
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
export async function sweepLateLanes({ list, stop, isLane, settleMs = 5000, stepMs = 1000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const stopped = [];
  const failed = new Map();
  const end = now() + settleMs;
  for (let left = settleMs; left > 0; left = end - now()) {
    await sleep(Math.min(stepMs, left));
    let agents;
    try {
      agents = list();
    } catch (err) {
      failed.set(null, errLine(err));
      break;
    }
    for (const a of agents) {
      if (!isLane(a) || !isAgentAlive(a) || stopped.includes(a.id)) continue;
      try {
        stop(a.id);
        stopped.push(a.id);
        failed.delete(a.id);
      } catch (err) {
        failed.set(a.id, errLine(err));
      }
    }
  }
  return { stopped, failed: [...failed].map(([id, error]) => ({ id, error })) };
}

// The phase's plans without a SUMMARY, by id: what the owner's session executes. null without a single phase directory.
export function openPlans(root, phase) {
  const dir = findPhaseDir(root, phase);
  return dir ? phaseArtifacts(dir).plans.filter((p) => !p.hasSummary).map((p) => p.id) : null;
}

// spec §8 with §5.5: the checkpoints a stopped lane waits at become questions asked ahead again. Their agents belong
// to the lane session attend stopped, which the owner's session never reaches. An answer given at the stop stays and
// reaches the executor the owner's session dispatches as a pre-answer (turbo-run questions N --preanswers); an open
// one is asked ahead, its options rebuilt from the plan at the next refresh. A stop whose answer the stopped session
// already took (delivered) stays as it is: it is neither open nor a pre-answer, and nothing delivers it again.
// Returns the ids it released.
const released = (q) => q.stopped && q.state !== 'delivered';
export function releaseStops(root, phase) {
  return withPhaseLock(root, phase, () => {
    const list = readQuestions(root, phase);
    const ids = list.filter(released).map((q) => q.id);
    if (ids.length) writeQuestions(root, phase, list.map((q) => (released(q) ? { ...q, stopped: false, agentId: null } : q)));
    return ids;
  });
}
