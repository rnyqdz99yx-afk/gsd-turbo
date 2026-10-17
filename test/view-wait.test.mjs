import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAIT_KINDS, shownNext } from '../lib/view.mjs';

// Stage 4 (reconcile R4): the scheduler writes supervisor.json next ({ phase, why, waitsFor, gate? }) every tick; the
// view only carries it, cleaned, and never computes it again.
test('shownNext carries supervisor.json next as the scheduler wrote it, cleaned; anything it cannot show reads as none', () => {
  assert.deepEqual(WAIT_KINDS, ['deps', 'areas', 'gates', 'slots', 'annotation', 'merge']);
  const sup = (next, over = {}) => ({ pid: 1, finished: false, halted: false, lanes: {}, next, ...over });
  assert.deepEqual(shownNext(sup({ phase: '36', why: 'deps', waitsFor: ['34', '33'] })), { phase: '36', why: 'deps', waitsFor: ['34', '33'], gate: null });
  assert.deepEqual(shownNext(sup({ phase: 36, why: 'gates', waitsFor: [33], gate: 'prod-deploy' })), { phase: '36', why: 'gates', waitsFor: ['33'], gate: 'prod-deploy' });
  assert.deepEqual(shownNext(sup({ phase: '36', why: 'slots', waitsFor: [] })), { phase: '36', why: 'slots', waitsFor: [], gate: null });
  assert.deepEqual(shownNext(sup({ phase: '36', why: 'merge' })), { phase: '36', why: 'merge', waitsFor: [], gate: null }, 'no waitsFor: none');
  assert.deepEqual(shownNext(sup({ phase: '3\x1b[2J6', why: 'areas', waitsFor: ['3\u202e2', null, { x: 1 }], gate: 'lab-\x07printer' })), { phase: '36', why: 'areas', waitsFor: ['32'], gate: 'lab-printer' }, 'escapes and controls dropped, entries that are not ids left out');
  for (const bad of [null, undefined, 'x', [], {}, { phase: null, why: 'deps' }, { phase: '', why: 'deps' }, { phase: '36', why: 'mystery' }, { phase: '36' }]) assert.equal(shownNext(sup(bad)), null, JSON.stringify(bad));
  assert.equal(shownNext(sup({ phase: '36', why: 'deps', waitsFor: ['34'] }, { finished: true })), null, 'a finished run waits for nothing');
  assert.equal(shownNext(null), null);
  assert.equal(shownNext([]), null);
});
