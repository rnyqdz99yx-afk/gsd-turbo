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

// One process taking the phase lock n times; it counts entries that found another process inside. It prints ready
// once loaded and starts only on the parent's go, so all of them contend from their first entry however slowly the
// machine starts processes; a dot after each entry is its progress. Between entries it pauses a moment, as separate
// callers do: without that the process that just left takes the lock again at once and the others only wait.
const WORKER = `
import fs from 'node:fs';
import path from 'node:path';
const [url, root, n] = process.argv.slice(1);
const { withPhaseLock } = await import(url);
const inside = path.join(root, 'inside');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const errors = {};
let ok = 0;
let overlaps = 0;
process.stdout.write('ready\\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
for (let i = 0; i < Number(n); i++) {
  try {
    withPhaseLock(root, '32', () => {
      try { fs.closeSync(fs.openSync(inside, 'wx')); } catch { overlaps++; return; }
      const t = Date.now();
      while (Date.now() - t < 1) { /* hold */ }
      fs.rmSync(inside, { force: true });
    }, { waitMs: 600000 });
    ok++;
  } catch (e) {
    const k = String(e.code || e.message).slice(0, 60);
    errors[k] = (errors[k] || 0) + 1;
  }
  process.stdout.write('.');
  pause(1);
}
process.stdout.write('\\n' + JSON.stringify({ ok, overlaps, errors }));
`;

// No time limit on the run itself: a loaded machine only makes it slower. A hang is what stops it, no output from any
// worker for STALL_MS (a worker that cannot start, or a lock nobody gets).
test('several processes taking the same phase lock at once: every acquisition succeeds, none overlaps (Review Focus 1)', async () => {
  const root = tmpDir('lock-race');
  fs.mkdirSync(path.join(root, '.planning'));
  const N = 8;
  const n = 40;
  const STALL_MS = 60000;
  let last = Date.now();
  let ready = 0;
  let stalled = false;
  const workers = Array.from({ length: N }, () => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', WORKER, LIB, root, String(n)], { windowsHide: true });
    // ready is read from stdout alone: a warning on stderr first (from NODE_OPTIONS, say) never holds the start
    const w = { c, out: '', stdout: '', ready: false };
    const seen = (d) => {
      w.out += d;
      w.stdout += d;
      last = Date.now();
      if (w.ready || !w.stdout.startsWith('ready\n')) return;
      w.ready = true;
      if (++ready === N) for (const x of workers) x.c.stdin.end('go\n');
    };
    c.stdout.on('data', seen);
    c.stderr.on('data', (d) => { w.out += d; last = Date.now(); });
    c.stdin.on('error', () => {});
    // one that ends before it is ready never gets its go: the others get none either and end at once
    c.on('exit', () => { if (!w.ready) for (const x of workers) x.c.stdin.end(); });
    w.code = new Promise((resolve) => c.on('close', resolve));
    return w;
  });
  const watchdog = setInterval(() => {
    if (Date.now() - last < STALL_MS) return;
    stalled = true;
    for (const w of workers) w.c.kill();
  }, 1000);
  const codes = await Promise.all(workers.map((w) => w.code)).finally(() => clearInterval(watchdog));
  assert.equal(stalled, false, `no worker said anything for ${STALL_MS} ms: ${workers.map((w) => w.out.slice(-300)).join(' | ')}`);
  workers.forEach((w, i) => {
    assert.equal(codes[i], 0, w.out);
    assert.deepEqual(JSON.parse(w.stdout.trim().split('\n').pop()), { ok: n, overlaps: 0, errors: {} });
  });
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

// A stale lock that was swapped for another process's fresh one the moment this process looked at it.
function swappedStaleLock(root) {
  const file = lockFile(root, '32');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'crashed');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
  return file;
}

test('a stale lock that cannot be moved aside is waited on like any lock: give up after waitMs, sleeping between tries', () => {
  const root = tmpDir('spin');
  const file = swappedStaleLock(root);
  const realRename = fs.renameSync;
  const realOpen = fs.openSync;
  let renames = 0;
  let opens = 0;
  fs.renameSync = function (from, ...rest) {
    if (from === file) {
      renames += 1;
      throw Object.assign(new Error('operation not permitted, rename'), { code: 'EPERM' });
    }
    return realRename.call(this, from, ...rest);
  };
  // a spinning loop ends here with an error of its own instead of hanging the test
  fs.openSync = function (p, ...rest) {
    if (p === file && ++opens > 500) throw Object.assign(new Error(`still spinning after ${opens} tries`), { code: 'ESPIN' });
    return realOpen.call(this, p, ...rest);
  };
  const t0 = Date.now();
  try {
    assert.throws(() => withPhaseLock(root, '32', () => {}, { waitMs: 300 }), /locked by another turbo-run/);
  } finally {
    fs.renameSync = realRename;
    fs.openSync = realOpen;
  }
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(renames <= 30, `${renames} renames in ${Date.now() - t0} ms`);
});

test('without hard links a lock moved aside by mistake goes back only where no lock exists: a lock a third process took is never replaced', () => {
  const root = tmpDir('nolink');
  const file = swappedStaleLock(root);
  const realStat = fs.statSync;
  const realLink = fs.linkSync;
  let swapped = false;
  fs.statSync = function (p, ...rest) {
    const st = realStat.call(this, p, ...rest);
    if (!swapped && p === file) {
      swapped = true;
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, 'other-process', { flag: 'wx' });
    }
    return st;
  };
  // no hard links here, and a third process takes the free lock right before the moved one would go back
  fs.linkSync = () => {
    fs.writeFileSync(file, 'third-process', { flag: 'wx' });
    throw Object.assign(new Error('operation not supported, link'), { code: 'ENOTSUP' });
  };
  try {
    assert.throws(() => withPhaseLock(root, '32', () => {}, { waitMs: 200 }), /locked by another turbo-run/);
  } finally {
    fs.statSync = realStat;
    fs.linkSync = realLink;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'third-process');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n !== path.basename(file)), []);
});
