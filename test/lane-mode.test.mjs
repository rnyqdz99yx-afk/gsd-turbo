import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { laneUserPrompt, laneSystemPrompt } from '../lib/lane-prompt.mjs';
import { inferStatus, writeLaneStatus } from '../lib/run-status.mjs';
import { tick } from '../lib/supervisor.mjs';
import { doctor } from '../lib/doctor.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { laneSessionName } from '../lib/claude.mjs';

test('prompts: full mode runs turbo-phase; safe mode keeps gsd-autonomous and restores gates first', () => {
  assert.equal(laneUserPrompt({ phase: '3', mode: 'full' }), 'Run the turbo-phase skill with arguments: 3');
  assert.equal(laneUserPrompt({ phase: '3', mode: 'full', resume: true }), 'Resume phase 3. Run the turbo-phase skill with arguments: 3 --resume');
  assert.match(laneUserPrompt({ phase: '3', turboRun: 'node x' }), /^First run node x gates restore 3 .*Then run the gsd-autonomous skill with arguments: --only 3$/);
  assert.match(laneUserPrompt({ phase: '3' }), /^Run the gsd-autonomous skill with arguments: --only 3$/);
  const full = laneSystemPrompt({ phase: '3', turboRun: 'node x', contextPct: 55, autonomy: 'standard', mode: 'full' });
  assert.match(full, /lane-status 3 done.*close step/);
  assert.match(full, /turbo-uat/);
  assert.ok(!full.includes('"') && !full.includes('%'));
  assert.match(laneSystemPrompt({ phase: '3', turboRun: 'x', contextPct: 55, autonomy: 'standard' }), /when GSD has marked the phase complete/);
});

test('inferStatus full mode: done needs the fresh done record; human_needed is not needs-owner', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const ended = { state: 'done' };
  const complete = { complete: true, verification: null };
  const human = { complete: false, verification: 'human_needed' };
  assert.equal(inferStatus({ agent: ended, laneRecord: { status: 'running', at }, launchedAt: at, phase: complete }), 'done', 'safe mode unchanged');
  assert.equal(inferStatus({ agent: ended, laneRecord: { status: 'running', at }, launchedAt: at, phase: complete, mode: 'full' }), 'paused-context');
  assert.equal(inferStatus({ agent: ended, laneRecord: { status: 'done', at: '2026-01-01T00:05:00.000Z' }, launchedAt: at, phase: complete, mode: 'full' }), 'done');
  assert.equal(inferStatus({ agent: ended, laneRecord: { status: 'done', at: '2025-12-31T00:00:00.000Z' }, launchedAt: at, phase: complete, mode: 'full' }), 'paused-context', 'a done record from before the launch does not count');
  assert.equal(inferStatus({ agent: ended, laneRecord: null, launchedAt: at, phase: human, mode: 'full' }), 'paused-context');
  assert.equal(inferStatus({ agent: ended, laneRecord: null, launchedAt: at, phase: human }), 'needs-owner');
  assert.equal(inferStatus({ agent: { state: 'working' }, laneRecord: null, launchedAt: at, phase: complete, mode: 'full' }), 'running');
});

function harness({ phases, mode }) {
  const root = tmpDir('sup2');
  fs.mkdirSync(path.join(root, '.planning'));
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const h = { root, phases, agents: [], launched: [], notes: [], fp: 'A', advance(min) { clock += min * 60000; } };
  let n = 0;
  h.ctx = {
    root, mode, config: structuredClone(DEFAULTS), turboRun: 'node x',
    deps: {
      loadPhases: () => h.phases,
      claude: {
        launchBg: (o) => { const id = `s${++n}`; h.launched.push({ id, ...o }); h.agents.push({ id, name: o.name, state: 'working', cwd: root }); return id; },
        list: () => h.agents,
        stop() {},
        rm: (id) => { h.agents = h.agents.filter((a) => a.id !== id); },
      },
      fingerprint: () => h.fp,
      notify: async (key, vars) => { h.notes.push({ key, vars }); },
      now: () => new Date(clock),
      log() {},
    },
  };
  return h;
}
const P = (number, deps = [], complete = false, verification = null) => ({ number, deps, complete, verification });
const fresh = () => ({ lane: null, finished: false, halted: false });
const last = (h) => h.agents[h.agents.length - 1];

