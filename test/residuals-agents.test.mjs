import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { createClaude, parseAgents } from '../lib/claude.mjs';
import { tick } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { msg } from '../lib/messages.mjs';

test('parseAgents takes a state only from a string field', () => {
  const a = parseAgents(JSON.stringify([
    { id: 'o1', state: { phase: 'x' }, status: 'busy' },
    { id: 'n1', state: 7, status: 'working' },
    { id: 'e1', state: '', status: 'done' },
    { id: 's1', state: 'blocked', status: 'busy' },
  ]));
  assert.deepEqual(a.map((x) => [x.id, x.state]), [['o1', 'busy'], ['n1', 'working'], ['e1', 'done'], ['s1', 'blocked']]);
});

function harness({ phases, launch } = {}) {
  const root = tmpDir('res');
  fs.mkdirSync(path.join(root, '.planning'));
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const h = { root, phases, agents: [], launched: [], notes: [], fp: 'A', advance(min) { clock += min * 60000; } };
  let n = 0;
  h.ctx = {
    root, config: structuredClone(DEFAULTS), turboRun: 'node x',
    deps: {
      loadPhases: () => h.phases,
      claude: {
        launchBg: (o) => {
          const id = `s${++n}`;
          h.launched.push({ id, ...o });
          if (launch) return launch(id, o);
          h.agents.push({ id, name: o.name, cwd: root, state: 'working' });
          return id;
        },
        list: () => h.agents,
        stop() {},
        rm: (id) => { h.agents = h.agents.filter((a) => a.id !== id); },
      },
      fingerprint: () => h.fp,
      notify: async (key, vars) => { h.notes.push({ key, vars }); },
      now: () => new Date(clock),
      log() {},
    },
  };
  return h;
}
const P = (number, deps = [], complete = false) => ({ number, deps, complete, verification: null });
const fresh = () => ({ lane: null, finished: false, halted: false });

test('a launch whose lane record cannot be written counts toward the launch-failure cap', async () => {
  const h = harness({ phases: [P('2')], launch: (id) => id }); // the session never shows up in the list
  // writeLaneStatus fails (its temp file name is taken by a directory); the lane's temp directory, created
  // before the launch, still can be
  fs.mkdirSync(path.join(h.root, '.planning', 'turbo', 'run', `p2.json.tmp-${process.pid}`), { recursive: true });
  let s = fresh();
  for (let i = 0; i < 12 && !s.halted; i++) s = await tick(s, h.ctx);
  assert.equal(s.halted, true);
  assert.equal(h.launched.length, 10);
  assert.equal(h.notes.at(-1).key, 'launchHalted');
  assert.match(h.notes.at(-1).vars.error, /session s\d+ started, then/);
});

test('an untrusted workspace stops the run at the first launch with a clear notification', async () => {
  const h = harness({ phases: [P('2')], launch: () => { throw new Error('claude --bg failed: Workspace not trusted. Run `claude` in /w/app once and accept the trust prompt'); } });
  const s = await tick(fresh(), h.ctx);
  assert.equal(s.halted, true);
  assert.equal(h.launched.length, 1);
  assert.deepEqual(h.notes.map((x) => [x.key, x.vars.dir]), [['workspaceUntrusted', h.root]]);
  for (const lang of ['en', 'ru']) assert.match(msg(lang, 'workspaceUntrusted', { phase: '2', dir: '/w/app' }).body, /\/w\/app.*resume 2/);
});

test('the CLI wrapper carries the untrusted-workspace text, so the supervisor stops at the first launch', async () => {
  const stderr = 'Workspace not trusted. Run `claude` in /w/app once and accept the trust prompt\n';
  const claude = createClaude({ bin: { cmd: 'claude', prefix: [], shell: false }, exec: () => { throw Object.assign(new Error('Command failed: claude --bg'), { status: 1, stderr }); } });
  const opts = { name: 'n', prompt: 'p', systemPrompt: 's', permissionMode: 'auto' };
  assert.throws(() => claude.launchBg(opts, '/w/app'), { message: `claude --bg failed: ${stderr.trim()}` });
  const h = harness({ phases: [P('2')] });
  h.ctx.deps.claude = { ...h.ctx.deps.claude, launchBg: (o, cwd) => claude.launchBg(o, cwd) };
  const s = await tick(fresh(), h.ctx);
  assert.equal(s.halted, true);
  assert.deepEqual(h.notes.map((x) => x.key), ['workspaceUntrusted']);
});

test('a daemon whose lease is gone launches nothing: the tick fails without counting or notifying', async () => {
  const h = harness({ phases: [P('2')] });
  let held = false;
  h.ctx.deps.leaseHeld = () => held;
  const s = await tick(fresh(), h.ctx);
  assert.equal(h.launched.length, 0);
  assert.deepEqual([s.lane, s.halted, s.launchFailures, s.failingSince], [null, false, undefined, undefined]);
  assert.deepEqual(h.notes, []);
  held = true;
  const s2 = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.equal(s2.lane.sessionId, 's1');
  // a relaunch (here a forced one) is skipped the same way and stays armed
  held = false;
  const s3 = await tick({ ...s2, lane: { ...s2.lane, forceRelaunch: true } }, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.equal(s3.lane.forceRelaunch, true);
  assert.equal(s3.launchFailures, undefined);
});
