#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, gsdCoreDir, runDir, logsDir, locksDir } from '../lib/paths.mjs';
import { DEFAULTS, loadConfig, initConfig, deepMerge } from '../lib/config.mjs';
import { readJson, writeJsonAtomic, ensureDir } from '../lib/fsx.mjs';
import { writeLaneStatus, LANE_STATUSES } from '../lib/run-status.mjs';
import { createClaude, resolveBin } from '../lib/claude.mjs';
import { loadPhases, normalizePhaseId } from '../lib/gsd.mjs';
import { doctor } from '../lib/doctor.mjs';
import { runDaemon } from '../lib/supervisor.mjs';
import { msg } from '../lib/messages.mjs';
import { notify } from '../lib/notify.mjs';

const SELF = fileURLToPath(import.meta.url);
const USAGE = 'usage: turbo-run <doctor|init|start|daemon|status|stop|lane-status|notify|resume|test-changed> [args]';
// GSD runs workflow.test_command through bash -c, so the shell expands the config dir.
const TURBO_TEST_CMD = 'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" test-changed';
const SUPERVISOR_LOG = '.planning/turbo/logs/supervisor.log';
const VALUE_FLAGS = new Set(['--project', '--reason', '--lang', '--autonomy']);
// No path separators: a phase id only ever names p<id>.json inside the run directory.
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
const CONFIG_ERROR = /^invalid turbo config /;
// `claude stop` on a session that no longer runs: "No job matching '<id>'. …"
const SESSION_GONE = /no job matching|not running|already (?:stopped|finished|ended|exited)|not found|no such/i;
const HEARTBEAT_MIN_MS = 10 * 60 * 1000;
const KILL_WAIT_MS = 5000;

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
const pidExists = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const clampPoll = (x) => Math.max(5, Number(x) || 20);
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
// valid pid that exists AND a heartbeat (updatedAt, rewritten every tick) that is recent.
function daemonAlive(pid, updatedAt, pollSeconds) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at) || Date.now() - at > Math.max(HEARTBEAT_MIN_MS, 5 * pollSeconds * 1000)) return false;
  return pidExists(pid);
}
const supAlive = (sup, pollSeconds) => Boolean(sup) && daemonAlive(sup.pid, sup.updatedAt, pollSeconds);

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
      if (daemonAlive(lock.pid, beat, pollSeconds)) return { ok: false, pid: lock.pid };
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
  if (sup.lane) out(`lane: phase ${sup.lane.phase} · session ${sup.lane.sessionId} · restarts ${sup.lane.restarts} · since ${sup.lane.launchedAt}\n  watch: claude attach ${sup.lane.sessionId}`);
}

function fingerprint(root) {
  return (phase) => {
    let head = '';
    try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { /* not a repo */ }
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

function makeCtx(root) {
  const config = runtimeConfig(loadConfig(root));
  const core = gsdCoreDir(root);
  const claude = createClaude({ bin: resolveBin() });
  ensureDir(logsDir(root));
  const logFile = path.join(logsDir(root), 'supervisor.log');
  return {
    root, config, turboRun: `node '${SELF.replace(/\\/g, '/')}'`,
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
    },
  };
}

function start(root) {
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
  const child = spawn(process.execPath, [SELF, 'daemon', '--project', root], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  child.unref();
  fs.closeSync(fd);
  out(`started supervisor pid ${child.pid} (mode ${r.mode})`);
  return 0;
}

async function daemon(root) {
  const ctx = makeCtx(root);
  const lock = acquireLock(root, ctx.config.poll_seconds);
  if (!lock.ok) { out(`already running${lock.pid ? ` (pid ${lock.pid})` : ''}`); return 0; }
  const onSignal = (code) => () => { clearDaemonPid(root, null); releaseLock(root); process.exit(code); };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));
  let final = null;
  try {
    const prev = readJson(supPath(root), null);
    const initial = prev && !prev.finished ? { lane: prev.lane || null, finished: false, halted: false } : { lane: null, finished: false, halted: false };
    // pid on disk before the first tick, so status and a second start see this daemon at once
    writeJsonAtomic(supPath(root), { ...initial, pid: process.pid, updatedAt: new Date().toISOString() });
    ctx.deps.log(`daemon start pid ${process.pid}`);
    final = await runDaemon({ ctx, statePath: supPath(root), initial, intervalMs: ctx.config.poll_seconds * 1000 });
    ctx.deps.log(`daemon exit${final.finished ? ': milestone finished' : final.halted ? ': halted' : ''}`);
  } finally {
    clearDaemonPid(root, final);
    releaseLock(root);
  }
  return 0;
}

// Stops the daemon process only (never the lane session) and clears its pid.
function stopDaemon(root, sup) {
  if (!sup) return;
  if (supAlive(sup, pollOf(root))) {
    killDaemon(root, sup.pid);
    out(`stopped supervisor pid ${sup.pid}`);
  } else if (Number.isInteger(sup.pid) && sup.pid > 0 && pidExists(sup.pid)) {
    out(`pid ${sup.pid} has no recent supervisor heartbeat (last ${sup.updatedAt || 'never'}); not killed`);
  }
  if (sup.pid != null) writeJsonAtomic(supPath(root), { ...readJson(supPath(root), sup), pid: null });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const root = projectArg(args);
  const pos = positional(args);
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
          prev = execFileSync(process.execPath, [tool, 'config-get', 'workflow.test_command', '--default', '', '--raw', '--cwd', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).replace(/\r?\n$/, '');
        } catch (e) {
          const why = typeof e.status === 'number' ? `exit status ${e.status}` : e.code || e.signal || 'failed';
          const detail = String(e.stderr || '').trim().split(/\r?\n/)[0] || '';
          die(`init aborted: gsd-tools config-get workflow.test_command failed (${why})${detail ? `: ${detail}` : ''}; nothing was changed`);
        }
      }
      const res = initConfig(root, { lang, autonomy });
      loadConfig(root); // an existing corrupt config fails init
      if (tool) {
        if (prev && !prev.includes('turbo-run.mjs')) {
          writeJsonAtomic(res.file, deepMerge(readJson(res.file, {}), { test: { full: prev } }));
          out(`kept previous workflow.test_command as test.full: ${prev}`);
        }
        try {
          execFileSync(process.execPath, [tool, 'config-set', 'workflow.test_command', TURBO_TEST_CMD, '--cwd', root], { stdio: 'inherit', windowsHide: true });
        } catch { die('gsd-tools config-set workflow.test_command failed'); }
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
      return daemon(root);
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
      const id = sup?.lane?.sessionId;
      if (id) {
        try {
          createClaude().stop(id);
        } catch (e) {
          if (!SESSION_GONE.test(e.message)) {
            process.stderr.write(`warn: lane session ${id} not stopped: ${e.message}\n`);
            return 1;
          }
        }
      }
      out('stopped');
      return 0;
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
