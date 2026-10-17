import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { SESSION } from './helpers/transcripts.mjs';
import { buildHeadlessArgs, headlessEnv, sessionSettings, killTree } from '../lib/headless.mjs';
import { decodeGuardArg, GUARD_MATCHER } from '../lib/lane-guard.mjs';
import { pidAlive } from '../lib/merge-lock.mjs';

test('buildHeadlessArgs: the exact flag order', () => {
  assert.deepEqual(buildHeadlessArgs({ effort: 'high', settingsFile: 'S', agent: 'gsd-code-reviewer', appendSystemPromptFile: 'R' }),
    ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--effort', 'high', '--permission-mode', 'bypassPermissions',
      '--settings', 'S', '--disallowedTools', 'AskUserQuestion', '--agent', 'gsd-code-reviewer', '--append-system-prompt-file', 'R']);
});

test('buildHeadlessArgs: optional flags are left out; resume comes last', () => {
  assert.deepEqual(buildHeadlessArgs({}), ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'AskUserQuestion']);
  assert.deepEqual(buildHeadlessArgs({ resume: SESSION }).slice(-2), ['--resume', SESSION]);
});

test('buildHeadlessArgs: refuses a bad effort, agent or resume id', () => {
  assert.throws(() => buildHeadlessArgs({ effort: 'ultra' }), /effort/);
  assert.throws(() => buildHeadlessArgs({ agent: '../x' }), /agent/);
  assert.throws(() => buildHeadlessArgs({ resume: 'a b' }), /session id/);
});

test('headlessEnv drops the calling session and keeps the config dir', () => {
  const env = { PATH: 'p', CLAUDE_CONFIG_DIR: 'h', claudecode: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_JOB_DIR: 'j', CLAUDE_CODE_MESSAGING_SOCKET: 'm', CLAUDE_EFFORT: 'max', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' };
  assert.deepEqual(headlessEnv(env), { PATH: 'p', CLAUDE_CONFIG_DIR: 'h', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1' });
});

test('sessionSettings writes the lane settings with the worktree as an allowed root, outside the session temp dir', (t) => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpDir('home');
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  });
  const root = tmpGitRepo();
  const worktree = tmpDir('wt');
  const { settingsFile, tmpDir: dir } = sessionSettings({ root, key: '3-s02', cwd: worktree, controlRoot: root });
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(path.dirname(settingsFile), path.dirname(dir)); // in laneTmpBase(root), not inside the temp dir
  assert.equal(path.basename(dir), 'p3-s02');
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepEqual([s.env.TURBO_LANE, s.env.TMP], ['1', dir]);
  assert.equal(s.hooks.PreToolUse[0].matcher, GUARD_MATCHER);
  const arg = s.hooks.PreToolUse[0].hooks[0].command.split(' ').at(-1);
  assert.deepEqual(decodeGuardArg(arg).roots, [path.resolve(worktree), dir, path.join(root, '.planning', 'turbo')]);
  assert.equal('hooks' in JSON.parse(fs.readFileSync(sessionSettings({ root, key: '3-s03', cwd: worktree, guard: false }).settingsFile, 'utf8')), false);
  assert.throws(() => sessionSettings({ root, key: '../x', cwd: worktree }), /key/);
});

test('killTree ends a process and its child', { timeout: 20000 }, async (t) => {
  const grand = 'setInterval(() => {}, 1000)';
  const parentCode = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
  let childPid = null;
  t.after(() => {
    for (const pid of [parent.pid, childPid]) {
      try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });
  childPid = await new Promise((resolve, reject) => {
    let out = '';
    parent.stdout.on('data', (d) => {
      out += d;
      const m = /(\d+)\r?\n/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    parent.on('exit', () => reject(new Error('the parent exited before printing its child')));
  });
  assert.ok(pidAlive(childPid));
  killTree(parent.pid);
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    gone = !pidAlive(parent.pid) && !pidAlive(childPid);
    if (!gone) await sleep(100);
  }
  assert.equal(gone, true, `parent ${parent.pid} or child ${childPid} survived`);
});

test('killTree never throws', () => {
  killTree(2147483644);
  killTree(2147483644, { platform: 'win32', exec: () => { throw new Error('taskkill failed'); } });
  killTree(2147483644, { platform: 'linux' });
});
