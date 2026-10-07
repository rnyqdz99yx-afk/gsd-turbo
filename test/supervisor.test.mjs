import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { tick, runDaemon } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { writeLaneStatus, readLaneStatus } from '../lib/run-status.mjs';
import { laneSessionName, parseAgents } from '../lib/claude.mjs';

function harness({ phases, agents = [] }) {
  const root = tmpDir('sup');
  fs.mkdirSync(path.join(root, '.planning'));
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const h = {
    root, phases, agents, launched: [], removed: [], notes: [], logs: [], fp: 'A',
    advance(min) { clock += min * 60000; },
  };
  let n = 0;
  h.ctx = {
    root, config: structuredClone(DEFAULTS), turboRun: 'node x',
    deps: {
      loadPhases: () => h.phases,
      claude: {
        launchBg: (opts, cwd) => { const id = `s${++n}`; h.launched.push({ id, cwd, ...opts }); h.agents.push({ id, name: opts.name, cwd, state: 'working' }); return id; },
        list: () => h.agents,
        stop: () => {},
        rm: (id) => {
          h.removed.push(id);
          if (!h.agents.some((a) => a.id === id)) throw new Error(`claude rm failed: no session ${id}`);
          h.agents = h.agents.filter((a) => a.id !== id);
        },
      },
      fingerprint: () => h.fp,
      notify: async (key, vars) => { h.notes.push({ key, vars }); },
      now: () => new Date(clock),
      log: (line) => { h.logs.push(line); },
    },
  };
  return h;
}
const P = (number, deps = [], complete = false, verification = null) => ({ number, deps, complete, verification });
const fresh = () => ({ lane: null, finished: false, halted: false });

test('launches the next ready phase', async () => {
  const h = harness({ phases: [P('1', [], true), P('2', ['1'])] });
  const s = await tick(fresh(), h.ctx);
  assert.equal(s.lane.phase, '2');
  assert.equal(h.launched.length, 1);
  assert.match(h.launched[0].prompt, /--only 2/);
  assert.equal(h.launched[0].cwd, h.root);
});

test('adopts an already running session with the lane name instead of launching', async () => {
  const h = harness({ phases: [P('2')], agents: [] });
  // same directory written differently: forward slashes / trailing slash, upper case on win32
  const cwd = process.platform === 'win32' ? h.root.replace(/\\/g, '/').toUpperCase() : `${h.root}/`;
  h.agents.push({ id: 'old', name: laneSessionName(h.root, '2'), cwd, state: 'working' });
  const s = await tick(fresh(), h.ctx);
  assert.equal(h.launched.length, 0);
  assert.equal(s.lane.sessionId, 'old');
});

test('adoption sees through a junction or symlink to the checkout', async () => {
  const h = harness({ phases: [P('2')] });
  const link = path.join(tmpDir('sup-link'), 'checkout');
  fs.symlinkSync(h.root, link, 'junction');
  h.agents.push({ id: 'old', name: laneSessionName(h.root, '2'), cwd: link, state: 'working' });
  const s = await tick(fresh(), h.ctx);
  assert.equal(h.launched.length, 0);
  assert.equal(s.lane.sessionId, 'old');
});

test('does not adopt a same-named session from another directory or without a cwd', async () => {
  const h = harness({ phases: [P('2')] });
  const name = laneSessionName(h.root, '2');
  h.agents.push({ id: 'other', name, cwd: tmpDir('sup-other'), state: 'working' });
  h.agents.push({ id: 'nocwd', name, cwd: '', state: 'working' });
  const s = await tick(fresh(), h.ctx);
  assert.equal(h.launched.length, 1);
  assert.equal(s.lane.sessionId, 's1');
});

test('paused-context with progress relaunches with resume prompt; no progress halts after max', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'done';
  h.fp = 'B';
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.match(h.launched[1].prompt, /HANDOFF/);
  assert.equal(s.lane.restarts, 0);
  for (let i = 0; i < 4; i++) {
    h.agents.find((a) => a.id === s.lane.sessionId).state = 'done';
    s = await tick(s, h.ctx);
  }
  assert.equal(s.halted, true);
  assert.equal(h.notes.at(-1).key, 'laneHalted');
});

