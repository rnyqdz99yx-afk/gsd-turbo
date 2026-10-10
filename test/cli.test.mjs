import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { laneSessionName } from '../lib/claude.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const run = (args, cwd, env = process.env, nodeArgs = []) => execFileSync(process.execPath, [...nodeArgs, CLI, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// Async, so this process keeps reaping children the CLI kills (no POSIX zombies).
const runAsync = (args, cwd, env = process.env, nodeArgs = []) => new Promise((resolve) => {
  execFile(process.execPath, [...nodeArgs, CLI, ...args], { cwd, env, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
  });
});

const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const TURBO_TEST_CMD = 'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" test-changed';
// Far above any real pid limit (Linux 2^22, macOS 99999; Windows pids are small multiples of 4).
const DEAD_PID = 2147483644;
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const runDirOf = (root) => path.join(root, '.planning', 'turbo', 'run');
const lockOf = (root) => path.join(root, '.planning', 'turbo', 'locks', 'daemon.lock');
const readJsonFile = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readSup = (root) => readJsonFile(path.join(runDirOf(root), 'supervisor.json'));
function writeSup(root, obj) {
  fs.mkdirSync(runDirOf(root), { recursive: true });
  fs.writeFileSync(path.join(runDirOf(root), 'supervisor.json'), JSON.stringify(obj));
}
function writeLock(root, obj) {
  fs.mkdirSync(path.dirname(lockOf(root)), { recursive: true });
  fs.writeFileSync(lockOf(root), JSON.stringify(obj));
}
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const pidExists = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function plainProject() {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning'));
  return root;
}

// Stand-ins written into the fake project; they run as CommonJS scripts.
function fakeClaude() {
  const fs = require('fs');
  const path = require('path');
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(__dirname, 'claude-argv.jsonl'), JSON.stringify(args) + '\n');
  // the calling session's ids a launched lane sees (none expected)
  if (args[0] === '--bg') fs.appendFileSync(path.join(__dirname, 'claude-env.jsonl'), JSON.stringify({ sid: process.env.CLAUDE_CODE_SESSION_ID ?? null, job: process.env.CLAUDE_JOB_DIR ?? null }) + '\n');
  const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'behavior.json'), 'utf8'));
  const [cmd, id = ''] = args;
  if (cmd === '--version') console.log(`${b.version} (Claude Code)`);
  else if (cmd === 'agents') {
    if (b.agentsFail) { console.error('agents broke'); process.exitCode = 1; } else console.log(JSON.stringify(b.agents || []));
  } else if (cmd === '--bg') console.log('backgrounded abcdef123456');
  else if (cmd === 'stop' || cmd === 'rm') {
    if (id.startsWith('gone')) { console.error(`No job matching '${id}'. Run 'claude agents' to list running sessions.`); process.exitCode = 1; }
    if (id.startsWith('stuck')) { console.error('permission denied'); process.exitCode = 1; }
    if (id.startsWith('lost')) { console.error(`session ${id} not found`); process.exitCode = 1; }
  } else process.exitCode = 2;
}
// Preloaded with --require: records every execFileSync call (command, first args, timeout) and
// answers every execFile call (desktop notifications) without running anything.
function execSpyPreload() {
  const cp = require('node:child_process');
  const fs = require('node:fs');
  const log = (rec) => fs.appendFileSync(process.env.TURBO_SPY_LOG, JSON.stringify(rec) + '\n');
  const sync = cp.execFileSync;
  cp.execFileSync = function (cmd, args, opts) {
    log({ cmd, args: (args || []).slice(0, 3), timeout: opts && opts.timeout !== undefined ? opts.timeout : null });
    return sync.apply(this, arguments);
  };
  cp.execFile = function (cmd, args, opts, cb) {
    const done = [opts, cb].find((f) => typeof f === 'function');
    log({ execFile: cmd, args, title: (opts && opts.env && opts.env.TURBO_NOTIFY_TITLE) || null });
    process.nextTick(() => done(null, '', ''));
    return null;
  };
  require('node:module').syncBuiltinESMExports();
}
function execSpy(dir) {
  const preload = path.join(dir, 'exec-spy.cjs');
  const log = path.join(dir, 'exec-spy.jsonl');
  fs.writeFileSync(preload, `(${execSpyPreload})();\n`);
  return { nodeArgs: ['--require', preload], env: { TURBO_SPY_LOG: log }, calls: () => readLines(log) };
}
function fakeGsd() {
  const fs = require('fs');
  const path = require('path');
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(__dirname, 'gsd-argv.jsonl'), JSON.stringify(args) + '\n');
  const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'behavior.json'), 'utf8'));
  if (args[0] === 'config-get' && args[1] === 'context_window') {
    // absent unless set: the --default value, else GSD's schema default
    const d = args.indexOf('--default');
    process.stdout.write(b.contextWindow ?? (d >= 0 ? args[d + 1] : '200000'));
  } else if (args[0] === 'config-get') {
    process.stdout.write(b.configGet.out);
    if (b.configGet.exit) { console.error('config-get broke'); process.exitCode = b.configGet.exit; }
  } else if (args[0] === 'init' && args[1] === 'manager') process.stdout.write(JSON.stringify({ milestone_version: 'v1', phases: b.phases }));
  else if (args[0] === 'loop' && args[1] === 'render-hooks') process.stdout.write(JSON.stringify({ point: args[2], activeHooks: [] }));
  else if (args[0] !== 'config-set') process.exitCode = 2;
}

// A project whose claude (PATH) and gsd-core (.claude/gsd-core in the project) are local fakes:
// nothing reaches a real claude or GSD install.
function fakeProject({
  phases = [{ number: '1', name: 'one', phase_complete: true }],
  configGet = { out: '', exit: 0 },
  contextWindow, // GSD's context_window in .planning/config.json (a string), absent by default
  claudeVersion = '2.1.291',
  config = { notify: { desktop: false, telegram: false } },
  agents = [],
} = {}) {
  const root = tmpDir('cli');
  const bin = path.join(root, 'fake-bin');
  const core = path.join(root, '.claude', 'gsd-core');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  if (config) fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(core, 'VERSION'), '1.16.0');
  fs.writeFileSync(path.join(core, 'bin', 'gsd-tools.cjs'), `(${fakeGsd})();\n`);
  fs.writeFileSync(path.join(core, 'bin', 'behavior.json'), JSON.stringify({ configGet, contextWindow, phases }));
  const setClaude = (patch) => fs.writeFileSync(path.join(bin, 'behavior.json'), JSON.stringify({ version: claudeVersion, agents, ...patch }));
  setClaude({});
  fs.writeFileSync(path.join(bin, 'claude-fake.cjs'), `(${fakeClaude})();\n`);
  // win32: an npm-style shim that resolveBin maps to node + claude-fake.cjs (never run by cmd.exe)
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@"%dp0%\\claude-fake.cjs" %*\r\n');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\n(${fakeClaude})();\n`, { mode: 0o755 });
  // stage 2: doctor reports full mode only with the turbo-phase skill and the turbo-uat agent installed
  const home = path.join(root, 'claude-home');
  fs.mkdirSync(path.join(home, 'skills', 'turbo-phase'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'turbo-phase', 'SKILL.md'), 'x');
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', 'turbo-uat.md'), 'x');
  const env = { ...process.env, [PATH_KEY]: `${bin}${path.delimiter}${process.env[PATH_KEY]}`, CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') };
  return {
    root,
    env,
    setClaude,
    gsdCalls: () => readLines(path.join(core, 'bin', 'gsd-argv.jsonl')),
    claudeCalls: () => readLines(path.join(bin, 'claude-argv.jsonl')),
  };
}

function sleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  return child;
}
const exited = (child, ms = 8000) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
  const timer = setTimeout(() => resolve(false), ms);
  child.once('exit', () => { clearTimeout(timer); resolve(true); });
});
// A daemon run in the background; killed after the test.
function spawnCli(t, args, p, { nodeArgs = [], env = {}, cli = CLI } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, cli, ...args], { cwd: p.root, env: { ...p.env, ...env }, stdio: 'ignore', windowsHide: true });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  return child;
}
const logOf = (root) => { try { return fs.readFileSync(path.join(root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8'); } catch { return ''; } };
async function waitFor(fn, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const v = fn();
    if (v) return v;
  }
  return null;
}

test('lane-status writes the run file from inside the project', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning', 'phases'), { recursive: true });
  run(['lane-status', '4', 'needs-owner', '--reason', 'owner sign-off'], path.join(root, '.planning', 'phases'));
  const rec = JSON.parse(fs.readFileSync(path.join(root, '.planning', 'turbo', 'run', 'p4.json'), 'utf8'));
  assert.equal(rec.status, 'needs-owner');
  assert.equal(rec.reason, 'owner sign-off');
});

// The session may still run when it records done (Claude Code scratch files, GSD hook files): only the
// supervisor removes the temp directory, once it has removed the session.
test('lane-status N done records done and removes nothing', () => {
  const root = plainProject();
  const tmp = path.join(runDirOf(root), 'tmp', 'p3');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'scratch.txt'), 'x');
  assert.match(run(['lane-status', '03', 'done', '--reason', 'closed'], root), /^lane 3: done\r?\n$/);
  assert.ok(fs.existsSync(path.join(tmp, 'scratch.txt')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDirOf(root), 'p3.json'), 'utf8')).status, 'done');
});

test('lane-status rejects an unknown status with a non-zero exit', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning'));
  assert.throws(() => run(['lane-status', '4', 'bogus'], root));
});

test('status without a supervisor prints not running', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning'));
  assert.match(run(['status'], root), /not running/i);
});

test('unknown command exits non-zero with usage', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning'));
  assert.throws(() => run(['frobnicate'], root), /usage/i);
});

test('a corrupt turbo config is a one-line error with exit 1, never a stack trace', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), '{\n  "lang": \n}\n');
  for (const cmd of ['status', 'notify']) {
    assert.throws(() => run([cmd], root), (err) => {
      assert.equal(err.status, 1, cmd);
      assert.match(err.stderr, /invalid turbo config/, cmd);
      assert.equal(err.stderr.trim().split(/\r?\n/).length, 1, `${cmd}: ${err.stderr}`);
      assert.doesNotMatch(err.stderr, /\bat .+:\d+:\d+/, cmd);
      return true;
    });
  }
});

test('test-changed with a corrupt turbo config is a one-line error with exit 1', async () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), '{\n  "test": \n}\n');
  const r = await runAsync(['test-changed'], root);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /invalid turbo config/);
  assert.equal(r.stderr.trim().split(/\r?\n/).length, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /\bat .+:\d+:\d+/);
});

test('test-changed prints one [turbo-test] line and exits with the test command code', async () => {
  const root = tmpDir('cli'); // not a git repository: always the full command
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ test: { full: 'node -e "process.exit(3)"' } }));
  const r = await runAsync(['test-changed'], root);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '[turbo-test] full: not a git repository\n');
  assert.equal(r.stderr, '');
});

test('status shows failingSince in text and json output', () => {
  const root = tmpDir('cli');
  const run1 = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run1, { recursive: true });
  const since = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(run1, 'supervisor.json'), JSON.stringify({ lane: null, finished: false, halted: false, failingSince: since }));
  assert.match(run(['status'], root), new RegExp(`failing since ${since.replace(/\./g, '\\.')}`));
  const json = JSON.parse(run(['status', '--json'], root));
  assert.equal(json.running, false);
  assert.equal(json.failingSince, since);
});

test('a daemon counts as running only with a valid existing pid and a recent heartbeat', () => {
  const root = plainProject();
  const cases = [
    [{ pid: process.pid, updatedAt: ago(0) }, true],
    [{ pid: process.pid, updatedAt: ago(30) }, false],
    [{ pid: process.pid }, false],
    [{ pid: -1, updatedAt: ago(0) }, false],
    [{ pid: 0, updatedAt: ago(0) }, false],
    [{ pid: String(process.pid), updatedAt: ago(0) }, false],
    [{ pid: DEAD_PID, updatedAt: ago(0) }, false],
  ];
  for (const [sup, want] of cases) {
    writeSup(root, sup);
    assert.equal(JSON.parse(run(['status', '--json'], root)).running, want, JSON.stringify(sup));
  }
});

test('the heartbeat window is max(10 min, 5 x poll_seconds) with poll_seconds clamped', () => {
  const root = plainProject();
  const cfg = path.join(root, '.planning', 'turbo', 'config.json');
  writeSup(root, { pid: process.pid, updatedAt: ago(20) });
  fs.writeFileSync(cfg, JSON.stringify({ poll_seconds: 600 }));
  assert.equal(JSON.parse(run(['status', '--json'], root)).running, true);
  fs.writeFileSync(cfg, JSON.stringify({ poll_seconds: 'often' }));
  assert.equal(JSON.parse(run(['status', '--json'], root)).running, false);
});

test('a pid the OS refuses to signal (EPERM) still counts as an existing process', () => {
  const root = plainProject();
  writeSup(root, { pid: process.platform === 'win32' ? 4 : 1, updatedAt: ago(0) });
  assert.equal(JSON.parse(run(['status', '--json'], root)).running, true);
});

