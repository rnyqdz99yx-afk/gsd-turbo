import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { PHASES, ROADMAP } from './fixtures/roadmap-lanes.mjs';
import { writeAnswers } from '../lib/questions.mjs';
import { readAnnotateAttempt, readJobStatus, writeAnnotateAttempt, writeJobStatus } from '../lib/run-status.mjs';
import { roadmapFile, writeLanesFile } from '../lib/lanes-file.mjs';
import { roadmapDigest } from '../lib/roadmap-lanes.mjs';
import { ANNOTATE_PHASE, MARKUP_MIN_INDEPENDENT, annotateReason, finishJob, independentCount, jobName, jobPrompts, jobSystemPrompt, jobUserPrompt, pendingJobs } from '../lib/prep.mjs';
import { tmpRule } from '../lib/lane-prompt.mjs';

const MORE = [...PHASES, { number: '5', name: 'Ops', deps: ['4'], complete: false, closed: false }];
const ROADMAP5 = ROADMAP.replace('## Progress', '### Phase 5: Ops\n**Goal**: Deploy it\n**Depends on**: Phase 4\n\n## Progress');
// three phases independent by Depends on (3, 4, 5): lane markup pays (Stage 6 §5.5)
const WIDE = MORE.map((p) => (p.number === '5' ? { ...p, deps: [] } : p));
// prep.lookahead 10: every phase is in the prep window, as before Stage 6
const SLOTS = { lanes: { mode: 'slots' }, max_lanes: 3, prep: { lookahead: 10 } };

