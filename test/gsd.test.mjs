import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { versionInRange, normalizePhases, runGsdJson, readVersion } from '../lib/gsd.mjs';

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
  assert.deepEqual(p.map((x) => x.number), ['1', '2', '2.1', '3']);
  assert.deepEqual(p[1].deps, ['1']);
  assert.deepEqual(p[2].deps, ['2']);
  assert.deepEqual(p[3].deps, ['2', '0']);
  assert.equal(p[0].complete, true);
  assert.equal(p[3].verification, 'human_needed');
  assert.equal(p[0].deps.length, 0);
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
