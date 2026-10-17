#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { claudeHome, findProjectRoot, gsdCoreDir, runDir, logsDir, locksDir, dirKey, stateRoot } from '../lib/paths.mjs';
import { cwdInside, laneSessionIds, ownSessionId } from '../lib/transcripts.mjs';
import { DEFAULTS, loadConfig, fullEntries, laneGates, lanesSettings, maxPrep, mergeRounds, pushSettings, leanSettings, prepSettings, laneEffort, buildSettings } from '../lib/config.mjs';
import { effortApply, effortOffHint, leanApply, leanBoundary, runLeanCommand } from '../lib/lean.mjs';
import { acquireGate, gateDeclaredBy, releaseGate } from '../lib/gate-locks.mjs';
import { InitAborted, initProject } from '../lib/project-init.mjs';
import { closedLineFor, runAdoptCommand } from '../lib/cli-adopt.mjs';
import { readJson, writeJsonAtomic, ensureDir } from '../lib/fsx.mjs';
import { createGit } from '../lib/push.mjs';
import { createGh } from '../lib/ci.mjs';
import { writeLaneStatus, isAgentAlive, LANE_STATUSES } from '../lib/run-status.mjs';
import { createClaude, daemonAware, resolveBin, laneSessionName, sessionFreeEnv } from '../lib/claude.mjs';
import { loadPhases, normalizePhaseId } from '../lib/gsd.mjs';
import { doctor } from '../lib/doctor.mjs';
import { runDaemon, resumableLane, resumableLanes } from '../lib/supervisor.mjs';
import { comparePhase, inRange, rangeLabel } from '../lib/scheduler.mjs';
import { msg } from '../lib/messages.mjs';
import { notify } from '../lib/notify.mjs';
import { PHASE_COMMANDS, VALUE_FLAGS as PHASE_VALUE_FLAGS, runPhaseCommand } from '../lib/cli-phase.mjs';
import { ownerRequestFiles } from '../lib/uat.mjs';
import { nextStep, readProgress } from '../lib/phase-progress.mjs';
import { gatesLeftovers } from '../lib/gates.mjs';
import { measureContext } from '../lib/context.mjs';
import { buildView, clean, formatView, openQuestions, runLineFor, withRunLine } from '../lib/view.mjs';
import { quietOnClosedPipe, useColor, watch } from '../lib/watch.mjs';
import { createLaneProbe } from '../lib/wake.mjs';
import { ANSWERS_IGNORE_REL, answersRel, deliveryState, readQuestions } from '../lib/questions.mjs';
import { commitAnswerPaths } from '../lib/answers.mjs';
import { attendFile, attendGates, attendedPhases, sweepLateLanes, clearResumeRequest, handBack, openPlans, releaseStops, requestResume, resumeRequests, writeAttend } from '../lib/attend.mjs';
import { runLanesCommand } from '../lib/cli-lanes.mjs';
import { listSlots, maxLanes, prepareSlot, releaseSlot, setupSlots, slotForPhase, slotsDir } from '../lib/slots.mjs';
import { trustLine, trustState } from '../lib/trust.mjs';
import { laneForPhase, laneLabel, lanesSummary, setupLines, supervisorLanes } from '../lib/lanes-state.mjs';
import { loadLanePlugins } from '../lib/lane-plugins.mjs';
import { findStrays, strayWatch } from '../lib/strays.mjs';
import { IntegrateRefused, readyRecord } from '../lib/integrate.mjs';
import { jobLaneStatus, runAnnotateCommand } from '../lib/cli-jobs.mjs';
import { runAwayCommand } from '../lib/away.mjs';
import { autoAnswers, readAway } from '../lib/away-state.mjs';
import { beatBeforeBoot, clearOwnerStop, logonSkip, readOwnerStop, runAutostart, writeOwnerStop } from '../lib/autostart.mjs';
import { runWorktreesCommand } from '../lib/worktrees.mjs';
import { watchSupervisor } from '../lib/watchdog.mjs';
import { readSupervisor } from '../lib/sup-state.mjs';
import { recoverSupervisor } from '../lib/sup-recover.mjs';
import { WHATIF_VALUE_FLAGS, runExecWhatif } from '../lib/exec-whatif.mjs';
import { gitRunner } from '../lib/staleness.mjs';
import { runCostCommand, spawnCostLog } from '../lib/cost.mjs';
import { buildLaneDeps, runnerOf, runningBuilds, stopBuild, waitBuildPaused } from '../lib/build-lane.mjs';
import { loadBuildState } from '../lib/build-queue.mjs';
import { buildOf, buildRows } from '../lib/view.mjs';

const SELF = fileURLToPath(import.meta.url);
const USAGE = 'usage: turbo-run <doctor|init|start|daemon|status|view|stop|lane-status|annotate|notify|resume|attend|lock|unlock|lanes|context|test-changed|phase-step|staleness|gates|jobs|uat|inbox|push-request|push-allow|state-sync|integrate|plan-drafts|questions|answer|agent-tail|away|back|autostart|worktrees|adopt|exec-whatif|lean|cost|build> [args]';
const SUPERVISOR_LOG = '.planning/turbo/logs/supervisor.log';
const VALUE_FLAGS = new Set(['--project', '--reason', '--base', '--lang', '--autonomy', '--mode', '--from', '--to', '--only', '--wait-seconds', '--job', '--relax', '--answers', '--plan-sha', '--merge', ...WHATIF_VALUE_FLAGS]);
// D12: commands of the owner's that act on the run; typed in a slot (an attend sitting) they act on the control root
const OWNER_COMMANDS = new Set(['start', 'daemon', 'status', 'view', 'stop', 'resume', 'attend', 'away', 'back', 'autostart', 'lean']);
// No path separators: a phase id only ever names p<id>.json inside the run directory.
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
const START_USAGE = 'usage: turbo-run start [--from <phase>] [--to <phase>] | start --only <phase> | start --all';
const CONFIG_ERROR = /^invalid turbo config /;
const HEARTBEAT_MIN_MS = 10 * 60 * 1000;
const KILL_WAIT_MS = 5000;
const START_CONFIRM_MS = 5000;
const EXEC_TIMEOUT_MS = 30000;
// POSIX single quotes; a ' inside becomes '\''.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function die(text, code = 1) { process.stderr.write(text + '\n'); process.exit(code); }
function flag(args, name, fallback = '') { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; }
function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) i++;
    else if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}
// Flags of any command whose next argument is their value: bin's and the phase commands' (cli-phase, turbo-run
// questions and answer among them, so a flag added there is covered here too).
const ARG_VALUE_FLAGS = new Set([...VALUE_FLAGS, ...PHASE_VALUE_FLAGS]);
// --project read in order: the value of another flag is skipped, so an answer text or a reason that says --project
// never names the project, and nothing after -- is a flag. --project may still follow the positional arguments.
function projectArg(args) {
  let p = '';
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '--project') {
      p = args[i + 1] ?? '';
      break;
    }
    if (ARG_VALUE_FLAGS.has(args[i])) i++;
  }
  return p ? path.resolve(p) : findProjectRoot(process.cwd());
}
// The range flags of start (and of the daemon it spawns): undefined without any (start keeps the
// stored range), null for --all, else { from, to } of normalized ids, a missing end null (open).
function rangeFlags(args) {
  const has = (f) => args.includes(f);
  const bad = (why) => die(`${why}\n${START_USAGE}`);
  // a flag right after another one is no phase id
  const id = (f) => { const v = flag(args, f); if (!PHASE_ID.test(v) || v.startsWith('-')) bad(`${f} needs a phase id`); return normalizePhaseId(v); };
  if (has('--all')) {
    if (has('--from') || has('--to') || has('--only')) bad('--all clears the range: no --from, --to or --only with it');
    return null;
  }
  if (has('--only')) {
    if (has('--from') || has('--to')) bad('--only takes no --from or --to');
    const only = id('--only');
    return { from: only, to: only };
  }
  if (!has('--from') && !has('--to')) return undefined;
  const range = { from: has('--from') ? id('--from') : null, to: has('--to') ? id('--to') : null };
  if (range.from && range.to && comparePhase(range.from, range.to) > 0) bad(`--from ${range.from} comes after --to ${range.to}`);
  return range;
}
// A run that has not finished (a stop, a halt, a resume) hands its range to the next start.
function keptRange(sup) {
  const r = sup && !sup.finished ? sup.range : null;
  const end = (v) => (v == null || v === '' ? null : String(v));
  return r && (end(r.from) || end(r.to)) ? { from: end(r.from), to: end(r.to) } : null;
}
const supPath = (root) => path.join(runDir(root), 'supervisor.json');
const lockPath = (root) => path.join(locksDir(root), 'daemon.lock');
const out = (line) => process.stdout.write(line + '\n');
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// EPERM: the process exists but belongs to someone else.
const pidExists = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Upper bound: setTimeout turns delays above 2^31-1 ms into 1 ms (a hot loop).
const clampPoll = (x) => Math.min(3600, Math.max(5, Number(x) || 20));
const clampInt = (x, min, fallback) => { const n = Math.floor(Number(x)); return Number.isFinite(n) ? Math.max(min, n) : fallback; };
// Numeric keys the daemon loop and the liveness checks depend on, kept sane.
function runtimeConfig(config) {
  const c = {
    ...config,
    poll_seconds: clampPoll(config.poll_seconds),
    max_restarts_without_progress: clampInt(config.max_restarts_without_progress, 1, DEFAULTS.max_restarts_without_progress),
    blocked_minutes_before_notify: clampInt(config.blocked_minutes_before_notify, 1, DEFAULTS.blocked_minutes_before_notify),
    // push.* checked where start, status and the daemon load the config: a typo stops them with one line
    push: pushSettings(config.push),
    // Stage 4 L1: merge_rounds, lanes.gates and max_prep the same way
    merge_rounds: mergeRounds(config),
  };
  laneGates(c);
  maxPrep(c, maxLanes(c));
  // Stage 6 §6.10: lean.*, prep.lookahead, lanes.effort and build.* the same way
  leanSettings(c);
  prepSettings(c);
  laneEffort(c);
  buildSettings(c);
  return c;
}
// stop/resume must work even when the config is broken.
function pollOf(root) {
  try { return runtimeConfig(loadConfig(root)).poll_seconds; } catch { return clampPoll(undefined); }
}

