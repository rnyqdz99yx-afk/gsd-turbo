import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { lanesHarness, P as LP, freshLanes } from './helpers/lanes.mjs';
import { tick } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { readLaneStatus, writeLaneStatus } from '../lib/run-status.mjs';
import { writeAttend } from '../lib/attend.mjs';

// Stage 6 B4 (spec §6.1, §6.6): build lanes in the supervisor, with ctx.deps.build faked. Pids from 4243.
function fakeBuild({ pathFor = () => ({ build: true, why: '' }), running = () => null } = {}) {
  let pid = 4242;
  const b = {
    calls: [], live: new Set(), pathFor, running,
    launch: (o) => {
      b.calls.push(['launch', o]);
      pid += 1;
      b.live.add(pid);
      return { pid };
    },
    alive: (l) => b.live.has(l.pid),
    stop: (l) => {
      b.calls.push(['stop', l.pid]);
      b.live.delete(l.pid);
    },
  };
  return b;
}

// The checkout supervisor's harness (test/supervisor.test.mjs's), with claude resume and activity recorded.
function harness({ phases }) {
  const root = tmpDir('sup-build');
  fs.mkdirSync(path.join(root, '.planning'));
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let n = 0;
  const h = { root, phases, agents: [], launched: [], removed: [], stopped: [], resumed: [], activity: 0, notes: [], logs: [], fp: 'A', advance(min) { clock += min * 60000; }, at: () => new Date(clock).toISOString() };
  h.ctx = {
    root, config: structuredClone(DEFAULTS), turboRun: 'node x',
    deps: {
      loadPhases: () => h.phases,
      claude: {
        launchBg: (opts, cwd) => { const id = `s${++n}`; h.launched.push({ id, cwd, ...opts }); h.agents.push({ id, name: opts.name, cwd, state: 'working' }); return id; },
        list: () => h.agents,
        stop: (id) => { h.stopped.push(id); },
        rm: (id) => {
          h.removed.push(id);
          if (!h.agents.some((a) => a.id === id)) throw new Error(`claude rm failed: no session ${id}`);
          h.agents = h.agents.filter((a) => a.id !== id);
        },
        resume: (id) => { h.resumed.push(id); return 'note: woke'; },
      },
      lanes: { session: (id) => id, activity: () => { h.activity += 1; return { lastMs: 0, active: 0 }; }, replied: () => false },
      fingerprint: () => h.fp,
      notify: async (key, vars) => { h.notes.push({ key, vars }); },
      now: () => new Date(clock),
      log: (line) => { h.logs.push(line); },
    },
  };
  return h;
}
const P = (number, deps = [], complete = false) => ({ number, deps, complete, verification: null });
const fresh = () => ({ lane: null, finished: false, halted: false });

test('a build phase launches turbo-run build instead of a lane session (Stage 6 B4)', async () => {
  const h = harness({ phases: [P('4')] });
  const b = (h.ctx.deps.build = fakeBuild());
  const s = await tick(fresh(), h.ctx);
  assert.deepEqual(h.launched, [], h.logs.join(String.fromCharCode(10)));
  assert.deepEqual(b.calls, [['launch', { phase: '4', cwd: h.root, controlRoot: null, resume: false }]]);
  assert.ok(s.lane, JSON.stringify(s) + h.logs.join(String.fromCharCode(10)));
  assert.deepEqual([s.lane.path, s.lane.pid, s.lane.sessionId], ['build', 4243, null]);
  assert.ok(h.logs.includes('launch phase 4 build pid 4243'), h.logs.join('\n'));
  assert.equal(readLaneStatus(h.root, '4').status, 'running');
});

test('a live build lane is never stall-woken, removed or relaunched (Stage 6 B4)', async () => {
  const h = harness({ phases: [P('4')] });
  const b = (h.ctx.deps.build = fakeBuild());
  let s = await tick(fresh(), h.ctx);
  h.advance(60);
  s = await tick(s, h.ctx);
  h.advance(60);
  s = await tick(s, h.ctx);
  assert.deepEqual([h.stopped, h.removed, h.resumed, h.activity], [[], [], [], 0]);
  assert.equal(b.calls.length, 1);
  assert.equal(s.lane.pid, 4243);
});

test('a build that died is relaunched with --resume and counted (Stage 6 B4)', async () => {
  const h = harness({ phases: [P('4')] });
  const b = (h.ctx.deps.build = fakeBuild());
  let s = await tick(fresh(), h.ctx);
  b.live.delete(4243);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(b.calls.at(-1), ['launch', { phase: '4', cwd: h.root, controlRoot: null, resume: true }]);
  assert.equal(s.lane.restarts, 1);
  for (let i = 0; i < 6 && !s.halted; i++) {
    b.live.delete(s.lane.pid);
    h.advance(1);
    s = await tick(s, h.ctx);
  }
  assert.ok(h.logs.includes('phase 4 halted: no progress after 3 restarts'), h.logs.join('\n'));
  assert.ok(h.notes.some((x) => x.key === 'laneHalted'));
  assert.deepEqual(h.launched, [], h.logs.join(String.fromCharCode(10)));
});

