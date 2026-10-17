import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildSettings, loadConfig } from './config.mjs';
import { attendMark } from './attend.mjs';
import { readProgress } from './phase-progress.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { buildStateFile, planGraph } from './build-queue.mjs';
import { gsdCoreDir, locksDir, logsDir, runDir } from './paths.mjs';
import { readVersion, versionInRange } from './gsd.mjs';
import { pidAlive } from './merge-lock.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fsx.mjs';
import { withFileLock } from './questions.mjs';
import { sessionFreeEnv } from './claude.mjs';
import { killTree } from './headless.mjs';

// Stage 6 B4 (spec §6.1, §6.6, §6.8): the supervisor's side of the build path. Which phases may take it, one runner
// per phase (a lock file with a heartbeat), the detached `turbo-run build N` and the end of its process tree.

export const RUNNER_BEAT_MS = 60000;
export const RUNNER_STALE_MS = 5 * 60000;
export const runnerFile = (root, phase) => path.join(locksDir(root), `build-run-p${phase}.json`);
export const buildLogFile = (root, phase) => path.join(logsDir(root), `build-p${phase}.log`);
const BIN = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));
const RUNNER_RE = /^build-run-p(.+)\.json$/;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// GSD's own commit_docs switch (.planning/config.json, nested or top level): false means GSD commits no plans.
function commitDocsOff(root) {
  const cfg = readJson(path.join(root, '.planning', 'config.json'), null);
  return isObj(cfg) && (cfg.planning?.commit_docs === false || cfg.commit_docs === false);
}

function tracked(root, rel) {
  try {
    return String(execFileSync('git', ['ls-files', '--', rel], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000 })).trim() !== '';
  } catch {
    return false;
  }
}

// spec §6.8: whether phase <N> runs the build path, and why not. A phase that started on it stays on it.
// -> { build: boolean, why: string }
export function buildPathFor(root, phase, opts = {}) {
  const no = (why) => ({ build: false, why });
  if (fs.existsSync(buildStateFile(runDir(root), phase))) return { build: true, why: 'started on the build path' };
  let settings;
  try {
    settings = buildSettings(opts.config ?? loadConfig(root));
  } catch (err) {
    return no(String(err?.message ?? err));
  }
  if (!settings.enabled) return no('build.enabled is false');
  if (attendMark(root, phase)) return no(`phase ${phase} is attended`);
  // spec §6.8: a phase /turbo-phase began finishes there (its step record has a done step)
  if (readProgress(root, phase).done.length) return no(`phase ${phase} started on the lean path (/turbo-phase): it finishes there`);
  const core = 'core' in opts ? opts.core : gsdCoreDir(root);
  if (!core) return no('gsd-core not found');
  const version = readVersion(core) || '';
  if (!versionInRange(version)) return no(`gsd-core ${version || '(no version)'} is outside the tested range`);
  if (commitDocsOff(root)) return no('GSD commit_docs is false: the build path commits plans and summaries');
  if (tracked(root, '.gitmodules')) return no('the project has git submodules: the build path does not build inside them');
  const dir = findPhaseDir(root, phase);
  const plans = dir ? phaseArtifacts(dir).plans : [];
  const open = plans.filter((p) => !p.hasSummary).map((p) => p.id);
  if (open.length && !settings.adoptPlans) {
    return no(`phase ${phase} has GSD plans without a summary (${open.join(', ')}): the lean path finishes them (build.adopt_plans: true lets the build path take them)`);
  }
  if (plans.length) {
    try {
      planGraph(root, phase);
    } catch (err) {
      if (/depends_on cycle/.test(String(err?.message))) return no(String(err.message));
    }
  }
  return { build: true, why: '' };
}

export function runnerOf(root, phase) {
  const rec = readJson(runnerFile(root, phase), null);
  return isObj(rec) && Number.isInteger(rec.pid) ? rec : null;
}

// A runner record whose process runs and whose heartbeat is fresh (Windows reuses pids: the beat decides).
export function runnerAlive(rec, { now = Date.now(), alive = pidAlive, staleMs = RUNNER_STALE_MS } = {}) {
  if (!isObj(rec) || !Number.isInteger(rec.pid) || rec.pid < 1) return false;
  const beat = Date.parse(rec.beat);
  return Number.isFinite(beat) && now - beat <= staleMs && alive(rec.pid);
}