// Windows reuses pids quickly, so a pid alone proves nothing: a daemon is alive only with a
// valid pid that exists AND a heartbeat (updatedAt, rewritten every tick) that is recent. A
// heartbeat from the future (clock changed) is just as stale as an old one.
function daemonAlive(pid, updatedAt, pollSeconds) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > Math.max(HEARTBEAT_MIN_MS, 5 * pollSeconds * 1000)) return false;
  // a heartbeat from before the machine started: the daemon died with it (its pid may be another process's now).
  // TURBO_UPTIME_SECONDS stands in for the machine's uptime in tests whose heartbeats are hours old.
  const up = process.env.TURBO_UPTIME_SECONDS;
  if (beatBeforeBoot(updatedAt, up ? { uptimeSeconds: Number(up) } : {})) return false;
  return pidExists(pid);
}
// The running daemon may poll more slowly than the config now says: it records its own poll.
const supPoll = (sup, pollSeconds) => Math.max(pollSeconds, sup?.poll_seconds == null ? 0 : clampPoll(sup.poll_seconds));
const supAlive = (sup, pollSeconds) => Boolean(sup) && daemonAlive(sup.pid, sup.updatedAt, supPoll(sup, pollSeconds));

// Kills a daemon and waits until it is gone, so the caller's state edits are not overwritten
// by a last tick. ESRCH means it already exited.
function killDaemon(root, pid) {
  try {
    process.kill(pid);
  } catch (e) {
    if (e.code !== 'ESRCH') die(`cannot stop supervisor pid ${pid}: ${e.code || e.message}`);
  }
  for (let waited = 0; waited < KILL_WAIT_MS && pidExists(pid); waited += 100) sleepSync(100);
  if (pidExists(pid)) die(`supervisor pid ${pid} did not exit within ${KILL_WAIT_MS / 1000} s`);
  // a killed daemon runs no exit handler on Windows
  if (readJson(lockPath(root), null)?.pid === pid) fs.rmSync(lockPath(root), { force: true });
}

// Single daemon per project: an exclusive lock file holding {pid, at}. The holder's heartbeat is
// the newer of the lock's `at` and its supervisor.json updatedAt.
function acquireLock(root, pollSeconds) {
  ensureDir(locksDir(root));
  const file = lockPath(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n'); } finally { fs.closeSync(fd); }
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const lock = readJson(file, null);
    if (!lock) {
      // being written by a daemon that is starting right now
      let age = Infinity;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* gone again */ }
      if (age < 30000) return { ok: false, pid: null };
    } else {
      const sup = readJson(supPath(root), null);
      const beats = [lock.at, sup?.pid === lock.pid ? sup.updatedAt : null].map((s) => Date.parse(s)).filter(Number.isFinite);
      const beat = beats.length ? new Date(Math.max(...beats)).toISOString() : null;
      if (daemonAlive(lock.pid, beat, sup?.pid === lock.pid ? supPoll(sup, pollSeconds) : pollSeconds)) return { ok: false, pid: lock.pid };
    }
    fs.rmSync(file, { force: true }); // stale lock
  }
  return { ok: false, pid: null };
}

function releaseLock(root) {
  try {
    if (readJson(lockPath(root), null)?.pid === process.pid) fs.rmSync(lockPath(root), { force: true });
  } catch { /* best-effort */ }
}

// No pid on disk once this daemon is gone. Skipped when another writer (stop, resume) already
// replaced this daemon's pid.
function clearDaemonPid(root, state) {
  try {
    const cur = readJson(supPath(root), null);
    if (cur && cur.pid !== process.pid) return;
    writeJsonAtomic(supPath(root), { ...(state || cur || {}), pid: null, updatedAt: new Date().toISOString() });
  } catch { /* best-effort */ }
}

// The watchdog's look (lib/watchdog.mjs): a supervisor that died without a word is told to the owner once. root: the
// command's project (a lane's slot names its control root). Its line, or null; a look never fails the command it rides on.
const LANE_LOOKS = new Set(['inbox', 'ask', 'lane-status']);
// The owner's commands that start the supervisor (start, resume): a lane hears from the watchdog that it died and never
// starts it, since a lane's environment (its TURBO_LANE, its own temp directory) is no daemon's.
const refuseInLane = (cmd) => { if (process.env.TURBO_LANE) die(`refused: ${cmd} is the owner's: a lane never runs it`); };
async function supervisorLook(root, by) {
  try {
    const control = stateRoot(root);
    const config = runtimeConfig(loadConfig(control));
    // a damaged supervisor.json (a crash cut its write short) is told too, never taken for a project that never ran
    const { sup, damaged } = readSupervisor(control);
    const up = process.env.TURBO_UPTIME_SECONDS;
    const r = await watchSupervisor(control, { sup, damaged, alive: supAlive(sup, config.poll_seconds), config, by, ...(up ? { uptimeSeconds: Number(up) } : {}) });
    return r?.line ?? null;
  } catch {
    return null;
  }
}

// A damaged supervisor.json (lib/sup-state.mjs) at the owner's start or resume: kept aside as
// supervisor.json.damaged-<UTC> and rebuilt from the slots, the lane sessions and records, and the phases' progress
// (lib/sup-recover.mjs); the summary printed in the owner's language and logged. An unreadable one (an error code, not
// damaged content) is left alone and the command refuses. mode: the mode the supervisor runs in; range: what this start
// runs. true when it recovered.
function recoverDamaged(root, config, { mode = 'safe', range = null } = {}) {
  const { damaged } = readSupervisor(root);
  if (!damaged) return false;
  if (damaged.unreadable) die(`supervisor.json cannot be read: ${damaged.why}; nothing was started or changed: look at ${supPath(root)} (move it aside by hand once the disk reads again)`);
  // a daemon that still holds the lease would write over the rebuilt state: never next to it (the owner stops it first)
  const lock = readJson(lockPath(root), null);
  const up = process.env.TURBO_UPTIME_SECONDS;
  if (Number.isInteger(lock?.pid) && lock.pid > 0 && lock.pid !== process.pid && pidExists(lock.pid) && !beatBeforeBoot(lock.at, up ? { uptimeSeconds: Number(up) } : {})) {
    die(`supervisor.json is damaged (${damaged.why}), but daemon.lock names pid ${lock.pid}, which still runs (since ${lock.at || 'an unknown time'}): nothing was started or changed. Run turbo-run stop, then start again`);
  }
  let r;
  try {
    const core = gsdCoreDir(root);
    r = recoverSupervisor(root, {
      lang: config?.lang,
      slots: lanesSettings(config?.lanes).mode === 'slots',
      listSlots: () => listSlots(root, config),
      agents: () => createClaude({ root }).list(),
      phases: () => (core ? loadPhases(root, core).phases : null),
      mode,
      range,
    });
  } catch (e) {
    die(`${String(e?.message ?? e).split(/\r?\n/)[0]}; nothing was started or changed: look at ${supPath(root)} (move it aside by hand once the disk reads again)`);
  }
  // null: another start set it aside first and rebuilt it
  if (!r) return false;
  for (const line of r.lines) out(line);
  try {
    ensureDir(logsDir(root));
    fs.appendFileSync(path.join(logsDir(root), 'supervisor.log'), r.log.map((l) => `${new Date().toISOString()} recovery: ${l}\n`).join(''));
  } catch { /* logging is best-effort */ }
  return true;
}

// What status prints of a damaged supervisor.json, and what to do.
const damagedLine = (d) => `supervisor: state damaged (supervisor.json: ${d.why}${d.at ? `, last changed ${d.at}` : ''}), most likely by a machine crash; nothing runs the lanes. turbo-run start keeps the file aside and rebuilds the lanes from the slots and the lane sessions`;

// What status prints next to the lanes: the attended phases, the open questions, the owner's language.
function statusOpts(root, config) {
  return { root, attended: attendedPhases(root), questions: openQuestions(root).length, lang: config?.lang === 'ru' ? 'ru' : 'en', resumes: resumeRequests(root) };
}

// rangeLine false: the caller printed the range line already. attended: attendedPhases; a mark holds every lane, so
// the lane line names the hold instead of a session to watch.
// closed: Stage 5's line about the closed phases turbo skips (lib/cli-adopt.mjs closedLineFor), after the supervisor line.
// Stage 6 B4 (spec §6.7): a build lane's step and slices (lib/view.mjs buildRows), under its lane line
function printBuildRows(root, lane, lang) {
  if (!root) return;
  for (const row of buildRows(buildOf(root, lane, { home: claudeHome() }), lang)) out(`  ${row}`);
}

function printStatus(sup, running, { root = null, rangeLine = true, attended = [], questions = 0, lang = 'en', resumes = [], closed = null } = {}) {
  const finished = sup.range ? ' · range finished' : ' · milestone finished';
  out(`supervisor: ${running ? `running pid ${sup.pid}` : 'not running'}${sup.planOnly ? ' · plan only' : ''}${sup.finished ? finished : ''}${sup.halted ? ' · halted' : ''}`);
  if (closed) out(closed);
  if (sup.range && rangeLine) out(`range: phases ${rangeLabel(sup.range)}`);
  if (sup.failingSince) out(`failing since ${sup.failingSince} · log: ${SUPERVISOR_LOG}`);
  if (sup.lanes) return printLanes(sup, { root, attended, questions, lang, resumes, running });
  // F5: a resume handed to a slots supervisor that a supervisor of this mode has not taken yet
  for (const p of resumes) out(`resume asked: phase ${p} · ${running ? 'the running supervisor takes it at its next check' : 'taken when the supervisor starts (turbo-run start)'}`);
  if (sup.lane?.forceRelaunch) {
    // a resumed lane: its recorded session belongs to the run before the resume and is replaced at the next check
    const when = running ? "at the supervisor's next check" : 'once a supervisor runs: turbo-run start';
    out(`lane: phase ${sup.lane.phase} · relaunch pending (resume) · replaces session ${sup.lane.sessionId} ${when} · mode ${sup.lane.mode || 'safe'}`);
  } else if (sup.lane?.path === 'build') {
    out(`lane: phase ${sup.lane.phase} · build pid ${sup.lane.pid} · restarts ${sup.lane.restarts ?? 0} · since ${sup.lane.launchedAt}`);
    printBuildRows(root, sup.lane, lang);
  } else if (sup.lane) {
    const held = attended.map((a) => a.phase).join(', ');
    const next = held ? `held: phase ${held} attended in the owner's session; no lane runs until turbo-run attend <phase> --done` : `watch: claude attach ${sup.lane.sessionId}`;
    out(`lane: phase ${sup.lane.phase} · session ${sup.lane.sessionId} · restarts ${sup.lane.restarts} · mode ${sup.lane.mode || 'safe'} · since ${sup.lane.launchedAt}\n  ${next}`);
  }
}