test('heartbeat window: poll capped at 3600 s, the daemon\'s own poll counts, a heartbeat from the future is stale', () => {
  const root = plainProject();
  const cfg = path.join(root, '.planning', 'turbo', 'config.json');
  const running = () => JSON.parse(run(['status', '--json'], root)).running;
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  for (const poll of ['1e999', '99999999']) {
    fs.writeFileSync(cfg, `{"poll_seconds": ${poll}}`);
    writeSup(root, { pid: process.pid, updatedAt: ago(6 * 60) });
    assert.equal(running(), false, `poll ${poll}, 6 h old`);
    writeSup(root, { pid: process.pid, updatedAt: ago(4 * 60) });
    assert.equal(running(), true, `poll ${poll}, 4 h old`);
  }
  fs.rmSync(cfg);
  writeSup(root, { pid: process.pid, updatedAt: ago(20), poll_seconds: 600 });
  assert.equal(running(), true, 'running daemon polls every 600 s');
  writeSup(root, { pid: process.pid, updatedAt: ago(-30) });
  assert.equal(running(), false, '30 min in the future');
  writeSup(root, { pid: process.pid, updatedAt: ago(-1) });
  assert.equal(running(), true, '1 min clock skew');
});

test('stop kills a live daemon, clears its pid and stops the lane session', async (t) => {
  const p = fakeProject();
  const child = sleeper(t);
  writeSup(p.root, { pid: child.pid, updatedAt: ago(0), lane: { phase: '4', sessionId: 'abc123' } });
  const r = await runAsync(['stop'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await exited(child), 'daemon process still alive');
  assert.equal(readSup(p.root).pid, null);
  assert.deepEqual(p.claudeCalls().filter((a) => a[0] === 'stop'), [['stop', 'abc123']]);
});

test('stop never kills a pid without a recent heartbeat, and clears it', async (t) => {
  const p = fakeProject();
  const child = sleeper(t);
  writeSup(p.root, { pid: child.pid, updatedAt: ago(30) });
  const r = await runAsync(['stop'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /not killed/);
  assert.equal(await exited(child, 300), false);
  assert.ok(pidExists(child.pid));
  assert.equal(readSup(p.root).pid, null);
  assert.equal(readJsonFile(lockOf(p.root)).pid, null, 'the lock ends the lease of a daemon that only looks dead');
});

test('stop counts a lane session as stopped only when claude no longer lists it alive', async () => {
  const p = fakeProject();
  const stopWith = (id, agents) => {
    p.setClaude({ agents });
    writeSup(p.root, { pid: null, lane: { phase: '4', sessionId: id } });
    return runAsync(['stop'], p.root, p.env);
  };
  let r = await stopWith('gone1', []);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /stopped/);
  r = await stopWith('stuck2', [{ id: 'stuck2', name: 'x', cwd: p.root, state: 'done' }]);
  assert.equal(r.code, 0, `ended session: ${r.stderr}`);
  r = await stopWith('stuck1', [{ id: 'stuck1', name: 'x', cwd: p.root, state: 'working' }]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /^warn: lane session stuck1 not stopped: .*permission denied/m);
  // an error text that only looks like "already gone" proves nothing while the session is listed alive
  r = await stopWith('lost1', [{ id: 'lost1', name: 'x', cwd: p.root, state: 'working' }]);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /^warn: lane session lost1 not stopped: .*not found/m);
});

test('stop also stops alive lane sessions of this project that supervisor.json never recorded', async () => {
  const p = fakeProject();
  const lane = (phase) => laneSessionName(p.root, phase);
  p.setClaude({ agents: [
    { id: 'late01', name: lane('5'), cwd: p.root, state: 'working' },
    { id: 'late02', name: lane('6'), cwd: p.root, state: 'blocked' },
    { id: 'done01', name: lane('3'), cwd: p.root, state: 'done' },
    { id: 'other1', name: lane('5'), cwd: path.join(p.root, 'elsewhere'), state: 'working' },
    { id: 'user01', name: 'my-own-session', cwd: p.root, state: 'working' },
  ] });
  writeSup(p.root, { pid: null, lane: { phase: '4', sessionId: 'abc123' } });
  let r = await runAsync(['stop'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(p.claudeCalls().some((a) => a[0] === 'agents' && a.includes('--json') && a.includes('--all')));
  assert.deepEqual(p.claudeCalls().filter((a) => a[0] === 'stop').map((a) => a[1]).sort(), ['abc123', 'late01', 'late02']);

  // the scan cannot run: the recorded lane is still stopped, and stop says what it could not check
  p.setClaude({ agentsFail: true });
  writeSup(p.root, { pid: null, lane: { phase: '4', sessionId: 'abc999' } });
  r = await runAsync(['stop'], p.root, p.env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /cannot list/);
  assert.ok(p.claudeCalls().some((a) => a[0] === 'stop' && a[1] === 'abc999'));
});

test('daemon replaces a dead lock, runs to the end, then clears its pid and lock', async () => {
  const p = fakeProject();
  writeLock(p.root, { pid: DEAD_PID, at: ago(0) });
  const r = await runAsync(['daemon'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  const sup = readSup(p.root);
  assert.equal(sup.finished, true);
  assert.equal(sup.pid, null);
  assert.equal(sup.poll_seconds, 20, 'the daemon records its own poll for the heartbeat window');
  assert.equal(fs.existsSync(lockOf(p.root)), false);
  assert.ok(p.claudeCalls().some((a) => a[0] === 'agents'));
});

test('daemon.lock alone decides the lease: a foreign lock or {pid: null} ends it, a foreign supervisor.json or read errors do not', async (t) => {
  const mk = () => fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }], config: { notify: { desktop: false, telegram: false }, poll_seconds: 5 } });
  const [a, b, c, d, e] = [mk(), mk(), mk(), mk(), mk()];
  const other = sleeper(t).pid; // the daemon that took over after this one looked dead
  const supFile = (p) => path.join(runDirOf(p.root), 'supervisor.json');
  // Each change is written as soon as that daemon's own first tick is seen, a whole poll before its
  // lease check: waiting for all daemons first let a fast one tick again and overwrite the change.
  const setUp = async (p, change) => {
    const ch = spawnCli(t, ['daemon'], p);
    const s = await waitFor(() => { const v = readSup(p.root); return v?.pid === ch.pid && v.lane ? v : null; }, 10000);
    assert.ok(s, logOf(p.root));
    const at = new Date().toISOString();
    change(s, at);
    return { ch, at };
  };
  const [ra, rb, rc, rd, re] = await Promise.all([
    setUp(a, (s, at) => writeSup(a.root, { ...s, pid: other, updatedAt: at })), // a: only supervisor.json names another pid
    setUp(b, (s, at) => writeLock(b.root, { pid: other, at })), // b: the lock names another pid
    setUp(c, (s, at) => { fs.writeFileSync(supFile(c), '{ not json'); writeLock(c.root, { pid: other, at }); }), // c: state unreadable, lock taken over
    setUp(d, () => { fs.writeFileSync(supFile(d), '{ not json'); fs.rmSync(lockOf(d.root)); }), // d: read errors only
    setUp(e, (s, at) => writeLock(e.root, { pid: null, at })), // e: stop cleared the lock (stale heartbeat)
  ]);
  const [eb, ec, ee] = await Promise.all([exited(rb.ch, 12000), exited(rc.ch, 12000), exited(re.ch, 12000)]);
  assert.ok(eb, `daemon b still running: ${logOf(b.root)}`);
  assert.ok(ec, `daemon c still running: ${logOf(c.root)}`);
  assert.ok(ee, `daemon e still running: ${logOf(e.root)}`);
  assert.equal(readJsonFile(lockOf(b.root)).pid, other, 'the new owner\'s lock is left alone');
  assert.equal(fs.readFileSync(supFile(c), 'utf8'), '{ not json', 'no write after the lease is lost to another owner');
  assert.equal(readSup(e.root).pid, null, 'a daemon whose lock stop cleared leaves no pid behind');
  for (const p of [b, c, e]) assert.match(logOf(p.root), /lease lost/);
  // a and d keep running and write their own state again on their next tick
  for (const [p, r] of [[a, ra], [d, rd]]) {
    const again = await waitFor(() => { const s = readSup(p.root); return s?.pid === r.ch.pid && Date.parse(s.updatedAt) > Date.parse(r.at) ? s : null; }, 12000);
    assert.ok(again, logOf(p.root));
    assert.equal(r.ch.exitCode, null, 'still running');
    assert.doesNotMatch(logOf(p.root), /lease lost/);
  }
});

