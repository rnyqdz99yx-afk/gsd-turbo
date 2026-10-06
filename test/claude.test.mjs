import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBin, parseAgents, laneSessionName, buildBgArgs, parseBgLaunch, createClaude } from '../lib/claude.mjs';

const BG_OPTS = { name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'auto' };
const PLAIN_BIN = { cmd: 'claude', prefix: [], shell: false };

// Same layout npm's cmd-shim generates for a global bin.
const npmShim = (target) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, '',
].join('\r\n');

function tempDir(t, prefix = 'turbo-claude-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('resolveBin returns plain exe/linux paths with an empty prefix and no shell', () => {
  const exe = () => 'C:\\Users\\u\\.local\\bin\\claude.exe\r\n';
  assert.deepEqual(resolveBin('claude', { platform: 'win32', exec: exe }), { cmd: 'C:\\Users\\u\\.local\\bin\\claude.exe', prefix: [], shell: false });
  assert.deepEqual(resolveBin('claude', { platform: 'linux', exec: () => '/usr/bin/claude\n' }), { cmd: '/usr/bin/claude', prefix: [], shell: false });
  assert.deepEqual(resolveBin('claude', { platform: 'linux', exec: () => { throw new Error('nf'); } }), { cmd: 'claude', prefix: [], shell: false });
});

test('resolveBin unwraps an npm .cmd shim with a JS target to node + script', (t) => {
  const dir = tempDir(t);
  const script = writeFile(path.join(dir, 'node_modules', '@scope', 'cli', 'cli.js'), '');
  const shim = writeFile(path.join(dir, 'claude.cmd'), npmShim('node_modules\\@scope\\cli\\cli.js'));
  const exec = () => `${shim}\r\n${path.join(dir, 'claude')}\r\n`;
  assert.deepEqual(resolveBin('claude', { platform: 'win32', exec }), { cmd: process.execPath, prefix: [script], shell: false });
});

test('resolveBin unwraps an older %~dp0 shim with an .exe target', (t) => {
  const dir = tempDir(t);
  const target = writeFile(path.join(dir, 'bin', 'claude.exe'), '');
  const shim = writeFile(path.join(dir, 'claude.cmd'), '@"%~dp0\\node.exe" --version >NUL\r\n@"%~dp0\\bin\\claude.exe" %*\r\n');
  assert.deepEqual(resolveBin('claude', { platform: 'win32', exec: () => `${shim}\r\n` }), { cmd: target, prefix: [], shell: false });
});

test('resolveBin flags unrecognized or dangling shims as unsupported', (t) => {
  const dir = tempDir(t);
  const unknown = writeFile(path.join(dir, 'a', 'claude.cmd'), '@echo off\r\ncall some-launcher %*\r\n');
  const dangling = writeFile(path.join(dir, 'b', 'claude.bat'), npmShim('node_modules\\gone\\cli.js'));
  for (const shim of [unknown, dangling, path.join(dir, 'missing.cmd')]) {
    const bin = resolveBin('claude', { platform: 'win32', exec: () => `${shim}\r\n` });
    assert.equal(bin.cmd, shim);
    assert.deepEqual(bin.prefix, []);
    assert.equal(bin.shell, false);
    assert.match(bin.unsupported, /unrecognized \.cmd shim; install the native Claude Code build/);
  }
});

