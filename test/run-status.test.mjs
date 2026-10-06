import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { writeLaneStatus, readLaneStatus, inferStatus } from '../lib/run-status.mjs';

const root = () => { const r = tmpDir('rs'); fs.mkdirSync(path.join(r, '.planning')); return r; };
const phase = (o = {}) => ({ number: '2', complete: false, verification: null, ...o });
const T0 = '2026-01-01T00:00:00.000Z';
const later = '2026-01-01T01:00:00.000Z';

test('write/read lane status round-trip; rejects unknown status', () => {
  const r = root();
  writeLaneStatus(r, '2', 'paused-context', { reason: 'ctx 56%' });
  const rec = readLaneStatus(r, '2');
  assert.equal(rec.status, 'paused-context');
  assert.equal(rec.reason, 'ctx 56%');
  assert.throws(() => writeLaneStatus(r, '2', 'weird'));
  assert.equal(readLaneStatus(r, '9'), null);
});

test('working agent → running; blocked agent → blocked', () => {
  assert.equal(inferStatus({ agent: { state: 'working' }, phase: phase(), launchedAt: T0 }), 'running');
  assert.equal(inferStatus({ agent: { state: 'busy' }, phase: phase(), launchedAt: T0 }), 'running');
  assert.equal(inferStatus({ agent: { state: 'blocked' }, phase: phase(), launchedAt: T0 }), 'blocked');
});

test('finished agent: fresh lane record wins; stale record ignored', () => {
  const fresh = { status: 'needs-owner', at: later };
  assert.equal(inferStatus({ agent: { state: 'done' }, laneRecord: fresh, phase: phase(), launchedAt: T0 }), 'needs-owner');
  const stale = { status: 'done', at: '2025-12-31T00:00:00.000Z' };
  assert.equal(inferStatus({ agent: { state: 'done' }, laneRecord: stale, phase: phase(), launchedAt: T0 }), 'paused-context');
  const running = { status: 'running', at: later };
  assert.equal(inferStatus({ agent: { state: 'done' }, laneRecord: running, phase: phase(), launchedAt: T0 }), 'paused-context');
});

test('missing agent (removed/rebooted) or no state field → inferred from GSD', () => {
  assert.equal(inferStatus({ agent: undefined, phase: phase({ complete: true }), launchedAt: T0 }), 'done');
  assert.equal(inferStatus({ agent: { state: '' }, phase: phase({ verification: 'human_needed' }), launchedAt: T0 }), 'needs-owner');
  assert.equal(inferStatus({ agent: { state: 'failed' }, phase: phase(), launchedAt: T0 }), 'failed');
  assert.equal(inferStatus({ agent: { state: 'done' }, phase: phase(), launchedAt: T0 }), 'paused-context');
});

test('GSD completion beats a stale paused record', () => {
  const rec = { status: 'paused-context', at: later };
  assert.equal(inferStatus({ agent: { state: 'done' }, laneRecord: rec, phase: phase({ complete: true }), launchedAt: T0 }), 'done');
});
