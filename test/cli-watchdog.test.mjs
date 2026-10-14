import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';

// The supervisor's watchdog on the command line (lib/watchdog.mjs): the owner's view on the mod's clock
// (view --watchdog) and a lane at its inbox, ask or lane-status tell the owner once that the supervisor died without
// a word; a lane never starts it.
const CLI = path.resolve('bin/turbo-run.mjs');
// Far above any real pid limit (Linux 2^22, macOS 99999; Windows pids are small multiples of 4).
const DEAD_PID = 2147483644;
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
// a machine up for 30 days: a heartbeat 30 minutes old is no heartbeat from before the boot (CI machines boot minutes before)
const LONG_UP = String(30 * 24 * 3600);

// Preloaded with --require: every execFile call (the desktop notification) is recorded with its title and answered
// without running anything.
function notifySpy() {
  const cp = require('node:child_process');
  const fs = require('node:fs');
  cp.execFile = function (cmd, args, opts, cb) {
    const done = [opts, cb].find((f) => typeof f === 'function');
    fs.appendFileSync(process.env.TURBO_SPY_LOG, JSON.stringify({ title: (opts && opts.env && opts.env.TURBO_NOTIFY_TITLE) || null }) + '\n');
    process.nextTick(() => done(null, '', ''));
    return null;
  };
  require('node:module').syncBuiltinESMExports();
}

function project(sup = { pid: DEAD_PID, updatedAt: ago(30), finished: false, halted: false, lane: { phase: '1', sessionId: 's1' } }) {
  const base = tmpDir('wdcli');
  const root = path.join(base, 'my-app');
  const run = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ notify: { desktop: true, telegram: false }, lanes: { mode: 'checkout' } }));
  fs.writeFileSync(path.join(run, 'supervisor.json'), JSON.stringify(sup));
  const preload = path.join(base, 'spy.cjs');
  const spyLog = path.join(base, 'spy.jsonl');
  fs.writeFileSync(preload, `(${notifySpy})();\n`);
  const home = tmpDir('home');
  const cli = (args, env = {}) => spawnSync(process.execPath, ['--require', preload, CLI, ...args], {
    cwd: root,
    env: { ...process.env, CLAUDE_CONFIG_DIR: home, TURBO_SPY_LOG: spyLog, TURBO_LANE: '', TURBO_UPTIME_SECONDS: LONG_UP, ...env },
    encoding: 'utf8',
    windowsHide: true,
  });
  const told = () => (fs.existsSync(spyLog) ? fs.readFileSync(spyLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const log = () => { try { return fs.readFileSync(path.join(root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8'); } catch { return ''; } };
  return { root, cli, told, log, mark: path.join(run, 'supervisor-down.json'), sup: path.join(run, 'supervisor.json') };
}

test('the mod\'s view (view --json --watchdog) tells the owner once that the supervisor died without a word; a plain view tells nobody', () => {
  const p = project();
  const plain = p.cli(['view', '--json']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).supervisor.running, false);
  assert.deepEqual(p.told(), []);
  assert.equal(fs.existsSync(p.mark), false);
  const r = p.cli(['view', '--json', '--watchdog']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).supervisor.running, false, 'the view is the same');
  assert.deepEqual(p.told(), [{ title: 'The supervisor stopped' }]);
  assert.match(p.log(), new RegExp(`watchdog: supervisor pid ${DEAD_PID} has not checked in since \\S+ and left no exit line; owner told \\(seen by the owner's view\\)`));
  // the next tick of the clock tells nobody again
  assert.equal(p.cli(['view', '--json', '--watchdog']).status, 0);
  assert.equal(p.told().length, 1);
});

test('a lane at its inbox, ask and lane-status gets the line and tells the owner once; outside a lane nothing happens', () => {
  const p = project();
  const notLane = p.cli(['inbox', '1']);
  assert.equal(notLane.status, 0, notLane.stderr);
  assert.equal(notLane.stderr, '');
  assert.equal(fs.existsSync(p.mark), false, 'a phase run by hand expects no supervisor');
  const lane = { TURBO_LANE: '1' };
  const inbox = p.cli(['inbox', '1'], lane);
  assert.equal(inbox.status, 0, inbox.stderr);
  assert.equal(inbox.stdout, 'inbox 1: nothing new\n', 'the inbox prints what it always prints');
  assert.match(inbox.stderr, new RegExp(`^warn: the supervisor is not running \\(pid ${DEAD_PID}, last check-in \\S+\\); the owner is told\\. Go on: only the owner starts it\\n$`));
  assert.equal(p.told().length, 1);
  assert.match(p.log(), /\(seen by the lane of phase 1 \(inbox\)\)/);
  const status = p.cli(['lane-status', '1', 'needs-owner', '--reason', 'owner question ask-1'], lane);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stderr, /^warn: the supervisor is not running .*; the owner was told\. Go on: only the owner starts it$/m);
  // ask looks before it checks its own arguments
  const ask = p.cli(['ask', '1', '--question', 'Which one?', '--option', 'a|first', '--option', 'b|second'], lane);
  assert.match(ask.stderr, /^warn: the supervisor is not running .*the owner was told/m);
  assert.equal(p.told().length, 1, 'told once for the dead daemon');
});

test('a running supervisor, or one the owner stopped: the lane gets no line', () => {
  const alive = project({ pid: process.pid, updatedAt: new Date().toISOString(), finished: false, halted: false });
  assert.equal(alive.cli(['inbox', '1'], { TURBO_LANE: '1' }).stderr, '');
  const stopped = project({ pid: null, updatedAt: ago(30), finished: false, halted: false });
  assert.equal(stopped.cli(['inbox', '1'], { TURBO_LANE: '1' }).stderr, '');
  assert.deepEqual([alive.told(), stopped.told()], [[], []]);
});

test('a lane never starts the supervisor: start refuses inside a lane and changes nothing', () => {
  const p = project();
  const before = fs.readFileSync(p.sup, 'utf8');
  const r = p.cli(['start'], { TURBO_LANE: '1' });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "refused: start is the owner's: a lane never runs it\n");
  assert.equal(fs.readFileSync(p.sup, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(p.root, '.planning', 'turbo', 'logs', 'supervisor.log')), false, 'no daemon was spawned');
});