function project({ context = [] } = {}) {
  const root = tmpDir('pending');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'ROADMAP.md'), ROADMAP5);
  for (const n of context) {
    const dir = path.join(root, '.planning', 'phases', `0${n}-p${n}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `0${n}-CONTEXT.md`), '# ctx\n');
  }
  return root;
}
const ctx = (root, over = {}) => ({ root, config: SLOTS, lanes: {}, range: null, mode: 'full', ...over });
const all = (n) => Object.fromEntries(n.map((x) => [x, { areas: [`p${x}/**`], gates: [], confidence: 'high' }]));

test('prep first: every unfinished phase of the range without CONTEXT.md, in phase order, capped by max_prep', () => {
  const root = project({ context: ['2'] });
  assert.deepEqual(pendingJobs(ctx(root), MORE), [{ kind: 'prep', phase: '3' }, { kind: 'prep', phase: '4' }, { kind: 'prep', phase: '5' }]);
  assert.deepEqual(pendingJobs(ctx(root, { range: { from: '3', to: '4' } }), MORE).map((j) => j.phase), ['3', '4']);
  const lanes = { 3: { job: 'phase', phase: '3' }, 'prep-4': { job: 'prep', phase: '4' } };
  assert.deepEqual(pendingJobs(ctx(root, { lanes, config: { ...SLOTS, max_prep: 2 } }), MORE), [{ kind: 'prep', phase: '5' }]);
  assert.deepEqual(pendingJobs(ctx(root, { lanes, config: { ...SLOTS, max_prep: 1 } }), MORE), []);
  assert.deepEqual(pendingJobs(ctx(root, { config: { ...SLOTS, max_prep: 0 } }), MORE), []);
});

test('a failed or prepped prep is not queued again; checkout mode and safe mode queue nothing', () => {
  const root = project({ context: ['2'] });
  writeJobStatus(root, { kind: 'prep', phase: '3' }, 'failed', { reason: 'x' });
  writeJobStatus(root, { kind: 'prep', phase: '4' }, 'prepped');
  assert.deepEqual(pendingJobs(ctx(root), MORE), [{ kind: 'prep', phase: '5' }]);
  assert.deepEqual(pendingJobs(ctx(root, { config: { lanes: { mode: 'checkout' } } }), MORE), []);
  assert.deepEqual(pendingJobs(ctx(root, { mode: 'safe' }), MORE), []);
});

test('annotate after prep: only when no prep is due or running and no annotate lane runs', () => {
  const root = project({ context: ['2', '3', '4', '5'] });
  assert.deepEqual(pendingJobs(ctx(root), WIDE), [{ kind: 'annotate', phase: null }]);
  assert.deepEqual(pendingJobs(ctx(root, { lanes: { annotate: { job: 'annotate', phase: null } } }), WIDE), []);
  assert.deepEqual(pendingJobs(ctx(root, { lanes: { 'prep-6': { job: 'prep', phase: '6' } } }), WIDE), []);
  writeLanesFile(root, { phases: all(['2', '3', '4', '5']), pairs: [] });
  assert.deepEqual(pendingJobs(ctx(root), WIDE), [], 'fresh markup: nothing to do');
  fs.writeFileSync(roadmapFile(root), ROADMAP5.replace('**Depends on**: Phase 4', '**Depends on**: Phase 2'));
  assert.equal(annotateReason(root, MORE), 'phases');
  assert.deepEqual(pendingJobs(ctx(root), WIDE), [{ kind: 'annotate', phase: null }]);
});

test('a markup that failed on this same ROADMAP is not retried; a changed ROADMAP is', () => {
  const root = project({ context: ['2', '3', '4', '5'] });
  writeAnnotateAttempt(root, { status: 'failed', roadmapSha256: 'x' });
  assert.equal(annotateReason(root, MORE), 'phases');
  writeAnnotateAttempt(root, { status: 'failed', roadmapSha256: roadmapDigest(ROADMAP5) });
  assert.equal(annotateReason(root, MORE), null);
  writeAnnotateAttempt(root, { status: 'running', roadmapSha256: roadmapDigest(ROADMAP5) });
  assert.equal(annotateReason(root, MORE), 'phases', 'only a failure holds it back');
});

test('finishJob: merges with the job\'s predicate and releases the slot; a refusal fails the job; wait and needs-owner change nothing', async () => {
  const root = project({ context: ['2'] });
  const calls = [];
  const lane = { key: 'prep-3', job: 'prep', phase: '3', slot: 2, slotPath: '/home/dev/app.turbo/lane-2', branch: 'turbo/prep-3' };
  const merge = async (c, l, { allowed }) => {
    calls.push(['merge', l.key, allowed('.planning/phases/03-p3/03-CONTEXT.md'), allowed('.planning/STATE.md')]);
    return { outcome: 'merged', sha: 'abc' };
  };
  const release = (r, slot, { outcome }) => calls.push(['release', slot, outcome]);
  assert.deepEqual(await finishJob({ root }, lane, { merge, release }), { outcome: 'merged', sha: 'abc' });
  assert.deepEqual(calls, [['merge', 'prep-3', true, false], ['release', 2, 'merged']]);
  calls.length = 0;
  const r = await finishJob({ root }, lane, { merge: async () => ({ outcome: 'refused', reason: 'changed .planning/STATE.md' }), release });
  assert.deepEqual(r, { outcome: 'failed', reason: 'merge refused: changed .planning/STATE.md' }, 'reconcile R7: refused maps to failed');
  assert.deepEqual(calls, [['release', 2, 'failed']]);
  assert.deepEqual([readJobStatus(root, { kind: 'prep', phase: '3' }).status, readJobStatus(root, { kind: 'prep', phase: '3' }).reason], ['failed', 'merge refused: changed .planning/STATE.md']);
  for (const outcome of ['wait', 'needs-owner']) {
    calls.length = 0;
    assert.equal((await finishJob({ root }, lane, { merge: async () => ({ outcome }), release })).outcome, outcome);
    assert.deepEqual(calls, []);
  }
  await assert.rejects(finishJob({ root }, { ...lane, job: 'phase' }, { merge, release }), /no planning-only merge for a phase job/);
  await assert.rejects(finishJob({ root }, lane, { merge: async () => ({ outcome: 'reintegrate' }), release }), /unknown outcome/);
});

test('finishJob: L2 lib/merge.mjs is loaded lazily; without it the job waits, any other load error is thrown', async () => {
  const root = project({ context: ['2'] });
  const lane = { key: 'prep-3', job: 'prep', phase: '3', slot: 2, slotPath: '/home/dev/app.turbo/lane-2' };
  const release = () => assert.fail('no release while waiting');
  const missing = async (href) => {
    assert.match(href, /\/merge\.mjs$/);
    throw Object.assign(new Error(`Cannot find module '${href.replace('file:///', '/')}' imported from x`), { code: 'ERR_MODULE_NOT_FOUND' });
  };
  const r = await finishJob({ root }, lane, { importer: missing, release });
  assert.equal(r.outcome, 'wait');
  assert.match(r.reason, /lib\/merge\.mjs/);
  const broken = async () => { throw Object.assign(new Error("Cannot find module '/x/lib/git-helpers.mjs' imported from /x/lib/merge.mjs"), { code: 'ERR_MODULE_NOT_FOUND' }); };
  await assert.rejects(finishJob({ root }, lane, { importer: broken, release }), /git-helpers/);
  const merged = [];
  const fine = async () => ({ mergePlanningOnly: async (c, l) => { merged.push(l.key); return { outcome: 'merged' }; } });
  assert.equal((await finishJob({ root }, lane, { importer: fine, release: () => {} })).outcome, 'merged');
  assert.deepEqual(merged, ['prep-3']);
});

test('jobPrompts: L1\'s plugin shape; a relaunch or a wake resumes', () => {
  const ctx = { turboRun: 'node /home/dev/.claude/turbo/bin/turbo-run.mjs', config: { context_stop_pct: 50 } };
  const lane = { key: 'prep-5', job: 'prep', phase: '5', slotPath: '/home/dev/app.turbo/lane-1' };
  const p = jobPrompts({ ctx, lane, resume: false, wake: null });
  assert.equal(p.prompt, 'Run the turbo-prep skill with arguments: 5');
  assert.ok(p.systemPrompt.includes('reports 50 percent'));
  assert.match(jobPrompts({ ctx, lane, resume: true }).prompt, /^Resume preparing phase 5\./);
  assert.match(jobPrompts({ ctx, lane, resume: false, wake: { kind: 'stall', minutes: 15 } }).prompt, /^Resume preparing phase 5\./);
  assert.ok(jobPrompts({ ctx, lane: { key: 'annotate', job: 'annotate', phase: null } }).prompt.includes('annotate brief'));
});

test('an answered dependency card queues a markup job even when the markup is fresh', () => {
  const root = project({ context: ['2', '3', '4', '5'] });
  writeLanesFile(root, { phases: all(['2', '3', '4', '5']), pairs: [], proposal: { id: 'ask-1', state: 'asked', at: 'x', relax: [{ id: 'r1', phase: '5', drop: ['4'] }] } });
  assert.equal(annotateReason(root, MORE), null, 'not answered yet');
  writeAnswers(root, ANNOTATE_PHASE, [{ id: 'ask-1', option: 1, label: 'Remove all', answer: 'Remove all', by: 'session', at: 'x' }], { warn: () => {} });
  assert.equal(annotateReason(root, MORE), 'answer');
  assert.deepEqual(pendingJobs(ctx(root), MORE), [{ kind: 'annotate', phase: null }]);
});

test('reconcile R7: a job key in failed (supervisor.json jobsFailed) is never queued', () => {
  const root = project({ context: ['2'] });
  assert.deepEqual(pendingJobs(ctx(root, { failed: ['prep-3', 'prep-5'] }), MORE), [{ kind: 'prep', phase: '4' }]);
  const done = project({ context: ['2', '3', '4', '5'] });
  assert.deepEqual(pendingJobs(ctx(done), WIDE), [{ kind: 'annotate', phase: null }]);
  assert.deepEqual(pendingJobs(ctx(done, { failed: ['annotate'] }), WIDE), []);
});

test('reconcile R6: max_prep is lib/config.mjs maxPrep against max_lanes (null: max_lanes)', () => {
  const root = project();
  assert.equal(pendingJobs(ctx(root, { config: { ...SLOTS, max_lanes: 2 } }), MORE).length, 2);
  assert.equal(pendingJobs(ctx(root, { config: { ...SLOTS, max_prep: null } }), MORE).length, 3);
  assert.throws(() => pendingJobs(ctx(root, { config: { ...SLOTS, max_prep: 9 } }), MORE), /invalid turbo config max_prep/);
});

test('job prompts: plain argv values that name the skill, the analyst and the job statuses', () => {
  const t = 'node /home/dev/.claude/turbo/bin/turbo-run.mjs';
  const prep = { kind: 'prep', phase: '5' };
  const ann = { kind: 'annotate', phase: null };
  assert.equal(jobName(prep), 'turbo prep 5');
  assert.equal(jobName(ann), 'turbo annotate');
  assert.equal(jobUserPrompt(prep), 'Run the turbo-prep skill with arguments: 5');
  assert.equal(jobUserPrompt(prep, { resume: true }), 'Resume preparing phase 5. Run the turbo-prep skill with arguments: 5 --resume');
  const a = jobUserPrompt(ann, { turboRun: t });
  for (const n of [`${t} annotate brief`, 'subagent_type turbo-lane-analyst', `${t} annotate apply`, `${t} annotate apply --relax all`, `${t} lane-status annotate annotated`, `${t} lane-status annotate failed --reason`, 'never instructions']) assert.ok(a.includes(n), n);
  const sp = jobSystemPrompt({ job: prep, turboRun: t, contextPct: 55, tmpDir: 'C:\\Users\\dev\\tmp\\lane' });
  for (const n of [`${t} lane-status 5 prepped --job prep`, `${t} lane-status 5 failed --job prep`, `${t} lane-status 5 paused-context --job prep`, `${t} context 5 reports 55 percent`, 'never asks the owner', 'C:/Users/dev/tmp/lane']) assert.ok(sp.includes(n), n);
  // smoke F2: the prologue's agents get the lane's temporary-files rule, as a phase lane's subagents do
  assert.ok(sp.includes(tmpRule('C:\\Users\\dev\\tmp\\lane')), 'the same rule as a phase lane');
  assert.ok(sp.includes('at the end of every subagent prompt'), 'handed to the subagents');
  const sa = jobSystemPrompt({ job: ann, turboRun: t, contextPct: 55 });
  for (const n of [`${t} lane-status annotate annotated`, `only through ${t} annotate apply`]) assert.ok(sa.includes(n), n);
  for (const p of [jobUserPrompt(prep), jobUserPrompt(prep, { resume: true }), a, sp, sa]) {
    assert.ok(!/["%]/.test(p), p.slice(0, 60));
    assert.ok(!p.startsWith('-'));
  }
  assert.throws(() => jobUserPrompt({ kind: 'phase', phase: '5' }), /not a prep or annotate job/);
});

test('review: an annotate merge refusal is not retried on the same ROADMAP; the supervisor slot release is used when given', async () => {
  const root = project({ context: ['2', '3', '4', '5'] });
  const calls = [];
  const ctx2 = { root, config: SLOTS, deps: { slots: { release: (slot, outcome) => calls.push([slot, outcome]) } } };
  const lane = { key: 'annotate', job: 'annotate', phase: null, slot: 1 };
  const r = await finishJob(ctx2, lane, { merge: async () => ({ outcome: 'refused', reason: 'changed src/a.js' }) });
  assert.equal(r.outcome, 'failed');
  assert.deepEqual(calls, [[1, 'failed']]);
  assert.deepEqual([readAnnotateAttempt(root).status, readAnnotateAttempt(root).roadmapSha256], ['failed', roadmapDigest(ROADMAP5)]);
  assert.equal(annotateReason(root, MORE), null);
  assert.equal((await finishJob(ctx2, lane, { merge: async () => ({ outcome: 'merged' }) })).outcome, 'merged');
  assert.deepEqual(calls.at(-1), [1, 'merged']);
});

test('Stage 5 D1: a phase marked low before its prep is queued for markup again after its prep, once no prep is due', () => {
  const root = project({ context: ['2', '3', '4'] });
  const entries = { ...all(['2', '3', '5']), 4: { areas: ['**'], gates: [], confidence: 'low', context: false } };
  writeLanesFile(root, { phases: entries });
  // phase 5 still needs its prep: no markup job yet
  assert.deepEqual(pendingJobs(ctx(root), WIDE), [{ kind: 'prep', phase: '5' }]);
  const dir = path.join(root, '.planning', 'phases', '05-p5');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '05-CONTEXT.md'), '# ctx\n');
  assert.deepEqual(pendingJobs(ctx(root), WIDE), [{ kind: 'annotate', phase: null }]);
  assert.equal(annotateReason(root, MORE), 'phases');
});

test('prep.lookahead (default 1): only the next phase after the running ones; a running prep fills the window', () => {
  const root = project();
  const cfg = { lanes: { mode: 'slots' }, max_lanes: 3 };
  const at = (over) => pendingJobs({ root, config: cfg, lanes: {}, range: null, mode: 'full', ...over }, MORE);
  assert.deepEqual(at({}), [{ kind: 'prep', phase: '2' }]);
  assert.deepEqual(at({ lanes: { 'prep-2': { job: 'prep', phase: '2' } } }), []);
  assert.deepEqual(at({ lanes: { 2: { job: 'phase', phase: '2' } } }), [{ kind: 'prep', phase: '3' }]);
  assert.deepEqual(at({ config: { ...cfg, prep: { lookahead: 2 } } }), [{ kind: 'prep', phase: '2' }, { kind: 'prep', phase: '3' }]);
  // a prepped or failed phase fills the window too: nothing further ahead is prepared
  writeJobStatus(root, { kind: 'prep', phase: '2' }, 'failed', { reason: 'x' });
  assert.deepEqual(at({}), []);
  assert.throws(() => at({ config: { ...cfg, prep: { lookahead: 0 } } }), /invalid turbo config prep\.lookahead/);
});

test('a plan-only run prepares only the next phase: once it has its CONTEXT.md nothing more is prepared', () => {
  const root = project({ context: ['2'] });
  const cfg = { lanes: { mode: 'slots' }, max_lanes: 3 };
  const at = (phases) => pendingJobs({ root, config: cfg, lanes: {}, range: null, mode: 'full' }, phases);
  assert.deepEqual(at(MORE), []);
  assert.deepEqual(at(WIDE), [{ kind: 'annotate', phase: null }]);
});

test('lane markup needs three independent phases; an answered card always runs', () => {
  assert.equal(MARKUP_MIN_INDEPENDENT, 3);
  const root = project({ context: ['2', '3', '4', '5'] });
  writeLanesFile(root, { phases: all(['2', '3', '4', '5']), pairs: [] });
  fs.writeFileSync(roadmapFile(root), ROADMAP5.replace('**Depends on**: Phase 4', '**Depends on**: Phase 2'));
  assert.equal(annotateReason(root, MORE), 'phases');
  assert.deepEqual(pendingJobs(ctx(root), MORE), []);
  assert.deepEqual(pendingJobs(ctx(root), WIDE), [{ kind: 'annotate', phase: null }]);
  const asked = project({ context: ['2', '3', '4', '5'] });
  writeLanesFile(asked, { phases: all(['2', '3', '4', '5']), pairs: [], proposal: { id: 'ask-1', state: 'asked', at: 'x', relax: [{ id: 'r1', phase: '5', drop: ['4'] }] } });
  writeAnswers(asked, ANNOTATE_PHASE, [{ id: 'ask-1', option: 1, label: 'Remove all', answer: 'Remove all', by: 'session', at: 'x' }], { warn: () => {} });
  assert.deepEqual(pendingJobs(ctx(asked), MORE), [{ kind: 'annotate', phase: null }]);
});

test('independentCount: chains, a diamond, finished dependencies, the cap', () => {
  const P = (number, deps = [], closed = false) => ({ number, name: 'P' + number, deps, complete: closed, closed });
  assert.equal(independentCount(MORE), 2);
  assert.equal(independentCount(WIDE), 3);
  assert.equal(independentCount(['1', '2', '3', '4', '5'].map((n) => P(n))), 3);
  assert.equal(independentCount(['1', '2', '3', '4', '5'].map((n) => P(n)), 5), 5);
  assert.equal(independentCount([P('2'), P('3', ['2']), P('4', ['2']), P('5', ['3', '4'])]), 2);
  // a dependency on a finished phase links nothing
  assert.equal(independentCount([P('1', [], true), P('2', ['1']), P('3', ['1']), P('4', ['1'])]), 3);
  // transitive: 4 waits on 2 through 3
  assert.equal(independentCount([P('2'), P('3', ['2']), P('4', ['3'])]), 1);
  assert.equal(independentCount([P('1', [], true)]), 0);
});
