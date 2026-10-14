// Gap 2 (v0.4.0): the opt-in restart of a project's supervisor after a reboot (turbo-run autostart on|off|status), and
// the owner's stop mark that start at logon respects. Every system change is printed, and off undoes it; the commands
// run through an injected runner (tests never call reg, launchctl or systemctl).
//
// Windows: a per-user Run entry (HKCU, no admin) that starts a hidden launcher. Not Task Scheduler: an ONLOGON task
// needs an administrator (schtasks /Create /SC ONLOGON answers "Access is denied" to a standard user), and Task
// Scheduler ends every process a task started when the task's own process exits, so the supervisor start spawns, and
// a Claude Code background service that supervisor starts, would die with it. Explorer starts a Run entry like any
// program of the user's: the supervisor lives on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectHash } from './claude.mjs';
import { runDir, turboHome } from './paths.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fsx.mjs';

// ---- the owner's stop (turbo-run stop) ----
// turbo-run stop leaves it; start and resume, the owner's own, clear it. A start at logon does nothing while it stands.
const stopFile = (root) => path.join(runDir(root), 'owner-stop.json');
export const readOwnerStop = (root) => readJson(stopFile(root), null);
export const writeOwnerStop = (root, at = new Date().toISOString()) => writeJsonAtomic(stopFile(root), { at });
export const clearOwnerStop = (root) => fs.rmSync(stopFile(root), { force: true });

// Why a start at logon (turbo-run start --autostart) starts nothing, or null when it starts the supervisor: only a run
// that was going when the machine went down, or that halted because its lane's session failed (haltedFor, set by the
// supervisor), comes back. sup: supervisor.json; ownerStop: the stop mark; alive: whether its daemon runs.
export function logonSkip({ sup, ownerStop, alive }) {
  if (!sup) return 'no run was ever started in this project';
  if (alive) return `the supervisor already runs (pid ${sup.pid})`;
  if (ownerStop) return `the run was stopped by the owner${ownerStop.at ? ` at ${ownerStop.at}` : ''} (turbo-run stop)`;
  if (sup.finished) return 'the run finished';
  if (sup.halted && sup.haltedFor !== 'sessionFailed') return 'the run halted and waits for the owner (turbo-run status)';
  return null;
}

// ---- turbo-run autostart ----
// The project's key: the slug and hash its lane sessions are named with (lib/claude.mjs laneSessionName).
export function autostartKey(root) {
  const abs = path.resolve(root);
  const slug = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return `${slug}-${projectHash(abs)}`;
}
// What runs at logon: the owner's start, marked as the logon's (bin/turbo-run.mjs startAtLogon decides).
export const logonCommand = ({ node, turboRun, root }) => [node, turboRun, 'start', '--autostart', '--project', root];

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const USAGE = 'usage: turbo-run autostart on|off|status [--project <dir>]';

// One argument of a Windows command line (the C runtime's rules): quoted, a quote and the backslashes before it or
// before the closing quote escaped.
const winQuote = (s) => `"${String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
const winLine = (argv) => argv.map((a, i) => (i === 0 || a.includes(' ') || a.includes('\\') || a.includes('"') ? winQuote(a) : a)).join(' ');
// A systemd value in double quotes: C escapes, and % (specifiers) doubled; in ExecStart $ is doubled too (no expansion).
const sdQuote = (s, exec = true) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, exec ? '$$$$' : '$')}"`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shown = (argv) => argv.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a}"`)).join(' ');
const firstLine = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
// The environment a login job gets from launchd or systemd is bare: the PATH that finds claude, node and git, and the
// Claude Code config directory, as they are now.
const keptEnv = (env) => Object.fromEntries([['PATH', env.PATH ?? env.Path], ['CLAUDE_CONFIG_DIR', env.CLAUDE_CONFIG_DIR]].filter(([, v]) => v));

