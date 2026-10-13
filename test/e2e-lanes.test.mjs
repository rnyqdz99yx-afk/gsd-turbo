import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { A, P, annotated, freshLanes, lanesHarness } from './helpers/lanes.mjs';
import { resumableLanes, runDaemon, tick } from '../lib/supervisor.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { readJson } from '../lib/fsx.mjs';
import { laneSessionName } from '../lib/claude.mjs';

// L2's fake (reconcile R5): merged marks the phase complete in main and its merge state merged; the harness's
// mergeFollowUp releases the slot at the next tick, as L2 does after push and CI
const mergeOnce = (lane, h) => {
  h.phases.find((p) => p.number === lane.phase).complete = true;
  h.mergeStates[lane.phase] = { state: 'merged' };
  return { outcome: 'merged' };
};

test('e2e (spec §13): two independent phases run together, the third waits for its dependency; a failed lane stops alone', async () => {
  const h = lanesHarness({
    phases: [P('1'), P('2'), P('3', ['1'])],
    lanes: annotated({ 1: A('src/a/**'), 2: A('src/b/**'), 3: A('src/a/**') }),
    merge: mergeOnce,
  });
  let ticks = 0;
  // one step per tick, run inside GSD's phase list (the tick's first read); then the clock moves a minute
  const script = [
    () => {},
    () => { h.agentOf('2').state = 'failed'; },
    () => { writeLaneStatus(h.root, '1', 'ready', { at: h.at() }); h.agentOf('1').state = 'blocked'; },
    () => {}, // the follow-up releases phase 1's slot; phase 3 starts in it
    () => { writeLaneStatus(h.root, '3', 'ready', { at: h.at() }); h.agentOf('3').state = 'blocked'; },
  ];
  const load = h.ctx.deps.loadPhases;
  h.ctx.deps.loadPhases = () => {
    script[ticks]?.();
    ticks++;
    h.advance(1);
    return load();
  };
  const statePath = path.join(h.root, '.planning', 'turbo', 'run', 'supervisor.json');
  let sleeps = 0;
  // every fake resolves as a microtask: a daemon that never stops would hang the suite
  const sleep = async () => { if (++sleeps > 20) throw new Error(`runaway daemon after ${sleeps} iterations; last log ${h.logs.slice(-5).join(' | ')}`); };
  const final = await runDaemon({ ctx: h.ctx, statePath, initial: freshLanes(), intervalMs: 0, sleep });
  assert.deepEqual([final.halted, final.finished], [true, false]);
  assert.deepEqual(h.events, ['launch 1', 'launch 2', 'merge 1', 'launch 3', 'merge 3']);
  assert.deepEqual(h.launched.map((l) => l.cwd), [h.slots[0].path, h.slots[1].path, h.slots[0].path], 'phase 3 reuses the slot phase 1 freed');
  assert.deepEqual(h.notes.map((x) => [x.key, x.vars.phase]), [['laneStopped', '2'], ['phaseDone', '1'], ['phaseDone', '3']]);
  assert.deepEqual(Object.keys(final.lanes), ['2']);
  assert.equal(final.lanes['2'].halted.why, 'failed');
  assert.deepEqual(h.released, [[1, 'merged'], [1, 'merged']]);
  assert.equal(h.slots[1].job.state, 'active', 'the failed lane keeps its slot and its work');
  const saved = readJson(statePath);
  assert.equal(saved.lanesMode, 'slots');
  assert.equal(Object.hasOwn(saved, 'lane'), false);
});

test('e2e (spec §9, §13): a restart keeps the recorded lanes, adopts their sessions, and resumes an orphan slot job in its slot; nothing launches twice (Review Focus 1)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('4')], maxLanes: 2, lanes: annotated({ 1: A('a/**'), 2: A('b/**'), 4: A('c/**') }) });
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', '2']);
  // the supervisor dies right after preparing slot 3 for phase 4 and launching its session, before its state write
  h.ctx.config.max_lanes = 3;
  h.ctx.deps.slots.prepare(h.slots[2], { kind: 'phase', phase: '4' });
  h.agents.push({ id: 'orphan', name: laneSessionName(h.root, '4'), cwd: h.slots[2].path, state: 'working' });
  const lanes = resumableLanes(s, null, h.ctx);
  assert.deepEqual(Object.keys(lanes), ['1', '2', '4']);
  assert.deepEqual([lanes['4'].slot, lanes['4'].sessionId, lanes['4'].launch, lanes['4'].branch], [3, null, 'resume', 'turbo/p4']);
  h.advance(1);
  s = await tick({ ...s, lanes }, h.ctx);
  assert.equal(h.launched.length, 2, 'no new session: 1 and 2 keep theirs, 4 adopts the one in its slot');
  assert.equal(s.lanes['4'].sessionId, 'orphan');
  assert.ok(h.logs.includes('adopt phase 4 session orphan'), h.logs.join('\n'));
  assert.deepEqual(h.prepared.map((p) => p[2]), ['1', '2', '4'], 'no second slot for phase 4');
  // a lane outside the new range, and a lane whose slot no longer holds its job, are not resumed
  h.release(2, 'abandoned');
  assert.deepEqual(Object.keys(resumableLanes(s, { from: '4', to: null }, h.ctx)), ['4']);
  assert.ok(h.logs.some((l) => l === 'lane 1 is outside the range 4–end; not resumed (session s1 and slot 1 kept)'));
  assert.deepEqual(Object.keys(resumableLanes(s, null, h.ctx)), ['1', '4']);
  assert.ok(h.logs.includes('lane 2: no slot holds its job any more; not resumed'));
  // a lane that was stopped is tried again by a new start
  s.lanes['1'].halted = { why: 'failed', at: h.at() };
  s.lanes['1'].launchFailures = 4;
  const retried = resumableLanes(s, null, h.ctx)['1'];
  assert.deepEqual([retried.halted, retried.forceRelaunch, retried.restarts, retried.launchFailures], [undefined, true, 0, undefined]);
  // a checkout-mode lane is never resumed in slots mode; a finished run resumes nothing
  const other = lanesHarness({ phases: [P('7')] });
  assert.deepEqual(resumableLanes({ lane: { phase: '7', sessionId: 'x' }, finished: false }, null, other.ctx), {});
  assert.ok(other.logs.some((l) => l.startsWith('a checkout-mode lane of phase 7 is recorded; slots mode does not resume it')));
  assert.deepEqual(resumableLanes({ lanes: { 7: { key: '7', job: 'phase', phase: '7', slot: 1 } }, finished: true }, null, other.ctx), {});
});
