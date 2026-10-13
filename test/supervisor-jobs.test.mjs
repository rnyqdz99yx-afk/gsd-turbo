import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, P, annotated, freshLanes, lanesHarness } from './helpers/lanes.mjs';
import { resumableLanes, tick } from '../lib/supervisor.mjs';
import { readJobStatus, writeJobStatus, writeLaneStatus } from '../lib/run-status.mjs';
import { acquireGate, heldGates } from '../lib/gate-locks.mjs';
import { inboxWakePrompt } from '../lib/wake.mjs';

// L2's fake: each call takes the next outcome; merged marks the phase complete in main and records the merge state,
// as L2 does; the slot stays held until mergeFollowUp releases it (reconcile R5). An empty list is L2's wait for a
// ready record it already decided.
function mergeFrom(outcomes) {
  return (lane, h) => {
    const r = outcomes.shift() ?? { outcome: 'wait', reason: 'already decided' };
    if (r.outcome === 'merged') {
      h.phases.find((p) => p.number === lane.phase).complete = true;
      h.mergeStates[lane.phase] = { state: 'merged' };
    }
    return r;
  };
}

test('a ready lane goes to L2\'s merge only once its turn ended; wait, reintegrate, needs-owner, merged, then the follow-up: ci-red, needs-owner, wait, released (spec §7.2; reconcile R5)', async () => {
  const follow = [{ outcome: 'ci-red', sha: 'b'.repeat(40) }, { outcome: 'needs-owner', reason: 'CI timed out' }, { outcome: 'needs-owner', reason: 'CI timed out' }, { outcome: 'wait' }, { outcome: 'released' }];
  const h = lanesHarness({
    phases: [P('1')],
    followUp: () => follow.shift(),
    merge: mergeFrom([
      { outcome: 'wait', reason: 'main is dirty' },
      { outcome: 'wait', reason: 'main is dirty' },
      { outcome: 'reintegrate', reason: 'main moved' },
      { outcome: 'needs-owner', reason: 'phase 1 cannot catch up with main' },
      { outcome: 'needs-owner', reason: 'phase 1 cannot catch up with main' },
      { outcome: 'merged' },
    ]),
  });
  let s = await tick(freshLanes(), h.ctx);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  s = await tick(s, h.ctx);
  assert.deepEqual(h.merges, [], 'the session still works: its last words may be on their way');
  h.agentOf('1').state = 'blocked';
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.merges, ['1', '1']);
  assert.equal(h.logs.filter((l) => l === 'phase 1: merge waits: main is dirty').length, 1);
  h.advance(1);
  s = await tick(s, h.ctx);
  // reconcile R5: reintegrate carries no prompt; L1 wakes the lane with its inbox wake prompt
  assert.deepEqual(h.resumed.map((r) => [r.id, r.prompt, r.cwd]), [['s1', inboxWakePrompt({ phase: '1', turboRun: 'node x', kind: 'reintegrate' }), h.slots[0].path]]);
  assert.equal(s.lanes['1'].launchedAt, h.at(), 'its ready record is older than the wake now');
  h.advance(1);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes.filter((x) => x.key === 'laneNeedsOwner').map((x) => x.vars), [{ phase: '1', reason: 'phase 1 cannot catch up with main' }]);
  s = await tick(s, h.ctx);
  // merged: main has it, but the slot is held and the lane entry stays until the follow-up releases it
  assert.ok(s.lanes['1']);
  assert.equal(h.slots[0].job.state, 'active');
  assert.deepEqual(h.notes.map((x) => x.key), ['laneNeedsOwner']);
  assert.equal(s.finished, false);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.resumed.at(-1).prompt, inboxWakePrompt({ phase: '1', turboRun: 'node x', kind: 'ci-red' }), 'ci-red wakes the lane to read its inbox');
  h.agentOf('1').state = 'working';
  h.advance(1);
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes.filter((x) => x.key === 'laneNeedsOwner').map((x) => x.vars.reason), ['phase 1 cannot catch up with main', 'CI timed out'], 'a follow-up needs-owner is told once');
  s = await tick(s, h.ctx);
  assert.ok(s.lanes['1'], 'wait: nothing happens');
  s = await tick(s, h.ctx);
  assert.deepEqual(s.lanes, {});
  assert.deepEqual(h.removed, ['s1']);
  assert.deepEqual(h.released, [[1, 'merged']]);
  assert.deepEqual(h.notes.map((x) => x.key), ['laneNeedsOwner', 'laneNeedsOwner', 'phaseDone', 'milestoneDone']);
  assert.equal(s.finished, true);
});

