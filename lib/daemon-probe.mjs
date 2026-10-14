import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { claudeHome } from './paths.mjs';

// Whether Claude Code's background service (the daemon that runs claude --bg sessions) is reachable for this config
// directory, and whether any process still carries a session, without asking claude: claude stop, rm and logs all fail
// while the service is down, and claude agents then lists its jobs from disk, a dead one as blocked or working.
// What Claude Code 2.1.300 uses, one service per config directory (CLAUDE_CONFIG_DIR, else ~/.claude):
// - Windows: the control pipe \\.\pipe\cc-daemon-<key>-control, <key> = 16 hex in <config>/daemon/pipe.key (written
//   before the service binds any pipe, so another config directory's service never has it); a session's pty host
//   listens on \\.\pipe\cc-daemon-<key>-pty-<job id> and keeps its pid in <config>/daemon/pty-pids/<job id>.pid.
// - POSIX: the control socket /tmp/cc-daemon-<uid>/<8 hex of sha256(config dir)>/control.sock ($PREFIX/tmp under
//   Termux); a session's pty host listens on pty/<job id>.sock beside it. A socket file a crash left behind cannot be
//   told from a live one without connecting, so a socket file there counts as the service (conservative).
// Every probe answers true, false, or null when it cannot tell; only false on both counts proves anything.

const KEY = /^[a-f0-9]{16}$/;
const PIPES = '\\\\.\\pipe\\';
const enoent = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
const daemonDir = (env, home) => path.join(claudeHome(env, home), 'daemon');

// The control channel of this config directory's service: true (it exists), false (it does not), null (unknown).
export function daemonChannel({ platform = process.platform, env = process.env, home = os.homedir(), fsx = fs, uid = process.getuid?.() ?? 0 } = {}) {
  if (platform === 'win32') {
    let key;
    try {
      key = String(fsx.readFileSync(path.join(daemonDir(env, home), 'pipe.key'), 'utf8')).trim();
    } catch (e) {
      // no key: no service of this config directory has bound a pipe
      return enoent(e) ? false : null;
    }
    if (!KEY.test(key)) return null;
    let names;
    try {
      names = fsx.readdirSync(PIPES);
    } catch {
      return null;
    }
    const want = `cc-daemon-${key}-control`;
    return names.some((n) => String(n).toLowerCase() === want);
  }
  const base = env.TERMUX_VERSION && env.PREFIX ? path.join(env.PREFIX, 'tmp') : '/tmp';
  const hash = createHash('sha256').update(path.resolve(claudeHome(env, home))).digest('hex').slice(0, 8);
  try {
    fsx.lstatSync(path.join(base, `cc-daemon-${uid}`, hash, 'control.sock'));
    return true;
  } catch (e) {
    return enoent(e) ? false : null;
  }
}

// The pid a session's pty host recorded (Windows only), or 0.
function ptyPid(id, { platform, env, home, fsx }) {
  if (platform !== 'win32' || !/^[0-9A-Za-z-]+$/.test(id)) return 0;
  try {
    const n = Number(String(fsx.readFileSync(path.join(daemonDir(env, home), 'pty-pids', `${id}.pid`), 'utf8')).trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

// One snapshot of the process table, [{ pid, cmd }]: Win32_Process command lines on Windows, ps elsewhere. null when
// it cannot be read, or when it does not list this very process (a listing that misses processes proves nothing).
export function processTable({ platform = process.platform, exec = execFileSync, self = process.pid } = {}) {
  let text;
  try {
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 };
    text = platform === 'win32'
      ? exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'], opts)
      : exec('ps', ['-A', '-ww', '-o', 'pid=,args='], opts);
  } catch {
    return null;
  }
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s?(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return rows.some((r) => r.pid === self) ? rows : null;
}

// Whether a process carries the session: its job id or transcript session id in a command line (the pty host's pipe or
// socket names the job id; a resumed session names its session id), or a pid claude agents or the pty host recorded
// still running. true, false, or null (no process table).
export function sessionProcess({ ids = [], pids = [], table }) {
  if (!table) return null;
  const want = ids.map((x) => String(x || '').toLowerCase()).filter((x) => x.length >= 6);
  const running = new Set(pids.filter((p) => Number.isInteger(p) && p > 0));
  return table.some((r) => running.has(r.pid) || want.some((x) => r.cmd.toLowerCase().includes(x)));
}

// True only when this config directory's service has no control channel AND no process carries the session (job id
// `id`; `agent` is its claude agents entry, when listed): then nothing runs it, whatever claude agents still lists, and
// it counts as stopped. Anything unknown is false: the caller keeps its own handling.
export function serviceGone(id, agent, { platform = process.platform, env = process.env, home = os.homedir(), fsx = fs, uid = process.getuid?.() ?? 0, exec = execFileSync, self = process.pid } = {}) {
  if (daemonChannel({ platform, env, home, fsx, uid }) !== false) return false;
  const pids = [Number(agent?.pid) || 0, ptyPid(String(id), { platform, env, home, fsx })];
  return sessionProcess({ ids: [id, agent?.sessionId], pids, table: processTable({ platform, exec, self }) }) === false;
}