test('relaunch adopts an alive same-lane session instead of launching a duplicate', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'done';
  h.agents.push({ id: 'orphan', name: s.lane.name, cwd: h.root, state: 'working' });
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.deepEqual(h.removed, ['s1']);
  assert.equal(s.lane.sessionId, 'orphan');
  assert.equal(s.lane.restarts, 1);
});

test('a throwing launchBg leaves the state unchanged and the next tick launches', async () => {
  const h = harness({ phases: [P('2', [], false, 'human_needed')] });
  const working = h.ctx.deps.claude.launchBg;
  const broken = () => { throw new Error('claude --bg failed: exit status 1'); };

  h.ctx.deps.claude.launchBg = broken;
  let s = await tick(fresh(), h.ctx);
  assert.deepEqual(s, { ...fresh(), failingSince: '2026-01-01T00:00:00.000Z', launchFailures: 1 });
  assert.ok(h.logs.some((l) => /tick error: launch phase 2 failed: claude --bg failed/.test(l)));
  h.ctx.deps.claude.launchBg = working;
  s = await tick(s, h.ctx);
  assert.equal(s.lane.sessionId, 's1');
  assert.ok(!('failingSince' in s) && !('launchFailures' in s));

  // relaunch after a context pause: the failed attempt changes nothing (state or the lane's
  // paused-context record, which outranks human_needed) and costs no restart
  h.agents[0].state = 'done';
  writeLaneStatus(h.root, '2', 'paused-context', { reason: 'context', at: '2026-01-01T00:00:00.000Z' });
  const before = structuredClone(s);
  h.ctx.deps.claude.launchBg = broken;
  s = await tick(s, h.ctx);
  assert.deepEqual(s, { ...before, failingSince: '2026-01-01T00:00:00.000Z', launchFailures: 1 });
  assert.equal(readLaneStatus(h.root, '2').status, 'paused-context');
  h.ctx.deps.claude.launchBg = working;
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.equal(s.lane.sessionId, 's2');
  assert.equal(s.lane.restarts, 1);
  assert.match(h.launched[1].prompt, /HANDOFF/);
  assert.deepEqual(h.notes, []);
  assert.deepEqual([readLaneStatus(h.root, '2').status, readLaneStatus(h.root, '2').sessionId], ['running', 's2']);
});

// --bg that registers the session and then throws (timeout, or no id in its output)
const registersThenThrows = (h) => {
  const working = h.ctx.deps.claude.launchBg;
  return (opts, cwd) => { working(opts, cwd); throw new Error('claude --bg failed: timed out after 120000 ms'); };
};

