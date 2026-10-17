import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { draftText, outline, planText } from './helpers/drafts.mjs';
import { DRAFTING_STALE_MS, draftFile, draftsGuard, draftsPlan, finishReconcile, markDrafted, predecessors, promote, readDrafts, replan, startDraft, startReconcile, stripAssumptions, writeDrafts } from '../lib/plan-drafts.mjs';
import { STEPS, completeStep } from '../lib/phase-progress.mjs';
import { planSetCheck, runPhaseCommand } from '../lib/cli-phase.mjs';

const NOW = new Date('2026-10-14T10:00:00.000Z');
const CFG = { plan_drafts: { enabled: true, min_waves: 3, max_parallel: 8 } };

// 3 waves: 33-01, 33-02, 33-05 in wave 1 (33-02 shares src/b.ts with 33-03's draft, 33-05 shares nothing), 33-03 in
// wave 2 on 33-01, 33-04 in wave 3 on 33-03.
const ROWS = [['33-01', 1], ['33-02', 1], ['33-05', 1], ['33-03', 2, '33-01'], ['33-04', 3, '33-03']];
const FILES = { '33-01': ['src/a.ts'], '33-02': ['src/b.ts'], '33-05': ['src/z.ts'] };

function project(rows = ROWS) {
  const root = tmpGitRepo();
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', '.gitignore'), 'run/\nlogs/\nlocks/\n');
  fs.writeFileSync(path.join(root, '.planning', 'ROADMAP.md'), '# Roadmap\n\n### Phase 33: demo\n');
  const dir = path.join(root, '.planning', 'phases', '33-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '33-CONTEXT.md'), '# context\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'project');
  // GSD never commits the outline
  fs.writeFileSync(path.join(dir, '33-PLAN-OUTLINE.md'), outline(rows));
  const planFile = (id) => path.join(dir, `${id}-PLAN.md`);
  const commitPlan = (id, text) => {
    fs.writeFileSync(planFile(id), text);
    git('add', '--', planFile(id));
    git('commit', '-q', '-m', `docs(33): plan ${id} (chunked)`);
  };
  const writeDraft = (id, text) => fs.writeFileSync(draftFile(root, '33', id), text);
  return { root, dir, git, planFile, commitPlan, writeDraft };
}

// The drafts flow up to a drafted 33-03 (and 33-04), wave 1 committed.
function drafted(p = project()) {
  assert.equal(draftsPlan(p.root, '33', { config: CFG, now: NOW }).use, true);
  for (const id of ['33-03', '33-04']) assert.ok(startDraft(p.root, '33', id, { config: CFG, now: NOW }).paragraph);
  p.writeDraft('33-03', draftText('33-03', 2, ['33-01'], ['src/c.ts', 'src/b.ts']));
  p.writeDraft('33-04', draftText('33-04', 3, ['33-03'], ['src/d.ts']));
  // GSD plans and the lane commits wave 1 meanwhile: the lane's own commits
  for (const id of ['33-01', '33-02', '33-05']) p.commitPlan(id, planText(id, 1, [], FILES[id]));
  for (const id of ['33-03', '33-04']) assert.deepEqual(markDrafted(p.root, '33', id, { now: NOW }), { ok: true });
  return p;
}

test('the whole cycle: reconcile against the committed plans before it, promote without the assumptions, guard passes', () => {
  const p = drafted();
  const r = startReconcile(p.root, '33', '33-03', { now: NOW });
  const lines = r.block.split('\n');
  assert.equal(lines[0], 'reconcile 33-03: 2 plans before it');
  assert.deepEqual(lines.filter((l) => l.startsWith('before: ')), [`before: ${p.planFile('33-01')}`, `before: ${p.planFile('33-02')}`]);
  assert.ok(lines.includes(`draft: ${draftFile(p.root, '33', '33-03')}`));
  assert.ok(lines.includes(`outline: ${path.join(p.dir, '33-PLAN-OUTLINE.md')}`));
  assert.ok(lines.includes('row: | 33-03 | objective of 33-03 | 2 | 33-01 | R-03 |'));
  assert.ok(lines.includes(`context: ${path.join(p.dir, '33-CONTEXT.md')}`));
  assert.deepEqual(lines.slice(lines.indexOf('assumptions:') + 1), ['- 33-01: creates src/33-01.ts with export make01()']);
  assert.equal(readDrafts(p.root, '33').plans['33-03'].state, 'reconciling');
  assert.deepEqual(finishReconcile(p.root, '33', '33-03', 'passed', { now: NOW }), { ok: 'reconciled' });
  assert.deepEqual(promote(p.root, '33', '33-03', { now: NOW }), { promoted: '.planning/phases/33-demo/33-03-PLAN.md' });
  const text = fs.readFileSync(p.planFile('33-03'), 'utf8');
  assert.ok(text.startsWith('---') && !text.includes('Draft assumptions') && text.includes('<tasks>'));
  assert.deepEqual(fs.readdirSync(path.dirname(p.dir)), ['33-demo'], 'no temp file left beside the phase directory');
  const e = readDrafts(p.root, '33').plans['33-03'];
  assert.equal(e.state, 'promoted');
  assert.match(e.blobs.promoted, /^[0-9a-f]{40}$/);
  // promoted and not committed yet: the guard reads its working blob; --plan names it to commit first
  assert.equal(draftsGuard(p.root, '33'), null);
  assert.deepEqual(draftsPlan(p.root, '33', { config: CFG, now: NOW }).commitFirst, ['33-03']);
  p.commitPlan('33-03', text);
  assert.deepEqual(draftsPlan(p.root, '33', { config: CFG, now: NOW }).commitFirst, []);
  // 33-04 after it, then the whole set
  assert.ok(startReconcile(p.root, '33', '33-04', { now: NOW }).block.startsWith('reconcile 33-04: 1 plan before it'));
  finishReconcile(p.root, '33', '33-04', 'passed', { now: NOW });
  promote(p.root, '33', '33-04', { now: NOW });
  p.commitPlan('33-04', fs.readFileSync(p.planFile('33-04'), 'utf8'));
  assert.equal(draftsGuard(p.root, '33'), null);
  assert.match(planSetCheck(p.root, '33').ok, /lists 5 plans, all written/);
  // the plan checker revises a promoted plan in a later commit: the plan still came from its promote
  p.commitPlan('33-03', `${text}\n<!-- revised by the checker -->\n`);
  assert.equal(draftsGuard(p.root, '33'), null);
});

test('reconcile is refused while a plan before it is not committed; predecessor drift refuses --reconciled and --promote', () => {
  const p = project();
  draftsPlan(p.root, '33', { config: CFG, now: NOW });
  startDraft(p.root, '33', '33-03', { config: CFG, now: NOW });
  p.writeDraft('33-03', draftText('33-03', 2, ['33-01'], ['src/c.ts']));
  assert.deepEqual(markDrafted(p.root, '33', '33-03', { now: NOW }), { ok: true });
  fs.writeFileSync(p.planFile('33-01'), planText('33-01', 1, [], FILES['33-01']));
  for (const id of ['33-02', '33-05']) p.commitPlan(id, planText(id, 1, [], FILES[id]));
  assert.match(startReconcile(p.root, '33', '33-03', { now: NOW }).refused, /33-01 is not committed yet: reconcile 33-03 after its commit/);
  p.commitPlan('33-01', planText('33-01', 1, [], FILES['33-01']));
  assert.ok(startReconcile(p.root, '33', '33-03', { now: NOW }).block);
  // 33-01 committed again in between: reconcile again
  p.commitPlan('33-01', planText('33-01', 1, [], ['src/a.ts', 'src/a2.ts']));
  assert.match(finishReconcile(p.root, '33', '33-03', 'passed', { now: NOW }).refused, /33-01 changed since the reconcile started/);
  assert.ok(startReconcile(p.root, '33', '33-03', { now: NOW }).block, 'a reconcile runs again from reconciling');
  assert.deepEqual(finishReconcile(p.root, '33', '33-03', 'passed', { now: NOW }), { ok: 'reconciled' });
  p.commitPlan('33-01', planText('33-01', 1, [], ['src/a.ts']));
  assert.match(promote(p.root, '33', '33-03', { now: NOW }).refused, /33-01 changed since the reconcile started/);
  assert.equal(fs.existsSync(p.planFile('33-03')), false);
});

test('promote refuses: a draft edited after its reconcile, a wave or depends_on off its row, a same-wave files_modified overlap, an existing plan file', () => {
  const rows = [['33-01', 1], ['33-02', 1], ['33-03', 2, '33-01'], ['33-06', 2, '33-01'], ['33-04', 3, '33-03']];
  const p = project(rows);
  draftsPlan(p.root, '33', { config: CFG, now: NOW });
  startDraft(p.root, '33', '33-03', { config: CFG, now: NOW });
  p.writeDraft('33-03', draftText('33-03', 2, ['33-01'], ['src/c.ts']));
  markDrafted(p.root, '33', '33-03', { now: NOW });
  for (const id of ['33-01', '33-02']) p.commitPlan(id, planText(id, 1, [], [`src/${id}.ts`]));
  const reconciled = (text) => {
    startReconcile(p.root, '33', '33-03', { now: NOW });
    if (text) p.writeDraft('33-03', text);
    assert.deepEqual(finishReconcile(p.root, '33', '33-03', 'passed', { now: NOW }), { ok: 'reconciled' });
  };
  reconciled();
  p.writeDraft('33-03', `${draftText('33-03', 2, ['33-01'], ['src/c.ts'])}\nmore\n`);
  assert.match(promote(p.root, '33', '33-03', { now: NOW }).refused, /^the draft changed after its reconcile$/);
  p.writeDraft('33-03', draftText('33-03', 2, ['33-01'], ['src/c.ts']));
  // the reconcile agent moved the wave
  reconciled(draftText('33-03', 3, ['33-01'], ['src/c.ts']));
  assert.match(promote(p.root, '33', '33-03', { now: NOW }).refused, /its wave is 3, its outline row says 2/);
  reconciled(draftText('33-03', 2, ['33-02'], ['src/c.ts']));
  assert.match(promote(p.root, '33', '33-03', { now: NOW }).refused, /its depends_on is \[33-02\], its outline row says \[33-01\]/);
  // GSD wrote 33-06 of the same wave, changing src/c.ts too (G7)
  reconciled(draftText('33-03', 2, ['33-01'], ['src/c.ts']));
  p.commitPlan('33-06', planText('33-06', 2, ['33-01'], ['./src/c.ts']));
  assert.match(promote(p.root, '33', '33-03', { now: NOW }).refused, /its files_modified overlaps 33-06 of the same wave: src\/c\.ts/);
  // a plan file there already is never overwritten
  p.commitPlan('33-06', planText('33-06', 2, ['33-01'], ['src/e.ts']));
  fs.writeFileSync(p.planFile('33-03'), 'not frontmatter\n');
  assert.match(promote(p.root, '33', '33-03', { now: NOW }).refused, /33-03-PLAN\.md exists already/);
  fs.rmSync(p.planFile('33-03'));
  assert.ok(promote(p.root, '33', '33-03', { now: NOW }).promoted);
});

test('a failed reconcile and --replan hand the plan to GSD; every use: gsd answer records replanned', () => {
  const p = drafted();
  startReconcile(p.root, '33', '33-03', { now: NOW });
  assert.deepEqual(finishReconcile(p.root, '33', '33-03', 'failed', { reason: 'RECONCILE FAILED: 33-01 took another approach', now: NOW }), { ok: 'replanned', removed: [] });
  assert.deepEqual(startReconcile(p.root, '33', '33-03', { now: NOW }), { gsd: 'replanned: RECONCILE FAILED: 33-01 took another approach' });
  assert.deepEqual(replan(p.root, '33', '33-04', { reason: 'no marker', now: NOW }), { removed: [] });
  assert.deepEqual(startReconcile(p.root, '33', '33-04', { now: NOW }), { gsd: 'replanned: no marker' });
  assert.ok(fs.existsSync(draftFile(p.root, '33', '33-04')), 'the draft file is kept');
  // a draft changed after its check, and one whose agent never returned: GSD's, and the record says so
  const q = project([['33-01', 1], ['33-03', 2, '33-01'], ['33-04', 3, '33-03']]);
  draftsPlan(q.root, '33', { config: CFG, now: NOW });
  startDraft(q.root, '33', '33-03', { config: CFG, now: NOW });
  startDraft(q.root, '33', '33-04', { config: CFG, now: NOW });
  q.writeDraft('33-03', draftText('33-03', 2, ['33-01']));
  markDrafted(q.root, '33', '33-03', { now: NOW });
  q.writeDraft('33-03', `${draftText('33-03', 2, ['33-01'])}x\n`);
  q.commitPlan('33-01', planText('33-01', 1));
  assert.deepEqual(startReconcile(q.root, '33', '33-03', { now: NOW }), { gsd: 'the draft changed after its check' });
  assert.deepEqual(startReconcile(q.root, '33', '33-04', { now: NOW }), { gsd: 'the draft agent never returned' });
  assert.deepEqual(startReconcile(q.root, '33', '33-09', { now: NOW }), { gsd: 'no draft' });
  const rec = readDrafts(q.root, '33');
  assert.deepEqual([rec.plans['33-03'].state, rec.plans['33-04'].state], ['replanned', 'replanned']);
});

test('B5 (review 9): predecessors are the dependencies, the plans the assumptions name and the earlier plans sharing a file', () => {
  const p = drafted();
  assert.deepEqual(predecessors(p.root, '33', '33-03').map((x) => x.id), ['33-01', '33-02']);
  // no shared file: 33-02 is no predecessor; named in the assumptions: 33-05 is
  p.writeDraft('33-03', draftText('33-03', 2, ['33-01'], ['src/c.ts']));
  assert.deepEqual(predecessors(p.root, '33', '33-03').map((x) => x.id), ['33-01']);
  p.writeDraft('33-03', draftText('33-03', 2, ['33-01'], ['src/c.ts']).replace('## Draft assumptions\n', '## Draft assumptions\n\n- 33-05: the z module exists\n'));
  assert.deepEqual(predecessors(p.root, '33', '33-03').map((x) => x.id), ['33-01', '33-05']);
  // a path the draft cites in its text meets 33-02's files_modified
  p.writeDraft('33-03', draftText('33-03', 2, ['33-01'], ['src/c.ts']).replace('<tasks>', 'Reads src/b.ts.\n<tasks>'));
  assert.deepEqual(predecessors(p.root, '33', '33-03').map((x) => x.id), ['33-01', '33-02']);
});

test('critical 1: a draft the agent wrote and committed into the phase directory is removed with a commit; --plan removes leftovers on resume', () => {
  const p = project();
  draftsPlan(p.root, '33', { config: CFG, now: NOW });
  startDraft(p.root, '33', '33-04', { config: CFG, now: NOW });
  p.writeDraft('33-04', draftText('33-04', 3, ['33-03']));
  p.commitPlan('33-04', draftText('33-04', 3, ['33-03']));
  const r = markDrafted(p.root, '33', '33-04', { now: NOW });
  assert.match(r.refused, /the draft agent wrote into the phase directory: removed \.planning\/phases\/33-demo\/33-04-PLAN\.md/);
  assert.equal(fs.existsSync(p.planFile('33-04')), false);
  assert.match(p.git('log', '-1', '--format=%s'), /^docs\(33\): drop plan 33-04: a draft agent wrote it into the phase directory/);
  assert.equal(p.git('status', '--porcelain', '--', p.planFile('33-04')).trim(), '');
  // a stopped session left one, untracked: the next --plan removes it before GSD's resume would take it for a plan
  fs.writeFileSync(p.planFile('33-04'), draftText('33-04', 3, ['33-03']));
  assert.deepEqual(draftsPlan(p.root, '33', { config: CFG, now: NOW }).removed, ['.planning/phases/33-demo/33-04-PLAN.md']);
  assert.equal(fs.existsSync(p.planFile('33-04')), false);
});

test('review C1: GSD\'s own planners updating ROADMAP.md and committing create phase plan refuse no draft; a plan file an agent wrote under another name is removed and refused', () => {
  const p = project();
  draftsPlan(p.root, '33', { config: CFG, now: NOW });
  for (const id of ['33-03', '33-04']) startDraft(p.root, '33', id, { config: CFG, now: NOW });
  p.writeDraft('33-03', draftText('33-03', 2, ['33-01'], ['src/c.ts']));
  p.writeDraft('33-04', draftText('33-04', 3, ['33-03']));
  // wave 1 as GSD 1.16 runs it: the planner's own update_roadmap and git_commit, then the orchestrator's commit
  fs.writeFileSync(p.planFile('33-01'), planText('33-01', 1, [], FILES['33-01']));
  fs.appendFileSync(path.join(p.root, '.planning', 'ROADMAP.md'), '- [ ] 33-01-PLAN.md\n');
  p.git('add', '-A');
  p.git('commit', '-q', '-m', 'docs(33): create phase plan');
  fs.appendFileSync(path.join(p.root, '.planning', 'STATE.md'), 'x\n');
  assert.deepEqual(markDrafted(p.root, '33', '33-03', { now: NOW }), { ok: true });
  // the 33-04 agent also wrote a misnamed plan into the phase directory, and committed it
  p.commitPlan('33-04-auth', draftText('33-04', 3, ['33-03']));
  const r = markDrafted(p.root, '33', '33-04', { now: NOW });
  assert.match(r.refused, /the draft agent wrote into the phase directory: removed \.planning\/phases\/33-demo\/33-04-auth-PLAN\.md/);
  assert.equal(fs.existsSync(p.planFile('33-04-auth')), false);
  assert.match(p.git('log', '-1', '--format=%s'), /^docs\(33\): drop 33-04-auth-PLAN\.md: a draft agent wrote it/);
  assert.match(readDrafts(p.root, '33').plans['33-04'].blobs.drafted, /^[0-9a-f]{40}$/, 'the refused draft\'s blob is kept for the guard');
  // a reconcile agent that writes a plan file of its own
  for (const id of ['33-02', '33-05']) p.commitPlan(id, planText(id, 1, [], FILES[id]));
  assert.ok(startReconcile(p.root, '33', '33-03', { now: NOW }).block);
  fs.mkdirSync(path.join(p.dir, 'plans'));
  fs.writeFileSync(path.join(p.dir, 'plans', 'PLAN-03.md'), planText('33-03', 2, ['33-01']));
  assert.match(finishReconcile(p.root, '33', '33-03', 'passed', { now: NOW }).refused, /reconcile agent wrote into the phase directory: removed \.planning\/phases\/33-demo\/plans\/PLAN-03\.md/);
});

test('review I2: the guard goes over every plan file: a misnamed copy of a draft is refused', () => {
  const p = drafted();
  const why = () => draftsGuard(p.root, '33');
  assert.equal(why(), null);
  fs.copyFileSync(draftFile(p.root, '33', '33-04'), path.join(p.dir, '33-04-x-PLAN.md'));
  assert.match(why(), /^plan file 33-04-x-PLAN\.md is the draft of 33-04, not a plan: delete it, commit the deletion and plan 33-04 again/);
  p.commitPlan('33-04-x', fs.readFileSync(path.join(p.dir, '33-04-x-PLAN.md'), 'utf8'));
  assert.match(why(), /is the draft of 33-04/, 'committed as well');
});

test('second review C1: a plan GSD\'s revision loop splits off (scope_sanity) passes the guard and survives --replan of another plan', async () => {
  const p = drafted();
  for (const id of ['33-03', '33-04']) {
    startReconcile(p.root, '33', id, { now: NOW });
    finishReconcile(p.root, '33', id, 'passed', { now: NOW });
    promote(p.root, '33', id, { now: NOW });
    p.commitPlan(id, fs.readFileSync(p.planFile(id), 'utf8'));
  }
  // planner-revision Step 3: 33-04 split into 33-04 and a new 33-06, committed by the revision
  fs.writeFileSync(p.planFile('33-06'), planText('33-06', 3, ['33-03'], ['src/f.ts']));
  fs.appendFileSync(p.planFile('33-04'), '\n<!-- split -->\n');
  p.git('add', '-A');
  p.git('commit', '-q', '-m', 'fix(33): revise plans based on checker feedback');
  assert.equal(draftsGuard(p.root, '33'), null);
  assert.ok(planSetCheck(p.root, '33').ok);
  // a --replan of a plan whose agent is no longer at work keeps GSD's split plan
  const q = drafted();
  fs.writeFileSync(q.planFile('33-06'), planText('33-06', 3, ['33-03']));
  q.git('add', '-A');
  q.git('commit', '-q', '-m', 'fix(33): revise plans based on checker feedback');
  assert.deepEqual(replan(q.root, '33', '33-04', { now: NOW }), { removed: [] });
  assert.ok(fs.existsSync(q.planFile('33-06')));
  // a lost drafting agent's misnamed plan, though, goes when its plan is handed to GSD at its wave
  const r = project([['33-01', 1], ['33-03', 2, '33-01'], ['33-04', 3, '33-03']]);
  draftsPlan(r.root, '33', { config: CFG, now: NOW });
  startDraft(r.root, '33', '33-04', { config: CFG, now: NOW });
  fs.writeFileSync(path.join(r.dir, '33-04-lost-PLAN.md'), planText('33-04', 3, ['33-03']));
  r.commitPlan('33-01', planText('33-01', 1));
  r.commitPlan('33-03', planText('33-03', 2, ['33-01']));
  assert.deepEqual(startReconcile(r.root, '33', '33-04', { now: NOW }), { gsd: 'the draft agent never returned' });
  assert.equal(fs.existsSync(path.join(r.dir, '33-04-lost-PLAN.md')), false);
});

test('final review I-1: re-drafting after a lost agent (>90 min) removes the misnamed plan file it left before taking the new base', () => {
  const p = project();
  draftsPlan(p.root, '33', { config: CFG, now: NOW });
  assert.ok(startDraft(p.root, '33', '33-04', { config: CFG, now: NOW }).paragraph);
  // the lost agent's partial draft and a misnamed plan it committed into the phase directory
  p.writeDraft('33-04', '---\nwave: 3\n');
  p.commitPlan('33-04-auth', planText('33-04', 3, ['33-03']));
  const later = new Date(Math.max(Date.now(), NOW.getTime()) + DRAFTING_STALE_MS + 60000);
  assert.ok(startDraft(p.root, '33', '33-04', { config: CFG, now: later }).paragraph);
  assert.equal(fs.existsSync(p.planFile('33-04-auth')), false);
  assert.match(p.git('log', '-1', '--format=%s'), /^docs\(33\): drop 33-04-auth-PLAN\.md: a draft agent wrote it/);
  assert.equal(fs.existsSync(draftFile(p.root, '33', '33-04')), false);
  assert.ok(!readDrafts(p.root, '33').plans['33-04'].base.plans.includes('33-04-auth-PLAN.md'));
});

test('review I-a: a resumed session with drafts now off hands every draft not promoted to GSD; GSD\'s plans then pass the guard', async () => {
  const p = drafted();
  const off = draftsPlan(p.root, '33', { config: { plan_drafts: { enabled: false } }, now: NOW });
  assert.equal(off.why, 'plan_drafts.enabled is false');
  const rec = readDrafts(p.root, '33');
  assert.deepEqual([rec.plans['33-03'].state, rec.plans['33-03'].reason, rec.plans['33-04'].state], ['replanned', 'drafts off: plan_drafts.enabled is false', 'replanned']);
  p.commitPlan('33-03', planText('33-03', 2, ['33-01'], ['src/c.ts']));
  p.commitPlan('33-04', planText('33-04', 3, ['33-03']));
  assert.equal(draftsGuard(p.root, '33'), null);
  // GSD's checker switched off works the same way
  const q = drafted();
  fs.writeFileSync(path.join(q.root, '.planning', 'config.json'), JSON.stringify({ workflow: { plan_check: false } }));
  assert.match(draftsPlan(q.root, '33', { config: CFG, now: NOW }).why, /^plan checker disabled/);
  assert.equal(readDrafts(q.root, '33').plans['33-04'].state, 'replanned');
});

test('review C2: a resumed session whose first wave holds a drafted plan reconciles it (or hands it to GSD) at that wave; GSD\'s plan then passes the guard', async () => {
  const p = drafted();
  // the first session stopped after wave 2 was planned by GSD; 33-04 (wave 3) is drafted
  replan(p.root, '33', '33-03', { now: NOW });
  p.commitPlan('33-03', planText('33-03', 2, ['33-01'], ['src/c.ts']));
  const resumed = draftsPlan(p.root, '33', { config: CFG, now: NOW });
  assert.deepEqual([resumed.use, resumed.draftNow, resumed.removed, resumed.commitFirst], [true, [], [], []]);
  // wave 3 is the first runnable wave of this session: point 3 runs for it too
  assert.ok(startReconcile(p.root, '33', '33-04', { now: NOW }).block.startsWith('reconcile 33-04: 1 plan before it'));
  assert.deepEqual(finishReconcile(p.root, '33', '33-04', 'failed', { reason: 'RECONCILE FAILED', now: NOW }), { ok: 'replanned', removed: [] });
  p.commitPlan('33-04', planText('33-04', 3, ['33-03']));
  assert.equal(draftsGuard(p.root, '33'), null);
  assert.ok(planSetCheck(p.root, '33').ok);
});

test('B11: a plan that came from a draft without a passed reconcile is refused by --check plan and --done plan, committed or not', async () => {
  const p = drafted();
  for (const s of STEPS.slice(0, STEPS.indexOf('plan'))) completeStep(p.root, '33', s);
  const lines = [];
  const run = (...a) => runPhaseCommand('phase-step', ['33', ...a], { root: p.root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  // the reconciled draft copied by hand, never promoted
  startReconcile(p.root, '33', '33-03', { now: NOW });
  finishReconcile(p.root, '33', '33-03', 'passed', { now: NOW });
  fs.copyFileSync(draftFile(p.root, '33', '33-03'), p.planFile('33-03'));
  // 33-04 took GSD's path
  replan(p.root, '33', '33-04', { now: NOW });
  p.commitPlan('33-04', planText('33-04', 3, ['33-03']));
  const why = 'plan 33-03 came from a draft without a passed reconcile: delete it and plan it again (turbo-run plan-drafts 33 --replan 33-03)';
  assert.equal(draftsGuard(p.root, '33'), why, 'uncommitted');
  p.commitPlan('33-03', fs.readFileSync(p.planFile('33-03'), 'utf8'));
  assert.equal(draftsGuard(p.root, '33'), why, 'committed');
  assert.equal(await run('--check', 'plan'), 0);
  assert.equal(lines.at(-1), `phase 33: plan set incomplete: ${why}`);
  assert.equal(await run('--done', 'plan'), 1);
  assert.match(lines.at(-1), new RegExp(`^ERR turbo-run phase-step: phase 33 cannot finish planning: ${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // the plan-check record (web-hygiene2) is refused the same way: there is no whole plan set to check yet
  assert.equal(await run('--plan-checked'), 1);
  assert.match(lines.at(-1), /no plan check to record: plan set incomplete: plan 33-03 came from a draft without a passed reconcile/);
  // a replanned record whose plan file is still the draft: refused whatever the record says
  const rec = readDrafts(p.root, '33');
  rec.plans['33-03'].state = 'replanned';
  writeDrafts(p.root, '33', rec);
  assert.equal(draftsGuard(p.root, '33'), why);
  // the way out: the file deleted and the deletion committed, then GSD's own plan for the replanned record passes
  p.git('rm', '-q', '--', p.planFile('33-03'));
  p.git('commit', '-q', '-m', 'docs(phase-33): drop a plan that skipped its reconcile');
  p.commitPlan('33-03', planText('33-03', 2, ['33-01'], ['src/c.ts']));
  assert.equal(draftsGuard(p.root, '33'), null);
  assert.equal(await run('--plan-checked', '--note', 'passed'), 0, lines.at(-1));
  assert.equal(await run('--done', 'plan'), 0, lines.at(-1));
});

test('stripAssumptions: the section in the middle, at the end, with CRLF; a text without it is unchanged', () => {
  const mid = '---\nwave: 2\n---\n\n## Plan\n\nx\n\n## Draft assumptions\n\n- 33-01: a\n### sub\n- 33-01: b\n\n## Verification\n\ny\n';
  assert.equal(stripAssumptions(mid), '---\nwave: 2\n---\n\n## Plan\n\nx\n\n## Verification\n\ny\n');
  const end = '---\nwave: 2\n---\n\nx\n\n## Draft assumptions\n\n- 33-01: a\n\n';
  assert.equal(stripAssumptions(end), '---\nwave: 2\n---\n\nx\n');
  assert.equal(stripAssumptions(end.replace(/\n/g, '\r\n')), '---\r\nwave: 2\r\n---\r\n\r\nx\r\n');
  const fenced = 'x\n\n## Draft assumptions\n\n```\n# not a heading\n```\n- a\n\n# Next\n';
  assert.equal(stripAssumptions(fenced), 'x\n\n# Next\n');
  assert.equal(stripAssumptions('no section\n'), 'no section\n');
});
