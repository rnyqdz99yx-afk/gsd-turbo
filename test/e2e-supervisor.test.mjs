import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { runDaemon } from '../lib/supervisor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { readJson } from '../lib/fsx.mjs';

// Lane lifecycle: running -> paused-context with progress (resume relaunch) -> needs-owner
// -> done -> next phase -> milestone done. One script step runs per tick, inside loadPhases.
test('daemon drives a 2-phase milestone to completion', async () => {
  const root = tmpDir('e2e');
  fs.mkdirSync(path.join(root, '.planning'));
  const phases = [{ number: '1', deps: [], complete: false, verification: null }, { number: '2', deps: ['1'], complete: false, verification: null }];
  const agents = [];
  const prompts = [];
  const notes = [];
  const reasons = [];
  const logs = [];
  let n = 0, fp = 0, ticks = 0;
  const clock = () => new Date(Date.parse('2026-01-01T00:00:00Z') + ticks * 1000);
  const script = [
    () => {},
    () => { agents.at(-1).state = 'done'; fp++; },
    () => {},
    () => { agents.at(-1).state = 'done'; writeLaneStatus(root, '1', 'needs-owner', { reason: 'sign-off', at: clock().toISOString() }); },
    () => { phases[0].complete = true; },
    () => {},
    () => { agents.at(-1).state = 'done'; phases[1].complete = true; },
  ];
  const ctx = {
    // no restart budget: a context pause without progress halts, so the relaunch proves progress
    root, config: { ...structuredClone(DEFAULTS), max_restarts_without_progress: 0 }, turboRun: 'node x',
    deps: {
      loadPhases: () => { script[ticks]?.(); ticks++; return phases; },
      claude: {
        // cwd: the real claude.list() reports each session's directory (adoption requires it)
        launchBg: (o, cwd) => { const id = `s${++n}`; prompts.push(o.prompt); agents.push({ id, name: o.name, cwd, state: 'working' }); return id; },
        list: () => agents, stop() {}, rm() {},
      },
      fingerprint: () => String(fp),
      notify: async (k, v) => { notes.push(k); if (k === 'laneNeedsOwner') reasons.push(v.reason); },
      now: clock,
      log: (line) => { logs.push(line); },
    },
  };
  const statePath = path.join(root, '.planning', 'turbo', 'run', 'supervisor.json');
  // every fake resolves as a microtask, so a daemon that never stops would hang the suite
  // (node:test timeouts never fire); runDaemon calls sleep outside its try, so this throw escapes.
  // It counts loop iterations, not ticks: a throwing script step never advances ticks.
  let sleeps = 0;
  const sleep = async () => {
    // the first log line is usually the root cause, the last ones show the loop
    if (++sleeps > 20) throw new Error(`runaway daemon after ${sleeps} iterations (${ticks} ticks); notes ${notes}; first log ${logs[0] ?? '-'}; last log ${logs.slice(-5).join(' | ')}`);
  };
  const final = await runDaemon({ ctx, statePath, intervalMs: 0, sleep });
  assert.equal(final.finished, true);
  assert.deepEqual(notes, ['laneNeedsOwner', 'phaseDone', 'phaseDone', 'milestoneDone']);
  assert.equal(readJson(statePath).finished, true);
  // phase 1 start, its resume relaunch after the context pause, phase 2 start
  assert.deepEqual(prompts.map((p) => [/--only (\d+)/.exec(p)[1], /^Resume/.test(p)]), [['1', false], ['1', true], ['2', false]]);
  assert.deepEqual(reasons, ['sign-off']);
});
