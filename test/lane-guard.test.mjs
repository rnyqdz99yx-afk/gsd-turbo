import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { GUARD_MATCHER, decodeGuardArg, encodeGuardArg, guardCommand, guardDecision, guardHooks, hookOutput, readStdin, windowsPath } from '../lib/lane-guard.mjs';
import { GUARD_SCRIPT, buildBgArgs } from '../lib/claude.mjs';

// Smoke F2: GSD executors in lanes wrote TDD captures into the folder above the slots (the owner's Desktop); the write
// guard denies a file tool's write outside the lane's checkout, its temp directory and the control root's .planning/turbo.

// A Windows file system on any machine: the existing directories (their real spelling), and links: 8.3 short names and
// junctions, each mapping a prefix to its real path. Anything else does not exist (ENOENT), as fs.realpathSync.native.
function fakeWin({ dirs, links = {} }) {
  const real = new Map(dirs.map((d) => [d.toLowerCase(), d]));
  return (p) => {
    let q = p;
    for (const [from, to] of Object.entries(links)) if (q.toLowerCase() === from.toLowerCase() || q.toLowerCase().startsWith(`${from.toLowerCase()}\\`)) q = to + q.slice(from.length);
    const hit = real.get(q.toLowerCase().replace(/\\$/, '') || q.toLowerCase());
    if (!hit) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return hit;
  };
}

const WIN = {
  slot: 'C:\\Users\\dev\\Desktop\\demo-app.turbo\\lane-1',
  tmp: 'C:\\Users\\dev\\.claude\\turbo\\tmp\\0123456789abcdef\\p2',
  control: 'C:\\Users\\dev\\Desktop\\demo-app',
};
const winFs = fakeWin({
  dirs: ['C:\\', 'C:\\Users', 'C:\\Users\\dev', 'C:\\Users\\dev\\Desktop', 'C:\\Users\\dev\\Desktop\\demo-app', 'C:\\Users\\dev\\Desktop\\demo-app\\.planning', 'C:\\Users\\dev\\Desktop\\demo-app\\.planning\\turbo',
    'C:\\Users\\dev\\Desktop\\demo-app.turbo', WIN.slot, `${WIN.slot}\\src`, 'C:\\Users\\dev\\.claude', 'C:\\Users\\dev\\.claude\\turbo', 'C:\\Users\\dev\\.claude\\turbo\\tmp', 'C:\\Users\\dev\\.claude\\turbo\\tmp\\0123456789abcdef', WIN.tmp,
    'D:\\', 'D:\\cache'],
  // the 8.3 name of the user folder, and a junction in the slot that leads out to the Desktop
  links: { 'C:\\Users\\DEVELO~1': 'C:\\Users\\dev', [`${WIN.slot}\\out`]: 'C:\\Users\\dev\\Desktop' },
});
const winRoots = [WIN.slot, WIN.tmp, `${WIN.control}\\.planning\\turbo`];
const win = (file_path, extra = {}) => guardDecision({ tool: 'Write', input: { file_path }, cwd: WIN.slot, roots: winRoots, tmp: WIN.tmp, platform: 'win32', realpath: winFs, ...extra });

test('Windows paths: inside the slot, the temp directory and the control root\'s .planning/turbo are allowed, in any case, slash or spelling', () => {
  for (const p of [
    `${WIN.slot}\\src\\app.ts`,
    `${WIN.slot}\\src\\new\\deep\\file.ts`, // not there yet: its nearest existing parent decides
    'c:\\users\\DEV\\desktop\\DEMO-APP.TURBO\\Lane-1\\README.md', // case: drive letter and every folder
    'C:/Users/dev/Desktop/demo-app.turbo/lane-1/src/x.ts', // forward slashes
    '/c/Users/dev/Desktop/demo-app.turbo/lane-1/src/x.ts', // Git Bash
    '/cygdrive/c/Users/dev/Desktop/demo-app.turbo/lane-1/x.ts', // Cygwin
    '\\\\?\\C:\\Users\\dev\\Desktop\\demo-app.turbo\\lane-1\\x.ts', // the long-path prefix
    'C:\\Users\\DEVELO~1\\Desktop\\demo-app.turbo\\lane-1\\x.ts', // an 8.3 short name
    'src\\relative.ts', // relative: from the hook input's cwd
    `${WIN.tmp}\\capture-red.mjs`,
    'C:\\Users\\DEVELO~1\\.claude\\turbo\\tmp\\0123456789ABCDEF\\p2\\red-t1.json',
    `${WIN.control}\\.planning\\turbo\\run\\annotate\\analysis.json`,
  ]) assert.deepEqual(win(p), { allow: true }, p);
});