// One `build N` per phase: the runner record locks/build-run-p<N>.json { pid, token, startedAt, beat }, taken when it
// is missing, unreadable, its pid dead, or its beat older than staleMs. An unref'ed heartbeat rewrites beat while the
// record holds this token. -> { release(), record } | { busy: { pid, startedAt, beat } }
export function claimRunner(root, phase, { now = () => Date.now(), alive = pidAlive, beatMs = RUNNER_BEAT_MS, staleMs = RUNNER_STALE_MS } = {}) {
  const file = runnerFile(root, phase);
  const locked = () => new Error(`the runner record of phase ${phase} stayed locked (${path.basename(file)}.lock)`);
  const under = (fn) => withFileLock(`${file}.lock`, fn, { waitMs: 10000, staleMs: 60000, locked });
  const token = `${process.pid}-${randomUUID()}`;
  const stamp = () => new Date(now()).toISOString();
  const taken = under(() => {
    const rec = runnerOf(root, phase);
    if (rec && runnerAlive(rec, { now: now(), alive, staleMs })) return { busy: { pid: rec.pid, startedAt: rec.startedAt ?? null, beat: rec.beat ?? null } };
    const record = { pid: process.pid, token, startedAt: stamp(), beat: stamp() };
    writeJsonAtomic(file, record);
    return { record };
  });
  if (taken.busy) return taken;
  const holds = () => readJson(file, null)?.token === token;
  const timer = setInterval(() => {
    try {
      under(() => {
        if (!holds()) {
          clearInterval(timer);
          return;
        }
        writeJsonAtomic(file, { ...readJson(file, {}), beat: stamp() });
      });
    } catch {
      // again at the next beat
    }
  }, beatMs);
  timer.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      under(() => {
        if (holds()) fs.rmSync(file, { force: true });
      });
    } catch {
      // a held lock: the record goes stale by itself
    }
  };
  return { release, record: taken.record };
}

// The phases whose runner is alive: [{ phase, pid }].
export function runningBuilds(root) {
  let names = [];
  try {
    names = fs.readdirSync(locksDir(root));
  } catch {
    return [];
  }
  return names.map((n) => RUNNER_RE.exec(n)?.[1]).filter(Boolean).map((phase) => ({ phase, rec: runnerOf(root, phase) }))
    .filter(({ rec }) => runnerAlive(rec)).map(({ phase, rec }) => ({ phase, pid: rec.pid }));
}

// `turbo-run build N --project <cwd>` detached, its output appended to logs/build-p<N>.log; --resume when asked or
// when the phase's build state exists (a run without it refuses an existing state). -> { pid }
export function launchBuild({ root, phase, cwd = root, controlRoot = null, resume = false, script = BIN, node = process.execPath }) {
  ensureDir(logsDir(root));
  const resumeArg = resume || fs.existsSync(buildStateFile(runDir(root), phase)) ? ['--resume'] : [];
  const env = { ...sessionFreeEnv(), TURBO_BUILD_LANE: '1', ...(controlRoot ? { TURBO_CONTROL_ROOT: controlRoot } : {}) };
  delete env.NODE_TEST_CONTEXT;
  const fd = fs.openSync(buildLogFile(root, phase), 'a');
  try {
    const child = spawn(node, [script, 'build', String(phase), '--project', cwd, ...resumeArg], { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => {}); // a spawn failure shows as a dead pid
    child.unref();
    return { pid: child.pid };
  } finally {
    fs.closeSync(fd);
  }
}

// Ends the build's process tree and waits up to waitMs for it to go; throws when it survives.
export function stopBuild({ pid }, { waitMs = 5000, kill = killTree, alive = pidAlive } = {}) {
  kill(pid);
  const until = Date.now() + waitMs;
  while (alive(pid)) {
    if (Date.now() >= until) throw new Error(`build pid ${pid} did not stop`);
    sleepSync(100);
  }
}

// What the supervisor calls for build lanes (lib/supervisor.mjs ctx.deps.build).
export function buildLaneDeps(root, config) {
  return {
    pathFor: (phase) => buildPathFor(root, phase, { config }),
    launch: (o) => launchBuild({ root, ...o }),
    // the runner's beat once it has claimed the phase (another pid's record counts by its own beat); before that, a
    // pid launched less than RUNNER_STALE_MS ago
    alive(lane) {
      const rec = runnerOf(root, lane.phase);
      if (rec && runnerAlive(rec)) return true;
      if (rec && rec.pid === lane.pid) return false;
      const launched = Date.parse(lane.launchedAt);
      return Number.isInteger(lane.pid) && lane.pid > 0 && Number.isFinite(launched) && Date.now() - launched < RUNNER_STALE_MS && pidAlive(lane.pid);
    },
    // only the build's own process: its runner record names the pid and beats, or it was launched less than
    // RUNNER_STALE_MS ago (Windows reuses pids: a lane ended hours ago never names a stranger's process)
    stop(lane) {
      if (!Number.isInteger(lane.pid) || lane.pid < 1 || !pidAlive(lane.pid)) return;
      const rec = runnerOf(root, lane.phase);
      const launched = Date.parse(lane.launchedAt);
      const ours = (rec?.pid === lane.pid && runnerAlive(rec)) || (Number.isFinite(launched) && Date.now() - launched < RUNNER_STALE_MS);
      if (ours) stopBuild({ pid: lane.pid });
    },
    running(phase) {
      const rec = runnerOf(root, phase);
      return rec && runnerAlive(rec) ? rec.pid : null;
    },
  };
}

// attend N of a build phase: waits until no runner of the phase is alive (the build paused: no new dispatch, running
// sessions finished and merged). -> { paused }
export async function waitBuildPaused(root, phase, { timeoutMs, pollMs = 2000, out = () => {} } = {}) {
  const until = Date.now() + timeoutMs;
  let said = false;
  for (;;) {
    if (!runnerAlive(runnerOf(root, phase))) return { paused: true };
    if (!said) {
      out(`phase ${phase}: the build pauses: it finishes its running sessions first`);
      said = true;
    }
    if (Date.now() >= until) return { paused: false };
    await sleep(pollMs);
  }
}