test('stop with a stale heartbeat clears the lock too; a daemon that only looked dead ends its lease and leaves no pid', async (t) => {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }], config: { notify: { desktop: false, telegram: false }, poll_seconds: 5 } });
  const ch = spawnCli(t, ['daemon'], p);
  const s = await waitFor(() => { const v = readSup(p.root); return v?.pid === ch.pid && v.lane ? v : null; }, 10000);
  assert.ok(s, logOf(p.root));
  writeSup(p.root, { ...s, updatedAt: ago(30) }); // looks hibernated, right after its tick
  const r = await runAsync(['stop'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /not killed/);
  assert.equal(readJsonFile(lockOf(p.root)).pid, null, 'the lock no longer names the daemon');
  assert.ok(await exited(ch, 12000), `daemon still running: ${logOf(p.root)}`);
  assert.equal(readSup(p.root).pid, null);
  assert.match(logOf(p.root), /lease lost/);
});

test('stop revokes the lock lease of a daemon that an unreadable supervisor.json no longer names', async (t) => {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }], config: { notify: { desktop: false, telegram: false }, poll_seconds: 5 } });
  const ch = spawnCli(t, ['daemon'], p);
  const s = await waitFor(() => { const v = readSup(p.root); return v?.pid === ch.pid && v.lane ? v : null; }, 10000);
  assert.ok(s, logOf(p.root));
  fs.writeFileSync(path.join(runDirOf(p.root), 'supervisor.json'), '{ not json'); // right after its tick
  const r = await runAsync(['stop'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`daemon\\.lock names pid ${ch.pid}.*exits at its next check`));
  assert.equal(readJsonFile(lockOf(p.root)).pid, null);
  assert.ok(await exited(ch, 12000), `daemon still running: ${logOf(p.root)}`);
  assert.match(logOf(p.root), /lease lost/);
  assert.equal(readSup(p.root).pid, null, 'the daemon leaves no pid behind');
});

test('stop sweeps this project\'s alive lane sessions even when supervisor.json is missing or unreadable', async () => {
  const p = fakeProject();
  p.setClaude({ agents: [{ id: 'late01', name: laneSessionName(p.root, '5'), cwd: p.root, state: 'working' }] });
  let r = await runAsync(['stop'], p.root, p.env); // never started: no supervisor.json
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(p.claudeCalls().filter((x) => x[0] === 'stop').map((x) => x[1]), ['late01']);
  fs.mkdirSync(runDirOf(p.root), { recursive: true });
  fs.writeFileSync(path.join(runDirOf(p.root), 'supervisor.json'), '{ not json');
  r = await runAsync(['stop'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(p.claudeCalls().filter((x) => x[0] === 'stop').map((x) => x[1]), ['late01', 'late01']);
});

test('status and stop name the GSD gates and docs commits a stopped phase left off, and never restore them (I4)', async () => {
  const p = fakeProject();
  const gatesDir = path.join(p.root, '.planning', 'turbo', 'gates');
  const docs = path.join(runDirOf(p.root), 'docs-p4.json');
  fs.mkdirSync(gatesDir, { recursive: true });
  fs.mkdirSync(runDirOf(p.root), { recursive: true });
  const state = JSON.stringify({ phase: '3', original: { 'workflow.code_review': true } });
  fs.writeFileSync(path.join(gatesDir, 'p3.json'), state);
  fs.writeFileSync(docs, JSON.stringify({ key: 'phase_commit_docs.4', original: '__turbo_absent__' }));
  const want = ['gates off: phase 3 (run: turbo-run gates restore 3)', 'docs commits off: phase 4 (run: turbo-run gates docs-restore 4)'];
  // never started, then with a supervisor record: both text views list the leftovers
  for (const sup of [null, { lane: null, finished: true, halted: false, pid: null }]) {
    if (sup) writeSup(p.root, sup);
    const text = run(['status'], p.root, p.env);
    for (const l of want) assert.ok(text.includes(`${l}\n`), text);
    assert.deepEqual(JSON.parse(run(['status', '--json'], p.root, p.env)).gatesOff, ['3']);
  }
  const r = await runAsync(['stop'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  for (const l of want) assert.ok(r.stdout.includes(`${l}\n`), r.stdout);
  assert.equal(fs.readFileSync(path.join(gatesDir, 'p3.json'), 'utf8'), state, 'never restored by status or stop');
  assert.ok(fs.existsSync(docs));
  assert.equal(p.gsdCalls().length, 0, 'no gsd-tools call: nothing was restored');
  fs.rmSync(gatesDir, { recursive: true });
  fs.rmSync(docs);
  assert.doesNotMatch(run(['status'], p.root, p.env), /off: phase/);
  assert.deepEqual(JSON.parse(run(['status', '--json'], p.root, p.env)).gatesOff, []);
  assert.doesNotMatch((await runAsync(['stop'], p.root, p.env)).stdout, /off: phase/);
});

test('a daemon that dies on a fatal error notifies the owner', async () => {
  const p = fakeProject({ config: { notify: { desktop: true, telegram: false } } });
  fs.mkdirSync(path.join(runDirOf(p.root), 'supervisor.json'), { recursive: true }); // state cannot be written
  const spy = execSpy(p.root);
  const r = await runAsync(['daemon'], p.root, { ...p.env, ...spy.env }, spy.nodeArgs);
  assert.notEqual(r.code, 0);
  const notes = spy.calls().filter((c) => c.execFile);
  assert.ok(notes.some((c) => JSON.stringify(c).includes('gsd-turbo cannot make progress')), JSON.stringify(notes));
  assert.match(logOf(p.root), /fatal/);
});

test('start fails with the log tail when the daemon exits at once', async (t) => {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }] });
  const holder = sleeper(t); // a daemon that holds the lock but never wrote supervisor.json
  writeLock(p.root, { pid: holder.pid, at: ago(0) });
  const r = await runAsync(['start'], p.root, p.env);
  assert.equal(r.code, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /started supervisor/);
  assert.match(r.stderr, /exited/);
  assert.match(r.stderr, new RegExp(`already running \\(pid ${holder.pid}\\)`));
});

