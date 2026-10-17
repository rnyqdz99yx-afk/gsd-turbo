import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRig, claudeHome, phaseScript, summaryText } from './helpers/build-fake.mjs';
import { runBuild } from '../lib/build.mjs';
import { loadBuildState } from '../lib/build-queue.mjs';
import { readQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { gsdCoreDir, runDir } from '../lib/paths.mjs';
import { readVersion, versionInRange } from '../lib/gsd.mjs';

// the installed GSD, looked up before CLAUDE_CONFIG_DIR is redirected
const REAL = gsdCoreDir(null);
const REAL_OK = Boolean(REAL) && versionInRange(readVersion(REAL) || '');
const H = claudeHome();
after(() => H.restore());
const REL = '.planning/phases/05-demo';

// Answers ask-1 with option 1 as soon as it is open.
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
const count = (acts, role, plan) => acts.filter((a) => a.role === role && (!plan || a.plan === plan)).length;

test('the build path runs a phase end to end (fake claude, fake GSD)', { timeout: 300000 }, async (t) => {
  const r = await buildRig({ script: await phaseScript() });
  answerAsk(t, r.root);
  const out = await runBuild({ root: r.root, phase: '5', deps: r.deps });
  assert.deepEqual(out, { outcome: 'closed', step: 'close', why: '', slices: { total: 4, merged: 4 } }, r.lines.join('\n'));
  const acts = r.a.acts();
  assert.deepEqual(['slicer', 'builder', 'fixer', 'gsd-code-reviewer', 'gsd-verifier', 'discuss', 'gsd-phase-researcher'].map((x) => count(acts, x)), [1, 5, 2, 2, 1, 0, 0]);
  const s = loadBuildState(runDir(r.root), '5').slices;
  for (const id of ['05-01', '05-04']) assert.ok(Date.parse(s[id].at.dispatched) < Date.parse(s['05-02'].at.merged), `${id} ran while 05-02 waited`);
  assert.equal(Number(r.git('rev-list', '--merges', '--count', 'HEAD')), 4);
  assert.match(fs.readFileSync(path.join(r.root, '.planning', 'ROADMAP.md'), 'utf8'), /^- \[x\] \*\*Phase 5/m);
  assert.equal(readLaneStatus(r.root, '5').status, 'done');
  const cost = JSON.parse(fs.readFileSync(path.join(runDir(r.root), 'cost-p5.json'), 'utf8')).sessions;
  for (const step of ['slice', 'build', 'review', 'verify']) assert.ok(cost.some((c) => c.step === step), step);
  for (const role of ['slicer', 'builder', 'fixer', 'reviewer', 'verifier']) assert.ok(cost.some((c) => c.role === role), role);
  assert.deepEqual(readQuestions(r.root, '5').map((q) => [q.id, q.state]), [['ask-1', 'delivered']]);
});

test('the same phase with the installed GSD', { skip: !REAL_OK && 'GSD 1.16/1.17 is not installed', timeout: 300000 }, async (t) => {
  const script = await phaseScript({ ask: false, red: false });
  script.summaries = Object.fromEntries([['05-01', 'DEMO-01'], ['05-02', 'DEMO-02'], ['05-03', 'DEMO-01'], ['05-04', 'DEMO-01']].map(([id, req]) => [id, summaryText({ phaseSlug: '05-demo', plan: id, reqs: [req] })]));
  script.verifications[0].text = '---\nphase: 05-demo\nverified: 2026-10-17T00:00:00Z\nstatus: passed\nscore: 2/2 must-haves verified\n---\n\n# Phase 5: Verification\n';
  const r = await buildRig({ script, deps: { core: REAL } });
  fs.rmSync(path.join(r.root, '.claude', 'gsd-core'), { recursive: true, force: true });
  const out = await runBuild({ root: r.root, phase: '5', deps: r.deps });
  assert.equal(out.outcome, 'closed', `${out.why}\n${r.lines.join('\n')}`);
  const tool = (...args) => {
    const x = spawnSync(process.execPath, [path.join(REAL, 'bin', 'gsd-tools.cjs'), ...args, '--cwd', r.root], { encoding: 'utf8', windowsHide: true });
    return JSON.parse(x.stdout.slice(x.stdout.search(/[{[]/)));
  };
  const manager = tool('init', 'manager').phases.find((p) => String(p.number) === '5');
  assert.deepEqual([manager.disk_status, manager.roadmap_complete], ['complete', true], JSON.stringify(manager));
  assert.equal(tool('verification', 'status', REL).status, 'passed');
  assert.equal(tool('progress').phases[0].status, 'Complete');
});