// spec §8 (D16): the summary line, then one block per lane: what it runs, where, and what to do next.
function printLanes(sup, { root = null, attended, questions, lang, resumes = [], running = false }) {
  const held = new Set(attended.map((a) => a.phase));
  const asked = new Set(resumes);
  const lanes = supervisorLanes(sup);
  out(lanesSummary({ lanes: lanes.length, questions, next: sup.next || null }, lang));
  for (const l of lanes) {
    if (l.path === 'build') {
      // Stage 6 B4: a build lane runs turbo-run build N, no session
      out(`lane ${l.key}: ${laneLabel(l)} · slot ${l.slot} ${l.slotPath} · build pid ${l.pid} · restarts ${l.restarts ?? 0} · since ${l.launchedAt || '-'}`);
      printBuildRows(root, l, lang);
      continue;
    }
    out(`lane ${l.key}: ${laneLabel(l)} · slot ${l.slot} ${l.slotPath} · session ${l.sessionId || 'none yet'} · restarts ${l.restarts ?? 0} · since ${l.launchedAt || '-'}`);
    // F5: a resume handed to the running supervisor that it has not taken yet
    if (l.job === 'phase' && asked.has(l.phase)) out(`  resume asked: ${running ? 'the running supervisor relaunches it at its next check' : 'taken when the supervisor starts (turbo-run start)'}`);
    else if (l.job === 'phase' && held.has(l.phase)) out(`  attended in the owner's session: cd "${l.slotPath}" && claude (hand it back: turbo-run attend ${l.phase} --done)`);
    else if (l.halted) out(`  stopped (${l.halted.why}): try again with turbo-run resume ${l.phase}`);
    else if (l.forceRelaunch) out('  relaunch pending (resume)');
    else if (!l.sessionId) out('  launch pending');
    else out(`  watch: claude attach ${l.sessionId}`);
  }
}

// spec §8 (S4): the phases the owner runs in their own session; while any is marked, no lane runs.
function printAttended(attended) {
  for (const a of attended) out(`attended: phase ${a.phase}${a.at ? ` since ${a.at}` : ''} in the owner's session (hand it back: turbo-run attend ${a.phase} --done)`);
}

// v0.4.0: away mode and the answers turbo took itself since the owner last came back, each with its undo command
function printAway(root, config) {
  const away = readAway(root);
  const ru = config.lang === 'ru';
  if (away.since) out(ru ? `режим «ушёл»: с ${away.since}; когда вернётесь: turbo-run back` : `away: since ${away.since}; when you are back: turbo-run back`);
  for (const a of autoAnswers(root, { after: away.ackAt })) {
    const q = clean(String(a.question)).replace(/\s+/g, ' ');
    out(ru ? `принято автоматически: фаза ${a.phase} — ${q} → ${clean(a.option)} (отменить: ${a.undo})` : `auto-answered: phase ${a.phase} — ${q} → ${clean(a.option)} (undo: ${a.undo})`);
  }
}

function fingerprint(root) {
  // cwd: where the phase's lane works (its slot in Stage 4): its HEAD and its plans' summaries
  return (phase, cwd = root) => {
    let head = '';
    try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL' }).trim(); } catch { /* not a repo, or git hung */ }
    const dir = path.join(cwd, '.planning', 'phases');
    const raw = String(phase.number);
    const prefixes = [`${raw.replace(/^\d+/, (n) => n.padStart(2, '0'))}-`, `${raw}-`];
    let summaries = 0;
    try {
      for (const d of fs.readdirSync(dir)) if (prefixes.some((p) => d.startsWith(p))) summaries += fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('-SUMMARY.md')).length;
    } catch { /* no phases dir */ }
    return `${head}:${summaries}`;
  };
}

// D2: slots mode needs lanes.mode slots and doctor's full mode; anything else is v0.3's single lane in this checkout.
async function makeCtx(root, mode = 'safe') {
  const config = runtimeConfig(loadConfig(root));
  const core = gsdCoreDir(root);
  const claude = createClaude({ bin: resolveBin(), root });
  ensureDir(logsDir(root));
  const logFile = path.join(logsDir(root), 'supervisor.log');
  const slots = lanesSettings(config.lanes).mode === 'slots' && mode === 'full';
  const plugins = slots ? await loadLanePlugins() : null;
  const log = (line) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* logging is best-effort */ }
  };
  const ctx = {
    root, config, mode: mode === 'full' ? 'full' : 'safe', turboRun: `node ${shQuote(SELF.replace(/\\/g, '/'))}`,
    ...(slots ? { lanes: 'slots' } : {}),
    deps: {
      loadPhases: () => {
        if (!core) throw new Error('gsd-core not found');
        return loadPhases(root, core).phases;
      },
      claude,
      // the supervisor's push and CI work (spec §6, S2); unused while push.mode is off
      git: createGit(root),
      gh: createGh(root),
      // the lanes' transcripts, read-only: the session id a wake resumes, and a lane's activity (spec §5.5)
      lanes: createLaneProbe(root),
      fingerprint: fingerprint(root),
      // Stage 4 (D11): while two or more lanes run, every notification ends with the run's summary line
      // (a phaseDone tells of a lane still in supervisor.json: its line leaves that lane out, review I5)
      notify: (key, vars) => notify(config, withRunLine(msg(config.lang, key, vars), runLineFor(root, config, { leaving: key === 'phaseDone' ? vars?.phase : null }))),
      now: () => new Date(),
      log,
      // Stage 6 M (spec §7): the closed phase's cost line, from a detached turbo-run cost <N> --log; a job's session ids
      // (its job state), logged before claude rm takes them
      phaseCost: (phase) => spawnCostLog({ script: SELF, root, phase, log }),
      jobSessions: (jobId, cwd) => laneSessionIds({ home: claudeHome(), root: cwd, jobId }),
      // probed right before a launch: a lease revoked mid-tick (stop, resume, another start) launches nothing
      leaseHeld: () => !lostLease(root),
      // smoke F2: new entries next to the project while lanes run (lib/strays.mjs)
      strays: ({ sinceMs, seen }) => findStrays({ watch: strayWatch(root, config, { slots }), sinceMs, seen }),
      // Stage 6 D10: lean mode at a phase's boundary, before its launch (checkout) or its slot (slots)
      leanBoundary: (phase) => leanBoundary({ root, phase, core, log: (l) => ctx.deps.log(l), effort: () => effortApply({ root, env: process.env }) }),
      // Stage 6 B4 (spec §6.1): eligible phases run turbo-run build N as a detached lane (lib/build-lane.mjs)
      build: buildLaneDeps(root, config),
    },
  };
  if (plugins) {
    Object.assign(ctx.deps, {
      slots: slotDeps(root, config),
      mergeReady: plugins.mergeReady,
      // reconcile R5: the merge is two calls (mergeReady, then mergeFollowUp); mergeHolds keeps new phase lanes back
      mergeFollowUp: plugins.mergeFollowUp,
      mergeState: plugins.mergeState,
      mergeHolds: plugins.mergeHolds,
      pendingJobs: plugins.pendingJobs,
      jobPrompts: plugins.jobPrompts,
      finishJob: plugins.finishJob,
      lanesFile: () => (plugins.readLanesFile ? plugins.readLanesFile(root) : null),
    });
  }
  return ctx;
}

// The supervisor's view of L0's slots (Contracts: ctx.deps.slots). free: the first free slot Claude Code trusts,
// leaving out the ones the supervisor skips for a while (D10).
function slotDeps(root, config) {
  const trusted = (slot) => trustState(slot.path) === 'trusted';
  return {
    list: () => listSlots(root, config),
    free: ({ skip = [] } = {}) => listSlots(root, config).find((x) => x.state === 'free' && !skip.includes(x.k) && trusted(x)) || null,
    untrusted: () => listSlots(root, config).filter((x) => x.state === 'free' && !trusted(x)).map((x) => ({ k: x.k, path: x.path, line: trustLine(x.path, config.lang) })),
    prepare: (slot, job) => prepareSlot(root, slot, job),
    release: (k, outcome) => releaseSlot(root, k, { outcome, config }),
    forJob: (phase, kind) => slotForPhase(root, config, phase, { kind }),
  };
}

