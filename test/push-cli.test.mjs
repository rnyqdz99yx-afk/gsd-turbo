import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', windowsHide: true });

function writeConfig(root, obj) {
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify(obj));
}

test('a bad push setting stops status and start with one config line and exit 1 (S2)', () => {
  const root = tmpDir('pushcfg');
  writeConfig(root, { push: { mode: 'after_wave' } });
  for (const args of [['status'], ['start']]) {
    const r = cli(args, root);
    assert.equal(r.status, 1, args[0]);
    assert.equal(r.stderr.trim(), 'invalid turbo config push.mode: must be one of off, after-wave, after-phase');
  }
});
