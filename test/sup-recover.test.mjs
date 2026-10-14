import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { laneSessionName } from '../lib/claude.mjs';
import { completeStep } from '../lib/phase-progress.mjs';
import { writeLaneStatus } from '../lib/run-status.mjs';
import { readSupervisor, setAside, supervisorFile } from '../lib/sup-state.mjs';
import { recoverSupervisor } from '../lib/sup-recover.mjs';

// A supervisor.json a machine crash damaged (seen: 526 NUL bytes after a bugcheck) is told apart from a missing one,
// and the owner's start keeps it aside (never deleted) and rebuilds the lanes from what lives outside it: the slots'
// own records, the lane sessions, the lane records and the phases' progress. What is lost is said.
const NOW = new Date('2026-10-14T12:30:00.000Z');
const STARTED = '2026-10-14T11:00:00.000Z';
const NUL = Buffer.alloc(526);

function project(content = NUL) {
  const root = path.join(tmpDir('rec'), 'demo-app');
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  if (content !== null) fs.writeFileSync(supervisorFile(root), content);
  return root;
}
const asideOf = (root) => fs.readdirSync(path.dirname(supervisorFile(root))).filter((n) => n.startsWith('supervisor.json.damaged-'));
const readNew = (root) => JSON.parse(fs.readFileSync(supervisorFile(root), 'utf8'));

test('readSupervisor: missing, valid and damaged (zero bytes, NUL bytes, truncated JSON) with why and the last change', () => {
  assert.deepEqual(readSupervisor(project(null)), { state: 'missing', sup: null, damaged: null });
  assert.deepEqual(readSupervisor(project('{"pid":null,"lanes":{}}')), { state: 'valid', sup: { pid: null, lanes: {} }, damaged: null });
  for (const [content, why] of [['', 'empty (0 bytes)'], [NUL, '526 zero bytes'], ['{"pid": 4016', 'not JSON (12 bytes)']]) {
    const root = project(content);
    const r = readSupervisor(root);
    assert.equal(r.state, 'damaged');
    assert.equal(r.sup, null);
    assert.equal(r.damaged.why, why);
    assert.equal(r.damaged.at, fs.statSync(supervisorFile(root)).mtime.toISOString());
  }
});

test('setAside keeps the damaged file under a UTC name next to it, never over another one', () => {
  const root = project();
  const first = setAside(root, { now: NOW });
  assert.equal(path.basename(first), 'supervisor.json.damaged-20261014T123000Z');
  assert.deepEqual(fs.readFileSync(first), NUL, 'the bytes kept as they were');
  assert.equal(fs.existsSync(supervisorFile(root)), false);
  fs.writeFileSync(supervisorFile(root), '');
  assert.equal(path.basename(setAside(root, { now: NOW })), 'supervisor.json.damaged-20261014T123000Z-2');
});

test('nothing to recover: a missing or a valid supervisor.json is left alone; an unreadable one is refused, never moved', () => {
  for (const content of [null, '{"pid":null}']) {
    const root = project(content);
    assert.equal(recoverSupervisor(root, { now: NOW }), null);
    assert.deepEqual(asideOf(root), []);
  }
  const root = project(null);
  fs.mkdirSync(supervisorFile(root));
  assert.throws(() => recoverSupervisor(root, { now: NOW }), /^Error: supervisor\.json cannot be read: unreadable \(E[A-Z]+\)$/);
  assert.deepEqual(asideOf(root), []);
});

