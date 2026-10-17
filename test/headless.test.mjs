import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { SESSION } from './helpers/transcripts.mjs';
import { buildHeadlessArgs, headlessEnv, sessionSettings, killTree, parseStreamLine, newStreamState, foldEvent, usageOf, transcriptPath } from '../lib/headless.mjs';
import { projectKey } from '../lib/transcripts.mjs';
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

// Task 2: stream-json, in the shapes the live probe printed (Claude Code 2.1.302)
const u = (i, c, r, o) => ({ input_tokens: i, cache_creation_input_tokens: c, cache_read_input_tokens: r, output_tokens: o });
const HOOK = { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' };
const INIT = { type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-opus-5-5', tools: ['Read'], permissionMode: 'bypassPermissions' };
const A = (id, us) => ({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { id, usage: us } });
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION, usage: u(20, 200, 2000, 50) };
const fold = (...evs) => evs.reduce(foldEvent, newStreamState());

test('parseStreamLine: only a JSON object is an event', () => {
  for (const l of ['', 'not json', '[1]', 'null', '"s"']) assert.equal(parseStreamLine(l), null);
  assert.deepEqual(parseStreamLine('{"type":"x"}\r'), { type: 'x' });
});

test('foldEvent: init names the session; result gives text, error flag and final usage', () => {
  const s = fold(HOOK, INIT, A('msg_1', u(1, 2, 3, 4)), RESULT);
  assert.deepEqual([s.sessionId, s.model, s.tools, s.result, s.isError, s.subtype, s.events], [SESSION, 'claude-opus-5-5', ['Read'], 'ok', false, 'success', 4]);
  assert.deepEqual(usageOf(s), u(20, 200, 2000, 50));
});

test('foldEvent: without a result, usage is the last usage of each distinct message id', () => {
  const s = fold(INIT, A('msg_1', u(10, 100, 1000, 1)), A('msg_1', u(10, 100, 1000, 5)), A('msg_2', u(1, 1, 1, 1)));
  assert.deepEqual(usageOf(s), u(11, 101, 1001, 6));
  assert.equal(s.isError, null);
  assert.equal(s.result, null);
});

test('foldEvent: a usage field missing or not a number counts 0; an is_error result is an error', () => {
  const s = fold(INIT, { ...RESULT, is_error: true, subtype: 'error_during_execution', usage: { input_tokens: 'x', output_tokens: 3 } });
  assert.deepEqual(usageOf(s), u(0, 0, 0, 3));
  assert.equal(s.isError, true);
  assert.deepEqual(usageOf(newStreamState()), u(0, 0, 0, 0));
});

test('foldEvent: a session id from a later event fills in when init had none; a bad one never does', () => {
  assert.equal(fold({ type: 'system', subtype: 'init' }, RESULT).sessionId, SESSION);
  assert.equal(fold({ type: 'system', subtype: 'init', session_id: '../x' }).sessionId, null);
  assert.equal(fold(INIT, { ...RESULT, session_id: 'other' }).sessionId, SESSION);
  assert.equal(fold(null, 'x', [], { type: 'result' }).result, '');
});

test('transcriptPath: the found file, else <home>/projects/<projectKey(cwd)>/<id>.jsonl (Windows spelling too)', () => {
  const home = tmpDir('home');
  const cwd = tmpDir('cwd');
  const want = path.join(home, 'projects', projectKey(cwd), `${SESSION}.jsonl`);
  assert.equal(transcriptPath({ home, cwd, sessionId: SESSION }), want); // not written yet: computed
  const elsewhere = path.join(home, 'projects', 'other', `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  fs.writeFileSync(elsewhere, '{}\n');
  assert.equal(transcriptPath({ home, cwd, sessionId: SESSION }), elsewhere); // a found file as is
  assert.equal(transcriptPath({ home: 'C:\\h', cwd: 'C:\\Users\\u\\my proj', sessionId: SESSION, platform: 'win32' }),
    `C:\\h\\projects\\C--Users-u-my-proj\\${SESSION}.jsonl`);
});
