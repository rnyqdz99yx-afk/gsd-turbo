import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { comparePhase } from './scheduler.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { dropLaneQuestions, readAnswers, readQuestions, refreshQuestions, withPhaseLock, writeAnswers, writeQuestions } from './questions.mjs';
import { STEPS, clearAttempts } from './phase-progress.mjs';
import { isAgentAlive } from './run-status.mjs';
import { NOT_RUNNING, SERVICE_GONE } from './claude.mjs';

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
// fails is tried again at the next list; what still fails at the end is reported. A session the stop found not running
// (lib/claude.mjs NOT_RUNNING, SERVICE_GONE: a record Claude Code's stopped background service left listed) is no late
// lane: neither reported nor stopped again while it is listed the same way (state and pid).
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
const listedAs = (a) => `${a.state}|${a.pid || 0}`;
export async function sweepLateLanes({ list, stop, isLane, settleMs = 5000, stepMs = 1000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const stopped = [];
  const idle = new Map();
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
      if (!isLane(a) || !isAgentAlive(a) || stopped.includes(a.id) || idle.get(a.id) === listedAs(a)) continue;
      try {
        const r = stop(a.id);
        if (r === NOT_RUNNING || r === SERVICE_GONE) idle.set(a.id, listedAs(a));
        else stopped.push(a.id);
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
// A stop the owner had answered before it came back keeps that answer (keptAnswer): the sitting takes it as a
// pre-answer, with its time, unless the stop's condition changed. Returns { ids (released), kept (ids whose answer was
// kept: a new live record in the answers file, which the caller commits) }.
// A lane's own question (turbo-run ask, v0.3.3) belongs to no agent: it stays as it is.
const released = (q) => q.stopped && q.state !== 'delivered' && q.source !== 'lane';
export function releaseStops(root, phase, { now = new Date() } = {}) {
  return withPhaseLock(root, phase, () => {
    const list = readQuestions(root, phase);
    const ids = list.filter(released).map((q) => q.id);
    const answers = readAnswers(root, phase);
    const kept = [];
    const next = list.map((q) => {
      if (!released(q)) return q;
      const free = { ...q, stopped: false, agentId: null };
      const r = q.state === 'open' ? keptAnswer(q, answers) : null;
      if (!r) return free;
      const { superseded: _s, supersededBy: _b, ...rest } = r;
      const record = { ...rest, keptAt: now.toISOString() };
      answers.push(record);
      kept.push(q.id);
      return { ...free, state: 'answered', answer: { option: record.option, label: record.label, answer: record.answer, by: record.by, at: record.at, conditional: record.conditional } };
    });
    if (kept.length) writeAnswers(root, phase, answers);
    if (ids.length) writeQuestions(root, phase, next);
    return { ids, kept };
  });
}

// The owner's last real answer to a stop that only came back (questions.mjs stopQuestion set it aside as 'stop': the
// agent returned the same checkpoint), or null when the stop's condition changed: the answer did not hold (unmet), the
// lane's diagnosis of a failed action reworded the card, the owner's newest word was a preference (defer), the plan
// changed the checkpoint, the answer is turbo's own (auto, the standing rule) or was taken back. A record from before
// supersededBy holds only when it is plain (no condition that could be unmet) and the card carries no diagnosis.
const OWNER_CHANNELS = new Set(['session', 'pane', 'telegram']);
function keptAnswer(q, answers) {
  const r = answers.findLast((x) => x.id === q.id);
  if (!r?.superseded || r.defer || r.undone || !OWNER_CHANNELS.has(r.by)) return null;
  if (r.cpHash && q.cpHash && r.cpHash !== q.cpHash) return null;
  if (r.supersededBy) return r.supersededBy === 'stop' ? r : null;
  return !r.conditional && !(q.diagnosis > 0) ? r : null;
}

// The owner's resume of phase N and attend N --done (spec §8, §9): the phase's run files a stop left go: its lane record
// and its owner request (the resume answers it), the attend mark, the bounded rounds' counts (a fresh budget; the steps
// done stay done) and its lane questions not yet delivered (the restarted step asks again); its questions are rebuilt
// from the plans in phaseRoot (its lane's slot, else root), before anything announces a released stop again. Returns
// { dropped } (the lane questions dropped); warn gets a line for what could not be done.
export function handBack(root, phase, { phaseRoot = root, lang = 'en', warn = () => {} } = {}) {
  fs.rmSync(path.join(runDir(root), `p${phase}.json`), { force: true });
  // the .notified mark stays: a checklist already sent is not sent again
  fs.rmSync(path.join(runDir(root), `p${phase}-owner.md`), { force: true });
  clearAttempts(root, phase);
  let dropped = [];
  try {
    dropped = dropLaneQuestions(root, phase);
  } catch (err) {
    warn(`the lane questions of phase ${phase} were not dropped (${errLine(err)})`);
  }
  if (openPlans(phaseRoot, phase) !== null) {
    try {
      refreshQuestions(phaseRoot, phase, { lang, warn });
    } catch (err) {
      warn(`the questions of phase ${phase} were not rebuilt (${errLine(err)}); the lane rebuilds them`);
    }
  }
  // last: while the mark stands a supervisor holds the lane, so a failure above never lets it step a stopped session
  clearAttend(root, phase);
  return { dropped };
}

// F5 (Stage 4 §9): a resume of phase N while a slots-mode supervisor runs is handed to it as run/p<N>-resume.json: the
// supervisor owns supervisor.json and the lanes' state, so it clears the phase itself between its lane steps (handBack)
// and relaunches that lane; neither it nor the other lanes stop. The file's existence is the request.
const RESUME_RE = /^p(.+)-resume\.json$/;
const resumeFile = (root, phase) => path.join(runDir(root), `p${phase}-resume.json`);
export const requestResume = (root, phase, { now = new Date() } = {}) => writeJsonAtomic(resumeFile(root, phase), { phase: String(phase), at: now.toISOString() });
// Removes the request; true when there was one.
export function clearResumeRequest(root, phase) {
  const had = fs.existsSync(resumeFile(root, phase));
  fs.rmSync(resumeFile(root, phase), { force: true });
  return had;
}
// The phases whose resume waits for the supervisor, in GSD's phase order; none when the run directory cannot be read.
export function resumeRequests(root) {
  try {
    return fs.readdirSync(runDir(root)).map((n) => RESUME_RE.exec(n)?.[1]).filter(Boolean).sort(comparePhase);
  } catch {
    return [];
  }
}
