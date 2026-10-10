#!/usr/bin/env node
// Runs a command under a time limit that ends its whole process tree. git push and git fetch start pre-push hooks, ssh
// and remote helpers as children; a timeout that kills only git would leave them running (spec §6, S2).
// Usage: node tree-timeout.mjs <milliseconds> <command> [args...]
// stdin, stdout and stderr are the command's own. Exit: the command's status; 124 with "turbo: timed out" on stderr
// after the time limit; 127 when the command cannot start.
import { spawn, execFileSync } from 'node:child_process';

const [ms, cmd, ...args] = process.argv.slice(2);

function killTree(pid) {
  try {
    // Windows: taskkill ends the tree; elsewhere the command leads its own process group
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  killTree(child.pid);
}, Number(ms) || 60000);
child.on('error', (e) => {
  clearTimeout(timer);
  process.stderr.write(`${e.code || e.message}\n`);
  process.exit(127);
});
child.on('exit', (code) => {
  clearTimeout(timer);
  if (timedOut) {
    process.stderr.write('turbo: timed out, process tree ended\n');
    process.exit(124);
  }
  process.exit(code ?? 1);
});