test('a relaunch whose --bg registered the session and then threw adopts it with fresh accounting', async () => {
  const h = harness({ phases: [P('2', [], false, 'human_needed')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'done';
  h.advance(1);
  writeLaneStatus(h.root, '2', 'paused-context', { reason: 'context', at: '2026-01-01T00:01:00.000Z' });
  h.ctx.deps.claude.launchBg = registersThenThrows(h);
  h.advance(1);
  s = await tick(s, h.ctx); // rm s1; s2 registers, the call throws
  assert.equal(s.lane.sessionId, 's1');
  h.advance(1);
  s = await tick(s, h.ctx); // s1 is gone: paused-context again, the relaunch adopts s2
  assert.equal(h.launched.length, 2);
  assert.equal(s.lane.sessionId, 's2');
  assert.equal(s.lane.restarts, 1);
  assert.equal(s.lane.launchedAt, '2026-01-01T00:03:00.000Z');
  assert.ok(!('failingSince' in s) && !('launchFailures' in s), 'adoption counts as a successful tick');
  assert.ok(h.logs.some((l) => /rm session s1 failed: claude rm failed/.test(l)));
  // s2 ends without a record of its own: the old paused-context record is not fresh for it,
  // so the human_needed phase goes to the owner instead of another relaunch
  h.agents.find((a) => a.id === 's2').state = 'done';
  h.advance(1);
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.deepEqual(h.notes, [{ key: 'laneNeedsOwner', vars: { phase: '2', reason: 'human verification' } }]);
});

test('a --bg that always registers and then throws still halts after the restart budget', async () => {
  const h = harness({ phases: [P('2')] });
  h.ctx.deps.claude.launchBg = registersThenThrows(h);
  const statePath = path.join(h.root, '.planning', 'turbo', 'run', 'supervisor.json');
  let sleeps = 0;
  const sleep = async () => {
    if (++sleeps > 50) throw new Error('supervisor never halted');
    const { lane } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const agent = lane && h.agents.find((a) => a.id === lane.sessionId);
    if (agent) agent.state = 'done'; // every adopted session ends without progress
  };
  const s = await runDaemon({ ctx: h.ctx, statePath, intervalMs: 1, sleep });
  assert.equal(s.halted, true);
  assert.equal(h.notes.at(-1).key, 'laneHalted');
  assert.equal(h.launched.length, DEFAULTS.max_restarts_without_progress + 1);
});

// --bg that registers a session which dies at once, and then throws
const registersDeadThenThrows = (h) => {
  const working = h.ctx.deps.claude.launchBg;
  return (opts, cwd) => {
    const id = working(opts, cwd);
    h.agents.find((a) => a.id === id).state = 'done';
    throw new Error('claude --bg failed: timed out after 120000 ms');
  };
};
const deadLaneSessions = (h, phase) => h.agents.filter((a) => a.name === laneSessionName(h.root, phase) && a.state === 'done');
const BG_ERROR = 'launch phase 2 failed: claude --bg failed: timed out after 120000 ms';
async function tickUntilHalted(h, s) {
  for (let i = 0; i < 50 && !s.halted; i++) {
    s = await tick(s, h.ctx);
    assert.ok(deadLaneSessions(h, '2').length <= 1, `dead lane sessions after tick ${i + 1}`);
  }
  return s;
}

test('register-then-die --bg with no lane: bounded launches, dead sessions removed, launchHalted', async () => {
  const h = harness({ phases: [P('2')] });
  h.ctx.deps.claude.launchBg = registersDeadThenThrows(h);
  const s = await tickUntilHalted(h, fresh());
  assert.equal(s.halted, true);
  assert.equal(h.launched.length, 10);
  assert.equal(s.lane, null);
  assert.equal(s.launchFailures, 10);
  assert.deepEqual(h.notes, [{ key: 'launchHalted', vars: { phase: '2', error: BG_ERROR } }]);
  assert.ok(h.logs.some((l) => /phase 2 halted: launch failed 10 times in a row/.test(l)));
});

test('register-then-die --bg on a relaunch: bounded launches, launchHalted keeps the lane', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'done';
  h.ctx.deps.claude.launchBg = registersDeadThenThrows(h);
  s = await tickUntilHalted(h, s);
  assert.equal(s.halted, true);
  assert.equal(h.launched.length, 1 + 10);
  assert.equal(s.lane.sessionId, 's1');
  assert.deepEqual(h.notes, [{ key: 'launchHalted', vars: { phase: '2', error: BG_ERROR } }]);
});

test('register-then-die --bg on forceRelaunch: bounded launches, launchHalted', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  s.lane.forceRelaunch = true;
  h.ctx.deps.claude.launchBg = registersDeadThenThrows(h);
  s = await tickUntilHalted(h, s);
  assert.equal(s.halted, true);
  assert.equal(h.launched.length, 1 + 10);
  assert.deepEqual(h.notes, [{ key: 'launchHalted', vars: { phase: '2', error: BG_ERROR } }]);
});

test('a launch removes up to 3 dead sessions of this lane only, never alive or foreign ones', async () => {
  const h = harness({ phases: [P('2')] });
  const name = laneSessionName(h.root, '2');
  for (const id of ['d1', 'd2', 'd3', 'd4']) h.agents.push({ id, name, cwd: h.root, state: 'done' });
  h.agents.push({ id: 'other-phase', name: laneSessionName(h.root, '3'), cwd: h.root, state: 'done' });
  h.agents.push({ id: 'other-dir', name, cwd: tmpDir('sup-other'), state: 'done' });
  const s = await tick(fresh(), h.ctx);
  assert.deepEqual(h.removed, ['d1', 'd2', 'd3']);
  assert.equal(s.lane.sessionId, 's1');
  assert.ok(!('launchFailures' in s));
});

test('a launch that keeps failing notifies supervisorFailing once per failing spell', async () => {
  const h = harness({ phases: [P('2')] });
  const working = h.ctx.deps.claude.launchBg;
  h.ctx.deps.claude.launchBg = () => { throw new Error('claude --bg failed: exit status 1\nsecond line'); };
  let s = await tick(fresh(), h.ctx);
  h.advance(DEFAULTS.blocked_minutes_before_notify - 1);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes, []);
  h.advance(1);
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes, [{ key: 'supervisorFailing', vars: { error: 'launch phase 2 failed: claude --bg failed: exit status 1' } }]);
  assert.equal(h.logs.filter((l) => /^tick error: launch phase 2 failed/.test(l)).length, 4);
  assert.equal(s.lane, null);
  h.ctx.deps.claude.launchBg = working;
  s = await tick(s, h.ctx);
  assert.equal(s.lane.sessionId, 's1');
  assert.ok(!('failingSince' in s) && !('failingNotified' in s) && !('launchFailures' in s));
});

