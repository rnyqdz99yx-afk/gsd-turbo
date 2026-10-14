import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { claudeHome } from '../lib/paths.mjs';
import { daemonChannel, processTable, serviceGone, sessionProcess } from '../lib/daemon-probe.mjs';

// The live finding (journal 2026-10-14 15:34Z): claude stop failed «couldn't confirm 0203669b was stopped — the
// background service may be restarting», no daemon control pipe of the default config directory (only another config
// directory's service was alive), no process with the session id, claude agents still listing it blocked.
const KEY = '0123456789abcdef';
const OTHER = 'fedcba9876543210';
const env = { CLAUDE_CONFIG_DIR: '/home/dev/cfg-a' };
const daemonFile = (...parts) => path.join(claudeHome(env), 'daemon', ...parts);
const enoent = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

// A Windows file system: files by path (a value that is an Error is thrown), the named pipes \\.\pipe\ lists.
function winFs({ files = {}, pipes = ['InitShutdown', 'lsass'], pipesFail = false } = {}) {
  return {
    readFileSync: (p) => {
      if (!Object.hasOwn(files, p)) throw enoent();
      if (files[p] instanceof Error) throw files[p];
      return files[p];
    },
    readdirSync: (p) => {
      assert.equal(p, '\\\\.\\pipe\\');
      if (pipesFail) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return pipes;
    },
  };
}
const win = (fsx, id) => ({ platform: 'win32', env, fsx, id });

test('Windows: the control pipe of this config directory is named by its daemon/pipe.key; another config directory\'s service never counts', () => {
  const key = { [daemonFile('pipe.key')]: `${KEY}\n` };
  assert.equal(daemonChannel(win(winFs({ files: key, pipes: ['some-pipe', `cc-daemon-${KEY}-control`] }))), true);
  assert.equal(daemonChannel(win(winFs({ files: key, pipes: [`CC-DAEMON-${KEY.toUpperCase()}-CONTROL`] }))), true, 'pipe names are case-insensitive');
  assert.equal(daemonChannel(win(winFs({ files: key, pipes: [`\\\\.\\pipe\\cc-daemon-${KEY}-control`] }))), true, 'a name listed with a path before it');
  assert.equal(daemonChannel(win(winFs({ files: key, pipes: [`cc-daemon-${OTHER}-control`, `cc-daemon-${KEY}-pty-9a9a9a9a`] }))), false, 'only another service\'s control pipe and another session\'s pty pipe');
  assert.equal(daemonChannel(win(winFs({ pipes: [`cc-daemon-${OTHER}-control`] }))), false, 'no pipe.key: no service of this config directory ever bound a pipe');
  assert.equal(daemonChannel(win(winFs({ files: { [daemonFile('pipe.key')]: 'not a key' } }))), null, 'a broken key: unknown');
  assert.equal(daemonChannel(win(winFs({ files: key, pipesFail: true }))), null, 'the pipe list cannot be read: unknown');
  assert.equal(daemonChannel(win(winFs({ files: key, pipes: [] }))), null, 'an empty pipe list is no list: unknown');
  assert.equal(daemonChannel(win(winFs({ files: { [daemonFile('pipe.key')]: eacces() } }))), null, 'an unreadable key: unknown');
});

test('Windows: the session\'s own pty host pipe counts like the control pipe: something of the service still carries it', () => {
  const key = { [daemonFile('pipe.key')]: KEY };
  const pipes = [`cc-daemon-${OTHER}-control`, `cc-daemon-${KEY}-pty-0203669B`];
  assert.equal(daemonChannel(win(winFs({ files: key, pipes }), '0203669b')), true);
  assert.equal(daemonChannel(win(winFs({ files: key, pipes }), '9a9a9a9a')), false);
  assert.equal(daemonChannel(win(winFs({ files: key, pipes }))), false, 'no session asked: the control pipe only');
});

