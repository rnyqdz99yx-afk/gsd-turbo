import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED } from './helpers/slots.mjs';
import { buildProject } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { pidAlive } from '../lib/merge-lock.mjs';
import { BUILD_STEPS } from '../lib/build.mjs';
import { runDir, locksDir } from '../lib/paths.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';

const BIN = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));
const HOME = tmpDir('cli-build-home');

function run(root, args, env = {}) {
  const e = { ...ISOLATED, CLAUDE_CONFIG_DIR: HOME, TURBO_LANE: '', TURBO_BUILD_LANE: '', ...env };
  delete e.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [BIN, ...args, '--project', root], { cwd: root, env: e, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const writeState = (root, fields) => {
  fs.mkdirSync(runDir(root), { recursive: true });
  fs.writeFileSync(path.join(runDir(root), 'build-p5.json'), JSON.stringify({ v: 1, phase: '5', round: 0, startedAt: new Date().toISOString(), head0: null, graphSha: null, maxBuilders: 4, edges: [], order: [], red: null, hold: null, slices: {}, step: 'begin', steps: {}, base: null, roundBase: null, gapRounds: 0, info: { name: 'Demo Feature', padded: '05' }, ...fields }));
};

test('build: usage and refusals', () => {
  const p = buildProject();
  for (const args of [['build'], ['build', 'x/y'], ['build', '5', '--bogus']]) {
    const r = run(p.root, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /usage: turbo-run build <phase> \[--resume\] \[--json\]/);
  }
  const off = buildProject({ config: { build: { enabled: false } } });
  const r1 = run(off.root, ['build', '5']);
  assert.equal(r1.code, 2);
  assert.match(r1.err, /refused: build\.enabled is false; phase 5 runs the lean path \(\/turbo-phase\)/);
  assert.equal(readLaneStatus(off.root, '5'), null);
  const r2 = run(off.root, ['build', '5'], { TURBO_BUILD_LANE: '1' });
  assert.equal(r2.code, 2);
  assert.deepEqual([readLaneStatus(off.root, '5').status, readLaneStatus(off.root, '5').reason], ['failed', 'build refused: build.enabled is false']);
  const r3 = run(p.root, ['build', '5'], { TURBO_LANE: '1' });
  assert.equal(r3.code, 2);
  assert.match(r3.err, /refused: build is the owner's: a lane never runs it/);

  writeState(p.root, { step: 'slice' });
  const r4 = run(p.root, ['build', '5']);
  assert.equal(r4.code, 2);
  assert.match(r4.err, /phase 5 has a build in progress \(step slice\): turbo-run build 5 --resume continues it/);

  const q = buildProject();
  fs.mkdirSync(locksDir(q.root), { recursive: true });
  fs.writeFileSync(path.join(locksDir(q.root), 'build-run-p5.json'), JSON.stringify({ pid: process.pid, token: 'x', startedAt: new Date().toISOString(), beat: new Date().toISOString() }));
  const r5 = run(q.root, ['build', '5']);
  assert.equal(r5.code, 3);
  assert.match(r5.err, new RegExp(`phase 5: a build runs already \\(pid ${process.pid}\\)`));
});

// A claude on PATH that lists no session (turbo-run stop and attend list lane sessions): never a real claude.
function noSessionsClaude() {
  const dir = tmpDir('claude-bin');
  fs.writeFileSync(path.join(dir, 'agents.cjs'), "process.stdout.write('[]');\n");
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@"%dp0%\\agents.cjs" %*\r\n');
  fs.writeFileSync(path.join(dir, 'claude'), "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { [key]: `${dir}${path.delimiter}${process.env[key]}` };
}
// A node process that stands for a running build: its runner record, and the checkout supervisor's build lane.
function runningBuild(t, root, { exitMs = null } = {}) {
  const child = spawn(process.execPath, ['-e', exitMs ? `setTimeout(() => {}, ${exitMs})` : 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  fs.mkdirSync(locksDir(root), { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(locksDir(root), 'build-run-p5.json'), JSON.stringify({ pid: child.pid, token: 'x', startedAt: now, beat: now }));
  fs.mkdirSync(runDir(root), { recursive: true });
  fs.writeFileSync(path.join(runDir(root), 'supervisor.json'), JSON.stringify({ pid: null, finished: false, halted: false, range: null, lane: { phase: '5', path: 'build', pid: child.pid, sessionId: null, launchedAt: now, mode: 'full', restarts: 0, notified: {} } }));
  return child;
}

test('stop asks a running build to pause first and ends it on the second stop', async (t) => {
  const p = buildProject();
  const child = runningBuild(t, p.root);
  writeState(p.root, { step: 'build' });
  const env = noSessionsClaude();
  const first = run(p.root, ['stop'], env);
  assert.match(first.out, /^phase 5: the build stops after its running sessions; run turbo-run stop again to end them now$/m, first.err);
  assert.equal(pidAlive(child.pid), true);
  // the second stop ends it: the first came after the build started (whether or not the build recorded its hold yet)
  const second = run(p.root, ['stop'], env);
  assert.match(second.out, new RegExp(`^phase 5: build pid ${child.pid} ended$`, 'm'), second.err);
  for (let i = 0; i < 50 && pidAlive(child.pid); i++) await sleep(100);
  assert.equal(pidAlive(child.pid), false);
});

test('attend of a build lane waits for the build to pause', (t) => {
  const p = buildProject();
  p.write(`${p.rel}/05-01-PLAN.md`, compactPlan({ id: '05-01' }));
  p.commit('docs: plan');
  runningBuild(t, p.root, { exitMs: 1000 });
  const r = run(p.root, ['attend', '5'], noSessionsClaude());
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const lines = r.out.split(/\r?\n/);
  for (const l of ['phase 5: the build pauses: it finishes its running sessions first', 'phase 5: attended in this session; no lane starts, relaunches or wakes until turbo-run attend 5 --done', 'open plans: 05-01', 'gates: keep on (the build path reviews and verifies after attend 5 --done)']) assert.ok(lines.includes(l), `${l}\n${r.out}`);
  assert.ok(fs.existsSync(path.join(runDir(p.root), 'p5-attend.json')));
});

test('status shows a build lane\'s step and slices', () => {
  const p = buildProject();
  const at = new Date().toISOString();
  fs.mkdirSync(runDir(p.root), { recursive: true });
  fs.writeFileSync(path.join(runDir(p.root), 'supervisor.json'), JSON.stringify({ pid: null, finished: false, halted: false, range: null, lane: { phase: '5', path: 'build', pid: 4242, sessionId: null, launchedAt: at, mode: 'full', restarts: 0, notified: {} } }));
  const slice = (state, fields = {}) => ({ state, plan: '', summary: '', base: null, sessions: [], pid: null, worktree: null, branch: null, links: [], merge: null, tests: null, question: null, ownerQuestion: null, reason: null, retries: 0, rebuilds: 0, salvage: [], leftover: null, at: {}, ...fields });
  writeState(p.root, { step: 'build', order: ['05-01', '05-02', '05-03', '05-04'], slices: { '05-01': slice('merged', { tests: 'green' }), '05-02': slice('running'), '05-03': slice('waiting'), '05-04': slice('waiting') } });
  const r = run(p.root, ['status'], noSessionsClaude());
  const lines = r.out.split(/\r?\n/);
  assert.ok(lines.includes(`lane: phase 5 · build pid 4242 · restarts 0 · since ${at}`), r.out);
  assert.ok(lines.includes('  Slices: 1 of 4 merged · 1 building'), r.out);
});

test('build --resume --json prints the outcome', () => {
  const p = buildProject();
  const at = new Date().toISOString();
  writeState(p.root, { step: 'close', steps: Object.fromEntries(BUILD_STEPS.map((s) => [s, { state: 'done', at }])) });
  const r = run(p.root, ['build', '5', '--resume', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { phase: '5', outcome: 'closed', step: 'close', why: '', slices: { total: 0, merged: 0 } });
});
