import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { completeStep } from '../lib/phase-progress.mjs';
import { tmpDir } from './helpers/tmp.mjs';
import { buildProject } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { writeAttend } from '../lib/attend.mjs';
import { loadConfig } from '../lib/config.mjs';
import { runDir } from '../lib/paths.mjs';
import { pidAlive } from '../lib/merge-lock.mjs';
import { buildPathFor, buildLaneDeps, buildLogFile, claimRunner, launchBuild, runnerAlive, runnerFile, runnerOf, runningBuilds, stopBuild, waitBuildPaused } from '../lib/build-lane.mjs';

const DEAD = 2147483644;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('buildPathFor: the refusals of spec §6.8, each with its reason', () => {
  const off = buildProject({ config: { build: { enabled: false } } });
  assert.deepEqual(buildPathFor(off.root, '5'), { build: false, why: 'build.enabled is false' });
  fs.mkdirSync(runDir(off.root), { recursive: true });
  fs.writeFileSync(path.join(runDir(off.root), 'build-p5.json'), '{}');
  assert.deepEqual(buildPathFor(off.root, '5'), { build: true, why: 'started on the build path' });

  const p = buildProject();
  assert.deepEqual(buildPathFor(p.root, '5'), { build: true, why: '' });
  assert.deepEqual(buildPathFor(p.root, '5', { core: null }), { build: false, why: 'gsd-core not found' });
  writeAttend(p.root, '5');
  assert.deepEqual(buildPathFor(p.root, '5'), { build: false, why: 'phase 5 is attended' });

  const sub = buildProject();
  sub.write('.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = ./x\n');
  sub.commit('chore: submodules');
  assert.deepEqual(buildPathFor(sub.root, '5'), { build: false, why: 'the project has git submodules: the build path does not build inside them' });

  const docs = buildProject();
  docs.write('.planning/config.json', '{ "planning": { "commit_docs": false } }\n');
  assert.deepEqual(buildPathFor(docs.root, '5'), { build: false, why: 'GSD commit_docs is false: the build path commits plans and summaries' });

  const planned = buildProject();
  planned.write(`${planned.rel}/05-01-PLAN.md`, compactPlan({ id: '05-01' }));
  planned.commit('docs: plan');
  assert.deepEqual(buildPathFor(planned.root, '5'), { build: false, why: 'phase 5 has GSD plans without a summary (05-01): the lean path finishes them (build.adopt_plans: true lets the build path take them)' });
  const adopt = { ...loadConfig(planned.root), build: { enabled: true, adopt_plans: true } };
  assert.deepEqual(buildPathFor(planned.root, '5', { config: adopt }), { build: true, why: '' });
  planned.write(`${planned.rel}/05-01-PLAN.md`, compactPlan({ id: '05-01', deps: ['05-02'] }));
  planned.write(`${planned.rel}/05-02-PLAN.md`, compactPlan({ id: '05-02', deps: ['05-01'], files: ['src/b.js'] }));
  const cycle = buildPathFor(planned.root, '5', { config: adopt });
  assert.equal(cycle.build, false);
  assert.match(cycle.why, /^depends_on cycle/);
});

test('buildPathFor: a phase /turbo-phase began finishes there', () => {
  const p = buildProject();
  completeStep(p.root, '5', 'freshness');
  assert.deepEqual(buildPathFor(p.root, '5'), { build: false, why: 'phase 5 started on the lean path (/turbo-phase): it finishes there' });
});

test('the supervisor\'s stop ends only the build\'s own process', async (t) => {
  const p = buildProject();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const deps = buildLaneDeps(p.root, loadConfig(p.root));
  // a lane that ended long ago, its pid now someone else's: left alone
  deps.stop({ phase: '5', pid: child.pid, launchedAt: ago(60 * 60000) });
  await sleep(300);
  assert.equal(pidAlive(child.pid), true);
  // the build's own (just launched): ended
  deps.stop({ phase: '5', pid: child.pid, launchedAt: ago(0) });
  for (let i = 0; i < 50 && pidAlive(child.pid); i++) await sleep(100);
  assert.equal(pidAlive(child.pid), false);
});

test('claimRunner: one holder per phase; a dead or silent holder is replaced', async () => {
  const p = buildProject();
  const file = runnerFile(p.root, '5');
  const first = claimRunner(p.root, '5', { beatMs: 50 });
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.pid, process.pid);
  assert.equal(typeof rec.token, 'string');
  assert.ok(rec.startedAt && rec.beat);
  const busy = claimRunner(p.root, '5');
  assert.equal(busy.busy.pid, process.pid);
  await sleep(200);
  assert.ok(Date.parse(runnerOf(p.root, '5').beat) > Date.parse(rec.beat), 'the heartbeat rewrites beat');
  first.release();
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, JSON.stringify({ pid: DEAD, token: 'x', startedAt: ago(0), beat: ago(0) }));
  const overDead = claimRunner(p.root, '5', { beatMs: 50 });
  assert.equal(overDead.record.pid, process.pid);

  // a silent holder (6 min without a beat) is replaced even while its pid lives; its release leaves the new record
  fs.writeFileSync(file, JSON.stringify({ ...runnerOf(p.root, '5'), beat: ago(6 * 60000) }));
  const second = claimRunner(p.root, '5', { alive: () => true, beatMs: 50 });
  assert.ok(second.record);
  overDead.release();
  assert.equal(runnerOf(p.root, '5').token, second.record.token);
  second.release();
  assert.equal(fs.existsSync(file), false);
});