// Last lines of the supervisor log (read from its end: the log only grows).
function logTail(root, lines = 10) {
  try {
    const fd = fs.openSync(path.join(logsDir(root), 'supervisor.log'), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, 8192));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

// requested: rangeFlags' result (undefined keeps the range of a run that has not finished).
async function start(root, requested = undefined, { planOnly = false, logon = false } = {}) {
  const config = runtimeConfig(loadConfig(root)); // a corrupt config fails here, not inside the detached daemon
  // reconcile R10: /turbo-plan-milestone runs start --plan-only: prep and lane markup jobs in slots, no phase
  if (planOnly && lanesSettings(config.lanes).mode !== 'slots') die(`start --plan-only needs lanes.mode slots (this project runs lanes.mode ${lanesSettings(config.lanes).mode}); nothing was started`);
  fullEntries(config.test?.full, root); // an invalid test.full list too, not at every test gate of the lanes
  const running = () => { const sup = readJson(supPath(root), null); return supAlive(sup, config.poll_seconds) ? sup : null; };
  const already = (sup) => {
    // range flags never change a run that is going: the owner stops it first
    if (requested !== undefined) {
      process.stderr.write(`a run of ${sup.range ? `phases ${rangeLabel(sup.range)}` : 'the whole milestone'} is going (supervisor pid ${sup.pid}); nothing was changed: run turbo-run stop first, then start with the new range\n`);
      return 1;
    }
    if (planOnly && !sup.planOnly) {
      process.stderr.write(`a run of the phases is going (supervisor pid ${sup.pid}); nothing was changed: run turbo-run stop first, then start --plan-only\n`);
      return 1;
    }
    // the owner's start: a stop mark a failed stop left behind goes (Gap 2)
    clearOwnerStop(root);
    out(`already running (pid ${sup.pid})`);
    const opts = statusOpts(root, config);
    printStatus(sup, true, opts);
    printAttended(opts.attended);
    return 0;
  };
  let sup = running();
  if (sup) return already(sup);
  const r = doctor({ root });
  const failed = r.checks.filter((c) => !c.ok);
  if (r.mode === 'unsupported') {
    for (const c of failed) process.stderr.write(`FAIL ${c.name} ${c.detail}\n`);
    die('doctor: mode unsupported; not starting', 2);
  }
  for (const c of r.checks.filter((x) => !x.ok || x.warn)) out(`warn ${c.name} ${c.detail}`);
  for (const w of r.warnings ?? []) out(`warn ${w}`);
  // spec §4 (Stage 4 L1): slots mode builds the missing slots and their trust before the daemon starts (L0 setupSlots)
  if (lanesSettings(config.lanes).mode === 'slots') {
    if (r.mode !== 'full' && planOnly) die('start --plan-only needs full mode (doctor: safe); nothing was started');
    if (r.mode !== 'full') out('warn lanes.mode slots needs full mode (doctor: safe): one lane runs in this checkout');
    else {
      let res;
      try {
        res = setupSlots(root, config);
      } catch (e) {
        die(`slots: ${String(e?.message ?? e).split(/\r?\n/)[0]}; nothing was started`);
      }
      for (const line of setupLines(res)) out(line);
      if (!res.slots.some((x) => x.action !== 'refused')) die('slots: no slot could be built (see the lines above); nothing was started');
    }
  }
  // doctor takes seconds: another start may have launched a daemon meanwhile
  sup = running();
  if (sup) return already(sup);
  // a supervisor.json a crash damaged: kept aside, the lanes rebuilt before the daemon reads them
  recoverDamaged(root, config, { mode: r.mode === 'full' ? 'full' : 'safe', range: requested ?? null });
  const kept = requested === undefined ? keptRange(readJson(supPath(root), null)) : null;
  const range = kept || requested || null;
  if (range) out(`range: phases ${rangeLabel(range)}${kept ? ' (kept from the previous run)' : ''}`);
  // a forgotten sitting holds every lane of the daemon about to start: say so, never let it look like a run
  printAttended(attendedPhases(root));
  const rangeArgs = [...(range?.from ? ['--from', range.from] : []), ...(range?.to ? ['--to', range.to] : []), ...(planOnly ? ['--plan-only'] : []), ...(logon ? ['--autostart'] : [])];
  // reconcile R10: a later start without --plan-only clears a kept plan-only mark (a daemon restart keeps it)
  const stored = readJson(supPath(root), null);
  if (!planOnly && stored?.planOnly) {
    const { planOnly: _was, ...rest } = stored;
    writeJsonAtomic(supPath(root), rest);
  }
  if (planOnly) out('plan only: prep and lane markup jobs run in the slots; no phase runs');
  // Stage 5 §4.10: the closed phases with a stale verification are skipped; said until the owner decides in /turbo-adopt
  const closed = closedLineFor(root, config.lang);
  if (closed) out(closed);
  // the run goes on: a start at logon takes it up again after a reboot (Gap 2)
  clearOwnerStop(root);
  ensureDir(logsDir(root));
  const fd = fs.openSync(path.join(logsDir(root), 'supervisor.log'), 'a');
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [SELF, 'daemon', '--project', root, '--mode', r.mode === 'full' ? 'full' : 'safe', ...rangeArgs], { cwd: root, env: sessionFreeEnv(), detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  let ended = null;
  child.once('exit', (code, signal) => { ended = signal ? `signal ${signal}` : `exit code ${code}`; });
  child.once('error', (e) => { ended = e.code || e.message; });
  child.unref();
  fs.closeSync(fd);
  // A daemon announces itself by writing its pid to supervisor.json before its first tick.
  const started = () => readJson(supPath(root), null)?.pid === child.pid;
  for (const end = Date.now() + START_CONFIRM_MS; !ended && Date.now() < end && !started();) await delay(100);
  if (started()) {
    out(`started supervisor pid ${child.pid} (mode ${r.mode})`);
    return 0;
  }
  const last = readJson(supPath(root), null);
  if (ended && supAlive(last, config.poll_seconds)) {
    // another start won the lock: this start's daemon exited, the winner runs with its own range
    const label = (x) => (x?.from || x?.to ? `phases ${rangeLabel(x)}` : 'the whole milestone');
    out(`another start launched supervisor pid ${last.pid} first (${label(last.range)}); this start's supervisor exited`);
    printStatus(last, true, { ...statusOpts(root, config), rangeLine: false });
    if (requested !== undefined && label(range) !== label(last.range)) {
      process.stderr.write(`the running range is ${label(last.range)}, not ${label(range)}: run turbo-run stop first, then start with the new range\n`);
      return 1;
    }
    return 0;
  }
  if (ended && last && last.pid == null && Date.parse(last.updatedAt) >= spawnedAt && (last.finished || last.halted)) {
    out(`supervisor pid ${child.pid} ran and exited`);
    printStatus(last, false, { ...statusOpts(root, config), rangeLine: !range });
    return last.finished ? 0 : 1;
  }
  const what = ended ? `exited at once (${ended})` : `did not report within ${START_CONFIRM_MS / 1000} s; check: turbo-run status`;
  process.stderr.write(`supervisor pid ${child.pid} ${what}\n${SUPERVISOR_LOG}:\n${logTail(root)}\n`);
  return 1;
}

// Gap 2: turbo-run start --autostart, what autostart on registers for the logon. It starts the supervisor only for a
// run that was going when the machine went down (lib/autostart.mjs logonSkip), keeping its range and plan-only mark,
// and copies everything it prints, a failure of the start included, into the supervisor log: nobody sees a logon
// command's output.
async function startAtLogon(root) {
  const log = (text) => {
    const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return;
    try {
      ensureDir(logsDir(root));
      fs.appendFileSync(path.join(logsDir(root), 'supervisor.log'), lines.map((l) => `${new Date().toISOString()} ${l.startsWith('autostart: ') ? l : `autostart: ${l}`}\n`).join(''));
    } catch { /* logging is best-effort */ }
  };
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      log(chunk);
      return write(chunk, ...rest);
    };
  }
  const read = readSupervisor(root);
  if (read.damaged) {
    // the owner rebuilds it (turbo-run start): told once, as the watchdog tells a dead supervisor
    out(read.damaged.unreadable ? `autostart: nothing started: supervisor.json cannot be read (${read.damaged.why})` : `autostart: nothing started: supervisor.json is damaged (${read.damaged.why}); the owner's turbo-run start rebuilds the lanes`);
    await supervisorLook(root, 'autostart at logon');
    return 0;
  }
  const sup = read.sup;
  const why = logonSkip({ sup, ownerStop: readOwnerStop(root), alive: supAlive(sup, pollOf(root)) });
  if (why) {
    out(`autostart: nothing started: ${why}`);
    return 0;
  }
  out('autostart: the run was going when the machine went down; starting the supervisor');
  return start(root, undefined, { planOnly: Boolean(sup.planOnly), logon: true });
}

// Gap 1: how the owner comes back to their controlling session after a crash, printed by status in that session (the
// skill's own Bash knows its id as CLAUDE_CODE_SESSION_ID); never in a lane. Bare claude -c may open a lane's
// conversation: in checkout mode the lanes run in this directory too.
function backToChat(env, lang) {
  const id = String(env.CLAUDE_CODE_SESSION_ID ?? '');
  if (env.TURBO_LANE || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) return null;
  return lang === 'ru' ? `вернуться в этот чат: claude -r (выбрать по названию) или claude --resume ${id}` : `back to this chat: claude -r (pick it by its title) or claude --resume ${id}`;
}

// The daemon's lease, checked after every sleep. After a long sleep (hibernate, a stopped VM) the
// heartbeat goes stale: another start may then judge this daemon dead and take the lock, and stop
// or resume clear it ({pid: null}). daemon.lock alone decides: the lease is lost as soon as the lock
// is readable and names a different pid (null included). supervisor.json does not count: a daemon
// that only looked dead may have rewritten it in the middle of a tick, and the new owner's next tick
// rewrites it anyway. A read error (missing, unreadable or half-written lock) proves nothing and
// keeps the daemon running.
function lostLease(root) {
  const lock = readJson(lockPath(root), null);
  return lock !== null && typeof lock === 'object' && Object.hasOwn(lock, 'pid') && lock.pid !== process.pid ? lock : null;
}
function leaseSleep(root, log) {
  return async (ms) => {
    await delay(ms);
    const lock = lostLease(root);
    if (!lock) return;
    log(`daemon exit pid ${process.pid}: lease lost (daemon.lock names ${lock.pid == null ? 'no pid' : `pid ${lock.pid}`})`);
    // stop or resume cleared the lock: leave no pid behind. With another owner, write nothing.
    if (lock.pid == null) clearDaemonPid(root, null);
    process.exit(0); // not a throw: nothing after this point may write state
  };
}

async function daemon(root, mode = 'safe', range = null, { planOnly: asked = false, logon = false } = {}) {
  const ctx = await makeCtx(root, mode);
  const poll = ctx.config.poll_seconds;
  const lock = acquireLock(root, poll);
  if (!lock.ok) { out(`already running${lock.pid ? ` (pid ${lock.pid})` : ''}`); return 0; }
  const onSignal = (code) => () => { clearDaemonPid(root, null); releaseLock(root); process.exit(code); };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));
  let final = null;
  try {
    ctx.deps.log(`daemon start pid ${process.pid}`);
    const prev = readJson(supPath(root), null);
    // poll_seconds: this daemon's own poll, for the heartbeat window of status, stop and start;
    // range: the phases this run may start (no key: the whole milestone)
    // reconcile R10: --plan-only, or kept from the run this daemon takes over (start without it clears the mark)
    const planOnly = asked || Boolean(prev && !prev.finished && prev.planOnly);
    // takeover: the first tick relaunches a lane whose session failed or is gone while no supervisor ran (a reboot or
    // a crash), as a continuation instead of a halt (lib/supervisor.mjs takeOver)
    const base = { finished: false, halted: false, takeover: true, poll_seconds: poll, ...(range ? { range } : {}), ...(planOnly ? { planOnly: true } : {}) };
    let initial;
    // logon: a start at logon tries again only the lanes a crash stopped (Gap 2)
    if (ctx.lanes === 'slots') initial = { lanesMode: 'slots', lanes: resumableLanes(prev, range, ctx, { logon }), ...base };
    else {
      if (lanesSettings(ctx.config.lanes).mode === 'slots') ctx.deps.log(`lanes.mode slots needs full mode (doctor: ${mode}); one lane runs in this checkout`);
      if (prev?.lanes && Object.keys(prev.lanes).length && !prev.finished) ctx.deps.log(`slots-mode lanes are recorded (${Object.keys(prev.lanes).join(', ')}); checkout mode does not resume them (their sessions and slots kept)`);
      initial = { lane: resumableLane(prev, range, ctx.deps.log), ...base };
      if (planOnly) {
        // a plan-only run needs slots: never run phases in this checkout instead
        ctx.deps.log(`plan-only run needs lanes.mode slots and full mode (doctor: ${mode}); nothing runs`);
        initial = { ...initial, lane: null, halted: true };
      }
    }
    // pid on disk before the first tick, so status and a second start see this daemon at once
    writeJsonAtomic(supPath(root), { ...initial, pid: process.pid, updatedAt: new Date().toISOString() });
    final = await runDaemon({ ctx, statePath: supPath(root), initial, intervalMs: poll * 1000, sleep: leaseSleep(root, ctx.deps.log) });
    ctx.deps.log(`daemon exit${final.finished ? (final.planOnly ? ': milestone prepared' : final.range ? ': range finished' : ': milestone finished') : final.halted ? ': halted' : ''}`);
  } catch (e) {
    const text = String(e?.message ?? e);
    ctx.deps.log(`daemon fatal: ${text.replace(/\s*\r?\n\s*/g, ' ')}`);
    try {
      await ctx.deps.notify('supervisorFailing', { error: text.split(/\r?\n/)[0].slice(0, 200) });
    } catch { /* best-effort: the log has it */ }
    throw e;
  } finally {
    clearDaemonPid(root, final);
    releaseLock(root);
  }
  return 0;
}

