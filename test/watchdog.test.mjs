import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { writeOwnerStop } from '../lib/autostart.mjs';
import { silentDeath, watchSupervisor } from '../lib/watchdog.mjs';

// The supervisor's watchdog: a daemon that died without an exit line (a crash, a reboot, a killed process) is told to the
// owner once, by whoever sees it first: the owner's view on the mod's clock, or a lane at its inbox, ask or lane-status.
const NOW = Date.parse('2026-10-14T13:00:00.000Z');
const BEAT = '2026-10-14T12:20:10.000Z';
const going = { pid: 40164, updatedAt: BEAT, finished: false, halted: false, lane: { phase: '33', sessionId: 's' } };
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function project(name = 'my-app') {
  const root = path.join(tmpDir('wd'), name);
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  return root;
}
function spy(root, extra = {}) {
  const sent = [];
  const logged = [];
  const deps = { config: { lang: 'en' }, by: 'the owner\'s view', now: NOW, uptimeSeconds: 30 * 24 * 3600, notify: async (m) => { sent.push(m); }, log: (l) => logged.push(l), ...extra };
  return { sent, logged, watch: (sup, alive = false) => watchSupervisor(root, { sup, alive, ...deps }) };
}
const mark = (root) => path.join(root, '.planning', 'turbo', 'run', 'supervisor-down.json');

test('a silent death is a recorded pid whose daemon does not run, in a run that was going', () => {
  assert.deepEqual(silentDeath({ sup: going, alive: false, ownerStop: null }), { pid: 40164, since: BEAT });
  assert.equal(silentDeath({ sup: going, alive: true, ownerStop: null }), null, 'it runs');
  assert.equal(silentDeath({ sup: null, alive: false, ownerStop: null }), null, 'never started, or unreadable');
  // an exit, a stop, a resume or a lost lease clears the pid: those say so themselves
  assert.equal(silentDeath({ sup: { ...going, pid: null }, alive: false, ownerStop: null }), null);
  assert.equal(silentDeath({ sup: { ...going, pid: 'x' }, alive: false, ownerStop: null }), null);
  assert.equal(silentDeath({ sup: { ...going, finished: true }, alive: false, ownerStop: null }), null);
  assert.equal(silentDeath({ sup: { ...going, halted: true }, alive: false, ownerStop: null }), null);
  assert.equal(silentDeath({ sup: going, alive: false, ownerStop: { at: BEAT } }), null, 'the owner stopped it');
});

test('a running supervisor, a finished run or the owner\'s stop: nothing told, nothing written', async () => {
  const root = project();
  const s = spy(root);
  assert.equal(await s.watch(going, true), null);
  assert.equal(await s.watch({ ...going, finished: true }), null);
  assert.equal(await s.watch(null), null);
  writeOwnerStop(root);
  assert.equal(await s.watch(going), null);
  assert.deepEqual([s.sent, s.logged], [[], []]);
  assert.equal(fs.existsSync(mark(root)), false);
});

test('a dead supervisor is told to the owner once per dead daemon, with a log line; every caller gets the line', async () => {
  const root = project('my-app');
  const s = spy(root);
  const first = await s.watch(going);
  assert.equal(first.told, true);
  assert.match(first.line, /^warn: the supervisor is not running \(pid 40164, last check-in 2026-10-14T12:20:10\.000Z\); the owner is told\. Go on: only the owner starts it$/);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].title, 'The supervisor stopped');
  assert.match(s.sent[0].body, new RegExp(`^The supervisor of my-app has not run since ${hhmm(BEAT)} and left no exit line`));
  assert.match(s.sent[0].body, /To start it again: \/turbo-autonomous in my-app\. Log: \.planning\/turbo\/logs\/supervisor\.log$/);
  assert.deepEqual(s.logged, ['watchdog: supervisor pid 40164 has not checked in since 2026-10-14T12:20:10.000Z and left no exit line; owner told (seen by the owner\'s view)']);
  assert.equal(JSON.parse(fs.readFileSync(mark(root), 'utf8')).pid, 40164);
  // the next look (another lane, the next clock tick) tells nobody again
  const again = await s.watch(going);
  assert.equal(again.told, false);
  assert.match(again.line, /the owner was told\. Go on: only the owner starts it$/);
  assert.equal(s.sent.length, 1);
  assert.equal(s.logged.length, 1);
  // a later daemon that dies too is a new death
  const later = await s.watch({ ...going, pid: 2028, updatedAt: '2026-10-14T12:50:00.000Z' });
  assert.equal(later.told, true);
  assert.equal(s.sent.length, 2);
});

test('a heartbeat from before the machine started: the owner reads that the machine restarted', async () => {
  const root = project();
  // booted 20 minutes before NOW, the heartbeat is 40 minutes old
  const s = spy(root, { uptimeSeconds: 20 * 60 });
  const r = await s.watch(going);
  assert.match(r.line, /\(the machine restarted since\)/);
  assert.match(s.sent[0].body, new RegExp(`has not run since ${hhmm(BEAT)}: the machine restarted\\.`));
  assert.match(s.logged[0], /left no exit line \(the machine restarted since\); owner told/);
});

test('in Russian, and with a heartbeat of another day the date is named', async () => {
  const root = project('сайт');
  const s = spy(root, { config: { lang: 'ru' } });
  await s.watch({ ...going, updatedAt: '2026-10-12T08:05:00.000Z' });
  const d = new Date('2026-10-12T08:05:00.000Z');
  assert.equal(s.sent[0].title, 'Супервизор остановился');
  assert.match(s.sent[0].body, new RegExp(`^Супервизор проекта сайт не работает с ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(d)} `));
});

test('a notification that fails changes nothing: the mark stands and the caller still gets its line', async () => {
  const root = project();
  const s = spy(root, { notify: async () => { throw new Error('offline'); } });
  const r = await s.watch(going);
  assert.equal(r.told, true);
  assert.equal(fs.existsSync(mark(root)), true);
});
