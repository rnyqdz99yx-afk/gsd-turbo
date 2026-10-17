import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ISOLATED } from './helpers/slots.mjs';
import { finishPhase, laneProject } from './helpers/lane-merge.mjs';
import { IntegrateRefused, integrateMain, readyRecord } from '../lib/integrate.mjs';
import { LANE_STATUSES, readLaneStatus } from '../lib/run-status.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { requestFile } from '../lib/push.mjs';
import { formatInboxMessage } from '../lib/inbox.mjs';

const BIN = path.resolve('bin/turbo-run.mjs');

test('lane-status N ready --base writes the record the supervisor reads, in the control root; a fix after integrating is fine', () => {
  // reconcile R11: L1 added ready (with prepped and annotated)
  assert.ok(LANE_STATUSES.includes('ready'));
  const p = laneProject();
  finishPhase(p);
  const r = integrateMain(p.slot, '3', { git: p.git });
  p.writeSlot('src/fix.js', 'export const fix = 1;\n');
  const head = p.commitSlot('fix: red after the merge');
  assert.deepEqual(readyRecord(p.slot, '3', { base: r.base, git: p.git }), { base: r.base, head, branch: 'turbo/p3', slot: 1 });
  const out = execFileSync(process.execPath, [BIN, 'lane-status', '3', 'ready', '--base', r.base, '--reason', 'integrated', '--project', p.slot], { env: ISOLATED, encoding: 'utf8' });
  assert.equal(out, `lane 3: ready (base ${r.base.slice(0, 12)}, head ${head.slice(0, 12)}); the supervisor merges it into main\n`);
  const rec = readLaneStatus(p.root, '3');
  assert.deepEqual({ ...rec, at: 'x' }, { base: r.base, head, branch: 'turbo/p3', slot: 1, phase: '3', status: 'ready', reason: 'integrated', sessionId: '', at: 'x' });
});

test('ready refuses what the supervisor must not merge, naming why, and writes nothing', () => {
  const p = laneProject();
  finishPhase(p);
  const refused = (root, base, re) => assert.throws(() => readyRecord(root, '3', { base, git: p.git }), (e) => e instanceof IntegrateRefused && re.test(e.message));
  refused(p.slot, '', /--base needs the full 40-hex sha that turbo-run integrate printed/);
  refused(p.slot, p.inMain('rev-parse', 'HEAD'), /is not the base of the last finished turbo-run integrate 3: run turbo-run integrate 3 first/);
  const r = integrateMain(p.slot, '3', { git: p.git });
  refused(p.slot, r.base.slice(0, 12), /40-hex/);
  p.writeSlot('src/feature.js', 'changed\n');
  refused(p.slot, r.base, /uncommitted changes: src\/feature\.js/);
  p.inSlot('checkout', '--', 'src/feature.js');
  p.inSlot('checkout', '-q', '-b', 'side');
  refused(p.slot, r.base, /the slot is on side, not on turbo\/p3/);
  p.inSlot('checkout', '-q', 'turbo/p3');
  refused(p.root, r.base, /lane-status ready is for a lane in a slot/);
  const res = spawnSync(process.execPath, [BIN, 'lane-status', '3', 'ready', '--project', p.slot], { env: ISOLATED, encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /^refused: --base needs the full 40-hex sha/);
  assert.equal(readLaneStatus(p.root, '3'), null);
});

test('push-request in a slot files nothing: the supervisor pushes main after the merge (spec §7.3); push off keeps its line', async () => {
  const p = laneProject({ config: { push: { mode: 'after-wave', ci: 'none' } } });
  const lines = [];
  const run = (root, ...a) => runPhaseCommand('push-request', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  assert.equal(await run(p.slot, '3', '--at', 'wave'), 0);
  assert.equal(lines.at(-1), 'push in slots: nothing requested at a wave; the supervisor pushes main after it merges this phase');
  for (const args of [['--at', 'phase', '--wait'], ['--wait'], []]) {
    assert.equal(await run(p.slot, '3', ...args), 0);
    assert.equal(lines.at(-1), 'push in slots: nothing requested; the supervisor merges this phase in step integrate and pushes main');
  }
  assert.equal(fs.existsSync(requestFile(p.slot, '3')), false);
  const q = laneProject();
  assert.equal(await run(q.slot, '3', '--at', 'phase'), 0);
  assert.match(lines.at(-1), /^push off: nothing requested/);
});

test('the inbox prints a reintegrate message with what moved and what to do', () => {
  const text = formatInboxMessage({ kind: 'reintegrate', base: 'a'.repeat(40), was: 'b'.repeat(40), round: 2, of: 3, seq: 4, at: 'x' }, { phase: '3', ciFixRounds: 2 });
  assert.equal(text, `reintegrate · main moved to ${'a'.repeat(12)} after your base ${'b'.repeat(12)} (round 2 of 3)\n  run step integrate again: turbo-run phase-step 3 prints next integrate`);
});