function windowsPlan({ root, node, turboRun, env, key }) {
  const sys = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
  const reg = path.win32.join(sys, 'reg.exe');
  const name = `gsd-turbo ${key}`;
  const launcher = path.join(turboHome(env), 'autostart', `${key}.js`);
  // JScript run by Windows Script Host: node with window style 0 (no console window), not waited for
  const command = winLine(logonCommand({ node, turboRun, root }));
  const js = [
    `// gsd-turbo: starts the supervisor of ${root} at logon, without a console window.`,
    '// Written by turbo-run autostart on; removed by turbo-run autostart off.',
    `new ActiveXObject('WScript.Shell').Run(${JSON.stringify(command).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}, 0, false);`,
    '',
  ].join('\r\n');
  const data = `${winQuote(path.win32.join(sys, 'wscript.exe'))} //E:JScript //B //NoLogo ${winQuote(launcher)}`;
  return {
    when: 'logon',
    where: `${RUN_KEY} "${name}"`,
    files: [{ file: launcher, data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(js, 'utf16le')]) }],
    on: [[reg, 'add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', data, '/f']],
    off: [[reg, 'delete', RUN_KEY, '/v', name, '/f']],
    query: [reg, 'query', RUN_KEY, '/v', name],
    shownCmd: (argv) => winLine(argv),
  };
}

function launchdPlan({ root, node, turboRun, env, home, uid, key }) {
  const label = `gsd-turbo.${key}`;
  const file = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const vars = Object.entries(keptEnv(env)).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- gsd-turbo: starts the supervisor of ${xml(root)} at login. Written by turbo-run autostart on; removed by off. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${logonCommand({ node, turboRun, root }).map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
</dict>
</plist>
`;
  return {
    when: 'login',
    where: file,
    loadsLater: true,
    files: [{ file, data: plist }],
    on: [],
    // unloads it when a login loaded it; nothing to unload is no failure
    off: [['/bin/launchctl', 'bootout', `gui/${uid}/${label}`]],
    offMayFail: true,
    query: null,
  };
}

function systemdPlan({ root, node, turboRun, env, home, key }) {
  const unit = `gsd-turbo-${key}.service`;
  const file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', unit);
  const text = [
    '# gsd-turbo: starts the supervisor of the project at login. Written by turbo-run autostart on; removed by off.',
    '[Unit]',
    `Description=gsd-turbo supervisor start for ${root.replace(/%/g, '%%')}`,
    '',
    '[Service]',
    // the start spawns the supervisor and exits; RemainAfterExit keeps the unit, and so the supervisor, until logout
    'Type=oneshot',
    'RemainAfterExit=yes',
    ...Object.entries(keptEnv(env)).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`, false)}`),
    `ExecStart=${logonCommand({ node, turboRun, root }).map((a, i) => (i < 2 || i === 5 ? sdQuote(a) : a)).join(' ')}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  return {
    when: 'login',
    where: `systemd user unit ${unit}`,
    probe: ['systemctl', '--user', 'show-environment'],
    files: [{ file, data: text }],
    on: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', unit]],
    off: [['systemctl', '--user', 'disable', unit]],
    offMayFail: true,
    afterOff: [['systemctl', '--user', 'daemon-reload']],
    query: ['systemctl', '--user', 'is-enabled', unit],
    enabledWord: 'enabled',
  };
}

const defaultRun = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });

// turbo-run autostart <action> for the project at root: { code, lines } for the CLI to print. node and turboRun are
// what runs at logon (the node and the turbo-run.mjs of this call); platform, env, home and uid are the machine's.
export function runAutostart(action, { platform = process.platform, root, node, turboRun, env = process.env, home = os.homedir(), uid = process.getuid?.() ?? 0, run = defaultRun }) {
  if (!['on', 'off', 'status'].includes(action)) return { code: 1, lines: [USAGE] };
  const key = autostartKey(root);
  const by = { node, turboRun, root };
  const plan = platform === 'win32' ? windowsPlan({ root, node, turboRun, env, key })
    : platform === 'darwin' ? launchdPlan({ root, node, turboRun, env, home, uid, key })
    : platform === 'linux' ? systemdPlan({ root, node, turboRun, env, home, key }) : null;
  const lines = [];
  const call = (argv) => {
    const r = run(argv[0], argv.slice(1)) || {};
    lines.push(`ran: ${(plan?.shownCmd || shown)(argv)}`);
    return { ok: !r.error && r.status === 0, why: firstLine(r.stderr) || firstLine(r.error?.message) || `exit status ${r.status}`, stdout: String(r.stdout ?? '') };
  };
  const byHand = `add this to your session's autostart: ${winLine(logonCommand(by))}`;
  const unsupported = (why) => ({ code: action === 'on' ? 1 : 0, lines: [action === 'status' ? `autostart: off (not supported here: ${why})` : `autostart is not supported here (${why}); to start the supervisor at login, ${byHand}`] });
  if (!plan) return unsupported(`no autostart for ${platform}`);
  if (plan.probe) {
    const r = run(plan.probe[0], plan.probe.slice(1)) || {};
    if (r.error || r.status !== 0) {
      // off still removes a unit an earlier on wrote
      if (action !== 'off' || !plan.files.some((f) => fs.existsSync(f.file))) return unsupported('no systemd user session');
    }
  }
  const present = plan.files.filter((f) => fs.existsSync(f.file));
  if (action === 'status') {
    // registered: the Run entry or the enabled unit; a LaunchAgent is its file
    let registered = present.length === plan.files.length;
    if (plan.query) {
      const r = run(plan.query[0], plan.query.slice(1)) || {};
      registered = !r.error && r.status === 0 && (!plan.enabledWord || String(r.stdout ?? '').trim() === plan.enabledWord);
    }
    if (present.length === plan.files.length && registered) return { code: 0, lines: [`autostart: on (at ${plan.when}: ${plan.where})`] };
    if (!present.length && !registered) return { code: 0, lines: ['autostart: off'] };
    return { code: 0, lines: [`autostart: incomplete (at ${plan.when}: ${plan.where}: ${present.length ? 'the file is there, the registration is not' : 'registered, its file is missing'}); run turbo-run autostart on again, or off`] };
  }
  if (action === 'on') {
    for (const f of plan.files) {
      ensureDir(path.dirname(f.file));
      fs.writeFileSync(f.file, f.data);
      lines.push(`wrote ${f.file}`);
    }
    for (const argv of plan.on) {
      const r = call(argv);
      if (r.ok) continue;
      // nothing half done stays: the files go again
      for (const f of plan.files) fs.rmSync(f.file, { force: true });
      for (const a of plan.afterOff || []) call(a);
      lines.push(`autostart not set: ${path.win32.basename(path.posix.basename(argv[0])).replace(/\.exe$/i, '')} ${argv[1] === '--user' ? argv[2] : argv[1]} failed: ${r.why}`);
      return { code: 1, lines };
    }
    lines.push(`autostart on: the supervisor of ${root} starts at ${plan.when}${plan.loadsLater ? ', from your next login' : ''} (${plan.where})`);
    lines.push(`  it runs turbo-run start --autostart: nothing starts when the run finished, halted for you, or you stopped it (turbo-run stop)`);
    lines.push('undo: turbo-run autostart off');
    return { code: 0, lines };
  }
  // off: unregister what is registered, then remove the files; a registration that cannot be removed keeps its files
  // (a Run entry whose launcher is gone would show an error at every logon)
  const registered = plan.query ? quietly(run, plan.query) : true;
  if (registered) {
    for (const argv of plan.off) {
      const r = call(argv);
      if (r.ok || plan.offMayFail) continue;
      lines.push(`autostart off failed: ${r.why}; nothing else was changed`);
      return { code: 1, lines };
    }
  }
  for (const f of present) {
    fs.rmSync(f.file, { force: true });
    lines.push(`removed ${f.file}`);
  }
  for (const a of plan.afterOff || []) call(a);
  lines.push('autostart off');
  return { code: 0, lines };
}

// A query run without a line printed: whether it succeeded.
function quietly(run, argv) {
  const r = run(argv[0], argv.slice(1)) || {};
  return !r.error && r.status === 0;
}
