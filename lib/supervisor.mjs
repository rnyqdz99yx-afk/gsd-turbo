import fs from 'node:fs';
import path from 'node:path';
import { annotationOf, comparePhase, inRange, isFinished, nextPhase, pickPhases, rangeBlocker, rangeLabel, relaunchDecision } from './scheduler.mjs';
import { inferStatus, isAgentAlive, readJobStatus, readLaneStatus, turnEnded, unknownAgentState, writeJobStatus, writeLaneStatus } from './run-status.mjs';
import { daemonAware, isDaemonDown, laneSessionName, parseResume } from './claude.mjs';
import { laneSystemPrompt, laneUserPrompt } from './lane-prompt.mjs';
import { writeJsonAtomic } from './fsx.mjs';
import { prepareLaneTmp, removeLaneTmp } from './lane-tmp.mjs';
import { pushTick } from './push.mjs';
import { askNamed, deliveryState, dropLaneQuestions } from './questions.mjs';
import { answerWakePrompt, inboxWakePrompt, stallWakePrompt } from './wake.mjs';
import { compareLanes, DONE_STATUSES, laneCwd, laneKey, recordKey } from './lanes-state.mjs';
import { heldGates, releaseGatesOf } from './gate-locks.mjs';
import { maxPrep } from './config.mjs';
import { maxLanes } from './slots.mjs';
import { stallMs } from './view.mjs';
import { MAX_STALL_WAKES, liveness } from './liveness.mjs';
import { ownerTick } from './owner-tick.mjs';
import { attendedPhases } from './attend.mjs';

const SUPERVISOR_LOG = '.planning/turbo/logs/supervisor.log';
// Consecutive failed launches before the supervisor halts: a --bg that keeps failing (or
// registers a session that dies at once) must never launch on every tick forever.
const MAX_LAUNCH_FAILURES = 10;
// Dead sessions of the lane removed before a launch; the cap keeps a tick inside the heartbeat window.
const MAX_DEAD_REMOVED = 3;
// claude --bg --resume attempts per wake: a copy is removed and the wake tried once more (spec §5.5.1 step 4).
const WAKE_ATTEMPTS = 2;
// Wakes for the same set of answers: a lane that stops again without delivering them is the owner's.
const ANSWER_WAKES = 2;
// Stall wakes in a row without a transcript write after them; then the owner is told once: MAX_STALL_WAKES
// (lib/liveness.mjs, where the view reads it too).
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
// claude --bg in a folder Claude Code does not trust yet fails at once; no retry can fix that.
const UNTRUSTED_RE = /workspace not trusted/i;
// The lane mode doctor chose when the daemon started: full runs /turbo-phase, anything else is safe.
const laneMode = (ctx) => (ctx.mode === 'full' ? 'full' : 'safe');
// A relaunched lane runs this supervisor's mode. An adopted live session may run either prompt: one
// an earlier supervisor launched (the lane's recorded mode) or one whose --bg call from this
// supervisor timed out after it registered (this supervisor's mode). It takes the stricter of the
// two: a full lane never ends on GSD's completion alone, while safe mode would end it early.
const relaunchMode = (lane, adopted, ctx) => (adopted && lane.mode === 'full' ? 'full' : laneMode(ctx));

