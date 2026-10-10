import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { describeRecord, requestFile, recordFile } from '../lib/push.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', windowsHide: true });

function writeConfig(root, obj) {
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify(obj));
}

test('a bad push setting stops status and start with one config line and exit 1 (S2)', () => {
  const root = tmpDir('pushcfg');
  writeConfig(root, { push: { mode: 'after_wave' } });
  for (const args of [['status'], ['start']]) {
    const r = cli(args, root);
    assert.equal(r.status, 1, args[0]);
    assert.equal(r.stderr.trim(), 'invalid turbo config push.mode: must be one of off, after-wave, after-phase');
  }
});

const head = (root) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
function laneRepo(push = { mode: 'after-phase' }) {
  const root = tmpGitRepo();
  writeConfig(root, { push });
  return root;
}
// a fake clock that the fake sleep moves; onSleep plays the supervisor
function lane(root, { alive = () => true, onSleep = () => {} } = {}) {
  let t = Date.parse('2026-01-01T00:00:00Z');
  const lines = [];
  const deps = { supervisorAlive: alive, now: () => new Date(t), sleep: async (ms) => { t += ms; onSleep(); } };
  const run = (...a) => runPhaseCommand('push-request', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), deps });
  return { lines, run };
}
// the supervisor's answer: pushed, with the CI watch in lastPush
const answer = (root, { ci }) => {
  const req = readJson(requestFile(root, '3'));
  const push = { requestId: req.id, remote: 'origin', branch: 'main', sha: req.head };
  writeJsonAtomic(recordFile(root, '3'), { ...push, phase: '3', outcome: 'pushed', lastPush: { ...push, ci } });
};

test('bin routes push-request and inbox; with push off nothing is requested; a bad --at is a usage error', () => {
  const root = tmpGitRepo();
  fs.mkdirSync(path.join(root, '.planning'));
  const r = cli(['push-request', '3'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'push off: nothing requested (push.mode in .planning/turbo/config.json)');
  assert.equal(cli(['inbox', '3'], root).stdout.trim(), 'inbox 3: nothing new');
  assert.equal(cli(['push-request', '3', '--at', 'nope'], root).status, 2);
});

test('push-request without --wait writes the request and warns when no supervisor runs', async () => {
  const root = laneRepo();
  const { lines, run } = lane(root, { alive: () => false });
  assert.equal(await run('3', '--at', 'phase'), 0);
  assert.equal(lines[0], `push requested: ${head(root).slice(0, 7)} (the supervisor pushes it at its next check)`);
  assert.equal(lines[1], 'warn: no supervisor is running; the request waits for the next turbo-run start');
  assert.equal(readJson(requestFile(root, '3')).head, head(root));
  lines.length = 0;
  assert.equal(await run('3', '--at', 'wave'), 0);
  assert.deepEqual(lines, ['push after-phase: nothing requested at a wave']);
});

test('push-request --wait returns once the supervisor pushed and CI finished', async () => {
  const root = laneRepo();
  let n = 0;
  const { lines, run } = lane(root, {
    onSleep: () => {
      n += 1;
      if (n === 1) answer(root, { ci: { state: 'pending', runs: [] } });
      if (n === 3) answer(root, { ci: { state: 'green', runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success' }] } });
    },
  });
  assert.equal(await run('3', '--at', 'phase', '--wait'), 0);
  assert.equal(lines.at(-1), `pushed ${head(root).slice(0, 7)} to origin/main · CI green (CI success)`);
});

test('push-request --wait stops after a 9-minute slice with waiting (exit 3); run again it keeps the same request', async () => {
  const root = laneRepo();
  const { lines, run } = lane(root, { onSleep: () => answer(root, { ci: { state: 'pending', runs: [] } }) });
  assert.equal(await run('3', '--wait'), 3);
  assert.match(lines.at(-1), /^waiting: CI on [0-9a-f]{7} is still running; run the same command again$/);
  const id = readJson(requestFile(root, '3')).id;
  assert.equal(await run('3', '--wait'), 3);
  assert.equal(lines.at(-2), `push already requested: ${head(root).slice(0, 7)}`);
  assert.equal(readJson(requestFile(root, '3')).id, id);
});

test('push-request --wait fails at once without a supervisor, and after 10 minutes of a request nobody takes', async () => {
  const root = laneRepo();
  const gone = lane(root, { alive: () => false });
  assert.equal(await gone.run('3', '--wait'), 1);
  assert.match(gone.lines.at(-1), /^failed: no supervisor is running/);
  const ignored = lane(laneRepo());
  assert.equal(await ignored.run('3', '--wait'), 3, 'the first 9-minute slice ends in waiting');
  assert.equal(await ignored.run('3', '--wait'), 1);
  assert.match(ignored.lines.at(-1), /^failed: the supervisor has not taken this request for 10 min/);
});

test('describeRecord: one line and exit code per outcome', () => {
  const pushed = (ci) => ({ requestId: 'r', phase: '3', remote: 'origin', branch: 'main', outcome: 'pushed', sha: 'f'.repeat(40), lastPush: { requestId: 'r', sha: 'f'.repeat(40), ci } });
  const red = [{ id: 1, name: 'CI', status: 'completed', conclusion: 'failure' }, { id: 2, name: 'Lint', status: 'completed', conclusion: 'success' }];
  const cases = [
    [pushed({ state: 'pending', runs: [] }), 3, 'pushed fffffff to origin/main · CI pending'],
    [pushed({ state: 'none', reason: 'push.ci is none' }), 0, 'pushed fffffff to origin/main · CI none (push.ci is none)'],
    [pushed({ state: 'red', runs: red }), 1, 'pushed fffffff to origin/main · CI red (CI failure); read it with turbo-run inbox 3'],
    [pushed({ state: 'timeout', runs: [] }), 1, 'pushed fffffff to origin/main · CI timeout: no result within push.ci_timeout_minutes'],
    [pushed({ state: 'superseded', runs: [] }), 1, 'pushed fffffff to origin/main · CI superseded by a later push'],
    [pushed({ state: 'cancelled', runs: [{ id: 3, name: 'CI', status: 'completed', conclusion: 'cancelled' }] }), 1, 'pushed fffffff to origin/main · CI cancelled (CI cancelled): nothing was tested'],
    [{ outcome: 'refused', findings: [{ file: 'logs/x.log', kind: 'forbidden name *.log' }] }, 1, 'refused: logs/x.log (forbidden name *.log); nothing was pushed'],
    [{ outcome: 'diverged', remote: 'origin', branch: 'main' }, 1, 'diverged: origin/main has commits this checkout does not have; nothing was pushed'],
    [{ outcome: 'failed', reason: 'HEAD is detached; turbo pushes a branch only' }, 1, 'failed: HEAD is detached; turbo pushes a branch only'],
  ];
  for (const [rec, code, line] of cases) assert.deepEqual(describeRecord(rec), { code, line });
});
