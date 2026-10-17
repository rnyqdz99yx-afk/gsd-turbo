import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { writePhase } from './helpers/plans.mjs';
import { FOUR_WAVES, draftText, outline, planText } from './helpers/drafts.mjs';
import { DRAFTING_STALE_MS, checkDraft, dependIds, draftFile, draftParagraph, draftsDir, draftsPlan, markDrafted, readDrafts, startDraft, writeDrafts } from '../lib/plan-drafts.mjs';

const NOW = new Date('2026-10-14T10:00:00.000Z');
const project = () => {
  const root = tmpDir('drafts');
  fs.mkdirSync(path.join(root, '.planning'));
  return root;
};
const phase = (root, files = {}) => writePhase(root, '33-demo', { '33-PLAN-OUTLINE.md': FOUR_WAVES, ...files });
const cfg = (d = {}) => ({ plan_drafts: { enabled: true, min_waves: 3, max_parallel: 8, ...d } });
const plan = (root, opts = {}) => draftsPlan(root, '33', { config: cfg(opts), now: NOW });

test('B4: every drafts off reason in its order; enabled false writes no record, the others a lastPlan with use false', () => {
  const root = project();
  assert.deepEqual(draftsPlan(root, '33', { config: cfg({ enabled: false }), now: NOW }), { use: false, why: 'plan_drafts.enabled is false', removed: [], commitFirst: [] });
  assert.equal(fs.existsSync(draftsDir(root, '33')), false, 'no record with drafts disabled');
  const off = (why) => {
    const r = plan(root);
    assert.equal(r.use, false);
    assert.match(r.why, why);
    const rec = readDrafts(root, '33');
    assert.equal(rec.lastPlan.use, false);
    assert.equal(rec.lastPlan.why, r.why);
    assert.equal(rec.lastPlan.at, NOW.toISOString());
  };
  off(/^no phase directory$/);
  const dir = writePhase(root, '33-demo', { '33-CONTEXT.md': '# c\n' });
  off(/^no chunked plan outline$/);
  const put = (text) => fs.writeFileSync(path.join(dir, '33-PLAN-OUTLINE.md'), text);
  put(outline([['33-01', 1]], { open: true }));
  off(/unfinished \(no ## OUTLINE COMPLETE line\)/);
  put('| Plan ID | Objective | Depends On |\n|---|---|---|\n| 33-01 | a | none |\n\n## OUTLINE COMPLETE\n');
  off(/no Wave column/);
  put('| Plan ID | Objective | Wave |\n|---|---|---|\n| 33-01 | a | 1 |\n\n## OUTLINE COMPLETE\n');
  off(/no Depends On column/);
  put(outline([['33-01', 1], ['—', 2, '33-01']]));
  off(/a row of the outline names no plan id/);
  put(outline([['33-01', 1], ['33-02', '2a', '33-01']]));
  off(/plan 33-02: its wave is not a whole number/);
  put(outline([['33-01', 1], ['33-02', 2, '33-01'], ['33-03', 3, 'TBD']]));
  off(/plan 33-03: its Depends On names no plan id/);
  put(outline([['33-01', 1], ['33-02', 2, '33-09']]));
  off(/plan 33-02 depends on 33-09, which the outline does not list/);
  put(outline([['33-01', 2], ['33-02', 2, '33-01']]));
  off(/plan 33-02 \(wave 2\) depends on 33-01 of wave 2/);
  put(outline([['33-01', 1], ['33-02', 2, '33-01'], ['33-03', 3, '33-02']]));
  fs.writeFileSync(path.join(dir, '33-01-PLAN.md'), planText('33-01', 1));
  off(/^2 waves hold plans not written yet, fewer than plan_drafts\.min_waves \(3\)$/);
  // GSD's plan checker off: drafts have nothing to check them
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ workflow: { plan_check: false } }));
  off(/^plan checker disabled/);
});

