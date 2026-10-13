import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { gitIn } from './helpers/slots.mjs';
import { finishPhase, laneOf, laneProject, mergeCtx, reportReady } from './helpers/lane-merge.mjs';
import { mergeFollowUp, mergeHolds, mergePlanningOnly, mergeReady, mergeState } from '../lib/merge.mjs';
import { setMergeHold } from '../lib/integrate.mjs';
import { STEPS, completeStep, readProgress } from '../lib/phase-progress.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { readSlotRecord } from '../lib/slots.mjs';
import { pushTick, recordFile } from '../lib/push.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { PHASE_DIR, fakeDigest } from './helpers/lane-merge.mjs';

// the push allow file lives in turbo's own directory: a throwaway one for this file
process.env.CLAUDE_CONFIG_DIR = tmpDir('home');

// A lane merged into main, its steps through close done (the supervisor marks integrate).
async function merged({ push = { mode: 'off' }, remote = false } = {}) {
  const p = laneProject();
  let bare = null;
  if (remote) {
    bare = path.join(tmpDir('bare'), 'remote.git');
    gitIn(p.root, 'init', '-q', '--bare', '-b', 'main', bare);
    p.inMain('remote', 'add', 'origin', bare);
    p.inMain('push', '-q', 'origin', 'main');
  }
  for (const s of STEPS.slice(0, STEPS.indexOf('integrate'))) completeStep(p.root, '3', s);
  finishPhase(p);
  reportReady(p);
  const m = mergeCtx(p, { push });
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  return { p, m, sha: r.sha, bare };
}
// What S2's CI watch leaves in the phase's push record, for a push of sha.
function ciRecord(p, sha, state, { phase = '3', requestId = mergeState(p.root, '3').pushRequestId, at = '2026-10-13T13:05:00.000Z' } = {}) {
  writeJsonAtomic(recordFile(p.root, phase), {
    requestId, phase, remote: 'origin', at, outcome: 'pushed', branch: 'main', sha,
    lastPush: { requestId, sha, branch: 'main', remote: 'origin', at, ci: { state, since: at, runs: [] } },
  });
}

test('push off: the slot is released at once; integrate done, the lane done, the hold gone; a second call waits', async () => {
  const { p, m, sha } = await merged();
  setMergeHold(p.slot, '3');
  const r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'released', sha });
  const job = readSlotRecord(p.slot).job;
  assert.deepEqual([job.state, job.outcome], ['done', 'merged']);
  assert.ok(readProgress(p.root, '3').done.includes('integrate'));
  assert.equal(readProgress(p.root, '3').notes.integrate, `merged into main at ${sha.slice(0, 12)}; CI off`);
  const lane = readLaneStatus(p.root, '3');
  assert.deepEqual([lane.status, lane.reason], ['done', `merged into main at ${sha.slice(0, 12)}; CI off`]);
  assert.deepEqual(mergeHolds(p.root), []);
  assert.equal(mergeState(p.root, '3').state, 'released');
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'wait');
});

test('push on, through S2\'s pushTick to a local bare remote: wait until pushed, then released with CI none', async () => {
  const { p, m, sha, bare } = await merged({ push: { mode: 'after-phase', ci: 'none' }, remote: true });
  let r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'wait', reason: `the supervisor has not pushed main at ${sha.slice(0, 12)} yet` });
  await pushTick(m.ctx, new Date('2026-10-13T13:01:00.000Z'));
  assert.equal(gitIn(p.root, 'ls-remote', bare, 'refs/heads/main').split(/\s/)[0], sha);
  r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'released', sha });
  assert.equal(readLaneStatus(p.root, '3').reason, `merged into main at ${sha.slice(0, 12)}; CI none`);
});

test('CI pending waits; red is told once per red commit and keeps the slot; green releases', async () => {
  const { p, m, sha } = await merged({ push: { mode: 'after-phase', ci: 'github' } });
  ciRecord(p, sha, 'pending');
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'wait');
  ciRecord(p, sha, 'red');
  let r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'ci-red', reason: `CI is red on main at ${sha.slice(0, 12)} after the merge of phase 3`, sha });
  r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'wait', reason: `CI is red on ${sha.slice(0, 12)}; phase 3 fixes it` });
  assert.equal(readSlotRecord(p.slot).job.state, 'active');
  ciRecord(p, sha, 'green');
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'released');
});

