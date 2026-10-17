import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { tick } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { freshLanes, lanesHarness, P as LP } from './helpers/lanes.mjs';

// lane temp directories live under turbo's own directory: a throwaway Claude home for the whole test file
process.env.CLAUDE_CONFIG_DIR = tmpDir('lean-home');

// The checkout-mode harness of test/lane-mode.test.mjs: one lane in this checkout, claude faked, launches recorded.
function harness({ phases, mode = 'full' }) {
  const root = tmpDir('sup-lean');
  fs.mkdirSync(path.join(root, '.planning'));
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const h = { root, phases, agents: [], launched: [], notes: [], order: [], fp: 'A', advance(min) { clock += min * 60000; } };
  let n = 0;
  h.ctx = {
    root, mode, config: structuredClone(DEFAULTS), turboRun: 'node x',
    deps: {
      loadPhases: () => h.phases,
      claude: {
        launchBg: (o) => {
          const id = `s${++n}`;
          h.launched.push({ id, ...o });
          h.order.push(`launch ${h.phases.find((p) => o.prompt.includes(`arguments: ${p.number}`))?.number}`);
          h.agents.push({ id, name: o.name, state: 'working', cwd: root });
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
const P = (number, deps = [], complete = false, verification = null) => ({ number, deps, complete, verification });
const fresh = () => ({ lane: null, finished: false, halted: false });

test('a lane launches with lanes.effort: high by default, the configured value otherwise', async () => {
  const h = harness({ phases: [P('2')] });
  await tick(fresh(), h.ctx);
  assert.equal(h.launched[0].effort, 'high');
  const m = harness({ phases: [P('2')] });
  m.ctx.config.lanes.effort = 'medium';
  await tick(fresh(), m.ctx);
  assert.equal(m.launched[0].effort, 'medium');
});

test('checkout mode: leanBoundary runs for the phase right before its launch, and before a relaunch', async () => {
  const h = harness({ phases: [P('2')] });
  h.ctx.deps.leanBoundary = (phase) => {
    h.order.push(`lean ${phase}`);
    return { applied: false, why: 'current' };
  };
  let s = await tick(fresh(), h.ctx);
  assert.deepEqual(h.order, ['lean 2', 'launch 2']);
  // a relaunch (resume N --start): the old session gone
  s.lane.forceRelaunch = true;
  h.agents = [];
  s = await tick(s, h.ctx);
  assert.deepEqual(h.order, ['lean 2', 'launch 2', 'lean 2', 'launch 2']);
  // a dep that throws is logged and never stops the launch
  const t2 = harness({ phases: [P('3')] });
  const logs = [];
  t2.ctx.deps.log = (l) => logs.push(l);
  t2.ctx.deps.leanBoundary = () => { throw new Error('lean broke\nmore'); };
  await tick(fresh(), t2.ctx);
  assert.equal(t2.launched.length, 1);
  assert.ok(logs.includes('lean: lean broke'), logs.join('\n'));
});

test('slots mode: leanBoundary runs before the slot is prepared; no call without the dep', async () => {
  const h = lanesHarness({ phases: [LP('1')] });
  const order = [];
  const prepare = h.ctx.deps.slots.prepare;
  h.ctx.deps.slots.prepare = (slot, job) => {
    order.push(`prepare ${job.phase}`);
    return prepare(slot, job);
  };
  h.ctx.deps.leanBoundary = (phase) => {
    order.push(`lean ${phase}`);
    return { applied: true, why: null };
  };
  await tick(freshLanes(), h.ctx);
  assert.deepEqual(order, ['lean 1', 'prepare 1']);
  assert.equal(h.launched.length, 1);
  // the slot lane's own launch (startLane with a control root) runs no boundary: the slot took the commit
  assert.equal(order.filter((x) => x.startsWith('lean')).length, 1);
  const plain = lanesHarness({ phases: [LP('1')] });
  await tick(freshLanes(), plain.ctx);
  assert.equal(plain.launched.length, 1);
});