test('loadPhases or list failing every tick notifies once per spell with the first error line, capped', async () => {
  const h = harness({ phases: [P('2')] });
  const long = `gsd-tools init manager: ${'x'.repeat(300)}\nat stack line`;
  h.ctx.deps.loadPhases = () => { throw new Error(long); };
  let s = await tick(fresh(), h.ctx);
  h.advance(DEFAULTS.blocked_minutes_before_notify);
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes, [{ key: 'supervisorFailing', vars: { error: long.split('\n')[0].slice(0, 200) } }]);
  // recovery ends the spell; a later failing spell (agents list) notifies again and keeps the lane
  h.ctx.deps.loadPhases = () => h.phases;
  s = await tick(s, h.ctx);
  assert.equal(s.lane.sessionId, 's1');
  assert.ok(!('failingSince' in s));
  const list = h.ctx.deps.claude.list;
  h.ctx.deps.claude.list = () => { throw new Error('claude agents failed: timed out after 30000 ms'); };
  s = await tick(s, h.ctx);
  h.advance(DEFAULTS.blocked_minutes_before_notify);
  s = await tick(s, h.ctx);
  assert.equal(h.notes.length, 2);
  assert.deepEqual(h.notes[1].vars, { error: 'claude agents failed: timed out after 30000 ms' });
  assert.equal(s.lane.sessionId, 's1');
  h.ctx.deps.claude.list = list;
  s = await tick(s, h.ctx);
  assert.ok(!('failingSince' in s));
});

test('an agents list that stops parsing fails the tick and never removes the lane session', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  const before = structuredClone(s);
  h.ctx.deps.claude.list = () => parseAgents(JSON.stringify({ agents: h.agents }));
  for (let i = 0; i < 3; i++) s = await tick(s, h.ctx);
  assert.deepEqual(s, { ...before, failingSince: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(h.removed, []);
  assert.equal(h.launched.length, 1);
  assert.ok(h.logs.some((l) => /tick error: claude agents output is not a JSON array/.test(l)));
});

test('an unknown lane session state waits as blocked: no rm, no relaunch, logged once', async () => {
  const h = harness({ phases: [P('2', [], false, 'human_needed')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'running';
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  h.phases[0].complete = true;
  s = await tick(s, h.ctx);
  assert.deepEqual(h.removed, []);
  assert.equal(h.launched.length, 1);
  assert.equal(s.lane.sessionId, 's1');
  assert.equal(h.logs.filter((l) => /session s1 reports unknown state "running"/.test(l)).length, 1);
  h.advance(DEFAULTS.blocked_minutes_before_notify);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes, [{ key: 'laneBlocked', vars: { phase: '2', id: 's1' } }]);
});

test('a stopped lane session (claude stop, then start) is relaunched with resume, not waited on', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'stopped';
  h.fp = 'B';
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.match(h.launched[1].prompt, /HANDOFF/);
  assert.deepEqual(h.removed, ['s1']);
  assert.equal(s.lane.sessionId, 's2');
  assert.ok(!h.logs.some((l) => /unknown state/.test(l)));
});

test('a same-lane session in an unknown state is adopted, never removed or duplicated', async () => {
  const h = harness({ phases: [P('2')] });
  h.agents.push({ id: 'live', name: laneSessionName(h.root, '2'), cwd: h.root, state: 'running' });
  let s = await tick(fresh(), h.ctx);
  assert.equal(s.lane.sessionId, 'live');
  // and on a relaunch: the ended lane session is replaced by the unknown-state one
  h.agents.find((a) => a.id === 'live').state = 'done';
  h.agents.push({ id: 'live2', name: laneSessionName(h.root, '2'), cwd: h.root, state: 'running' });
  h.fp = 'B';
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 0);
  assert.deepEqual(h.removed, ['live']);
  assert.equal(s.lane.sessionId, 'live2');
});

test('a dependency cycle among unfinished phases is logged and notified once; fixing it launches', async () => {
  const h = harness({ phases: [P('1', [], true), P('2', ['3']), P('3', ['2'])] });
  let s = await tick(fresh(), h.ctx);
  s = await tick(s, h.ctx);
  assert.equal(s.lane, null);
  assert.equal(s.finished, false);
  assert.equal(h.launched.length, 0);
  assert.deepEqual(h.notes, [{ key: 'noReadyPhase', vars: { phases: '2, 3' } }]);
  assert.equal(h.logs.filter((l) => /^no ready phase: 2, 3/.test(l)).length, 1);
  h.phases[2].deps = [];
  s = await tick(s, h.ctx);
  assert.equal(s.lane.phase, '3');
  assert.ok(!('noReady' in s));
});

test('a lane whose phase left the roadmap keeps a live session, and halts once it has ended', async () => {
  const h = harness({ phases: [P('2'), P('3')] });
  let s = await tick(fresh(), h.ctx);
  h.phases = [P('3')];
  s = await tick(s, h.ctx);
  assert.equal(s.halted, false);
  assert.equal(s.lane.sessionId, 's1');
  h.agents[0].state = 'done';
  s = await tick(s, h.ctx);
  assert.equal(s.halted, true);
  assert.equal(s.lane, null, 'a restart (resume) goes on with the next ready phase');
  assert.equal(h.launched.length, 1);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.notes, [{ key: 'phaseMissing', vars: { phase: '2', id: 's1' } }]);
});

