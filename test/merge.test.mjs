import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { finishPhase, laneOf, laneProject, mergeCtx, reportReady } from './helpers/lane-merge.mjs';
import * as merge from '../lib/merge.mjs';
import { mergeHolds, mergeReady, mergeState } from '../lib/merge.mjs';
import { mergeRounds } from '../lib/config.mjs';
import { mergeLockFile } from '../lib/merge-lock.mjs';
import { setMergeHold } from '../lib/integrate.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { readInbox } from '../lib/inbox.mjs';
import { readQuestions } from '../lib/questions.mjs';

const mergeOf = (p) => p.inMain('rev-list', '--merges', '-n', '1', 'HEAD');

// reconcile R6: merge_rounds is read through L1's mergeRounds (lib/config.mjs); lib/merge.mjs defines none of its own
test('merge rounds come from lib/config.mjs: 3 by default, and lib/merge.mjs has no copy of its own', () => {
  assert.equal(mergeRounds({}), 3);
  assert.equal(merge.mergeRounds, undefined);
  assert.equal(merge.MERGE_ROUNDS_DEFAULT, undefined);
});

test('HEAD == base: the verified tip merges with --no-ff and the spec\'s message; the merge tree is the lane\'s tree; the same ready record is decided once', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const rec = readLaneStatus(p.root, '3');
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  const merge = mergeOf(p);
  assert.equal(p.inMain('log', '-1', '--format=%s', merge), 'Merge phase 3 (turbo lane 1)');
  assert.deepEqual([p.inMain('rev-parse', `${merge}^1`), p.inMain('rev-parse', `${merge}^2`)], [rec.base, rec.head]);
  assert.equal(p.inMain('rev-parse', `${merge}^{tree}`), p.inMain('rev-parse', `${rec.head}^{tree}`));
  assert.equal(r.sha, p.inMain('rev-parse', 'HEAD'));
  const st = mergeState(p.root, '3');
  assert.deepEqual([st.state, st.readyAt, st.laneHead, st.mergeSha, st.rounds], ['merged', rec.at, rec.head, merge, 0]);
  const again = await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual([again.outcome, again.reason], ['wait', 'phase 3\'s ready record was handled already (merged)']);
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
});

test('HEAD != base: a reintegrate message in the lane\'s inbox, once per ready record; after it integrates again the merge goes through and the rounds reset', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  p.writeMain('src/other.js', 'export const other = 2;\n');
  const moved = p.commitMain('feat: another phase merged first');
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'reintegrate');
  assert.match(r.reason, /^main is at [0-9a-f]{12}, the lane integrated [0-9a-f]{12} \(round 1 of 3\)$/);
  const msg = readInbox(p.root, '3').at(-1);
  assert.deepEqual([msg.kind, msg.base, msg.round, msg.of], ['reintegrate', moved, 1, 3]);
  assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'wait');
  assert.equal(readInbox(p.root, '3').length, 1, 'no second message for the same ready record');
  reportReady(p);
  assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'merged');
  assert.equal(mergeState(p.root, '3').rounds, 0);
});

test('more than merge_rounds in a row: a card for the owner instead; the owner\'s wait (a hold) gives a fresh budget', async () => {
  const p = laneProject();
  finishPhase(p);
  const m = mergeCtx(p, { merge_rounds: 1, lang: 'ru' });
  const move = (n) => { p.writeMain(`src/m${n}.js`, `export const m = ${n};\n`); p.commitMain(`feat: m${n}`); };
  reportReady(p);
  move(1);
  assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'reintegrate');
  reportReady(p);
  move(2);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'needs-owner');
  assert.match(r.reason, /^the main branch moved 1 times in a row before phase 3 could be merged; owner question ask-1$/);
  const q = readQuestions(p.root, '3').find((x) => x.id === 'ask-1');
  assert.equal(q.options.length, 2);
  assert.match(q.question, /^Фазу 3 не удаётся влить/);
  assert.equal(readLaneStatus(p.root, '3').status, 'needs-owner');
  assert.equal(m.notes.length, 0, 'the card reaches the owner through the question channel, not a second notification');
  // the owner chose to wait: the lane sets the hold and integrates again; main moves once more
  setMergeHold(p.slot, '3', { now: new Date('2026-10-13T14:00:00.000Z') });
  assert.deepEqual(mergeHolds(p.root), ['3']);
  reportReady(p);
  move(3);
  const after = await mergeReady(m.ctx, laneOf(p));
  assert.equal(after.outcome, 'reintegrate');
  assert.match(after.reason, /\(round 1 of 1\)$/);
});

test('the main checkout dirty or on another branch: wait, the owner told once per reason; nothing merged', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const m = mergeCtx(p);
  p.writeMain('src/app.js', 'export const app = 5;\n');
  let r = await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual([r.outcome, r.reason], ['wait', 'the main checkout has uncommitted changes: src/app.js']);
  await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual(m.notes, [['mergeWaiting', { phase: '3', why: 'the main checkout has uncommitted changes: src/app.js' }]]);
  p.inMain('checkout', '--', 'src/app.js');
  p.inMain('checkout', '-q', '-b', 'side');
  r = await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual([r.outcome, r.reason], ['wait', 'the main checkout is on side, not on main']);
  assert.equal(m.notes.length, 2);
  p.inMain('checkout', '-q', 'main');
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '0');
  assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'merged');
});

test('an uncommitted owner answer neither blocks the merge nor costs a round; it is committed after the merge (Review Focus 1)', async () => {
  const p = laneProject({ files: { '.planning/turbo/answers/p9.json': '[]\n' } });
  finishPhase(p);
  reportReady(p);
  p.writeMain('.planning/turbo/answers/p9.json', '[{"id":"9-01-t1"}]\n');
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(p.inMain('show', 'HEAD:.planning/turbo/answers/p9.json'), '[{"id":"9-01-t1"}]');
  assert.equal(readInbox(p.root, '3').length, 0);
});

test('a lane tip that moved after ready is never merged (Review Focus 4)', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  p.writeSlot('src/late.js', 'export const late = 1;\n');
  p.commitSlot('feat: after ready');
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'wait');
  assert.match(r.reason, /^the lane's branch turbo\/p3 is at [0-9a-f]{12}, not at the [0-9a-f]{12} it reported ready; waiting for its next ready$/);
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '0');
});

test('a held merge lock or no ready record: wait, nothing changes', async () => {
  const p = laneProject();
  finishPhase(p);
  const m = mergeCtx(p);
  let r = await mergeReady(m.ctx, laneOf(p));
  assert.deepEqual([r.outcome, r.reason], ['wait', 'phase 3 has no ready record for turbo/p3']);
  reportReady(p);
  fs.mkdirSync(path.dirname(mergeLockFile(p.root)), { recursive: true });
  fs.writeFileSync(mergeLockFile(p.root), 'other-process');
  r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'wait');
  assert.match(r.reason, /^main is busy: another turbo-run holds the merge lock/);
  fs.rmSync(mergeLockFile(p.root));
  assert.equal(mergeState(p.root, '3'), null);
});