test('Windows paths: the smoke F2 files, a relative path out of the slot, the home folder, a junction out and another drive are denied with the lane\'s temp directory named', () => {
  for (const p of [
    'C:\\Users\\dev\\Desktop\\exec-02-01-tools\\capture-red.mjs', // the parent of <repo>.turbo
    'C:\\Users\\dev\\Desktop\\exec-03-01\\mut-empty.json',
    '..\\..\\exec-03-01\\capture.mjs', // relative, from the slot
    '../red-t1.json', // into the slots folder
    'C:\\Users\\dev\\Desktop\\demo-app.turbo\\lane-10\\x.ts', // a sibling slot whose name starts with lane-1
    'C:\\Users\\dev\\Desktop\\demo-app\\src\\main.ts', // the control root outside .planning/turbo
    'C:\\Users\\DEVELO~1\\Desktop\\x.mjs',
    'C:\\Users\\dev\\notes.md',
    `${WIN.slot}\\out\\leak.txt`, // a junction inside the slot that leads to the Desktop
    'D:\\cache\\x.json',
    '/tmp/x.json', // Git Bash's /tmp is not the lane's temp directory
  ]) {
    const d = win(p);
    assert.equal(d.allow, false, p);
    assert.ok(d.reason.includes('C:/Users/dev/.claude/turbo/tmp/0123456789abcdef/p2'), d.reason);
    assert.ok(d.reason.includes('outside this lane\'s checkout C:/Users/dev/Desktop/demo-app.turbo/lane-1'), d.reason);
    assert.ok(d.reason.includes('TMP, TEMP and TMPDIR point there'), d.reason);
  }
  assert.match(win('C:\\Users\\dev\\Desktop\\exec-02-01-tools\\capture-red.mjs').reason, /^gsd-turbo lane guard: c:\/users\/dev\/desktop\/exec-02-01-tools\/capture-red\.mjs lies outside/i);
});

test('windowsPath: Git Bash and Cygwin drive paths, the \\\\?\\ prefix and UNC; anything else unchanged', () => {
  assert.equal(windowsPath('/c/Users/dev/x'), 'c:\\Users\\dev\\x');
  assert.equal(windowsPath('/D'), 'D:\\');
  assert.equal(windowsPath('/cygdrive/e/data'), 'e:\\data');
  assert.equal(windowsPath('\\\\?\\C:\\x'), 'C:\\x');
  assert.equal(windowsPath('//?/C:/x'), 'C:/x');
  assert.equal(windowsPath('\\\\?\\UNC\\server\\share\\x'), '\\\\server\\share\\x');
  for (const p of ['/tmp/x', 'C:\\x', 'rel\\x', '\\\\server\\share']) assert.equal(windowsPath(p), p);
});

test('POSIX paths on a real file system: links resolved, sibling prefixes and the folder above the slots denied', () => {
  const base = tmpDir('guard');
  const slot = path.join(base, 'demo-app.turbo', 'lane-1');
  const tmp = path.join(base, 'cfg', 'turbo', 'tmp', '0123456789abcdef', 'p2');
  const control = path.join(base, 'demo-app');
  for (const d of [path.join(slot, 'src'), tmp, path.join(control, '.planning', 'turbo', 'run'), path.join(base, 'demo-app.turbo', 'lane-10')]) fs.mkdirSync(d, { recursive: true });
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(base, path.join(slot, 'up'), kind);
  fs.symlinkSync(path.join(slot, 'src'), path.join(base, 'to-src'), kind);
  const roots = [slot, tmp, path.join(control, '.planning', 'turbo')];
  const d = (p, tool = 'Write') => guardDecision({ tool, input: tool === 'NotebookEdit' ? { notebook_path: p } : { file_path: p }, cwd: slot, roots, tmp }).allow;
  for (const p of [path.join(slot, 'src', 'a.ts'), 'src/b.ts', path.join(tmp, 'capture.mjs'), path.join(control, '.planning', 'turbo', 'run', 'x.json'), path.join(base, 'to-src', 'c.ts')]) assert.equal(d(p), true, p);
  for (const p of [path.join(base, 'exec-02-01-tools', 'capture-red.mjs'), '../../exec-03-01/capture.mjs', '../lane-10/x', path.join(slot, 'up', 'leak.txt'), path.join(control, 'src', 'x.ts'), '/etc/x']) assert.equal(d(p), false, p);
  for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) assert.equal(d('/etc/x.ipynb', tool), false, tool);
});