// Real path when it exists (resolve() otherwise), forward slashes, case-insensitive on win32:
// the same normalization laneSessionName uses.
function dirKey(p) {
  let abs;
  try {
    abs = fs.realpathSync.native(p);
  } catch {
    abs = path.resolve(p);
  }
  const key = abs.replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

/// Sessions of a lane: its name AND started in its directory (this checkout, or its slot). An empty cwd never matches
// (it would resolve to the supervisor's own working directory).
function laneAgents(agents, name, cwd, exclude) {
  const home = dirKey(cwd);
  return agents.filter((a) => a.id !== exclude && a.name === name && Boolean(a.cwd) && dirKey(a.cwd) === home);
}

// Where a lane runs (Stage 4 L1): v0.3's lane (no slotPath) in this checkout under its phase; a slot lane in its slot,
// under its own key and job, with the control root in its session env (L0 D16).
export function placeOf(ctx, lane) {
  return {
    key: lane?.key ?? String(lane.phase),
    job: lane?.job || 'phase',
    phase: lane?.phase == null ? null : String(lane.phase),
    cwd: laneCwd(ctx.root, lane),
    controlRoot: lane?.slotPath ? ctx.root : null,
  };
}

// How logs and notifications name a lane: v0.3's words for a phase lane; a job by its key, its phase with its kind.
const lname = (lane) => (!lane.job || lane.job === 'phase' ? `phase ${lane.phase}` : `lane ${lane.key}`);
// reconcile R12: the annotate job is the pseudo-phase annotate, which the messages title «Lane markup»
const notePhase = (lane) => (!lane.job || lane.job === 'phase' ? lane.phase : lane.job === 'annotate' ? 'annotate' : `${lane.phase ?? '-'} (${lane.job})`);

// A job lane's prompts come from L3's job module (lib/prep.mjs jobPrompts, Interfaces for L2–L4).
function jobPromptsOf(ctx, place, { resume, wake, tmpDir = null }) {
  if (!ctx.deps.jobPrompts) throw new Error(`no prep/annotate support (lib/prep.mjs) for lane ${place.key}`);
  return ctx.deps.jobPrompts({ ctx, lane: { key: place.key, job: place.job, phase: place.phase, slotPath: place.cwd, ...(tmpDir ? { tmpDir } : {}) }, resume, wake });
}

// The prompt that wakes a lane's own conversation: v0.3's for a phase lane, the job module's for prep and annotate.
export function wakePrompt(ctx, lane, wake) {
  if (!lane.job || lane.job === 'phase') {
    if (wake.kind === 'inbox') return inboxWakePrompt({ phase: lane.phase, turboRun: ctx.turboRun, kind: wake.message });
    return wake.kind === 'answers'
      ? answerWakePrompt({ phase: lane.phase, turboRun: ctx.turboRun, ids: wake.ids, lane: wake.lane, mode: lane.mode === 'full' ? 'full' : 'safe' })
      : stallWakePrompt({ phase: lane.phase, turboRun: ctx.turboRun, mode: lane.mode, minutes: wake.minutes });
  }
  return jobPromptsOf(ctx, placeOf(ctx, lane), { resume: true, wake }).prompt;
}

const isFresh = (record, launchedAt) => Boolean(record && launchedAt && Date.parse(record.at) >= Date.parse(launchedAt));

const MIN_START_MS = Date.parse('2000-01-01T00:00:00Z');
// An adopted session's start time (ms number, digit string or ISO string) as ISO, or null
// unless it lies between 2000 and now: seconds since the epoch would make stale lane records
// count as fresh, and a future time would make the session's own records stale.
function startedAtIso(agent, at) {
  const v = agent?.startedAt;
  const text = typeof v === 'string' ? v.trim() : '';
  const ms = typeof v === 'number' ? v : /^\d+$/.test(text) ? Number(text) : text ? Date.parse(text) : NaN;
  return Number.isFinite(ms) && ms >= MIN_START_MS && ms <= Date.parse(at) ? new Date(ms).toISOString() : null;
}

// The answers no session took yet, for a new session's prompt: the checkpoints' (their agents are gone: the
// continuation path) and the lane's own questions (v0.3.3: the lane takes them itself).
function undelivered(root, phase) {
  const { ready } = deliveryState(root, phase, { ask: askNamed(readLaneStatus(root, phase)?.reason) });
  return { answered: ready.filter((q) => q.source !== 'lane').map((q) => q.id), laneAnswered: ready.filter((q) => q.source === 'lane').map((q) => q.id) };
}

// Adopts an alive session of this lane (for example one whose --bg call timed out after it
// registered) instead of launching a duplicate. Before a launch, removes dead sessions of this
// lane (a --bg that registers a session that dies at once would otherwise leave one per tick);
// `exclude` (the old session, already removed by the caller) is skipped. Throws when the
// launch fails, with the error marked launchFailed for failedTick's bound.
// Returns { sessionId, name, launchedAt, adopted }: an adopted session keeps its own start time when
// it is valid, so lane records it wrote before the adoption still count as fresh.
function startLane(phase, agents, ctx, { resume, exclude, at, place = placeOf(ctx, { phase: phase.number }) }) {
  const { root, config, turboRun, deps } = ctx;
  const name = laneSessionName(root, place.key);
  const what = place.job === 'phase' ? `phase ${place.phase}` : `lane ${place.key}`;
  const mine = laneAgents(agents, name, place.cwd, exclude);
  const alive = mine.find(isAgentAlive);
  if (alive) {
    deps.log(`adopt ${what} session ${alive.id}`);
    return { sessionId: alive.id, name, launchedAt: startedAtIso(alive, at) || at, adopted: true };
  }
  for (const dead of mine.filter((a) => !isAgentAlive(a)).slice(0, MAX_DEAD_REMOVED)) removeSession(ctx, dead.id);
  // A daemon whose lease was revoked mid-tick (stop, resume, another start) launches nothing: the
  // lease check after this tick ends it. Not a launch failure.
  if (deps.leaseHeld && !deps.leaseHeld()) throw Object.assign(new Error(`launch ${what} skipped: lease lost`), { leaseLost: true });
  // review 1: a fresh lane drops the phase's stale lane questions (its steps ask again)
  if (!resume && place.job === 'phase') {
    try {
      const dropped = dropLaneQuestions(root, place.phase);
      if (dropped.length) deps.log(`phase ${place.phase}: dropped its questions ${dropped.join(', ')} (the restarted step asks again)`);
    } catch (err) {
      deps.log(`phase ${place.phase}: its lane questions were not dropped: ${errLine(err)}`);
    }
  }
  let sessionId = null;
  try {
    // the session's TMP, TEMP and TMPDIR, emptied of what an earlier session of the lane left
    const tmpDir = prepareLaneTmp(root, place.key, deps.log);
    const prompts = place.job === 'phase'
      ? {
        prompt: laneUserPrompt({ phase: place.phase, resume, mode: ctx.mode, turboRun, ...(resume ? undelivered(root, place.phase) : {}) }),
        systemPrompt: laneSystemPrompt({ phase: place.phase, turboRun, contextPct: config.context_stop_pct, autonomy: config.autonomy, mode: ctx.mode, tmpDir, pushMode: config.push?.mode, slots: Boolean(place.controlRoot) }),
      }
      : jobPromptsOf(ctx, place, { resume, wake: null, tmpDir });
    sessionId = deps.claude.launchBg({
      name,
      prompt: prompts.prompt,
      systemPrompt: prompts.systemPrompt,
      permissionMode: config.lane_permission_mode,
      model: config.lane_model,
      tmpDir,
      ...(place.controlRoot ? { controlRoot: place.controlRoot } : {}),
    }, place.cwd);
    // Written only after a successful launch: a failed launch leaves the lane record
    // (paused-context, needs-owner) as it was, so the next tick reaches the same decision.
    writeLaneStatus(root, recordKey(place), 'running', { sessionId, at });
    deps.log(`launch ${what} session ${sessionId}${resume ? ' (resume)' : ''}`);
  } catch (err) {
    // Any error from the launch on counts toward MAX_LAUNCH_FAILURES: a session that starts but whose
    // lane record cannot be written would otherwise be launched again on every tick, unbounded.
    const fail = sessionId ? `session ${sessionId} started, then ${err.message}` : err.message;
    throw Object.assign(new Error(`launch ${what} failed: ${fail}`, { cause: err }), { launchFailed: true, phase: place.key });
  }
  return { sessionId, name, launchedAt: at, adopted: false };
}

// GSD marks a phase complete inside execute-phase (G9), before a full lane's fan-out runs the gates.
// A safe relaunch of such a lane (gsd-autonomous) would end at once on the completed phase and count
// as done, so the gates and the owner items would be lost. Until the lane's own fresh done record
// exists, a full lane on a completed phase is never relaunched or adopted by a safe-mode supervisor:
// the owner is told once and the lane waits, still recorded as full. Returns true while it waits.
async function holdDowngradedLane(lane, ctx, phase, record) {
  const doneRecord = record?.status === 'done' && isFresh(record, lane.launchedAt);
  if (lane.mode !== 'full' || laneMode(ctx) === 'full' || !phase.complete || doneRecord) return false;
  if (!lane.notified.downgraded) {
    ctx.deps.log(`phase ${lane.phase}: GSD completed it before turbo's gates finished and this supervisor runs in safe mode; waiting for the owner`);
    await ctx.deps.notify('laneDowngraded', { phase: lane.phase, turboRun: ctx.turboRun });
    lane.notified.downgraded = true;
  }
  return true;
}

// A lane that finished its turn stays listed as blocked, which counts as alive: it is removed before
// phaseDone and before the next lane starts, and a failed rm fails the tick, which the next tick retries.
async function finishLane(s, ctx, agent) {
  const { phase, sessionId } = s.lane;
  const alive = isAgentAlive(agent);
  if (alive) ctx.deps.claude.rm(sessionId);
  ctx.deps.log(`phase ${phase} done`);
  await ctx.deps.notify('phaseDone', { phase });
  if (!alive) removeSession(ctx, sessionId);
  // the session is gone now: its temp directory goes too (Claude Code's scratch files and GSD's hook
  // files may live there while it runs)
  try {
    removeLaneTmp(ctx.root, phase);
  } catch (err) {
    ctx.deps.log(`phase ${phase}: temp directory not removed: ${err.message}`);
  }
  s.lane = null;
}

// The scheduler skips closed phases that GSD reports unfinished (verification stale, for example):
// logged once per distinct set (the last one is kept in the state), never notified.
function logSkipped(s, phases, deps) {
  const skipped = phases.filter((x) => x.closed && !x.complete).sort((a, b) => comparePhase(a.number, b.number));
  const numbers = skipped.map((x) => x.number);
  if (numbers.join() === (s.skippedClosed || []).join()) return;
  if (!numbers.length) {
    delete s.skippedClosed;
    return;
  }
  const why = [...new Set(skipped.map((x) => x.verification || 'missing'))].join(', ');
  deps.log(`skipped phases ${numbers.join(', ')}: checked off in the roadmap, GSD reports them unfinished (verification ${why}); re-verify by hand with /gsd-execute-phase <N>`);
  s.skippedClosed = numbers;
}

function removeSession(ctx, id) {
  try {
    ctx.deps.claude.rm(id);
  } catch (err) {
    // the background service down: deps.claude logged it once; the next tick tries again
    if (!isDaemonDown(err)) ctx.deps.log(`rm session ${id} failed: ${err.message}`);
  }
}

// Whether a session may still run: listed and not ended (an unreadable list counts as running).
function mayRun(deps, id) {
  try {
    return isAgentAlive(deps.claude.list().find((a) => a.id === id));
  } catch {
    return true;
  }
}

// One wake of the lane's own conversation (spec §5.5.1, the §9 spikes): claude stop <job id>, then claude --bg
// --resume <session id> <prompt> without any other flag. A session that may still run after a failed claude stop is
// never resumed: that only starts a copy (F4). A copy cannot reach the old subagents: it is stopped and removed, and
// the wake is tried once more. Output that is neither a wake nor a copy, or an error, is a failed attempt. Returns
// { woke, why }: why is the last failure. Claude Code's background service may have idle-exited while the lane waited
// (its job listed blocked or done, no pid): claude stop then counts as done (NOT_RUNNING), and the same session is
// resumed inside a kick that holds the service up (lib/claude.mjs daemonAware). A service that stays down returns { daemonDown: true } at once: no attempt counted.
function wakeSession(ctx, lane, prompt) {
  const { deps } = ctx;
  const cwd = laneCwd(ctx.root, lane);
  // the transcript's session id from the job state, read while the lane is idle (§5.5.1 step 5); else the job id
  const target = deps.lanes?.session(lane.sessionId, cwd) || lane.sessionId;
  let why = '';
  for (let attempt = 1; attempt <= WAKE_ATTEMPTS; attempt++) {
    try {
      // a job the stopped service no longer runs counts as stopped; deps.claude kicks the service up for the resume
      deps.claude.stop(lane.sessionId);
    } catch (err) {
      if (isDaemonDown(err)) return { woke: false, why: errLine(err), daemonDown: true };
      deps.log(`wake ${lname(lane)}: stop ${lane.sessionId}: ${errLine(err)}`);
      if (mayRun(deps, lane.sessionId)) {
        why = errLine(err);
        deps.log(`wake ${lname(lane)} attempt ${attempt}: session ${lane.sessionId} may still run; not resumed (that would only start a copy)`);
        continue;
      }
    }
    let r;
    try {
      r = parseResume(deps.claude.resume(target, prompt, cwd), { jobId: lane.sessionId, sessionId: target });
    } catch (err) {
      if (isDaemonDown(err)) return { woke: false, why: errLine(err), daemonDown: true };
      why = errLine(err);
      deps.log(`wake ${lname(lane)} attempt ${attempt}: ${why}`);
      continue;
    }
    if (r.woke) {
      deps.log(`wake ${lname(lane)}: woke session ${lane.sessionId}`);
      return { woke: true, why: '' };
    }
    if (!r.copyId) {
      why = 'claude reported neither a wake nor a copy';
      deps.log(`wake ${lname(lane)} attempt ${attempt}: ${why}`);
      continue;
    }
    why = `claude started a copy ${r.copyId}`;
    deps.log(`wake ${lname(lane)} attempt ${attempt}: started a copy ${r.copyId}; stopped and removed`);
    for (const f of ['stop', 'rm']) {
      try {
        deps.claude[f](r.copyId);
      } catch (err) {
        deps.log(`${f} copy ${r.copyId}: ${errLine(err)}`);
      }
    }
  }
  return { woke: false, why };
}

// The session did not wake: it goes, and a new one starts (spec §5.5.1 step 4, path continuation). startLane puts
// the undelivered answers into its prompt; the skill delivers them by the continuation path. The guards of every
// other relaunch hold here too: a full lane on a phase GSD completed waits under a safe-mode supervisor
// (holdDowngradedLane: 'held'), and no session starts next to one that may still run: when claude rm cannot remove
// it, the lane keeps it ('kept') and the caller counts the try; when the background service stays down, 'daemon-down'
// (nothing counted, the next tick tries again). Returns 'relaunched', 'held', 'kept' or 'daemon-down'; a failed launch
// throws, as every launch does.
async function relaunchAfterFailedWake(ctx, lane, phase, at) {
  const { deps, root } = ctx;
  if (await holdDowngradedLane(lane, ctx, phase, readLaneStatus(root, recordKey(lane)))) return 'held';
  deps.log(`wake ${lname(lane)}: the session did not wake; starting a new session (continuation path)`);
  // a session still listed, in any state (claude agents may report a live one as ended), goes first and its rm must
  // succeed; an unlisted one is gone already; an unreadable list counts as listed
  let listed = true;
  try {
    listed = deps.claude.list().some((a) => a.id === lane.sessionId);
  } catch { /* unknown: remove it */ }
  if (listed) {
    try {
      deps.claude.rm(lane.sessionId);
    } catch (err) {
      if (isDaemonDown(err)) return 'daemon-down';
      deps.log(`wake ${lname(lane)}: session ${lane.sessionId} was not removed (${errLine(err)}) and may still run; no new session next to it`);
      return 'kept';
    }
  }
  // listed again: the copies just removed must not be adopted
  const { adopted, ...started } = startLane(phase, deps.claude.list(), ctx, { resume: true, exclude: lane.sessionId, at, place: placeOf(ctx, lane) });
  Object.assign(lane, started, { notified: {}, blockedSince: null, mode: relaunchMode(lane, adopted, ctx) });
  return 'relaunched';
}

// The relaunch after a failed wake; a failure that fails the tick keeps this tick's count of tries (laneKeep, applied
// by failedTick), so the bounds of D13 hold across failing ticks too.
async function relaunchCounted(ctx, lane, phase, at, keep) {
  try {
    return await relaunchAfterFailedWake(ctx, lane, phase, at);
  } catch (err) {
    throw Object.assign(err, { laneKeep: keep(errLine(err)) });
  }
}

// The lane question the lane's fresh needs-owner record names, or null (review 1: no other lane question counts).
function currentAsk(root, lane) {
  const record = readLaneStatus(root, recordKey(lane));
  return record?.status === 'needs-owner' && isFresh(record, lane.launchedAt) ? askNamed(record.reason) : null;
}

// spec §5.5.1: every question the lane stopped for has an answer → its own conversation goes on. Returns true when
// it tried this tick (woke the lane, started a new session for it, or counted a failed try). After ANSWER_WAKES tries
// for the same answers it stops; when the last try did not reach a session, the owner is told once.
async function wakeForAnswers(ctx, lane, phase, at) {
  const { deps, root } = ctx;
  if (!deps.claude.resume) return false;
  const { waiting, ready } = deliveryState(root, recordKey(lane), { ask: currentAsk(root, lane) });
  if (waiting.length || !ready.length) return false;
  const ids = ready.map((q) => q.id);
  // the same answers: each question's revision and the time of its answer (a checkpoint that stopped again and got a
  // new answer is a new set, D13)
  const key = ready.map((q) => `${q.id}:${q.rev || 1}:${q.answer?.at ?? ''}`).join(',');
  const count = lane.woken?.key === key ? lane.woken.count : 0;
  if (count >= ANSWER_WAKES) {
    if (lane.woken.failed && !lane.woken.told) {
      deps.log(`${lname(lane)}: the answers to ${ids.join(', ')} did not reach session ${lane.sessionId} in ${count} tries; waiting for the owner`);
      await deps.notify('laneNeedsOwner', { phase: notePhase(lane), reason: `the answers to ${ids.join(', ')} did not reach session ${lane.sessionId} (${lane.woken.failed})` });
      lane.woken.told = true;
    }
    return false;
  }
  // the background service down (logged once by deps.claude): the try is undone and made again at the next tick
  const before = lane.woken;
  if (!deps.claude.isDown?.()) deps.log(`${lname(lane)}: the owner answered ${ids.join(', ')}; waking session ${lane.sessionId}`);
  lane.woken = { key, count: count + 1, at };
  // v0.3.3 (D4): a question the lane asked itself goes to the lane, named with the chosen option
  const own = ready.filter((q) => q.source === 'lane').map((q) => ({ id: q.id, option: q.answer?.option ?? null, label: q.answer?.label ?? null }));
  const cps = ready.filter((q) => q.source !== 'lane').map((q) => q.id);
  const w = wakeSession(ctx, lane, wakePrompt(ctx, lane, { kind: 'answers', ids: cps, lane: own }));
  const undo = () => {
    if (before === undefined) delete lane.woken;
    else lane.woken = before;
    return true;
  };
  if (w.daemonDown) return undo();
  if (w.woke) {
    // its needs-owner record is older than this: it no longer counts
    Object.assign(lane, { launchedAt: at, notified: {}, blockedSince: null });
    return true;
  }
  const outcome = await relaunchCounted(ctx, lane, phase, at, (why) => ({ woken: { ...lane.woken, failed: why } }));
  if (outcome === 'daemon-down') return undo();
  if (outcome === 'kept') lane.woken.failed = w.why || 'the session could not be stopped or removed';
  return true;
}

// Whether the lane session answered since a time (the probe reads its transcript); no answer when it cannot tell.
function replied(ctx, lane, sinceMs) {
  try {
    return Boolean(ctx.deps.lanes.replied?.(lane.sessionId, sinceMs, laneCwd(ctx.root, lane)));
  } catch (err) {
    ctx.deps.log(`${lname(lane)}: reply check failed: ${errLine(err)}`);
    return false;
  }
}

// spec §5.5.6: a lane alive (or with its turn ended and no record) that is silent by liveness.mjs is woken with the
// interruption prompt: it wrote nothing, neither its transcript nor its subagents', for stall_minutes, or a command in
// its tree ran past its timeout and nothing was written since. A lane with a command in flight within its timeout is
// busy, never woken: a wake stops the session and would end the command. Returns 'woken', or the lane's activity
// { lastMs, active, calls }, with busy (the command in flight) while one runs; null without a probe. No transcript found
// is no proof of a stall.
async function checkStall(ctx, lane, phase, now, at) {
  const { deps } = ctx;
  // a full lane under a safe-mode supervisor waits for the owner (holdDowngradedLane), never for a wake
  if (!deps.lanes || !deps.claude.resume || (lane.mode === 'full' && laneMode(ctx) !== 'full')) return null;
  const stall = stallMs(ctx.config);
  let live;
  try {
    live = deps.lanes.activity(lane.sessionId, now, stall, laneCwd(ctx.root, lane));
  } catch (err) {
    deps.log(`${lname(lane)}: activity check failed: ${errLine(err)}`);
    return null;
  }
  if (!live || live.lastMs === null) return live;
  const wokenAt = Date.parse(lane.stall?.at);
  // D13: progress after a wake is what the woken session did itself, an answer of its own; the wake prompt it records
  // (and what claude stop writes) moves the transcript's time too, so a write alone is no progress
  if (Number.isFinite(wokenAt) && live.lastMs > wokenAt && replied(ctx, lane, wokenAt)) {
    lane.stall = null;
    lane.notified.stalled = false;
  }
  const floorMs = Math.max(Date.parse(lane.launchedAt) || 0, lane.stall && Number.isFinite(wokenAt) ? wokenAt : 0);
  const state = liveness({ lastMs: live.lastMs, calls: live.calls, nowMs: Number(now), stallMs: stall, floorMs });
  if (state.state === 'busy') return { ...live, busy: state.call };
  if (live.active || state.state !== 'silent') return live;
  const minutes = Math.floor((now - live.lastMs) / 60000);
  const why = state.call ? `a ${state.call.tool} command ran past its time limit and nothing was written for ${minutes} min` : `no transcript write for ${minutes} min`;
  const count = lane.stall?.count || 0;
  if (count >= MAX_STALL_WAKES) {
    if (!lane.notified.stalled) {
      deps.log(`${lname(lane)}: ${why}, also after ${count} wakes`);
      await deps.notify('laneStalled', { phase: notePhase(lane), minutes, wakes: count, id: lane.sessionId });
      lane.notified.stalled = true;
    }
    return live;
  }
  if (!deps.claude.isDown?.()) deps.log(`${lname(lane)}: ${why}; waking session ${lane.sessionId}`);
  const before = lane.stall;
  lane.stall = { count: count + 1, at };
  const w = wakeSession(ctx, lane, wakePrompt(ctx, lane, { kind: 'stall', minutes }));
  const outcome = w.daemonDown ? 'daemon-down' : w.woke ? 'woke' : await relaunchCounted(ctx, lane, phase, at, () => ({ stall: lane.stall }));
  // the background service down: no wake counted, the next tick tries again
  if (outcome === 'daemon-down') {
    lane.stall = before ?? null;
    return 'woken';
  }
  if (outcome === 'woke') Object.assign(lane, { notified: {}, blockedSince: null });
  // what the view tells the owner turbo did: a new session started in place of one that did not wake, or a session
  // it could neither wake nor replace (kept: it may still run)
  if (outcome === 'relaunched') lane.stall.relaunched = true;
  if (outcome === 'kept') lane.stall.missed = true;
  return 'woken';
}

/// The part of a lane's step both modes share (spec §5.5): stall wakes, a blocked lane's wait, the owner's answers.
// true when it handled the status (running, blocked, needs-owner); done, paused-context and failed are the caller's.
async function sharedStatus(ctx, lane, phase, record, status, agent, now, at) {
  const { config, deps } = ctx;
  // spec §5.5.6: alive but silent for stall_minutes → woken; a turn that ended while subagents still work waits for
  // them. A blocked lane under a safe-mode supervisor, or one that runs gsd-autonomous, waits for the owner as before
  // (laneBlocked) and is never stall-woken: there a turn that ended is gsd-autonomous asking in its text.
  const ownersBlock = status === 'blocked' && (laneMode(ctx) !== 'full' || lane.mode !== 'full');
  if ((status === 'running' || status === 'blocked') && !ownersBlock) {
    const live = await checkStall(ctx, lane, phase, now, at);
    if (live === 'woken') return true;
    if (status === 'blocked' && (live?.active || live?.busy)) {
      lane.blockedSince = null;
      lane.notified.blocked = false;
      return true;
    }
  }
  if (status === 'running') {
    lane.blockedSince = null;
    lane.notified.blocked = false;
    return true;
  }
  if (status === 'blocked') {
    // a full lane that finished its turn on a phase GSD completed waits for full mode, never as a generic block
    if (turnEnded(agent) && await holdDowngradedLane(lane, ctx, phase, record)) return true;
    lane.blockedSince ||= at;
    const waited = (now - Date.parse(lane.blockedSince)) / 60000;
    if (waited >= config.blocked_minutes_before_notify && !lane.notified.blocked) {
      deps.log(`${lname(lane)} blocked for ${Math.floor(waited)} min`);
      await deps.notify('laneBlocked', { phase: notePhase(lane), id: lane.sessionId });
      lane.notified.blocked = true;
    }
    return true;
  }
  if (status === 'needs-owner') {
    // spec §5.5.1: the owner's answers are in → the same conversation goes on
    if (await wakeForAnswers(ctx, lane, phase, at)) return true;
    if (!lane.notified.owner) {
      // v0.3.3 (D3): a question the lane asked (turbo-run ask) reaches the owner as its plain question (owner-tick's
      // questionsReady, the pane's card, Telegram): no second notification with the lane's reason
      const asked = deliveryState(ctx.root, recordKey(lane), { ask: currentAsk(ctx.root, lane) }).waiting.filter((q) => q.source === 'lane').map((q) => q.id);
      if (asked.length) deps.log(`${lname(lane)} needs the owner: question ${asked.join(', ')} waits for the answer`);
      else {
        deps.log(`${lname(lane)} needs the owner`);
        const own = record?.status === 'needs-owner' && record.reason && isFresh(record, lane.launchedAt);
        await deps.notify('laneNeedsOwner', { phase: notePhase(lane), reason: own ? record.reason : 'human verification' });
      }
      lane.notified.owner = true;
    }
    return true;
  }
  return false;
}

// Gap 2 (v0.4.0): the first tick of a supervisor that takes a run over (turbo-run daemon sets s.takeover; tick clears
// it after its first successful step) finds the session of a lane ended (failed, stopped, done) or gone: a reboot or a
// crash took it down with the supervisor before, or the run halted on it. No supervisor watched it end, so it is no
// failure of the lane: it is relaunched as a continuation, as the owner's resume N --start does (forceRelaunch, its
// restarts counted afresh). A lane that recorded its own state since its
// launch (asked the owner, paused, failed, ready, done), a session that lives, and a phase GSD completed under a
// safe-mode lane keep their usual handling. Returns true when the lane is armed.
function takeOver(ctx, lane, agent, phase) {
  if (!lane.sessionId || lane.forceRelaunch || lane.halted) return false;
  if (isAgentAlive(agent)) return false;
  const record = readLaneStatus(ctx.root, recordKey(lane));
  if (isFresh(record, lane.launchedAt) && record.status !== 'running') return false;
  const status = inferStatus({ agent, laneRecord: record, launchedAt: lane.launchedAt, phase, mode: ctx.lanes === 'slots' ? 'full' : lane.mode || 'safe' });
  if (status !== 'failed' && status !== 'paused-context') return false;
  const ended = !agent ? 'is gone' : agent.state === 'failed' ? 'failed' : `ended (${agent.state || 'no state'})`;
  ctx.deps.log(`${lname(lane)}: session ${lane.sessionId} ${ended} before this supervisor started (a reboot, a crash or a halt); relaunching it (continuation)`);
  Object.assign(lane, { forceRelaunch: true, restarts: 0, notified: {} });
  return true;
}

/// No lane runs and none can start: an empty roadmap or range, a finished run, a dependency outside the range, or a
// dependency cycle. Shared by both modes.
async function runEnd(s, phases, scoped, range, deps) {
  if (!scoped.length) {
    // an empty list is a broken or empty roadmap, never a finished milestone; nor is an empty range a finished run
    if (!s.noPhases) deps.log(phases.length ? `no phase of the milestone is in the range ${rangeLabel(range)}; waiting` : 'no phases in the current milestone; waiting');
    s.noPhases = true;
  } else if (scoped.every(isFinished)) {
    if (range) {
      deps.log(`phases ${rangeLabel(range)} done`);
      await deps.notify('rangeDone', { range: rangeLabel(range) });
    } else {
      deps.log('milestone done');
      await deps.notify('milestoneDone', {});
    }
    s.finished = true;
  } else if (rangeBlocker(phases, range)) {
    // only the owner can change the range or finish the phase outside it
    const { phase, dep } = rangeBlocker(phases, range);
    deps.log(`phases ${rangeLabel(range)} wait: phase ${phase} depends on phase ${dep} outside the range, which is not finished; halted`);
    await deps.notify('rangeBlocked', { range: rangeLabel(range), phase, dep });
    s.halted = true;
  } else if (!s.noReady) {
    // every unfinished phase waits on another unfinished one: a dependency cycle
    const waiting = scoped.filter((x) => !isFinished(x)).map((x) => x.number);
    deps.log(`no ready phase: ${waiting.join(', ')} wait on each other; waiting for the roadmap to change`);
    await deps.notify('noReadyPhase', { phases: waiting.slice(0, 10).join(', ') });
    s.noReady = true;
  }
}

// The unfinished phases of the run's scope (its range, else the milestone), in phase order, the running ones included:
// the view ends the chain of the last one with the end of the run (supervisor.json remaining).
const remainingOf = (phases, range) => phases.filter((x) => inRange(x.number, range || null) && !isFinished(x)).map((x) => String(x.number)).sort(comparePhase);

// One supervisor step; mutates s. Throws on any failure, and tick then keeps the previous state.
async function step(s, ctx, now) {
  // Stage 4 L1 (D1): slots mode runs several lanes from supervisor.json lanes; checkout mode is v0.3, below
  if (ctx.lanes === 'slots') return stepSlots(s, ctx, now);
  const { root, config, deps } = ctx;
  const at = now.toISOString();
  // spec §8 (S4): while the owner attends a phase in their own session (turbo-run attend N), that session is the only
  // writer in this checkout: no lane of that phase or any other starts, relaunches, wakes or is notified until
  // turbo-run attend N --done or resume N clears the mark. Logged once per set of marks.
  const attended = attendedPhases(root).map((a) => a.phase).join(', ');
  if (attended) {
    if (s.attendWait !== attended) deps.log(`attended in the owner's session: phase ${attended}; no lane starts, relaunches or wakes until turbo-run attend <phase> --done`);
    s.attendWait = attended;
    return;
  }
  delete s.attendWait;
  const phases = deps.loadPhases();
  s.remaining = remainingOf(phases, s.range);
  const agents = deps.claude.list();

  if (!s.lane) {
    const range = s.range || null;
    // what the scheduler looks at: the run's range, or the whole milestone without one
    const scoped = phases.filter((x) => inRange(x.number, range));
    if (scoped.length) delete s.noPhases;
    logSkipped(s, scoped, deps);
    const p = nextPhase(phases, { range });
    if (!p) {
      await runEnd(s, phases, scoped, range, deps);
      return;
    }
    delete s.noReady;
    const fingerprint = deps.fingerprint(p);
    const { adopted, ...started } = startLane(p, agents, ctx, { resume: false, exclude: null, at });
    s.lane = { phase: p.number, ...started, mode: laneMode(ctx), restarts: 0, fingerprint, notified: {}, blockedSince: null };
    return;
  }

  const lane = s.lane;
  lane.notified ??= {};
  const listed = phases.find((x) => x.number === lane.phase);
  const phase = listed || { number: lane.phase, complete: false, verification: null };
  // By id only: an unlisted session counts as ended, and the relaunch below adopts an already
  // registered session of this lane with full accounting (restarts, launchedAt, notified).
  const agent = agents.find((a) => a.id === lane.sessionId);
  if (s.takeover && listed) takeOver(ctx, lane, agent, phase);
  if (lane.forceRelaunch) {
    const record = readLaneStatus(root, lane.phase);
    // resume removed the lane record: a fresh done record on a completed phase (the owner ran the
    // remaining steps and recorded it, or the lane did) leaves nothing to relaunch
    if (phase.complete && record?.status === 'done' && isFresh(record, lane.launchedAt)) return finishLane(s, ctx, agent);
    if (await holdDowngradedLane(lane, ctx, phase, record)) return;
    const fingerprint = deps.fingerprint(phase);
    // a still-listed (usually blocked) old session must be gone first; a failed rm fails the tick and keeps the resume
    if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
    else removeSession(ctx, lane.sessionId);
    const { adopted, ...started } = startLane(phase, agents, ctx, { resume: true, exclude: lane.sessionId, at });
    Object.assign(lane, started, { restarts: 0, fingerprint, notified: {}, blockedSince: null, forceRelaunch: false, mode: relaunchMode(lane, adopted, ctx) });
    return;
  }

  if (!listed && turnEnded(agent)) {
    // Relaunching a phase GSD no longer lists would loop; the lane is cleared so that a
    // restart goes on with the next ready phase. The ended (or finished, listed blocked)
    // session is kept for inspection.
    deps.log(`phase ${lane.phase} is no longer in the roadmap and session ${lane.sessionId} has ended; halted`);
    await deps.notify('phaseMissing', { phase: lane.phase, id: lane.sessionId });
    s.lane = null;
    s.halted = true;
    return;
  }
  const record = readLaneStatus(root, lane.phase);
  const status = inferStatus({ agent, laneRecord: record, launchedAt: lane.launchedAt, phase, mode: lane.mode || 'safe' });
  const unknown = unknownAgentState(agent);
  if (unknown && lane.notified.unknownState !== unknown) {
    deps.log(`phase ${lane.phase} session ${lane.sessionId} reports unknown state ${JSON.stringify(unknown.slice(0, 40))}; waiting`);
    lane.notified.unknownState = unknown;
  }

  if (await sharedStatus(ctx, lane, phase, record, status, agent, now, at)) return;
  if (status === 'done') return finishLane(s, ctx, agent);
  if (status === 'paused-context') {
    if (await holdDowngradedLane(lane, ctx, phase, record)) return;
    const fp = deps.fingerprint(phase);
    const d = relaunchDecision({ restarts: lane.restarts, progressed: fp !== lane.fingerprint, maxRestarts: config.max_restarts_without_progress });
    if (d.action === 'halt') {
      deps.log(`phase ${lane.phase} halted: no progress after ${lane.restarts} restarts`);
      await deps.notify('laneHalted', { phase: lane.phase, restarts: lane.restarts, log: SUPERVISOR_LOG });
      s.halted = true;
      return;
    }
    // A blocked session that wrote paused-context is still alive: two sessions must never work in one
    // checkout, so its rm must succeed (a failure fails the tick, which the next tick retries).
    if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
    else removeSession(ctx, lane.sessionId);
    const { adopted, ...started } = startLane(phase, agents, ctx, { resume: true, exclude: lane.sessionId, at });
    Object.assign(lane, started, { restarts: d.restarts, fingerprint: fp, notified: {}, blockedSince: null, mode: relaunchMode(lane, adopted, ctx) });
    return;
  }
  deps.log(`phase ${lane.phase} failed: session ${lane.sessionId}`);
  await deps.notify('laneFailed', { phase: lane.phase, id: lane.sessionId });
  s.halted = true;
  // the session failed, not the lane by its own record: a start at logon takes the run up again (lib/autostart.mjs)
  if (!(isFresh(record, lane.launchedAt) && record.status === 'failed')) s.haltedFor = 'sessionFailed';
}

/// ---- Stage 4 L1: slots mode (spec §5, §8, §9) ----

// spec §9 (D6): a phase lane that cannot go on stops alone; its slot keeps the work (the job stays active), its phase,
// areas and gates stay taken until the owner's resume N (or a new start) tries it again. The other lanes go on.
async function haltLane(ctx, lane, why, at, extra = {}) {
  if (lane.halted) return;
  lane.halted = { why, at, ...extra };
  ctx.deps.log(`${lname(lane)} stopped (${why}${extra.error ? `: ${extra.error}` : ''}); the other lanes go on`);
  await ctx.deps.notify('laneStopped', { phase: lane.phase, why, slot: lane.slotPath, error: extra.error || '' });
}

// The one way a slot lane that cannot go on stops: a phase lane halts alone (D6); a job fails, its slot released.
async function stopLane(s, ctx, lane, agent, why, at, extra = {}) {
  if (lane.job !== 'phase') return failJob(s, ctx, lane, agent, why, at);
  return haltLane(ctx, lane, why, at, extra);
}

// A slot lane that ended (merged by L2 or L3, or a job that failed): its session goes (the rm of a live one must
// succeed), then its temp directory and its gate locks; the entry goes last. Its slot was released by whoever merged.
async function dropLane(s, ctx, lane, agent, { done = false } = {}) {
  const { deps, root } = ctx;
  if (lane.sessionId) {
    if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
    else removeSession(ctx, lane.sessionId);
  }
  if (done) {
    deps.log(`phase ${lane.phase} done`);
    await deps.notify('phaseDone', { phase: lane.phase });
  }
  try {
    removeLaneTmp(root, lane.key);
  } catch (err) {
    deps.log(`${lname(lane)}: temp directory not removed: ${errLine(err)}`);
  }
  if (lane.job === 'phase') {
    try {
      const freed = releaseGatesOf(root, lane.phase);
      if (freed.length) deps.log(`phase ${lane.phase}: released ${freed.join(', ')}`);
    } catch (err) {
      deps.log(`phase ${lane.phase}: gate locks not released: ${errLine(err)}`);
    }
  }
  delete s.lanes[lane.key];
}

// D6: a prep or annotate job that cannot go on: its slot is released as failed (L0 releaseSlot). One rule for every
// failed job (L3 D12): its record says failed, as a session-recorded failure does, so no later start queues it again
// (pendingJobs skips a failed record; the phase's lane redoes the prep work); jobsFailed keeps it out of this run.
async function failJob(s, ctx, lane, agent, why, at) {
  ctx.deps.log(`lane ${lane.key} failed (${why}); slot ${lane.slot} released, the job is not queued again`);
  (s.jobsFailed ??= {})[lane.key] = { why, at };
  const job = { kind: lane.job, phase: lane.phase ?? null };
  try {
    if (readJobStatus(ctx.root, job)?.status !== 'failed') writeJobStatus(ctx.root, job, 'failed', { reason: why, at });
  } catch (err) {
    ctx.deps.log(`lane ${lane.key}: its failed record was not written: ${errLine(err)}`);
  }
  ctx.deps.slots.release(lane.slot, 'failed');
  await dropLane(s, ctx, lane, agent);
}

// spec §7.2 through L2 (mergeReady): the phase lane recorded ready (or done) and its turn ended.
async function mergeStep(s, ctx, lane, agent, at) {
  const { deps } = ctx;
  if (!deps.mergeReady) {
    if (lane.mergeWait !== 'unavailable') deps.log(`phase ${lane.phase} is ready, but this turbo has no merge (lib/merge.mjs); waiting`);
    lane.mergeWait = 'unavailable';
    return;
  }
  const r = await deps.mergeReady(ctx, lane);
  // reconcile R5: merged into main and phase.complete committed; the slot stays held and the entry stays until
  // mergeFollowUp releases it (push and CI)
  if (r?.outcome === 'merged') {
    delete lane.mergeWait;
    deps.log(`phase ${lane.phase}: merged into main${r.sha ? ` at ${String(r.sha).slice(0, 12)}` : ''}; the slot is released after push and CI`);
    return;
  }
  // reconcile R5: reintegrate carries no prompt; L2 put the message into the lane's inbox and counts the rounds
  if (r?.outcome === 'reintegrate') {
    deps.log(`phase ${lane.phase}: integrate again${r.reason ? ` (${r.reason})` : ''}; waking session ${lane.sessionId}`);
    delete lane.mergeWait;
    return wakeForInbox(ctx, lane, 'reintegrate', at);
  }
  if (r?.outcome === 'needs-owner') {
    if (!lane.notified.merge) {
      deps.log(`phase ${lane.phase}: the merge waits for the owner: ${r.reason || ''}`);
      await deps.notify('laneNeedsOwner', { phase: lane.phase, reason: r.reason || 'the merge needs you' });
      lane.notified.merge = true;
    }
    return;
  }
  if (r?.outcome === 'wait') {
    const why = r.reason || 'waiting';
    if (lane.mergeWait !== why) deps.log(`phase ${lane.phase}: merge waits: ${why}`);
    lane.mergeWait = why;
    return;
  }
  throw new Error(`the merge of phase ${lane.phase} returned an unknown outcome ${JSON.stringify(r?.outcome)}`);
}

// Wakes the lane's own session to read its inbox (L2's reintegrate or ci-red); a session that does not wake is
// replaced by a new resumed one, which reads its inbox at its next step.
async function wakeForInbox(ctx, lane, message, at) {
  // review I1: L2 says reintegrate and ci-red once; the wake stays due (lane.inboxWake) until a session takes it
  lane.inboxWake = message;
  const w = wakeSession(ctx, lane, wakePrompt(ctx, lane, { kind: 'inbox', message }));
  if (w.woke) {
    // its ready record is older than this wake: it no longer counts
    Object.assign(lane, { launchedAt: at, notified: {}, blockedSince: null });
    delete lane.inboxWake;
    return;
  }
  const outcome = await relaunchCounted(ctx, lane, { number: lane.phase, complete: false, verification: null }, at, () => ({ inboxWake: message }));
  if (outcome === 'relaunched') delete lane.inboxWake;
}

// Reconcile R5: §7.2 p.6–7 through L2 (mergeFollowUp) while the phase's merge state is merged: push and CI, then the
// release. Returns true when this tick is done with the lane (released and dropped, or woken).
async function followUpStep(s, ctx, lane, agent, at) {
  const { deps } = ctx;
  const r = await deps.mergeFollowUp(ctx, lane);
  if (r?.outcome === 'released') {
    // L2 released the slot, marked integrate done and wrote the lane record done
    await dropLane(s, ctx, lane, agent, { done: true });
    return true;
  }
  if (r?.outcome === 'ci-red') {
    deps.log(`phase ${lane.phase}: CI is red after the merge${r.sha ? ` (${String(r.sha).slice(0, 12)})` : ''}; waking session ${lane.sessionId}`);
    await wakeForInbox(ctx, lane, 'ci-red', at);
    return true;
  }
  if (r?.outcome === 'needs-owner') {
    const why = r.reason || 'the push or CI of the merge needs you';
    if (lane.notified.followUp !== why) {
      // a refused or diverged push or a CI timeout: the push work told the owner already (r.notified); one notification
      if (r.notified) deps.log(`phase ${lane.phase}: after the merge, waiting for the owner: ${why} (the push work told the owner)`);
      else {
        deps.log(`phase ${lane.phase}: after the merge, waiting for the owner: ${why}`);
        await deps.notify('laneNeedsOwner', { phase: lane.phase, reason: why });
      }
      lane.notified.followUp = why;
    }
    // review I7: L2 wrote the lane record needs-owner; the lane's own status must not tell the owner again
    return true;
  }
  if (r?.outcome === 'wait') return false;
  throw new Error(`the merge follow-up of phase ${lane.phase} returned an unknown outcome ${JSON.stringify(r?.outcome)}`);
}

// spec §6.1, §6.2 through L3 (finishJob): a prep or annotate job recorded its end and its turn ended.
async function finishJobStep(s, ctx, lane, agent, at) {
  const { deps } = ctx;
  if (!deps.finishJob) {
    if (lane.jobWait !== 'unavailable') deps.log(`lane ${lane.key} is done, but this turbo has no job module (lib/prep.mjs); waiting`);
    lane.jobWait = 'unavailable';
    return;
  }
  const r = await deps.finishJob(ctx, lane);
  if (r?.outcome === 'merged') {
    deps.log(`lane ${lane.key} merged`);
    return dropLane(s, ctx, lane, agent);
  }
  if (r?.outcome === 'failed') {
    const why = r.reason || 'refused';
    deps.log(`lane ${lane.key} failed: ${why}`);
    (s.jobsFailed ??= {})[lane.key] = { why, at };
    return dropLane(s, ctx, lane, agent);
  }
  if (r?.outcome === 'needs-owner') {
    if (!lane.notified.job) {
      deps.log(`lane ${lane.key} waits for the owner: ${r.reason || ''}`);
      await deps.notify('laneNeedsOwner', { phase: notePhase(lane), reason: r.reason || 'the job needs you' });
      lane.notified.job = true;
    }
    return;
  }
  if (r?.outcome === 'wait') {
    const why = r.reason || 'waiting';
    if (lane.jobWait !== why) deps.log(`lane ${lane.key} waits: ${why}`);
    lane.jobWait = why;
    return;
  }
  throw new Error(`the job module returned an unknown outcome ${JSON.stringify(r?.outcome)} for lane ${lane.key}`);
}

// spec §8 (D11): the owner runs this phase in its slot. A session of its lane that still runs (a launch or a wake of an
// earlier tick that registered after attend stopped the listed ones) is stopped; nothing starts, relaunches or wakes it.
function holdAttended(ctx, lane, agents) {
  const { deps, root } = ctx;
  for (const a of laneAgents(agents, laneSessionName(root, lane.key), laneCwd(root, lane), null).filter(isAgentAlive)) {
    try {
      deps.claude.stop(a.id);
      deps.log(`phase ${lane.phase} is attended: stopped its session ${a.id}`);
    } catch (err) {
      deps.log(`phase ${lane.phase} is attended: session ${a.id} not stopped: ${errLine(err)}`);
    }
  }
  if (!lane.notified.attended) {
    deps.log(`phase ${lane.phase} is attended in the owner's session; its lane waits until turbo-run attend ${lane.phase} --done`);
    lane.notified.attended = true;
  }
}

// One slot lane's step (spec §5): what step does for v0.3's lane, per entry, with per-lane halts (D6).
async function laneStep(s, key, ctx, view, now) {
  const { root, config, deps } = ctx;
  const at = now.toISOString();
  const lane = s.lanes[key];
  lane.notified ??= {};
  const isPhase = lane.job === 'phase';
  const agent = lane.sessionId ? view.agents.find((a) => a.id === lane.sessionId) : undefined;
  const listed = isPhase ? view.phases.find((x) => x.number === lane.phase) : null;
  // a slot lane's phase is never complete for its own status: main records it only after L2's merge
  const phase = { number: isPhase ? lane.phase : recordKey(lane), complete: false, verification: listed?.verification ?? null };
  const cwd = laneCwd(root, lane);
  if (isPhase && view.attended.has(lane.phase)) return holdAttended(ctx, lane, view.agents);
  // reconcile R10 (review I6): a plan-only run never steps a phase lane an earlier run recorded
  if (isPhase && s.planOnly) {
    if (!lane.notified.planOnly) deps.log(`phase ${lane.phase}: this run prepares only; its lane waits for a start without --plan-only`);
    lane.notified.planOnly = true;
    return;
  }
  // reconcile R5: L2 merged the phase into main; its follow-up (push, CI, release) runs every tick until released.
  // Before any launch (review I3): a merged phase is never relaunched, the owner's resume included.
  const merge = isPhase && deps.mergeState ? deps.mergeState(root, lane.phase) : null;
  if (merge?.state === 'released') {
    // released by L2 while this supervisor was away: the lane's work is done
    return dropLane(s, ctx, lane, agent, { done: true });
  }
  if (merge?.state === 'merged') {
    if (lane.forceRelaunch) {
      deps.log(`phase ${lane.phase} is merged into main and waits for push and CI; nothing is relaunched`);
      delete lane.forceRelaunch;
    }
    if (deps.mergeFollowUp && await followUpStep(s, ctx, lane, agent, at)) return;
    if (!lane.sessionId) return;
  }
  if (lane.halted) return;
  // review I1: a wake L2 asked for that no session took yet
  if (isPhase && lane.inboxWake && lane.sessionId) return wakeForInbox(ctx, lane, lane.inboxWake, at);
  if (!lane.sessionId || lane.forceRelaunch) {
    // D8: a new lane (its slot just prepared), one whose launch failed, one a restarted supervisor found in its slot,
    // or the owner's resume
    const resume = Boolean(lane.forceRelaunch) || lane.launch === 'resume';
    if (lane.sessionId) {
      // a still-listed old session must be gone first; a failed rm fails this lane's step and keeps the resume
      if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
      else removeSession(ctx, lane.sessionId);
    }
    const { adopted, ...started } = startLane(phase, view.agents, ctx, { resume, exclude: lane.sessionId, at, place: placeOf(ctx, lane) });
    const restarts = lane.forceRelaunch ? 0 : Number(lane.restarts) || 0;
    Object.assign(lane, started, { restarts, fingerprint: deps.fingerprint(phase, cwd), notified: {}, blockedSince: null, forceRelaunch: false, mode: relaunchMode(lane, adopted, ctx) });
    delete lane.launch;
    return;
  }
  if (isPhase && !listed && turnEnded(agent)) {
    deps.log(`phase ${lane.phase} is no longer in the roadmap and session ${lane.sessionId} has ended`);
    return haltLane(ctx, lane, 'missing', at, { id: lane.sessionId });
  }
  const record = readLaneStatus(root, recordKey(lane));
  // D3: the lane's end, once its turn has ended (its last words may still be on their way): L2's merge, L3's job
  if (isFresh(record, lane.launchedAt) && DONE_STATUSES[lane.job].includes(record.status)) {
    if (!turnEnded(agent)) return;
    return isPhase ? mergeStep(s, ctx, lane, agent, at) : finishJobStep(s, ctx, lane, agent, at);
  }
  const status = inferStatus({ agent, laneRecord: record, launchedAt: lane.launchedAt, phase, mode: 'full' });
  const unknown = unknownAgentState(agent);
  if (unknown && lane.notified.unknownState !== unknown) {
    deps.log(`${lname(lane)} session ${lane.sessionId} reports unknown state ${JSON.stringify(unknown.slice(0, 40))}; waiting`);
    lane.notified.unknownState = unknown;
  }
  if (await sharedStatus(ctx, lane, phase, record, status, agent, now, at)) return;
  if (status === 'paused-context') {
    const fp = deps.fingerprint(phase, cwd);
    const d = relaunchDecision({ restarts: lane.restarts, progressed: fp !== lane.fingerprint, maxRestarts: config.max_restarts_without_progress });
    if (d.action === 'halt') return stopLane(s, ctx, lane, agent, 'noProgress', at, { restarts: lane.restarts });
    // two sessions never work in one slot: a still-listed one goes first and its rm must succeed
    if (isAgentAlive(agent)) deps.claude.rm(lane.sessionId);
    else removeSession(ctx, lane.sessionId);
    const { adopted, ...started } = startLane(phase, view.agents, ctx, { resume: true, exclude: lane.sessionId, at, place: placeOf(ctx, lane) });
    Object.assign(lane, started, { restarts: d.restarts, fingerprint: fp, notified: {}, blockedSince: null, mode: relaunchMode(lane, adopted, ctx) });
    return;
  }
  // complete is false here, so done is never inferred: anything left is a failure. sessionFailed: the session failed,
  // not the lane by its own record, so a start at logon tries it again (resumableLanes)
  return stopLane(s, ctx, lane, agent, 'failed', at, { id: lane.sessionId, ...(isFresh(record, lane.launchedAt) && record.status === 'failed' ? {} : { sessionFailed: true }) });
}

// D7: an error in one lane's step restores only that lane (plus what must survive a failure, laneKeep) and counts on it.
async function guarded(s, key, ctx, view, now) {
  if (!s.lanes[key]) return;
  const before = structuredClone(s.lanes[key]);
  try {
    await laneStep(s, key, ctx, view, now);
    const lane = s.lanes[key];
    if (lane) {
      delete lane.launchFailures;
      delete lane.failingSince;
      delete lane.failingNotified;
    }
  } catch (err) {
    const lane = { ...before, ...(err?.laneKeep || {}) };
    s.lanes[key] = lane;
    try {
      await laneError(s, ctx, lane, err, now);
    } catch (again) {
      ctx.deps.log(`${lname(lane)}: ${errLine(again)}`);
    }
  }
}

async function laneError(s, ctx, lane, err, now) {
  const { config, deps } = ctx;
  // Claude Code's background service stays down after a kick (deps.claude logged it once): retried next tick, nothing
  // counted or notified
  if (isDaemonDown(err)) return;
  const at = now.toISOString();
  const text = errLine(err);
  deps.log(`${lname(lane)}: tick error: ${String(err?.message ?? err).replace(/\s*\r?\n\s*/g, ' ')}`);
  // the lease check after this tick ends the daemon: nothing to count
  if (err?.leaseLost) return;
  if (err?.launchFailed && UNTRUSTED_RE.test(String(err.message))) return stopLane(s, ctx, lane, undefined, 'untrusted', at, { error: text });
  if (err?.launchFailed) {
    lane.launchFailures = (Number(lane.launchFailures) || 0) + 1;
    if (lane.launchFailures >= MAX_LAUNCH_FAILURES) await stopLane(s, ctx, lane, undefined, 'launch', at, { error: text });
    return;
  }
  lane.failingSince ||= at;
  if (!lane.failingNotified && (now - Date.parse(lane.failingSince)) / 60000 >= config.blocked_minutes_before_notify) {
    await deps.notify('supervisorFailing', { error: `${lname(lane)}: ${text}`.slice(0, 200) });
    lane.failingNotified = true;
  }
}

// D10: a free slot Claude Code trusts, leaving out the slots that refused their preparation lately.
function freeSlotFor(s, ctx, now) {
  const window = ctx.config.blocked_minutes_before_notify * 60000;
  const skip = Object.entries(s.slotRefused || {}).filter(([, r]) => now - Date.parse(r.at) < window).map(([k]) => Number(k));
  return ctx.deps.slots.free({ skip });
}

// D10, spec §9: the owner is told once per free slot that Claude Code does not trust, with L0's line for it.
async function tellUntrusted(s, ctx) {
  for (const u of ctx.deps.slots.untrusted()) {
    const note = `trust-${u.k}`;
    if ((s.slotNotes ??= {})[note]) continue;
    ctx.deps.log(`slot ${u.k}: ${u.line}`);
    await ctx.deps.notify('slotUntrusted', { k: u.k, line: u.line });
    s.slotNotes[note] = true;
  }
}

// D8: prepares the slot for the job (L0 prepareSlot) and records the lane without a session; its own step launches it.
// A refusal changes nothing in the slot: it is skipped for a while and the owner told once per reason.
async function openLane(s, ctx, slot, job, now) {
  const { config, deps } = ctx;
  const key = laneKey({ job: job.kind, phase: job.phase });
  let prepared;
  try {
    prepared = deps.slots.prepare(slot, job);
  } catch (err) {
    const why = errLine(err);
    const was = s.slotRefused?.[slot.k];
    (s.slotRefused ??= {})[slot.k] = { why, at: now.toISOString() };
    deps.log(`slot ${slot.k} refused ${key}: ${why}`);
    if (was?.why !== why) await deps.notify('slotRefused', { k: slot.k, why, minutes: config.blocked_minutes_before_notify });
    return null;
  }
  if (s.slotRefused) delete s.slotRefused[slot.k];
  if (s.slotNotes) delete s.slotNotes[`trust-${slot.k}`];
  s.lanes[key] = { key, job: job.kind, phase: job.phase, slot: prepared.k, slotPath: prepared.path, branch: prepared.branch, sessionId: null, launch: 'new', launchedAt: null, restarts: 0, notified: {}, mode: 'full', blockedSince: null };
  deps.log(`${job.kind === 'phase' ? `phase ${job.phase}` : `lane ${key}`}: slot ${prepared.k} prepared on ${prepared.branch}`);
  return key;
}

// D5: L3's lane annotation; an unreadable one is none (one phase lane at a time), logged once per reason.
function readAnnotation(s, ctx) {
  try {
    const f = ctx.deps.lanesFile ? ctx.deps.lanesFile() : null;
    delete s.lanesFileError;
    return f && typeof f === 'object' ? f : null;
  } catch (err) {
    const why = errLine(err);
    if (s.lanesFileError !== why) ctx.deps.log(`lanes.json unreadable (${why}); one phase lane at a time`);
    s.lanesFileError = why;
    return null;
  }
}

// spec §5: the ready phases get slots first (pickPhases); returns the keys of the lanes opened in this tick.
async function schedule(s, ctx, view, now) {
  const { root, config, deps } = ctx;
  const limit = maxLanes(config);
  const lanesFile = readAnnotation(s, ctx);
  const annotation = (n) => annotationOf(lanesFile, n);
  const lanes = () => Object.values(s.lanes);
  // the areas and gates of every phase lane, refreshed: the scheduler and turbo-run lock read them
  for (const l of lanes()) if (l.job === 'phase') Object.assign(l, annotation(l.phase));
  const busy = () => new Set([...lanes().map((l) => l.phase).filter((p) => p != null), ...view.attended]);
  const running = lanes().filter((l) => l.job === 'phase').map((l) => ({ phase: l.phase, areas: l.areas, gates: l.gates }));
  // reconcile R10: start --plan-only runs prep and annotate jobs only, never a phase lane
  const { picked, next } = s.planOnly ? { picked: [], next: null } : pickPhases(view.phases, {
    range: s.range || null, running, exclude: [...busy()], annotation, heldGates: heldGates(root),
    // reconcile R8: only no annotation at all limits the lanes; a stale one leaves its changed phases out (they read
    // as **, so they run alone) and keeps the marks of the others
    slots: Math.max(0, limit - lanes().length), oneLane: !lanesFile,
  });
  s.next = next;
  const started = [];
  let waiting = null;
  // reconcile R5: while a phase's merge waits on the owner (a merge hold), no new phase lane starts; jobs may
  const holds = deps.mergeHolds ? deps.mergeHolds(root).map(String) : [];
  const holdKey = holds.join(', ');
  if (holdKey !== (s.mergeHold || '')) {
    if (holdKey) deps.log(`merge hold of phase ${holdKey}: no new phase lane starts until it is released`);
    if (holdKey) s.mergeHold = holdKey;
    else delete s.mergeHold;
  }
  if (holds.length && picked.length) s.next = { phase: picked[0].number, why: 'merge', waitsFor: holds };
  for (const p of holds.length ? [] : picked) {
    const slot = freeSlotFor(s, ctx, now);
    if (!slot) {
      await tellUntrusted(s, ctx);
      waiting ??= p.number;
      break;
    }
    const key = await openLane(s, ctx, slot, { kind: 'phase', phase: p.number }, now);
    if (key) {
      Object.assign(s.lanes[key], annotation(p.number));
      started.push(key);
    } else waiting ??= p.number;
  }
  if (waiting) s.next = { phase: waiting, why: 'slots', waitsFor: [] };
  // D9: jobs only in the slots the ready phases leave, at most max_prep at once. view.jobsDue: how many jobs
  // pendingJobs named this tick (null: not asked or failed), for the end of a plan-only run
  view.jobsDue = deps.pendingJobs ? null : 0;
  if ((!holds.length && (waiting || next?.why === 'slots')) || !deps.pendingJobs) return started;
  const failed = Object.keys(s.jobsFailed || {});
  let jobs;
  try {
    // reconcile R7: L3's signature; the lanes after this tick's phase launches
    jobs = await deps.pendingJobs({ root, config, lanes: s.lanes, range: s.range || null, mode: ctx.mode, failed }, view.phases);
  } catch (err) {
    const why = errLine(err);
    if (s.jobsError !== why) deps.log(`jobs: ${why}`);
    s.jobsError = why;
    return started;
  }
  delete s.jobsError;
  view.jobsDue = Array.isArray(jobs) ? jobs.length : 0;
  const cap = maxPrep(config, limit);
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (limit - lanes().length <= 0 || lanes().filter((l) => l.job !== 'phase').length >= cap) break;
    // reconcile R7: a job is { kind, phase } (L0's job field name)
    if (!j || (j.kind !== 'prep' && j.kind !== 'annotate')) continue;
    const phase = j.kind === 'annotate' ? null : String(j.phase);
    const key = laneKey({ job: j.kind, phase });
    // never two lanes of one phase (D3): not the prep of a phase that runs, is attended or is prepped already
    if (s.lanes[key] || failed.includes(key) || (phase !== null && busy().has(phase))) continue;
    const slot = freeSlotFor(s, ctx, now);
    if (!slot) {
      await tellUntrusted(s, ctx);
      break;
    }
    const opened = await openLane(s, ctx, slot, { kind: j.kind, phase }, now);
    if (opened) started.push(opened);
  }
  return started;
}

