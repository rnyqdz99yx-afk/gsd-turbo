import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { projectHash } from '../lib/claude.mjs';
import { RUN_KEY, autostartKey, beatBeforeBoot, clearOwnerStop, logonCommand, logonSkip, readOwnerStop, runAutostart, writeOwnerStop } from '../lib/autostart.mjs';

// Gap 2 (v0.4.0): turbo-run autostart on|off|status. Every system command goes through the injected runner: no test
// ever calls reg, launchctl or systemctl. Files land in a throwaway home and config directory.
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const TURBO = 'C:\\Users\\dev\\.claude\\turbo\\bin\\turbo-run.mjs';

function setup({ platform = 'win32', answers = {} } = {}) {
  const home = tmpDir('home');
  const root = path.join(tmpDir('proj'), 'My App');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: path.join(home, '.claude'), SystemRoot: 'C:\\Windows', PATH: '/usr/local/bin:/usr/bin' };
  const calls = [];
  // answers: the first words of a command (its executable's base name and first argument) → its result
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${path.win32.basename(path.posix.basename(cmd))} ${args[0] === '--user' ? args[1] : args[0]}`;
    return { status: 0, stdout: '', stderr: '', ...(answers[key] || {}) };
  };
  const opts = { platform, root, node: NODE, turboRun: TURBO, env, home, uid: 501, run };
  return { home, root, env, calls, run, opts, key: autostartKey(root) };
}

test('the project key is the lane names\' slug and hash; the logon command is turbo-run start --autostart for the project', () => {
  const root = path.join(tmpDir('proj'), 'My App');
  assert.equal(autostartKey(root), `my-app-${projectHash(root)}`);
  assert.deepEqual(logonCommand({ node: NODE, turboRun: TURBO, root }), [NODE, TURBO, 'start', '--autostart', '--project', root]);
});

test('Windows on: a hidden launcher in turbo\'s directory and a per-user Run entry (no admin, no Task Scheduler); every change printed with the way back', () => {
  const s = setup();
  const r = runAutostart('on', s.opts);
  assert.equal(r.code, 0, r.lines.join('\n'));
  const launcher = path.join(s.env.CLAUDE_CONFIG_DIR, 'turbo', 'autostart', `${s.key}.js`);
  const raw = fs.readFileSync(launcher);
  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 with a BOM: Windows Script Host reads any path');
  const js = raw.subarray(2).toString('utf16le');
  // the window style 0 runs node without a console window; the command quotes every path
  const cmdLine = `"${NODE}" "${TURBO}" start --autostart --project "${s.root}"`;
  assert.ok(js.includes(`.Run(${JSON.stringify(cmdLine)}, 0, false)`), js);
  const reg = 'C:\\Windows\\System32\\reg.exe';
  const data = `"C:\\Windows\\System32\\wscript.exe" //E:JScript //B //NoLogo "${launcher}"`;
  assert.deepEqual(s.calls, [[reg, 'add', RUN_KEY, '/v', `gsd-turbo ${s.key}`, '/t', 'REG_SZ', '/d', data, '/f']]);
  assert.ok(r.lines.includes(`wrote ${launcher}`), r.lines.join('\n'));
  assert.ok(r.lines.some((l) => l.startsWith('ran: ') && l.includes(`reg.exe" add "${RUN_KEY}" /v "gsd-turbo ${s.key}"`)), r.lines.join('\n'));
  assert.ok(r.lines.some((l) => /^undo: turbo-run autostart off/.test(l)), r.lines.join('\n'));
});

