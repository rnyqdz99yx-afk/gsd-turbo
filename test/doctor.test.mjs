import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { doctor } from '../lib/doctor.mjs';

function env() {
  const home = tmpDir('home');
  const core = path.join(home, 'gsd-core');
  fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(core, 'VERSION'), '1.16.0');
  const root = tmpDir('proj');
  fs.mkdirSync(path.join(root, '.planning'));
  return { home, core, root };
}

const execOk = (version) => (cmd, args) => {
  if (cmd === 'git') return 'git version 2.45.0';
  if (args.includes('manager')) return '{"phases":[]}';
  if (args.includes('agents')) return '[]';
  if (args.includes('--version')) return `${version} (Claude Code)`;
  return '';
};

const BIN = { cmd: 'claude', prefix: [], shell: false };

test('full mode when everything is in range', () => {
  const e = env();
  const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execOk('2.1.291'), claudeBin: BIN });
  assert.equal(r.mode, 'full', JSON.stringify(r.checks));
});

test('unsupported when claude too old', () => {
  const e = env();
  const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execOk('2.1.100'), claudeBin: BIN });
  assert.equal(r.mode, 'unsupported');
  assert.ok(r.checks.some((c) => c.name === 'claude-version' && !c.ok));
});

test('safe mode when GSD version is outside the tested range', () => {
  const e = env();
  fs.writeFileSync(path.join(e.core, 'VERSION'), '1.17.2');
  const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execOk('2.1.291'), claudeBin: BIN });
  assert.equal(r.mode, 'safe');
});

test('unsupported without a .planning project', () => {
  const e = env();
  const r = doctor({ root: null, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execOk('2.1.291'), claudeBin: BIN });
  assert.equal(r.mode, 'unsupported');
});

test('claude runs as cmd + prefix args without a shell', () => {
  const e = env();
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, shell: opts?.shell });
    return execOk('2.1.291')(cmd, args);
  };
  const bin = { cmd: '/opt/node', prefix: ['/opt/claude/cli.js'], shell: false };
  const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec, claudeBin: bin });
  assert.equal(r.mode, 'full', JSON.stringify(r.checks));
  const claudeCalls = calls.filter((c) => c.cmd === '/opt/node');
  assert.deepEqual(claudeCalls.map((c) => c.args), [['/opt/claude/cli.js', '--version'], ['/opt/claude/cli.js', 'agents', '--json', '--all']]);
  assert.ok(claudeCalls.every((c) => c.shell === false));
});

test('failure details carry the spawn code, exit status and signal', () => {
  const e = env();
  const fail = (props) => Object.assign(new Error('Command failed'), props);
  const exec = (cmd, args) => {
    if (cmd === 'git') throw fail({ status: null, signal: 'SIGTERM', code: 'ETIMEDOUT' });
    if (args.includes('--version')) throw fail({ code: 'ENOENT' });
    if (args.includes('agents')) throw fail({ status: 3, stderr: 'not logged in\n' });
    return execOk('2.1.291')(cmd, args);
  };
  const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec, claudeBin: BIN });
  const detail = (name) => r.checks.find((c) => c.name === name).detail;
  assert.equal(r.mode, 'unsupported');
  assert.match(detail('git'), /ETIMEDOUT/);
  assert.match(detail('git'), /signal SIGTERM/);
  assert.match(detail('claude-version'), /ENOENT/);
  assert.match(detail('claude-agents'), /exit status 3/);
  assert.match(detail('claude-agents'), /not logged in/);
});

test('unsupported claude shim fails claude-version with the shim message and never runs it', () => {
  const e = env();
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(cmd);
    return execOk('2.1.291')(cmd, args);
  };
  const reason = 'claude is installed as an unrecognized .cmd shim; install the native Claude Code build';
  const bin = { cmd: 'C:/tools/claude.cmd', prefix: [], shell: false, unsupported: reason };
  const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec, claudeBin: bin });
  assert.equal(r.mode, 'unsupported');
  const check = r.checks.find((c) => c.name === 'claude-version');
  assert.equal(check.ok, false);
  assert.equal(check.detail, reason);
  assert.ok(!calls.includes('C:/tools/claude.cmd'));
});

test('claude-agents fails when the agents output is not a JSON array', () => {
  const e = env();
  for (const out of ['{"agents":[]}', 'no sessions', 'null']) {
    const exec = (cmd, args) => (args.includes('agents') ? out : execOk('2.1.291')(cmd, args));
    const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec, claudeBin: BIN });
    assert.equal(r.mode, 'unsupported', out);
    const check = r.checks.find((c) => c.name === 'claude-agents');
    assert.equal(check.ok, false, out);
    assert.match(check.detail, /^claude agents --json --all: claude agents output is not a JSON array/, out);
  }
});

// The same parser as the supervisor: a format change it cannot read makes `start` refuse,
// instead of every tick failing after start.
test('claude-agents validates entries like the supervisor: renamed fields fail, interactive sessions pass', () => {
  const e = env();
  const run = (entries) => {
    const exec = (cmd, args) => (args.includes('agents') ? JSON.stringify(entries) : execOk('2.1.291')(cmd, args));
    const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec, claudeBin: BIN });
    return { mode: r.mode, check: r.checks.find((c) => c.name === 'claude-agents') };
  };
  const live = [
    { kind: 'background', id: 'b1a2c3d4', name: 'turbo-app-1a2b3c-p1', cwd: '/w/app', startedAt: 1, sessionId: 's-1', state: 'done' },
    { kind: 'interactive', pid: 4101, name: 'chat', cwd: '/w/app', startedAt: 2, sessionId: 's-2', status: 'busy' },
  ];
  assert.deepEqual(run(live), { mode: 'full', check: { name: 'claude-agents', ok: true, detail: '' } });
  const secret = 'SECRET-SESSION-TITLE';
  for (const entries of [[{ kind: 'background', id: 'b1', name: secret, phase: 'working' }], [{ kind: 'bg', pid: 1, name: secret, status: 'busy' }]]) {
    const { mode, check } = run(entries);
    assert.equal(mode, 'unsupported');
    assert.equal(check.ok, false);
    assert.match(check.detail, /^claude agents --json --all: claude agents entry 0 has no string (id|state or status)$/);
    assert.ok(!check.detail.includes(secret));
  }
});

test('unsupported when gsd-tools init manager fails', () => {
  const e = env();
  const exec = (cmd, args) => {
    if (args.includes('manager')) throw Object.assign(new Error('Command failed'), { status: 1, stderr: 'init broke' });
    return execOk('2.1.291')(cmd, args);
  };
  const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec, claudeBin: BIN });
  assert.equal(r.mode, 'unsupported');
  assert.equal(r.checks.find((c) => c.name === 'gsd-init-manager').ok, false);
});
