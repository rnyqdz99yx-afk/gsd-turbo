import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpDir } from './helpers/tmp.mjs';
import { writeBuildPhase4, writeLanePhase3, writeLanePhase5 } from './fixtures/cost.mjs';
import { FORK, SESSION, entry, projectDirFor, setMtime, writeJob, writeSession } from './helpers/transcripts.mjs';
import { GAP_CAP_MS, IEU_WEIGHTS, costLine, eachLine, ieuOf, laneJobIds, laneTranscripts, phaseCost, recordSessionUsage, spawnCostLog, turboStepOf } from '../lib/cost.mjs';

const U = { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 50 };

test('ieuOf weighs input 1, cache write 1.25 (the 1h cache too), cache read 0.1, output 5', () => {
  assert.equal(ieuOf(U), 1600);
  assert.equal(ieuOf({ ...U, cache_creation: { ephemeral_1h_input_tokens: 1000 } }), 1600);
  assert.equal(ieuOf({}), 0);
  assert.deepEqual(IEU_WEIGHTS, { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
  assert.equal(GAP_CAP_MS, 300000);
});

test('recordSessionUsage appends one record per session to run/cost-p<N>.json', () => {
  const run = path.join(tmpDir('cost'), 'run');
  const now = new Date('2026-10-17T12:00:00Z');
  const at = '2026-10-17T12:00:00.000Z';
  const r1 = recordSessionUsage(run, '04', { step: 'build', role: 'builder', sessionId: 's-1', usage: U, wallMs: 1000 }, { now });
  recordSessionUsage(run, '04', { step: 'review', role: 'fixer', usage: { output_tokens: 7 }, wallMs: 0 }, { now });
  assert.deepEqual(r1, { step: 'build', role: 'builder', sessionId: 's-1', usage: U, wallMs: 1000, at });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, 'cost-p4.json'), 'utf8')), {
    v: 1,
    phase: '4',
    sessions: [
      { step: 'build', role: 'builder', sessionId: 's-1', usage: U, wallMs: 1000, at },
      { step: 'review', role: 'fixer', sessionId: null, usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 }, wallMs: 0, at },
    ],
  });
});

test('recordSessionUsage refuses a bad record, naming the field', () => {
  const run = path.join(tmpDir('cost'), 'run');
  const ok = { step: 'build', role: 'builder', sessionId: 's-1', usage: U, wallMs: 1 };
  const bad = (phase, rec, re) => assert.throws(() => recordSessionUsage(run, phase, { ...ok, ...rec }), (e) => e instanceof TypeError && re.test(e.message));
  bad('4', { usage: { ...U, output_tokens: -1 } }, /usage\.output_tokens/);
  bad('4', { step: 'a b' }, /step/);
  bad('4', { wallMs: NaN }, /wallMs/);
  bad('../x', {}, /phase/);
  bad('4', { sessionId: 'x/y' }, /sessionId/);
  assert.equal(fs.existsSync(run), false, 'no file is written');
});

test('a cost file that does not parse counts as empty', () => {
  const run = path.join(tmpDir('cost'), 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'cost-p4.json'), 'not json');
  recordSessionUsage(run, '4', { step: 'build', role: 'builder', usage: U, wallMs: 1 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'cost-p4.json'), 'utf8')).sessions.length, 1);
});

test('phaseCost of a build phase: rows by step and role, wall clock as the union of the sessions', () => {
  const root = tmpDir('cost-b');
  writeBuildPhase4(root);
  const cost = phaseCost({ root, phase: '4', env: { CLAUDE_CONFIG_DIR: tmpDir('cost-home') } });
  assert.deepEqual(cost.rows, [
    { step: 'slice', role: 'slicer', sessions: 1, wallMs: 300000, out: 3000, inCreate: 21000, cacheRead: 50000, ieu: 46000 },
    { step: 'build', role: 'builder', sessions: 2, wallMs: 900000, out: 8000, inCreate: 21000, cacheRead: 200000, ieu: 86000 },
    { step: 'review', role: 'fixer', sessions: 1, wallMs: 120000, out: 1000, inCreate: 1130, cacheRead: 10000, ieu: 7380 },
  ]);
  assert.deepEqual(cost.total, { sessions: 4, wallMs: 1020000, out: 12000, inCreate: 43130, cacheRead: 260000, ieu: 139380 });
  assert.deepEqual(cost.steps, [{ step: 'slice', wallMs: 300000, ieu: 46000 }, { step: 'build', wallMs: 600000, ieu: 86000 }, { step: 'review', wallMs: 120000, ieu: 7380 }]);
  assert.equal(cost.slices, 2);
  assert.equal(cost.fixRounds, 1);
  assert.deepEqual(cost.sources, { lane: 0, build: 4 });
  assert.equal(cost.phase, '4');
});

