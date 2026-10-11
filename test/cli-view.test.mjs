import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { SESSION, entry, projectDirFor, usage, writeAgent, writeSession } from './helpers/transcripts.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const run = (args, cwd, env) => execFileSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

test('turbo-run view prints the lane and its subagents; --json prints the same view as one JSON object', () => {
  const root = tmpGitRepo();
  const run_ = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run_, { recursive: true });
  // a dead pid without a recent heartbeat: not running
  fs.writeFileSync(path.join(run_, 'supervisor.json'), JSON.stringify({ pid: 2147483644, updatedAt: ago(120), lane: { phase: '32', sessionId: SESSION.slice(0, 8), launchedAt: ago(30), mode: 'full' } }));
  const home = tmpDir('home');
  const dir = projectDirFor(home, root);
  writeSession(dir, SESSION, [entry.user('run phase 32', ago(30)), entry.launched('toolu_1', 'a4000000000000001', ago(20))]);
  writeAgent(dir, SESSION, 'a4000000000000001', [
    entry.agentUser('a4000000000000001', 'Execute the plan', ago(20)),
    entry.assistant({ ts: ago(1), tool: { name: 'Edit', input: { file_path: path.join(root, 'lib', 'x.mjs') } }, usage: usage(0, 0, 166000), sidechain: true }),
  ]);
  const env = { CLAUDE_CONFIG_DIR: home };
  const text = run(['view'], root, env);
  // the pane's words: verdict first, the helper indented, then the latest changes and the supervisor
  assert.match(text, /^Phase 32 — freshness check · 30m so far · supervisor not running$/m);
  assert.match(text, /^ {2}Executor · plan 32-07 · editing lib\/x\.mjs · 20m$/m);
  assert.match(text, /^Latest changes:\n {2}[0-9a-f]{7,} init$/m);
  assert.match(text, /\n\nSupervisor not running\n$/);
  assert.doesNotMatch(text, /11111111|166k/, 'no session id, no bare token count');
  const v = JSON.parse(run(['view', '--json'], root, env));
  assert.equal(v.supervisor.running, false);
  assert.equal(v.lanes[0].agents[0].agentId, 'a4000000000000001');
  assert.equal(v.lanes[0].agents[0].state, 'running');
});

// The exit status and stderr of a failing CLI call.
function failure(args, cwd) {
  try {
    run(args, cwd, { CLAUDE_CONFIG_DIR: tmpDir('home') });
  } catch (e) {
    return { status: e.status, stderr: e.stderr };
  }
  return { status: 0, stderr: '' };
}

test('turbo-run view outside a GSD project exits 1 with one line', () => {
  const r = failure(['view'], tmpDir('noplan'));
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), 'no .planning directory found');
});

test('turbo-run view with a broken turbo config exits 1 with a one-line error, never a stack trace (Review Focus 5)', () => {
  const root = tmpDir('badcfg');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), '{"stall_minutes": ');
  const r = failure(['view', '--json'], root);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  assert.match(r.stderr, /^invalid turbo config .*config\.json: /);
});
