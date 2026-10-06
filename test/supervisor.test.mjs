import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { tick, runDaemon } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { writeLaneStatus, readLaneStatus } from '../lib/run-status.mjs';
import { laneSessionName } from '../lib/claude.mjs';

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
        rm: (id) => { h.removed.push(id); h.agents = h.agents.filter((a) => a.id !== id); },
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
  assert.deepEqual(s, fresh());
  assert.ok(h.logs.some((l) => /launch phase 2 failed: claude --bg failed/.test(l)));
  h.ctx.deps.claude.launchBg = working;
  s = await tick(s, h.ctx);
  assert.equal(s.lane.sessionId, 's1');

  // relaunch after a context pause: the failed attempt changes nothing (state or the lane's
  // paused-context record, which outranks human_needed) and costs no restart
  h.agents[0].state = 'done';
  writeLaneStatus(h.root, '2', 'paused-context', { reason: 'context', at: '2026-01-01T00:00:00.000Z' });
  const before = structuredClone(s);
  h.ctx.deps.claude.launchBg = broken;
  s = await tick(s, h.ctx);
  assert.deepEqual(s, before);
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

test('a --bg call that timed out after the session registered is picked up, not duplicated', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  const working = h.ctx.deps.claude.launchBg;
  h.ctx.deps.claude.launchBg = (opts, cwd) => { working(opts, cwd); throw new Error('claude --bg failed: timed out after 120000 ms'); };
  h.agents[0].state = 'done';
  s = await tick(s, h.ctx);
  assert.equal(s.lane.sessionId, 's1');
  h.ctx.deps.claude.launchBg = working;
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.equal(s.lane.sessionId, 's2');
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

test('failed session notifies and halts', async () => {
  const h = harness({ phases: [P('2')] });
  let s = await tick(fresh(), h.ctx);
  h.agents[0].state = 'failed';
  s = await tick(s, h.ctx);
  assert.equal(s.halted, true);
  assert.equal(h.notes.at(-1).key, 'laneFailed');
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