// After the lanes and the scheduler: the run halts when every lane waits for the owner (D6), or ends as in v0.3 when
// no lane runs and no phase can start.
async function settle(s, ctx, view, started) {
  const { deps } = ctx;
  const range = s.range || null;
  const scoped = view.phases.filter((x) => inRange(x.number, range));
  if (scoped.length) delete s.noPhases;
  logSkipped(s, scoped, deps);
  const lanes = Object.values(s.lanes);
  // reconcile R10: a plan-only run ends once pendingJobs names nothing and no job lane runs (a phase lane of an
  // earlier run is not stepped meanwhile, review I6, and waits for the next start)
  if (s.planOnly) {
    if (view.jobsDue === 0 && !started.length && lanes.every((l) => l.job === 'phase')) {
      deps.log('milestone prepared: no prep or annotate job is due and none runs');
      await deps.notify('milestonePrepared', {});
      s.finished = true;
    }
    return;
  }
  if (lanes.length) {
    delete s.noReady;
    if (lanes.every((l) => l.halted) && s.next?.why !== 'slots') {
      deps.log(`every lane is stopped (${lanes.map((l) => `${l.key}: ${l.halted.why}`).join(', ')}) and no phase can start; halted until the owner's resume`);
      s.halted = true;
      // only their sessions failed: a start at logon takes the run up again (lib/autostart.mjs logonSkip)
      if (lanes.every((l) => l.halted.sessionFailed)) s.haltedFor = 'sessionFailed';
    }
    return;
  }
  // a ready phase waits for a slot or for the annotation: not the end of anything
  if (started.length || (s.next && s.next.why !== 'deps')) return;
  await runEnd(s, view.phases, scoped, range, deps);
}

