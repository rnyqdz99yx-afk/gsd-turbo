import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DONE_STATUSES, JOBS, compareLanes, laneAt, laneCwd, laneForPhase, laneKey, laneLabel, lanesSummary, nextLine, recordKey, setupLines, supervisorLanes } from '../lib/lanes-state.mjs';
import { LANE_STATUSES } from '../lib/run-status.mjs';

const base = tmpDir('lstate');
const root = path.join(base, 'app');
const slot = (k) => path.join(base, 'app.turbo', `lane-${k}`);
fs.mkdirSync(root, { recursive: true });
for (const k of [1, 2, 3]) fs.mkdirSync(slot(k), { recursive: true });

const SUP = {
  lanesMode: 'slots',
  lanes: {
    annotate: { key: 'annotate', job: 'annotate', phase: null, slot: 3, slotPath: slot(3), sessionId: 's3' },
    'prep-36': { key: 'prep-36', job: 'prep', phase: '36', slot: 2, slotPath: slot(2), sessionId: 's2' },
    34: { key: '34', job: 'phase', phase: '34', slot: 1, slotPath: slot(1), sessionId: 's1' },
  },
};

test('keys, records and labels of the three jobs; the statuses that end each of them', () => {
  assert.deepEqual(JOBS, ['phase', 'prep', 'annotate']);
  assert.deepEqual(DONE_STATUSES, { phase: ['ready', 'done'], prep: ['prepped'], annotate: ['annotated'] });
  for (const s of ['ready', 'prepped', 'annotated']) assert.ok(LANE_STATUSES.includes(s), s);
  assert.deepEqual([laneKey({ job: 'phase', phase: '34' }), laneKey({ job: 'prep', phase: '36' }), laneKey({ job: 'annotate', phase: null })], ['34', 'prep-36', 'annotate']);
  assert.deepEqual([recordKey({ job: 'phase', phase: '34' }), recordKey({ job: 'prep', phase: '36' }), recordKey({ job: 'annotate', phase: null }), recordKey({ phase: 7 })], ['34', '36', 'annotate', '7']);
  assert.equal(laneCwd(root, { phase: '7' }), root);
  assert.equal(laneCwd(root, { phase: '7', slotPath: slot(1) }), path.resolve(slot(1)));
  assert.deepEqual(['phase', 'prep', 'annotate'].map((job) => laneLabel({ job, phase: '36' })), ['phase 36', 'prep of phase 36', 'annotation']);
  assert.deepEqual(['phase', 'prep', 'annotate'].map((job) => laneLabel({ job, phase: '36' }, 'ru')), ['фаза 36', 'подготовка фазы 36', 'разметка']);
});

test('supervisorLanes: slots lanes in order (phases, prep, annotate); v0.3\'s lane in the same shape; nothing without either', () => {
  assert.deepEqual(supervisorLanes(SUP, root).map((l) => l.key), ['34', 'prep-36', 'annotate']);
  const v03 = supervisorLanes({ lane: { phase: 7, sessionId: 'abc', restarts: 1, mode: 'full' } }, root);
  assert.deepEqual(v03, [{ phase: '7', sessionId: 'abc', restarts: 1, mode: 'full', key: '7', job: 'phase', slot: 0, slotPath: path.resolve(root), branch: null }]);
  assert.deepEqual(supervisorLanes(null, root), []);
  assert.deepEqual(supervisorLanes({ lane: null }, root), []);
  assert.equal(laneForPhase(SUP, root, '34').slot, 1);
  assert.equal(laneForPhase(SUP, root, '36'), null, 'a prep lane is no phase lane');
  assert.equal(laneAt(SUP, root, slot(2)).key, 'prep-36');
  assert.equal(laneAt(SUP, root, root), null, 'slots mode: no lane works in the main checkout');
  assert.equal(laneAt({ lane: { phase: '7' } }, root, root).phase, '7');
  assert.deepEqual([{ job: 'annotate' }, { job: 'phase', phase: '10' }, { job: 'prep', phase: '2' }, { job: 'phase', phase: '9' }].sort(compareLanes).map((l) => l.phase ?? 'a'), ['9', '10', '2', 'a']);
});

