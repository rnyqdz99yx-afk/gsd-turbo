import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { writeBuildPhase4 } from './fixtures/cost.mjs';
import { GAP_CAP_MS, IEU_WEIGHTS, ieuOf, phaseCost, recordSessionUsage } from '../lib/cost.mjs';

const U = { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 };

test('ieuOf weighs input 1, cache write 1.25 (the 1h cache too), cache read 0.1, output 5', () => {
  assert.equal(ieuOf(U), 1600);
  assert.equal(ieuOf({ ...U, cache_creation: { ephemeral_1h_input_tokens: 1000 } }), 1600);
  assert.equal(ieuOf({}), 0);
  assert.deepEqual(IEU_WEIGHTS, { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
  assert.equal(GAP_CAP_MS, 300000);
});

test('recordSessionUsage appends one record per session to run/cost-p<N>.json', () => {
  const run = path.join(tmpDir('cost'), 'run');
  const now = new Date('2026-10-17T12:00:00Z');
  const at = '2026-10-17T12:00:00.000Z';
  const r1 = recordSessionUsage(run, '04', { step: 'build', role: 'builder', sessionId: 's-1', usage: U, wallMs: 1000 }, { now });
  recordSessionUsage(run, '04', { step: 'review', role: 'fixer', usage: { output_tokens: 7 }, wallMs: 0 }, { now });
  assert.deepEqual(r1, { step: 'build', role: 'builder', sessionId: 's-1', usage: U, wallMs: 1000, at });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, 'cost-p4.json'), 'utf8')), {
    v: 1,
    phase: '4',
    sessions: [
      { step: 'build', role: 'builder', sessionId: 's-1', usage: U, wallMs: 1000, at },
      { step: 'review', role: 'fixer', sessionId: null, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 }, wallMs: 0, at },
    ],
  });
});

test('recordSessionUsage refuses a bad record, naming the field', () => {
  const run = path.join(tmpDir('cost'), 'run');
  const ok = { step: 'build', role: 'builder', sessionId: 's-1', usage: U, wallMs: 1 };
  const bad = (phase, rec, re) => assert.throws(() => recordSessionUsage(run, phase, { ...ok, ...rec }), (e) => e instanceof TypeError && re.test(e.message));
  bad('4', { usage: { ...U, output_tokens: -1 } }, /usage\.output_tokens/);
  bad('4', { step: 'a b' }, /step/);
  bad('4', { wallMs: NaN }, /wallMs/);
  bad('../x', {}, /phase/);
  bad('4', { sessionId: 'x/y' }, /sessionId/);
  assert.equal(fs.existsSync(run), false, 'no file is written');
});

test('a cost file that does not parse counts as empty', () => {
  const run = path.join(tmpDir('cost'), 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'cost-p4.json'), 'not json');
  recordSessionUsage(run, '4', { step: 'build', role: 'builder', usage: U, wallMs: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'cost-p4.json'), 'utf8')).sessions.length, 1);
});

test('phaseCost of a build phase: rows by step and role, wall clock as the union of the sessions', () => {
  const root = tmpDir('cost-b');
  writeBuildPhase4(root);
  const cost = phaseCost({ root, phase: '4', env: { CLAUDE_CONFIG_DIR: tmpDir('cost-home') } });
  assert.deepEqual(cost.rows, [
    { step: 'slice', role: 'slicer', sessions: 1, wallMs: 300000, out: 3000, inCreate: 21000, cacheRead: 50000, ieu: 46000 },
    { step: 'build', role: 'builder', sessions: 2, wallMs: 900000, out: 8000, inCreate: 21000, cacheRead: 200000, ieu: 86000 },
    { step: 'review', role: 'fixer', sessions: 1, wallMs: 120000, out: 1000, inCreate: 1130, cacheRead: 10000, ieu: 7380 },
  ]);
  assert.deepEqual(cost.total, { sessions: 4, wallMs: 1020000, out: 12000, inCreate: 43130, cacheRead: 260000, ieu: 139380 });
  assert.deepEqual(cost.steps, [{ step: 'slice', wallMs: 300000, ieu: 46000 }, { step: 'build', wallMs: 600000, ieu: 86000 }, { step: 'review', wallMs: 120000, ieu: 7380 }]);
  assert.equal(cost.slices, 2);
  assert.equal(cost.fixRounds, 1);
  assert.deepEqual(cost.sources, { lane: 0, build: 4 });
  assert.equal(cost.phase, '4');
});
