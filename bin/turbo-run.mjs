#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, gsdCoreDir, runDir, logsDir } from '../lib/paths.mjs';
import { loadConfig, initConfig, deepMerge } from '../lib/config.mjs';
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
const TURBO_TEST_CMD = 'node "$HOME/.claude/turbo/bin/turbo-run.mjs" test-changed';
const SUPERVISOR_LOG = '.planning/turbo/logs/supervisor.log';
const VALUE_FLAGS = new Set(['--project', '--reason', '--lang', '--autonomy']);
// No path separators: a phase id only ever names p<id>.json inside the run directory.
const PHASE_ID = /^[A-Za-z0-9._-]+$/;
const CONFIG_ERROR = /^invalid turbo config /;

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
// EPERM: the process exists but belongs to someone else, so it is alive.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const out = (line) => process.stdout.write(line + '\n');

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
  const config = loadConfig(root);
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
      const res = initConfig(root, { lang, autonomy });
      if (core) {
        const tool = path.join(core, 'bin', 'gsd-tools.cjs');
        let prev = '';
        try {
          prev = execFileSync(process.execPath, [tool, 'config-get', 'workflow.test_command', '--raw', '--cwd', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim().replace(/^"|"$/g, '');
        } catch { /* key unset */ }
        if (/^(null|undefined)$/.test(prev)) prev = '';
        if (prev && !prev.includes('turbo-run.mjs') && res.created) {
          const cfgFile = path.join(root, '.planning', 'turbo', 'config.json');
          writeJsonAtomic(cfgFile, deepMerge(readJson(cfgFile, {}), { test: { full: prev } }));
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
      loadConfig(root); // a corrupt config fails here, not silently inside the detached daemon
      const sup = readJson(supPath(root), null);
      if (sup?.pid && alive(sup.pid)) { out(`already running (pid ${sup.pid})`); printStatus(sup, true); return 0; }
      const r = doctor({ root });
      const failed = r.checks.filter((c) => !c.ok);
      if (r.mode === 'unsupported') {
        for (const c of failed) process.stderr.write(`FAIL ${c.name} ${c.detail}\n`);
        die('doctor: mode unsupported; not starting', 2);
      }
      for (const c of failed) out(`warn ${c.name} ${c.detail}`);
      ensureDir(logsDir(root));
      const fd = fs.openSync(path.join(logsDir(root), 'supervisor.log'), 'a');
      const child = spawn(process.execPath, [SELF, 'daemon', '--project', root], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
      child.unref();
      fs.closeSync(fd);
      out(`started supervisor pid ${child.pid} (mode ${r.mode})`);
      return 0;
    }
    case 'daemon': {
      if (!root) die('no .planning directory found');
      const ctx = makeCtx(root);
      const prev = readJson(supPath(root), null);
      const initial = prev && !prev.finished ? { lane: prev.lane || null, finished: false, halted: false } : { lane: null, finished: false, halted: false };
      // pid on disk before the first tick, so status and a second start see this daemon at once
      writeJsonAtomic(supPath(root), { ...initial, pid: process.pid, updatedAt: new Date().toISOString() });
      ctx.deps.log(`daemon start pid ${process.pid}`);
      await runDaemon({ ctx, statePath: supPath(root), initial, intervalMs: ctx.config.poll_seconds * 1000 });
      return 0;
    }
    case 'status': {
      if (!root) die('no .planning directory found');
      loadConfig(root); // a corrupt config stops the daemon; report it instead of a normal status
      const sup = readJson(supPath(root), null);
      const running = Boolean(sup?.pid && alive(sup.pid));
      if (args.includes('--json')) { out(JSON.stringify({ running, ...sup }, null, 2)); return 0; }
      if (!sup) { out('supervisor: not running (never started)'); return 0; }
      printStatus(sup, running);
      return 0;
    }
    case 'stop': {
      if (!root) die('no .planning directory found');
      const sup = readJson(supPath(root), null);
      if (sup?.pid) {
        try { process.kill(sup.pid); } catch (e) { if (e.code !== 'ESRCH') die(`cannot stop supervisor pid ${sup.pid}: ${e.code || e.message}`); }
      }
      if (sup?.lane?.sessionId) { try { createClaude().stop(sup.lane.sessionId); } catch { /* already gone */ } }
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
      if (!root || !phase || !PHASE_ID.test(phase)) die('resume <phase>');
      const id = normalizePhaseId(phase);
      const sup = readJson(supPath(root), null);
      // a live daemon rewrites supervisor.json every tick and would drop this change
      if (sup?.pid && alive(sup.pid)) die(`supervisor is running (pid ${sup.pid}); run: turbo-run stop, then resume`);
      fs.rmSync(path.join(runDir(root), `p${id}.json`), { force: true });
      if (sup) {
        const lane = sup.lane && String(sup.lane.phase) === id ? { ...sup.lane, notified: {}, restarts: 0, forceRelaunch: true } : sup.lane || null;
        writeJsonAtomic(supPath(root), { ...sup, halted: false, lane });
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