test('the summary line of status (spec §8): lanes, questions and what the next phase waits for, in English and Russian', () => {
  const next = { phase: '36', why: 'deps', waitsFor: ['34'] };
  assert.equal(lanesSummary({ lanes: 3, questions: 1, next }), 'lanes: 3 · questions: 1 · next: phase 36 waits for phase 34');
  assert.equal(lanesSummary({ lanes: 3, questions: 1, next }, 'ru'), 'полосы: 3 · вопросы: 1 · следующая: фаза 36 ждёт фазу 34');
  assert.equal(lanesSummary({ lanes: 0, questions: 0, next: null }), 'lanes: 0 · questions: 0');
  assert.equal(nextLine({ phase: '36', why: 'deps', waitsFor: ['34', '35'] }), 'phase 36 waits for phases 34, 35');
  assert.equal(nextLine({ phase: '36', why: 'deps', waitsFor: ['34', '35'] }, 'ru'), 'фаза 36 ждёт фазы 34, 35');
  assert.equal(nextLine({ phase: '36', why: 'areas', waitsFor: ['34'] }), 'phase 36 waits for phase 34 (same files)');
  assert.equal(nextLine({ phase: '36', why: 'areas', waitsFor: ['34'] }, 'ru'), 'фаза 36 ждёт фазу 34 (общие файлы)');
  assert.equal(nextLine({ phase: '36', why: 'gates', waitsFor: ['34'], gate: 'prod-deploy' }), 'phase 36 waits for prod-deploy (held by phase 34)');
  assert.equal(nextLine({ phase: '36', why: 'gates', waitsFor: ['34'], gate: 'prod-deploy' }, 'ru'), 'фаза 36 ждёт prod-deploy (держит фаза 34)');
  assert.equal(nextLine({ phase: '36', why: 'gates', waitsFor: [], gate: 'prod-deploy' }), 'phase 36 waits for prod-deploy');
  assert.equal(nextLine({ phase: '36', why: 'slots', waitsFor: [] }), 'phase 36 waits for a free slot');
  assert.equal(nextLine({ phase: '36', why: 'slots', waitsFor: [] }, 'ru'), 'фаза 36 ждёт свободный слот');
  assert.equal(nextLine({ phase: '36', why: 'annotation', waitsFor: ['34'] }), 'phase 36 waits for the lane annotation');
  assert.equal(nextLine({ phase: '36', why: 'annotation', waitsFor: ['34'] }, 'ru'), 'фаза 36 ждёт разметку');
  assert.equal(nextLine(null), null);
});

test('setupLines: what start prints after building the slots (L0 setupSlots result)', () => {
  const p = 'C:\\Users\\dev\\app.turbo\\lane-';
  assert.deepEqual(setupLines({
    dir: 'C:\\Users\\dev\\app.turbo',
    slots: [
      { k: 1, path: `${p}1`, action: 'kept', why: null, trust: { status: 'already' } },
      { k: 2, path: `${p}2`, action: 'created', why: null, trust: { status: 'trusted' } },
      { k: 3, path: `${p}3`, action: 'created', why: null, trust: { status: 'manual', line: `open claude in ${p}3 once and accept the trust dialog`, why: 'unknown format' } },
      { k: 4, path: `${p}4`, action: 'refused', why: 'not a slot of this project', trust: null },
    ],
    backup: 'C:\\Users\\dev\\.claude.json.turbo-bak-20261013T120000Z',
  }), [
    `lane-1: kept ${p}1`, 'lane-1: trusted (already)',
    `lane-2: created ${p}2`, 'lane-2: trusted',
    `lane-3: created ${p}3`, `lane-3: open claude in ${p}3 once and accept the trust dialog (unknown format)`,
    'lane-4: refused: not a slot of this project',
    'backup: C:\\Users\\dev\\.claude.json.turbo-bak-20261013T120000Z',
  ]);
});