test('a refused push or a CI timeout goes to the owner and keeps the slot; the lane record is written once', async () => {
  const { p, m, sha } = await merged({ push: { mode: 'after-phase', ci: 'github' } });
  const id = mergeState(p.root, '3').pushRequestId;
  writeJsonAtomic(recordFile(p.root, '3'), { requestId: id, phase: '3', remote: 'origin', at: 'x', outcome: 'refused', branch: 'main', sha, findings: [{ file: 'a.log', kind: 'forbidden name *.log' }] });
  let r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.deepEqual(r, { outcome: 'needs-owner', reason: 'refused: a.log (forbidden name *.log); nothing was pushed', notified: true }, 'the push work told the owner already (pushRefused)');
  const written = readLaneStatus(p.root, '3');
  assert.equal(written.status, 'needs-owner');
  // L1's followUpStep keeps the lane at needs-owner while this lasts and notifies once per reason: the same answer again
  assert.deepEqual(await mergeFollowUp(m.ctx, laneOf(p)), r);
  assert.deepEqual(readLaneStatus(p.root, '3'), written);
  ciRecord(p, sha, 'timeout', { requestId: id });
  r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'needs-owner');
  assert.match(r.reason, /CI timeout/);
  assert.equal(r.notified, true, 'the push work told the owner already (ciTimeout)');
  assert.equal(readSlotRecord(p.slot).job.state, 'active');
});

test('a superseded CI watch follows the later push that holds the merge (Review Focus 5)', async () => {
  const { p, m, sha } = await merged({ push: { mode: 'after-phase', ci: 'github' } });
  ciRecord(p, sha, 'superseded');
  assert.match((await mergeFollowUp(m.ctx, laneOf(p))).reason, /no push that holds it has a result yet$/);
  // another phase merged and pushed after this one: its commit holds this merge
  p.writeMain('src/next.js', 'export const next = 1;\n');
  const later = p.commitMain('Merge phase 4 (turbo lane 2)');
  ciRecord(p, later, 'red', { phase: '4', requestId: 'r4', at: '2026-10-13T13:10:00.000Z' });
  const r = await mergeFollowUp(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'wait', 'the red belongs to the later push\'s phase');
  assert.match(r.reason, /the CI of the later push [0-9a-f]{12} that holds this merge is red$/);
  ciRecord(p, later, 'green', { phase: '4', requestId: 'r4', at: '2026-10-13T13:10:00.000Z' });
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'released');
  assert.equal(readLaneStatus(p.root, '3').reason, `merged into main at ${sha.slice(0, 12)}; CI green`);
});

test('a CI fix after red: the lane integrates again, the fix merges without a second phase.complete, the new push is watched', async () => {
  const { p, m, sha } = await merged({ push: { mode: 'after-phase', ci: 'github' } });
  ciRecord(p, sha, 'red');
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'ci-red');
  p.writeSlot('src/feature.js', 'export const feature = 1; // fixed\n');
  p.commitSlot('fix(03): CI red');
  // the lane's step integrate again: its re-verify refreshes the report (here: the fake verifier's fingerprint)
  const fix = reportReadyAfterFix(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(m.calls.filter((c) => c === 'query phase.complete 3').length, 1);
  // the slot's own "Merge main into turbo/p3" is in main's history too: count the supervisor's merges by their message
  assert.equal(p.inMain('log', '--merges', '--format=%s', 'HEAD').split('\n').filter((s) => s === 'Merge phase 3 (turbo lane 1)').length, 2);
  const st = mergeState(p.root, '3');
  assert.deepEqual([st.state, st.ciRed, st.finalSha === r.sha], ['merged', null, true]);
  assert.notEqual(st.pushRequestId, null);
  assert.ok(fix);
});

// The lane's re-verify after its fix (§7.1 p.3a), as the fake verifier does it: a fresh fingerprint over the slot's
// bytes, committed; then integrate and ready.
function reportReadyAfterFix(p) {
  const file = path.join(p.slot, ...PHASE_DIR.split('/'), '03-VERIFICATION.md');
  const text = fs.readFileSync(file, 'utf8');
  const digest = fakeDigest(p.slot, ['src/feature.js'], path.join(p.slot, ...PHASE_DIR.split('/')));
  fs.writeFileSync(file, text.replace(/^covered_digest: .*$/m, `covered_digest: "${digest}"`));
  p.commitSlot('docs(phase-3): re-verify after the CI fix');
  return reportReady(p);
}

// reconcile R5: L1's plugin loader takes lib/merge.mjs as it is (mergeReady, mergeFollowUp, mergeState, mergeHolds)
test('L1\'s plugin loader accepts lib/merge.mjs', async () => {
  const { loadLanePlugins } = await import('../lib/lane-plugins.mjs');
  const plugins = await loadLanePlugins({ importer: async (href) => (href.endsWith('/merge.mjs') ? import(href) : Promise.reject(Object.assign(new Error(`Cannot find module '${href.split('/').pop()}'`), { code: 'ERR_MODULE_NOT_FOUND' }))) });
  assert.deepEqual([plugins.mergeReady, plugins.mergeFollowUp, plugins.mergeState, plugins.mergeHolds], [mergeReady, mergeFollowUp, mergeState, mergeHolds]);
});

const prepLane = (p) => ({ key: 'prep-4', job: 'prep', phase: '4', slot: 1, slotPath: p.slot, branch: 'turbo/prep-4' });
// reconcile R9: L3 passes its allowedFor(job); this predicate stands in for it
const onlyPhase4 = { allowed: (f) => f.startsWith('.planning/phases/04-') };