// Stops the daemon process only (never the lane session) and clears its pid. A daemon that is not
// killed (no recent heartbeat, or not named by supervisor.json) loses its lease instead: daemon.lock
// {pid: null} ends it at its next check.
function stopDaemon(root, sup) {
  const revoke = () => writeJsonAtomic(lockPath(root), { pid: null, at: new Date().toISOString() });
  if (sup && supAlive(sup, pollOf(root))) {
    killDaemon(root, sup.pid);
    out(`stopped supervisor pid ${sup.pid}`);
  } else if (sup && Number.isInteger(sup.pid) && sup.pid > 0 && pidExists(sup.pid)) {
    out(`pid ${sup.pid} has no recent supervisor heartbeat (last ${sup.updatedAt || 'never'}); not killed`);
    // A daemon that only looks dead (hibernated) may still be mid-tick and rewrite its pid into
    // supervisor.json; the lock is what ends its lease, at its next check.
    revoke();
  } else {
    // supervisor.json is missing, unreadable or names no live daemon, but daemon.lock, the lease, may
    // still name one. Never killed: without a heartbeat the pid may belong to another process by now.
    const pid = readJson(lockPath(root), null)?.pid;
    if (Number.isInteger(pid) && pid > 0 && pidExists(pid)) {
      out(`daemon.lock names pid ${pid}, supervisor.json does not; its lease is revoked and it exits at its next check`);
      revoke();
    }
  }
  if (sup?.pid != null) writeJsonAtomic(supPath(root), { ...readJson(supPath(root), sup), pid: null });
}

// Where this project's lane sessions run: this checkout, every recorded lane's slot, and the slots directory (a lane the
// stopped daemon never recorded). A broken config leaves the recorded slots only.
function laneWhere(root, sups) {
  const dirs = new Set([dirKey(root)]);
  for (const sup of sups) for (const l of supervisorLanes(sup, root)) if (l.slotPath) dirs.add(dirKey(l.slotPath));
  let base = null;
  try { base = dirKey(slotsDir(root, loadConfig(root))); } catch { /* broken config */ }
  return { dirs, base };
}

// Lane sessions of this project: a lane name of this project (any key) started in one of its lane directories.
function projectLaneAgents(agents, root, where = { dirs: new Set([dirKey(root)]), base: null }) {
  const prefix = laneSessionName(root, '');
  return agents.filter((a) => String(a.name).startsWith(prefix) && Boolean(a.cwd) && (where.dirs.has(dirKey(a.cwd)) || (where.base !== null && dirKey(a.cwd).startsWith(`${where.base}/`))));
}

// A phase stopped by the owner or a crashed lane can leave GSD's gates or docs commits off; they stay off until
// restored by hand, so status and stop name them with the command. Never restored here.
function printLeftovers({ gates, docs }) {
  for (const p of gates) out(`gates off: phase ${p} (run: turbo-run gates restore ${p})`);
  for (const p of docs) out(`docs commits off: phase ${p} (run: turbo-run gates docs-restore ${p})`);
}

// The claude of the owner's commands that stop lane sessions (stop, attend): stop and rm bring Claude Code's idle-exited
// background service up (lib/claude.mjs daemonAware); a session whose service is gone for this config directory and that
// no process carries counts as stopped, said once per session in one plain line (in lang). Warnings go to stderr.
const goneTold = new Set();
function ownerClaude(root) {
  let ru = false;
  try { ru = loadConfig(root).lang === 'ru'; } catch { /* broken config: English */ }
  const warn = (line) => process.stderr.write(`warn: ${line}\n`);
  const onGone = (id) => {
    if (goneTold.has(id)) return;
    goneTold.add(id);
    out(ru ? `фоновая служба Claude Code не работает и процесса сессии ${id} нет — считаю полосу остановленной` : `Claude Code's background service is not running and no process carries lane session ${id}: counted as stopped`);
  };
  return daemonAware(createClaude({ root }), { log: warn, onGone });
}

// Runs once the daemon is gone. Stops the lane recorded before and after its death, and every
// alive lane session of this project: a daemon stopped while launching never records the session
// it started. A failed `claude stop` counts as stopped only when claude no longer lists the
// session alive.
// A job that Claude Code's idle-exited background service no longer runs (no pid) is stopped as it is, and so is one
// listed alive when the service is gone and no process carries it; one it may run gets the service kicked up and its
// stop tried once more (lib/claude.mjs daemonAware).
function stopLanes(root, before, { prevStop = null } = {}) {
  const after = readJson(supPath(root), null);
  const warn = (line) => process.stderr.write(`warn: ${line}\n`);
  // Stage 6 B4 (spec §6.6, §6.7): a running build pauses on the owner's first stop (the owner-stop mark: running
  // sessions finish and merge, nothing new starts); a stop while it already pauses for one ends its process tree
  let buildCode = 0;
  for (const b of runningBuilds(root)) {
    let hold = null;
    try {
      hold = loadBuildState(runDir(root), b.phase)?.hold ?? null;
    } catch { /* a damaged state: it pauses */ }
    // the second stop: the build already pauses for one (its hold), or an earlier stop came after the build started
    const started = Date.parse(runnerOf(root, b.phase)?.startedAt);
    const stoppedOnce = Number.isFinite(started) && Date.parse(prevStop?.at) >= started;
    if (hold?.reason !== 'stop' && !stoppedOnce) {
      out(`phase ${b.phase}: the build stops after its running sessions; run turbo-run stop again to end them now`);
      continue;
    }
    try {
      stopBuild({ pid: b.pid });
      out(`phase ${b.phase}: build pid ${b.pid} ended`);
    } catch (e) {
      warn(`phase ${b.phase}: ${e.message}`);
      buildCode = 1;
    }
  }
  const claude = ownerClaude(root);
  const list = () => { try { return claude.list(); } catch (e) { return e; } };
  let ok = true;
  const ids = new Set([...supervisorLanes(before, root), ...supervisorLanes(after, root)].map((l) => l.sessionId).filter(Boolean));
  const agents = list();
  if (agents instanceof Error) {
    warn(`cannot list sessions (${agents.message}); lane sessions missing from supervisor.json were not checked`);
    ok = false;
  } else {
    for (const a of projectLaneAgents(agents, root, laneWhere(root, [before, after]))) if (isAgentAlive(a)) ids.add(a.id);
  }
  const failed = new Map();
  for (const id of ids) {
    try { claude.stop(id); } catch (e) { failed.set(id, e); }
  }
  const now = failed.size ? list() : [];
  for (const [id, e] of failed) {
    if (now instanceof Error) {
      warn(`lane session ${id} not stopped: ${e.message}; cannot list sessions: ${now.message}`);
      ok = false;
      continue;
    }
    const agent = now.find((a) => a.id === id);
    if (agent && isAgentAlive(agent)) {
      warn(`lane session ${id} not stopped: ${e.message}`);
      ok = false;
    }
  }
  if (!ok) return 1;
  out('stopped');
  if (buildCode) return buildCode;
  // spec §8: stop never touches the slots: their work and their branches stay for review
  if ([before, after].some((x) => x?.lanes && Object.keys(x.lanes).length)) out('their slots and branches stay for review');
  return 0;
}

// The view of the project, read fresh: what view prints and status --watch redraws.
function readView(root) {
  const config = runtimeConfig(loadConfig(root));
  const { sup, damaged } = readSupervisor(root);
  // a file that cannot be read now (not damaged content) draws no red state: the next read decides
  return buildView({ root, sup, damaged: damaged?.unreadable ? null : damaged, running: supAlive(sup, config.poll_seconds), config });
}

// The owner's resume, and attend N --done (spec §8): clears the phase's lane record and its attend mark (the owner
// hands the phase back), gives turbo-phase's bounded rounds a fresh budget, arms a forced relaunch of its lane, and
// with andStart starts the supervisor. F5 (Stage 4 §9): a slots-mode supervisor that runs is never stopped for it: the
// resume is handed to it (requestResume) and it does the same between its lane steps, while the other lanes go on.
async function resumePhase(root, id, andStart) {
  if (andStart) {
    // start would keep this range and never resume a phase outside it: refuse before anything changes
    const prev = readJson(supPath(root), null);
    const kept = keptRange(prev);
    if (kept && !inRange(id, kept)) {
      const stopFirst = supAlive(prev, pollOf(root)) ? 'turbo-run stop, then ' : '';
      die(`phase ${id} is outside the range ${rangeLabel(kept)} that start keeps; nothing was stopped, removed or started. To run phase ${id}, change the range: ${stopFirst}turbo-run start --only ${id} (or --from <phase>, or --all)`);
    }
  }
  // a plan-only run never steps a phase lane, and a supervisor that halted or finished takes nothing more: those go the
  // way below (a start without --plan-only clears the plan-only mark)
  const live = readJson(supPath(root), null);
  if (live?.lanes && !live.planOnly && !live.halted && !live.finished && supAlive(live, pollOf(root))) {
    clearOwnerStop(root);
    requestResume(root, id);
    const what = laneForPhase(live, root, id) ? 'clears the phase and relaunches its lane' : 'clears the phase';
    out(`phase ${id}: handed to the running supervisor (pid ${live.pid}): at its next check it ${what}; the other lanes keep running`);
    return 0;
  }
  // a live daemon (for example one waiting for the owner) rewrites supervisor.json every
  // tick; stop it first. The lane session is left alone: forceRelaunch replaces it.
  stopDaemon(root, readJson(supPath(root), null));
  // a supervisor.json a crash damaged: kept aside and rebuilt first, so the phase's lane is found and armed below
  if (readSupervisor(root).damaged) {
    let config = {};
    try { config = loadConfig(root); } catch { /* a broken config: checkout mode's rebuild */ }
    recoverDamaged(root, config, { mode: 'safe' });
  }
  // the owner goes on with the run: a start at logon takes it up again (Gap 2)
  clearOwnerStop(root);
  // the phase's own files: in its lane's slot (Stage 4), else in this checkout. The questions are rebuilt as the plans
  // are now, before any supervisor tick notifies them: a sitting may have finished plans whose questions (a released
  // human-action stop, never answered there) would otherwise be announced again
  const phaseRoot = laneForPhase(readJson(supPath(root), null), root, id)?.slotPath || root;
  const warn = (line) => process.stderr.write(`warn: ${line}\n`);
  const { dropped } = handBack(root, id, { phaseRoot, lang: loadConfig(root).lang, warn });
  // review 1: the restarted step asks again; a lane question left open would block its wakes or answer another step
  if (dropped.length) out(`dropped questions: ${dropped.join(', ')} (the restarted step asks again)`);
  // done here: a request an earlier resume left for a supervisor that stopped before it took it goes
  clearResumeRequest(root, id);
  const sup = readJson(supPath(root), null);
  if (sup?.lanes) {
    // spec §9: only lane N is armed again (its stop cleared); the other lanes keep their state
    const lanes = { ...sup.lanes };
    if (lanes[id]) {
      const lane = { ...lanes[id], notified: {}, restarts: 0, forceRelaunch: true };
      delete lane.halted;
      lanes[id] = lane;
    }
    writeJsonAtomic(supPath(root), { ...sup, pid: null, finished: false, halted: false, lanes });
  } else if (sup) {
    const lane = sup.lane && String(sup.lane.phase) === id ? { ...sup.lane, notified: {}, restarts: 0, forceRelaunch: true } : sup.lane || null;
    writeJsonAtomic(supPath(root), { ...sup, pid: null, finished: false, halted: false, lane });
  }
  if (andStart) {
    out(`phase ${id} cleared`);
    return start(root);
  }
  out(`phase ${id} cleared; run: turbo-run start`);
  return 0;
}

