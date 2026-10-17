import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { acquireSessionSlot, SLOT } from '../lib/headless.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';

const slotFiles = (dir) => fs.readdirSync(dir).filter((n) => /^slot-\d+\.json$/.test(n));
const setMtime = (file, date) => fs.utimesSync(file, date, date);

test('SLOT defaults', () => {
  assert.deepEqual(SLOT, { pollMs: 2000, heartbeatMs: 60000, staleMs: 30 * 60000 });
});

test('at most max slots are held at once; a release lets the next one in', async () => {
  const dir = tmpDir('slots');
  const a = await acquireSessionSlot({ max: 2, dir, pollMs: 20 });
  const b = await acquireSessionSlot({ max: 2, dir, pollMs: 20, label: 'p3 builder 02' });
  assert.deepEqual([a.slot, b.slot], [1, 2]);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'slot-2.json'), 'utf8'));
  assert.deepEqual([rec.pid, rec.label, rec.cwd], [process.pid, 'p3 builder 02', process.cwd()]);
  assert.match(rec.token, new RegExp(`^${process.pid}-`));
  let got = false;
  const c = acquireSessionSlot({ max: 2, dir, pollMs: 20 }).then((r) => { got = true; return r; });
  await sleep(300);
  assert.equal(got, false);
  a();
  const rc = await c;
  assert.equal(rc.slot, a.slot);
  b();
  rc();
  a(); // a second release is a no-op
  assert.deepEqual(slotFiles(dir), []);
});

test('two processes with max 1 never overlap', { timeout: 20000 }, async () => {
  const dir = tmpDir('slots');
  const url = pathToFileURL(path.resolve('lib/headless.mjs')).href;
  const code = `import { acquireSessionSlot } from ${JSON.stringify(url)};
const release = await acquireSessionSlot({ max: 1, dir: ${JSON.stringify(dir)}, pollMs: 20 });
const got = Date.now();
await new Promise((r) => setTimeout(r, 400));
const released = Date.now();
release();
console.log(JSON.stringify([got, released]));`;
  const run = () => new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(JSON.parse(stdout.trim()))));
  });
  const [x, y] = await Promise.all([run(), run()]);
  const [first, second] = x[0] <= y[0] ? [x, y] : [y, x];
  assert.ok(first[1] <= second[0], `intervals overlap: ${JSON.stringify([first, second])}`);
  assert.deepEqual(slotFiles(dir), []);
});

test('a dead holder\'s slot is taken at once', async () => {
  const dir = tmpDir('slots');
  writeJsonAtomic(path.join(dir, 'slot-1.json'), { pid: 2147483644, token: '2147483644-x', at: new Date().toISOString() });
  const t0 = Date.now();
  const r = await acquireSessionSlot({ max: 1, dir, pollMs: 20 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.slot, 1);
  r();
});

test('an unreadable slot file is free', async () => {
  const dir = tmpDir('slots');
  fs.writeFileSync(path.join(dir, 'slot-1.json'), 'not json');
  const r = await acquireSessionSlot({ max: 1, dir, pollMs: 20 });
  assert.equal(r.slot, 1);
  r();
});

test('a slot not refreshed for staleMs is taken even when its pid seems alive; the old holder\'s release leaves it', async () => {
  const dir = tmpDir('slots');
  const old = await acquireSessionSlot({ max: 1, dir, heartbeatMs: 3600000 });
  setMtime(path.join(dir, 'slot-1.json'), new Date(Date.now() - 2 * 3600000));
  const fresh = await acquireSessionSlot({ max: 1, dir, pollMs: 20, alive: () => true, staleMs: 60000 });
  old();
  assert.ok(fs.existsSync(path.join(dir, 'slot-1.json')));
  fresh();
  assert.equal(fs.existsSync(path.join(dir, 'slot-1.json')), false);
});

test('a held slot\'s file is refreshed every heartbeatMs', async () => {
  const dir = tmpDir('slots');
  const r = await acquireSessionSlot({ max: 1, dir, heartbeatMs: 50 });
  const file = path.join(dir, 'slot-1.json');
  setMtime(file, new Date(Date.now() - 3600000));
  await sleep(300);
  assert.ok(Math.abs(fs.statSync(file).mtimeMs - Date.now()) < 1000);
  r();
});

test('a slot file unreadable for a moment does not stop the heartbeat', async () => {
  const dir = tmpDir('slots');
  const r = await acquireSessionSlot({ max: 1, dir, heartbeatMs: 50 });
  const file = path.join(dir, 'slot-1.json');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, 'cut sho');
  await sleep(200);
  fs.writeFileSync(file, text);
  setMtime(file, new Date(Date.now() - 3600000));
  await sleep(300);
  assert.ok(Math.abs(fs.statSync(file).mtimeMs - Date.now()) < 1000, 'the heartbeat stopped');
  r();
  assert.equal(fs.existsSync(file), false);
});

test('a mutex left by a crash is taken over even when its pid is alive (Windows reuses pids); a busy one is waited on', { timeout: 20000 }, async () => {
  const dir = tmpDir('slots');
  const mutex = path.join(dir, '.mutex');
  fs.writeFileSync(mutex, `${process.pid}-left-by-a-crash`);
  setMtime(mutex, new Date(Date.now() - 120000));
  const t0 = Date.now();
  const a = await acquireSessionSlot({ max: 1, dir, pollMs: 20 });
  assert.ok(Date.now() - t0 < 2000);
  a();
  fs.writeFileSync(mutex, `${process.pid}-busy`);
  setTimeout(() => fs.rmSync(mutex, { force: true }), 300);
  const b = await acquireSessionSlot({ max: 1, dir, pollMs: 20 });
  assert.equal(b.slot, 1);
  b();
});

test('max must be an integer of at least 1', async () => {
  const dir = tmpDir('slots');
  for (const max of [0, 1.5, '2', undefined]) await assert.rejects(acquireSessionSlot({ max, dir }), /max/);
});