test('lane prompts quote a CLI path that contains a single quote; git in the fingerprint has a timeout', async (t) => {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }] });
  const copy = path.join(tmpDir('cli'), "it's here");
  for (const d of ['bin', 'lib', 'package.json']) fs.cpSync(path.resolve(d), path.join(copy, d), { recursive: true });
  const spy = execSpy(p.root);
  const child = spawnCli(t, ['daemon'], p, { nodeArgs: spy.nodeArgs, env: spy.env, cli: path.join(copy, 'bin', 'turbo-run.mjs') });
  const bg = await waitFor(() => p.claudeCalls().find((a) => a[0] === '--bg'), 10000);
  assert.ok(bg, logOf(p.root));
  child.kill();
  await exited(child);
  const system = bg[bg.indexOf('--append-system-prompt') + 1];
  const quoted = `node '${copy.replace(/\\/g, '/').replace(/'/g, `'\\''`)}/bin/turbo-run.mjs'`;
  assert.ok(system.includes(`${quoted} lane-status 4 done`), system);
  if (process.platform !== 'win32') {
    execFileSync('sh', ['-c', `${quoted} lane-status 4 paused-context --reason quoted`], { cwd: p.root, env: p.env, stdio: 'pipe' });
    assert.equal(readJsonFile(path.join(runDirOf(p.root), 'p4.json')).reason, 'quoted');
  }
  const git = spy.calls().filter((c) => c.cmd === 'git' && c.args[0] === 'rev-parse');
  assert.ok(git.length > 0, JSON.stringify(spy.calls()));
  assert.ok(git.every((c) => c.timeout === 30000), JSON.stringify(git));
});

test('daemon refuses while a live daemon holds the lock; a lock without heartbeat is stale', async (t) => {
  const p = fakeProject();
  const child = sleeper(t);
  writeLock(p.root, { pid: child.pid, at: ago(0) });
  let r = await runAsync(['daemon'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`already running \\(pid ${child.pid}\\)`));
  assert.equal(readSup(p.root), null);
  assert.deepEqual(p.claudeCalls(), []);
  assert.equal(readJsonFile(lockOf(p.root)).pid, child.pid);

  writeLock(p.root, { pid: child.pid, at: ago(30) });
  r = await runAsync(['daemon'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readSup(p.root).finished, true);
  assert.equal(fs.existsSync(lockOf(p.root)), false);
  assert.ok(pidExists(child.pid));
});

test('resume with a dead daemon pid clears the phase and arms a forced relaunch', async () => {
  const root = plainProject();
  writeSup(root, { pid: DEAD_PID, updatedAt: ago(0), halted: true, lane: { phase: '4', sessionId: 'abc', restarts: 3, notified: { owner: true } } });
  fs.writeFileSync(path.join(runDirOf(root), 'p4.json'), JSON.stringify({ phase: '4', status: 'failed' }));
  // the owner's resume gives the stopped step a fresh budget of bounded rounds; the steps done stay done
  fs.writeFileSync(path.join(runDirOf(root), 'phase-p4.json'), JSON.stringify({ phase: '4', done: ['freshness'], notes: {}, attempts: { fix: 4 }, updatedAt: ago(1) }));
  assert.match(run(['resume', '04'], root), /phase 4 cleared; run: turbo-run start/);
  const sup = readSup(root);
  assert.equal(sup.pid, null);
  assert.equal(sup.halted, false);
  assert.deepEqual(sup.lane, { phase: '4', sessionId: 'abc', restarts: 0, notified: {}, forceRelaunch: true });
  assert.equal(fs.existsSync(path.join(runDirOf(root), 'p4.json')), false);
  const progress = readJsonFile(path.join(runDirOf(root), 'phase-p4.json'));
  assert.deepEqual([progress.done, progress.attempts], [['freshness'], {}]);
});

test('resume with a stale heartbeat kills nothing and revokes the lock lease', async (t) => {
  const root = plainProject();
  const child = sleeper(t);
  writeSup(root, { pid: child.pid, updatedAt: ago(30), lane: { phase: '4', sessionId: 'abc' } });
  writeLock(root, { pid: child.pid, at: ago(30) });
  const r = await runAsync(['resume', '4'], root);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /not killed/);
  assert.equal(readJsonFile(lockOf(root)).pid, null, 'the lock no longer names the daemon');
  assert.ok(pidExists(child.pid));
  assert.equal(readSup(root).pid, null);
  assert.equal(readSup(root).lane.forceRelaunch, true);
});

test('resume stops a live daemon (waiting for the owner) but not the lane session', async (t) => {
  const p = fakeProject();
  const child = sleeper(t);
  writeSup(p.root, { pid: child.pid, updatedAt: ago(0), halted: false, lane: { phase: '4', sessionId: 'abc', restarts: 1, notified: { owner: true } } });
  const r = await runAsync(['resume', '4'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await exited(child), 'daemon process still alive');
  const sup = readSup(p.root);
  assert.equal(sup.pid, null);
  assert.equal(sup.lane.forceRelaunch, true);
  assert.deepEqual(p.claudeCalls(), []);
});

test('resume --start launches a daemon that relaunches the lane; stop ends it', async (t) => {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }], config: { notify: { desktop: false, telegram: false }, poll_seconds: 5 } });
  t.after(() => { const pid = readSup(p.root)?.pid; if (pid) try { process.kill(pid); } catch { /* gone */ } });
  writeSup(p.root, { pid: null, halted: true, lane: { phase: '4', sessionId: 'old111', restarts: 3, notified: { owner: true }, launchedAt: ago(5), fingerprint: 'x' } });
  const r = await runAsync(['resume', '4', '--start'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /started supervisor pid \d+ \(mode full\)/);
  const sup = await waitFor(() => { const s = readSup(p.root); return s?.pid && s.lane?.sessionId === 'abcdef123456' ? s : null; }, 15000);
  assert.ok(sup, fs.readFileSync(path.join(p.root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8'));
  assert.equal(sup.lane.forceRelaunch, false);
  assert.ok(p.claudeCalls().some((a) => a[0] === 'rm' && a[1] === 'old111'));
  assert.ok(p.claudeCalls().some((a) => a[0] === '--bg'));
  const stop = await runAsync(['stop'], p.root, p.env);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(readSup(p.root).pid, null);
  assert.equal(pidExists(sup.pid), false);
});

test('start passes doctor\'s full mode to the daemon: the lane runs the turbo-phase skill', async (t) => {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }], config: { notify: { desktop: false, telegram: false }, poll_seconds: 5 } });
  t.after(() => { const pid = readSup(p.root)?.pid; if (pid) try { process.kill(pid); } catch { /* gone */ } });
  // started from the owner's own session: the lane never gets that session's ids
  const r = await runAsync(['start'], p.root, { ...p.env, CLAUDE_CODE_SESSION_ID: 'owner-session', CLAUDE_JOB_DIR: path.join(p.root, 'owner-job') });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /started supervisor pid \d+ \(mode full\)/);
  const bg = await waitFor(() => p.claudeCalls().find((a) => a[0] === '--bg'), 15000);
  assert.ok(bg, logOf(p.root));
  assert.deepEqual(readLines(path.join(p.root, 'fake-bin', 'claude-env.jsonl')), [{ sid: null, job: null }]);
  assert.equal(bg.at(-1), 'Run the turbo-phase skill with arguments: 4');
  assert.match(bg[bg.indexOf('--append-system-prompt') + 1], /lane-status 4 done .*close step/);
  // the settings JSON crosses a real process boundary intact (on win32 too: the shim resolves to node, no cmd.exe)
  const tmp = path.join(p.root, '.planning', 'turbo', 'run', 'tmp', 'p4');
  assert.deepEqual(JSON.parse(bg[bg.indexOf('--settings') + 1]), { worktree: { bgIsolation: 'none' }, env: { TMP: tmp, TEMP: tmp, TMPDIR: tmp } });
  assert.ok(fs.statSync(tmp).isDirectory(), 'created before the launch');
  const sup = await waitFor(() => { const s = readSup(p.root); return s?.lane?.mode ? s : null; }, 15000);
  assert.equal(sup?.lane?.mode, 'full', logOf(p.root));
  const stop = await runAsync(['stop'], p.root, p.env);
  assert.equal(stop.code, 0, stop.stderr);
});

test('start refuses conflicting or invalid range flags with exit 1 and starts nothing', async () => {
  const root = plainProject();
  const cases = [
    ['--only', '4', '--from', '3'], ['--only', '4', '--to', '5'], ['--all', '--from', '3'], ['--all', '--only', '4'],
    ['--from', '5', '--to', '3'], ['--from', '2B', '--to', '2.1'], ['--from'], ['--only', '../x'], ['--from', '--to', '5'],
  ];
  for (const args of cases) {
    const r = await runAsync(['start', ...args], root);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /usage: turbo-run start \[--from <phase>\] \[--to <phase>\] \| start --only <phase> \| start --all/, args.join(' '));
  }
  assert.equal(readSup(root), null);
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo', 'logs')), false, 'no daemon was spawned');
});

test('status shows the run\'s range, and a finished range is not a finished milestone; status --json carries it', () => {
  const root = plainProject();
  const cases = [[{ from: '4', to: '7' }, 'range: phases 4–7'], [{ from: '4', to: null }, 'range: phases 4–end'], [{ from: null, to: '7' }, 'range: phases start–7']];
  for (const [range, line] of cases) {
    writeSup(root, { lane: null, finished: false, halted: true, pid: null, range });
    const text = run(['status'], root);
    assert.ok(text.split(/\r?\n/).includes(line), text);
    assert.deepEqual(JSON.parse(run(['status', '--json'], root)).range, range);
  }
  writeSup(root, { lane: null, finished: true, halted: false, pid: null, range: { from: '4', to: '4' } });
  assert.match(run(['status'], root), /^supervisor: not running · range finished$/m);
  writeSup(root, { lane: null, finished: true, halted: false, pid: null });
  const text = run(['status'], root);
  assert.match(text, /^supervisor: not running · milestone finished$/m);
  assert.doesNotMatch(text, /range/);
});

test('start --only/--from/--all set, keep, drop and clear the range; a lane outside it is not resumed', async (t) => {
  // 3 is checked off in the roadmap but GSD reports its verification stale; 4 is complete
  const p = fakeProject({ phases: [
    { number: '3', name: 'three', phase_complete: false, roadmap_complete: true, implementation_complete: true, disk_status: 'executed', verification_status: 'stale' },
    { number: '4', name: 'four', phase_complete: true },
  ] });
  t.after(() => { const pid = readSup(p.root)?.pid; if (pid) try { process.kill(pid); } catch { /* gone */ } });
  const startRun = async (args) => {
    const r = await runAsync(['start', ...args], p.root, p.env);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    const sup = await waitFor(() => { const s = readSup(p.root); return s?.finished && s.pid === null ? s : null; }, 15000);
    assert.ok(sup, `${args.join(' ')}: ${logOf(p.root)}`);
    return { stdout: r.stdout, sup };
  };
  // start prints its own range line before spawning, and only that one: a daemon that already finished
  // (a fast tick under load) makes start print the status too, without a second range line
  const rangeLines = (stdout) => stdout.split(/\r?\n/).filter((l) => l.startsWith('range:'));

  writeSup(p.root, { pid: null, finished: false, halted: true, lane: { phase: '3', sessionId: 'old333', restarts: 0, launchedAt: ago(5) } });
  let r = await startRun(['--only', '04']);
  assert.deepEqual(rangeLines(r.stdout), ['range: phases 4–4']);
  assert.deepEqual([r.sup.range, r.sup.lane], [{ from: '4', to: '4' }, null]);
  assert.match(logOf(p.root), /lane phase 3 is outside the range 4–4; not resumed \(session old333 kept\)/);
  assert.match(logOf(p.root), /phases 4–4 done/);
  assert.ok(!p.claudeCalls().some((a) => a[0] === 'stop' || a[0] === 'rm' || a[0] === '--bg'), JSON.stringify(p.claudeCalls()));

  r = await startRun([]); // the previous run finished: its range is dropped
  assert.deepEqual(rangeLines(r.stdout), []);
  assert.equal('range' in r.sup, false);
  assert.match(logOf(p.root), /milestone done/);

  writeSup(p.root, { pid: null, finished: false, halted: true, lane: null, range: { from: '4', to: null } });
  r = await startRun([]); // a halted run keeps it
  assert.deepEqual(rangeLines(r.stdout), ['range: phases 4–end (kept from the previous run)']);
  assert.deepEqual(r.sup.range, { from: '4', to: null });

  writeSup(p.root, { pid: null, finished: false, halted: true, lane: null, range: { from: '4', to: '4' } });
  r = await startRun(['--all']);
  assert.deepEqual(rangeLines(r.stdout), []);
  assert.equal('range' in r.sup, false);
  assert.equal(p.claudeCalls().filter((a) => a[0] === '--bg').length, 0, 'the closed phase 3 is never started');
});

test('start with range flags while a run is going exits 1 naming the running range and changes nothing; without flags it reports the run', async (t) => {
  const root = plainProject();
  const child = sleeper(t);
  for (const [range, label] of [[{ from: '4', to: '5' }, 'phases 4–5'], [undefined, 'the whole milestone']]) {
    const sup = { pid: child.pid, updatedAt: ago(0), finished: false, halted: false, lane: null, ...(range ? { range } : {}) };
    writeSup(root, sup);
    for (const args of [['--only', '7'], ['--from', '2'], ['--to', '9'], ['--all']]) {
      const r = await runAsync(['start', ...args], root);
      assert.equal(r.code, 1, args.join(' '));
      assert.ok(r.stderr.includes(`a run of ${label} is going (supervisor pid ${child.pid})`), r.stderr);
      assert.match(r.stderr, /run turbo-run stop first/);
    }
    assert.deepEqual(readSup(root), sup);
  }
  assert.ok(pidExists(child.pid));
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo', 'logs')), false, 'no daemon was spawned');
  const r = await runAsync(['start'], root);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^already running \\(pid ${child.pid}\\)`));
});