// One slots-mode tick (spec §5): every lane on its own, then the scheduler, then the lanes it opened, then the run's end.
// GSD's phase list and claude's session list are read once; their failure fails the tick (failedTick), as in v0.3.
async function stepSlots(s, ctx, now) {
  const { root, deps } = ctx;
  s.lanes ??= {};
  const view = { phases: deps.loadPhases(), agents: deps.claude.list(), attended: new Set(attendedPhases(root).map((a) => a.phase)) };
  s.remaining = remainingOf(view.phases, s.range);
  // armed before any lane's step, so a step that fails (guarded restores the lane) keeps the relaunch
  if (s.takeover) {
    for (const lane of Object.values(s.lanes)) {
      const isPhase = lane.job === 'phase';
      const listed = isPhase ? view.phases.find((x) => x.number === lane.phase) : null;
      if (isPhase && (!listed || view.attended.has(lane.phase) || s.planOnly)) continue;
      lane.notified ??= {};
      takeOver(ctx, lane, lane.sessionId ? view.agents.find((a) => a.id === lane.sessionId) : undefined, { number: isPhase ? lane.phase : recordKey(lane), complete: false, verification: listed?.verification ?? null });
    }
  }
  for (const key of Object.keys(s.lanes).sort((a, b) => compareLanes(s.lanes[a], s.lanes[b]))) await guarded(s, key, ctx, view, now);
  let started = [];
  try {
    started = await schedule(s, ctx, view, now);
    delete s.scheduleError;
  } catch (err) {
    // the lanes keep what this tick did for them; scheduling is tried again at the next tick
    const why = errLine(err);
    if (s.scheduleError !== why) deps.log(`schedule: ${why}`);
    s.scheduleError = why;
  }
  for (const key of started) await guarded(s, key, ctx, view, now);
  await settle(s, ctx, view, started);
}

