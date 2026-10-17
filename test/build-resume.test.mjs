import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildRig, claudeHome, claudeShim, phaseScript } from './helpers/build-fake.mjs';
import { ISOLATED } from './helpers/slots.mjs';
import { runBuild } from '../lib/build.mjs';
import { loadBuildState } from '../lib/build-queue.mjs';
import { readQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { runDir } from '../lib/paths.mjs';
import { killTree } from '../lib/headless.mjs';
import { pidAlive } from '../lib/merge-lock.mjs';

const H = claudeHome();
after(() => H.restore());
const BIN = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));

const crashAt = (name) => (n) => {
  if (n === name) throw new Error('crash');
};
const count = (acts, role, plan) => acts.filter((a) => a.role === role && (!plan || a.plan === plan)).length;
const merges = (r) => Number(r.git('rev-list', '--merges', '--count', 'HEAD'));
function answerAsk(t, root) {
  const timer = setInterval(() => {
    try {
      const q = readQuestions(root, '5').find((x) => x.id === 'ask-1' && x.state === 'open');
      if (!q) return;
      answerQuestion({ root, phase: '5', id: 'ask-1', option: 1, by: 'pane', laneRunning: true });
      clearInterval(timer);
    } catch { /* again */ }
  }, 20);
  t.after(() => clearInterval(timer));
}

// The first run crashes at the named checkpoint; the second goes on with --resume and closes the phase.
async function crashAndResume(t, name, script, { answer = false } = {}) {
  const r = await buildRig({ script });
  await assert.rejects(runBuild({ root: r.root, phase: '5', deps: { ...r.deps, checkpoint: crashAt(name) } }), /crash/);
  if (answer) answerAsk(t, r.root);
  const out = await runBuild({ root: r.root, phase: '5', resume: true, deps: r.deps });
  assert.equal(out.outcome, 'closed', `${out.why}\n${r.lines.join('\n')}`);
  return r;
}

test('a crash after slicing does not slice again', { timeout: 300000 }, async (t) => {
  const r = await crashAndResume(t, 'step:slice', await phaseScript({ ask: false, red: false }));
  assert.equal(count(r.a.acts(), 'slicer'), 1);
  assert.equal(merges(r), 4);
});

test('a crash after one merge keeps it; the slice that was running is salvaged and built again', { timeout: 300000 }, async (t) => {
  const r = await buildRig({ script: await phaseScript({ ask: false, red: false, slices: { '05-02': { delayMs: 4000 } } }) });
  await assert.rejects(runBuild({ root: r.root, phase: '5', deps: { ...r.deps, checkpoint: crashAt('merged:05-01') } }), /crash/);
  const before = loadBuildState(runDir(r.root), '5');
  const pid = before.slices['05-02'].pid;
  assert.ok(pid && pidAlive(pid), '05-02 is still building');
  const out = await runBuild({ root: r.root, phase: '5', resume: true, deps: r.deps });
  assert.equal(out.outcome, 'closed', `${out.why}\n${r.lines.join('\n')}`);
  assert.equal(pidAlive(pid), false);
  const acts = r.a.acts();
  assert.deepEqual([count(acts, 'builder', '05-01'), count(acts, 'builder', '05-02')], [1, 2]);
  assert.equal(merges(r), 4);
  const after = loadBuildState(runDir(r.root), '5');
  for (const step of ['begin', 'slice', 'build', 'review', 'verify', 'close']) assert.ok(['done', 'skipped'].includes(after.steps[step]?.state), step);
  assert.ok(r.lines.some((l) => /reconcile: 05-02 (requeued|salvaged)/.test(l)), r.lines.join('\n'));
});

test('a crash after the review is written does not review round 1 again', { timeout: 300000 }, async (t) => {
  const r = await crashAndResume(t, 'review:reviewed', await phaseScript({ ask: false, red: false }));
  const acts = r.a.acts();
  assert.deepEqual([count(acts, 'gsd-code-reviewer'), count(acts, 'fixer')], [2, 1]);
});

test('a crash while a card waits asks nothing again and resumes the same session', { timeout: 300000 }, async (t) => {
  // 05-02 asks after the others have started (their sessions are known when the run dies)
  const r = await crashAndResume(t, 'owner:ask-1', await phaseScript({ red: false, slices: { '05-02': { delayMs: 1500 } } }), { answer: true });
  assert.deepEqual(readQuestions(r.root, '5').map((q) => q.id), ['ask-1']);
  const first = loadBuildState(runDir(r.root), '5').slices['05-02'].sessions[0].id;
  const resumed = r.a.acts().filter((a) => a.role === 'builder' && a.plan === '05-02' && a.resume);
  assert.deepEqual(resumed.map((a) => a.resume), [first]);
});

test('a killed build process goes on with --resume', { timeout: 300000 }, async (t) => {
  const r = await buildRig({ script: await phaseScript({ ask: false, red: false, slices: { '05-02': { delayMs: 2500 }, '05-03': { delayMs: 500 }, '05-04': { delayMs: 2500 } } }) });
  const bin = claudeShim(path.dirname(r.a.act));
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const env = { ...ISOLATED, CLAUDE_CONFIG_DIR: H.home, TURBO_LANE: '', TURBO_BUILD_LANE: '', [key]: `${bin}${path.delimiter}${process.env[key]}` };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [BIN, 'build', '5', '--project', r.root], { cwd: r.root, env, stdio: 'ignore', windowsHide: true });
  t.after(() => killTree(child.pid));
  let merged = false;
  for (let i = 0; i < 1200 && !merged; i++) {
    await sleep(100);
    try {
      merged = loadBuildState(runDir(r.root), '5')?.slices?.['05-01']?.state === 'merged';
    } catch { /* written at this moment */ }
  }
  assert.ok(merged, '05-01 merged in the first run');
  killTree(child.pid);
  for (let i = 0; i < 50 && pidAlive(child.pid); i++) await sleep(100);
  const res = spawnSync(process.execPath, [BIN, 'build', '5', '--resume', '--project', r.root], { cwd: r.root, env, encoding: 'utf8', windowsHide: true, timeout: 240000 });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /^phase 5: build closed$/m);
  assert.equal(count(r.a.acts(), 'builder', '05-01'), 1);
  assert.equal(merges(r), 4);
  assert.ok(fs.existsSync(path.join(r.root, '.planning', 'ROADMAP.md')));
});
