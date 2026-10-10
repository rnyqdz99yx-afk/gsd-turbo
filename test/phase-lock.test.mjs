import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';
import { lockFile, withPhaseLock } from '../lib/questions.mjs';

const LIB = pathToFileURL(path.resolve('lib/questions.mjs')).href;

test('the phase lock waits while Windows reports the lock file as being deleted (EPERM, EACCES); elsewhere those errors stay errors', () => {
  const root = tmpDir('lock');
  const file = lockFile(root, '32');
  const real = fs.openSync;
  let fail = 0;
  fs.openSync = function (p, ...rest) {
    if (p === file && fail > 0) {
      fail -= 1;
      throw Object.assign(new Error('operation not permitted, open'), { code: fail % 2 ? 'EPERM' : 'EACCES' });
    }
    return real.call(this, p, ...rest);
  };
  try {
    fail = 4;
    assert.equal(withPhaseLock(root, '32', () => 7, { platform: 'win32' }), 7);
    assert.equal(fail, 0);
    fail = 1;
    assert.throws(() => withPhaseLock(root, '32', () => 7, { platform: 'linux' }), (e) => e.code === 'EACCES');
  } finally {
    fs.openSync = real;
  }
  assert.equal(fs.existsSync(file), false);
});

// One process taking the phase lock n times; it counts entries that found another process inside.
const WORKER = `
import fs from 'node:fs';
import path from 'node:path';
const [url, root, n] = process.argv.slice(1);
const { withPhaseLock } = await import(url);
const inside = path.join(root, 'inside');
const errors = {};
let ok = 0;
let overlaps = 0;
for (let i = 0; i < Number(n); i++) {
  try {
    withPhaseLock(root, '32', () => {
      try { fs.closeSync(fs.openSync(inside, 'wx')); } catch { overlaps++; return; }
      const t = Date.now();
      while (Date.now() - t < 1) { /* hold */ }
      fs.rmSync(inside, { force: true });
    }, { waitMs: 20000 });
    ok++;
  } catch (e) {
    const k = String(e.code || e.message).slice(0, 60);
    errors[k] = (errors[k] || 0) + 1;
  }
}
process.stdout.write(JSON.stringify({ ok, overlaps, errors }));
`;

test('several processes taking the same phase lock at once: every acquisition succeeds, none overlaps (Review Focus 1)', async () => {
  const root = tmpDir('lock-race');
  fs.mkdirSync(path.join(root, '.planning'));
  const N = 8;
  const n = 200;
  const runs = await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', WORKER, LIB, root, String(n)], { windowsHide: true, timeout: 90000, killSignal: 'SIGKILL' });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  })));
  for (const r of runs) {
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(r.out), { ok: n, overlaps: 0, errors: {} });
  }
});

test('a stale lock is taken over by one process only: a lock another process took meanwhile is put back, never removed', () => {
  const root = tmpDir('steal');
  const file = lockFile(root, '32');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'crashed');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
  // the moment this process looks at the stale lock, another one takes it over and holds a fresh lock of its own
  const realStat = fs.statSync;
  let other = false;
  fs.statSync = function (p, ...rest) {
    const st = realStat.call(this, p, ...rest);
    if (!other && p === file) {
      other = true;
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, 'other-process', { flag: 'wx' });
    }
    return st;
  };
  let ran = false;
  try {
    assert.throws(() => withPhaseLock(root, '32', () => { ran = true; }, { waitMs: 200 }), /locked by another turbo-run/);
  } finally {
    fs.statSync = realStat;
  }
  assert.equal(ran, false, 'never inside while the other process holds the lock');
  assert.equal(fs.readFileSync(file, 'utf8'), 'other-process', "the other process's lock stays");
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n !== path.basename(file)), [], 'nothing left aside');
});

test('a release removes only its own lock: one a stealer put in its place stays', () => {
  const root = tmpDir('own');
  const file = lockFile(root, '32');
  withPhaseLock(root, '32', () => {
    fs.rmSync(file);
    fs.writeFileSync(file, 'stealer');
  });
  assert.equal(fs.readFileSync(file, 'utf8'), 'stealer');
});