test('without L2\'s merge a ready lane waits, logged once (D14)', async () => {
  const h = lanesHarness({ phases: [P('1')] });
  let s = await tick(freshLanes(), h.ctx);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  h.agentOf('1').state = 'blocked';
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.equal(h.logs.filter((l) => l.startsWith('phase 1 is ready, but this turbo has no merge')).length, 1);
  assert.ok(s.lanes['1']);
  assert.equal(s.finished, false);
});

test('prep and annotate jobs take the slots the phases leave, at most max_prep; finished, failed and refused jobs (spec §6.1, D6, D9)', async () => {
  const outcomes = { annotate: [{ outcome: 'merged' }], 'prep-3': [{ outcome: 'wait', reason: 'main is busy' }, { outcome: 'wait', reason: 'main is busy' }, { outcome: 'failed', reason: 'it touched src/x.ts' }] };
  const h = lanesHarness({
    phases: [P('1'), P('2'), P('3')],
    jobs: (options, hh) => {
      hh.jobOptions = options;
      return hh.jobList;
    },
    finish: (lane, hh) => {
      const r = outcomes[lane.key].shift();
      if (r.outcome === 'merged' || r.outcome === 'failed') hh.release(lane.slot, r.outcome);
      return r;
    },
  });
  h.jobList = [{ kind: 'annotate', phase: null }, { kind: 'prep', phase: '1' }, { kind: 'prep', phase: '2' }, { kind: 'prep', phase: '3' }];
  h.ctx.config.max_prep = 1;
  let s = await tick(freshLanes(), h.ctx);
  // no annotation: one phase lane; one job (max_prep 1) in the slots left
  assert.deepEqual(Object.keys(s.lanes), ['1', 'annotate']);
  assert.deepEqual([s.lanes.annotate.slot, s.lanes.annotate.branch, s.lanes.annotate.phase], [2, 'turbo/annotate', null]);
  assert.deepEqual(h.launched.map((l) => [l.prompt, l.systemPrompt.startsWith('job ') ? l.systemPrompt : 'phase']), [['Run the turbo-phase skill with arguments: 1', 'phase'], ['Run annotate', 'job annotate']]);
  // annotate is merged by L3; the next job starts in its slot
  writeLaneStatus(h.root, 'annotate', 'annotated', { at: h.at() });
  h.agentOf('annotate').state = 'blocked';
  h.jobList = h.jobList.slice(1);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', 'prep-2'], 'prep of a phase that has a lane (prep-1) is never started');
  assert.ok(h.logs.includes('lane annotate merged'));
  // the prep session fails: its slot is released as failed and the job is not proposed again this run
  h.agentOf('prep-2').state = 'failed';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', 'prep-3']);
  assert.equal(s.jobsFailed['prep-2'].why, 'failed');
  // reconcile R7: pendingJobs gets { root, config, lanes, range, mode, failed }
  assert.deepEqual([h.jobOptions.root, h.jobOptions.mode, h.jobOptions.range, h.jobOptions.failed, Object.keys(h.jobOptions.lanes)], [h.root, 'full', null, ['prep-2'], ['1', 'prep-3']]);
  assert.deepEqual(h.released, [[2, 'merged'], [2, 'failed']]);
  // L3 refuses the merge of prep-3 (it touched code): failed with L3's reason; a wait is logged once
  writeLaneStatus(h.root, '3', 'prepped', { at: h.at() });
  h.agentOf('prep-3').state = 'blocked';
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.equal(h.logs.filter((l) => l === 'lane prep-3 waits: main is busy').length, 1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  assert.equal(s.jobsFailed['prep-3'].why, 'it touched src/x.ts');
  assert.deepEqual(h.notes, [], 'jobs never notify the owner on their own end');
});

test('phases come first: while a ready phase waits for a slot no job starts (D9)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], slots: 1, lanes: annotated({ 1: A('a/**'), 2: A('b/**') }), jobs: () => [{ kind: 'prep', phase: '3' }] });
  const s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  assert.deepEqual(s.next, { phase: '2', why: 'slots', waitsFor: [] });
  assert.equal(h.launched.length, 1);
});

test('a lane\'s gate locks are released when it ends; the phase that waited for its declared gate starts then (spec §5)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], lanes: annotated({ 1: A('a/**', ['prod-deploy']), 2: A('b/**', ['prod-deploy']) }), merge: mergeFrom([{ outcome: 'merged' }]) });
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  await acquireGate(h.root, 'owner-live', '1'); // lane 1 took a lock on one of its steps and never unlocked it
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  h.agentOf('1').state = 'blocked';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1'], 'merged: the lane holds its gates until the follow-up releases it (reconcile R5)');
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(heldGates(h.root), []);
  assert.ok(h.logs.includes('phase 1: released owner-live'), h.logs.join('\n'));
  assert.deepEqual(Object.keys(s.lanes), ['2']);
});

test('while a merge hold exists no new phase lane starts; jobs may (reconcile R5)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], lanes: annotated({ 1: A('a/**'), 2: A('b/**') }), merge: mergeFrom([]), jobs: () => [{ kind: 'prep', phase: '3' }] });
  h.holds = ['7'];
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['prep-3']);
  assert.deepEqual(s.next, { phase: '1', why: 'merge', waitsFor: ['7'] });
  s = await tick(s, h.ctx);
  assert.equal(h.logs.filter((l) => l.startsWith('merge hold')).length, 1);
  h.holds = [];
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', '2', 'prep-3']);
});

test('start --plan-only: no phase lane, only prep and annotate jobs; the run ends with milestonePrepared once nothing is due and no job runs (reconcile R10)', async () => {
  const h = lanesHarness({
    phases: [P('1'), P('2')],
    lanes: annotated({ 1: A('a/**'), 2: A('b/**') }),
    jobs: (options, hh) => hh.jobList,
    finish: (lane, hh) => { hh.release(lane.slot, 'merged'); return { outcome: 'merged' }; },
  });
  h.jobList = [{ kind: 'prep', phase: '1' }, { kind: 'prep', phase: '2' }];
  let s = await tick({ ...freshLanes(), planOnly: true }, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['prep-1', 'prep-2'], 'phases 1 and 2 are ready, yet no phase lane starts');
  assert.equal(s.next, null);
  // both preps end and are merged; pendingJobs has nothing more
  for (const n of ['1', '2']) {
    writeLaneStatus(h.root, n, 'prepped', { at: h.at() });
    h.agentOf(`prep-${n}`).state = 'blocked';
  }
  h.jobList = [];
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(s.lanes, {});
  assert.deepEqual([s.finished, s.halted, s.planOnly], [true, false, true]);
  assert.deepEqual(h.notes.map((x) => x.key), ['milestonePrepared']);
  assert.ok(h.logs.includes('milestone prepared: no prep or annotate job is due and none runs'), h.logs.join('\n'));
  // without the job module there is nothing to prepare: it ends at once
  const bare = lanesHarness({ phases: [P('1')] });
  const b = await tick({ ...freshLanes(), planOnly: true }, bare.ctx);
  assert.deepEqual([Object.keys(b.lanes), b.finished, bare.notes.map((x) => x.key)], [[], true, ['milestonePrepared']]);
});

// ---- final review fixes ----

test('review I1: a reintegrate wake whose relaunch fails to launch is retried at the next tick, never dropped', async () => {
  const h = lanesHarness({ phases: [P('1')], merge: mergeFrom([{ outcome: 'reintegrate', reason: 'main moved' }]) });
  let s = await tick(freshLanes(), h.ctx);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  h.agentOf('1').state = 'blocked';
  h.ctx.deps.claude.resume = () => { throw new Error('claude --bg --resume failed'); };
  let fail = true;
  h.launchFail = () => (fail ? 'claude --bg failed: boom' : null);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([s.lanes['1'].inboxWake, s.lanes['1'].launchFailures], ['reintegrate', 1]);
  fail = false;
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(s.lanes['1'].sessionId, 's2', 'a new resumed session reads the inbox');
  assert.equal(s.lanes['1'].inboxWake, undefined);
  assert.deepEqual(h.merges, ['1'], 'L2 is not asked again for the wake it already decided');
});

test('review I2: a lane whose slot L2 released while the supervisor was away is finished at the next start', async () => {
  const h = lanesHarness({ phases: [P('1')], merge: mergeFrom([]) });
  await acquireGate(h.root, 'owner-live', '1');
  const prev = { ...freshLanes(), lanes: { 1: { key: '1', job: 'phase', phase: '1', slot: 1, slotPath: h.slots[0].path, branch: 'turbo/p1', sessionId: 'gone', launchedAt: h.at(), restarts: 0, notified: {}, mode: 'full' } } };
  h.mergeStates['1'] = { state: 'released' };
  const lanes = resumableLanes(prev, null, h.ctx);
  assert.deepEqual(Object.keys(lanes), ['1']);
  h.phases[0].complete = true;
  const s = await tick({ ...prev, lanes }, h.ctx);
  assert.deepEqual(s.lanes, {});
  assert.deepEqual(h.notes.map((x) => x.key), ['phaseDone', 'milestoneDone']);
  assert.deepEqual(heldGates(h.root), []);
});

test('review I3: resume of a phase that is merged and waits for push or CI relaunches nothing', async () => {
  const h = lanesHarness({ phases: [P('1')], merge: mergeFrom([{ outcome: 'merged' }]), followUp: () => ({ outcome: 'wait' }) });
  let s = await tick(freshLanes(), h.ctx);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  h.agentOf('1').state = 'blocked';
  s = await tick(s, h.ctx);
  assert.equal(h.mergeStates['1'].state, 'merged');
  s.lanes['1'].forceRelaunch = true; // the owner's turbo-run resume 1
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.equal(s.lanes['1'].forceRelaunch, undefined);
  assert.deepEqual(h.followUps, ['1']);
});

test('review I6: start --plan-only never steps a phase lane recorded by an earlier run; the run ends on jobs alone', async () => {
  const h = lanesHarness({ phases: [P('1')], jobs: () => [] });
  const prev = { ...freshLanes(), planOnly: true, lanes: { 1: { key: '1', job: 'phase', phase: '1', slot: 1, slotPath: h.slots[0].path, branch: 'turbo/p1', sessionId: 'old111', launchedAt: h.at(), restarts: 0, notified: {}, mode: 'full', forceRelaunch: true } } };
  const s = await tick(prev, h.ctx);
  assert.equal(h.launched.length, 0);
  assert.deepEqual([s.finished, Object.keys(s.lanes)], [true, ['1']]);
  assert.deepEqual(h.notes.map((x) => x.key), ['milestonePrepared']);
});

test('review I7: a follow-up needs-owner (L2 wrote the lane record needs-owner) reaches the owner once', async () => {
  const h = lanesHarness({ phases: [P('1')], merge: mergeFrom([{ outcome: 'merged' }]), followUp: () => ({ outcome: 'needs-owner', reason: 'CI timed out' }) });
  let s = await tick(freshLanes(), h.ctx);
  writeLaneStatus(h.root, '1', 'ready', { at: h.at() });
  h.agentOf('1').state = 'blocked';
  s = await tick(s, h.ctx);
  writeLaneStatus(h.root, '1', 'needs-owner', { at: h.at(), reason: 'CI timed out' });
  for (let i = 0; i < 3; i++) {
    h.advance(1);
    s = await tick(s, h.ctx);
  }
  assert.deepEqual(h.notes.map((x) => x.key), ['laneNeedsOwner']);
});

// ---- Stage 4 integration ----

test('integration: a job that failed in the supervisor (its session failed, or it could not launch) has its record failed, so the next start does not queue it again (L3 D12)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('3')], jobs: (options, hh) => hh.jobList });
  h.jobList = [{ kind: 'prep', phase: '2' }];
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', 'prep-2']);
  h.jobList = [];
  h.agentOf('prep-2').state = 'failed';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(s.jobsFailed['prep-2'].why, 'failed');
  assert.equal(readJobStatus(h.root, { kind: 'prep', phase: '2' })?.status, 'failed');
  // a record that says failed already (the session's own) keeps its reason
  writeJobStatus(h.root, { kind: 'annotate', phase: null }, 'failed', { reason: 'the analysis was refused twice' });
  h.jobList = [{ kind: 'annotate', phase: null }];
  h.launchFail = () => 'claude --bg failed: boom';
  for (let i = 0; i < 10 && !s.jobsFailed?.annotate; i++) {
    h.advance(1);
    s = await tick(s, h.ctx);
    h.jobList = [];
  }
  assert.ok(s.jobsFailed?.annotate, h.logs.slice(-5).join('\n'));
  assert.equal(s.lanes.annotate, undefined);
  assert.equal(readJobStatus(h.root, { kind: 'annotate', phase: null })?.reason, 'the analysis was refused twice');
  assert.equal(readJobStatus(h.root, { kind: 'annotate', phase: null })?.status, 'failed');
});

test('integration: a job session gets the lane temp dir in jobPrompts (the TMP rule of its system prompt)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], jobs: (options, hh) => hh.jobList });
  const seen = [];
  const prompts = h.ctx.deps.jobPrompts;
  h.ctx.deps.jobPrompts = (a) => { seen.push(a.lane); return prompts(a); };
  h.jobList = [{ kind: 'prep', phase: '2' }];
  await tick(freshLanes(), h.ctx);
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0].tmpDir, 'string');
  assert.equal(seen[0].tmpDir, h.launched.find((l) => l.name.includes('prep')).tmpDir);
});
