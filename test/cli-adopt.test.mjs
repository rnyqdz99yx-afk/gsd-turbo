import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { MANAGER, adoptProject, closedRow, commitAll, write } from './helpers/adopt.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const PATH_KEY = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// A claude stand-in for doctor: its version and an empty agents list. Runs as CommonJS.
function fakeClaude() {
  const args = process.argv.slice(2);
  if (args[0] === '--version') console.log('2.1.291 (Claude Code)');
  else if (args[0] === 'agents') console.log('[]');
  else process.exitCode = 2;
}

// The isolated env of a spawned turbo-run: no lane, no control root, no git config of the developer's, an empty Claude
// home, the fake claude first on PATH.
function env(root) {
  const bin = path.join(tmpDir('adopt-bin'), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude-fake.cjs'), `(${fakeClaude})();\n`);
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@"%dp0%\\claude-fake.cjs" %*\r\n');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\n(${fakeClaude})();\n`, { mode: 0o755 });
  const e = { ...process.env, TURBO_LANE: '', GIT_CONFIG_GLOBAL: path.join(root, '.git', 'no-global'), GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CONFIG_DIR: tmpDir('adopt-home'), [PATH_KEY]: `${bin}${path.delimiter}${process.env[PATH_KEY]}` };
  delete e.TURBO_CONTROL_ROOT;
  return e;
}
const run = (args, root, e = env(root)) => new Promise((resolve) => {
  execFile(process.execPath, [CLI, ...args], { cwd: root, env: e, encoding: 'utf8', windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr, lines: stdout.split(/\r?\n/).filter(Boolean) });
  });
});
const QUIET = { notify: { desktop: false, telegram: false }, lanes: { mode: 'checkout' } };

test('adopt scan prints the overview; --json the overview object; refusals exit 1, one line each', async () => {
  const p = adoptProject({ config: QUIET });
  let r = await run(['adopt', 'scan'], p.root);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.lines[0], 'phases:');
  assert.ok(r.lines.includes('  closed, verification stale: 1'), r.stdout);
  r = await run(['adopt', 'scan', '--json'], p.root);
  assert.deepEqual(JSON.parse(r.stdout).staleClosed, ['1']);
  fs.writeFileSync(path.join(p.root, 'mine.txt'), 'x\n');
  r = await run(['adopt', 'scan'], p.root);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^refused: uncommitted changes: mine\.txt: /m);
});

test('adopt is the owner\'s: refused in a lane; a wrong answer or a missing plan sha is a usage error (exit 2)', async () => {
  const p = adoptProject({ config: QUIET });
  let r = await run(['adopt', 'scan'], p.root, { ...env(p.root), TURBO_LANE: '1' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refused: adopt is the owner's: a lane never runs it/);
  r = await run(['adopt', 'plan', '--answers', 'bogus=1'], p.root);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage: turbo-run adopt /);
  r = await run(['adopt', 'apply', '--answers', 'stale-closed=keep'], p.root);
  assert.equal(r.code, 2);
  r = await run(['adopt', 'frobnicate'], p.root);
  assert.equal(r.code, 2);
});

test('adopt plan, reverify and apply: the questions as JSON, the change list with its digest, one commit and the report; the Claude home stays empty', async () => {
  const p = adoptProject({ config: QUIET });
  const e = env(p.root);
  let r = await run(['adopt', 'plan', '--json'], p.root, e);
  assert.equal(r.code, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json.questions.map((q) => q.id), ['stale-closed']);
  assert.match(json.plan, /^[0-9a-f]{64}$/);
  r = await run(['adopt', 'plan', '--answers', 'stale-closed=keep'], p.root, e);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.lines.includes('changes:'));
  const sha = /^plan: ([0-9a-f]{64})$/.exec(r.lines.at(-1))?.[1];
  assert.ok(sha, r.stdout);
  r = await run(['adopt', 'reverify', '3'], p.root, e);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^refused: phase 3 is not a closed phase with a stale verification$/m);
  r = await run(['adopt', 'apply', '--answers', 'stale-closed=keep', '--plan-sha', sha], p.root, e);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.lines[0], /^committed [0-9a-f]{7,} chore\(turbo\): adopt$/);
  assert.equal(r.lines.at(-1), '/turbo-autonomous');
  assert.deepEqual(fs.readdirSync(e.CLAUDE_CONFIG_DIR), []);
  r = await run(['adopt', 'apply', '--answers', '', '--plan-sha', 'f'.repeat(64)], p.root, e);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^refused: the plan changed since it was shown/m);
});

test('adopt reverify: a passing fresh report', async () => {
  const p = adoptProject({ config: QUIET });
  write(p.root, '.planning/phases/01-base/01-VERIFICATION.md', '---\nstatus: passed\n---\nfresh\n');
  const r = await run(['adopt', 'reverify', '1'], p.root);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.lines[0], 'phase 1: re-verified: passed');
});

test('start and status name the closed phases turbo skips until the owner decided in adopt; in Russian too', async () => {
  // every other phase done: the supervisor start launches finishes at once
  const done = (n) => ({ ...closedRow(n), disk_status: 'complete', phase_complete: true, verification_status: 'passed' });
  const p = adoptProject({ config: QUIET, manager: { ...MANAGER, phases: [closedRow('1'), done('2'), done('3'), done('4')] } });
  const e = env(p.root);
  const line = 'closed phases not re-verified: 1 (checked off, verification stale; turbo skips them) · /turbo-adopt';
  let r = await run(['status'], p.root, e);
  assert.deepEqual(r.lines.slice(0, 2), ['supervisor: not running (never started)', line]);
  r = await run(['start'], p.root, e);
  assert.ok(r.lines.includes(line), r.stdout + r.stderr);
  r = await run(['status'], p.root, e);
  assert.ok(r.lines.includes(line), r.stdout);
  write(p.root, '.planning/turbo/config.json', JSON.stringify({ ...QUIET, lang: 'ru' }));
  commitAll(p.root);
  r = await run(['status'], p.root, e);
  assert.ok(r.lines.some((l) => l.startsWith('закрытые фазы без свежей проверки: 1 (')), r.stdout);
  r = await run(['adopt', 'plan', '--answers', 'stale-closed=keep'], p.root, e);
  const sha = /^plan: ([0-9a-f]{64})$/.exec(r.lines.at(-1))?.[1];
  r = await run(['adopt', 'apply', '--answers', 'stale-closed=keep', '--plan-sha', sha], p.root, e);
  assert.equal(r.code, 0, r.stderr);
  r = await run(['status'], p.root, e);
  assert.ok(!r.lines.some((l) => /закрытые фазы|closed phases/.test(l)), r.stdout);
});