test('eachLine reads whole lines across chunk boundaries, multi-byte characters included', () => {
  const file = path.join(tmpDir('cost'), 'lines.jsonl');
  fs.writeFileSync(file, Buffer.from('a\n{"x":"≈é"}\r\n\nlast', 'utf8'));
  const lines = [];
  eachLine(file, (l) => lines.push(l), { chunk: 2 });
  assert.deepEqual(lines, ['a', '{"x":"≈é"}', 'last']);
});

test('turboStepOf reads the last step phase-step printed', () => {
  assert.equal(turboStepOf('phase 3: next plan (done: freshness, discuss)'), 'plan');
  assert.equal(turboStepOf('phase 3: prep next discuss'), 'discuss');
  assert.equal(turboStepOf('phase 3: next execute\nphase 3: next restore'), 'restore');
  assert.equal(turboStepOf('phase 3: next none (done: close)'), null);
  assert.equal(turboStepOf('attempt fix 2'), null);
});

test('laneJobIds takes the phase\'s own launches and adoptions and its prep lane, in log order', () => {
  const text = [
    'launch phase 3 session 11111111',
    'launch phase 30 session 30303030',
    'launch phase 3.1 session 31313131',
    'launch lane prep-3 session 33333333',
    'adopt phase 03 session 11111111',
    'launch phase 3 session 44444444 (resume)',
    'launch lane annotate session 55555555',
    'wake phase 3: woke session 66666666',
  ].map((l, i) => `2026-10-17T10:0${i}:00.000Z ${l}`).join('\n');
  assert.deepEqual(laneJobIds(text, '3'), ['11111111', '33333333', '44444444']);
  assert.deepEqual(laneJobIds(text, '03'), ['11111111', '33333333', '44444444']);
});

// A project root and a Claude home holding the synthetic lane phases 3 and 5.
function laneProject() {
  const root = tmpDir('cost-l');
  const home = tmpDir('cost-home');
  writeLanePhase3({ home, root });
  writeLanePhase5({ home, root });
  return { root, home, env: { CLAUDE_CONFIG_DIR: home } };
}

test('laneTranscripts finds a phase\'s lane sessions through supervisor.log and the job state, and their subagents', () => {
  const { root, home } = laneProject();
  const t = laneTranscripts({ home, root, phase: '3' });
  assert.deepEqual(t.mains.map((m) => path.basename(m.file)), [`${SESSION}.jsonl`, `${FORK}.jsonl`]);
  assert.deepEqual(t.agents.map((a) => [path.basename(a.file), a.meta.agentType]), [['agent-a0123456789abcdef.jsonl', 'gsd-assumptions-analyzer']]);
});

test('phaseCost of a lane phase: steps from phase-step and skills, subagents under their dispatch step, each call once', () => {
  const { root, env } = laneProject();
  const cost = phaseCost({ root, phase: '3', env });
  assert.deepEqual(cost.rows, [
    { step: 'turbo-phase', role: 'orchestrator', sessions: 1, wallMs: 30000, out: 70, inCreate: 1110, cacheRead: 2000, ieu: 1910 },
    { step: 'discuss', role: 'orchestrator', sessions: 1, wallMs: 385000, out: 130, inCreate: 500, cacheRead: 7000, ieu: 1975 },
    { step: 'discuss', role: 'gsd-assumptions-analyzer', sessions: 1, wallMs: 180000, out: 500, inCreate: 4200, cacheRead: 8000, ieu: 8500 },
    { step: 'plan', role: 'orchestrator', sessions: 1, wallMs: 20000, out: 60, inCreate: 0, cacheRead: 7000, ieu: 1000 },
  ]);
  assert.deepEqual(cost.total, { sessions: 3, wallMs: 616000, out: 760, inCreate: 5810, cacheRead: 24000, ieu: 13385 });
  assert.deepEqual(cost.steps, [{ step: 'turbo-phase', wallMs: 30000, ieu: 1910 }, { step: 'discuss', wallMs: 566000, ieu: 10475 }, { step: 'plan', wallMs: 20000, ieu: 1000 }]);
  assert.deepEqual(cost.sources, { lane: 3, build: 0 });
  assert.equal(cost.fixRounds, 2);
  assert.equal(cost.slices, 0);
});

test('nested subagents inherit through their parent agent, an unlinked one reads ?, synthetic messages count nothing', () => {
  const { root, env } = laneProject();
  const cost = phaseCost({ root, phase: '5', env });
  assert.deepEqual(cost.rows.map((r) => [r.step, r.role, r.ieu]), [
    ['gsd-execute-phase', 'orchestrator', 12],
    ['gsd-execute-phase', 'gsd-executor', 6],
    ['gsd-execute-phase', 'Explore', 6],
    ['?', 'general-purpose', 6],
  ]);
  assert.equal(cost.total.ieu, 30);
});