// slots mode: slot 1 runs phase 38 (its session alive), slot 2 a prep job (no session), slot 3's own record is damaged
// too, slot 4 is free, slot 5 belongs to another project
function slotsProject(content = NUL) {
  const root = project(content);
  const dir = `${root}.turbo`;
  const slot = (k) => path.join(dir, `lane-${k}`);
  const record = (k, job) => ({ k, control: root, copied: [], job });
  const active = (kind, phase, branch) => ({ kind, phase, branch, base: { branch: 'main', sha: 'a'.repeat(40) }, state: 'active', startedAt: STARTED, endedAt: null, outcome: null });
  fs.mkdirSync(path.join(slot(3), '.git'), { recursive: true });
  fs.writeFileSync(path.join(slot(3), '.git', 'turbo-lane.json'), Buffer.alloc(300));
  fs.writeFileSync(path.join(slot(3), '.git', 'HEAD'), 'ref: refs/heads/turbo/p40\n');
  const slots = [
    { k: 1, path: slot(1), state: 'busy', record: record(1, active('phase', '38', 'turbo/p38')) },
    { k: 2, path: slot(2), state: 'busy', record: record(2, active('prep', '39', 'turbo/prep-39')) },
    { k: 3, path: slot(3), state: 'foreign', record: null },
    { k: 4, path: slot(4), state: 'free', record: record(4, { ...active('phase', '37', 'turbo/p37'), state: 'done', outcome: 'merged' }) },
    { k: 5, path: slot(5), state: 'foreign', record: { k: 5, control: path.join(path.dirname(root), 'other-app'), job: active('phase', '9', 'turbo/p9') } },
  ];
  const agents = [
    { id: 'df2604b1', name: laneSessionName(root, '38'), cwd: slot(1), state: 'working', startedAt: STARTED },
    { id: 'old00001', name: laneSessionName(root, '38'), cwd: slot(1), state: 'failed', startedAt: '2026-10-14T09:00:00.000Z' },
    // the same lane name in another directory is not this lane's
    { id: 'elsewhere', name: laneSessionName(root, 'prep-39'), cwd: root, state: 'working' },
  ];
  return { root, slot, slots, agents };
}

test('slots mode: the lanes are rebuilt from the slots\' own records and their sessions; a slot with a damaged record is named; the summary says what was lost', () => {
  const p = slotsProject();
  for (const s of ['freshness', 'discuss', 'prologue', 'plan', 'gates-off']) completeStep(p.root, '38', s);
  const r = recoverSupervisor(p.root, { slots: true, listSlots: () => p.slots, agents: () => p.agents, now: NOW });
  assert.equal(path.basename(r.aside), 'supervisor.json.damaged-20261014T123000Z');
  assert.deepEqual(fs.readFileSync(r.aside), NUL);
  const sup = readNew(p.root);
  assert.deepEqual(sup, r.sup);
  assert.deepEqual(Object.keys(sup.lanes), ['38', 'prep-39']);
  assert.deepEqual(sup.lanes['38'], { key: '38', job: 'phase', phase: '38', slot: 1, slotPath: p.slot(1), branch: 'turbo/p38', sessionId: 'df2604b1', launchedAt: STARTED, restarts: 0, notified: {}, mode: 'full', blockedSince: null });
  // no session: the supervisor's own path for a slot with a job and no record (adopt or resume there)
  assert.deepEqual(sup.lanes['prep-39'], { key: 'prep-39', job: 'prep', phase: '39', slot: 2, slotPath: p.slot(2), branch: 'turbo/prep-39', sessionId: null, launch: 'resume', launchedAt: null, restarts: 0, notified: {}, mode: 'full', blockedSince: null });
  assert.deepEqual([sup.lanesMode, sup.pid, sup.finished, sup.halted, sup.updatedAt], ['slots', null, false, false, NOW.toISOString()]);
  assert.deepEqual(sup.recovered, { at: NOW.toISOString(), from: 'supervisor.json.damaged-20261014T123000Z', why: '526 zero bytes' });
  assert.deepEqual(r.lines, [
    'supervisor.json was damaged (526 zero bytes; most likely a machine crash): kept as .planning/turbo/run/supervisor.json.damaged-20261014T123000Z',
    `recovered phase 38 in slot 1 (${p.slot(1)}), branch turbo/p38, next step: running plans; session df2604b1 runs: the supervisor adopts it`,
    `recovered prep of phase 39 in slot 2 (${p.slot(2)}), branch turbo/prep-39; no lane session found: the supervisor starts a resumed one`,
    `not recovered: slot 3 (${p.slot(3)}): its own record is damaged too (300 zero bytes); its branch is turbo/p40: repair or remove that slot by hand (turbo-run lanes)`,
    "not recovered: the run's range and plan-only mark (the supervisor now runs the whole milestone), restart counts and sent-notification marks",
  ]);
  assert.deepEqual(r.log, r.lines, 'English for the log');
});