// A failing tick (launch, agents list, GSD phases) keeps the previous state so the next tick
// retries, and notifies the owner once per failing spell that lasts blocked_minutes_before_notify.
// Failed launches are counted (a successful tick resets the count) and halt at MAX_LAUNCH_FAILURES.
async function failedTick(state, err, ctx, now) {
  const { config, deps } = ctx;
  // Claude Code's background service stays down after a kick (deps.claude logged it once): no failing spell, no owner
  // notice; the next tick tries again
  // (no laneKeep either: that is a counted try)
  if (isDaemonDown(err)) return structuredClone(state);
  const text = String(err?.message ?? err);
  const firstLine = text.split(/\r?\n/)[0].slice(0, 200);
  deps.log(`tick error: ${text.replace(/\s*\r?\n\s*/g, ' ')}`);
  const s = structuredClone(state);
  // what a failing tick must not roll back: the tries of a wake (the D13 bounds), set by relaunchCounted
  if (err?.laneKeep && s.lane) Object.assign(s.lane, err.laneKeep);
  // the lease check after this tick ends the daemon: nothing to count or notify
  if (err?.leaseLost) return s;
  if (err?.launchFailed && UNTRUSTED_RE.test(text)) {
    deps.log(`phase ${err.phase} halted: Claude Code does not trust ${ctx.root}`);
    await deps.notify('workspaceUntrusted', { phase: err.phase, dir: ctx.root });
    s.halted = true;
    return s;
  }
  s.failingSince ||= now.toISOString();
  if (!s.failingNotified && (now - Date.parse(s.failingSince)) / 60000 >= config.blocked_minutes_before_notify) {
    await deps.notify('supervisorFailing', { error: firstLine });
    s.failingNotified = true;
  }
  if (err?.launchFailed) {
    s.launchFailures = (Number(s.launchFailures) || 0) + 1;
    if (s.launchFailures >= MAX_LAUNCH_FAILURES) {
      deps.log(`phase ${err.phase} halted: launch failed ${s.launchFailures} times in a row`);
      await deps.notify('launchHalted', { phase: err.phase, error: firstLine });
      s.halted = true;
    }
  }
  return s;
}

