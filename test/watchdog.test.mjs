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
const MIN = 60 * 1000;
const going = { pid: 40164, updatedAt: BEAT, finished: false, halted: false, lane: { phase: '33', sessionId: 's' } };
const pad = (n) => String(n).padStart(2, '0');
// what the owner reads for a heartbeat, in this machine's time zone: HH:MM, with the date when it is not today
function localClock(iso, now = NOW) {
  const d = new Date(iso);
  const day = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return day(d) === day(new Date(now)) ? time : `${day(d)} ${time}`;
}

function project(name = 'my-app', sup = going) {
  const root = path.join(tmpDir('wd'), name);
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  // the confirming read (a gone pid is read again) finds what the look was given
  if (sup) fs.writeFileSync(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), JSON.stringify(sup));
  return root;
}
const ON = { desktop: true, telegram: true };
const TOKEN = { TURBO_TELEGRAM_TOKEN: 'T', TURBO_TELEGRAM_CHAT: '42' };
// results: what each send answers per channel (all delivered unless said)
function spy(root, extra = {}) {
  const sent = [];
  const logged = [];
  const slept = [];
  const deps = {
    config: { lang: 'en', poll_seconds: 20, notify: { desktop: true, telegram: false } },
    by: 'the owner\'s view',
    now: NOW,
    uptimeSeconds: 30 * 24 * 3600,
    env: {},
    // the recorded pid is gone unless a test says otherwise (a real pid number may run on the test machine)
    pidRuns: () => false,
    sleep: async (ms) => { slept.push(ms); },
    results: () => ({ desktop: true, telegram: true }),
    log: (l) => logged.push(l),
    ...extra,
  };
  const notify = async (cfg, m) => {
    const channels = Object.keys(cfg.notify).filter((c) => cfg.notify[c]);
    sent.push({ channels, ...m });
    const r = deps.results(channels);
    return Object.fromEntries(channels.map((c) => [c, Boolean(r[c])]));
  };
  const watch = (sup, alive = false, at = {}) => watchSupervisor(root, { sup, alive, notify, ...deps, ...at });
  return { sent, logged, slept, watch };
}
const markOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.planning', 'turbo', 'run', 'supervisor-down.json'), 'utf8'));
const hasMark = (root) => fs.existsSync(path.join(root, '.planning', 'turbo', 'run', 'supervisor-down.json'));

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
  assert.equal(hasMark(root), false);
});

test('a dead supervisor is told to the owner once per dead daemon, with log lines; every caller gets the line', async () => {
  const root = project('my-app');
  const s = spy(root);
  const first = await s.watch(going);
  assert.equal(first.told, true);
  assert.equal(first.line, 'warn: the supervisor is not running (pid 40164, last check-in 2026-10-14T12:20:10.000Z); turbo tells the owner. Go on: only the owner starts it');
  assert.deepEqual(s.slept, [1500], 'a gone pid is read again first');
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0].channels, ['desktop']);
  assert.equal(s.sent[0].title, 'The supervisor stopped');
  assert.equal(s.sent[0].body.startsWith(`The supervisor of my-app has not run since ${localClock(BEAT)} and left no exit line`), true, s.sent[0].body);
  assert.match(s.sent[0].body, /To start it again: \/turbo-autonomous in my-app\. Log: \.planning\/turbo\/logs\/supervisor\.log$/);
  assert.deepEqual(s.logged, [
    'watchdog: supervisor pid 40164 has not checked in since 2026-10-14T12:20:10.000Z and left no exit line (seen by the owner\'s view)',
    'watchdog: owner told on desktop',
  ]);
  assert.deepEqual(markOf(root).delivered, { desktop: true });
  // the next look (another lane, the next clock tick) tells nobody again
  const again = await s.watch(going, false, { now: NOW + 10 * MIN });
  assert.deepEqual(again, { told: false, line: first.line });
  assert.equal(s.sent.length, 1);
  assert.equal(s.logged.length, 2);
  // a later daemon that dies too is a new death
  const later = { ...going, pid: 2028, updatedAt: '2026-10-14T12:50:00.000Z' };
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), JSON.stringify(later));
  assert.equal((await s.watch(later)).told, true);
  assert.equal(s.sent.length, 2);
});

test('stop, resume and attend kill the daemon, then clear its pid: a look in between tells nobody', async () => {
  // the confirming read finds the pid cleared
  const root = project('my-app', { ...going, pid: null });
  const s = spy(root);
  assert.equal(await s.watch(going), null);
  assert.deepEqual([s.sent, s.logged], [[], []]);
  assert.equal(hasMark(root), false);
});

test('a plan-only run is started again with /turbo-plan-milestone', async () => {
  const root = project('my-app', { ...going, planOnly: true });
  const s = spy(root);
  await s.watch({ ...going, planOnly: true });
  assert.match(s.sent[0].body, /To start it again: \/turbo-plan-milestone in my-app\./);
});

