#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, gsdCoreDir, runDir, logsDir, locksDir, dirKey } from '../lib/paths.mjs';
import { DEFAULTS, loadConfig, initConfig, deepMerge } from '../lib/config.mjs';
import { readJson, writeJsonAtomic, ensureDir } from '../lib/fsx.mjs';
import { writeLaneStatus, isAgentAlive, LANE_STATUSES } from '../lib/run-status.mjs';
import { createClaude, resolveBin, laneSessionName } from '../lib/claude.mjs';
import { loadPhases, normalizePhaseId } from '../lib/gsd.mjs';
import { doctor } from '../lib/doctor.mjs';
import { runDaemon } from '../lib/supervisor.mjs';
import { msg } from '../lib/messages.mjs';
import { notify } from '../lib/notify.mjs';
import { PHASE_COMMANDS, runPhaseCommand } from '../lib/cli-phase.mjs';

const SELF = fileURLToPath(import.meta.url);
const USAGE = 'usage: turbo-run <doctor|init|start|daemon|status|stop|lane-status|notify|resume|test-changed|phase-step|staleness|gates|jobs|uat> [args]';
// GSD runs workflow.test_command through bash -c, so the shell expands the config dir.
const TURBO_TEST_CMD = 'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" test-changed';
const SUPERVISOR_LOG = '.planning/turbo/logs/supervisor.log';
const VALUE_FLAGS = new Set(['--project', '--reason', '--lang', '--autonomy', '--mode']);
// No path separators: a phase id only ever names p<id>.json inside the run directory.
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
const CONFIG_ERROR = /^invalid turbo config /;
const HEARTBEAT_MIN_MS = 10 * 60 * 1000;
const KILL_WAIT_MS = 5000;
const START_CONFIRM_MS = 5000;
const EXEC_TIMEOUT_MS = 30000;
// POSIX single quotes; a ' inside becomes '\''.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Why a child process failed, without Node's "Command failed: <argv>" text.
const execWhy = (e) => (typeof e.status === 'number' ? `exit status ${e.status}` : e.code || e.signal || 'failed');

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
function projectArg(args) { const p = flag(args, '--project'); return p ? path.resolve(p) : findProjectRoot(process.cwd()); }
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
  return {
    ...config,
    poll_seconds: clampPoll(config.poll_seconds),
    max_restarts_without_progress: clampInt(config.max_restarts_without_progress, 1, DEFAULTS.max_restarts_without_progress),
    blocked_minutes_before_notify: clampInt(config.blocked_minutes_before_notify, 1, DEFAULTS.blocked_minutes_before_notify),
  };
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

function printStatus(sup, running) {
  out(`supervisor: ${running ? `running pid ${sup.pid}` : 'not running'}${sup.finished ? ' · milestone finished' : ''}${sup.halted ? ' · halted' : ''}`);
  if (sup.failingSince) out(`failing since ${sup.failingSince} · log: ${SUPERVISOR_LOG}`);
  if (sup.lane) out(`lane: phase ${sup.lane.phase} · session ${sup.lane.sessionId} · restarts ${sup.lane.restarts} · mode ${sup.lane.mode || 'safe'} · since ${sup.lane.launchedAt}\n  watch: claude attach ${sup.lane.sessionId}`);
}

function fingerprint(root) {
  return (phase) => {
    let head = '';
    try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL' }).trim(); } catch { /* not a repo, or git hung */ }
    const dir = path.join(root, '.planning', 'phases');
    const raw = String(phase.number);
    const prefixes = [`${raw.replace(/^\d+/, (n) => n.padStart(2, '0'))}-`, `${raw}-`];
    let summaries = 0;
    try {
      for (const d of fs.readdirSync(dir)) if (prefixes.some((p) => d.startsWith(p))) summaries += fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('-SUMMARY.md')).length;
    } catch { /* no phases dir */ }
    return `${head}:${summaries}`;
  };
}