test('a finished (blocked) session of a phase that left the roadmap halts like an ended one, even with a fresh paused-context record', async () => {
  const h = harness({ phases: [P('2'), P('3')] });
  let s = await tick(fresh(), h.ctx);
  h.phases = [P('3')];
  h.advance(1);
  writeLaneStatus(h.root, '2', 'paused-context', { at: '2026-01-01T00:01:00.000Z' });
  h.agents[0].state = 'blocked';
  s = await tick(s, h.ctx);
  assert.equal(s.halted, true);
  assert.equal(s.lane, null);
  assert.equal(h.launched.length, 1, 'never relaunched for a phase GSD no longer lists');
  assert.deepEqual(h.removed, [], 'the session is kept for inspection');
  assert.deepEqual(h.notes, [{ key: 'phaseMissing', vars: { phase: '2', id: 's1' } }]);
});

test('adoption takes launchedAt from the session start, so a record it wrote before adoption counts', async () => {
  const h = harness({ phases: [P('2')] });
  const working = h.ctx.deps.claude.launchBg;
  h.ctx.deps.claude.launchBg = (opts, cwd) => {
    const id = working(opts, cwd);
    h.agents.find((a) => a.id === id).startedAt = h.ctx.deps.now().getTime();
    throw new Error('claude --bg failed: timed out after 120000 ms');
  };
  let s = await tick(fresh(), h.ctx); // 00:00 s1 registers, the call throws
  h.advance(1);
  writeLaneStatus(h.root, '2', 'needs-owner', { reason: 'owner sign-off', at: h.ctx.deps.now().toISOString() });
  h.advance(1);
  s = await tick(s, h.ctx); // 00:02 adopts s1
  assert.equal(s.lane.sessionId, 's1');
  assert.equal(s.lane.launchedAt, '2026-01-01T00:00:00.000Z');
  h.agents[0].state = 'done';
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.deepEqual(h.notes, [{ key: 'laneNeedsOwner', vars: { phase: '2', reason: 'owner sign-off' } }]);
});

test('adoption falls back to now for a start time that is missing, in seconds, in the future or garbage', async () => {
  const start = Date.parse('2026-01-01T00:03:00Z');
  const cases = [
    [start, '2026-01-01T00:03:00.000Z'],
    ['2026-01-01T00:04:00.000Z', '2026-01-01T00:04:00.000Z'],
    [String(start), '2026-01-01T00:03:00.000Z'],
    [start / 1000, '2026-01-01T00:10:00.000Z'],
    [Date.parse('2026-01-01T00:30:00Z'), '2026-01-01T00:10:00.000Z'],
    ['soon', '2026-01-01T00:10:00.000Z'],
    [0, '2026-01-01T00:10:00.000Z'],
    [undefined, '2026-01-01T00:10:00.000Z'],
  ];
  for (const [startedAt, want] of cases) {
    const h = harness({ phases: [P('2')] });
    h.advance(10);
    h.agents.push({ id: 'old', name: laneSessionName(h.root, '2'), cwd: h.root, state: 'working', startedAt });
    const s = await tick(fresh(), h.ctx);
    assert.equal(s.lane.sessionId, 'old');
    assert.equal(s.lane.launchedAt, want, String(startedAt));
  }
});