test('phaseCost reads the transcripts under CLAUDE_CONFIG_DIR', () => {
  const { root } = laneProject();
  const cost = phaseCost({ root, phase: '3', env: { CLAUDE_CONFIG_DIR: tmpDir('cost-other') } });
  assert.deepEqual(cost.rows, []);
  assert.equal(cost.sources.lane, 0);
});

test('costLine names path, wall clock, IEU, sessions, slices, fix rounds and each step', () => {
  const { root, env } = laneProject();
  writeBuildPhase4(root);
  const lane = phaseCost({ root, phase: '3', env });
  const build = phaseCost({ root, phase: '4', env });
  assert.equal(costLine(lane, { path: 'lane' }), 'phase 3 cost: path lane · wall 10m16s · ≈IEU 13.4K · sessions 3 · slices 0 · fix rounds 2 · steps: turbo-phase 0m30s 1.9K, discuss 9m26s 10.5K, plan 0m20s 1.0K');
  assert.equal(costLine(build, { path: 'build' }), 'phase 4 cost: path build · wall 17m00s · ≈IEU 139.4K · sessions 4 · slices 2 · fix rounds 1 · steps: slice 5m00s 46.0K, build 10m00s 86.0K, review 2m00s 7.4K');
  assert.equal(costLine(phaseCost({ root, phase: '9', env }), { path: 'lane' }), 'phase 9 cost: path lane · wall 0m00s · ≈IEU 0 · sessions 0 · slices 0 · fix rounds 0');
  assert.match(costLine(build), /^phase 4 cost: path build · /);
  assert.match(costLine(lane), /^phase 3 cost: path lane · /);
});

test('spawnCostLog logs a child that cannot start and never throws', async () => {
  const logs = [];
  const child = spawnCostLog({ script: path.resolve('bin/turbo-run.mjs'), root: tmpDir('cost'), phase: '4', log: (l) => logs.push(l), node: path.join(tmpDir('cost'), 'no-such-node.exe') });
  await once(child, 'error');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^phase 4 cost: not measured: /);
});

test('spawnCostLog\'s detached child appends the cost line to supervisor.log', async () => {
  const root = tmpDir('cost-b');
  writeBuildPhase4(root);
  const logs = [];
  spawnCostLog({ script: path.resolve('bin/turbo-run.mjs'), root, phase: '4', log: (l) => logs.push(l), env: { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('cost-home') } });
  const file = path.join(root, '.planning', 'turbo', 'logs', 'supervisor.log');
  let text = '';
  for (let i = 0; i < 200 && !/phase 4 cost: path build · wall 17m00s/.test(text); i++) {
    await delay(100);
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch { /* not written yet */ }
  }
  assert.match(text, /phase 4 cost: path build · wall 17m00s/);
  assert.deepEqual(logs, []);
});

test('a woken lane\'s later transcript is found through the supervisor\'s job line once claude rm took the job state', () => {
  const { root, home, env } = laneProject();
  const full = phaseCost({ root, phase: '3', env });
  const log = path.join(root, '.planning', 'turbo', 'logs', 'supervisor.log');
  fs.rmSync(path.join(home, 'jobs', '11111111'), { recursive: true });
  assert.equal(phaseCost({ root, phase: '3', env }).total.ieu, 12385, 'without the line only the first transcript is found');
  fs.appendFileSync(log, `2026-10-17T11:30:00.000Z phase 30 job 11111111 sessions ${FORK}\n`);
  assert.equal(phaseCost({ root, phase: '3', env }).total.ieu, 12385, 'another phase\'s line is not this phase\'s');
  // the woken transcript went on in another project directory (a slot's): found by its exact id anywhere
  const elsewhere = path.join(home, 'projects', 'C--elsewhere-lane-1');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.renameSync(path.join(projectDirFor(home, root), `${FORK}.jsonl`), path.join(elsewhere, `${FORK}.jsonl`));
  fs.appendFileSync(log, `2026-10-17T11:30:00.000Z lane prep-03 job 11111111 sessions ${FORK},${'x'.repeat(65)}\n`);
  const cost = phaseCost({ root, phase: '3', env });
  assert.deepEqual(cost.rows, full.rows);
  assert.deepEqual(cost.total, full.total);
  assert.deepEqual(laneTranscripts({ home, root, phase: '3' }).mains.map((m) => [path.basename(path.dirname(m.file)), path.basename(m.file)]), [
    [path.basename(projectDirFor(home, root)), `${SESSION}.jsonl`],
    ['C--elsewhere-lane-1', `${FORK}.jsonl`],
  ]);
});

