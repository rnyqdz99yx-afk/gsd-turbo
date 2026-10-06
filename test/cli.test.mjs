import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const run = (args, cwd, env = process.env) => execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// Async, so this process keeps reaping children the CLI kills (no POSIX zombies).
const runAsync = (args, cwd, env = process.env) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
  });
});

const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const TURBO_TEST_CMD = 'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" test-changed';
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
  const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'behavior.json'), 'utf8'));
  const [cmd, id = ''] = args;
  if (cmd === '--version') console.log(`${b.version} (Claude Code)`);
  else if (cmd === 'agents') console.log('[]');
  else if (cmd === '--bg') console.log('backgrounded abcdef123456');
  else if (cmd === 'stop' || cmd === 'rm') {
    if (id.startsWith('gone')) { console.error(`No job matching '${id}'. Run 'claude agents' to list running sessions.`); process.exitCode = 1; }
    if (id.startsWith('stuck')) { console.error('permission denied'); process.exitCode = 1; }
  } else process.exitCode = 2;
}
function fakeGsd() {
  const fs = require('fs');
  const path = require('path');
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(__dirname, 'gsd-argv.jsonl'), JSON.stringify(args) + '\n');
  const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'behavior.json'), 'utf8'));
  if (args[0] === 'config-get') {
    process.stdout.write(b.configGet.out);
    if (b.configGet.exit) { console.error('config-get broke'); process.exitCode = b.configGet.exit; }
  } else if (args[0] === 'init' && args[1] === 'manager') process.stdout.write(JSON.stringify({ milestone_version: 'v1', phases: b.phases }));
  else if (args[0] !== 'config-set') process.exitCode = 2;
}

// A project whose claude (PATH) and gsd-core (.claude/gsd-core in the project) are local fakes:
// nothing reaches a real claude or GSD install.
function fakeProject({
  phases = [{ number: '1', name: 'one', phase_complete: true }],
  configGet = { out: '', exit: 0 },
  claudeVersion = '2.1.291',
  config = { notify: { desktop: false, telegram: false } },
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
  fs.writeFileSync(path.join(core, 'bin', 'behavior.json'), JSON.stringify({ configGet, phases }));
  fs.writeFileSync(path.join(bin, 'behavior.json'), JSON.stringify({ version: claudeVersion }));
  fs.writeFileSync(path.join(bin, 'claude-fake.cjs'), `(${fakeClaude})();\n`);
  // win32: an npm-style shim that resolveBin maps to node + claude-fake.cjs (never run by cmd.exe)
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@"%dp0%\\claude-fake.cjs" %*\r\n');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\n(${fakeClaude})();\n`, { mode: 0o755 });
  const env = { ...process.env, [PATH_KEY]: `${bin}${path.delimiter}${process.env[PATH_KEY]}`, CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') };
  return {
    root,
    env,
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
async function deadPid() {
  const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await exited(c);
  return c.pid;
}
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

test('a daemon counts as running only with a valid existing pid and a recent heartbeat', async () => {
  const root = plainProject();
  const dead = await deadPid();
  const cases = [
    [{ pid: process.pid, updatedAt: ago(0) }, true],
    [{ pid: process.pid, updatedAt: ago(30) }, false],
    [{ pid: process.pid }, false],
    [{ pid: -1, updatedAt: ago(0) }, false],
    [{ pid: 0, updatedAt: ago(0) }, false],
    [{ pid: String(process.pid), updatedAt: ago(0) }, false],
    [{ pid: dead, updatedAt: ago(0) }, false],
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
  const root = plainProject();
  const child = sleeper(t);
  writeSup(root, { pid: child.pid, updatedAt: ago(30) });
  const r = await runAsync(['stop'], root);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /not killed/);
  assert.equal(await exited(child, 300), false);
  assert.ok(pidExists(child.pid));
  assert.equal(readSup(root).pid, null);
});

test('stop treats an already-gone lane session as stopped and warns on other failures', async () => {
  const p = fakeProject();
  writeSup(p.root, { pid: null, lane: { phase: '4', sessionId: 'gone1' } });
  let r = await runAsync(['stop'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /stopped/);
  writeSup(p.root, { pid: null, lane: { phase: '4', sessionId: 'stuck1' } });
  r = await runAsync(['stop'], p.root, p.env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /^warn: lane session stuck1 not stopped: .*permission denied/m);
});

test('daemon replaces a dead lock, runs to the end, then clears its pid and lock', async () => {
  const p = fakeProject();
  writeLock(p.root, { pid: await deadPid(), at: ago(0) });
  const r = await runAsync(['daemon'], p.root, p.env);
  assert.equal(r.code, 0, r.stderr);
  const sup = readSup(p.root);
  assert.equal(sup.finished, true);
  assert.equal(sup.pid, null);
  assert.equal(fs.existsSync(lockOf(p.root)), false);
  assert.ok(p.claudeCalls().some((a) => a[0] === 'agents'));
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
  writeSup(root, { pid: await deadPid(), updatedAt: ago(0), halted: true, lane: { phase: '4', sessionId: 'abc', restarts: 3, notified: { owner: true } } });
  fs.writeFileSync(path.join(runDirOf(root), 'p4.json'), JSON.stringify({ phase: '4', status: 'failed' }));
  assert.match(run(['resume', '04'], root), /phase 4 cleared; run: turbo-run start/);
  const sup = readSup(root);
  assert.equal(sup.pid, null);
  assert.equal(sup.halted, false);
  assert.deepEqual(sup.lane, { phase: '4', sessionId: 'abc', restarts: 0, notified: {}, forceRelaunch: true });
  assert.equal(fs.existsSync(path.join(runDirOf(root), 'p4.json')), false);
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
  run(['init'], p.root, p.env);
  const cfg = readJsonFile(path.join(p.root, '.planning', 'turbo', 'config.json'));
  assert.equal(cfg.test.full, prev);
  const calls = p.gsdCalls();
  assert.deepEqual(calls[0], ['config-get', 'workflow.test_command', '--default', '', '--raw', '--cwd', p.root]);
  assert.deepEqual(calls[1], ['config-set', 'workflow.test_command', TURBO_TEST_CMD, '--cwd', p.root]);
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
