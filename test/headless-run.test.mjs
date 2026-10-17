import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { SESSION, usage } from './helpers/transcripts.mjs';
import { fakeClaude } from './helpers/fake-claude.mjs';
import { runSession, resumeSession, buildHeadlessArgs } from '../lib/headless.mjs';
import { projectKey } from '../lib/transcripts.mjs';
import { pidAlive } from '../lib/merge-lock.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const u = (i, c, r, o) => ({ input_tokens: i, cache_creation_input_tokens: c, cache_read_input_tokens: r, output_tokens: o });

// One fake claude per test: its own directory, repository and Claude home; a grandchild it left is ended afterwards.
function setup(t, behavior = {}) {
  const dir = tmpDir('hl');
  const cwd = tmpGitRepo();
  const f = fakeClaude(dir, behavior);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: f.home };
  const deps = { bin: f.bin, pollMs: 100 };
  const S = path.join(dir, 'settings.json');
  const R = path.join(dir, 'role.md');
  fs.writeFileSync(S, '{}');
  fs.writeFileSync(R, 'role');
  t.after(() => {
    const pid = f.grandchildPid();
    try { if (pid) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  });
  return { dir, cwd, f, env, deps, S, R };
}

test('runSession passes the flags, sends the prompt on stdin and returns the session', async (t) => {
  const { cwd, f, env, deps, S } = setup(t);
  const prompt = 'Сделай кусок 02\nстрока 2 — «ok»';
  const r = await runSession({ cwd, role: 'builder', prompt, effort: 'high', settingsFile: S, env }, deps);
  assert.deepEqual(f.calls()[0].argv, buildHeadlessArgs({ effort: 'high', settingsFile: S }));
  assert.equal(f.calls()[0].stdin, prompt);
  assert.deepEqual([r.sessionId, r.result, r.exitCode, r.isError, r.timedOut, r.stalled, r.role, r.ownerQuestion], [SESSION, 'done', 0, false, false, false, 'builder', null]);
  assert.deepEqual(r.usage, usage(20, 200, 2000));
  assert.equal(r.transcript, path.join(f.home, 'projects', projectKey(cwd), `${SESSION}.jsonl`));
  assert.ok(fs.existsSync(r.transcript) && r.wallMs >= 0);
  assert.equal(r.stderrTail, '');
});

test('runSession scrubs the calling session from the child env', async (t) => {
  const { cwd, f, env, deps } = setup(t);
  await runSession({ cwd, prompt: 'x', env: { ...env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'owner' } }, deps);
  assert.deepEqual(f.calls()[0].env, { CLAUDECODE: null, CLAUDE_CODE_SESSION_ID: null, CLAUDE_CONFIG_DIR: f.home });
});

test('runSession calls onStart once with the session id, the pid and the transcript', async (t) => {
  const { cwd, f, env, deps } = setup(t);
  const seen = [];
  const r = await runSession({ cwd, prompt: 'x', env, onStart: (s) => { seen.push(s); throw new Error('a caller bug is not the session\'s'); } }, deps);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, SESSION);
  assert.ok(Number.isInteger(seen[0].pid));
  assert.equal(seen[0].transcript, path.join(f.home, 'projects', projectKey(cwd), `${SESSION}.jsonl`));
  assert.equal(r.result, 'done');
});

test('runSession returns the owner question of the final message', async (t) => {
  const { cwd, f, env, deps } = setup(t);
  f.set({ result: 'Slice blocked.\n## OWNER QUESTION\nQuestion: Which port?\nOptions:\n1. 8080 — free (recommended)\n2. 80 — needs admin' });
  const r = await runSession({ cwd, prompt: 'x', env }, deps);
  assert.equal(r.ownerQuestion.question, 'Which port?');
  assert.equal(r.ownerQuestion.options[0].recommended, true);
});

test('runSession: an is_error result or an exit without a result is an error, with the exit code', async (t) => {
  const { cwd, f, env, deps } = setup(t);
  f.set({ isError: true, exitCode: 1 });
  let r = await runSession({ cwd, prompt: 'x', env }, deps);
  assert.deepEqual([r.isError, r.exitCode], [true, 1]);
  f.set({ noResult: true, exitCode: 0 });
  r = await runSession({ cwd, prompt: 'x', env }, deps);
  assert.deepEqual([r.isError, r.exitCode, r.result], [true, 0, null]);
  assert.deepEqual(r.usage, u(11, 101, 1001, 6)); // msg_1's last usage + msg_2's
});

test('resumeSession runs the same flags plus --resume <id> with the answer on stdin', async (t) => {
  const { cwd, f, env, deps, S, R } = setup(t);
  const opts = { cwd, prompt: 'first', effort: 'high', agent: 'gsd-code-reviewer', settingsFile: S, appendSystemPromptFile: R, env };
  const r = await resumeSession(SESSION, 'Вариант 1', opts, deps);
  assert.deepEqual(f.calls()[0].argv, buildHeadlessArgs({ effort: 'high', agent: 'gsd-code-reviewer', settingsFile: S, appendSystemPromptFile: R, resume: SESSION }));
  assert.equal(f.calls()[0].stdin, 'Вариант 1');
  assert.equal(r.sessionId, SESSION);
  await assert.rejects(resumeSession('a b', 'x', opts, deps), /session id/);
  await assert.rejects(resumeSession(SESSION, '', opts, deps), /answer/);
  assert.equal(f.calls().length, 1);
});

