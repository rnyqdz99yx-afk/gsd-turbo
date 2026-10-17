import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED } from './helpers/slots.mjs';
import { buildProject } from './helpers/build-fake.mjs';
import { BUILD_STEPS } from '../lib/build.mjs';
import { runDir, locksDir } from '../lib/paths.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';

const BIN = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));
const HOME = tmpDir('cli-build-home');

function run(root, args, env = {}) {
  const e = { ...ISOLATED, CLAUDE_CONFIG_DIR: HOME, TURBO_LANE: '', TURBO_BUILD_LANE: '', ...env };
  delete e.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [BIN, ...args, '--project', root], { cwd: root, env: e, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const writeState = (root, fields) => {
  fs.mkdirSync(runDir(root), { recursive: true });
  fs.writeFileSync(path.join(runDir(root), 'build-p5.json'), JSON.stringify({ v: 1, phase: '5', round: 0, startedAt: new Date().toISOString(), head0: null, graphSha: null, maxBuilders: 4, edges: [], order: [], red: null, hold: null, slices: {}, step: 'begin', steps: {}, base: null, roundBase: null, gapRounds: 0, info: { name: 'Demo Feature', padded: '05' }, ...fields }));
};

test('build: usage and refusals', () => {
  const p = buildProject();
  for (const args of [['build'], ['build', 'x/y'], ['build', '5', '--bogus']]) {
    const r = run(p.root, args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /usage: turbo-run build <phase> \[--resume\] \[--json\]/);
  }
  const off = buildProject({ config: { build: { enabled: false } } });
  const r1 = run(off.root, ['build', '5']);
  assert.equal(r1.code, 2);
  assert.match(r1.err, /refused: build\.enabled is false; phase 5 runs the lean path \(\/turbo-phase\)/);
  assert.equal(readLaneStatus(off.root, '5'), null);
  const r2 = run(off.root, ['build', '5'], { TURBO_BUILD_LANE: '1' });
  assert.equal(r2.code, 2);
  assert.deepEqual([readLaneStatus(off.root, '5').status, readLaneStatus(off.root, '5').reason], ['failed', 'build refused: build.enabled is false']);
  const r3 = run(p.root, ['build', '5'], { TURBO_LANE: '1' });
  assert.equal(r3.code, 2);
  assert.match(r3.err, /refused: build is the owner's: a lane never runs it/);

  writeState(p.root, { step: 'slice' });
  const r4 = run(p.root, ['build', '5']);
  assert.equal(r4.code, 2);
  assert.match(r4.err, /phase 5 has a build in progress \(step slice\): turbo-run build 5 --resume continues it/);

  const q = buildProject();
  fs.mkdirSync(locksDir(q.root), { recursive: true });
  fs.writeFileSync(path.join(locksDir(q.root), 'build-run-p5.json'), JSON.stringify({ pid: process.pid, token: 'x', startedAt: new Date().toISOString(), beat: new Date().toISOString() }));
  const r5 = run(q.root, ['build', '5']);
  assert.equal(r5.code, 3);
  assert.match(r5.err, new RegExp(`phase 5: a build runs already \\(pid ${process.pid}\\)`));
});

test('build --resume --json prints the outcome', () => {
  const p = buildProject();
  const at = new Date().toISOString();
  writeState(p.root, { step: 'close', steps: Object.fromEntries(BUILD_STEPS.map((s) => [s, { state: 'done', at }])) });
  const r = run(p.root, ['build', '5', '--resume', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { phase: '5', outcome: 'closed', step: 'close', why: '', slices: { total: 0, merged: 0 } });
});