test('B4: a fresh 4-wave outline drafts waves 2-4 up to max_parallel; in-flight drafts count; GSD plans the wave it is at', () => {
  const root = project();
  const dir = phase(root);
  assert.deepEqual(plan(root), { use: true, waves: [['33-01'], ['33-02', '33-03'], ['33-04'], ['33-05']], draftNow: ['33-02', '33-03', '33-04', '33-05'], rest: [], removed: [], commitFirst: [] });
  assert.deepEqual(readDrafts(root, '33').lastPlan, { use: true, at: NOW.toISOString() });
  const two = plan(root, { max_parallel: 2 });
  assert.deepEqual([two.draftNow, two.rest], [['33-02', '33-03'], ['33-04', '33-05']]);
  // a draft at work takes a place
  assert.ok(startDraft(root, '33', '33-02', { config: cfg(), now: NOW }).paragraph);
  const busy = plan(root, { max_parallel: 2 });
  assert.deepEqual([busy.draftNow, busy.rest], [['33-03'], ['33-04', '33-05']]);
  // a drafting record its agent left long ago is drafted again
  const later = draftsPlan(root, '33', { config: cfg({ max_parallel: 2 }), now: new Date(NOW.getTime() + DRAFTING_STALE_MS + 60000) });
  assert.deepEqual(later.draftNow, ['33-02', '33-03']);
  // wave 1 written: GSD plans wave 2 now, drafts are for the waves after it
  fs.writeFileSync(path.join(dir, '33-01-PLAN.md'), planText('33-01', 1));
  const resumed = plan(root);
  assert.deepEqual(resumed.draftNow, ['33-04', '33-05']);
  // once drafts exist, min_waves no longer turns them off
  fs.writeFileSync(path.join(dir, '33-02-PLAN.md'), planText('33-02', 2, ['33-01']));
  fs.writeFileSync(path.join(dir, '33-03-PLAN.md'), planText('33-03', 2, ['33-01']));
  assert.equal(plan(root).use, true);
});

test('B4: a changed outline resets the record', () => {
  const root = project();
  const dir = phase(root);
  plan(root);
  startDraft(root, '33', '33-04', { config: cfg(), now: NOW });
  assert.equal(readDrafts(root, '33').plans['33-04'].state, 'drafting');
  fs.writeFileSync(path.join(dir, '33-PLAN-OUTLINE.md'), FOUR_WAVES.replace('objective of 33-04', 'another objective'));
  assert.equal(plan(root).use, true);
  const rec = readDrafts(root, '33');
  assert.deepEqual(rec.plans, {});
  assert.equal(rec.outline.file, '33-PLAN-OUTLINE.md');
  assert.deepEqual([rec.outline.plans, rec.outline.waves], [5, 4]);
});

test('B6: the draft paragraph names the draft path, keeps the row\'s wave and depends_on, lists the earlier waves\' rows only, and has no control characters', () => {
  const root = project();
  phase(root, { '33-PLAN-OUTLINE.md': FOUR_WAVES.replace('objective of 33-02', 'objective\u0007 of 33-02') });
  plan(root);
  const r = startDraft(root, '33', '33-04', { config: cfg(), now: NOW });
  const p = r.paragraph;
  assert.ok(p.startsWith('**Draft (gsd-turbo).** The plans before this one are not written yet.'));
  assert.ok(p.includes(`Write exactly one file, ${draftFile(root, '33', '33-04')}, instead of .planning/phases/33-demo/33-04-PLAN.md`));
  assert.ok(path.isAbsolute(draftFile(root, '33', '33-04')));
  assert.ok(p.includes('Skip your update_roadmap and git_commit steps; do not edit ROADMAP.md or STATE.md; do not commit.'));
  assert.ok(p.includes('wave: 3 and depends_on: [33-02]'));
  assert.ok(p.includes('## Draft assumptions'));
  const rows = p.split('\n').filter((l) => /^\| 33-/.test(l)).map((l) => l.split('|')[1].trim());
  assert.deepEqual(rows, ['33-01', '33-02', '33-03']);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(p));
  assert.equal(draftParagraph(root, '33', '33-04'), p);
  const e = readDrafts(root, '33').plans['33-04'];
  assert.deepEqual([e.state, e.wave, e.dependsOn, e.draft, e.at.drafting], ['drafting', 3, ['33-02'], '33-04-PLAN.md', NOW.toISOString()]);
});

