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
  // stage 2: full mode also needs the installed turbo-phase skill and turbo-uat agent
  fs.mkdirSync(path.join(home, 'skills', 'turbo-phase'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'turbo-phase', 'SKILL.md'), 'x');
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'agents', 'turbo-uat.md'), 'x');
  return { home, core, root };
}

const execOk = (version) => (cmd, args) => {
  if (cmd === 'git') return 'git version 2.45.0';
  if (args.includes('manager')) return '{"phases":[]}';
  if (args.includes('render-hooks')) return '{"activeHooks":[]}';
  if (args.includes('agents')) return '[]';
  if (args.includes('--version')) return `${version} (Claude Code)`;
  return '';
};

const BIN = { cmd: 'claude', prefix: [], shell: false };

test('full mode when everything is in range', () => {
  const e = env();
  const r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execOk('2.1.291'), claudeBin: BIN });
  assert.equal(r.mode, 'full', JSON.stringify(r.checks));
  assert.deepEqual(r.warnings, []);
});

test('a warning per nested package with its own test script that test.full does not run; an invalid test.full is reported', () => {
  const e = env();
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(e.root, f)), { recursive: true }); fs.writeFileSync(path.join(e.root, f), s); };
  const pkg = (test) => JSON.stringify({ scripts: { test } });
  w('package.json', pkg('node --test'));
  w('server/package.json', pkg('node --test'));
  w('app/package.json', pkg('vitest run'));
  w('tools/package.json', pkg('echo "Error: no test specified" && exit 1'));
  w('docs/site/package.json', JSON.stringify({ scripts: { build: 'site' } }));
  w('node_modules/dep/package.json', pkg('mocha'));
  w('untracked/package.json', pkg('node --test'));
  // review 7d: test data, not packages of the project
  w('test/fixtures/demo/package.json', pkg('node --test'));
  w('src/__fixtures__/sample/package.json', pkg('jest'));
  w('.planning/turbo/config.json', JSON.stringify({ test: { full: ['npm test', { dir: 'app', command: 'npm test' }] } }));
  const tracked = ['package.json', 'server/package.json', 'app/package.json', 'tools/package.json', 'docs/site/package.json', 'node_modules/dep/package.json', 'test/fixtures/demo/package.json', 'src/__fixtures__/sample/package.json'];
  const lsCwd = [];
  const exec = (cmd, args, opts) => {
    if (cmd === 'git' && args[0] === 'ls-files') { lsCwd.push(opts.cwd); return `${tracked.join('\0')}\0`; }
    return execOk('2.1.291')(cmd, args);
  };
  const run = () => doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec, claudeBin: BIN });
  const r = run();
  assert.equal(r.mode, 'full', 'a warning, not a failed check');
  assert.deepEqual(r.warnings, ['nested package server has its own test script that test.full does not run']);
  assert.deepEqual(lsCwd, [e.root]);
  w('.planning/turbo/config.json', JSON.stringify({ test: { full: 'npm test' } }));
  assert.deepEqual(run().warnings, ['app', 'server'].map((d) => `nested package ${d} has its own test script that test.full does not run`));
  w('.planning/turbo/config.json', JSON.stringify({ test: { full: ['npm test', { dir: 'missing', command: 'npm test' }] } }));
  const bad = run();
  assert.equal(bad.mode, 'full');
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /^invalid turbo config .*test\.full\[1\]\.dir "missing" is not a directory in the project$/);
});

test('context-window: a warning when GSD\'s effective context_window differs from turbo\'s, ok when they agree, nothing when GSD says nothing', () => {
  const e = env();
  const execWindow = (gsd) => (cmd, args) => (args.includes('config-get') ? gsd : execOk('2.1.291')(cmd, args));
  const check = (r) => r.checks.find((c) => c.name === 'context-window');
  let r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execWindow('200000\n'), claudeBin: BIN });
  assert.deepEqual([check(r).ok, check(r).warn], [true, true]);
  assert.match(check(r).detail, /^GSD's context_window is 200000, turbo's is 1000000/);
  assert.equal(r.mode, 'full', 'a warning, never a failure');
  fs.mkdirSync(path.join(e.root, '.planning', 'turbo'));
  fs.writeFileSync(path.join(e.root, '.planning', 'turbo', 'config.json'), JSON.stringify({ context_window: 200000 }));
  r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execWindow('200000'), claudeBin: BIN });
  assert.deepEqual(check(r), { name: 'context-window', ok: true, detail: '200000' });
  r = doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec: execWindow(''), claudeBin: BIN });
  assert.equal(check(r), undefined);
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

test('git below 2.31 fails the push check while push.mode is on, and is a warning while it is off (S2)', () => {
  const run = (git, mode) => {
    const e = env();
    if (mode) {
      fs.mkdirSync(path.join(e.root, '.planning', 'turbo'), { recursive: true });
      fs.writeFileSync(path.join(e.root, '.planning', 'turbo', 'config.json'), JSON.stringify({ push: { mode } }));
    }
    const exec = (cmd, args) => (cmd === 'git' && args[0] === '--version' ? `git version ${git}` : execOk('2.1.291')(cmd, args));
    return doctor({ root: e.root, env: { CLAUDE_CONFIG_DIR: e.home }, exec, claudeBin: BIN });
  };
  const on = run('2.30.2', 'after-wave');
  assert.deepEqual(on.checks.find((c) => c.name === 'git-push-scan'), { name: 'git-push-scan', ok: false, detail: 'git 2.30.2; push.mode after-wave needs git 2.31 or newer (the push scan uses --diff-merges)' });
  assert.equal(on.mode, 'full', 'the push check does not change the mode');
  const off = run('2.30.2', null);
  assert.equal(off.checks.some((c) => c.name === 'git-push-scan'), false);
  assert.deepEqual(off.warnings, ['git 2.30.2 is older than 2.31: push.mode other than off would not work (the push scan uses --diff-merges)']);
  assert.deepEqual(run('2.31.0.windows.1', 'after-phase').checks.find((c) => c.name === 'git-push-scan'), { name: 'git-push-scan', ok: true, detail: 'git 2.31.0' });
  assert.deepEqual(run('2.45.0', null).warnings, []);
});