test('nothing to decide allows: another tool, no path, no roots; the hook prints a deny only and allows what it cannot read', () => {
  // POSIX paths on any machine (on win32, /w/slot is Git Bash's spelling of W:\slot): a file system where nothing exists
  const posix = { platform: 'linux', realpath: (p) => { throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); } };
  const base = { cwd: '/w/slot', roots: ['/w/slot'], tmp: '/t', ...posix };
  assert.deepEqual(guardDecision({ ...base, tool: 'Bash', input: { command: 'echo x > /etc/x' } }), { allow: true });
  assert.deepEqual(guardDecision({ ...base, tool: 'Read', input: { file_path: '/etc/x' } }), { allow: true });
  assert.deepEqual(guardDecision({ ...base, tool: 'Write', input: {} }), { allow: true });
  assert.deepEqual(guardDecision({ ...base, tool: 'Write', input: { file_path: '/etc/x' }, roots: [] }), { allow: true });

  const arg = encodeGuardArg({ roots: ['/w/slot', '/t'], tmp: '/t' });
  const call = (file_path) => JSON.stringify({ session_id: 's', cwd: '/w/slot', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: 'x' } });
  assert.equal(hookOutput(call('/w/slot/a.ts'), arg, posix), '');
  const out = JSON.parse(hookOutput(call('/w/exec-02-01/capture.mjs'), arg, posix));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /\/w\/exec-02-01\/capture\.mjs lies outside this lane's checkout \/w\/slot\. Write temporary files .* under \/t:/);
  for (const [stdin, a] of [['not json', arg], [call('/etc/x'), 'not base64 json'], [call('/etc/x'), undefined]]) assert.equal(hookOutput(stdin, a, posix), '', String(a));
});

test('the hook command: the script quoted for every shell, the settings in one base64url argument', () => {
  const settings = { roots: ['C:\\Users\\dev\\demo app.turbo\\lane-1', "C:\\Users\\dev's\\tmp"], tmp: "C:\\Users\\dev's\\tmp" };
  assert.deepEqual(decodeGuardArg(encodeGuardArg(settings)), settings);
  assert.match(encodeGuardArg(settings), /^[A-Za-z0-9_-]+$/);
  const w = guardCommand({ script: 'C:\\Program Files\\gsd-turbo\\lib\\lane-guard-hook.mjs', ...settings, platform: 'win32' });
  assert.equal(w, `node "C:/Program Files/gsd-turbo/lib/lane-guard-hook.mjs" ${encodeGuardArg(settings)}`);
  assert.equal(guardCommand({ script: "/home/dev/it's/lane-guard-hook.mjs", roots: ['/a'], tmp: '/t', platform: 'linux' }), `node '/home/dev/it'\\''s/lane-guard-hook.mjs' ${encodeGuardArg({ roots: ['/a'], tmp: '/t' })}`);
  const h = guardHooks({ script: '/x/lane-guard-hook.mjs', roots: ['/a'], tmp: '/t', platform: 'linux' });
  assert.deepEqual(Object.keys(h), ['PreToolUse']);
  assert.equal(h.PreToolUse[0].matcher, GUARD_MATCHER);
  assert.equal(GUARD_MATCHER, 'Write|Edit|MultiEdit|NotebookEdit');
  assert.deepEqual({ ...h.PreToolUse[0].hooks[0], command: '' }, { type: 'command', command: '', timeout: 10 });
});