test('a heartbeat from before the machine started: the owner reads that the machine restarted, without a second read', async () => {
  const root = project();
  // booted 20 minutes before NOW, the heartbeat is 40 minutes old
  const s = spy(root, { uptimeSeconds: 20 * 60, pidRuns: () => true });
  const r = await s.watch(going);
  assert.match(r.line, /\(the machine restarted since\); turbo tells the owner/);
  assert.equal(s.sent[0].body.includes(`has not run since ${localClock(BEAT)}: the machine restarted.`), true, s.sent[0].body);
  assert.match(s.logged[0], /left no exit line \(the machine restarted since\) \(seen by/);
  assert.deepEqual(s.slept, []);
});

test('in Russian, and with a heartbeat of another day the date is named', async () => {
  const root = project('сайт', { ...going, updatedAt: '2026-10-12T08:05:00.000Z' });
  const s = spy(root, { config: { lang: 'ru', notify: { desktop: true } } });
  await s.watch({ ...going, updatedAt: '2026-10-12T08:05:00.000Z' });
  assert.equal(s.sent[0].title, 'Супервизор остановился');
  assert.equal(s.sent[0].body.startsWith(`Супервизор проекта сайт не работает с ${localClock('2026-10-12T08:05:00.000Z')} `), true, s.sent[0].body);
});

test('each channel is told once: a lane without the Telegram token sends the desktop note, the owner\'s view the Telegram one', async () => {
  const root = project();
  const config = { lang: 'en', poll_seconds: 20, notify: ON };
  const lane = spy(root, { config, by: 'the lane of phase 33 (inbox)' });
  assert.equal((await lane.watch(going)).told, true);
  assert.deepEqual(lane.sent.map((x) => x.channels), [['desktop']]);
  const view = spy(root, { config, env: TOKEN });
  assert.equal((await view.watch(going, false, { now: NOW + 3000 })).told, true);
  assert.deepEqual(view.sent.map((x) => x.channels), [['telegram']]);
  assert.deepEqual(markOf(root).delivered, { desktop: true, telegram: true });
  assert.equal((await view.watch(going, false, { now: NOW + 30 * MIN })).told, false);
  assert.equal(view.sent.length, 1);
});

test('a channel that failed is tried again after 5 minutes, three sends at most; the log says so', async () => {
  const root = project();
  const s = spy(root, { config: { lang: 'en', notify: ON }, env: TOKEN, results: () => ({ desktop: true, telegram: false }) });
  await s.watch(going);
  assert.deepEqual(s.sent.map((x) => x.channels), [['desktop', 'telegram']]);
  assert.equal(s.logged[1], 'watchdog: owner told on desktop (telegram failed; tried again after 5 min)');
  await s.watch(going, false, { now: NOW + 4 * MIN });
  assert.equal(s.sent.length, 1, 'not before 5 minutes');
  await s.watch(going, false, { now: NOW + 5 * MIN });
  await s.watch(going, false, { now: NOW + 10 * MIN });
  assert.deepEqual(s.sent.map((x) => x.channels), [['desktop', 'telegram'], ['telegram'], ['telegram']]);
  assert.equal(s.logged.at(-1), 'watchdog: the owner could not be told (telegram failed; no more tries)');
  await s.watch(going, false, { now: NOW + 60 * MIN });
  assert.equal(s.sent.length, 3);
});

test('a notification that throws counts as not delivered; the caller still gets its line', async () => {
  const root = project();
  const s = spy(root, { results: () => { throw new Error('offline'); } });
  const r = await s.watch(going);
  assert.equal(r.told, false);
  assert.match(r.line, /^warn: the supervisor is not running/);
  assert.equal(markOf(root).tries.desktop, 1);
});

test('two lookers at once: the one that holds the claim tells, the other stays quiet', async () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'run', 'supervisor-down.lock'), '');
  const s = spy(root);
  assert.equal(await s.watch(going), null, 'a first look without the claim says nothing yet');
  assert.deepEqual(s.sent, []);
});

test('a stale heartbeat whose pid still runs (a machine that slept, a hung tick) waits out a grace before anyone is told', async () => {
  const root = project();
  const s = spy(root, { pidRuns: () => true });
  // first look: only noted, the lane gets no line
  assert.equal(await s.watch(going), null);
  assert.equal(markOf(root).firstSeen, new Date(NOW).toISOString());
  // within the grace (2 min, or two polls when longer): still nothing; a woken daemon checks in meanwhile
  assert.equal(await s.watch(going, false, { now: NOW + 90 * 1000 }), null);
  assert.deepEqual(s.sent, []);
  // it checked in again: a new heartbeat, nothing to tell
  assert.equal(await s.watch({ ...going, updatedAt: new Date(NOW + 100 * 1000).toISOString() }, true, { now: NOW + 100 * 1000 }), null);
  // still stale past the grace: told, once, without a second read (its pid runs)
  const r = await s.watch(going, false, { now: NOW + 125 * 1000 });
  assert.equal(r.told, true);
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.slept, []);
  assert.match(s.logged[0], /though its pid still runs \(hung, or another process has that pid now\) \(seen by/);
  assert.equal((await s.watch(going, false, { now: NOW + 200 * 1000 })).told, false);
  assert.equal(s.sent.length, 1);
});

test('the grace is two of the daemon\'s own polls when it polls slowly', async () => {
  const root = project();
  const s = spy(root, { pidRuns: () => true });
  const slow = { ...going, poll_seconds: 300 };
  assert.equal(await s.watch(slow), null);
  assert.equal(await s.watch(slow, false, { now: NOW + 590 * 1000 }), null);
  assert.equal((await s.watch(slow, false, { now: NOW + 600 * 1000 })).told, true);
});
