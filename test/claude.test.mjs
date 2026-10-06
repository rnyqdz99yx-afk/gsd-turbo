import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBin, parseAgents, laneSessionName, buildBgArgs, parseBgLaunch, createClaude } from '../lib/claude.mjs';

test('resolveBin uses shell for .cmd shims on Windows', () => {
  const exec = () => 'C:\\npm\\claude.cmd\r\nC:\\npm\\claude\r\n';
  assert.deepEqual(resolveBin('claude', { platform: 'win32', exec }), { cmd: 'C:\\npm\\claude.cmd', shell: true });
  const exe = () => 'C:\\Users\\u\\.local\\bin\\claude.exe\r\n';
  assert.deepEqual(resolveBin('claude', { platform: 'win32', exec: exe }), { cmd: 'C:\\Users\\u\\.local\\bin\\claude.exe', shell: false });
  assert.deepEqual(resolveBin('claude', { platform: 'linux', exec: () => '/usr/bin/claude\n' }), { cmd: '/usr/bin/claude', shell: false });
  assert.deepEqual(resolveBin('claude', { platform: 'linux', exec: () => { throw new Error('nf'); } }), { cmd: 'claude', shell: false });
});

test('parseAgents tolerates mixed shapes and bad input', () => {
  const text = JSON.stringify([
    { id: 'a1', name: 'turbo-x-p2', kind: 'background', state: 'working', cwd: '/p', startedAt: 1 },
    { id: 'b2', kind: 'interactive', status: 'busy', cwd: '/q' },
  ]);
  const a = parseAgents(text);
  assert.equal(a.length, 2);
  assert.equal(a[0].state, 'working');
  assert.equal(a[1].state, 'busy');
  assert.deepEqual(parseAgents('not json'), []);
  assert.deepEqual(parseAgents('{"x":1}'), []);
});

test('laneSessionName is stable and filesystem-safe', () => {
  assert.equal(laneSessionName('/home/u/My Project', '32.1'), 'turbo-my-project-p32-1');
});

test('buildBgArgs puts flags before the prompt and disables AskUserQuestion', () => {
  const args = buildBgArgs({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'bypassPermissions', model: '' });
  assert.deepEqual(args, ['--bg', '--name', 'n', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'AskUserQuestion', '--append-system-prompt', 'S', 'P']);
  assert.ok(buildBgArgs({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'auto', model: 'opus' }).includes('opus'));
});

test('parseBgLaunch extracts the id', () => {
  assert.equal(parseBgLaunch('Starting background service…\nbackgrounded · 749a6844 · turbo-perm\n'), '749a6844');
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
  assert.equal(c.launchBg({ name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'auto' }, '/p'), 'abc123');
  assert.equal(c.list()[0].id, 'abc123');
  c.stop('abc123');
  c.rm('abc123');
  assert.deepEqual(calls.map((a) => a[0]), ['--bg', 'agents', 'stop', 'rm']);
});