test('POSIX: the control socket under /tmp/cc-daemon-<uid>/<8 hex of the config directory>/ counts as the service; any pty socket left there is unknown', () => {
  const hash = (dir) => createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8);
  const dir = path.join('/tmp', 'cc-daemon-1000', hash('/home/dev/cfg-a'));
  // present: the socket files that exist; dirs: directory listings; err: what a missing path throws
  const fsWith = (present, { dirs = {}, err = enoent() } = {}) => ({
    lstatSync: (p) => { if (present.includes(p)) return {}; throw err; },
    readdirSync: (p) => {
      if (dirs[p] instanceof Error) throw dirs[p];
      if (Object.hasOwn(dirs, p)) return dirs[p];
      throw enoent();
    },
  });
  const posix = (fsx, more = {}) => daemonChannel({ platform: 'linux', env, uid: 1000, fsx, ...more });
  assert.equal(posix(fsWith([path.join(dir, 'control.sock')])), true);
  assert.equal(posix(fsWith([])), false);
  assert.equal(posix(fsWith([], { dirs: { [path.join(dir, 'pty')]: ['0203669b.sock.err'], [path.join(dir, 'spare')]: ['ab12.claim.sock'] } })), false, 'no pty socket: only breadcrumbs and a claim socket');
  assert.equal(posix(fsWith([], { dirs: { [path.join(dir, 'pty')]: ['9a9a9a9a.sock'] } })), null, 'a pty host may outlive the service');
  assert.equal(posix(fsWith([], { dirs: { [path.join(dir, 'spare')]: ['ab12.pty.sock'] } })), null, 'a warm spare may carry a session');
  assert.equal(posix(fsWith([], { dirs: { [path.join(dir, 'pty')]: eacces() } })), null);
  assert.equal(posix(fsWith([path.join('/tmp', 'cc-daemon-1000', hash('/home/dev/cfg-b'), 'control.sock')])), false, 'another config directory\'s service');
  assert.equal(posix(fsWith([], { err: eacces() })), null);
  const termux = path.join('/data/usr', 'tmp', 'cc-daemon-1000', hash('/home/dev/cfg-a'), 'control.sock');
  assert.equal(posix(fsWith([termux]), { env: { ...env, TERMUX_VERSION: '1', PREFIX: '/data/usr' } }), true);
  // ~/.claude without CLAUDE_CONFIG_DIR
  const home = path.join('/tmp', 'cc-daemon-1000', hash(path.join('/home/dev', '.claude')), 'control.sock');
  assert.equal(daemonChannel({ platform: 'linux', env: {}, home: '/home/dev', uid: 1000, fsx: fsWith([home]) }), true);
});

test('processTable: Win32_Process command lines on Windows (line breaks made spaces), ps elsewhere; unreadable, or missing this very process or its command line, is no table', () => {
  const calls = [];
  const exec = (out) => (cmd, args) => {
    calls.push([cmd, ...args]);
    return out;
  };
  const text = '4 System\r\n77 D:\\tools\\node.exe turbo-run.mjs stop\r\n900 \r\n';
  const t = processTable({ platform: 'win32', exec: exec(text), self: 77 });
  assert.deepEqual(t.rows, [{ pid: 4, cmd: 'System' }, { pid: 77, cmd: 'D:\\tools\\node.exe turbo-run.mjs stop' }, { pid: 900, cmd: '' }]);
  assert.equal(t.text, text);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.match(calls[0].at(-1), /Get-CimInstance Win32_Process .*CommandLine -replace '\[\\r\\n\]\+', ' '/);
  assert.deepEqual(processTable({ platform: 'linux', exec: exec('  1 /sbin/init\n 77 node turbo-run.mjs stop\n'), self: 77 }).rows.map((r) => r.pid), [1, 77]);
  assert.deepEqual(calls[1], ['ps', '-A', '-ww', '-o', 'pid=,args=']);
  assert.equal(processTable({ platform: 'linux', exec: exec('  1 /sbin/init\n'), self: 77 }), null, 'a listing without this process proves nothing');
  assert.equal(processTable({ platform: 'win32', exec: exec('4 System\r\n77 \r\n'), self: 77 }), null, 'a listing without command lines (no rights) proves nothing');
  assert.equal(processTable({ platform: 'win32', exec: () => { throw new Error('powershell missing'); }, self: 77 }), null);
});