test('supervisor full mode: launches turbo-phase, records the mode, waits for the lane done record', async () => {
  const h = harness({ phases: [P('2'), P('3', ['2'])], mode: 'full' });
  let s = await tick(fresh(), h.ctx);
  assert.equal(s.lane.mode, 'full');
  assert.equal(h.launched[0].prompt, 'Run the turbo-phase skill with arguments: 2');
  h.phases[0].complete = true; // the verifier passed inside execute-phase (G9)
  s = await tick(s, h.ctx);
  assert.equal(h.notes.length, 0);
  last(h).state = 'done'; // the session paused for context in the middle of the fan-out
  h.fp = 'B';
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 2);
  assert.equal(h.launched[1].prompt, 'Resume phase 2. Run the turbo-phase skill with arguments: 2 --resume');
  h.advance(1);
  writeLaneStatus(h.root, '2', 'done', { at: h.ctx.deps.now().toISOString() });
  last(h).state = 'done';
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes.map((x) => x.key), ['phaseDone']);
  assert.equal(s.lane, null);
});

test('supervisor full mode: human_needed relaunches for turbo-uat; the lane record decides needs-owner', async () => {
  const h = harness({ phases: [P('2', [], false, 'human_needed')], mode: 'full' });
  let s = await tick(fresh(), h.ctx);
  last(h).state = 'done';
  h.fp = 'B';
  s = await tick(s, h.ctx);
  assert.equal(h.notes.filter((x) => x.key === 'laneNeedsOwner').length, 0);
  assert.equal(h.launched.length, 2);
  h.advance(1);
  writeLaneStatus(h.root, '2', 'needs-owner', { reason: '1 item needs your sign-off', at: h.ctx.deps.now().toISOString() });
  last(h).state = 'done';
  s = await tick(s, h.ctx);
  assert.equal(h.notes.at(-1).key, 'laneNeedsOwner');
  assert.equal(h.notes.at(-1).vars.reason, '1 item needs your sign-off');
});

test('supervisor safe mode (no ctx.mode): gsd-autonomous with the gates restore first', async () => {
  const h = harness({ phases: [P('2')], mode: undefined });
  const s = await tick(fresh(), h.ctx);
  assert.equal(s.lane.mode, 'safe');
  assert.match(h.launched[0].prompt, /^First run node x gates restore 2 .*gsd-autonomous skill with arguments: --only 2$/);
});

test('safe prompts also put back docs commits after the gates', () => {
  assert.match(laneUserPrompt({ phase: '3', turboRun: 'node x' }), /^First run node x gates restore 3 and then node x gates docs-restore 3 \(/);
  assert.match(laneUserPrompt({ phase: '3', turboRun: 'node x', resume: true }), /^Resume phase 3\. First run node x gates restore 3 and then node x gates docs-restore 3 \(.*--only 3\. The state on disk/);
});

// A lane left by a full-mode supervisor, with its session ended.
function fullLane(h, phase = '2') {
  const name = laneSessionName(h.root, phase);
  h.agents.push({ id: 's0', name, state: 'done', cwd: h.root });
  return { lane: { phase, sessionId: 's0', name, launchedAt: '2026-01-01T00:00:00.000Z', mode: 'full', restarts: 0, fingerprint: 'A', notified: {}, blockedSince: null }, finished: false, halted: false };
}

test('supervisor safe mode never relaunches or adopts a full lane on a phase GSD already completed', async () => {
  const h = harness({ phases: [P('2', [], true)], mode: 'safe' });
  let s = fullLane(h);
  // an alive session of the lane that a launch timing out would leave: never adopted while held
  h.agents.push({ id: 'sx', name: laneSessionName(h.root, '2'), state: 'working', cwd: h.root });
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 0);
  assert.equal(s.lane.sessionId, 's0');
  assert.equal(s.lane.mode, 'full');
  assert.deepEqual(h.notes.map((x) => x.key), ['laneNeedsOwner']);
  assert.match(h.notes[0].vars.reason, /GSD completed phase 2 before turbo's gates finished; doctor now reports safe mode/);
  h.fp = 'B';
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 0, 'no safe relaunch: gsd-autonomous would end at once on the completed phase');
  assert.equal(h.notes.length, 1, 'notified once');
  assert.ok(s.lane && !s.halted && !s.finished);
  // resume N --start while doctor still says safe: the forced relaunch waits too, and tells the owner again
  s.lane = { ...s.lane, notified: {}, restarts: 0, forceRelaunch: true };
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 0);
  assert.equal(h.notes.length, 2);
  assert.equal(s.lane.mode, 'full');
  // doctor fixed: a full-mode supervisor resumes the lane through turbo-phase
  h.agents = h.agents.filter((a) => a.id !== 'sx');
  h.ctx.mode = 'full';
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.equal(h.launched[0].prompt, 'Resume phase 2. Run the turbo-phase skill with arguments: 2 --resume');
  assert.equal(s.lane.mode, 'full');
});

