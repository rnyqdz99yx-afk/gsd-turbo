// The supervisor's watchdog. supervisor.json keeps a daemon's pid until the daemon exits (it clears it), the owner stops,
// resumes or attends the run (they clear it) or the daemon loses its lease. A recorded pid whose daemon no longer runs
// is a death without an exit line: the machine crashed or restarted, or the process was killed or hung (the daemon's own
// failures log "daemon fatal" and notify). Nothing then launches, pushes, wakes or takes the owner's answers, and the
// daemon cannot say so itself: whoever looks first tells the owner, once per dead daemon. The owner's view (the mod's
// clock: turbo-run view --watchdog) and every lane at its inbox, ask and lane-status look. Neither starts the supervisor:
// a lane's environment (TURBO_LANE, its own temp directory) is no daemon's, and a restart is the owner's (turbo-run
// start) or autostart's at logon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { beatBeforeBoot, readOwnerStop } from './autostart.mjs';
import { logsDir, runDir } from './paths.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fsx.mjs';
import { msg } from './messages.mjs';
import { notify as notifyOwner } from './notify.mjs';

// { pid, since } of a daemon that died without a word in a run that was going (not finished, not halted, not stopped
// by the owner); null while it runs, or when its pid was cleared (it said why itself).
export function silentDeath({ sup, alive, ownerStop }) {
  if (!sup || alive || ownerStop || sup.finished || sup.halted) return null;
  if (!Number.isInteger(sup.pid) || sup.pid <= 0) return null;
  return { pid: sup.pid, since: typeof sup.updatedAt === 'string' ? sup.updatedAt : null };
}

// The death being told: { pid, since, firstSeen, delivered: { desktop, telegram }, tries, nextTry }. A later daemon that
// dies is a new death.
const markFile = (root) => path.join(runDir(root), 'supervisor-down.json');
// Held while one look decides and sends, so two lookers (the mod, lanes, two sessions) never both tell.
const lockFile = (root) => path.join(runDir(root), 'supervisor-down.lock');
// A look that held the lock longer than this died (the mod ends a view read after 10 s).
const LOCK_STALE_MS = 30000;
// A heartbeat gone stale while its pid still runs is a hung daemon, another process that took the pid, or a machine that
// slept: a woken daemon checks in at its next poll, so that one is told only after two of its polls, two minutes at least.
const GRACE_MIN_MS = 120000;
// A gone pid is read again after this pause: stop, resume and attend kill the daemon first and clear its pid right after.
const CONFIRM_MS = 1500;
// A channel that did not deliver is tried again after RETRY_MS, TRIES sends at most; each send waits NOTIFY_MS at most
// (both channels at once), well inside the mod's 10 s for a view read.
const RETRY_MS = 5 * 60 * 1000;
const TRIES = 3;
const NOTIFY_MS = 5000;
const CHANNELS = ['desktop', 'telegram'];

// EPERM: the process exists but belongs to someone else.
const pidExists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const pad = (n) => String(n).padStart(2, '0');
// The heartbeat in the machine's local time, the way the owner reads a clock: HH:MM, with the date when it is not today.
function clock(iso, now) {
  const d = typeof iso === 'string' ? new Date(iso) : new Date(NaN);
  if (!Number.isFinite(d.getTime())) return '?';
  const day = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return day(d) === day(new Date(now)) ? time : `${day(d)} ${time}`;
}