test('resume <N> --start with N outside the kept range exits 1 naming the range; nothing is stopped, removed or started', async (t) => {
  const root = plainProject();
  const child = sleeper(t);
  const progress = { phase: '7', done: ['freshness'], notes: {}, attempts: { fix: 2 }, updatedAt: ago(1) };
  for (const [pid, stopFirst] of [[null, false], [child.pid, true]]) {
    const sup = { pid, updatedAt: ago(0), finished: false, halted: pid === null, lane: { phase: '7', sessionId: 'abc', restarts: 2 }, range: { from: '4', to: '5' } };
    writeSup(root, sup);
    fs.writeFileSync(path.join(runDirOf(root), 'p7.json'), JSON.stringify({ phase: '7', status: 'failed' }));
    fs.writeFileSync(path.join(runDirOf(root), 'phase-p7.json'), JSON.stringify(progress));
    const r = await runAsync(['resume', '07', '--start'], root);
    assert.equal(r.code, 1, r.stdout);
    assert.ok(r.stderr.includes('phase 7 is outside the range 4–5'), r.stderr);
    for (const way of ['turbo-run start --only 7', '--from', '--all']) assert.ok(r.stderr.includes(way), way);
    assert.equal(r.stderr.includes('turbo-run stop, then'), stopFirst, r.stderr);
    assert.deepEqual(readSup(root), sup);
    assert.ok(fs.existsSync(path.join(runDirOf(root), 'p7.json')), 'the lane record stays');
    assert.deepEqual(readJsonFile(path.join(runDirOf(root), 'phase-p7.json')), progress, 'the attempts stay');
  }
  assert.ok(pidExists(child.pid), 'the running daemon was not stopped');
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo', 'logs')), false, 'no daemon was spawned');
});