// What attend says of the stops it released (lib/attend.mjs releaseStops): those asked ahead again, and those that
// keep the owner's answer, each with the answer and its time, as pre-answers for the sitting; and the done answers it
// set aside on live sittings (journal 2026-10-14), which no executor may take. An answer kept from before its stop came
// back, or set aside, changes the answers file: committed here, as turbo-run answer commits one (no lane runs in this
// checkout now); a commit that fails is a warning, the change stays.
function printReleased(root, id, released) {
  const list = readQuestions(root, id);
  const answered = list.filter((q) => released.ids.includes(q.id) && q.state === 'answered' && q.answer);
  const asked = released.ids.filter((x) => !answered.some((q) => q.id === x));
  const words = (a) => clean(String(a.label ?? a.answer ?? '')).replace(/\s+/g, ' ').trim().slice(0, 60);
  if (asked.length) out(`released stops: ${asked.join(', ')} (asked ahead again)`);
  if (answered.length) out(`released stops with your answer: ${answered.map((q) => `${q.id} (${words(q.answer)}, ${clean(q.answer.by)}, ${clean(q.answer.at)})`).join(', ')} (pre-answers for this sitting)`);
  const dropped = released.dropped ?? [];
  if (dropped.length) out(`dropped done answers: ${dropped.map((d) => `${d.id} (${words(d)}, ${clean(d.by)}, ${clean(d.at)})`).join(', ')} (a live sitting is never answered done: it runs in this session, with you)`);
  if (!released.kept.length && !dropped.length) return;
  const what = [released.kept.length ? `the kept answer of ${released.kept.join(', ')}` : '', dropped.length ? `the dropped done answer of ${dropped.map((d) => d.id).join(', ')}` : ''].filter(Boolean).join(' and ');
  const message = [released.kept.length ? `keep the owner's answer to ${released.kept.join(', ')}` : '', dropped.length ? `drop the done answer to the live sitting ${dropped.map((d) => d.id).join(', ')}` : ''].filter(Boolean).join('; ');
  try {
    const c = commitAnswerPaths(root, [answersRel(id), ANSWERS_IGNORE_REL], `docs(turbo): ${message} (phase ${id}, attended)`);
    if (!c?.committed && c?.reason !== 'no changes') process.stderr.write(`warn: ${what} is not committed (${c?.reason || 'unknown reason'}); the next answer commits it\n`);
  } catch (err) {
    process.stderr.write(`warn: ${what} is not committed (${String(err?.message ?? err).split(/\r?\n/)[0]}); the next answer commits it\n`);
  }
}

// A resume of the phase handed to a supervisor that has not taken it yet would clear the mark attend just wrote and
// relaunch the lane in the sitting's slot: attend cancels it.
function cancelResume(root, id) {
  if (clearResumeRequest(root, id)) out(`cancelled the resume of phase ${id} that the supervisor had not taken yet`);
}

// spec §8: the owner's session this attend runs in (CLAUDE_CODE_SESSION_ID), recorded in the mark: the view reads the
// sitting's progress from its transcript. dir: the checkout the sitting runs in; an attend run from elsewhere (slots
// mode: the skill then runs attend again in the slot) names no session. null when none is known (the view then shows
// the phase without its progress).
function sittingSession(dir) {
  return cwdInside(process.cwd(), dir) ? ownSessionId({ env: process.env }) : null;
}

// How long attend watches for a lane session that a killed supervisor's claude child registers late: 5 s, or
// TURBO_ATTEND_SETTLE_MS (0 to 60000).
function attendSettleMs() {
  const v = Number(process.env.TURBO_ATTEND_SETTLE_MS ?? '');
  return process.env.TURBO_ATTEND_SETTLE_MS && Number.isInteger(v) && v >= 0 && v <= 60000 ? v : 5000;
}

// spec §8 (S4): the owner takes the rest of phase N's plans into their own session (/turbo-autonomous attend N).
// Only the supervisor's own lane, and only while it has plans without a summary: refusals change nothing. The daemon
// stops first, so no tick (a wake, a relaunch) runs alongside; then the mark, which holds every lane of any later
// daemon until attend N --done or resume N clears it; then every lane session of this checkout stops (claude stop
// keeps the conversation). The checkpoints the lane stopped at are asked ahead again.
// Stage 6 B4 (spec §6.7): attend N of a build phase: the mark, then the wait until the build paused (it dispatches
// nothing new, its running sessions finish and merge, and it exits); the phase is then the owner's. attend N --done
// lets the supervisor relaunch `build N --resume`, which goes on from disk. GSD's gates stay on: the build path reviews
// and verifies after the sitting.
async function attendBuild(root, id, { plans, owner, slotPath = null }) {
  writeAttend(root, id, { sessionId: null, owner });
  cancelResume(root, id);
  const minutes = buildSettings(loadConfig(root)).timeoutMin + 10;
  const r = await waitBuildPaused(root, id, { timeoutMs: minutes * 60000, out });
  if (!r.paused) {
    process.stderr.write(`phase ${id}: the build has not paused after ${minutes} min; turbo-run stop twice ends it\n`);
    return 1;
  }
  const released = releaseStops(root, id, slotPath ? { phaseRoot: slotPath } : {});
  out(`phase ${id}: attended in this session; no lane starts, relaunches or wakes until turbo-run attend ${id} --done`);
  if (slotPath) out(`open: cd "${slotPath}" && claude`);
  out(`open plans: ${plans.join(', ')}`);
  out(`gates: keep on (the build path reviews and verifies after attend ${id} --done)`);
  printReleased(root, id, released);
  return 0;
}

async function attend(root, id) {
  const damaged = readSupervisor(root).damaged;
  if (damaged?.unreadable) die(`supervisor.json cannot be read (${damaged.why}): no lane is known to attend; nothing was stopped. Check the file and the disk, then attend ${id}`);
  if (damaged) die(`supervisor.json is damaged (${damaged.why}), most likely by a machine crash: no lane is known to attend; nothing was stopped. Run turbo-run start first (it keeps the file aside and rebuilds the lanes), then attend ${id}`);
  const current = readJson(supPath(root), null);
  // spec §8 (D11): in slots mode only lane N stops; the supervisor and the other lanes go on
  if (current?.lanes) return attendLane(root, id, current);
  const plans = openPlans(root, id);
  if (plans === null) die(`no single phase directory for phase ${id} under .planning/phases: nothing to attend`);
  if (!plans.length) die(`phase ${id} has no plan without a summary: nothing to attend. For owner-only UAT items run /gsd-verify-work ${id}, then /turbo-autonomous resume ${id}`);
  const sup = readJson(supPath(root), null);
  const lane = sup?.lane ? String(sup.lane.phase) : null;
  if (lane !== id) die(`phase ${id} is not the supervisor's lane${lane ? ` (that is phase ${lane})` : ''}: attend takes over the lane of the run (turbo-run status names it); nothing was stopped`);
  // Stage 6 B4 (spec §6.7): a build pauses on its own: no new dispatch, its running sessions finish and merge
  if (sup.lane.path === 'build') {
    stopDaemon(root, sup);
    return attendBuild(root, id, { plans, owner: sittingSession(root) });
  }
  // GSD's gates in the sitting, decided here from the lane's mode and next step; the skill follows the gates: line
  const gates = attendGates({ mode: sup.lane.mode, next: nextStep(readProgress(root, id)) });
  if (gates.refuse) die(`phase ${id} is not ready to attend: ${gates.refuse}; nothing was stopped`);
  // a daemon that ran (or a lease that named one) may have left a claude --bg child that registers a lane late
  const hadDaemon = [sup.pid, readJson(lockPath(root), null)?.pid].some((p) => Number.isInteger(p) && p > 0);
  stopDaemon(root, sup);
  writeAttend(root, id, { sessionId: sup.lane.sessionId || null, owner: sittingSession(root) });
  cancelResume(root, id);
  let code = stopLanes(root, sup);
  if (hadDaemon) {
    const claude = ownerClaude(root);
    const late = await sweepLateLanes({ list: () => claude.list(), stop: (x) => claude.stop(x), isLane: (a) => projectLaneAgents([a], root).length === 1, settleMs: attendSettleMs() });
    for (const x of late.stopped) out(`stopped late lane session ${x} (started by the stopped supervisor)`);
    for (const f of late.failed) process.stderr.write(`warn: ${f.id ? `late lane session ${f.id} not stopped` : 'cannot list sessions after the stop'}: ${f.error}
`);
    if (late.failed.length) code = 1;
  }
  const released = releaseStops(root, id);
  out(`phase ${id}: attended in this session; no lane starts, relaunches or wakes until turbo-run attend ${id} --done`);
  out(`open plans: ${plans.join(', ')}`);
  out(`gates: ${gates.gates === 'off' ? 'turn off' : 'keep on'} (${gates.why})`);
  printReleased(root, id, released);
  const delivered = readQuestions(root, id).filter((q) => q.stopped && q.state === 'delivered').map((q) => q.id);
  if (delivered.length) out(`already delivered: ${delivered.join(', ')} (the stopped session took these answers; a checkpoint reached again is asked in this session)`);
  if (code !== 0) process.stderr.write('a lane session did not stop (see the warnings above): stop it with claude stop <id> before anything runs in this checkout\n');
  return code;
}

