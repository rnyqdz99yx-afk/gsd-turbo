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
//   Termux); a session's pty host listens on pty/<job id>.sock beside it, a warm spare's on spare/<n>.pty.sock. A socket
//   file a crash left behind cannot be told from a live one without connecting, so a control socket there counts as the
//   service and any pty socket makes the answer unknown (conservative).
// Every probe answers true, false, or null when it cannot tell; only false on both counts proves anything.

const KEY = /^[a-f0-9]{16}$/;
const PIPES = '\\\\.\\pipe\\';
const enoent = (e) => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
const daemonDir = (env, home) => path.join(claudeHome(env, home), 'daemon');
// a pipe name as listed, without any path before it, lower case
const pipeName = (n) => String(n).split(/[\\/]/).pop().toLowerCase();

// Socket files in a directory whose names end with suffix: true (some), false (none, or no directory), null (unknown).
function socketsIn(fsx, dir, suffix) {
  try {
    return fsx.readdirSync(dir).some((n) => String(n).endsWith(suffix));
  } catch (e) {
    return enoent(e) ? false : null;
  }
}

// The control channel of this config directory's service, or a pty host of the session id (job id) when given: true
// (one exists), false (none), null (unknown).
export function daemonChannel({ platform = process.platform, env = process.env, home = os.homedir(), fsx = fs, uid = process.getuid?.() ?? 0, id = '' } = {}) {
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
      names = fsx.readdirSync(PIPES).map(pipeName);
    } catch {
      return null;
    }
    // a Windows that lists no pipe at all lists them in a way this does not read
    if (!names.length) return null;
    const own = [`cc-daemon-${key}-control`, ...(id ? [`cc-daemon-${key}-pty-${String(id).toLowerCase()}`] : [])];
    return names.some((n) => own.includes(n));
  }
  const base = env.TERMUX_VERSION && env.PREFIX ? path.join(env.PREFIX, 'tmp') : '/tmp';
  const hash = createHash('sha256').update(path.resolve(claudeHome(env, home))).digest('hex').slice(0, 8);
  const dir = path.join(base, `cc-daemon-${uid}`, hash);
  try {
    fsx.lstatSync(path.join(dir, 'control.sock'));
    return true;
  } catch (e) {
    if (!enoent(e)) return null;
  }
  // a pty host may outlive the service: any of its sockets left there makes it unknown
  const pty = socketsIn(fsx, path.join(dir, 'pty'), '.sock');
  const spare = socketsIn(fsx, path.join(dir, 'spare'), '.pty.sock');
  return pty === false && spare === false ? false : null;
}

// The pid a session's pty host recorded (Windows only): 0 when it recorded none, null when that cannot be read.
function ptyPid(id, { platform, env, home, fsx }) {
  if (platform !== 'win32' || !/^[0-9A-Za-z-]+$/.test(id)) return 0;
  let text;
  try {
    text = String(fsx.readFileSync(path.join(daemonDir(env, home), 'pty-pids', `${id}.pid`), 'utf8')).trim();
  } catch (e) {
    return enoent(e) ? 0 : null;
  }
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// One snapshot of the process table: { rows: [{ pid, cmd }], text } from Win32_Process command lines on Windows (line
// breaks inside a command line made spaces), ps elsewhere. null when it cannot be read, or when it does not list this
// very process with its command line (a listing that misses processes or command lines proves nothing).
const WIN_PROCESSES = "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + ' ' + ([string]$_.CommandLine -replace '[\\r\\n]+', ' ') }";
export function processTable({ platform = process.platform, exec = execFileSync, self = process.pid } = {}) {
  let text;
  try {
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 };
    text = String(platform === 'win32'
      ? exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PROCESSES], opts)
      : exec('ps', ['-A', '-ww', '-o', 'pid=,args='], opts));
  } catch {
    return null;
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s?(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return rows.some((r) => r.pid === self && r.cmd.trim()) ? { rows, text } : null;
}

// Whether a process carries the session: its job id or transcript session id anywhere in the listing (the pty host's
// pipe or socket names the job id; a resumed session names its session id), or a pid claude agents or the pty host
// recorded still running. true, false, or null (no process table).
export function sessionProcess({ ids = [], pids = [], table }) {
  if (!table) return null;
  const want = ids.map((x) => String(x || '').toLowerCase()).filter((x) => x.length >= 6);
  const running = new Set(pids.filter((p) => Number.isInteger(p) && p > 0));
  const text = table.text.toLowerCase();
  return want.some((x) => text.includes(x)) || table.rows.some((r) => running.has(r.pid));
}

// True only when this config directory's service has no control channel AND no process carries the session (job id
// `id`; `agent` is its claude agents entry, when listed): then nothing runs it, whatever claude agents still lists, and
// it counts as stopped. Anything unknown is false: the caller keeps its own handling.
export function serviceGone(id, agent, { platform = process.platform, env = process.env, home = os.homedir(), fsx = fs, uid = process.getuid?.() ?? 0, exec = execFileSync, self = process.pid } = {}) {
  if (daemonChannel({ platform, env, home, fsx, uid, id: String(id) }) !== false) return false;
  const pty = ptyPid(String(id), { platform, env, home, fsx });
  if (pty === null) return false;
  return sessionProcess({ ids: [id, agent?.sessionId], pids: [Number(agent?.pid) || 0, pty], table: processTable({ platform, exec, self }) }) === false;
}
