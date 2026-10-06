import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import {
  versionInRange, normalizePhases, runGsdJson, readVersion, normalizePhaseId, isSentinelPhase,
} from '../lib/gsd.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/init-manager.json', import.meta.url), 'utf8'));

test('versionInRange', () => {
  assert.equal(versionInRange('1.16.0'), true);
  assert.equal(versionInRange('1.16.9'), true);
  assert.equal(versionInRange('1.17.0'), false);
  assert.equal(versionInRange('1.15.4'), false);
  assert.equal(versionInRange('garbage'), false);
});

test('normalizePhases maps deps from dep_phases or deps_display', () => {
  const p = normalizePhases(fixture);
  const by = Object.fromEntries(p.map((x) => [x.number, x]));
  assert.deepEqual(p.map((x) => x.number), ['1', '2', '2A', '2.1', '3', '4']);
  assert.deepEqual(by['2'].deps, ['1']);
  assert.deepEqual(by['2.1'].deps, ['2']);
  assert.deepEqual(by['3'].deps, ['2', '0']);
  assert.equal(by['1'].complete, true);
  assert.equal(by['3'].verification, 'human_needed');
  assert.equal(by['1'].deps.length, 0);
});

test('normalizePhases normalizes ids so deps match phase numbers', () => {
  const by = Object.fromEntries(normalizePhases(fixture).map((x) => [x.number, x]));
  assert.deepEqual(by['2A'].deps, ['1']);
  assert.deepEqual(by['4'].deps, ['2A', '3']);
});

test('normalizePhases drops backlog/icebox sentinel phases', () => {
  const numbers = normalizePhases(fixture).map((x) => x.number);
  assert.equal(numbers.includes('999.1'), false);
});

test('normalizePhaseId strips leading zeros and upper-cases the letter per segment', () => {
  assert.equal(normalizePhaseId('01'), '1');
  assert.equal(normalizePhaseId('2a'), '2A');
  assert.equal(normalizePhaseId('03.01'), '3.1');
  assert.equal(normalizePhaseId('12A.2'), '12A.2');
  assert.equal(normalizePhaseId(7), '7');
  assert.equal(normalizePhaseId('CK-01'), 'CK-01');
});

test('isSentinelPhase mirrors the GSD legacy leading-int rule (0 and 999)', () => {
  for (const id of ['999', '999.1', '0999.2', '0', '00', '0.5', 'CK-999.1']) assert.equal(isSentinelPhase(id), true, id);
  for (const id of ['1', '09', '10', '99', '1999', '2A', 'x']) assert.equal(isSentinelPhase(id), false, id);
});

test('runGsdJson names the gsd-tools args when stdout JSON is invalid', () => {
  const exec = () => '{"ok":tru';
  assert.throws(() => runGsdJson('/core', ['init', 'manager'], { cwd: '/proj', exec }), /gsd-tools init manager/);
});

test('runGsdJson strips leading non-JSON noise and passes --raw and --cwd', () => {
  let seen;
  const exec = (cmd, args, opts) => { seen = { cmd, args, opts }; return 'warning: x\n{"ok":true}\n'; };
  const out = runGsdJson('/core', ['init', 'manager'], { cwd: '/proj', exec });
  assert.deepEqual(out, { ok: true });
  assert.equal(seen.cmd, process.execPath);
  assert.deepEqual(seen.args.slice(-4), ['manager', '--raw', '--cwd', '/proj']);
});

test('readVersion reads VERSION file', () => {
  const core = tmpDir('core');
  fs.writeFileSync(path.join(core, 'VERSION'), '1.16.0\n');
  assert.equal(readVersion(core), '1.16.0');
  assert.equal(readVersion(path.join(core, 'nope')), null);
});