test('slots mode in Russian, with the range this start runs; sessions that cannot be listed are said, nothing waits on them', () => {
  const p = slotsProject('{"lanesMode":"slots","lanes":{"38":');
  const r = recoverSupervisor(p.root, { lang: 'ru', slots: true, listSlots: () => p.slots.slice(0, 1), agents: () => { throw new Error('claude agents failed: exit status 1\nmore'); }, range: { from: '38', to: '40' }, now: NOW });
  assert.deepEqual(r.lines, [
    'supervisor.json был повреждён (обрывок вместо JSON, 35 байт; вероятно, сбой машины): сохранён как .planning/turbo/run/supervisor.json.damaged-20261014T123000Z',
    `восстановлена фаза 38 в слоте 1 (${p.slot(1)}), ветка turbo/p38; сессии полос не удалось перечислить: супервизор посмотрит при первой проверке`,
    'не восстановлено: диапазон прогона и пометка «только планирование» (супервизор теперь идёт по фазам 38–40), счётчики перезапусков и пометки отправленных уведомлений',
  ]);
  assert.equal(r.log[1], `recovered phase 38 in slot 1 (${p.slot(1)}), branch turbo/p38; lane sessions could not be listed (claude agents failed: exit status 1): the supervisor looks at its first check`);
  assert.equal(readNew(p.root).lanes['38'].sessionId, null);
  // the reasons and session states in plain Russian words; the whole run is «всему этапу»
  const q = slotsProject();
  const ru = recoverSupervisor(q.root, { lang: 'ru', slots: true, listSlots: () => q.slots, agents: () => q.agents.map((a) => ({ ...a, state: 'failed' })), now: NOW });
  assert.match(ru.lines[0], /^supervisor\.json был повреждён \(526 нулевых байт; вероятно, сбой машины\)/);
  assert.match(ru.lines[1], /; сессия df2604b1 закончилась сбоем: супервизор продолжит полосу в новой сессии$/);
  assert.match(ru.lines[3], /его собственная запись тоже повреждена \(300 нулевых байт\); его ветка turbo\/p40:/);
  assert.match(ru.lines[4], /\(супервизор теперь идёт по всему этапу\)/);
  assert.doesNotMatch(ru.lines.join('\n'), /bytes|milestone|failed/);
});

test('a slot record naming another slot number is not this slot\'s lane; a file another start set aside first is left to it', () => {
  const p = slotsProject();
  const moved = { ...p.slots[0], record: { ...p.slots[0].record, k: 7 } };
  assert.deepEqual(recoverSupervisor(p.root, { slots: true, listSlots: () => [moved], now: NOW }).sup.lanes, {});
  const q = project();
  const realRename = fs.renameSync;
  // the other start renames it between this one's read and its rename
  fs.renameSync = (from, to) => { fs.renameSync = realRename; fs.rmSync(from); return realRename(from, to); };
  try {
    assert.equal(recoverSupervisor(q, { now: NOW }), null);
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.existsSync(supervisorFile(q)), false, 'nothing written over the other start\'s work');
});

test('slots mode with no slot holding a job: nothing to recover is said, the run starts fresh', () => {
  const p = slotsProject('');
  const r = recoverSupervisor(p.root, { slots: true, listSlots: () => [p.slots[3]], agents: () => [], now: NOW });
  assert.deepEqual(readNew(p.root).lanes, {});
  assert.equal(r.lines[1], 'no lane to recover (no slot holds a job, and this checkout has no lane session or record): this start begins with the next ready phase');
});

// checkout mode: the one lane in this checkout
const PHASES = [{ number: '32', complete: true }, { number: '33', complete: false }, { number: '34', complete: false }];