test('--drafting refuses: drafts off, the wave GSD plans now, a written plan, a drafted or replanned one', () => {
  const root = project();
  const dir = phase(root);
  const start = (id, opts) => startDraft(root, '33', id, { config: cfg(opts), now: NOW });
  assert.match(start('33-02', { enabled: false }).refused, /^drafts off: plan_drafts\.enabled is false/);
  assert.match(start('33-01').refused, /33-01 is in wave 1, the wave GSD plans now/);
  assert.ok(start('33-02').paragraph);
  assert.ok(start('33-02').paragraph, 'a drafting record is sent again');
  fs.writeFileSync(draftFile(root, '33', '33-02'), draftText('33-02', 2, ['33-01']));
  assert.deepEqual(markDrafted(root, '33', '33-02', { now: NOW }), { ok: true });
  assert.match(start('33-02').refused, /33-02 is drafted already/);
  const rec = readDrafts(root, '33');
  rec.plans['33-02'].state = 'replanned';
  writeDrafts(root, '33', rec);
  assert.match(start('33-02').refused, /33-02 is replanned/);
  fs.writeFileSync(path.join(dir, '33-03-PLAN.md'), planText('33-03', 2, ['33-01']));
  assert.match(start('33-03').refused, /33-03 is written already/);
});

test('B7: --drafted checks the draft: file, frontmatter, wave, depends_on, the assumptions section, nothing in the phase directory', () => {
  const root = project();
  const dir = phase(root);
  plan(root);
  assert.match(markDrafted(root, '33', '33-04', { now: NOW }).refused, /33-04 is not drafted, not drafting/);
  startDraft(root, '33', '33-04', { config: cfg(), now: NOW });
  const put = (text) => fs.writeFileSync(draftFile(root, '33', '33-04'), text);
  const refused = () => checkDraft(root, '33', '33-04');
  assert.match(refused(), /^no draft file /);
  put('# no frontmatter\n\n## Draft assumptions\n- x\n');
  assert.match(refused(), /does not match its outline row: it has no frontmatter/);
  put(draftText('33-04', 2, ['33-02']));
  assert.match(refused(), /its wave is 2, its outline row says 3/);
  put(draftText('33-04', 3, ['33-01']));
  assert.match(refused(), /its depends_on is \[33-01\], its outline row says \[33-02\]/);
  put(planText('33-04', 3, ['33-02']));
  assert.equal(refused(), 'the draft has no ## Draft assumptions section');
  put(draftText('33-04', 3, ['"33-02"']));
  assert.equal(refused(), null, 'a quoted id is the id');
  // the agent wrote into the phase directory as well: turbo removes that file and refuses
  fs.writeFileSync(path.join(dir, '33-04-PLAN.md'), draftText('33-04', 3, ['33-02']));
  assert.match(refused(), /the draft agent wrote into the phase directory: \.planning\/phases\/33-demo\/33-04-PLAN\.md/);
  const r = markDrafted(root, '33', '33-04', { now: NOW });
  assert.match(r.refused, /removed \.planning\/phases\/33-demo\/33-04-PLAN\.md/);
  assert.equal(fs.existsSync(path.join(dir, '33-04-PLAN.md')), false);
  assert.deepEqual(markDrafted(root, '33', '33-04', { now: NOW }), { ok: true });
  const e = readDrafts(root, '33').plans['33-04'];
  assert.equal(e.state, 'drafted');
  assert.match(e.blobs.drafted, /^[0-9a-f]{40}$/);
  assert.deepEqual(markDrafted(root, '33', '33-04', { now: NOW }), { ok: true }, 'the same draft again: still drafted');
});

test('review 13: depends_on entries read as the outline\'s ids: quoted, long form, bare numbers', () => {
  assert.deepEqual(dependIds(['"33-01"', "'33-02'", '33-03-auth-hardening', '04', '5', 'other'], '33'), ['33-01', '33-02', '33-03', '33-04', '33-05', 'other']);
});
