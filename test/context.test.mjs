import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { lastUsage, measureContext } from '../lib/context.mjs';
import { DEFAULTS } from '../lib/config.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
// The calling session's own ids are cleared: these tests may run inside a Claude Code session.
const runAsync = (args, cwd, env) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_JOB_DIR: '', ...env }, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
  });
});

// The shapes Claude Code writes to projects/<key>/<sessionId>.jsonl (only the fields turbo reads).
const usage = (input, create, read) => ({ input_tokens: input, cache_creation_input_tokens: create, cache_read_input_tokens: read, output_tokens: 50 });
const assistant = (cwd, u, extra = {}) => ({ type: 'assistant', isSidechain: false, cwd, sessionId: 'x', message: { model: 'claude-x', usage: u }, ...extra });
const user = (cwd, text = 'hi') => ({ type: 'user', isSidechain: false, cwd, sessionId: 'x', message: { content: text } });

function setup() {
  const base = tmpDir('ctx');
  const root = path.join(base, 'my project');
  const home = path.join(base, 'claude-home');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  let t = Date.parse('2026-01-01T00:00:00Z');
  return {
    root,
    home,
    env: { CLAUDE_CONFIG_DIR: home },
    // a transcript under projects/<dir>/<name>.jsonl, each one newer than the last
    transcript(dir, name, entries) {
      const file = path.join(home, 'projects', dir, `${name}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');
      t += 60000;
      fs.utimesSync(file, new Date(t), new Date(t));
      return file;
    },
  };
}
const keyOf = (root) => root.replace(/[^A-Za-z0-9]/g, '-');

test('context_window defaults to 1000000 in the turbo config', () => {
  assert.equal(DEFAULTS.context_window, 1000000);
});

test('the last main-chain assistant usage counts: input + cache creation + cache read; sidechain and synthetic entries do not', () => {
  const f = setup();
  f.transcript(keyOf(f.root), 'aaaa1111-0000', [
    user(f.root),
    assistant(f.root, usage(1, 10, 100)),
    assistant(f.root, usage(3, 2000, 268000)),
    assistant(f.root, usage(9, 9, 900000), { isSidechain: true }),
    assistant(f.root, usage(0, 0, 0), { message: { model: '<synthetic>', usage: usage(0, 0, 0) } }),
    user(f.root, 'tool result'),
    '{"type":"summary"', // a line cut short
  ]);
  const r = measureContext({ root: f.root, window: 1000000, env: f.env });
  assert.deepEqual([r.used, r.window, r.pct], [270003, 1000000, 27]);
});

test('without a lane: the newest transcript whose cwd is the project root, wherever it lives; other projects are skipped', () => {
  const f = setup();
  const other = path.join(path.dirname(f.root), 'other');
  f.transcript(keyOf(f.root), 'old', [assistant(f.root, usage(0, 0, 100000))]);
  f.transcript('renamed-folder', 'mine', [assistant(f.root, usage(0, 0, 400000))]);
  f.transcript(keyOf(other), 'theirs', [assistant(other, usage(0, 0, 900000))]);
  f.transcript(keyOf(f.root), 'foreign-in-my-folder', [assistant(other, usage(0, 0, 800000))]);
  const r = measureContext({ root: f.root, window: 1000000, env: f.env });
  assert.equal(r.used, 400000);
  assert.ok(r.transcript.endsWith(`mine.jsonl`), r.transcript);
});

const laneRecord = (f, sessionId) => {
  fs.mkdirSync(path.join(f.root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.planning', 'turbo', 'run', 'supervisor.json'), JSON.stringify({ lane: { phase: '3', sessionId } }));
};
const jobState = (f, jobId, state) => {
  const dir = path.join(f.home, 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  return dir;
};
const measure = (f, extra = {}, phase = '3') => measureContext({ root: f.root, phase, window: 1000000, env: { ...f.env, ...extra } });

test('the calling session comes first: CLAUDE_CODE_SESSION_ID names its transcript, over a recorded lane and a newer transcript, whatever its cwd', () => {
  const f = setup();
  laneRecord(f, 'abcd1234'); // a lane that stopped (needs-owner): its record stays
  f.transcript(keyOf(f.root), 'abcd1234-5678-90ab', [assistant(f.root, usage(0, 0, 190000))]);
  f.transcript(keyOf(f.root), 'ffff0000-1111', [assistant(path.join(f.root, 'backend'), usage(0, 0, 280000))]); // the caller, in a subfolder
  f.transcript(keyOf(f.root), 'eeee0000-2222', [assistant(f.root, usage(0, 0, 50000))]); // another session, newer
  const r = measure(f, { CLAUDE_CODE_SESSION_ID: 'ffff0000-1111' });
  assert.deepEqual([r.pct, r.source], [28, 'session']);
  assert.equal(measure(f, { CLAUDE_CODE_SESSION_ID: 'ffff0000-1111' }, null).pct, 28, 'without a phase too');
  assert.equal(measure(f, { CLAUDE_CODE_SESSION_ID: '9999' }).pct, 19, 'an id without a transcript: the next way, here the lane');
  assert.equal(measure(f, { CLAUDE_CODE_SESSION_ID: '../x' }).pct, 19, 'never a path');
});

test('a woken background job: its state.json names the transcript it writes now (linkScanPath, else resumeSessionId), never the old <jobId>-… one', () => {
  const f = setup();
  const old = f.transcript(keyOf(f.root), 'abcd1234-5678-90ab', [assistant(f.root, usage(0, 0, 527873))]);
  const now = f.transcript(keyOf(f.root), 'bbbb2222-0000', [assistant(f.root, usage(0, 0, 278097))]);
  fs.utimesSync(old, new Date(), new Date()); // the old one even looks newer
  const job = jobState(f, 'abcd1234', { sessionId: 'abcd1234-5678-90ab', resumeSessionId: 'bbbb2222-0000', linkScanPath: now });
  assert.deepEqual([measure(f, { CLAUDE_JOB_DIR: job }).used, measure(f, { CLAUDE_JOB_DIR: job }).source], [278097, 'job']);
  jobState(f, 'abcd1234', { sessionId: 'abcd1234-5678-90ab', resumeSessionId: 'bbbb2222-0000', linkScanPath: path.join(path.dirname(f.home), 'elsewhere.jsonl') });
  assert.equal(measure(f, { CLAUDE_JOB_DIR: job }).used, 278097, 'a linkScanPath outside projects/ is not read');
  // the lane record of phase 3 names the same job: its state comes before the prefix of its id
  laneRecord(f, 'abcd1234');
  assert.deepEqual([measure(f).used, measure(f).source], [278097, 'lane']);
  fs.rmSync(path.join(f.home, 'jobs'), { recursive: true });
  assert.equal(measure(f).used, 527873, 'without a job state: the transcript named after the lane id');
});

test('the newest-transcript fallback takes a cwd inside the root (subfolders; on win32 the Git Bash /c/… form and any case), never a sibling folder', () => {
  const f = setup();
  const sibling = `${f.root}-other`;
  f.transcript(keyOf(f.root), 'a', [assistant(path.join(f.root, 'backend'), usage(0, 0, 100000))]);
  f.transcript(keyOf(sibling), 'b', [assistant(sibling, usage(0, 0, 900000))]);
  assert.equal(measure(f, {}, null).used, 100000);
  if (process.platform === 'win32') {
    const gitBash = `/${f.root[0].toLowerCase()}${f.root.slice(2).replace(/\\/g, '/')}`;
    f.transcript(keyOf(f.root), 'c', [assistant(gitBash, usage(0, 0, 200000))]);
    assert.equal(measure(f, {}, null).used, 200000);
    f.transcript(keyOf(f.root), 'd', [assistant(f.root.toUpperCase(), usage(0, 0, 300000))]);
    assert.equal(measure(f, {}, null).used, 300000);
  }
  assert.equal(measure(f, {}, '7').source, 'newest');
});

test('only the tail of a large transcript is read; the window grows past a long last line', () => {
  const f = setup();
  const pad = user(f.root, 'x'.repeat(1000));
  const big = f.transcript(keyOf(f.root), 'big', [...Array(3000).fill(pad), assistant(f.root, usage(0, 0, 123456)), user(f.root, 'y'.repeat(600 * 1024))]);
  const size = fs.statSync(big).size;
  const r = lastUsage(big);
  assert.equal(r.used, 123456);
  assert.ok(r.read < size / 2, `read ${r.read} of ${size}`);
  assert.ok(r.read > 600 * 1024);
});

test('unknown, with the reason, when nothing can be measured', () => {
  const f = setup();
  assert.match(measureContext({ root: f.root, window: 1000000, env: f.env }).unknown, /no transcript of .* under /);
  f.transcript(keyOf(f.root), 'fresh', [user(f.root)]);
  assert.match(measureContext({ root: f.root, window: 1000000, env: f.env }).unknown, /no assistant message with token usage/);
  assert.match(measureContext({ root: f.root, window: 0, env: f.env }).unknown, /context_window .* not a positive number/);
});

test('turbo-run context prints the measured context, exit 0; unknown also exits 0; --json carries the numbers', async () => {
  const f = setup();
  fs.mkdirSync(path.join(f.root, '.planning', 'turbo'), { recursive: true });
  let r = await runAsync(['context'], f.root, f.env);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^context: unknown \(no transcript of .+\)\r?\n$/);
  f.transcript(keyOf(f.root), 's1', [assistant(f.root, usage(1, 2, 269997))]);
  r = await runAsync(['context', '03'], f.root, f.env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'context: 270000 of 1000000 tokens (27%)');
  fs.writeFileSync(path.join(f.root, '.planning', 'turbo', 'config.json'), JSON.stringify({ context_window: 200000 }));
  r = await runAsync(['context', '--json'], f.root, f.env);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.used, j.window, j.pct], [270000, 200000, 135]);
  r = await runAsync(['context', '../x'], f.root, f.env);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /usage: turbo-run context \[<phase>\] \[--json\]/);
});