test('paths with spaces reach claude as single arguments', async (t) => {
  const { dir, cwd, f, env, deps } = setup(t);
  const spaced = path.join(dir, 'with space');
  fs.mkdirSync(spaced);
  const S = path.join(spaced, 'settings file.json');
  const R = path.join(spaced, 'role prompt.md');
  fs.writeFileSync(S, '{}');
  fs.writeFileSync(R, 'role');
  await runSession({ cwd, prompt: 'x', settingsFile: S, appendSystemPromptFile: R, env }, deps);
  const argv = f.calls()[0].argv;
  assert.equal(argv[argv.indexOf('--settings') + 1], S);
  assert.equal(argv[argv.indexOf('--append-system-prompt-file') + 1], R);
});

test('a grandchild holding stdout does not hold the result', { timeout: 20000 }, async (t) => {
  const { cwd, f, env, deps } = setup(t);
  f.set({ grandchild: 'inherit' });
  const t0 = Date.now();
  const r = await runSession({ cwd, prompt: 'x', env }, { ...deps, closeGraceMs: 500 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.result, 'done');
  assert.ok(Date.now() - t0 < 5000);
});

test('runSession rejects when claude cannot start or cwd is no directory', async (t) => {
  const { dir, cwd, env, deps } = setup(t);
  await assert.rejects(runSession({ cwd, prompt: 'x', env }, { bin: { cmd: path.join(dir, 'missing.exe'), prefix: [], shell: false } }), /failed to start/);
  await assert.rejects(runSession({ cwd: path.join(dir, 'nope'), prompt: 'x', env }, deps), /not a directory/);
  await assert.rejects(runSession({ cwd, prompt: '', env }, deps), /prompt/);
  await assert.rejects(runSession({ cwd, prompt: 'x', env }, { bin: { cmd: 'claude.cmd', prefix: [], shell: false, unsupported: 'claude is installed as an unrecognized .cmd shim' } }), /unrecognized/);
  for (const bad of [{ timeoutMin: 0 }, { stallMin: -1 }, { stallMin: 'x' }]) await assert.rejects(runSession({ cwd, prompt: 'x', env, ...bad }, deps), /timeoutMin and stallMin/);
});

// Task 5: the watch
const gone = async (pid) => {
  for (let i = 0; i < 50; i++) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return false;
};

test('a silent session is stalled after stallMin and its whole tree is killed', { timeout: 20000 }, async (t) => {
  const { cwd, f, env, deps } = setup(t, { hang: true, grandchild: 'ignore' });
  const r = await runSession({ cwd, prompt: 'x', env, stallMin: 0.02, timeoutMin: 5 }, deps);
  assert.deepEqual([r.stalled, r.timedOut, r.sessionId, r.ownerQuestion, r.isError], [true, false, SESSION, null, true]);
  assert.ok(r.wallMs < 10000);
  assert.ok(f.grandchildPid());
  assert.ok(await gone(f.grandchildPid()), 'the grandchild survived the stall kill');
});

test('a session past timeoutMin is timedOut even while it keeps talking', { timeout: 20000 }, async (t) => {
  const { cwd, f, env, deps } = setup(t, { chatter: true, grandchild: 'ignore' });
  const r = await runSession({ cwd, prompt: 'x', env, stallMin: 1, timeoutMin: 0.03 }, deps);
  assert.deepEqual([r.timedOut, r.stalled], [true, false]);
  assert.ok(await gone(f.grandchildPid()), 'the grandchild survived the timeout kill');
});

test('transcript writes keep a session alive without stream events (its own and a subagent\'s)', { timeout: 30000 }, async (t) => {
  const { cwd, f, env, deps } = setup(t);
  for (const tickSubagent of [false, true]) {
    f.set({ transcriptTicks: 16, tickMs: 150, tickSubagent });
    const r = await runSession({ cwd, prompt: 'x', env, stallMin: 0.02, timeoutMin: 5 }, deps);
    assert.deepEqual([r.stalled, r.result], [false, 'done'], `tickSubagent ${tickSubagent}`);
  }
});

test('a session the tree kill misses is killed alone and finished after killGraceMs', { timeout: 20000 }, async (t) => {
  const { cwd, env, deps } = setup(t, { hang: true });
  const seen = [];
  const r = await runSession({ cwd, prompt: 'x', env, stallMin: 0.01 }, { ...deps, killGraceMs: 300, kill: (pid) => seen.push(pid) });
  assert.equal(r.stalled, true);
  assert.equal(seen.length, 1);
  assert.ok(await gone(seen[0]), 'claude survived child.kill');
});
