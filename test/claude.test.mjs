import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBin, parseAgents, laneSessionName, buildBgArgs, buildResumeArgs, parseBgLaunch, parseResume, createClaude, sessionFreeEnv } from '../lib/claude.mjs';

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

test('parseAgents reads entries with an id and a state or status field', () => {
  const text = JSON.stringify([
    { id: 'a1', name: 'turbo-x-p2', kind: 'background', state: 'working', cwd: '/p', startedAt: 1, sessionId: 'a1-full' },
    { id: 'i1', status: 'busy', cwd: '/q', pid: 42 },
    { id: 'e1', state: '' },
  ]);
  const a = parseAgents(text);
  assert.equal(a.length, 3);
  assert.equal(a[0].state, 'working');
  assert.equal(a[0].sessionId, 'a1-full');
  assert.equal(a[1].state, 'busy');
  assert.equal(a[1].pid, 42);
  assert.equal(a[2].state, '', 'an empty state field keeps meaning finished');
  assert.deepEqual(parseAgents('[]\n'), []);
});

// Shape of `claude agents --json --all` seen live (Claude Code 2.1.292), names and paths made
// synthetic: background sessions carry id + state; interactive ones have pid + status, no id.
test('parseAgents skips interactive sessions and keeps the background ones (live CLI shape)', () => {
  const t0 = 1767225600000;
  const sid = (n) => `c0ffee0${n}-0000-4000-8000-00000000000${n}`;
  const live = [
    { kind: 'background', id: 'b1a2c3d4', name: 'turbo-app-1a2b3c-p1', cwd: '/w/app', startedAt: t0, sessionId: sid(1), state: 'failed' },
    { kind: 'interactive', pid: 4101, name: 'chat one', cwd: '/w/app', startedAt: t0 + 1, sessionId: sid(2), status: 'busy' },
    { kind: 'background', id: 'b2b3c4d5', name: 'turbo-app-1a2b3c-p2', cwd: '/w/app', startedAt: t0 + 2, sessionId: sid(3), state: 'blocked' },
    { kind: 'interactive', pid: 4102, name: 'chat two', cwd: '/w/other', startedAt: t0 + 3, sessionId: sid(4), status: 'busy' },
    { kind: 'background', id: 'b3c4d5e6', name: 'misc', cwd: '/w/other', startedAt: t0 + 4, sessionId: sid(5), state: 'done' },
    { kind: 'interactive', pid: 4103, name: 'chat three', cwd: '/w/third', startedAt: t0 + 5, sessionId: sid(6), status: 'busy' },
  ];
  const a = parseAgents(JSON.stringify(live));
  assert.deepEqual(a.map((x) => [x.id, x.kind, x.state, x.sessionId]), [
    ['b1a2c3d4', 'background', 'failed', sid(1)],
    ['b2b3c4d5', 'background', 'blocked', sid(3)],
    ['b3c4d5e6', 'background', 'done', sid(5)],
  ]);
  // a non-object entry still throws, even next to a skipped one
  assert.throws(() => parseAgents(JSON.stringify([{ kind: 'interactive', pid: 1 }, null])), { message: 'claude agents entry 1 is not an object' });
});

// Only `interactive` is skipped: a renamed kind value (say `bg` for `background`) must not make
// lane sessions vanish (an unlisted lane session counts as ended and is removed).
test('parseAgents checks every kind other than interactive strictly', () => {
  assert.deepEqual(parseAgents(JSON.stringify([{ kind: 'bg', id: 'x', state: 'working' }])).map((a) => [a.id, a.kind, a.state]), [['x', 'bg', 'working']]);
  assert.throws(() => parseAgents(JSON.stringify([{ kind: 'bg', pid: 1, status: 'busy' }])), { message: 'claude agents entry 0 has no string id' });
  assert.throws(() => parseAgents(JSON.stringify([{ kind: 'remote', pid: 1 }])), { message: 'claude agents entry 0 has no string id' });
  assert.deepEqual(parseAgents(JSON.stringify([{ kind: 'interactive', pid: 1, status: 'busy' }])), []);
});

