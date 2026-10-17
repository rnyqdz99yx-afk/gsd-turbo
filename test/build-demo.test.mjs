import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';
import { gsdCoreDir } from '../lib/paths.mjs';
import { readVersion, versionInRange } from '../lib/gsd.mjs';

// scripts/build-demo.mjs (Stage 6 B4, spec §6.11 item 1): its --dry-run makes the scratch project and starts no claude;
// the live run is the controller's manual step.
const SCRIPT = fileURLToPath(new URL('../scripts/build-demo.mjs', import.meta.url));
const core = gsdCoreDir(null);
const SKIP = { skip: !(core && versionInRange(readVersion(core) || '')) && 'GSD 1.16/1.17 is not installed', timeout: 120000 };
const tool = (dir, ...args) => {
  const r = spawnSync(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), ...args, '--cwd', dir], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(r.stdout.slice(r.stdout.search(/[{[]/)));
};

test('build-demo --dry-run makes the two-phase project and builds nothing', SKIP, () => {
  const dir = path.join(tmpDir('demo'), 'project');
  const run = (...a) => spawnSync(process.execPath, [SCRIPT, '--dry-run', '--dir', dir, ...a], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.equal(lines.at(-1), `DRY ${dir}: 2 phases, ready to build`);
  assert.equal(lines.some((l) => /^build \d/.test(l)), false, 'no build started');
  assert.equal(fs.existsSync(dir), false, 'removed without --keep');

  const kept = run('--keep');
  assert.equal(kept.status, 0, kept.stderr);
  const phases = tool(dir, 'init', 'manager').phases.map((p) => String(p.number));
  assert.deepEqual(phases.filter((n) => n === '1' || n === '2'), ['1', '2']);
  assert.equal(tool(dir, 'init', 'phase-op', '1').has_context, true);
  assert.ok(fs.existsSync(path.join(dir, 'test', 'contract.test.js')));
});