// Preloaded into start only: supervisor.json reads see no pid, so start never sees its daemon report and
// takes the path of a daemon that ran and exited before start confirmed it.
function hideSupervisorPid() {
  const fs = require('node:fs');
  const read = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    const out = read.call(this, file, ...rest);
    if (!String(file).endsWith('supervisor.json')) return out;
    try {
      const text = JSON.stringify({ ...JSON.parse(String(out)), pid: null });
      return typeof out === 'string' ? text : Buffer.from(text);
    } catch { return out; }
  };
}

test('start prints the range line once, also when the daemon finished before start confirmed it', async () => {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: true }] });
  const preload = path.join(p.root, 'hide-pid.cjs');
  fs.writeFileSync(preload, `(${hideSupervisorPid})();\n`);
  const r = await runAsync(['start', '--only', '4'], p.root, p.env, ['--require', preload]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ran and exited/);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter((l) => l.startsWith('range:')), ['range: phases 4–4']);
  assert.match(r.stdout, /^supervisor: not running · range finished$/m);
});

// Preloaded into start only: its first TURBO_TEST_HIDE_READS reads of supervisor.json find nothing, so start
// spawns a daemon although another one already runs (the race of two starts).
function hideFirstSupervisorReads() {
  const fs = require('node:fs');
  const read = fs.readFileSync;
  let left = Number(process.env.TURBO_TEST_HIDE_READS) || 0;
  fs.readFileSync = function (file, ...rest) {
    if (String(file).endsWith('supervisor.json') && left > 0) {
      left--;
      throw Object.assign(new Error('ENOENT: hidden'), { code: 'ENOENT' });
    }
    return read.call(this, file, ...rest);
  };
}

test('start that loses the race to another start reports the winner and its range once; exit 1 only for a different requested range', async (t) => {
  const p = fakeProject({ phases: [{ number: '4', name: 'four', phase_complete: false }] });
  const winner = sleeper(t);
  const preload = path.join(p.root, 'hide-reads.cjs');
  fs.writeFileSync(preload, `(${hideFirstSupervisorReads})();\n`);
  const race = async (args, hide) => {
    writeSup(p.root, { pid: winner.pid, updatedAt: new Date().toISOString(), finished: false, halted: false, lane: null, range: { from: '4', to: '5' } });
    writeLock(p.root, { pid: winner.pid, at: new Date().toISOString() });
    return runAsync(['start', ...args], p.root, { ...p.env, TURBO_TEST_HIDE_READS: String(hide) }, ['--require', preload]);
  };
  const ranges = (r) => r.stdout.split(/\r?\n/).filter((l) => l.startsWith('range:'));
  let r = await race(['--from', '4', '--to', '5'], 2);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`another start launched supervisor pid ${winner.pid} first \\(phases 4–5\\)`));
  assert.deepEqual(ranges(r), ['range: phases 4–5']);
  r = await race(['--only', '7'], 2);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.deepEqual(ranges(r), ['range: phases 7–7']);
  assert.match(r.stderr, /the running range is phases 4–5, not phases 7–7: run turbo-run stop first/);
  assert.doesNotMatch(r.stderr, /nothing was changed/);
  r = await race([], 3);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(ranges(r), []);
  assert.match(r.stdout, /another start launched supervisor pid \d+ first \(phases 4–5\)/);
  assert.ok(pidExists(winner.pid));
});

test('start refuses an unsupported environment with exit 2 and the failed checks', async () => {
  const p = fakeProject({ claudeVersion: '2.1.100' });
  const r = await runAsync(['start'], p.root, p.env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /FAIL claude-version 2\.1\.100/);
  assert.match(r.stderr, /mode unsupported/);
  assert.equal(readSup(p.root), null);
});