// A renamed id or state field would make every live session look ended (and be removed).
test('parseAgents throws on an entry without an id or without a state/status field, without echoing it', () => {
  const secret = 'SECRET-SESSION-TITLE';
  const bad = [
    [{ id: 's1', name: secret, cwd: '/r', phase: 'working' }],
    [{ name: secret, state: 'working' }],
    // an interactive-looking entry without kind: only an explicit non-background kind is skipped
    [{ pid: 4242, name: secret, cwd: '/w/app', startedAt: 1767225600000, sessionId: 'c0ffee00-0000-4000-8000-000000000001', status: 'busy' }],
    [{ kind: 'background', name: secret, cwd: '/w/app', state: 'working' }],
    [{ kind: 'background', id: 'b1', name: secret, cwd: '/w/app', phase: 'working' }],
    [{ id: '', state: 'working' }],
    [{ id: 7, state: 'working' }],
    [{ id: 's1', state: null, status: 1, name: secret }],
    [{ id: 's1', state: 'working' }, null],
    [1], ['x'], [[1]],
  ];
  for (const entries of bad) {
    assert.throws(() => parseAgents(JSON.stringify(entries)), (e) => {
      assert.match(e.message, /^claude agents entry \d+ /);
      assert.ok(!e.message.includes(secret));
      return true;
    }, JSON.stringify(entries));
  }
});

// An empty list would make every lane session look ended, and the supervisor would remove them.
test('parseAgents throws on output that is not a JSON array, without echoing the output', () => {
  const secret = 'SECRET-SESSION-TITLE';
  for (const text of [`not json ${secret}`, '', `{"agents":[{"id":"a1","name":"${secret}","state":"working"}]}`, '"x"', 'null']) {
    assert.throws(() => parseAgents(text), (e) => {
      assert.match(e.message, /^claude agents output is not a JSON array/);
      assert.ok(!e.message.includes(secret));
      return true;
    }, JSON.stringify(text));
  }
  const c = createClaude({ bin: PLAIN_BIN, exec: () => '{"agents":[]}' });
  assert.throws(() => c.list(), /claude agents output is not a JSON array/);
});

test('laneSessionName is stable, filesystem-safe and unique per root', () => {
  const n = laneSessionName('/home/u/My Project', '32.1');
  assert.match(n, /^turbo-my-project-[0-9a-f]{6}-p32-1$/);
  assert.equal(laneSessionName('/home/u/My Project/', '32.1'), n);
  assert.notEqual(laneSessionName('/a/app', '1'), laneSessionName('/b/app', '1'));
  assert.match(laneSessionName('/x/\u30d7\u30ed\u30b8\u30a7\u30af\u30c8', 1), /^turbo-project-[0-9a-f]{6}-p1$/);
});

test('buildBgArgs puts flags before the prompt, disables AskUserQuestion and turns off bg worktree isolation', () => {
  const settings = '{"worktree":{"bgIsolation":"none"},"env":{"TURBO_LANE":"1"}}';
  const args = buildBgArgs({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'bypassPermissions', model: '' });
  assert.deepEqual(args, ['--bg', '--name', 'n', '--permission-mode', 'bypassPermissions', '--settings', settings, '--disallowedTools', 'AskUserQuestion', '--append-system-prompt', 'S', 'P']);
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { worktree: { bgIsolation: 'none' }, env: { TURBO_LANE: '1' } });
  const withModel = buildBgArgs({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'auto', model: 'opus' });
  assert.ok(withModel.includes('opus'));
  assert.equal(withModel[withModel.indexOf('--settings') + 1], settings);
  assert.equal(withModel.at(-1), 'P');
});