test('a build that closed its phase ends the lane (Stage 6 B4)', async () => {
  const h = harness({ phases: [P('4')] });
  const b = (h.ctx.deps.build = fakeBuild());
  let s = await tick(fresh(), h.ctx);
  h.advance(5);
  writeLaneStatus(h.root, '4', 'done', { reason: 'build path: phase complete', at: h.at() });
  b.live.delete(4243);
  h.phases = [P('4', [], true)];
  s = await tick(s, h.ctx);
  assert.ok(h.logs.includes('phase 4 done'), h.logs.join('\n'));
  assert.ok(h.notes.some((x) => x.key === 'phaseDone'));
  assert.equal(h.removed.includes(null), false);
  assert.equal(s.lane, null);
});

test('a refused phase runs its lane session and says why once (Stage 6 B4)', async () => {
  const why = 'phase 4 has GSD plans without a summary (04-01): the lean path finishes them (build.adopt_plans: true lets the build path take them)';
  const h = harness({ phases: [P('4')] });
  h.ctx.deps.build = fakeBuild({ pathFor: () => ({ build: false, why }) });
  let s = await tick(fresh(), h.ctx);
  assert.equal(h.launched.length, 1);
  h.agents[0].state = 'failed';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.logs.filter((l) => l === `phase 4: build path refused (${why}); it runs /turbo-phase`).length, 1, h.logs.join('\n'));
  const off = harness({ phases: [P('4')] });
  off.ctx.deps.build = fakeBuild({ pathFor: () => ({ build: false, why: 'build.enabled is false' }) });
  await tick(fresh(), off.ctx);
  assert.equal(off.logs.some((l) => /build path refused/.test(l)), false);
  assert.equal(off.launched.length, 1);
  assert.ok(s.lane.sessionId);
});

test('the owner\'s resume stops a live build before its relaunch; a live build is adopted, never launched twice (Stage 6 B4)', async () => {
  const h = harness({ phases: [P('4')] });
  const b = (h.ctx.deps.build = fakeBuild());
  let s = await tick(fresh(), h.ctx);
  s.lane.forceRelaunch = true;
  s = await tick(s, h.ctx);
  assert.deepEqual(b.calls.slice(1), [['stop', 4243], ['launch', { phase: '4', cwd: h.root, controlRoot: null, resume: true }]]);
  const a = harness({ phases: [P('4')] });
  const ab = (a.ctx.deps.build = fakeBuild({ running: () => 777 }));
  const t = await tick(fresh(), a.ctx);
  assert.ok(a.logs.includes('adopt phase 4 build pid 777'), a.logs.join('\n'));
  assert.deepEqual(ab.calls, []);
  assert.equal(t.lane.pid, 777);
});

test('a slot build lane is launched in its slot and merged once its process ended with ready (Stage 6 B4)', async () => {
  const h = lanesHarness({ phases: [LP('1')], merge: () => ({ outcome: 'merged' }) });
  const b = (h.ctx.deps.build = fakeBuild());
  let s = await tick(freshLanes(), h.ctx);
  const lane = s.lanes['1'];
  assert.deepEqual(b.calls, [['launch', { phase: '1', cwd: lane.slotPath, controlRoot: h.root, resume: false }]]);
  h.advance(5);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  s = await tick(s, h.ctx);
  assert.deepEqual(h.merges, []);
  b.live.delete(lane.pid);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.merges, ['1']);
  assert.deepEqual(h.launched, [], h.logs.join(String.fromCharCode(10)));
});

test('reintegrate and ci-red relaunch build --resume (Stage 6 B4)', async () => {
  let once = false;
  const h = lanesHarness({ phases: [LP('1')], merge: () => (once ? { outcome: 'wait', reason: 'x' } : ((once = true), { outcome: 'reintegrate' })) });
  const b = (h.ctx.deps.build = fakeBuild());
  let s = await tick(freshLanes(), h.ctx);
  h.advance(5);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  b.live.delete(s.lanes['1'].pid);
  s = await tick(s, h.ctx);
  assert.deepEqual(b.calls.at(-1), ['launch', { phase: '1', cwd: s.lanes['1'].slotPath, controlRoot: h.root, resume: true }]);
  assert.deepEqual(h.resumed, []);
  assert.equal(s.lanes['1'].inboxWake, undefined);
});

test('an attended build lane is left to pause on its own (Stage 6 B4)', async () => {
  const h = lanesHarness({ phases: [LP('1')] });
  const b = (h.ctx.deps.build = fakeBuild());
  let s = await tick(freshLanes(), h.ctx);
  writeAttend(h.root, '1');
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.deepEqual(b.calls.filter((c) => c[0] === 'stop'), []);
  assert.equal(h.logs.filter((l) => /^phase 1 is attended/.test(l)).length, 1, h.logs.join('\n'));
  assert.equal(s.lanes['1'].pid, 4243);
});