test('runnerAlive and the supervisor\'s alive', () => {
  const p = buildProject();
  assert.equal(runnerAlive({ pid: process.pid, beat: ago(0) }), true);
  assert.equal(runnerAlive({ pid: DEAD, beat: ago(0) }), false);
  assert.equal(runnerAlive({ pid: process.pid, beat: ago(6 * 60000) }), false);
  const deps = buildLaneDeps(p.root, loadConfig(p.root));
  assert.equal(deps.alive({ phase: '5', pid: process.pid, launchedAt: ago(0) }), true, 'just launched');
  assert.equal(deps.alive({ phase: '5', pid: process.pid, launchedAt: ago(6 * 60000) }), false);
  const held = claimRunner(p.root, '5');
  try {
    assert.equal(deps.alive({ phase: '5', pid: DEAD, launchedAt: ago(6 * 60000) }), true, 'another pid\'s record counts by its own beat');
    assert.equal(deps.running('5'), process.pid);
    assert.deepEqual(runningBuilds(p.root), [{ phase: '5', pid: process.pid }]);
    fs.writeFileSync(runnerFile(p.root, '5'), JSON.stringify({ ...runnerOf(p.root, '5'), beat: ago(6 * 60000) }));
    assert.equal(deps.alive({ phase: '5', pid: process.pid, launchedAt: ago(0) }), false, 'its own record went silent');
    assert.equal(deps.running('5'), null);
  } finally {
    held.release();
  }
});

test('launchBuild starts a detached turbo-run build; stopBuild ends its tree', async (t) => {
  const p = buildProject();
  const dir = tmpDir('launch');
  const script = path.join(dir, 'build.mjs');
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), lane: process.env.TURBO_BUILD_LANE ?? null, control: process.env.TURBO_CONTROL_ROOT ?? null, pids: [process.pid, g.pid] }));`,
    "console.log('hello');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const pids = [];
  t.after(() => {
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  });
  const started = async (o) => {
    fs.rmSync(out, { force: true });
    const { pid } = launchBuild({ root: p.root, phase: '5', script, ...o });
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await sleep(50);
    const r = JSON.parse(fs.readFileSync(out, 'utf8'));
    pids.push(...r.pids);
    assert.equal(r.pids[0], pid);
    return r;
  };
  const a = await started({});
  assert.deepEqual(a.argv, ['build', '5', '--project', p.root]);
  assert.deepEqual([a.lane, a.control], ['1', null]);
  stopBuild({ pid: a.pids[0] });
  for (let i = 0; i < 50 && pidAlive(a.pids[1]); i++) await sleep(100);
  assert.deepEqual(a.pids.map(pidAlive), [false, false]);
  for (let i = 0; i < 50 && !fs.readFileSync(buildLogFile(p.root, '5'), 'utf8').includes('hello'); i++) await sleep(50);
  assert.match(fs.readFileSync(buildLogFile(p.root, '5'), 'utf8'), /hello/);

  const b = await started({ resume: true, controlRoot: dir });
  assert.deepEqual(b.argv, ['build', '5', '--project', p.root, '--resume']);
  assert.equal(b.control, dir);
  stopBuild({ pid: b.pids[0] });
  fs.mkdirSync(runDir(p.root), { recursive: true });
  fs.writeFileSync(path.join(runDir(p.root), 'build-p5.json'), '{}');
  const c = await started({});
  assert.deepEqual(c.argv, ['build', '5', '--project', p.root, '--resume']);
  stopBuild({ pid: c.pids[0] });
  assert.throws(() => stopBuild({ pid: DEAD }, { kill: () => {}, alive: () => true, waitMs: 200 }), /did not stop/);
});

test('waitBuildPaused waits for the runner to go', async () => {
  const p = buildProject();
  const lines = [];
  assert.deepEqual(await waitBuildPaused(p.root, '5', { timeoutMs: 1000, pollMs: 20, out: (l) => lines.push(l) }), { paused: true });
  assert.deepEqual(lines, []);
  const held = claimRunner(p.root, '5');
  setTimeout(() => held.release(), 200);
  assert.deepEqual(await waitBuildPaused(p.root, '5', { timeoutMs: 5000, pollMs: 20, out: (l) => lines.push(l) }), { paused: true });
  assert.deepEqual(lines, ['phase 5: the build pauses: it finishes its running sessions first']);
  const again = claimRunner(p.root, '5');
  try {
    assert.deepEqual(await waitBuildPaused(p.root, '5', { timeoutMs: 100, pollMs: 20 }), { paused: false });
  } finally {
    again.release();
  }
});
