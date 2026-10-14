import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A, P, annotated, freshLanes, lanesHarness } from './helpers/lanes.mjs';
import { tick } from '../lib/supervisor.mjs';
import { readLaneStatus, writeLaneStatus } from '../lib/run-status.mjs';
import { laneSessionName } from '../lib/claude.mjs';
import { writeAttend } from '../lib/attend.mjs';
import { acquireGate, releaseGate } from '../lib/gate-locks.mjs';
import { msg } from '../lib/messages.mjs';

test('two independent phases start together, each in its own slot, with the control root in its session; the dependent one waits (spec §5, §13)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('3', ['1'])], lanes: annotated({ 1: A('src/a/**'), 2: A('src/b/**'), 3: A('src/a/**') }) });
  const s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', '2']);
  const l1 = s.lanes['1'];
  assert.deepEqual(
    [l1.key, l1.job, l1.phase, l1.slot, l1.slotPath, l1.branch, l1.sessionId, l1.launchedAt, l1.restarts, l1.mode, l1.areas, l1.gates, l1.launch],
    ['1', 'phase', '1', 1, h.slots[0].path, 'turbo/p1', 's1', h.at(), 0, 'full', ['src/a/**'], [], undefined],
  );
  assert.deepEqual(h.launched.map((l) => [l.cwd, l.controlRoot, l.name]), [
    [h.slots[0].path, h.root, laneSessionName(h.root, '1')],
    [h.slots[1].path, h.root, laneSessionName(h.root, '2')],
  ]);
  assert.equal(h.launched[0].prompt, 'Run the turbo-phase skill with arguments: 1');
  assert.match(h.launched[0].systemPrompt, /lock <gate> 1 /, 'slot lanes get the lock rule');
  assert.equal(readLaneStatus(h.root, '1').status, 'running');
  assert.deepEqual(s.next, { phase: '3', why: 'deps', waitsFor: ['1'] });
  assert.equal(s.lane, undefined, 'slots mode never writes v0.3\'s lane');
  assert.ok(h.logs.includes(`phase 1: slot 1 prepared on turbo/p1`), h.logs.join('\n'));
});

test('without an annotation only one phase lane runs; a stale one keeps the unchanged phases marks (spec §5, reconcile R8)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')] });
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  assert.deepEqual(s.next, { phase: '2', why: 'annotation', waitsFor: ['1'] });
  // reconcile R8: a stale annotation does not limit the lanes; L3 leaves the changed phases out (they read as **)
  h.annotation = { fresh: false, phases: { 1: A('a/**') } };
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1'], 'phase 2 changed since its markup: ** overlaps phase 1');
  assert.deepEqual(s.next, { phase: '2', why: 'areas', waitsFor: ['1'] });
  h.annotation = { fresh: false, phases: { 1: A('a/**'), 2: A('b/**') } };
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', '2'], 'unchanged phases keep their marks');
});

test('an error in one lane rolls back only that lane; ten failed launches stop it alone; an untrusted folder stops it at once (D6, D7; Review Focus 2)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('3')], lanes: annotated({ 1: A('a/**'), 2: A('b/**'), 3: A('c/**') }) });
  h.launchFail = (opts) => (opts.name === laneSessionName(h.root, '2') ? 'claude --bg failed: boom' : null);
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual([s.lanes['1'].sessionId, s.lanes['2'].sessionId, s.lanes['3'].sessionId], ['s1', null, 's2']);
  assert.deepEqual([s.lanes['2'].launchFailures, s.lanes['2'].slot, s.lanes['2'].launch], [1, 2, 'new']);
  assert.equal(s.failingSince, undefined, 'a lane error never fails the tick');
  for (let i = 0; i < 9; i++) {
    h.advance(1);
    s = await tick(s, h.ctx);
  }
  assert.equal(s.lanes['2'].halted.why, 'launch');
  assert.match(s.lanes['2'].halted.error, /^launch phase 2 failed: claude --bg failed: boom$/);
  assert.deepEqual(h.notes.filter((x) => x.key === 'laneStopped').map((x) => [x.vars.phase, x.vars.why]), [['2', 'launch']]);
  assert.deepEqual(h.prepared.map((p) => p[2]), ['1', '2', '3'], 'the same slot is retried, never a second one');
  assert.equal(h.slots[1].job.state, 'active', 'its slot keeps the job');
  assert.equal(h.launched.length, 2);
  assert.equal(s.halted, false);
  const u = lanesHarness({ phases: [P('1')] });
  u.launchFail = () => 'claude --bg failed: Workspace not trusted';
  s = await tick(freshLanes(), u.ctx);
  assert.equal(s.lanes['1'].halted.why, 'untrusted');
  assert.equal(s.halted, true, 'every lane stopped and nothing can start');
});

test('a failed session or no progress stops only its lane; the run halts once every lane is stopped (spec §9)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], lanes: annotated({ 1: A('a/**'), 2: A('b/**') }) });
  h.ctx.config.max_restarts_without_progress = 0;
  let s = await tick(freshLanes(), h.ctx);
  h.agentOf('1').state = 'failed';
  h.agentOf('2').state = 'done'; // ended without a record and without a new commit: paused-context without progress
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([s.lanes['1'].halted?.why, s.lanes['2'].halted?.why], ['failed', 'noProgress']);
  assert.equal(s.lanes['1'].halted.sessionFailed, true, 'its session failed, not the lane by its own record');
  assert.equal(s.halted, true);
  assert.equal(s.haltedFor, undefined, 'a lane stopped for the owner: a start at logon leaves the run halted');
  assert.deepEqual(h.notes.map((x) => x.key), ['laneStopped', 'laneStopped']);
  assert.equal(msg('en', 'laneStopped', h.notes[0].vars).body, `The other lanes go on. To look inside: cd "${h.slots[0].path}" && claude. To try again: /turbo-autonomous resume 1`);
});

test('every lane stopped by its session\'s failure: the run halts with haltedFor sessionFailed, which a start at logon takes up (Gap 2, review I2)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], lanes: annotated({ 1: A('a/**'), 2: A('b/**') }) });
  let s = await tick(freshLanes(), h.ctx);
  h.agentOf('1').state = 'failed';
  h.agentOf('2').state = 'failed';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([s.lanes['1'].halted?.sessionFailed, s.lanes['2'].halted?.sessionFailed, s.halted, s.haltedFor], [true, true, true, 'sessionFailed']);
});

test('a supervisor that starts after a reboot relaunches the slot lanes whose sessions failed or are gone, as continuations; a lane that asked the owner keeps waiting (Gap 2)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('3')], lanes: annotated({ 1: A('a/**'), 2: A('b/**'), 3: A('c/**') }) });
  h.ctx.config.max_restarts_without_progress = 0;
  let s = await tick(freshLanes(), h.ctx);
  h.agentOf('1').state = 'failed';
  h.agents = h.agents.filter((a) => a.id !== s.lanes['2'].sessionId); // gone after the reboot
  h.agentOf('3').state = 'failed';
  writeLaneStatus(h.root, '3', 'needs-owner', { reason: 'sign-off', at: h.at() }); // phase 3 asked before the crash
  h.advance(30);
  // a lane step that fails keeps the relaunch armed for the next tick (the takeover is the first tick's only)
  h.launchFail = (opts) => (opts.name === laneSessionName(h.root, '1') ? 'claude --bg failed: the background service may be restarting' : null);
  s = await tick({ ...s, takeover: true }, h.ctx);
  assert.equal(s.takeover, undefined);
  assert.deepEqual([s.lanes['1'].halted, s.lanes['1'].forceRelaunch, s.lanes['1'].sessionId], [undefined, true, 's1']);
  assert.deepEqual([s.lanes['2'].halted, s.lanes['2'].sessionId, s.lanes['2'].restarts], [undefined, 's4', 0]);
  assert.deepEqual([s.lanes['3'].halted, s.lanes['3'].sessionId], [undefined, 's3'], 'phase 3 waits for its answer');
  h.launchFail = () => null;
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([s.lanes['1'].halted, s.lanes['1'].forceRelaunch, s.lanes['1'].sessionId], [undefined, false, 's5']);
  assert.equal(h.launched.find((l) => l.id === 's5').prompt, 'Resume phase 1. Run the turbo-phase skill with arguments: 1 --resume');
  assert.equal(s.halted, false);
  assert.deepEqual(h.notes.filter((x) => x.key === 'laneStopped'), []);
});

test('a slot Claude Code does not trust is never used (the owner is told once); a slot that refuses its preparation is skipped for a while (D10)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], slots: 2, lanes: annotated({ 1: A('a/**'), 2: A('b/**') }) });
  h.trust[1] = false;
  h.refuse[2] = 'uncommitted changes: M src/x.ts';
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(s.lanes, {});
  assert.deepEqual(h.notes.map((x) => x.key), ['slotRefused', 'slotUntrusted']);
  assert.deepEqual(h.notes[0].vars, { k: 2, why: 'uncommitted changes: M src/x.ts', minutes: 10 });
  assert.deepEqual(h.notes[1].vars, { k: 1, line: `open claude in ${h.slots[0].path} once and accept the trust dialog` });
  assert.deepEqual(s.next, { phase: '1', why: 'slots', waitsFor: [] });
  assert.equal(s.halted, false);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.notes.length, 2, 'each told once');
  assert.equal(h.prepared.length, 1, 'the refused slot is skipped for blocked_minutes_before_notify');
  h.trust[1] = true;
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([Object.keys(s.lanes), s.lanes['1'].slot], [['1'], 1]);
  delete h.refuse[2];
  h.advance(10);
  s = await tick(s, h.ctx);
  assert.deepEqual([Object.keys(s.lanes), s.lanes['2'].slot], [['1', '2'], 2]);
  assert.equal(s.slotRefused?.[2], undefined);
});

test('an attended lane is held alone: a late session of it is stopped, nothing relaunches or wakes it; the other lanes go on (D11; Review Focus 3)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2')], lanes: annotated({ 1: A('a/**'), 2: A('b/**') }) });
  let s = await tick(freshLanes(), h.ctx);
  writeAttend(h.root, '1', { sessionId: 's1' });
  // a launch or wake of an earlier tick that registered after attend stopped the listed sessions
  h.agents.push({ id: 'late', name: laneSessionName(h.root, '1'), cwd: h.slots[0].path, state: 'working' });
  h.agentOf('2').state = 'done'; // lane 2 ended its turn without a record: relaunched as usual
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([...h.stopped].sort(), ['late', 's1']);
  assert.deepEqual(h.launched.map((l) => l.name), [laneSessionName(h.root, '1'), laneSessionName(h.root, '2'), laneSessionName(h.root, '2')]);
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual([...h.stopped].sort(), ['late', 's1'], 'a stopped session is not stopped again');
  assert.equal(h.logs.filter((l) => l.startsWith('phase 1 is attended in the owner\'s session')).length, 1);
  assert.equal(s.lanes['1'].sessionId, 's1');
});

test('Gates: a phase whose gate a running phase declares waits; one whose gate a lock holds waits until it is unlocked (spec §5)', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2'), P('3')], lanes: annotated({ 1: A('a/**', ['prod-deploy']), 2: A('b/**', ['prod-deploy']), 3: A('c/**', ['packaged-build']) }) });
  await acquireGate(h.root, 'packaged-build', '9'); // the owner's own lock: only unlock frees it (D13)
  let s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  assert.deepEqual(s.lanes['1'].gates, ['prod-deploy']);
  assert.deepEqual(s.next, { phase: '2', why: 'gates', waitsFor: ['1'], gate: 'prod-deploy' });
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  releaseGate(h.root, 'packaged-build', '9');
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1', '3']);
});

test('laneStopped, slotUntrusted and slotRefused in en and ru', () => {
  const slot = 'C:\\Users\\dev\\app.turbo\\lane-2';
  assert.deepEqual(msg('en', 'laneStopped', { phase: '2', why: 'launch', slot, error: 'launch phase 2 failed: boom' }), {
    title: 'Phase 2 stopped: its session could not start',
    body: `Error: launch phase 2 failed: boom. The other lanes go on. To look inside: cd "${slot}" && claude. To try again: /turbo-autonomous resume 2`,
  });
  assert.equal(msg('ru', 'laneStopped', { phase: '2', why: 'failed', slot, error: '' }).title, 'Фаза 2 остановлена: её сессия завершилась сбоем');
  assert.equal(msg('ru', 'laneStopped', { phase: '2', why: 'failed', slot, error: '' }).body, `Остальные полосы продолжают работу. Посмотреть: cd "${slot}" && claude. Попробовать снова: /turbo-autonomous resume 2`);
  assert.deepEqual(msg('en', 'slotUntrusted', { k: 1, line: 'open claude in C:\\Users\\dev\\app.turbo\\lane-1 once and accept the trust dialog' }), {
    title: 'Lane slot 1 is not trusted yet',
    body: 'open claude in C:\\Users\\dev\\app.turbo\\lane-1 once and accept the trust dialog. Phases wait for a trusted slot meanwhile.',
  });
  assert.deepEqual(msg('ru', 'slotRefused', { k: 2, why: 'uncommitted changes', minutes: 10 }), {
    title: 'Слот полосы 2 нельзя использовать',
    body: 'uncommitted changes. В нём ничего не изменено; turbo попробует снова через 10 мин, а пока использует другие слоты.',
  });
});

test('slots mode records the unfinished phases of the run too (remaining), the running ones included', async () => {
  const h = lanesHarness({ phases: [P('1'), P('2', [], true), P('3', ['1'])], lanes: annotated({ 1: A('a/**'), 3: A('a/**') }) });
  const s = await tick(freshLanes(), h.ctx);
  assert.deepEqual(Object.keys(s.lanes), ['1']);
  assert.deepEqual(s.remaining, ['1', '3']);
});

test('F5: the owner\'s resume N handed to the running supervisor clears that phase between lane steps and relaunches its lane; the other lanes go on untouched', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { requestResume } = await import('../lib/attend.mjs');
  const { readProgress } = await import('../lib/phase-progress.mjs');
  const h = lanesHarness({ phases: [P('1'), P('2')], lanes: annotated({ 1: A('a/**'), 2: A('b/**') }) });
  h.ctx.config.max_restarts_without_progress = 0;
  let s = await tick(freshLanes(), h.ctx);
  h.agentOf('2').state = 'failed';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(s.lanes['2'].halted?.why, 'failed');
  const run = path.join(h.root, '.planning', 'turbo', 'run');
  fs.writeFileSync(path.join(run, 'p2-owner.md'), '# Phase 2\n');
  fs.writeFileSync(path.join(run, 'phase-p2.json'), JSON.stringify({ phase: '2', done: ['freshness'], notes: {}, attempts: { fix: 3 } }));
  writeLaneStatus(h.root, '2', 'failed', { reason: 'tests red', at: h.at() });
  const lane1 = structuredClone(s.lanes['1']);
  requestResume(h.root, '2', { now: new Date(h.at()) });
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(s.lanes['2'].halted, undefined);
  assert.deepEqual([s.lanes['2'].restarts, s.lanes['2'].forceRelaunch, s.lanes['2'].sessionId], [0, false, 's3'], 'relaunched in the same tick');
  assert.equal(h.launched.at(-1).name, laneSessionName(h.root, '2'));
  assert.equal(readLaneStatus(h.root, '2')?.status, 'running', 'the old failed record is gone; the relaunch wrote its own');
  assert.equal(fs.existsSync(path.join(run, 'p2-owner.md')), false);
  assert.deepEqual([readProgress(h.root, '2').done, readProgress(h.root, '2').attempts], [['freshness'], {}]);
  assert.equal(fs.existsSync(path.join(run, 'p2-resume.json')), false, 'the request is taken once');
  assert.deepEqual({ ...s.lanes['1'], notified: lane1.notified }, { ...lane1, notified: lane1.notified }, 'lane 1 is as it was');
  assert.ok(h.logs.includes('phase 2: resumed by the owner (turbo-run resume 2); its lane is relaunched'), h.logs.join('\n'));
  assert.equal(s.halted, false);
});