test('a full lane with its fresh done record ends in safe mode too', async () => {
  const h = harness({ phases: [P('2', [], true)], mode: 'safe' });
  let s = fullLane(h);
  writeLaneStatus(h.root, '2', 'done', { at: '2026-01-01T00:01:00.000Z' });
  s = await tick(s, h.ctx);
  assert.deepEqual(h.notes.map((x) => x.key), ['phaseDone']);
  assert.equal(s.lane, null);
});

test('supervisor safe mode relaunches a full lane on an unfinished phase with the safe resume prompt', async () => {
  const h = harness({ phases: [P('2')], mode: undefined });
  let s = fullLane(h);
  h.fp = 'B';
  s = await tick(s, h.ctx);
  assert.equal(h.launched.length, 1);
  assert.match(h.launched[0].prompt, /^Resume phase 2\. First run node x gates restore 2 .*gsd-autonomous skill with arguments: --only 2\. /);
  assert.equal(s.lane.mode, 'safe');
});

function doctorSetup({ skill = true, agent = true } = {}) {
  const home = tmpDir('home');
  const root = tmpDir('proj');
  fs.mkdirSync(path.join(root, '.planning'));
  fs.mkdirSync(path.join(root, '.claude', 'gsd-core', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'gsd-core', 'VERSION'), '1.16.0\n');
  if (skill) { fs.mkdirSync(path.join(home, 'skills', 'turbo-phase'), { recursive: true }); fs.writeFileSync(path.join(home, 'skills', 'turbo-phase', 'SKILL.md'), 'x'); }
  if (agent) { fs.mkdirSync(path.join(home, 'agents'), { recursive: true }); fs.writeFileSync(path.join(home, 'agents', 'turbo-uat.md'), 'x'); }
  return { home, root };
}
// Answers every call doctor makes; if the stage-1 fix wave added calls, extend this fake, not the assertions.
const fakeExec = (hooks = { activeHooks: [] }) => (cmd, args) => {
  const a = args.join(' ');
  if (cmd === 'git') return 'git version 2.45.0';
  if (a.includes('--version')) return '2.1.300 (Claude Code)';
  if (a.includes('agents')) return '[]';
  if (a.includes('init manager')) return '{"phases":[]}';
  if (a.includes('render-hooks')) return JSON.stringify(hooks);
  throw new Error(`unexpected call: ${cmd} ${a}`);
};
const claudeBin = { cmd: 'claude', prefix: [], shell: false };

test('doctor: full only with the turbo-phase skill, the turbo-uat agent and GSD render-hooks', () => {
  const ok = doctorSetup();
  assert.equal(doctor({ root: ok.root, env: { CLAUDE_CONFIG_DIR: ok.home }, exec: fakeExec(), claudeBin }).mode, 'full');
  const noSkill = doctorSetup({ skill: false });
  const r = doctor({ root: noSkill.root, env: { CLAUDE_CONFIG_DIR: noSkill.home }, exec: fakeExec(), claudeBin });
  assert.equal(r.mode, 'safe');
  assert.equal(r.checks.find((c) => c.name === 'turbo-phase-skill').ok, false);
  const noAgent = doctorSetup({ agent: false });
  assert.equal(doctor({ root: noAgent.root, env: { CLAUDE_CONFIG_DIR: noAgent.home }, exec: fakeExec(), claudeBin }).mode, 'safe');
  const badHooks = doctorSetup();
  const bad = doctor({ root: badHooks.root, env: { CLAUDE_CONFIG_DIR: badHooks.home }, exec: fakeExec({ nope: 1 }), claudeBin });
  assert.equal(bad.mode, 'safe');
  assert.match(bad.checks.find((c) => c.name === 'gsd-render-hooks').detail, /render-hooks verify:post returned no activeHooks list/);
});

test('turbo-run status shows the lane mode', () => {
  const root = tmpDir('st');
  fs.mkdirSync(path.join(root, '.planning'));
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), {
    lane: { phase: '2', sessionId: 's1', restarts: 0, launchedAt: '2026-01-01T00:00:00Z', mode: 'full' }, finished: false, halted: false, pid: null,
  });
  const out = execFileSync(process.execPath, [path.resolve('bin/turbo-run.mjs'), 'status', '--project', root], { encoding: 'utf8' });
  assert.match(out, /mode full/);
});