test('runDaemon keeps running when the state file cannot be written, logging once per spell', async () => {
  const h = harness({ phases: [P('1', [], true)] });
  const blocker = path.join(h.root, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  let calls = 0;
  h.ctx.deps.loadPhases = () => {
    if (++calls <= 2) throw new Error('gsd-tools failed');
    return h.phases;
  };
  let sleeps = 0;
  const sleep = async () => { if (++sleeps > 10) throw new Error('runaway daemon'); };
  const s = await runDaemon({ ctx: h.ctx, statePath: path.join(blocker, 'supervisor.json'), intervalMs: 1, sleep });
  assert.equal(s.finished, true);
  assert.equal(sleeps, 2);
  assert.equal(h.logs.filter((l) => /^state write failed: /.test(l)).length, 1);
});

test('an empty phase list is not a finished milestone; it is logged once', async () => {
  const h = harness({ phases: [] });
  let s = await tick(fresh(), h.ctx);
  s = await tick(s, h.ctx);
  assert.equal(s.finished, false);
  assert.deepEqual(h.notes, []);
  assert.equal(h.logs.filter((l) => /no phases/.test(l)).length, 1);
  h.phases = [P('2')];
  s = await tick(s, h.ctx);
  assert.equal(s.lane.phase, '2');
  assert.ok(!('noPhases' in s));
});

test('needs-owner ignores the reason of a lane record older than the session', async () => {
  const h = harness({ phases: [P('2', [], false, 'human_needed')] });
  let s = await tick(fresh(), h.ctx);
  writeLaneStatus(h.root, '2', 'needs-owner', { reason: 'old reason', at: '2025-12-31T23:59:00.000Z' });
  h.agents[0].state = 'done';
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes, [{ key: 'laneNeedsOwner', vars: { phase: '2', reason: 'human verification' } }]);
});