test('buildBgArgs points the lane session\'s TMP, TEMP and TMPDIR at its own temp directory, bg isolation still off', () => {
  const tmpDir = path.resolve('/p/.planning/turbo/run/tmp/p3');
  const args = buildBgArgs({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'auto', model: '', tmpDir });
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { worktree: { bgIsolation: 'none' }, env: { TURBO_LANE: '1', TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir } });
  assert.equal(args.at(-1), 'P');
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

// The supervisor may be started from the owner's own session: a lane must never carry that session's ids,
// or turbo-run context inside the lane could measure the owner's transcript.
test('launchBg runs claude without the calling session\'s CLAUDE_CODE_SESSION_ID and CLAUDE_JOB_DIR; the rest of the env stays', (t) => {
  const saved = { sid: process.env.CLAUDE_CODE_SESSION_ID, job: process.env.CLAUDE_JOB_DIR };
  t.after(() => {
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.sid], ['CLAUDE_JOB_DIR', saved.job]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  process.env.CLAUDE_CODE_SESSION_ID = 'owner-session';
  process.env.CLAUDE_JOB_DIR = '/owner/job';
  const opts = [];
  const exec = (cmd, args, o) => { opts.push(o); return 'backgrounded · abc123 · n\n'; };
  createClaude({ bin: PLAIN_BIN, exec }).launchBg(BG_OPTS, '/p');
  const keys = Object.keys(opts[0].env).map((k) => k.toUpperCase());
  assert.ok(!keys.includes('CLAUDE_CODE_SESSION_ID') && !keys.includes('CLAUDE_JOB_DIR'), keys.join(' '));
  assert.ok(keys.includes('PATH'));
  assert.deepEqual(Object.keys(sessionFreeEnv({ Path: 'p', claude_job_dir: 'x', CLAUDE_CODE_SESSION_ID: 'y', OTHER: '1' })), ['Path', 'OTHER']);
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
  const bg = calls[0].args;
  assert.equal(bg[bg.indexOf('--settings') + 1], '{"worktree":{"bgIsolation":"none"},"env":{"TURBO_LANE":"1"}}');
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

test('the prompt never follows the value of the variadic --disallowedTools (spec §9), whatever the options', () => {
  for (const opts of [BG_OPTS, { ...BG_OPTS, model: 'opus' }, { ...BG_OPTS, tmpDir: path.resolve('/p/tmp') }]) {
    const args = buildBgArgs(opts);
    const at = args.indexOf('--disallowedTools');
    assert.equal(args[at + 1], 'AskUserQuestion');
    assert.ok(args[at + 2].startsWith('--'), args[at + 2]);
    assert.equal(args.at(-1), 'P');
  }
});

test('buildResumeArgs passes nothing but --bg, --resume, the session id and the prompt: any other flag starts a copy (spec §5.5.1)', () => {
  assert.deepEqual(buildResumeArgs('1a2b3c4d-2222-4333-8444-555555555555', 'The owner answered'), ['--bg', '--resume', '1a2b3c4d-2222-4333-8444-555555555555', 'The owner answered']);
});

test('parseResume: woke, a copy (with its id), or neither', () => {
  const ids = { jobId: '1a2b3c4d', sessionId: '1a2b3c4d-2222-4333-8444-555555555555' };
  assert.deepEqual(parseResume('note: woke session 1a2b3c4d with its saved options (--name, --model)\n', ids), { woke: true, copyId: null });
  assert.deepEqual(parseResume('note: session 1a2b3c4d is already running in the background, so this started a copy as 9f8e7d6c\n', ids), { woke: false, copyId: '9f8e7d6c' });
  assert.deepEqual(parseResume('note: it keeps its own saved options, so the flags you passed started a copy\nbackgrounded · 9f8e7d6c · lane\n', ids), { woke: false, copyId: '9f8e7d6c' });
  assert.deepEqual(parseResume('backgrounded · 1a2b3c4d · lane\n', ids), { woke: true, copyId: null });
  assert.deepEqual(parseResume('backgrounded · 9f8e7d6c · lane\n', ids), { woke: false, copyId: '9f8e7d6c' });
  assert.deepEqual(parseResume('Error: something else\n', ids), { woke: false, copyId: null });
  assert.deepEqual(parseResume(undefined), { woke: false, copyId: null });
});

test('resume runs claude with the resume args only, without the calling session\'s ids, and returns stdout and stderr together; errors never carry the prompt', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: 'backgrounded · 1a2b3c4d · lane\n', stderr: 'note: woke session 1a2b3c4d with its saved options\n' }; };
  const c = createClaude({ bin: { cmd: '/node', prefix: ['/x/cli.js'], shell: false }, exec: () => '', spawn });
  const out = c.resume('1a2b3c4d-full', 'SECRET-PROMPT', '/p');
  assert.match(out, /backgrounded/);
  assert.match(out, /woke session/);
  assert.deepEqual(calls[0].args, ['/x/cli.js', '--bg', '--resume', '1a2b3c4d-full', 'SECRET-PROMPT']);
  assert.deepEqual([calls[0].opts.cwd, calls[0].opts.shell, calls[0].opts.windowsHide, calls[0].opts.killSignal, calls[0].opts.timeout], ['/p', false, true, 'SIGKILL', 120000]);
  assert.ok(!Object.keys(calls[0].opts.env).some((k) => ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_JOB_DIR'].includes(k.toUpperCase())));
  const failing = createClaude({ bin: PLAIN_BIN, exec: () => '', spawn: () => ({ status: 1, stdout: '', stderr: 'no such session' }) });
  assert.throws(() => failing.resume('x', 'SECRET-PROMPT', '/p'), (e) => e.message === 'claude --resume failed: no such session' && !e.message.includes('SECRET'));
  const timeout = createClaude({ bin: PLAIN_BIN, exec: () => '', spawn: () => ({ status: null, error: Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }) });
  assert.throws(() => timeout.resume('x', 'P', '/p'), /claude --resume failed: timed out after 120000 ms/);
});