test('a job\'s woken transcript keeps its step, another job\'s does not; a slash command is a prompt; PowerShell phase-step; a result between a message\'s lines', () => {
  const root = tmpDir('cost-l');
  const home = tmpDir('cost-home');
  const T = (hms) => `2026-10-17T${hms}.000Z`;
  const one = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
  const zero = { ...one, output_tokens: 0 };
  const P = '99999999-0000-4000-8000-000000000003';
  const A = '77777777-0000-4000-8000-000000000001';
  const B = '88888888-0000-4000-8000-000000000002';
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'logs', 'supervisor.log'), `${T('07:00:00')} launch lane prep-6 session 99999999\n${T('08:00:00')} launch phase 6 session 77777777\n`);
  writeJob(home, '77777777', { sessionId: A, resumeSessionId: B });
  const dir = projectDirFor(home, root);
  // the prep job ends in its prologue step
  setMtime(writeSession(dir, P, [
    { ...entry.user('Run the turbo-prep skill with arguments: 6', T('07:00:00')), uuid: 'p-1' },
    entry.assistant({ ts: T('07:00:10'), id: 'z1', usage: one, tool: { name: 'Bash', input: { command: 'node "$T" phase-step 6 --prep' }, id: 'toolu_z' } }),
    { ...entry.toolResult('toolu_z', 'phase 6: prep next prologue', T('07:00:20')), uuid: 'p-2' },
    entry.assistant({ ts: T('07:00:30'), id: 'z2', usage: one, text: 'ok' }),
  ]), new Date(T('07:00:30')));
  setMtime(writeSession(dir, A, [
    { ...entry.user('Run the turbo-phase skill with arguments: 6', T('08:00:00')), uuid: 'u-1' },
    entry.assistant({ ts: T('08:00:10'), id: 'x1', usage: one, tool: { name: 'PowerShell', input: { command: 'node $T phase-step 6' }, id: 'toolu_p6' } }),
    { ...entry.toolResult('toolu_p6', 'phase 6: next execute', T('08:00:20')), uuid: 'u-2' },
    entry.assistant({ ts: T('08:00:30'), id: 'x2', usage: one, text: 'ok' }),
    // one message: its phase-step result lands before its second line; the message stays in its step
    entry.assistant({ ts: T('08:00:40'), id: 'x3', usage: zero, tool: { name: 'Bash', input: { command: 'node "$T" phase-step 6 --done execute' }, id: 'toolu_p7' } }),
    { ...entry.toolResult('toolu_p7', 'phase 6: next verify', T('08:00:41')), uuid: 'u-3' },
    entry.assistant({ ts: T('08:00:42'), id: 'x3', usage: one, tool: { name: 'Read', input: { file_path: 'a.md' }, id: 'toolu_r6' } }),
  ]), new Date(T('08:00:42')));
  // woken: the job went on in a transcript without its history
  const anonymous = entry.assistant({ ts: T('09:03:20'), usage: one, text: 'ok' });
  setMtime(writeSession(dir, B, [
    { ...entry.user('The owner answered ask-1.', T('09:00:00')), uuid: 'u-4' },
    entry.assistant({ ts: T('09:00:05'), id: 'y1', usage: one, text: 'ok' }),
    { ...entry.user('<command-message>gsd:verify-work</command-message>\n<command-name>/gsd:verify-work</command-name>', T('09:03:00')), uuid: 'u-5' },
    entry.assistant({ ts: T('09:03:10'), id: 'y2', usage: one, text: 'ok' }),
    anonymous,
  ]), new Date(T('09:03:20')));
  const cost = phaseCost({ root, phase: '6', env: { CLAUDE_CONFIG_DIR: home } });
  assert.deepEqual(cost.rows.map((r) => [r.step, r.sessions, r.wallMs, r.ieu]), [['-', 2, 40000, 10], ['prologue', 1, 10000, 5], ['execute', 1, 21000, 10], ['verify', 1, 25000, 15]]);
  assert.equal(cost.total.wallMs, 96000);
  assert.equal(cost.total.sessions, 3);
});

test('fix rounds on the build path count fixer sessions: a resumed one is one round', () => {
  const root = tmpDir('cost-b');
  writeBuildPhase4(root);
  const env = { CLAUDE_CONFIG_DIR: tmpDir('cost-home') };
  recordSessionUsage(path.join(root, '.planning', 'turbo', 'run'), '4', { step: 'review', role: 'fixer', sessionId: 'b0000000-0000-4000-8000-00000000000d', usage: { output_tokens: 1 }, wallMs: 1000 });
  assert.equal(phaseCost({ root, phase: '4', env }).fixRounds, 1);
  recordSessionUsage(path.join(root, '.planning', 'turbo', 'run'), '4', { step: 'review', role: 'fixer', sessionId: 'b0000000-0000-4000-8000-00000000000e', usage: { output_tokens: 1 }, wallMs: 1000 });
  assert.equal(phaseCost({ root, phase: '4', env }).fixRounds, 2);
});