test('needs-owner notifies once and waits; completion advances', async () => {
  const h = harness({ phases: [P('2'), P('3', ['2'])] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'done';
  h.advance(1);
  writeLaneStatus(h.root, '2', 'needs-owner', { reason: 'owner sign-off', at: '2026-01-01T00:01:00.000Z' });
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  const owner = h.notes.filter((x) => x.key === 'laneNeedsOwner');
  assert.equal(owner.length, 1);
  assert.equal(owner[0].vars.reason, 'owner sign-off');
  assert.equal(h.launched.length, 1);
  h.phases[0].complete = true;
  s = await tick(s, h.ctx);
  assert.equal(s.lane, null);
  assert.ok(h.notes.some((x) => x.key === 'phaseDone'));
  s = await tick(s, h.ctx);
  assert.equal(s.lane.phase, '3');
});

test('blocked notifies once per blocked spell after the configured minutes', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'blocked';
  s = await tick(s, h.ctx);
  assert.equal(h.notes.length, 0);
  h.advance(DEFAULTS.blocked_minutes_before_notify + 1);
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.equal(h.notes.filter((x) => x.key === 'laneBlocked').length, 1);
  assert.deepEqual(h.notes[0].vars, { phase: '2', id: 's1' });
  // unblocked, then blocked again later: a new spell notifies again
  h.agents[0].state = 'working';
  s = await tick(s, h.ctx);
  h.agents[0].state = 'blocked';
  s = await tick(s, h.ctx);
  h.advance(DEFAULTS.blocked_minutes_before_notify + 1);
  s = await tick(s, h.ctx);
  assert.equal(h.notes.filter((x) => x.key === 'laneBlocked').length, 2);
});

test('forceRelaunch (set by turbo-run resume) relaunches once even while GSD says human_needed', async () => {
  const h = harness({ phases: [P('2', [], false, 'human_needed')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'done';
  s.lane.forceRelaunch = true;
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.match(h.launched[1].prompt, /HANDOFF/);
  assert.equal(s.lane.forceRelaunch, false);
});

test('forceRelaunch never adopts the session it has just removed', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  s.lane.forceRelaunch = true;
  s = await tick(s, h.ctx);
  assert.deepEqual(h.removed, ['s1']);
  assert.equal(h.launched.length, 2);
  assert.equal(s.lane.sessionId, 's2');
});

test('forceRelaunch of a finished (blocked) session that rm cannot remove launches nothing until rm succeeds', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'blocked';
  s.lane.forceRelaunch = true;
  const rm = h.ctx.deps.claude.rm;
  h.ctx.deps.claude.rm = () => { throw new Error('claude rm failed: permission denied'); };
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.equal(s.lane.sessionId, 's1');
  assert.equal(s.lane.forceRelaunch, true, 'the resume is still pending');
  assert.ok(h.logs.some((l) => /tick error: claude rm failed/.test(l)), h.logs.join('\n'));
  h.ctx.deps.claude.rm = rm;
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.equal(s.lane.sessionId, 's2');
  assert.equal(s.lane.forceRelaunch, false);
  assert.deepEqual(h.agents.map((a) => a.id), ['s2']);
});

test('failed session notifies and halts', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'failed';
  s = await tick(s, h.ctx);
  assert.equal(s.halted, true);
  assert.equal(h.notes.at(-1).key, 'laneFailed');
});

// A lane that writes its record and ends its turn stays listed as state "blocked" (Claude Code 2.1.292).
test('blocked session with a fresh needs-owner record: one laneNeedsOwner with its reason, never laneBlocked', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.advance(1);
  writeLaneStatus(h.root, '2', 'needs-owner', { reason: 'owner sign-off', at: '2026-01-01T00:01:00.000Z' });
  h.agents[0].state = 'blocked';
  s = await tick(s, h.ctx);
  h.advance(DEFAULTS.blocked_minutes_before_notify + 1);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes, [{ key: 'laneNeedsOwner', vars: { phase: '2', reason: 'owner sign-off' } }]);
  assert.equal(h.launched.length, 1);
  assert.deepEqual(h.removed, []);
});

test('blocked session with a fresh paused-context record is removed, then the lane is relaunched', async () => {
  const h = harness({ phases: [P('2')] });
  const order = [];
  const { rm, launchBg } = h.ctx.deps.claude;
  h.ctx.deps.claude.rm = (id) => { order.push(`rm ${id}`); return rm(id); };
  h.ctx.deps.claude.launchBg = (opts, cwd) => { const id = launchBg(opts, cwd); order.push(`launch ${id}`); return id; };
  let s = await tick(fresh(), h.ctx);
  h.advance(1);
  writeLaneStatus(h.root, '2', 'paused-context', { reason: 'ctx 56%', at: '2026-01-01T00:01:00.000Z' });
  h.agents[0].state = 'blocked';
  h.fp = 'B';
  s = await tick(s, h.ctx);
  assert.deepEqual(order, ['launch s1', 'rm s1', 'launch s2']);
  assert.equal(s.lane.sessionId, 's2');
  assert.match(h.launched[1].prompt, /HANDOFF/);
  assert.deepEqual(h.agents.map((a) => a.id), ['s2']);
});

test('a blocked paused-context session that rm cannot remove is never relaunched next to', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.advance(1);
  writeLaneStatus(h.root, '2', 'paused-context', { at: '2026-01-01T00:01:00.000Z' });
  h.agents[0].state = 'blocked';
  const rm = h.ctx.deps.claude.rm;
  h.ctx.deps.claude.rm = () => { throw new Error('claude rm failed: permission denied'); };
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.equal(s.lane.sessionId, 's1');
  assert.ok(h.logs.some((l) => /tick error: claude rm failed/.test(l)), h.logs.join('\n'));
  h.ctx.deps.claude.rm = rm;
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.equal(s.lane.sessionId, 's2');
});

test('blocked session with a fresh failed record notifies laneFailed and halts', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.advance(1);
  writeLaneStatus(h.root, '2', 'failed', { reason: 'tests broke', at: '2026-01-01T00:01:00.000Z' });
  h.agents[0].state = 'blocked';
  s = await tick(s, h.ctx);
  assert.equal(s.halted, true);
  assert.deepEqual(h.notes.map((x) => x.key), ['laneFailed']);
  assert.equal(h.launched.length, 1);
});