test('checkout mode: an alive lane session in this checkout is the lane, its phase\'s progress read; a phase GSD completed is never picked', () => {
  const root = project();
  completeStep(root, '33', 'freshness');
  const agents = [
    { id: '0203669b', name: laneSessionName(root, '33'), cwd: root, state: 'blocked', startedAt: STARTED },
    { id: 'done3200', name: laneSessionName(root, '32'), cwd: root, state: 'working', startedAt: STARTED },
    { id: 'slotlane', name: laneSessionName(root, '34'), cwd: path.join(root, '..', 'elsewhere'), state: 'working' },
  ];
  const r = recoverSupervisor(root, { agents: () => agents, phases: () => PHASES, mode: 'safe', now: NOW });
  assert.deepEqual(r.sup.lane, { phase: '33', sessionId: '0203669b', name: laneSessionName(root, '33'), launchedAt: STARTED, mode: 'full', restarts: 0, notified: {}, blockedSince: null });
  assert.equal(r.sup.lanes, undefined);
  assert.equal(r.lines[1], 'recovered phase 33 in this checkout, next step: discussion; session 0203669b runs: the supervisor adopts it');
});

test('checkout mode: without a live session the newest lane record of an unfinished phase, then a session, then turbo-phase progress; else nothing', () => {
  const root = project();
  writeLaneStatus(root, '33', 'needs-owner', { reason: 'a live check', at: '2026-10-14T10:00:00.000Z' });
  writeLaneStatus(root, '34', 'running', { sessionId: 'rec34000', at: '2026-10-14T11:30:00.000Z' });
  writeLaneStatus(root, '32', 'running', { sessionId: 'old32000', at: '2026-10-14T12:00:00.000Z' });
  const agents = [{ id: 'rec34000', name: laneSessionName(root, '34'), cwd: root, state: 'failed', startedAt: STARTED }];
  const r = recoverSupervisor(root, { agents: () => agents, phases: () => PHASES, mode: 'full', now: NOW });
  assert.deepEqual([r.sup.lane.phase, r.sup.lane.sessionId, r.sup.lane.launchedAt, r.sup.lane.mode], ['34', 'rec34000', STARTED, 'full']);
  assert.equal(r.lines[1], 'recovered phase 34 in this checkout; session rec34000 is failed: the supervisor resumes the lane in a new session');
  // the record's session, not listed any more (gone with the reboot)
  const gone = project();
  writeLaneStatus(gone, '33', 'running', { sessionId: 'gone3300', at: '2026-10-14T11:30:00.000Z' });
  const g = recoverSupervisor(gone, { agents: () => [], phases: () => PHASES, now: NOW });
  assert.deepEqual([g.sup.lane.phase, g.sup.lane.sessionId, g.sup.lane.launchedAt, g.sup.lane.mode], ['33', 'gone3300', null, 'safe']);
  assert.match(g.lines[1], /^recovered phase 33 in this checkout; session gone3300 has ended: the supervisor resumes the lane in a new session$/);
  // only /turbo-phase progress left
  const progress = project('');
  completeStep(progress, '34', 'freshness');
  const pr = recoverSupervisor(progress, { agents: () => [], phases: () => PHASES, now: NOW });
  assert.deepEqual([pr.sup.lane.phase, pr.sup.lane.sessionId, pr.sup.lane.mode], ['34', null, 'full']);
  assert.match(pr.lines[1], /^recovered phase 34 in this checkout, next step: discussion; no lane session found/);
  // nothing at all: a fresh start, said; GSD's phases unknown (no gsd-core) count every recorded phase as unfinished
  const none = project('{"pid":');
  const n = recoverSupervisor(none, { agents: () => [], phases: () => { throw new Error('gsd-core not found'); }, now: NOW });
  assert.equal(n.sup.lane, null);
  assert.equal(n.lines[1], 'no lane to recover (no slot holds a job, and this checkout has no lane session or record): this start begins with the next ready phase');
  assert.equal(asideOf(none).length, 1);
});
