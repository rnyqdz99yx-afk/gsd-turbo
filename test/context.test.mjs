import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { lastUsage, measureContext } from '../lib/context.mjs';
import { DEFAULTS } from '../lib/config.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const runAsync = (args, cwd, env) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
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

test('with a phase whose lane supervisor.json records: that lane session\'s transcript, even when another one is newer', () => {
  const f = setup();
  fs.mkdirSync(path.join(f.root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.planning', 'turbo', 'run', 'supervisor.json'), JSON.stringify({ lane: { phase: '3', sessionId: 'abcd1234' } }));
  f.transcript(keyOf(f.root), 'abcd1234-5678-90ab', [assistant(f.root, usage(0, 0, 610000))]);
  f.transcript(keyOf(f.root), 'ffff0000-1111', [assistant(f.root, usage(0, 0, 50000))]); // the owner's own session, newer
  assert.equal(measureContext({ root: f.root, phase: '3', window: 1000000, env: f.env }).pct, 61);
  assert.equal(measureContext({ root: f.root, phase: '4', window: 1000000, env: f.env }).pct, 5, 'no lane for phase 4: the newest transcript');
  fs.rmSync(path.join(f.home, 'projects', keyOf(f.root), 'abcd1234-5678-90ab.jsonl'));
  assert.match(measureContext({ root: f.root, phase: '3', window: 1000000, env: f.env }).unknown, /no transcript of lane session abcd1234/);
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