test('Windows: a refused reg add leaves nothing behind; status reads the entry and the launcher; off removes both', () => {
  const refused = setup({ answers: { 'reg.exe add': { status: 1, stderr: 'ERROR: Access is denied.\r\n' } } });
  const r = runAutostart('on', refused.opts);
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-1), /^autostart not set: reg add failed: ERROR: Access is denied\.$/);
  assert.equal(fs.existsSync(path.join(refused.env.CLAUDE_CONFIG_DIR, 'turbo', 'autostart', `${refused.key}.js`)), false);

  const off = setup({ answers: { 'reg.exe query': { status: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' } } });
  assert.deepEqual(runAutostart('status', off.opts), { code: 0, lines: ['autostart: off'] });
  const s = setup();
  runAutostart('on', s.opts);
  const st = runAutostart('status', s.opts);
  assert.equal(st.code, 0);
  assert.match(st.lines[0], new RegExp(`^autostart: on \\(at logon: ${RUN_KEY.replace(/\\/g, '\\\\')} "gsd-turbo ${s.key}"\\)$`));
  const o = runAutostart('off', s.opts);
  assert.equal(o.code, 0, o.lines.join('\n'));
  assert.deepEqual(s.calls.at(-1), ['C:\\Windows\\System32\\reg.exe', 'delete', RUN_KEY, '/v', `gsd-turbo ${s.key}`, '/f']);
  assert.equal(fs.existsSync(path.join(s.env.CLAUDE_CONFIG_DIR, 'turbo', 'autostart', `${s.key}.js`)), false);
  assert.equal(o.lines.at(-1), 'autostart off');
  // off again: nothing is registered, nothing is deleted
  const again = runAutostart('off', { ...s.opts, run: (cmd, args) => (s.calls.push([cmd, ...args]), { status: args[0] === 'query' ? 1 : 0 }) });
  assert.deepEqual([again.code, again.lines, s.calls.at(-1)[1]], [0, ['autostart off'], 'query']);
});

test('Windows: a Run entry that cannot be removed keeps its launcher (no error box at the next logon) and says so', () => {
  const s = setup({ answers: { 'reg.exe delete': { status: 1, stderr: 'ERROR: Access is denied.' } } });
  runAutostart('on', s.opts);
  const o = runAutostart('off', s.opts);
  assert.equal(o.code, 1);
  assert.equal(o.lines.at(-1), 'autostart off failed: ERROR: Access is denied.; nothing else was changed');
  assert.ok(fs.existsSync(path.join(s.env.CLAUDE_CONFIG_DIR, 'turbo', 'autostart', `${s.key}.js`)));
});

test('macOS: on writes a LaunchAgent that runs at login with the PATH it was set up with; off unloads it and removes it', () => {
  const s = setup({ platform: 'darwin' });
  const r = runAutostart('on', s.opts);
  assert.equal(r.code, 0, r.lines.join('\n'));
  const plist = path.join(s.home, 'Library', 'LaunchAgents', `gsd-turbo.${s.key}.plist`);
  const xml = fs.readFileSync(plist, 'utf8');
  assert.match(xml, new RegExp(`<key>Label</key>\\s*<string>gsd-turbo\\.${s.key}</string>`));
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // the supervisor start spawns runs on after the login job ends
  assert.match(xml, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.ok(xml.includes('<string>--autostart</string>') && xml.includes(`<string>${s.root}</string>`), xml);
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/usr\/bin<\/string>/);
  assert.deepEqual(s.calls, [], 'nothing loads now: launchd runs it at the next login');
  assert.ok(r.lines.includes(`wrote ${plist}`));
  assert.match(runAutostart('status', s.opts).lines[0], /^autostart: on /);
  const o = runAutostart('off', s.opts);
  assert.deepEqual(s.calls, [['/bin/launchctl', 'bootout', `gui/501/gsd-turbo.${s.key}`]]);
  assert.equal(fs.existsSync(plist), false);
  assert.equal(o.code, 0);
});

test('Linux: a systemd user unit, enabled for the login session; without a systemd user session, a clear "not supported" and the line to add by hand', () => {
  const s = setup({ platform: 'linux', answers: { 'systemctl is-enabled': { stdout: 'enabled\n' } } });
  const r = runAutostart('on', s.opts);
  assert.equal(r.code, 0, r.lines.join('\n'));
  const unit = path.join(s.home, '.config', 'systemd', 'user', `gsd-turbo-${s.key}.service`);
  const text = fs.readFileSync(unit, 'utf8');
  // oneshot + RemainAfterExit: the supervisor the start spawns is not killed when the start exits
  assert.match(text, /^Type=oneshot$/m);
  assert.match(text, /^RemainAfterExit=yes$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.ok(text.includes(`ExecStart="${NODE.replace(/\\/g, '\\\\')}" "${TURBO.replace(/\\/g, '\\\\')}" start --autostart --project "${s.root.replace(/\\/g, '\\\\')}"`), text);
  assert.deepEqual(s.calls, [['systemctl', '--user', 'show-environment'], ['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', `gsd-turbo-${s.key}.service`]]);
  assert.match(runAutostart('status', s.opts).lines[0], /^autostart: on /);
  runAutostart('off', s.opts);
  assert.deepEqual(s.calls.slice(-2), [['systemctl', '--user', 'disable', `gsd-turbo-${s.key}.service`], ['systemctl', '--user', 'daemon-reload']]);
  assert.equal(fs.existsSync(unit), false);

  const none = setup({ platform: 'linux', answers: { 'systemctl show-environment': { status: 1, stderr: 'Failed to connect to bus' } } });
  const n = runAutostart('on', none.opts);
  assert.equal(n.code, 1);
  assert.match(n.lines.join('\n'), /not supported here \(no systemd user session\).*add this to your session's autostart/s);
  // a POSIX shell line, every path in single quotes (review m12)
  assert.ok(n.lines.join('\n').endsWith(`'${NODE}' '${TURBO}' start --autostart --project '${none.root}'`), n.lines.join('\n'));
  assert.deepEqual(none.calls, [['systemctl', '--user', 'show-environment']]);
  assert.equal(fs.existsSync(path.join(none.home, '.config', 'systemd')), false);
});

test('a path a logon command cannot carry (a line break, a JavaScript line separator, % on Windows) is refused before anything changes (review m4, m5)', () => {
  for (const [platform, bad] of [['linux', 'a\nExecStartPre=/bin/sh'], ['win32', 'a\u2028b'], ['win32', '%APPDATA%'], ['darwin', 'a\rb']]) {
    const s = setup({ platform });
    const r = runAutostart('on', { ...s.opts, root: path.join(s.root, bad) });
    assert.equal(r.code, 1, `${platform} ${JSON.stringify(bad)}`);
    assert.match(r.lines[0], /^autostart not set: .* has a character a logon command cannot carry/);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(fs.readdirSync(s.home), [], 'nothing written');
  }
  // % is fine outside Windows
  const mac = setup({ platform: 'darwin' });
  assert.equal(runAutostart('on', { ...mac.opts, root: path.join(mac.root, '100%') }).code, 0);
});

test('the files carry no project path in their comments (review m4)', () => {
  const s = setup();
  runAutostart('on', s.opts);
  const js = fs.readFileSync(path.join(s.env.CLAUDE_CONFIG_DIR, 'turbo', 'autostart', `${s.key}.js`)).subarray(2).toString('utf16le');
  assert.ok(js.split('\r\n').filter((l) => l.startsWith('//')).every((l) => !l.includes(s.root)), js);
  const mac = setup({ platform: 'darwin' });
  runAutostart('on', mac.opts);
  const xml = fs.readFileSync(path.join(mac.home, 'Library', 'LaunchAgents', `gsd-turbo.${mac.key}.plist`), 'utf8');
  assert.ok(!/<!--[^>]*My App/.test(xml), xml);
});

test('an unknown action is a usage error that changes nothing', () => {
  const s = setup();
  const r = runAutostart('maybe', s.opts);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /^usage: turbo-run autostart on\|off\|status/);
  assert.deepEqual(s.calls, []);
});

test('a start at logon comes back only for a run that was going when the machine went down, or halted by its lane session\'s failure', () => {
  const going = { pid: null, finished: false, halted: false, lane: { phase: '33', sessionId: 'x' } };
  assert.equal(logonSkip({ sup: going, ownerStop: null, alive: false }), null);
  assert.equal(logonSkip({ sup: { ...going, halted: true, haltedFor: 'sessionFailed' }, ownerStop: null, alive: false }), null);
  assert.match(logonSkip({ sup: null, ownerStop: null, alive: false }), /no run was ever started/);
  assert.match(logonSkip({ sup: { ...going, pid: 4242 }, ownerStop: null, alive: true }), /already runs \(pid 4242\)/);
  assert.match(logonSkip({ sup: going, ownerStop: { at: '2026-10-14T03:00:00.000Z' }, alive: false }), /stopped by the owner at 2026-10-14T03:00:00\.000Z/);
  assert.match(logonSkip({ sup: { ...going, finished: true }, ownerStop: null, alive: false }), /finished/);
  assert.match(logonSkip({ sup: { ...going, halted: true }, ownerStop: null, alive: false }), /halted.*turbo-run status/);
});

test('a heartbeat from before the machine started is a dead daemon\'s, however recent: after a quick reboot its pid may belong to another process (review I1)', () => {
  const now = Date.parse('2026-10-14T04:00:00.000Z');
  // booted 3 minutes ago: a supervisor that beat 5 minutes ago died with the machine
  assert.equal(beatBeforeBoot('2026-10-14T03:55:00.000Z', { now, uptimeSeconds: 180 }), true);
  assert.equal(beatBeforeBoot('2026-10-14T03:59:00.000Z', { now, uptimeSeconds: 180 }), false);
  // no heartbeat, or an unreadable one: not judged here (the heartbeat window does)
  assert.equal(beatBeforeBoot(null, { now, uptimeSeconds: 180 }), false);
  assert.equal(beatBeforeBoot('x', { now, uptimeSeconds: 180 }), false);
  // an uptime that cannot be read proves nothing
  assert.equal(beatBeforeBoot('2026-10-14T03:55:00.000Z', { now, uptimeSeconds: NaN }), false);
});

test('the owner\'s stop mark is written, read and cleared in the run directory', () => {
  const root = tmpDir('proj');
  fs.mkdirSync(path.join(root, '.planning'));
  assert.equal(readOwnerStop(root), null);
  writeOwnerStop(root, '2026-10-14T03:00:00.000Z');
  assert.deepEqual(readOwnerStop(root), { at: '2026-10-14T03:00:00.000Z' });
  assert.ok(fs.existsSync(path.join(root, '.planning', 'turbo', 'run', 'owner-stop.json')));
  clearOwnerStop(root);
  assert.equal(readOwnerStop(root), null);
  clearOwnerStop(root); // nothing to clear: no error
});
