import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { acquireGate, gateDeclaredBy, gateFile, heldGates, readGate, releaseGate, releaseGatesOf } from '../lib/gate-locks.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, TURBO_CONTROL_ROOT: '' } });
const T0 = '2026-01-01T00:00:00.000Z';
function project(config = null) {
  const root = tmpDir('gates');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  if (config) fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify(config));
  return root;
}

test('acquireGate / releaseGate: one phase holds a gate; another waits, polling, then gets it once released; another phase never unlocks it', async () => {
  const root = project();
  assert.deepEqual(await acquireGate(root, 'prod-deploy', '3', { stamp: () => T0 }), { acquired: true, already: false });
  assert.deepEqual(readGate(root, 'prod-deploy'), { gate: 'prod-deploy', phase: '3', at: T0 });
  assert.deepEqual(await acquireGate(root, 'prod-deploy', '3'), { acquired: true, already: true });
  let clock = 0;
  const sleeps = [];
  const r = await acquireGate(root, 'prod-deploy', '4', { waitMs: 5000, stepMs: 2000, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  assert.deepEqual(r, { acquired: false, holder: { phase: '3', at: T0, by: 'lock' } });
  assert.deepEqual(sleeps, [2000, 2000, 1000]);
  assert.deepEqual(releaseGate(root, 'prod-deploy', '4'), { released: false, why: 'other', holder: '3' });
  clock = 0;
  const got = await acquireGate(root, 'prod-deploy', '4', { waitMs: 10000, now: () => clock, sleep: async (ms) => { clock += ms; releaseGate(root, 'prod-deploy', '3'); } });
  assert.deepEqual(got, { acquired: true, already: false });
  assert.equal(readGate(root, 'prod-deploy').phase, '4');
  assert.deepEqual(releaseGate(root, 'prod-deploy', '4'), { released: true });
  assert.deepEqual(releaseGate(root, 'prod-deploy', '4'), { released: false, why: 'not-held' });
  await assert.rejects(acquireGate(root, '../x', '4'), /invalid gate name/);
});

test('a gate another running phase declares is held by its lane; heldGates lists the locks, a broken one held by nobody known; releaseGatesOf frees one phase\'s', async () => {
  const root = project();
  const sup = { lanes: { 3: { job: 'phase', phase: '3', gates: ['prod-deploy'] }, 'prep-5': { job: 'prep', phase: '5', gates: ['owner-live'] } } };
  assert.equal(gateDeclaredBy(sup, 'prod-deploy', '4'), '3');
  assert.equal(gateDeclaredBy(sup, 'prod-deploy', '3'), null, 'its own declaration');
  assert.equal(gateDeclaredBy(sup, 'owner-live', '4'), null, 'a job declares no gates');
  assert.equal(gateDeclaredBy(null, 'prod-deploy', '4'), null);
  assert.deepEqual(await acquireGate(root, 'prod-deploy', '4', { declaredBy: (g) => gateDeclaredBy(sup, g, '4') }), { acquired: false, holder: { phase: '3', at: null, by: 'lane' } });
  assert.equal(fs.existsSync(gateFile(root, 'prod-deploy')), false, 'no lock file is written while a lane holds the gate');
  await acquireGate(root, 'owner-live', '3', { stamp: () => T0 });
  await acquireGate(root, 'packaged-build', '4', { stamp: () => T0 });
  fs.writeFileSync(gateFile(root, 'owner-signature'), '{"gate":');
  assert.deepEqual(heldGates(root), [
    { gate: 'owner-live', phase: '3', at: T0 },
    { gate: 'owner-signature', phase: null, at: null },
    { gate: 'packaged-build', phase: '4', at: T0 },
  ]);
  assert.deepEqual(releaseGatesOf(root, '3'), ['owner-live']);
  assert.deepEqual(releaseGate(root, 'owner-signature', '9'), { released: true }, 'a broken lock file goes for anyone');
  assert.deepEqual(heldGates(root).map((g) => g.gate), ['packaged-build']);
  assert.deepEqual(heldGates(project()), []);
});

test('turbo-run lock / unlock: lines and exit codes (0 taken, 3 timed out, 1 another phase\'s, 2 usage or unknown gate)', () => {
  const root = project({ notify: { desktop: false, telegram: false }, lanes: { mode: 'checkout', gates: ['db-migrate'] } });
  let r = cli(['lock', 'db-migrate', '3'], root);
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'locked db-migrate for phase 3'], r.stderr);
  r = cli(['lock', 'db-migrate', '03'], root);
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'db-migrate is already held by phase 3']);
  r = cli(['lock', 'db-migrate', '4', '--wait-seconds', '0'], root);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^gate db-migrate is held by phase 3 since \S+ \(lock\); waited 0 s$/m);
  r = cli(['unlock', 'db-migrate', '4'], root);
  assert.deepEqual([r.status, r.stderr.trim()], [1, 'gate db-migrate is held by phase 3, not 4; nothing changed']);
  r = cli(['unlock', 'db-migrate', '3'], root);
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'unlocked db-migrate']);
  r = cli(['unlock', 'db-migrate', '3'], root);
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'db-migrate is not locked']);
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), { lanesMode: 'slots', lanes: { 5: { key: '5', job: 'phase', phase: '5', gates: ['prod-deploy'] } } });
  r = cli(['lock', 'prod-deploy', '4', '--wait-seconds', '0'], root);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^gate prod-deploy is held by phase 5 since unknown \(declared by its lane\); waited 0 s$/m);
  for (const args of [['lock', 'nope', '3'], ['lock', 'prod-deploy'], ['lock', 'prod-deploy', '3', '--wait-seconds', 'x'], ['unlock']]) {
    assert.equal(cli(args, root).status, 2, args.join(' '));
  }
  assert.match(cli(['lock', 'nope', '3'], root).stderr, /^unknown gate nope \(known: prod-deploy, owner-live, owner-signature, packaged-build, db-migrate; add your own in lanes\.gates\)$/m);
});