test('blocked session with a stale needs-owner record waits as blocked; a working one with a fresh record runs', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  writeLaneStatus(h.root, '2', 'needs-owner', { reason: 'old reason', at: '2025-12-31T23:59:00.000Z' });
  h.agents[0].state = 'blocked';
  s = await tick(s, h.ctx);
  h.advance(DEFAULTS.blocked_minutes_before_notify + 1);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes.map((x) => x.key), ['laneBlocked']);
  writeLaneStatus(h.root, '2', 'needs-owner', { reason: 'owner sign-off', at: '2026-01-01T00:11:00.000Z' });
  h.agents[0].state = 'working';
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes.map((x) => x.key), ['laneBlocked']);
  assert.equal(s.lane.blockedSince, null);
  assert.equal(h.launched.length, 1);
});

// Claude Code 2.1.292 lists a session that finished its turn as state "blocked", status idle.
test('a finished (blocked) session on a completed phase: removed before phaseDone, the next phase gets its own session', async () => {
  const h = harness({ phases: [P('2'), P('3', ['2'])] });
  const order = [];
  const { rm } = h.ctx.deps.claude;
  h.ctx.deps.claude.rm = (id) => { order.push(`rm ${id}`); return rm(id); };
  const notify = h.ctx.deps.notify;
  h.ctx.deps.notify = async (key, vars) => { order.push(key); return notify(key, vars); };
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'blocked';
  h.phases[0].complete = true;
  s = await tick(s, h.ctx);
  assert.deepEqual(order, ['rm s1', 'phaseDone']);
  assert.equal(s.lane, null);
  s = await tick(s, h.ctx);
  assert.equal(s.lane.phase, '3');
  assert.equal(s.lane.sessionId, 's2');
  assert.deepEqual(h.agents.map((a) => a.id), ['s2']);
});

test('a finished (blocked) session that rm cannot remove keeps the lane: no phaseDone, no next launch, retried', async () => {
  const h = harness({ phases: [P('2'), P('3', ['2'])] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'blocked';
  h.phases[0].complete = true;
  const rm = h.ctx.deps.claude.rm;
  h.ctx.deps.claude.rm = () => { throw new Error('claude rm failed: permission denied'); };
  s = await tick(s, h.ctx);
  s = await tick(s, h.ctx);
  assert.equal(s.lane.phase, '2');
  assert.deepEqual(h.notes, []);
  assert.equal(h.launched.length, 1);
  h.ctx.deps.claude.rm = rm;
  s = await tick(s, h.ctx);
  assert.equal(s.lane, null);
  assert.deepEqual(h.notes.map((x) => x.key), ['phaseDone']);
  assert.deepEqual(h.agents, []);
});

test('a finished (blocked) safe-mode session on a human_needed phase: one laneNeedsOwner, the session kept', async () => {
  const h = harness({ phases: [P('2', [], false, 'human_needed')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'blocked';
  s = await tick(s, h.ctx);
  h.advance(DEFAULTS.blocked_minutes_before_notify + 1);
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes, [{ key: 'laneNeedsOwner', vars: { phase: '2', reason: 'human verification' } }]);
  assert.deepEqual(h.removed, []);
  assert.equal(h.launched.length, 1);
});

test('milestone done when all phases complete', async () => {
  const h = harness({ phases: [P('1', [], true)] });
  const s = await tick(fresh(), h.ctx);
  assert.equal(s.finished, true);
  assert.equal(h.notes[0].key, 'milestoneDone');
});

test('runDaemon survives a tick error, persists state every tick, stops when finished', async () => {
  const h = harness({ phases: [P('1', [], true)] });
  const statePath = path.join(h.root, '.planning', 'turbo', 'run', 'supervisor.json');
  let calls = 0;
  h.ctx.deps.loadPhases = () => {
    if (++calls === 1) throw new Error('gsd-tools failed');
    return h.phases;
  };
  const seen = [];
  const s = await runDaemon({ ctx: h.ctx, statePath, intervalMs: 1, sleep: async () => { seen.push(JSON.parse(fs.readFileSync(statePath, 'utf8'))); } });
  assert.equal(s.finished, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].finished, false);
  assert.equal(seen[0].pid, process.pid);
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).finished, true);
  assert.ok(h.logs.some((l) => /tick error: gsd-tools failed/.test(l)));
});
