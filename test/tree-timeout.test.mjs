import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpDir } from './helpers/tmp.mjs';

const TREE = path.resolve('lib/tree-timeout.mjs');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('the time limit ends the whole process tree, not only the command', async () => {
  const pidFile = path.join(tmpDir('tree'), 'grandchild.pid');
  // the command starts a grandchild (as git starts a pre-push hook, ssh or a remote helper), then both wait
  const grand = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
  const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grand)}], { stdio: 'ignore' }); setTimeout(() => {}, 60000);`;
  const r = spawnSync(process.execPath, [TREE, '2000', process.execPath, '-e', child], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(r.status, 124, r.stderr);
  assert.match(r.stderr, /turbo: timed out/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 50 && alive(pid); i++) await delay(100);
  assert.equal(alive(pid), false, `grandchild ${pid} survived the time limit`);
});

test('within the time limit the command\'s status, stdout and stderr pass through', () => {
  const r = spawnSync(process.execPath, [TREE, '30000', process.execPath, '-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], { encoding: 'utf8', windowsHide: true });
  assert.deepEqual([r.status, r.stdout, r.stderr], [3, 'out', 'err']);
});
