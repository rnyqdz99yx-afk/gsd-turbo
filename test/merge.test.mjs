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
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED, gitIn } from './helpers/slots.mjs';
import { PHASE_DIR, fakeDigest, fakeGsd } from './helpers/lane-merge.mjs';
import { quietCommits, restampDigest, verificationFingerprint, mergeFile } from '../lib/merge.mjs';
import { readJson, writeJsonAtomic } from '../lib/fsx.mjs';
import { requestFile } from '../lib/push.mjs';

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
  // review I2: the card reaches the owner through the question channel; needs-owner would make L1 notify again
  assert.equal(r.outcome, 'wait');
  assert.equal(mergeState(p.root, '3').state, 'needs-owner');
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

const VERIFICATION = `${PHASE_DIR}/03-VERIFICATION.md`;
const readMain = (p, rel) => fs.readFileSync(path.join(p.root, ...rel.split('/')), 'utf8');

test('verificationFingerprint reads a block or a flow list, quoted or not, LF or CRLF; restampDigest rewrites exactly one line', () => {
  const block = '---\nstatus: passed\ncovered_files:\n  - src/a.js\n  - ".planning/phases/03-demo/03-01-SUMMARY.md"\ncovered_digest: "v3:sha256:old"\n---\n# body\ncovered_digest: not frontmatter\n';
  assert.deepEqual(verificationFingerprint(block), { files: ['src/a.js', '.planning/phases/03-demo/03-01-SUMMARY.md'], digest: 'v3:sha256:old' });
  assert.deepEqual(verificationFingerprint(block.replace(/\n/g, '\r\n')), { files: ['src/a.js', '.planning/phases/03-demo/03-01-SUMMARY.md'], digest: 'v3:sha256:old' });
  assert.deepEqual(verificationFingerprint("---\ncovered_files: [src/a.js, 'src/b.js']\ncovered_digest: v3:sha256:x\n---\n"), { files: ['src/a.js', 'src/b.js'], digest: 'v3:sha256:x' });
  assert.equal(verificationFingerprint('---\nstatus: passed\n---\n'), null, 'a legacy report without a fingerprint');
  assert.equal(verificationFingerprint('# no frontmatter\n'), null);
  assert.equal(restampDigest(block, 'v3:sha256:new'), block.replace('"v3:sha256:old"', '"v3:sha256:new"'));
  const crlf = block.replace(/\n/g, '\r\n');
  assert.equal(restampDigest(crlf, 'v3:sha256:new'), crlf.replace('"v3:sha256:old"', '"v3:sha256:new"'));
  assert.equal(restampDigest('---\ncovered_digest: a\ncovered_digest: b\n---\n', 'v3:sha256:n'), null);
  assert.equal(restampDigest('---\nstatus: passed\n---\n', 'v3:sha256:n'), null);
});

test('quietCommits answers state-sync\'s commit itself and passes every other call on', () => {
  const seen = [];
  const gsd = quietCommits((args) => { seen.push(args[0]); return { ok: true }; });
  assert.deepEqual(gsd(['commit', 'docs: x', '--files', '.planning/STATE.md']), { committed: false, skipped: true, reason: 'the turbo merge commits it' });
  assert.deepEqual(gsd(['state', 'patch', '{}']), { ok: true });
  assert.deepEqual(seen, ['state']);
});

