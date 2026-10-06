import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { writeLaneStatus, readLaneStatus, inferStatus, isAgentAlive } from '../lib/run-status.mjs';

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

test('fresh record "done" without GSD completion is not trusted', () => {
  const rec = { status: 'done', at: later };
  assert.equal(inferStatus({ agent: { state: 'done' }, laneRecord: rec, phase: phase(), launchedAt: T0 }), 'paused-context');
});

test('fresh record with unknown or missing status is ignored', () => {
  const unknown = { status: 'weird', at: later };
  assert.equal(inferStatus({ agent: { state: 'done' }, laneRecord: unknown, phase: phase(), launchedAt: T0 }), 'paused-context');
  const missing = { at: later };
  assert.equal(inferStatus({ agent: { state: 'done' }, laneRecord: missing, phase: phase(), launchedAt: T0 }), 'paused-context');
});

test('missing agent, phase not complete, no record → paused-context', () => {
  assert.equal(inferStatus({ agent: undefined, phase: phase(), launchedAt: T0 }), 'paused-context');
});

test('record written exactly at launch counts as fresh', () => {
  const rec = { status: 'needs-owner', at: T0 };
  assert.equal(inferStatus({ agent: { state: 'done' }, laneRecord: rec, phase: phase(), launchedAt: T0 }), 'needs-owner');
});

test('waiting agent → blocked', () => {
  assert.equal(inferStatus({ agent: { state: 'waiting' }, phase: phase(), launchedAt: T0 }), 'blocked');
});

test('isAgentAlive: true for working/busy/blocked/waiting only', () => {
  for (const state of ['working', 'busy', 'blocked', 'waiting']) assert.equal(isAgentAlive({ state }), true, state);
  for (const state of ['done', 'failed', 'idle', '']) assert.equal(isAgentAlive({ state }), false, state);
  assert.equal(isAgentAlive(undefined), false);
  assert.equal(isAgentAlive({}), false);
});

test('writeLaneStatus accepts an explicit at', () => {
  const r = root();
  const rec = writeLaneStatus(r, '3', 'failed', { at: later });
  assert.equal(rec.at, later);
  assert.equal(readLaneStatus(r, '3').at, later);
  const auto = writeLaneStatus(r, '4', 'done');
  assert.ok(!Number.isNaN(Date.parse(auto.at)));
});