test('the hook script itself: reads the call on stdin, always exits 0, prints the deny JSON or nothing', () => {
  const slot = tmpDir('guard-slot');
  const arg = encodeGuardArg({ roots: [slot], tmp: path.join(slot, 't') });
  const run = (file_path) => execFileSync(process.execPath, [GUARD_SCRIPT, arg], { input: JSON.stringify({ cwd: slot, tool_name: 'Write', tool_input: { file_path } }), encoding: 'utf8' });
  assert.equal(run(path.join(slot, 'a.txt')), '');
  const denied = JSON.parse(run(path.join(path.dirname(slot), 'exec-02-01-tools', 'capture-red.mjs')));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(execFileSync(process.execPath, [GUARD_SCRIPT], { input: 'garbage', encoding: 'utf8' }), '');
  // an empty stdin (the null device): allowed, exit 0
  const closed = spawnSync(process.execPath, [GUARD_SCRIPT, arg], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  assert.deepEqual([closed.status, closed.stdout], [0, '']);
});

test('readStdin: the whole input across reads; a Windows pipe\'s EOF error ends it, a non-blocking pipe\'s EAGAIN is waited out, anything else throws', () => {
  // answers: a Buffer (its bytes are read), an error code (thrown), or 0 (the end)
  const reader = (answers) => {
    const left = [...answers];
    return (fd, buf) => {
      const a = left.length ? left.shift() : 0;
      if (typeof a === 'string') throw Object.assign(new Error(a), { code: a });
      if (!a) return 0;
      return a.copy(buf);
    };
  };
  const b = (s) => Buffer.from(s);
  const u = Buffer.from('"ü"}');
  const slept = [];
  const sleep = (ms) => slept.push(ms);
  assert.equal(readStdin({ readSync: reader([b('{"tool_name":'), b('"Write"}'), 0]), sleep }), '{"tool_name":"Write"}');
  assert.equal(readStdin({ readSync: reader([b('{"a":'), b('"ü"}'), 'EOF']), sleep }), '{"a":"ü"}', 'EOF where a 0 was due');
  // the two bytes of ü split across reads still decode as one character
  assert.equal(readStdin({ readSync: reader([b('{"a":'), u.subarray(0, 2), u.subarray(2), 0]), sleep }), '{"a":"ü"}');
  assert.equal(readStdin({ readSync: reader(['EAGAIN', b('{}'), 'EAGAIN', 0]), sleep }), '{}');
  assert.deepEqual(slept, [10, 10]);
  assert.throws(() => readStdin({ readSync: reader(['EBADF']), sleep }), /EBADF/);
  assert.throws(() => readStdin({ readSync: reader(Array(5).fill('EAGAIN')), sleep, maxWaits: 3 }), /EAGAIN/);
  // the pauses count in a row only: data in between starts the count again
  assert.equal(readStdin({ readSync: reader(['EAGAIN', 'EAGAIN', 'EAGAIN', b('{'), 'EAGAIN', 'EAGAIN', 'EAGAIN', b('}'), 0]), sleep, maxWaits: 3 }), '{}');
});

test('a lane launch gets the guard over its checkout, temp directory and control root\'s .planning/turbo; lanes.write_guard false, or no temp directory, gets none', () => {
  const opts = { name: 'n', prompt: 'P', systemPrompt: 'S', permissionMode: 'auto', model: '' };
  const settings = (more) => {
    const args = buildBgArgs({ ...opts, ...more });
    return JSON.parse(args[args.indexOf('--settings') + 1]);
  };
  const slot = path.resolve('/w/demo-app.turbo/lane-1');
  const tmp = path.resolve('/c/turbo/tmp/k/p2');
  const control = path.resolve('/w/demo-app');
  const s = settings({ tmpDir: tmp, controlRoot: control, cwd: slot });
  const cmd = s.hooks.PreToolUse[0].hooks[0].command;
  assert.deepEqual(decodeGuardArg(cmd.split(' ').at(-1)), { roots: [slot, tmp, path.join(control, '.planning', 'turbo')], tmp });
  assert.deepEqual(decodeGuardArg(settings({ tmpDir: tmp, cwd: slot }).hooks.PreToolUse[0].hooks[0].command.split(' ').at(-1)).roots, [slot, tmp], 'a v0.3 lane: its checkout and temp directory');
  assert.equal(settings({ tmpDir: tmp, cwd: slot, guard: false }).hooks, undefined);
  assert.equal(settings({ cwd: slot }).hooks, undefined);
  assert.equal(settings({ tmpDir: tmp }).hooks, undefined);
  assert.deepEqual(s.env, { TURBO_LANE: '1', TMP: tmp, TEMP: tmp, TMPDIR: tmp, TURBO_CONTROL_ROOT: control });
});