test('after the merge: phase.complete in main and one commit with ROADMAP and STATE; nothing re-stamped when the bytes agree', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const m = mergeCtx(p);
  const before = fs.readFileSync(path.join(p.slot, ...VERIFICATION.split('/')), 'utf8');
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(p.inMain('log', '-1', '--format=%s'), 'docs(phase-3): complete phase (turbo merge)');
  assert.equal(p.inMain('rev-parse', 'HEAD^'), mergeOf(p), 'one commit after the merge');
  assert.deepEqual(p.inMain('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['.planning/ROADMAP.md', '.planning/STATE.md']);
  assert.match(readMain(p, '.planning/ROADMAP.md'), /- \[x\] Phase 3 complete/);
  assert.equal(readMain(p, VERIFICATION), before);
  assert.deepEqual(m.calls.filter((c) => !c.startsWith('query verification.fingerprint')), ['query phase.complete 3']);
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=no'), '');
  const st = mergeState(p.root, '3');
  assert.deepEqual([st.completed, st.completeSha, st.finalSha, st.pushRequestId], [true, r.sha, r.sha, null]);
});

test('S3: core.autocrlf=true in main, LF in the slot: equal blobs, the digest re-stamped over main\'s bytes, phase.complete passes, one commit (Review Focus 3)', async () => {
  const p = laneProject();
  finishPhase(p);
  p.inMain('config', 'core.autocrlf', 'true');
  reportReady(p);
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.match(readMain(p, 'src/feature.js'), /\r\n$/, 'the main checkout wrote CRLF');
  const fp = verificationFingerprint(readMain(p, VERIFICATION));
  assert.equal(fp.digest, fakeDigest(p.root, fp.files, path.join(p.root, ...PHASE_DIR.split('/'))));
  assert.deepEqual(p.inMain('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['.planning/ROADMAP.md', '.planning/STATE.md', VERIFICATION]);
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=no'), '');
});

test('phase.complete fails: the merge stays, a re-stamp is committed alone, the phase waits for the owner with GSD\'s error', async () => {
  const p = laneProject();
  finishPhase(p);
  p.inMain('config', 'core.autocrlf', 'true');
  reportReady(p);
  const calls = [];
  const m = mergeCtx(p, { gsd: fakeGsd({ calls, fail: { 'query phase.complete': 'Error: Phase 3 cannot be completed: 1 plan(s) have no completion record' } }) });
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'needs-owner');
  assert.equal(r.reason, 'phase.complete failed after the merge of phase 3: gsd-tools query phase.complete failed: Error: Phase 3 cannot be completed: 1 plan(s) have no completion record; the merge stays');
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
  assert.equal(p.inMain('log', '-1', '--format=%s'), 'docs(phase-3): re-stamp verification after the merge (turbo merge)');
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=no'), '');
  // L1's mergeStep notifies the owner of a needs-owner outcome; L2 sends nothing itself, and (review I1) keeps the ready
  // record, so L1's lane status does not tell the owner a second time; the next call waits
  assert.deepEqual([readLaneStatus(p.root, '3').status, m.notes.length], ['ready', 0]);
  assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'wait');
  assert.equal(mergeState(p.root, '3').completed, undefined);
});

test('a restart after the merge: no second merge commit; a covered file changed in main meanwhile goes to the owner (Review Focus 2)', async () => {
  const crashAfterMerge = (p) => {
    const rec = readLaneStatus(p.root, '3');
    p.inMain('fetch', '-q', p.slot, 'refs/heads/turbo/p3');
    p.inMain('merge', '--no-ff', '-q', '-m', 'Merge phase 3 (turbo lane 1)', rec.head);
    writeJsonAtomic(mergeFile(p.root, '3'), { v: 1, phase: '3', state: 'merging', readyAt: rec.at, laneHead: rec.head, base: rec.base, slot: 1, branch: 'turbo/p3', mergeSha: p.inMain('rev-parse', 'HEAD'), rounds: 0 });
  };
  const clean = laneProject();
  finishPhase(clean);
  reportReady(clean);
  crashAfterMerge(clean);
  const r = await mergeReady(mergeCtx(clean).ctx, laneOf(clean));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(clean.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
  assert.equal(clean.inMain('log', '-1', '--format=%s'), 'docs(phase-3): complete phase (turbo merge)');

  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  crashAfterMerge(p);
  p.writeMain('src/feature.js', 'export const feature = 2;\n');
  p.commitMain('fix: by hand in main');
  const m = mergeCtx(p);
  const owner = await mergeReady(m.ctx, laneOf(p));
  assert.equal(owner.outcome, 'needs-owner');
  assert.equal(owner.reason, 'the merged tree differs from what phase 3\'s verification covered: src/feature.js; the merge stays');
  assert.equal(p.inMain('rev-list', '--merges', '--count', 'HEAD'), '1');
  assert.ok(!m.calls.includes('query phase.complete 3'));
});

test('push on: the supervisor files the push request for main at the head after the complete commit', async () => {
  process.env.CLAUDE_CONFIG_DIR = tmpDir('home');
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const m = mergeCtx(p, { push: { mode: 'after-phase', ci: 'none' } });
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  const req = readJson(requestFile(p.root, '3'), null);
  assert.deepEqual([req.branch, req.head, req.phase], ['main', r.sha, '3']);
  assert.equal(mergeState(p.root, '3').pushRequestId, req.id);
});

// review I3: a crash after phase.complete wrote its files and before the commit; or phase.complete failing half-way
test('a restart finds the supervisor\'s own uncommitted planning edits: they are redone, not a dirty main; a half-written phase.complete is undone', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const rec = readLaneStatus(p.root, '3');
  p.inMain('fetch', '-q', p.slot, 'refs/heads/turbo/p3');
  p.inMain('merge', '--no-ff', '-q', '-m', 'Merge phase 3 (turbo lane 1)', rec.head);
  writeJsonAtomic(mergeFile(p.root, '3'), { v: 1, phase: '3', state: 'merging', readyAt: rec.at, laneHead: rec.head, base: rec.base, slot: 1, branch: 'turbo/p3', mergeSha: p.inMain('rev-parse', 'HEAD'), rounds: 0 });
  p.writeMain('.planning/ROADMAP.md', '# Roadmap\n- [x] Phase 3 complete\n');
  p.writeMain('.planning/STATE.md', '# State\n\nStatus: Phase 3 complete\n');
  const m = mergeCtx(p);
  const r = await mergeReady(m.ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(p.inMain('log', '-1', '--format=%s'), 'docs(phase-3): complete phase (turbo merge)');
  assert.equal((readMain(p, '.planning/ROADMAP.md').match(/Phase 3 complete/g) || []).length, 1);
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=no'), '');

  const q = laneProject();
  finishPhase(q);
  reportReady(q);
  const half = fakeGsd();
  const gsd = (args, o) => {
    if (args[1] === 'phase.complete') {
      fs.writeFileSync(path.join(o.cwd, '.planning', 'STATE.md'), 'half written\n');
      throw new Error('gsd-tools query phase.complete failed: Error: disk full');
    }
    return half(args, o);
  };
  const out = await mergeReady(mergeCtx(q, { gsd }).ctx, laneOf(q));
  assert.equal(out.outcome, 'needs-owner');
  assert.equal(q.inMain('status', '--porcelain', '--untracked-files=no'), '', 'the main checkout stays clean for the other lanes');
});

// review I4: the D9 path after the supervisor's own re-stamp was committed (S3) is not a verification mismatch
test('a restart after the complete commit with a re-stamped report: no mismatch, no second phase.complete', async () => {
  const p = laneProject();
  finishPhase(p);
  p.inMain('config', 'core.autocrlf', 'true');
  reportReady(p);
  const m = mergeCtx(p);
  const first = await mergeReady(m.ctx, laneOf(p));
  assert.equal(first.outcome, 'merged', first.reason);
  // the crash came between the complete commit and the merge record's last save
  const st = mergeState(p.root, '3');
  writeJsonAtomic(mergeFile(p.root, '3'), { ...st, state: 'merging', completed: undefined, completeSha: undefined });
  const again = await mergeReady(m.ctx, laneOf(p));
  assert.equal(again.outcome, 'merged', again.reason);
  assert.equal(again.sha, first.sha);
  assert.equal(m.calls.filter((c) => c === 'query phase.complete 3').length, 1);
});

// review M10: an owner answer that lands while the phase completes is not folded into the complete commit
test('the complete commit holds only the phase\'s planning files, never owner answers', async () => {
  const p = laneProject({ files: { '.planning/turbo/answers/p9.json': '[]\n' } });
  finishPhase(p);
  reportReady(p);
  const base = fakeGsd();
  const gsd = (args, o) => {
    if (args[1] === 'phase.complete') fs.writeFileSync(path.join(o.cwd, '.planning', 'turbo', 'answers', 'p9.json'), '[{"id":"late"}]\n');
    return base(args, o);
  };
  const r = await mergeReady(mergeCtx(p, { gsd }).ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.ok(!p.inMain('show', '--name-only', '--format=', 'HEAD').includes('answers'));
});

// smoke F6: GSD 1.16 publishes .planning/state.json (never committed, never ignored by GSD) after every phase.* and state.*
// step that wrote planning files (state-contract.cjs publishStateContract), so the supervisor's phase.complete and
// state-sync in the main checkout left an untracked one behind
const publishing = (base) => (args, o) => {
  const out = base(args, o);
  if (args[1] === 'phase.complete') {
    fs.writeFileSync(path.join(o.cwd, '.planning', 'state.json'), `{"completed":"${args[2]}"}\n`);
  }
  return out;
};

test('the GSD state.json the supervisor\'s phase.complete publishes in the main checkout goes again when main had none; the owner\'s own and a tracked one stay', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const r = await mergeReady(mergeCtx(p, { gsd: publishing(fakeGsd()) }).ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(fs.existsSync(path.join(p.root, '.planning', 'state.json')), false);
  assert.equal(p.inMain('status', '--porcelain', '--untracked-files=all', '--', '.planning'), '', 'no untracked leftover in main');

  // the owner's GSD keeps one in the main checkout: GSD updates it and it stays, untracked
  const q = laneProject();
  finishPhase(q);
  reportReady(q);
  q.writeMain('.planning/state.json', '{"owner":true}\n');
  assert.equal((await mergeReady(mergeCtx(q, { gsd: publishing(fakeGsd()) }).ctx, laneOf(q))).outcome, 'merged');
  assert.equal(readMain(q, '.planning/state.json'), '{"completed":"3"}\n');

  // a project that tracks it: the complete commit takes GSD's update, as with ROADMAP and STATE
  const t = laneProject({ files: { '.planning/state.json': '{}\n' } });
  finishPhase(t);
  reportReady(t);
  assert.equal((await mergeReady(mergeCtx(t, { gsd: publishing(fakeGsd()) }).ctx, laneOf(t))).outcome, 'merged');
  assert.equal(t.inMain('show', 'HEAD:.planning/state.json'), '{"completed":"3"}');
  assert.equal(t.inMain('status', '--porcelain'), '');
});

test('a restart after a crash that left the published state.json: main\'s record from the first try decides, so it still goes', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const rec = readLaneStatus(p.root, '3');
  // the first try recorded that main had no state.json, merged, and crashed right after phase.complete published one
  p.inMain('fetch', '-q', p.slot, 'refs/heads/turbo/p3');
  p.inMain('merge', '--no-ff', '-q', '-m', 'Merge phase 3 (turbo lane 1)', rec.head);
  writeJsonAtomic(mergeFile(p.root, '3'), { v: 1, phase: '3', state: 'merging', readyAt: rec.at, laneHead: rec.head, base: rec.base, slot: 1, branch: 'turbo/p3', mergeSha: p.inMain('rev-parse', 'HEAD'), rounds: 0, gsdStateBefore: false });
  p.writeMain('.planning/state.json', '{"crashed":true}\n');
  const r = await mergeReady(mergeCtx(p, { gsd: publishing(fakeGsd()) }).ctx, laneOf(p));
  assert.equal(r.outcome, 'merged', r.reason);
  assert.equal(fs.existsSync(path.join(p.root, '.planning', 'state.json')), false);
});

test('review: the published state.json goes on every way out of the complete stage (a failure for the owner too), and also when the project ignores it', async () => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const base = publishing(fakeGsd());
  const failing = (args, o) => {
    const out = base(args, o);
    if (args[1] === 'phase.complete') throw new Error('gsd-tools query phase.complete failed: Error: disk full');
    return out;
  };
  const r = await mergeReady(mergeCtx(p, { gsd: failing }).ctx, laneOf(p));
  assert.equal(r.outcome, 'needs-owner');
  assert.equal(fs.existsSync(path.join(p.root, '.planning', 'state.json')), false);

  const q = laneProject({ files: { '.planning/.gitignore': 'state.json\n' } });
  finishPhase(q);
  reportReady(q);
  assert.equal((await mergeReady(mergeCtx(q, { gsd: publishing(fakeGsd()) }).ctx, laneOf(q))).outcome, 'merged');
  assert.equal(fs.existsSync(path.join(q.root, '.planning', 'state.json')), false, 'ignored, but main had none before');
});

test('review: a removal that failed leaves a mark and is logged (POSIX); the next merge counts that state.json as turbo\'s, removes it and clears the mark', async (t) => {
  const p = laneProject();
  finishPhase(p);
  reportReady(p);
  const file = path.join(p.root, '.planning', 'state.json');
  const mark = path.join(p.root, '.planning', 'turbo', 'run', 'gsd-state-left');
  // a read-only file on Windows, a read-only folder elsewhere: the removal fails (unless this runs as root)
  const lock = process.platform === 'win32' ? file : path.dirname(file);
  const base = publishing(fakeGsd());
  const locking = (args, o) => {
    const out = base(args, o);
    if (args[1] === 'phase.complete') fs.chmodSync(lock, process.platform === 'win32' ? 0o444 : 0o555);
    return out;
  };
  const m = mergeCtx(p, { gsd: locking });
  try {
    assert.equal((await mergeReady(m.ctx, laneOf(p))).outcome, 'merged');
  } finally {
    if (fs.existsSync(lock)) fs.chmodSync(lock, process.platform === 'win32' ? 0o666 : 0o755);
  }
  if (fs.existsSync(file)) {
    assert.ok(fs.existsSync(mark), 'the failed removal is marked');
    assert.ok(m.logs.some((l) => l.startsWith('merge p3: .planning/state.json not removed: ')), m.logs.join('\n'));
  } else t.diagnostic('the removal did not fail here: Node removes a read-only file on Windows, and root may remove anything');

  // the next merge: main seems to have a state.json of its own, but the mark says it is the one turbo left
  const q = laneProject();
  finishPhase(q);
  reportReady(q);
  q.writeMain('.planning/state.json', '{"left":true}\n');
  fs.mkdirSync(path.dirname(path.join(q.root, '.planning', 'turbo', 'run', 'gsd-state-left')), { recursive: true });
  fs.writeFileSync(path.join(q.root, '.planning', 'turbo', 'run', 'gsd-state-left'), 'earlier\n');
  assert.equal((await mergeReady(mergeCtx(q, { gsd: publishing(fakeGsd()) }).ctx, laneOf(q))).outcome, 'merged');
  assert.equal(fs.existsSync(path.join(q.root, '.planning', 'state.json')), false);
  assert.equal(fs.existsSync(path.join(q.root, '.planning', 'turbo', 'run', 'gsd-state-left')), false, 'the mark goes with it');
});