export async function tick(state, ctx) {
  // stop, rm and resume that bring Claude Code's background service up when it idle-exited (wrapped once per ctx)
  ctx.deps.claude = daemonAware(ctx.deps.claude, { log: (line) => ctx.deps.log(line) });
  const now = ctx.deps.now();
  const s = structuredClone(state);
  // push requests and CI watches live in their own run files (spec §6, S2): their failures never fail the lane's tick
  try {
    await pushTick(ctx, now);
  } catch (err) {
    ctx.deps.log(`push: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
  // owner questions (spec §5.2, S1): their notifications never fail the lane's tick
  try {
    await ownerTick(ctx, now, s);
  } catch (err) {
    ctx.deps.log(`questions: ${errLine(err)}`);
  }
  // the owner's part may have waited on Telegram's long poll (up to 50 s): what the lane wrote meanwhile is older than
  // the times the step records (a wake's launchedAt), never newer
  const later = ctx.deps.now();
  try {
    await step(s, ctx, later);
  } catch (err) {
    const failed = await failedTick(state, err, ctx, later);
    // the skipped line this tick logged stays logged: it is not repeated during a failing spell
    if (s.skippedClosed) failed.skippedClosed = s.skippedClosed;
    else delete failed.skippedClosed;
    return failed;
  }
  delete s.failingSince;
  delete s.failingNotified;
  // any successful tick, adoption included, ends a launch-failure spell; restarts bound it from there
  delete s.launchFailures;
  // the takeover check (takeOver) is the first successful step's only; a checkout lane held by the owner's sitting
  // (attendWait) keeps it for the step after the sitting
  if (!s.attendWait) delete s.takeover;
  return s;
}

// The lane a starting daemon takes over: none after a finished run, and none outside the run's range.
// The session of a lane outside it is left alone (turbo-run stop already stopped it; kept for inspection).
export function resumableLane(prev, range, log) {
  const lane = prev && !prev.finished ? prev.lane || null : null;
  if (!lane || inRange(lane.phase, range)) return lane;
  log(`lane phase ${lane.phase} is outside the range ${rangeLabel(range)}; not resumed (session ${lane.sessionId} kept)`);
  return null;
}

// spec §9 (D8): what a starting slots-mode daemon takes over. The recorded lanes whose job a slot still holds (L0's
// slot record wins: a lane found in another slot moves there), inside the run's range; a lane that was stopped is tried
// again, as a new start does in v0.3. Then every slot of this project whose job is active but that no entry names (the
// supervisor stopped between preparing it and writing its state): its lane resumes there, adopting an alive session.
// logon (Gap 2): a start at logon (turbo-run start --autostart) tries again only a lane stopped by its session's failure
// (sessionFailed: a crash); a lane stopped for the owner stays stopped until the owner's resume.
export function resumableLanes(prev, range, ctx, { logon = false } = {}) {
  const { root, deps } = ctx;
  const log = deps.log;
  const lanes = {};
  const skipped = new Set();
  if (prev?.lane && !prev.finished) log(`a checkout-mode lane of phase ${prev.lane.phase} is recorded; slots mode does not resume it (session ${prev.lane.sessionId} kept)`);
  const recorded = prev && !prev.finished && prev.lanes && typeof prev.lanes === 'object' ? prev.lanes : {};
  for (const [key, lane] of Object.entries(recorded)) {
    if (!lane || typeof lane !== 'object') continue;
    if (lane.job === 'phase' && !inRange(lane.phase, range)) {
      log(`lane ${key} is outside the range ${rangeLabel(range)}; not resumed (session ${lane.sessionId} and slot ${lane.slot} kept)`);
      skipped.add(key);
      continue;
    }
    const held = deps.slots.forJob(lane.phase ?? null, lane.job);
    if (!held && lane.job === 'phase' && deps.mergeState?.(root, lane.phase)?.state === 'released') {
      // review I2: L2 released its slot after the merge while no supervisor ran; its step finishes the lane
      log(`lane ${key}: merged and released while the supervisor was away; finishing it`);
      lanes[key] = { ...lane, key };
      continue;
    }
    if (!held) {
      log(`lane ${key}: no slot holds its job any more; not resumed`);
      skipped.add(key);
      continue;
    }
    if (held.k !== lane.slot) log(`lane ${key}: its job is in slot ${held.k}, not ${lane.slot}; the slot record wins`);
    const entry = { ...lane, key, slot: held.k, slotPath: held.path };
    for (const f of ['launchFailures', 'failingSince', 'failingNotified']) delete entry[f];
    if (entry.halted && logon && !(entry.halted.why === 'failed' && entry.halted.sessionFailed)) {
      log(`lane ${key} stays stopped (${entry.halted.why}) at logon: turbo-run resume ${entry.phase ?? key} tries it again`);
    } else if (entry.halted) {
      log(`lane ${key} was stopped (${entry.halted.why}); this start tries it again`);
      delete entry.halted;
      Object.assign(entry, { forceRelaunch: true, restarts: 0 });
    }
    lanes[key] = entry;
  }
  if (prev?.finished) return lanes;
  let slots = [];
  try {
    slots = deps.slots.list();
  } catch (err) {
    log(`slots not listed (${errLine(err)}); a slot with a job and no record is not looked for`);
  }
  const home = dirKey(root);
  for (const slot of slots) {
    const job = slot.record?.job;
    if (!job || job.state !== 'active' || !slot.record.control || dirKey(slot.record.control) !== home) continue;
    const phase = job.phase == null ? null : String(job.phase);
    const key = laneKey({ job: job.kind, phase });
    if (lanes[key] || skipped.has(key) || (job.kind === 'phase' && !inRange(phase, range))) continue;
    lanes[key] = { key, job: job.kind, phase, slot: slot.k, slotPath: slot.path, branch: job.branch, sessionId: null, launch: 'resume', launchedAt: null, restarts: 0, notified: {}, mode: 'full', blockedSince: null };
    log(`lane ${key}: slot ${slot.k} holds its job without a record; its session is adopted or resumed there`);
  }
  return lanes;
}

export async function runDaemon({ ctx, statePath, initial, intervalMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let state = initial || { lane: null, finished: false, halted: false };
  let writeFailing = false;
  const beat = () => writeJsonAtomic(statePath, { ...state, pid: process.pid, updatedAt: ctx.deps.now().toISOString() });
  // long push work inside a tick refreshes the heartbeat between its steps (lib/push.mjs pushTick); a failing write
  // is reported by the write after the tick. A daemon that lost its lease writes nothing and answers false: its push
  // work stops, and the daemon ends the way it does after any tick without the lease.
  ctx.deps.heartbeat = () => {
    if (ctx.deps.leaseHeld && !ctx.deps.leaseHeld()) return false;
    try {
      beat();
    } catch {
      // reported after the tick
    }
    return true;
  };
  while (!state.finished && !state.halted) {
    try {
      state = await tick(state, ctx);
    } catch (err) {
      ctx.deps.log(`tick error: ${err.message}`);
    }
    // A failed state write (disk full, locked file) must not kill the daemon: the state stays
    // in memory and the next tick writes it again. Logged once per failing spell.
    try {
      beat();
      if (writeFailing) ctx.deps.log('state write ok again');
      writeFailing = false;
    } catch (err) {
      if (!writeFailing) ctx.deps.log(`state write failed: ${err.message}`);
      writeFailing = true;
    }
    if (state.finished || state.halted) break;
    await sleep(intervalMs);
  }
  return state;
}
