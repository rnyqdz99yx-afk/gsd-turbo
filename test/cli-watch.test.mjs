import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');

// Runs turbo-run status --watch until its output holds n frames, then stops it.
function watchFrames(cwd, n) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'status', '--watch'], { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('home') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const guard = setTimeout(() => { child.kill(); reject(new Error(`no ${n} frames in 15 s: ${JSON.stringify(out)}`)); }, 15000);
    child.stdout.on('data', (d) => {
      out += d;
      if ((out.match(/^updated /gm) || []).length >= n) {
        clearTimeout(guard);
        child.kill();
        resolve(out);
      }
    });
    child.on('error', reject);
  });
}

test('turbo-run status --watch redraws the view every view.refresh_seconds until stopped; a pipe gets no escape codes', async () => {
  const root = tmpGitRepo();
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ view: { refresh_seconds: 1 } }));
  const out = await watchFrames(root, 2);
  assert.equal((out.match(/^supervisor: not running \(never started\)$/gm) || []).length, 2);
  assert.match(out, /^updated \d\d:\d\d:\d\d · every 1 s · Ctrl\+C stops$/m);
  assert.equal(out.includes('\x1b['), false);
});
