// The supervisor's watchdog. supervisor.json keeps a daemon's pid until the daemon exits (it clears it), the owner stops
// or resumes the run (they clear it) or the daemon loses its lease. A recorded pid whose daemon no longer runs is a
// death without an exit line: the machine crashed or restarted, or the process was killed or hung (the daemon's own
// failures log "daemon fatal" and notify). Nothing then launches, pushes, wakes or takes the owner's answers, and the
// daemon cannot say so itself: whoever looks first tells the owner, once per dead daemon. The owner's view (the mod's
// clock: turbo-run view --watchdog) and every lane at its inbox, ask and lane-status look. Neither starts the supervisor:
// a lane's environment (TURBO_LANE, its own temp directory) is no daemon's, and a restart is the owner's (turbo-run
// start) or autostart's at logon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// The dead daemon already told, so the next look tells nobody again; a later daemon that dies is a new death.
const markFile = (root) => path.join(runDir(root), 'supervisor-down.json');

const pad = (n) => String(n).padStart(2, '0');
// The heartbeat in the machine's local time, the way the owner reads a clock: HH:MM, with the date when it is not today.
function clock(iso, now) {
  const d = new Date(iso);
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

// One look. null while the supervisor runs or no run is going; else { line, told }: the line the caller prints (the
// lane goes on with its step), told whether this look told the owner (desktop and Telegram, as the config says).
export async function watchSupervisor(root, { sup, alive, config = {}, by, notify, log, now = Date.now(), uptimeSeconds = os.uptime() }) {
  // the owner's stop mark is read only for a supervisor that does not run (the mod looks every few seconds)
  const dead = sup && !alive ? silentDeath({ sup, alive, ownerStop: readOwnerStop(root) }) : null;
  if (!dead) return null;
  const reboot = beatBeforeBoot(dead.since, { now, uptimeSeconds });
  const seen = readJson(markFile(root), null);
  const told = !(seen && seen.pid === dead.pid && seen.since === dead.since);
  const restarted = reboot ? ' (the machine restarted since)' : '';
  if (told) {
    writeJsonAtomic(markFile(root), { ...dead, at: new Date(now).toISOString(), by });
    (log || ((l) => appendLog(root, l)))(`watchdog: supervisor pid ${dead.pid} has not checked in since ${dead.since ?? 'never'} and left no exit line${restarted}; owner told (seen by ${by})`);
    const m = msg(config.lang, 'supervisorDown', { project: path.basename(root), since: clock(dead.since, now), reboot: reboot ? '1' : '' });
    try {
      await (notify || ((x) => notifyOwner(config, x)))(m);
    } catch { /* best-effort: the log and the view have it */ }
  }
  return { told, line: `warn: the supervisor is not running (pid ${dead.pid}, last check-in ${dead.since ?? 'never'})${restarted}; the owner ${told ? 'is' : 'was'} told. Go on: only the owner starts it` };
}