test('init keeps the previous test command verbatim as test.full and sets the turbo command', () => {
  const prev = 'pytest -k "not slow"';
  const p = fakeProject({ config: null, configGet: { out: prev, exit: 0 } });
  const spy = execSpy(p.root);
  run(['init'], p.root, { ...p.env, ...spy.env }, spy.nodeArgs);
  const cfg = readJsonFile(path.join(p.root, '.planning', 'turbo', 'config.json'));
  assert.equal(cfg.test.full, prev);
  const calls = p.gsdCalls();
  assert.deepEqual(calls[0], ['config-get', 'workflow.test_command', '--default', '', '--raw', '--cwd', p.root]);
  assert.deepEqual(calls[1], ['config-set', 'workflow.test_command', TURBO_TEST_CMD, '--cwd', p.root]);
  const gsd = spy.calls().filter((c) => /gsd-tools\.cjs$/.test(c.args[0] || ''));
  assert.deepEqual(gsd.map((c) => [c.args[1], c.args[2], c.timeout]), [['config-get', 'workflow.test_command', 30000], ['config-set', 'workflow.test_command', 30000], ['config-get', 'context_window', 30000], ['config-set', 'context_window', 30000]]);
});

test('init sets workflow.test_command only where GSD itself would run npm test, or a full command is known', () => {
  const pkg = JSON.stringify({ scripts: { test: 'node --test' } });
  const cases = [
    ['no package.json', {}, false],
    ['package.json with a test script', { 'package.json': pkg }, true],
    ['package.json without a test script', { 'package.json': '{"scripts":{}}' }, false],
    ['Makefile with a test target', { 'package.json': pkg, Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n' }, false],
    ['Makefile without a test target', { 'package.json': pkg, Makefile: 'build:\n\ttrue\n' }, true],
    ['Justfile', { 'package.json': pkg, Justfile: 'test:\n  true\n' }, false],
    ['justfile', { 'package.json': pkg, justfile: 'test:\n  true\n' }, false],
    ['xcodeproj at depth 2', { 'package.json': pkg, 'ios/App.xcodeproj/project.pbxproj': '' }, false],
    ['xcodeproj deeper than 2', { 'package.json': pkg, 'a/b/App.xcodeproj/project.pbxproj': '' }, true],
    ['xcodeproj inside node_modules', { 'package.json': pkg, 'node_modules/App.xcodeproj/project.pbxproj': '' }, true],
    ['explicit test.full', { '.planning/turbo/config.json': '{"test":{"full":"make check"}}' }, true],
    ['explicit test.full beside a Makefile test target', { Makefile: 'test:\n\ttrue\n', '.planning/turbo/config.json': '{"test":{"full":"make test"}}' }, true],
  ];
  for (const [name, files, set] of cases) {
    const p = fakeProject({ config: null });
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(p.root, rel)), { recursive: true });
      fs.writeFileSync(path.join(p.root, rel), text);
    }
    const stdout = run(['init'], p.root, p.env);
    assert.equal(p.gsdCalls().some((a) => a[0] === 'config-set' && a[1] === 'workflow.test_command'), set, `${name}: ${stdout}`);
    if (set) assert.match(stdout, /workflow\.test_command set/, name);
    else assert.match(stdout, /^targeted tests not enabled: set test\.full in \.planning\/turbo\/config\.json, then run init again$/m, name);
  }
});

test('init run again keeps test.full and re-sets the command when it is known, warns when it is not', () => {
  const p = fakeProject({ config: { test: { full: 'pytest -q' } }, configGet: { out: TURBO_TEST_CMD, exit: 0 } });
  let stdout = run(['init'], p.root, p.env);
  assert.doesNotMatch(stdout, /kept previous/);
  assert.equal(readJsonFile(path.join(p.root, '.planning', 'turbo', 'config.json')).test.full, 'pytest -q');
  assert.deepEqual(p.gsdCalls().filter((a) => a[0] === 'config-set' && a[1] === 'workflow.test_command').map((a) => a[2]), [TURBO_TEST_CMD]);

  const q = fakeProject({ config: { lang: 'en' }, configGet: { out: TURBO_TEST_CMD, exit: 0 } });
  stdout = run(['init'], q.root, q.env);
  assert.ok(!q.gsdCalls().some((a) => a[0] === 'config-set' && a[1] === 'workflow.test_command'), stdout);
  assert.match(stdout, /^warn: workflow\.test_command already runs turbo-run/m);
});

test('init gives GSD turbo\'s context_window when .planning/config.json sets none, and says so; a set one stays', () => {
  const p = fakeProject({ config: { context_window: 400000 } });
  let stdout = run(['init'], p.root, p.env);
  assert.deepEqual(p.gsdCalls().filter((a) => a[1] === 'context_window'), [
    ['config-get', 'context_window', '--default', '__turbo_absent__', '--raw', '--cwd', p.root],
    ['config-set', 'context_window', '400000', '--cwd', p.root],
  ]);
  assert.match(stdout, /^context_window set to 400000 in \.planning\/config\.json \(GSD had none; its default is 200000\)$/m);

  const q = fakeProject({ contextWindow: '200000' });
  stdout = run(['init'], q.root, q.env);
  assert.ok(!q.gsdCalls().some((a) => a[0] === 'config-set' && a[1] === 'context_window'), stdout);
  assert.doesNotMatch(stdout, /context_window set/);
});

test('doctor warns when GSD\'s effective context_window differs from turbo\'s; the mode stays', () => {
  const p = fakeProject();
  let stdout = run(['doctor'], p.root, p.env);
  assert.match(stdout, /^warn context-window GSD's context_window is 200000, turbo's is 1000000/m);
  assert.match(stdout, /^mode: full$/m);
  const q = fakeProject({ contextWindow: '1000000' });
  stdout = run(['doctor'], q.root, q.env);
  assert.match(stdout, /^ok {3}context-window 1000000$/m);
});

test('init aborts before config-set when config-get fails, and on a corrupt turbo config', () => {
  const p = fakeProject({ config: null, configGet: { out: '', exit: 1 } });
  assert.throws(() => run(['init'], p.root, p.env), (err) => {
    assert.equal(err.status, 1);
    assert.match(err.stderr, /init aborted: gsd-tools config-get workflow\.test_command failed/);
    return true;
  });
  assert.deepEqual(p.gsdCalls().map((a) => a[0]), ['config-get']);
  assert.equal(fs.existsSync(path.join(p.root, '.planning', 'turbo', 'config.json')), false);

  const q = fakeProject({ config: null, configGet: { out: 'npm test', exit: 0 } });
  fs.writeFileSync(path.join(q.root, '.planning', 'turbo', 'config.json'), '[]');
  assert.throws(() => run(['init'], q.root, q.env), (err) => {
    assert.equal(err.status, 1);
    assert.match(err.stderr, /invalid turbo config/);
    return true;
  });
  assert.ok(!q.gsdCalls().some((a) => a[0] === 'config-set'));
});