// spec §8 (D11): the owner takes phase N's remaining plans into a session in its slot. The mark goes first: from its next
// tick the daemon holds lane N and stops any session of it that still appears; then lane N's sessions stop (claude stop
// keeps the conversation). The daemon and the other lanes are left alone. Refusals change nothing.
async function attendLane(root, id, sup) {
  const lane = laneForPhase(sup, root, id);
  const keys = supervisorLanes(sup, root).map((l) => l.key).join(', ');
  if (!lane) die(`phase ${id} has no lane in this run${keys ? ` (lanes: ${keys})` : ''}: attend takes over a running lane (turbo-run status names them); nothing was stopped`);
  const plans = openPlans(lane.slotPath, id);
  if (plans === null) die(`no single phase directory for phase ${id} under ${path.join(lane.slotPath, '.planning', 'phases')}: nothing to attend`);
  if (!plans.length) die(`phase ${id} has no plan without a summary: nothing to attend. For owner-only UAT items run /gsd-verify-work ${id} in ${lane.slotPath}, then /turbo-autonomous resume ${id}`);
  // Stage 6 B4 (spec §6.7): a build lane pauses on its own; the daemon and the other lanes go on
  if (lane.path === 'build') return attendBuild(root, id, { plans, owner: sittingSession(lane.slotPath), slotPath: lane.slotPath });
  const gates = attendGates({ mode: lane.mode, next: nextStep(readProgress(root, id)) });
  if (gates.refuse) die(`phase ${id} is not ready to attend: ${gates.refuse}; nothing was stopped`);
  writeAttend(root, id, { sessionId: lane.sessionId || null, owner: sittingSession(lane.slotPath) });
  cancelResume(root, id);
  const warn = (line) => process.stderr.write(`warn: ${line}\n`);
  const claude = ownerClaude(root);
  let code = 0;
  const ids = new Set([lane.sessionId].filter(Boolean));
  const name = laneSessionName(root, lane.key);
  try {
    for (const a of claude.list()) if (a.name === name && a.cwd && dirKey(a.cwd) === dirKey(lane.slotPath) && isAgentAlive(a)) ids.add(a.id);
  } catch (e) {
    warn(`cannot list sessions (${e.message}); only the recorded session of phase ${id} was stopped`);
    code = 1;
  }
  for (const x of ids) {
    try {
      claude.stop(x);
    } catch (e) {
      let alive = true;
      try { alive = isAgentAlive(claude.list().find((a) => a.id === x)); } catch { /* unknown: alive */ }
      if (alive) {
        warn(`lane session ${x} not stopped: ${e.message}`);
        code = 1;
      }
    }
  }
  const released = releaseStops(root, id, { phaseRoot: lane.slotPath });
  out(`phase ${id}: attended in the owner's session; the other lanes keep running; nothing starts, relaunches or wakes phase ${id} until turbo-run attend ${id} --done`);
  out(`open: cd "${lane.slotPath}" && claude`);
  out(`open plans: ${plans.join(', ')}`);
  out(`gates: ${gates.gates === 'off' ? 'turn off' : 'keep on'} (${gates.why})`);
  printReleased(root, id, released);
  const delivered = readQuestions(root, id).filter((q) => q.stopped && q.state === 'delivered').map((q) => q.id);
  if (delivered.length) out(`already delivered: ${delivered.join(', ')} (the stopped session took these answers; a checkpoint reached again is asked in this session)`);
  if (code !== 0) process.stderr.write(`a lane session did not stop (see the warnings above): stop it with claude stop <id> before anything runs in ${lane.slotPath}\n`);
  return code;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  // attend's --done takes no value (phase-step's does): it never hides a --project after it
  const found = projectArg(cmd === 'attend' ? args.filter((a) => a !== '--done') : args);
  const root = found && OWNER_COMMANDS.has(cmd) ? stateRoot(found) : found;
  const pos = positional(args);
  // the watchdog's lane side: a lane looks at its inbox (every step and wave), ask and lane-status (it stops for the owner)
  if (root && process.env.TURBO_LANE && LANE_LOOKS.has(cmd)) {
    const line = await supervisorLook(root, `the lane of phase ${pos[0] && PHASE_ID.test(pos[0]) ? normalizePhaseId(pos[0]) : '?'} (${cmd})`);
    if (line) process.stderr.write(`${line}\n`);
  }
  if (PHASE_COMMANDS.has(cmd)) {
    if (!root) die('no .planning directory found');
    // push-request --wait waits only while a supervisor is alive to push and watch CI
    return runPhaseCommand(cmd, args, { root, deps: { supervisorAlive: () => supAlive(readJson(supPath(root), null), pollOf(root)) } });
  }
  switch (cmd) {
    case 'doctor': {
      const r = doctor({ root });
      if (args.includes('--json')) out(JSON.stringify(r, null, 2));
      else {
        for (const c of r.checks) out(`${!c.ok ? 'FAIL' : c.warn ? 'warn' : 'ok  '} ${c.name} ${c.detail}`);
        for (const w of r.warnings ?? []) out(`warn ${w}`);
        out(`mode: ${r.mode}`);
      }
      return r.mode === 'unsupported' ? 2 : 0;
    }
    case 'init': {
      if (!root) die('no .planning directory found');
      const lang = flag(args, '--lang', 'en');
      const autonomy = flag(args, '--autonomy', 'standard');
      if (!['en', 'ru'].includes(lang) || !['standard', 'max'].includes(autonomy)) die('init [--lang en|ru] [--autonomy standard|max]');
      // lib/project-init.mjs: the same lines and changes; where it stops, the message and exit 1
      try {
        // Stage 6 §5.1: lean mode's keys (no commit: init commits nothing) and GSD's agent effort
        return initProject(root, { lang, autonomy, out, lean: (o) => leanApply({ ...o, effort: () => effortApply({ root, env: process.env }) }) });
      } catch (e) {
        if (e instanceof InitAborted) die(e.message);
        throw e;
      }
    }
    case 'start': {
      if (!root) die('no .planning directory found');
      refuseInLane('start');
      if (args.includes('--autostart')) {
        if (rangeFlags(args) !== undefined || args.includes('--plan-only')) die('start --autostart takes no range flags and no --plan-only: it takes up the run as it was');
        return startAtLogon(root);
      }
      return start(root, rangeFlags(args), { planOnly: args.includes('--plan-only') });
    }
    case 'daemon': {
      if (!root) die('no .planning directory found');
      return daemon(root, flag(args, '--mode', 'safe'), rangeFlags(args) ?? null, { planOnly: args.includes('--plan-only'), logon: args.includes('--autostart') });
    }
    case 'status': {
      if (!root) die('no .planning directory found');
      if (args.includes('--watch')) {
        quietOnClosedPipe(process.stdout);
        // the live view without the mod: view's text form, redrawn every view.refresh_seconds until Ctrl+C, in the
        // pane's colours on a terminal (useColor)
        const color = useColor({ isTTY: process.stdout.isTTY });
        await watch({
          frame: () => {
            const view = readView(root);
            return { text: formatView(view, { color }), seconds: view.ui.refreshSeconds, lang: view.ui.lang };
          },
          write: (s) => process.stdout.write(s),
          tty: Boolean(process.stdout.isTTY),
        });
        return 0;
      }
      const config = runtimeConfig(loadConfig(root)); // a corrupt config stops the daemon; report it instead of a normal status
      const { sup, damaged } = readSupervisor(root);
      const running = supAlive(sup, config.poll_seconds);
      const ownerRequests = ownerRequestFiles(root); // a phase run by hand has one without a supervisor
      const leftovers = gatesLeftovers(root);
      const attended = attendedPhases(root); // spec §8: phases the owner runs in their session; no lane runs meanwhile
      if (args.includes('--json')) { out(JSON.stringify({ running, ...sup, ...(damaged ? { damaged } : {}), ownerRequests, gatesOff: leftovers.gates, attended }, null, 2)); return 0; }
      // Stage 5 §4.10: the closed phases turbo skips, until the owner decides in /turbo-adopt
      const closed = closedLineFor(root, config.lang, { running });
      if (damaged?.unreadable) out(`supervisor: state cannot be read now (supervisor.json: ${damaged.why}); look again in a moment; if it stays so, check the file and the disk`);
      else if (damaged) out(damagedLine(damaged));
      else if (!sup) out(`supervisor: not running (never started)${closed ? `\n${closed}` : ''}`);
      else printStatus(sup, running, { ...statusOpts(root, config), attended, closed });
      for (const f of ownerRequests) out(`owner request: ${f}`);
      // v0.3.3: the questions a phase stopped for, in the owner's words
      const said = config.lang === 'ru' ? ['вопрос к вам: фаза', 'ответить'] : ['owner question: phase', 'answer'];
      for (const q of openQuestions(root).filter((x) => x.stopped)) out(`${said[0]} ${q.phase} — ${String(q.question).replace(/\s+/g, ' ')} (${said[1]}: /turbo-autonomous answer)`);
      printAttended(attended);
      printAway(root, config);
      printLeftovers(leftovers);
      const back = backToChat(process.env, config.lang);
      if (back) out(back);
      return 0;
    }
    case 'view': {
      if (!root) die('no .planning directory found');
      const view = readView(root);
      // the mod's clock (--watchdog): the owner's view looks after the supervisor too (lib/watchdog.mjs)
      if (args.includes('--watchdog')) await supervisorLook(root, "the owner's view");
      out(args.includes('--json') ? JSON.stringify(view) : formatView(view));
      return 0;
    }
    case 'stop': {
      if (!root) die('no .planning directory found');
      // the owner's stop: a start at logon (autostart) leaves the run stopped until the owner's start or resume
      // Stage 6 B4: the stop before this one, which a running build may still be pausing for
      let prevStop = null;
      try {
        prevStop = readOwnerStop(root);
      } catch { /* none */ }
      if (fs.existsSync(path.dirname(runDir(root)))) writeOwnerStop(root);
      const sup = readJson(supPath(root), null);
      stopDaemon(root, sup);
      // supervisor.json may be missing (never started) or unreadable for any reason: this
      // project's lane sessions are swept either way
      const code = stopLanes(root, sup, { prevStop });
      printLeftovers(gatesLeftovers(root));
      const damaged = readSupervisor(root).damaged;
      if (damaged) out(damaged.unreadable ? `supervisor.json cannot be read (${damaged.why}): kept as it is` : `supervisor.json is damaged (${damaged.why}): kept as it is; turbo-run start keeps it aside and rebuilds the lanes`);
      return code;
    }
    case 'autostart': {
      // Gap 2: opt-in, per project: the supervisor comes back at logon after a reboot; every change printed, off
      // undoes it (lib/autostart.mjs)
      if (!root) die('no .planning directory found');
      const action = pos[0];
      if (action === 'on' && !fs.existsSync(path.dirname(runDir(root)))) die('no .planning/turbo/ in this project: run /turbo-autonomous here first');
      // node by its real path: a version manager's per-shell link (fnm) is gone after a reboot
      const r = runAutostart(action, { root, node: fs.realpathSync(process.execPath), turboRun: SELF });
      const failing = r.code ? r.lines.at(-1) : null;
      for (const line of r.lines) (line === failing ? process.stderr : process.stdout).write(`${line}\n`);
      return r.code;
    }
    case 'adopt': {
      // Stage 5 (spec §4, §7): /turbo-adopt's command; the owner's, never a lane's, and it never starts the run
      refuseInLane('adopt');
      return runAdoptCommand(args, { root, out, err: (l) => process.stderr.write(`${l}\n`), supervisorAlive: (sup) => supAlive(sup, pollOf(root)) });
    }
    case 'exec-whatif': {
      // Stage 6 (spec docs/specs/2026-10-15-stage-6-design.md §5): measure first. Reads a finished phase's plans, git
      // and transcripts and compares GSD's waves with a ready queue; it writes nothing
      let config = DEFAULTS;
      let slotsBase = null;
      try {
        if (root) config = loadConfig(root);
        if (root) slotsBase = slotsDir(root, config);
      } catch {
        // a broken config loses only max_executors and lanes.dir: the defaults serve a read-only calculator
        if (root) slotsBase = slotsDir(root, DEFAULTS);
      }
      const deps = root ? { git: gitRunner(root), home: claudeHome(), slotsBase, maxExecutors: Number(config.max_executors) || 20 } : {};
      return runExecWhatif(args, { root, out, err: (l) => process.stderr.write(`${l}\n`), deps });
    }
    case 'lean': {
      // Stage 6 §5.6 (L1): lean mode's status, apply and off; apply and off are the owner's
      if (!root) die('no .planning directory found');
      return runLeanCommand(args, {
        root,
        out,
        err: (l) => process.stderr.write(`${l}\n`),
        deps: {
          loadPhases: () => {
            const core = gsdCoreDir(root);
            if (!core) throw new Error('gsd-core not found');
            return loadPhases(root, core).phases;
          },
          effort: () => effortApply({ root, env: process.env }),
          hint: () => effortOffHint(),
        },
      });
    }
    case 'cost': {
      // Stage 6 M (spec §7): a phase's time and tokens by step and role; --log appends its line to supervisor.log
      if (!root) die('no .planning directory found');
      return runCostCommand(args, { root, out, err: (l) => process.stderr.write(`${l}\n`) });
    }
    case 'build': {
      // Stage 6 B4 (spec §6.3): the build path runs phase N by code; the supervisor launches it for eligible phases
      if (process.env.TURBO_LANE) die("refused: build is the owner's: a lane never runs it", 2);
      if (!root) die('no .planning directory found');
      const { runBuildCommand } = await import('../lib/build.mjs');
      return runBuildCommand(args, { root, out, err: (l) => process.stderr.write(`${l}\n`) });
    }
    case 'annotate': {
      // spec §6.2 (L3): the markup session's brief and apply
      return runAnnotateCommand(args, { root, out, err: (l) => process.stderr.write(`${l}
`) });
    }
    case 'lane-status': {
      if (!root) die('no .planning directory found');
      // spec §6 (L3): the prep and annotate jobs' own statuses
      if (args.includes('--job') || pos[0] === 'annotate') return jobLaneStatus(args, { root, out, err: (l) => process.stderr.write(`${l}
`) });
      const [phase, status] = pos;
      if (!phase || !PHASE_ID.test(phase) || !LANE_STATUSES.includes(status)) die(`lane-status <phase> <${LANE_STATUSES.join('|')}> [--reason <text>] [--base <sha>]`);
      const id = normalizePhaseId(phase);
      // Stage 4 §7.1 p.4: ready carries what the supervisor's merge checks (lib/integrate.mjs readyRecord)
      let fields = {};
      if (status === 'ready') {
        try {
          fields = readyRecord(root, id, { base: flag(args, '--base') });
        } catch (e) {
          if (e instanceof IntegrateRefused) die(`refused: ${e.message}`);
          throw e;
        }
      }
      writeLaneStatus(root, id, status, { reason: flag(args, '--reason'), fields });
      out(status === 'ready' ? `lane ${id}: ready (base ${fields.base.slice(0, 12)}, head ${fields.head.slice(0, 12)}); the supervisor merges it into main` : `lane ${id}: ${status}`);
      // v0.3.3 (D8): a stop for the owner reaches them as a question card only through turbo-run ask
      if (status === 'needs-owner' && !deliveryState(root, id).waiting.length) process.stderr.write(`hint: no owner question waits for phase ${id}, so the owner gets only this reason: ask with turbo-run ask ${id} --question <plain words> --option <label>|<description> (2 to 4) --recommended <n>, or --action <the owner's one step>\n`);
      return 0;
    }
    case 'notify': {
      const config = root ? loadConfig(root) : { notify: { desktop: true } };
      await notify(config, { title: pos[0] || 'gsd-turbo', body: pos[1] || '' });
      return 0;
    }
    case 'resume': {
      refuseInLane('resume');
      const [phase] = pos;
      if (!root || !phase || !PHASE_ID.test(phase)) die('resume <phase> [--start]');
      return resumePhase(root, normalizePhaseId(phase), args.includes('--start'));
    }
    case 'attend': {
      // spec §8 (S4): attend <phase> takes the lane over for the owner's session; --done hands it back (resume --start)
      const [phase] = pos;
      if (!root || !phase || !PHASE_ID.test(phase)) die('attend <phase> [--done]');
      if (process.env.TURBO_LANE) die("refused: attend is the owner's: a lane never runs it");
      const id = normalizePhaseId(phase);
      if (!args.includes('--done')) return attend(root, id);
      // a typo must not reset another phase's budgets or start a supervisor that the real mark then holds
      if (!fs.existsSync(attendFile(root, id))) {
        const marks = attendedPhases(root).map((a) => a.phase).join(', ');
        die(`phase ${id} is not attended: nothing to hand back (${marks ? `attended: phase ${marks}` : 'no phase is attended'}); nothing was changed. To give phase ${id} back to its lane without a sitting: turbo-run resume ${id} --start`);
      }
      return resumePhase(root, id, true);
    }
    case 'away':
    case 'back': {
      // v0.4.0 sleep mode: the questions to answer before leaving (away), the mode on (away --set), the morning summary
      if (!root) die('no .planning directory found');
      const config = loadConfig(root);
      const core = gsdCoreDir(root);
      const deps = {
        config,
        sup: readJson(supPath(root), null),
        loadPhases: () => {
          if (!core) { process.stderr.write('warn: gsd-core not found: only the questions already built are listed\n'); return []; }
          return loadPhases(root, core).phases;
        },
      };
      return runAwayCommand(cmd, args, { root, out, deps });
    }
    case 'worktrees': {
      // the agent worktrees Claude Code left in the project: only clean, merged ones go, never forced (lib/worktrees.mjs)
      if (!root) die('no .planning directory found');
      return runWorktreesCommand(args, { root, out });
    }
    case 'lanes': {
      // spec §4, §4.1 (Stage 4 L0): the slots of this project: setup, trust, remove
      if (!root) die('no .planning directory found');
      return runLanesCommand(args, { root });
    }
    case 'lock':
    case 'unlock': {
      // spec §5 (Stage 4 L1, D13): one-off locks on shared resources; a lane runs them from its slot, and the lock
      // files live in the control root (locksDir)
      const LOCK_USAGE = 'usage: turbo-run lock <gate> <phase> [--wait-seconds <s>] | turbo-run unlock <gate> <phase>';
      if (!root) die('no .planning directory found');
      const [gate, phase] = pos;
      if (!gate || !phase || !PHASE_ID.test(phase)) die(LOCK_USAGE, 2);
      const config = runtimeConfig(loadConfig(root));
      const known = laneGates(config);
      if (!known.includes(gate)) die(`unknown gate ${gate} (known: ${known.join(', ')}; add your own in lanes.gates)\n${LOCK_USAGE}`, 2);
      const id = normalizePhaseId(phase);
      if (cmd === 'unlock') {
        const r = releaseGate(root, gate, id);
        if (r.released) out(`unlocked ${gate}`);
        else if (r.why === 'not-held') out(`${gate} is not locked`);
        else {
          process.stderr.write(`gate ${gate} is held by phase ${r.holder}, not ${id}; nothing changed\n`);
          return 1;
        }
        return 0;
      }
      const raw = flag(args, '--wait-seconds', '540');
      const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!(seconds >= 0 && seconds <= 86400)) die(`--wait-seconds takes a whole number of seconds from 0 to 86400\n${LOCK_USAGE}`, 2);
      const r = await acquireGate(root, gate, id, { waitMs: seconds * 1000, declaredBy: (g) => gateDeclaredBy(readJson(supPath(root), null), g, id) });
      if (r.acquired) {
        out(r.already ? `${gate} is already held by phase ${id}` : `locked ${gate} for phase ${id}`);
        return 0;
      }
      const h = r.holder;
      process.stderr.write(`gate ${gate} is held by phase ${h.phase ?? 'unknown'} since ${h.at ?? 'unknown'} (${h.by === 'lane' ? 'declared by its lane' : 'lock'}); waited ${seconds} s\n`);
      try {
        await notify(config, msg(config.lang, 'gateWait', { phase: id, gate, holder: h.phase ?? '?', minutes: Math.round(seconds / 60) }));
      } catch { /* best-effort: the lane sees exit 3 */ }
      return 3;
    }
    case 'context': {
      // a lane decides on this (paused-context at or above its stop percentage): anything it cannot measure
      // is an answer, `unknown`, with exit 0
      const [phase] = pos;
      if (phase !== undefined && !PHASE_ID.test(phase)) die('usage: turbo-run context [<phase>] [--json]');
      let r;
      if (!root) r = { unknown: 'no .planning directory found' };
      else {
        let window;
        try { window = loadConfig(root).context_window; } catch (e) { r = { unknown: e.message.replace(/\s*\r?\n\s*/g, ' ') }; }
        r ??= measureContext({ root, phase: phase === undefined ? null : normalizePhaseId(phase), window });
      }
      if (args.includes('--json')) out(JSON.stringify(r));
      else out(r.unknown ? `context: unknown (${r.unknown})` : `context: ${r.used} of ${r.window} tokens (${r.pct}%)`);
      return 0;
    }
    case 'test-changed': {
      const { runTestChanged } = await import('../lib/test-changed.mjs');
      const m = args.indexOf('--merge');
      if (m >= 0 && (!args[m + 1] || args[m + 1].startsWith('--'))) die('usage: turbo-run test-changed [--merge <sha>]', 2);
      return runTestChanged({ root: root || process.cwd(), merge: m >= 0 ? args[m + 1] : null });
    }
    default:
      die(USAGE);
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code ?? 0; },
  (e) => die(CONFIG_ERROR.test(e?.message) ? e.message.replace(/\s*\r?\n\s*/g, ' ') : e?.stack || String(e)),
);