function appendLog(root, line) {
  try {
    ensureDir(logsDir(root));
    fs.appendFileSync(path.join(logsDir(root), 'supervisor.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging is best-effort */ }
}

function takeLock(root) {
  const file = lockFile(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
    }
    let age = 0;
    try {
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    if (age < LOCK_STALE_MS) return false;
    fs.rmSync(file, { force: true });
  }
  return false;
}

const sameDeath = (mark, dead) => Boolean(mark) && mark.pid === dead.pid && mark.since === dead.since;
// The daemon's own poll when it polls more slowly than the config says (bin/turbo-run.mjs supPoll), within 5 s to 1 h.
const pollMs = (config, sup) => 1000 * Math.min(3600, Math.max(5, Number(config.poll_seconds) || 20, Number(sup.poll_seconds) || 0));

// One look. null while the supervisor runs, no run is going, or a stale heartbeat waits out its grace; else { line, told }:
// the line the caller prints (the lane goes on with its step), told whether this look got the news through to the owner.
// notify(config, message) sends on the channels config.notify names and returns { desktop, telegram }.
export async function watchSupervisor(root, { sup, alive, config = {}, by, notify, log, env = process.env, now = Date.now(), uptimeSeconds = os.uptime(), pidRuns = pidExists, sleep = delay }) {
  // the owner's stop mark is read only for a supervisor that does not run (the mod looks every few seconds)
  const dead = sup && !alive ? silentDeath({ sup, alive, ownerStop: readOwnerStop(root) }) : null;
  if (!dead) return null;
  const reboot = beatBeforeBoot(dead.since, { now, uptimeSeconds });
  const gone = reboot || !pidRuns(dead.pid);
  const seen = readJson(markFile(root), null);
  const known = sameDeath(seen, dead);
  const firstSeen = known && Number.isFinite(Date.parse(seen.firstSeen)) ? seen.firstSeen : new Date(now).toISOString();
  if (!gone && now - Date.parse(firstSeen) < Math.max(GRACE_MIN_MS, 2 * pollMs(config, sup))) {
    if (!known) writeJsonAtomic(markFile(root), { ...dead, firstSeen });
    return null;
  }
  const restarted = reboot ? ' (the machine restarted since)' : '';
  const line = `warn: the supervisor is not running (pid ${dead.pid}, last check-in ${dead.since ?? 'never'})${restarted}; turbo tells the owner. Go on: only the owner starts it`;
  if (gone && !reboot && !(known && seen.noted)) {
    // a stop, resume or attend may be between its kill and its pid: null
    await sleep(CONFIRM_MS);
    if (!sameDeath(silentDeath({ sup: readJson(path.join(runDir(root), 'supervisor.json'), null), alive: false, ownerStop: readOwnerStop(root) }), dead)) return null;
  }
  if (!takeLock(root)) return known ? { told: false, line } : null;
  try {
    const mark = readJson(markFile(root), null);
    const same = sameDeath(mark, dead);
    const field = (k) => (same && mark[k] && typeof mark[k] === 'object' ? { ...mark[k] } : {});
    // per channel: delivered, sends so far, the time of the next send after a failed one
    const delivered = field('delivered');
    const tries = field('tries');
    const nextTry = field('nextTry');
    const write = () => writeJsonAtomic(markFile(root), { ...dead, firstSeen, noted: true, delivered, tries, nextTry });
    const say = log || ((l) => appendLog(root, l));
    if (!(same && mark.noted)) {
      const how = gone ? 'and left no exit line' : 'though its pid still runs (hung, or another process has that pid now)';
      say(`watchdog: supervisor pid ${dead.pid} has not checked in since ${dead.since ?? 'never'} ${how}${restarted} (seen by ${by})`);
    }
    // the channels the config names that have not delivered and are due; Telegram only where its token is (a lane's
    // environment may lack it: the owner's view sends it then)
    const token = Boolean(env.TURBO_TELEGRAM_TOKEN && env.TURBO_TELEGRAM_CHAT);
    const due = (c) => config.notify?.[c] && !delivered[c] && (c !== 'telegram' || token) && (Number(tries[c]) || 0) < TRIES && !(now < Date.parse(nextTry[c]));
    const here = CHANNELS.filter(due);
    if (!here.length) {
      if (!(same && mark.noted)) write();
      return { told: false, line };
    }
    // the send is on disk before it goes: a look killed while sending is not repeated before RETRY_MS
    for (const c of here) {
      tries[c] = (Number(tries[c]) || 0) + 1;
      nextTry[c] = new Date(now + RETRY_MS).toISOString();
    }
    write();
    const m = msg(config.lang, 'supervisorDown', { project: path.basename(root), since: clock(dead.since, now), reboot: reboot ? '1' : '', start: sup.planOnly ? '/turbo-plan-milestone' : '/turbo-autonomous' });
    const send = notify || ((cfg, x) => notifyOwner(cfg, x, { timeoutMs: NOTIFY_MS }));
    let r = {};
    try {
      r = (await send({ ...config, notify: Object.fromEntries(CHANNELS.map((c) => [c, here.includes(c)])) }, m)) || {};
    } catch { /* counted as not delivered */ }
    const got = here.filter((c) => r[c]);
    for (const c of got) {
      delivered[c] = true;
      delete nextTry[c];
    }
    write();
    const failed = here.filter((c) => !r[c]);
    say(`watchdog: ${got.length ? `owner told on ${got.join(' and ')}` : 'the owner could not be told'}${failed.length ? ` (${failed.join(' and ')} failed; ${failed.every((c) => tries[c] < TRIES) ? `tried again after ${RETRY_MS / 60000} min` : 'no more tries'})` : ''}`);
    return { told: got.length > 0, line };
  } finally {
    fs.rmSync(lockFile(root), { force: true });
  }
}