test('mergePlanningOnly: a prep branch that touches only its phase directory merges even after main moved; a repeat is a no-op', async () => {
  const p = laneProject({ job: { kind: 'prep', phase: '4' } });
  p.writeSlot('.planning/phases/04-next/04-CONTEXT.md', '# Context\n');
  const tip = p.commitSlot('docs(04): context');
  p.writeMain('src/other.js', 'export const other = 1;\n');
  p.commitMain('feat: elsewhere');
  const m = mergeCtx(p);
  const r = await mergePlanningOnly(m.ctx, prepLane(p), onlyPhase4);
  assert.deepEqual([r.outcome, r.sha], ['merged', p.inMain('rev-parse', 'HEAD')]);
  assert.equal(p.inMain('log', '-1', '--format=%s'), 'Merge prep 4 (turbo lane 1)');
  assert.equal(p.inMain('rev-parse', 'HEAD^2'), tip);
  assert.deepEqual(await mergePlanningOnly(m.ctx, prepLane(p), onlyPhase4), { outcome: 'merged', reason: 'already in main', sha: r.sha });
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
  assert.equal(readSlotRecord(p.slot).job.state, 'active', 'L3 releases the slot itself');
});

test('mergePlanningOnly refuses a branch that touched anything else, needs the owner on a conflict, waits for a dirty main; main stays as it was', async () => {
  const p = laneProject({ job: { kind: 'prep', phase: '4' } });
  p.writeSlot('.planning/phases/04-next/04-CONTEXT.md', '# Context\n');
  p.writeSlot('src/app.js', 'export const app = 9;\n');
  p.commitSlot('docs(04): context and a code edit');
  const m = mergeCtx(p);
  const head = p.inMain('rev-parse', 'HEAD');
  let r = await mergePlanningOnly(m.ctx, prepLane(p), onlyPhase4);
  assert.deepEqual(r, { outcome: 'refused', reason: 'the branch turbo/prep-4 changes files it may not: src/app.js; nothing was merged' });
  assert.equal(p.inMain('rev-parse', 'HEAD'), head);

  const q = laneProject({ job: { kind: 'prep', phase: '4' } });
  q.writeSlot('.planning/phases/04-next/04-CONTEXT.md', '# Context: lane\n');
  q.commitSlot('docs(04): context');
  q.writeMain('.planning/phases/04-next/04-CONTEXT.md', '# Context: by hand\n');
  q.commitMain('docs(04): by hand');
  const mq = mergeCtx(q);
  r = await mergePlanningOnly(mq.ctx, prepLane(q), onlyPhase4);
  assert.equal(r.outcome, 'needs-owner');
  assert.match(r.reason, /^merging turbo\/prep-4 into main failed: .+; nothing was merged$/);
  assert.equal(fs.existsSync(path.join(q.root, '.git', 'MERGE_HEAD')), false);
  assert.equal(q.inMain('status', '--porcelain', '--untracked-files=no'), '');
  q.writeMain('src/app.js', 'dirty\n');
  r = await mergePlanningOnly(mq.ctx, prepLane(q), onlyPhase4);
  assert.deepEqual(r, { outcome: 'wait', reason: 'the main checkout has uncommitted changes: src/app.js' });
});

// review I5: after a failed push, the owner's own push request (a new id) that holds the merge is followed
test('a later push request for the phase that holds the merge decides after a failed one', async () => {
  const { p, m, sha } = await merged({ push: { mode: 'after-phase', ci: 'github' } });
  const id = mergeState(p.root, '3').pushRequestId;
  writeJsonAtomic(recordFile(p.root, '3'), { requestId: id, phase: '3', remote: 'origin', at: 'x', outcome: 'failed', branch: 'main', sha, reason: 'network down' });
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'needs-owner');
  ciRecord(p, sha, 'pending', { requestId: 'owner-retry' });
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'wait');
  ciRecord(p, sha, 'green', { requestId: 'owner-retry' });
  assert.equal((await mergeFollowUp(m.ctx, laneOf(p))).outcome, 'released');
});

// review I7: the release's own bookkeeping comes before the slot's release, so a stop in between never leaves a hold
test('the hold, the step and the lane record are settled before the slot is released', async () => {
  const { p, m } = await merged();
  setMergeHold(p.slot, '3');
  const seen = [];
  const ctx = { ...m.ctx, deps: { ...m.ctx.deps, releaseSlot: () => { seen.push([mergeHolds(p.root).length, readLaneStatus(p.root, '3').status, readProgress(p.root, '3').done.includes('integrate')]); throw new Error('stopped here'); } } };
  await assert.rejects(mergeFollowUp(ctx, laneOf(p)), /stopped here/);
  assert.deepEqual(seen, [[0, 'done', true]]);
});