test('npm shim target runs without cmd.exe and keeps spaces, quotes and newlines intact', { skip: process.platform !== 'win32' }, (t) => {
  const dir = tempDir(t, 'turbo claude shim ');
  const script = writeFile(path.join(dir, 'node_modules', 'echo-pkg', 'echo.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const shim = writeFile(path.join(dir, 'claude.cmd'), npmShim('node_modules\\echo-pkg\\echo.js'));
  const bin = resolveBin('claude', { platform: 'win32', exec: () => `${shim}\r\n` });
  assert.deepEqual(bin, { cmd: process.execPath, prefix: [script], shell: false });
  const arg = 'two words\nsecond line "quoted" 100% done';
  assert.deepEqual(JSON.parse(createClaude({ bin }).stop(arg)), ['stop', arg]);
});

test('parseAgents tolerates mixed shapes and bad input', () => {
  const text = JSON.stringify([
    { id: 'a1', name: 'turbo-x-p2', kind: 'background', state: 'working', cwd: '/p', startedAt: 1, sessionId: 'a1-full' },
    { kind: 'interactive', status: 'busy', cwd: '/q', pid: 42 },
    null, 1, 'x', [1],
  ]);
  const a = parseAgents(text);
  assert.equal(a.length, 2);
  assert.equal(a[0].state, 'working');
  assert.equal(a[0].sessionId, 'a1-full');
  assert.equal(a[1].state, 'busy');
  assert.equal(a[1].pid, 42);
  assert.deepEqual(parseAgents('not json'), []);
  assert.deepEqual(parseAgents('{"x":1}'), []);
});

test('laneSessionName is stable, filesystem-safe and unique per root', () => {
  const n = laneSessionName('/home/u/My Project', '32.1');
  assert.match(n, /^turbo-my-project-[0-9a-f]{6}-p32-1$/);
  assert.equal(laneSessionName('/home/u/My Project/', '32.1'), n);
  assert.notEqual(laneSessionName('/a/app', '1'), laneSessionName('/b/app', '1'));
  assert.match(laneSessionName('/x/\u30d7\u30ed\u30b8\u30a7\u30af\u30c8', 1), /^turbo-project-[0-9a-f]{6}-p1$/);
});

test('buildBgArgs puts flags before the prompt and disables AskUserQuestion', () => {
  const args = buildBgArgs({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'bypassPermissions', model: '' });
  assert.deepEqual(args, ['--bg', '--name', 'n', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'AskUserQuestion', '--append-system-prompt', 'S', 'P']);
  assert.ok(buildBgArgs({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'auto', model: 'opus' }).includes('opus'));
});

test('parseBgLaunch extracts the id', () => {
  assert.equal(parseBgLaunch('Starting background service…\nbackgrounded · 749a6844 · turbo-perm\n'), '749a6844');
  assert.equal(parseBgLaunch('backgrounded: 0A1B2C3D (turbo-x)'), '0A1B2C3D');
  assert.equal(parseBgLaunch('backgrounded · abc · n'), null);
  assert.equal(parseBgLaunch('nothing'), null);
});

test('createClaude wires exec calls', () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args);
    if (args[0] === '--bg') return 'backgrounded · abc123 · n\n';
    if (args[0] === 'agents') return '[{"id":"abc123","state":"working"}]';
    return '';
  };
  const c = createClaude({ bin: { cmd: 'claude', shell: false }, exec });
  assert.equal(c.launchBg(BG_OPTS, '/p'), 'abc123');
  assert.equal(c.list()[0].id, 'abc123');
  c.stop('abc123');
  c.rm('abc123');
  assert.deepEqual(calls.map((a) => a[0]), ['--bg', 'agents', 'stop', 'rm']);
});

test('createClaude prepends the bin prefix and passes per-call timeouts with SIGKILL', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return args[1] === '--bg' ? 'backgrounded · abc123 · n' : '[]';
  };
  const c = createClaude({ bin: { cmd: '/node', prefix: ['/x/cli.js'], shell: false }, exec });
  c.launchBg(BG_OPTS, '/p');
  c.list();
  c.stop('abc123');
  c.rm('abc123');
  assert.deepEqual(calls.map((c2) => [c2.cmd, c2.args[0], c2.args[1]]), [
    ['/node', '/x/cli.js', '--bg'], ['/node', '/x/cli.js', 'agents'], ['/node', '/x/cli.js', 'stop'], ['/node', '/x/cli.js', 'rm'],
  ]);
  assert.deepEqual(calls.map((c2) => [c2.opts.timeout, c2.opts.killSignal, c2.opts.shell]), [
    [120000, 'SIGKILL', false], [30000, 'SIGKILL', false], [30000, 'SIGKILL', false], [30000, 'SIGKILL', false],
  ]);
  assert.equal(calls[0].opts.cwd, '/p');
});

test('createClaude errors carry CLI output but never the argv', () => {
  const secret = 'SECRET-PROMPT-TEXT';
  const nodeErr = (extra) => Object.assign(new Error(`Command failed: claude --bg --name n ${secret}`), extra);
  const failing = (err) => createClaude({ bin: PLAIN_BIN, exec: () => { throw err; } });
  const check = (fn, message) => assert.throws(fn, (e) => {
    assert.equal(e.message, message);
    assert.ok(!e.message.includes(secret));
    return true;
  });
  check(() => failing(nodeErr({ status: 1, stderr: 'auth expired\n' })).launchBg(BG_OPTS, '/p'), 'claude --bg failed: auth expired');
  check(() => failing(nodeErr({ status: 2, stderr: '' })).launchBg(BG_OPTS, '/p'), 'claude --bg failed: exit status 2');
  check(() => failing(nodeErr({ status: null, signal: 'SIGKILL', stderr: '' })).stop('abc123'), 'claude stop failed: killed by SIGKILL');
  check(() => failing(Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT', stderr: '' })).list(), 'claude agents failed: timed out after 30000 ms');
  check(() => failing(Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' })).rm('abc123'), 'claude rm failed: spawnSync claude ENOENT');
  const long = `${'x'.repeat(1000)}END`;
  check(() => failing(nodeErr({ status: 1, stderr: long })).list(), `claude agents failed: ${long.slice(-500)}`);
});

test('launchBg reports the raw CLI output when no id is found', () => {
  const out = `unexpected banner ${'y'.repeat(600)}`;
  const c = createClaude({ bin: PLAIN_BIN, exec: () => out });
  assert.throws(() => c.launchBg(BG_OPTS, '/p'), { message: `claude --bg did not report a session id: ${out.slice(0, 500)}` });
});

test('createClaude refuses an unsupported bin without spawning', () => {
  let spawned = false;
  const c = createClaude({ bin: { ...PLAIN_BIN, unsupported: 'install the native build' }, exec: () => { spawned = true; return '[]'; } });
  assert.throws(() => c.list(), { message: 'install the native build' });
  assert.equal(spawned, false);
});