function makeCtx(root, mode = 'safe') {
  const config = runtimeConfig(loadConfig(root));
  const core = gsdCoreDir(root);
  const claude = createClaude({ bin: resolveBin() });
  ensureDir(logsDir(root));
  const logFile = path.join(logsDir(root), 'supervisor.log');
  return {
    root, config, mode: mode === 'full' ? 'full' : 'safe', turboRun: `node ${shQuote(SELF.replace(/\\/g, '/'))}`,
    deps: {
      loadPhases: () => {
        if (!core) throw new Error('gsd-core not found');
        return loadPhases(root, core).phases;
      },
      claude,
      fingerprint: fingerprint(root),
      notify: (key, vars) => notify(config, msg(config.lang, key, vars)),
      now: () => new Date(),
      log: (line) => {
        try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`); } catch { /* logging is best-effort */ }
      },
      // probed right before a launch: a lease revoked mid-tick (stop, resume, another start) launches nothing
      leaseHeld: () => !lostLease(root),
    },
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

async function start(root) {
  const config = runtimeConfig(loadConfig(root)); // a corrupt config fails here, not inside the detached daemon
  const running = () => { const sup = readJson(supPath(root), null); return supAlive(sup, config.poll_seconds) ? sup : null; };
  const already = (sup) => { out(`already running (pid ${sup.pid})`); printStatus(sup, true); return 0; };
  let sup = running();
  if (sup) return already(sup);
  const r = doctor({ root });
  const failed = r.checks.filter((c) => !c.ok);
  if (r.mode === 'unsupported') {
    for (const c of failed) process.stderr.write(`FAIL ${c.name} ${c.detail}\n`);
    die('doctor: mode unsupported; not starting', 2);
  }
  for (const c of failed) out(`warn ${c.name} ${c.detail}`);
  // doctor takes seconds: another start may have launched a daemon meanwhile
  sup = running();
  if (sup) return already(sup);
  ensureDir(logsDir(root));
  const fd = fs.openSync(path.join(logsDir(root), 'supervisor.log'), 'a');
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [SELF, 'daemon', '--project', root, '--mode', r.mode === 'full' ? 'full' : 'safe'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
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
  if (ended && supAlive(last, config.poll_seconds)) return already(last); // another start won the lock
  if (ended && last && last.pid == null && Date.parse(last.updatedAt) >= spawnedAt && (last.finished || last.halted)) {
    out(`supervisor pid ${child.pid} ran and exited`);
    printStatus(last, false);
    return last.finished ? 0 : 1;
  }
  const what = ended ? `exited at once (${ended})` : `did not report within ${START_CONFIRM_MS / 1000} s; check: turbo-run status`;
  process.stderr.write(`supervisor pid ${child.pid} ${what}\n${SUPERVISOR_LOG}:\n${logTail(root)}\n`);
  return 1;
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

async function daemon(root, mode = 'safe') {
  const ctx = makeCtx(root, mode);
  const poll = ctx.config.poll_seconds;
  const lock = acquireLock(root, poll);
  if (!lock.ok) { out(`already running${lock.pid ? ` (pid ${lock.pid})` : ''}`); return 0; }
  const onSignal = (code) => () => { clearDaemonPid(root, null); releaseLock(root); process.exit(code); };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));
  let final = null;
  try {
    const prev = readJson(supPath(root), null);
    // poll_seconds: this daemon's own poll, for the heartbeat window of status, stop and start
    const initial = { lane: prev && !prev.finished ? prev.lane || null : null, finished: false, halted: false, poll_seconds: poll };
    // pid on disk before the first tick, so status and a second start see this daemon at once
    writeJsonAtomic(supPath(root), { ...initial, pid: process.pid, updatedAt: new Date().toISOString() });
    ctx.deps.log(`daemon start pid ${process.pid}`);
    final = await runDaemon({ ctx, statePath: supPath(root), initial, intervalMs: poll * 1000, sleep: leaseSleep(root, ctx.deps.log) });
    ctx.deps.log(`daemon exit${final.finished ? ': milestone finished' : final.halted ? ': halted' : ''}`);
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

// Lane sessions of this checkout: a lane name of this project (any phase) started in it.
function projectLaneAgents(agents, root) {
  const prefix = laneSessionName(root, '');
  const home = dirKey(root);
  return agents.filter((a) => String(a.name).startsWith(prefix) && Boolean(a.cwd) && dirKey(a.cwd) === home);
}

// Runs once the daemon is gone. Stops the lane recorded before and after its death, and every
// alive lane session of this project: a daemon stopped while launching never records the session
// it started. A failed `claude stop` counts as stopped only when claude no longer lists the
// session alive.
function stopLanes(root, before) {
  const after = readJson(supPath(root), null);
  const claude = createClaude();
  const warn = (line) => process.stderr.write(`warn: ${line}\n`);
  const list = () => { try { return claude.list(); } catch (e) { return e; } };
  let ok = true;
  const ids = new Set([before?.lane?.sessionId, after?.lane?.sessionId].filter(Boolean));
  const agents = list();
  if (agents instanceof Error) {
    warn(`cannot list sessions (${agents.message}); lane sessions missing from supervisor.json were not checked`);
    ok = false;
  } else {
    for (const a of projectLaneAgents(agents, root)) if (isAgentAlive(a)) ids.add(a.id);
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
  return 0;
}

// GSD 1.16 with an empty workflow.test_command runs: xcodebuild test for an Xcode project (within
// depth 2, not under node_modules; post-merge gate), else `make test` for a Makefile with a
// test: target, else `just test` for a Justfile, else `npm test` when package.json exists.
// turbo's default full command is GSD's own choice only in the npm case, and usable only with a
// test script. Returns why it is not, or null.
function npmTestBlocker(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const isX = (n) => n.endsWith('.xcodeproj');
  let top = [];
  try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { /* reported below as no package.json */ }
  for (const e of top) if (isX(e.name)) return `GSD runs xcodebuild test for ${e.name}`;
  for (const e of top) {
    if (!e.isDirectory() || e.name === 'node_modules') continue;
    let names = [];
    try { names = fs.readdirSync(path.join(root, e.name)); } catch { /* unreadable */ }
    const x = names.find(isX);
    if (x) return `GSD runs xcodebuild test for ${e.name}/${x}`;
  }
  if (has('Makefile') && /^test:/m.test(read('Makefile'))) return 'GSD runs make test (Makefile has a test target)';
  if (has('Justfile') || has('justfile')) return 'GSD runs just test (Justfile)';
  if (!has('package.json')) return 'no package.json';
  let pkg = null;
  try { pkg = JSON.parse(read('package.json').replace(/^\uFEFF/, '')); } catch { return 'package.json cannot be parsed'; }
  const script = pkg?.scripts?.test;
  return typeof script === 'string' && script.trim() ? null : 'package.json has no test script';
}

// The full command test-changed falls back to: an explicitly set test.full, or the default
// `npm test` where GSD itself would run it. Anything else would let a gate pass on a subset.
function knownFullCommand(root, config) {
  const full = config.test?.full;
  if (full !== DEFAULTS.test.full) return typeof full === 'string' && full.trim() ? { full } : { why: 'test.full is empty or not a string' };
  const why = npmTestBlocker(root);
  return why ? { why } : { full };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const root = projectArg(args);
  const pos = positional(args);
  if (PHASE_COMMANDS.has(cmd)) {
    if (!root) die('no .planning directory found');
    return runPhaseCommand(cmd, args, { root });
  }
  switch (cmd) {
    case 'doctor': {
      const r = doctor({ root });
      if (args.includes('--json')) out(JSON.stringify(r, null, 2));
      else { for (const c of r.checks) out(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name} ${c.detail}`); out(`mode: ${r.mode}`); }
      return r.mode === 'unsupported' ? 2 : 0;
    }
    case 'init': {
      if (!root) die('no .planning directory found');
      const lang = flag(args, '--lang', 'en');
      const autonomy = flag(args, '--autonomy', 'standard');
      if (!['en', 'ru'].includes(lang) || !['standard', 'max'].includes(autonomy)) die('init [--lang en|ru] [--autonomy standard|max]');
      const core = gsdCoreDir(root);
      const tool = core && path.join(core, 'bin', 'gsd-tools.cjs');
      // Read the previous test command before anything is written: it is never overwritten
      // without first being kept as test.full.
      let prev = '';
      if (tool) {
        try {
          prev = execFileSync(process.execPath, [tool, 'config-get', 'workflow.test_command', '--default', '', '--raw', '--cwd', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL' }).replace(/\r?\n$/, '');
        } catch (e) {
          const detail = String(e.stderr || '').trim().split(/\r?\n/)[0] || '';
          die(`init aborted: gsd-tools config-get workflow.test_command failed (${execWhy(e)})${detail ? `: ${detail}` : ''}; nothing was changed`);
        }
      }
      const res = initConfig(root, { lang, autonomy });
      const config = loadConfig(root); // an existing corrupt config fails init
      if (tool) {
        const prevIsTurbo = prev.includes('turbo-run.mjs');
        let known;
        if (prev && !prevIsTurbo) {
          writeJsonAtomic(res.file, deepMerge(readJson(res.file, {}), { test: { full: prev } }));
          out(`kept previous workflow.test_command as test.full: ${prev}`);
          known = { full: prev };
        } else {
          known = knownFullCommand(root, config);
        }
        if (known.full !== undefined) {
          try {
            execFileSync(process.execPath, [tool, 'config-set', 'workflow.test_command', TURBO_TEST_CMD, '--cwd', root], { stdio: 'inherit', windowsHide: true, timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL' });
          } catch (e) { die(`gsd-tools config-set workflow.test_command failed (${execWhy(e)})`); }
          out(`workflow.test_command set to turbo-run test-changed (full test command: ${known.full})`);
        } else {
          // GSD keeps choosing the test runner itself; nothing in the GSD config changes
          out(`no known full test command: ${known.why}`);
          out('targeted tests not enabled: set test.full in .planning/turbo/config.json, then run init again');
          if (prevIsTurbo) out('warn: workflow.test_command already runs turbo-run test-changed, but no full test command is known: set test.full and run init again, or reset workflow.test_command (see the README, Uninstall)');
        }
      } else {
        out('gsd-core not found: workflow.test_command not set');
      }
      out(`${res.created ? 'created' : 'kept'} ${res.file}`);
      return 0;
    }
    case 'start': {
      if (!root) die('no .planning directory found');
      return start(root);
    }
    case 'daemon': {
      if (!root) die('no .planning directory found');
      return daemon(root, flag(args, '--mode', 'safe'));
    }
    case 'status': {
      if (!root) die('no .planning directory found');
      const config = runtimeConfig(loadConfig(root)); // a corrupt config stops the daemon; report it instead of a normal status
      const sup = readJson(supPath(root), null);
      const running = supAlive(sup, config.poll_seconds);
      if (args.includes('--json')) { out(JSON.stringify({ running, ...sup }, null, 2)); return 0; }
      if (!sup) { out('supervisor: not running (never started)'); return 0; }
      printStatus(sup, running);
      return 0;
    }
    case 'stop': {
      if (!root) die('no .planning directory found');
      const sup = readJson(supPath(root), null);
      stopDaemon(root, sup);
      // supervisor.json may be missing (never started) or unreadable for any reason: this
      // project's lane sessions are swept either way
      return stopLanes(root, sup);
    }
    case 'lane-status': {
      const [phase, status] = pos;
      if (!root) die('no .planning directory found');
      if (!phase || !PHASE_ID.test(phase) || !LANE_STATUSES.includes(status)) die(`lane-status <phase> <${LANE_STATUSES.join('|')}> [--reason <text>]`);
      const id = normalizePhaseId(phase);
      writeLaneStatus(root, id, status, { reason: flag(args, '--reason') });
      out(`lane ${id}: ${status}`);
      return 0;
    }
    case 'notify': {
      const config = root ? loadConfig(root) : { notify: { desktop: true } };
      await notify(config, { title: pos[0] || 'gsd-turbo', body: pos[1] || '' });
      return 0;
    }
    case 'resume': {
      const [phase] = pos;
      if (!root || !phase || !PHASE_ID.test(phase)) die('resume <phase> [--start]');
      const id = normalizePhaseId(phase);
      // a live daemon (for example one waiting for the owner) rewrites supervisor.json every
      // tick; stop it first. The lane session is left alone: forceRelaunch replaces it.
      stopDaemon(root, readJson(supPath(root), null));
      fs.rmSync(path.join(runDir(root), `p${id}.json`), { force: true });
      const sup = readJson(supPath(root), null);
      if (sup) {
        const lane = sup.lane && String(sup.lane.phase) === id ? { ...sup.lane, notified: {}, restarts: 0, forceRelaunch: true } : sup.lane || null;
        writeJsonAtomic(supPath(root), { ...sup, pid: null, finished: false, halted: false, lane });
      }
      if (args.includes('--start')) {
        out(`phase ${id} cleared`);
        return start(root);
      }
      out(`phase ${id} cleared; run: turbo-run start`);
      return 0;
    }
    case 'test-changed': {
      const { runTestChanged } = await import('../lib/test-changed.mjs');
      return runTestChanged({ root: root || process.cwd() });
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