test('sessionProcess: the job id or session id anywhere in the listing, or a recorded pid that still runs; no table is unknown', () => {
  const rows = [
    { pid: 10, cmd: `"D:\\tools\\claude.exe" --bg-pty-host \\\\.\\pipe\\cc-daemon-${KEY}-pty-0203669B 200 50 -- claude.exe` },
    { pid: 11, cmd: 'claude.exe --bg --resume 5e6f7a8b-1111-4222-8333-444444444444 go on' },
    { pid: 12, cmd: 'git log abc' },
  ];
  const table = { rows, text: rows.map((r) => `${r.pid} ${r.cmd}`).join('\r\n') };
  assert.equal(sessionProcess({ ids: ['0203669b'], table }), true, 'the pty host names the job id (case-insensitive)');
  assert.equal(sessionProcess({ ids: ['9a9a9a9a', '5e6f7a8b-1111-4222-8333-444444444444'], table }), true, 'a resume names the session id');
  assert.equal(sessionProcess({ ids: ['9a9a9a9a'], pids: [12], table }), true, 'a recorded pid that runs');
  assert.equal(sessionProcess({ ids: ['9a9a9a9a', '', undefined, 'abc'], pids: [0, 13], table }), false, 'ids shorter than 6 never match');
  // a command line whose line break the listing kept: the id on its second line still counts
  const split = { rows: [{ pid: 20, cmd: 'claude.exe --bg-pty-host' }], text: '20 claude.exe --bg-pty-host\r\n  --resume 0203669b go on' };
  assert.equal(sessionProcess({ ids: ['0203669b'], table: split }), true);
  assert.equal(sessionProcess({ ids: ['0203669b'], table: null }), null);
});

test('serviceGone: true only with no control channel of this config directory and no process of the session; anything unknown keeps the caller\'s handling', () => {
  const key = { [daemonFile('pipe.key')]: KEY };
  const self = { pid: 77, cmd: 'node turbo-run.mjs stop' };
  const ps = (rows) => () => [self, ...rows].map((r) => `${r.pid} ${r.cmd}`).join('\r\n');
  const opts = (fsx, exec) => ({ platform: 'win32', env, fsx, exec, self: 77 });
  const dead = winFs({ files: key, pipes: [`cc-daemon-${OTHER}-control`] });
  // the live case: the default config directory's service is down, another config directory's runs, nothing carries 0203669b
  assert.equal(serviceGone('0203669b', { id: '0203669b', state: 'blocked', pid: 4242 }, opts(dead, ps([{ pid: 50, cmd: 'claude.exe' }]))), true);
  assert.equal(serviceGone('0203669b', undefined, opts(dead, ps([]))), true, 'not listed at all');
  // the service of this config directory is up, or the session's own pty pipe is there: never gone, no process table read
  let read = false;
  const noTable = () => { read = true; return ''; };
  assert.equal(serviceGone('0203669b', undefined, opts(winFs({ files: key, pipes: [`cc-daemon-${KEY}-control`] }), noTable)), false);
  assert.equal(serviceGone('0203669b', undefined, opts(winFs({ files: key, pipes: [`cc-daemon-${KEY}-pty-0203669b`] }), noTable)), false);
  assert.equal(read, false);
  assert.equal(serviceGone('0203669b', undefined, opts(winFs({ files: key, pipesFail: true }), ps([]))), false, 'pipes unknown');
  // a process of the session: by its pty host pipe in a command line, the agent's pid, or the pid the pty host recorded
  assert.equal(serviceGone('0203669b', undefined, opts(dead, ps([{ pid: 60, cmd: `claude.exe --bg-pty-host \\\\.\\pipe\\cc-daemon-${KEY}-pty-0203669b` }]))), false);
  assert.equal(serviceGone('0203669b', { id: '0203669b', state: 'working', pid: 61 }, opts(dead, ps([{ pid: 61, cmd: 'claude.exe' }]))), false);
  const withPid = (pidFile) => winFs({ files: { ...key, [daemonFile('pty-pids', '0203669b.pid')]: pidFile }, pipes: [`cc-daemon-${OTHER}-control`] });
  assert.equal(serviceGone('0203669b', undefined, opts(withPid('62\n'), ps([{ pid: 62, cmd: 'claude.exe' }]))), false);
  assert.equal(serviceGone('0203669b', undefined, opts(withPid('62\n'), ps([{ pid: 63, cmd: 'claude.exe' }]))), true, 'a recorded pid that no longer runs');
  assert.equal(serviceGone('0203669b', undefined, opts(withPid(eacces()), ps([]))), false, 'a pid file that cannot be read: unknown');
  assert.equal(serviceGone('0203669b', { id: '0203669b', state: 'blocked', sessionId: '0203669b-aaaa-4bbb-8ccc-dddddddddddd' }, opts(dead, ps([{ pid: 64, cmd: 'claude.exe --resume 0203669b-aaaa-4bbb-8ccc-dddddddddddd' }]))), false);
  assert.equal(serviceGone('0203669b', undefined, opts(dead, () => { throw new Error('WMI broke'); })), false, 'no process table: unknown');
});
