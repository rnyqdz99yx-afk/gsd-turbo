import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');

// A view change: a supervisor that ran once and is gone ("Run — supervisor not running").
const stopSupervisor = (root) => fs.writeFileSync(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), JSON.stringify({ pid: 2147483644, updatedAt: new Date(Date.now() - 2 * 3600000).toISOString() }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs turbo-run status --watch: after its first frame waits a few reads, changes the view, and stops it at the second
// frame.
function watchFrames(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'status', '--watch'], { cwd: root, env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('home') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const guard = setTimeout(() => { child.kill(); reject(new Error(`no 2 frames in 15 s: ${JSON.stringify(out)}`)); }, 15000);
    child.stdout.on('data', async (d) => {
      out += d;
      const frames = (out.match(/^updated /gm) || []).length;
      if (frames === 1 && !child.changed) {
        child.changed = true;
        await sleep(2500);
        stopSupervisor(root);
      }
      if (frames >= 2) {
        clearTimeout(guard);
        child.kill();
        resolve(out);
      }
    });
    child.on('error', reject);
  });
}

test('turbo-run status --watch reads every view.refresh_seconds until stopped; into a pipe it prints a frame only when the view changed, with no escape codes', async () => {
  const root = tmpGitRepo();
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ view: { refresh_seconds: 1 } }));
  const out = await watchFrames(root);
  assert.equal((out.match(/^Run — supervisor never started$/gm) || []).length, 1, 'the unchanged reads printed nothing');
  assert.equal((out.match(/^Run — supervisor not running$/gm) || []).length, 1);
  assert.match(out, /^updated \d\d:\d\d:\d\d · every 1 s · Ctrl\+C stops$/m);
  assert.equal(out.includes('\x1b['), false);
});

test('turbo-run status --watch into a pipe that closes (| head) exits 0 without a stack trace', async () => {
  const root = tmpGitRepo();
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ view: { refresh_seconds: 1 } }));
  const child = spawn(process.execPath, [CLI, 'status', '--watch'], { cwd: root, env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('home') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const closed = new Promise((resolve, reject) => {
    const guard = setTimeout(() => { child.kill(); reject(new Error(`still running 15 s after its pipe closed; stderr: ${err}`)); }, 15000);
    child.on('close', (code) => { clearTimeout(guard); resolve(code); });
  });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.stdout.destroy();
  // the next frame differs, so the watch writes it into the closed pipe
  stopSupervisor(root);
  assert.equal(await closed, 0, err);
  assert.equal(err, '');
});
