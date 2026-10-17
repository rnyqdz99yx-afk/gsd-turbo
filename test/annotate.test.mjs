import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { PHASES, ROADMAP, gsdDeps, gsdDepends, gsdGoal, gsdSection } from './fixtures/roadmap-lanes.mjs';
import { readQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { parseRoadmapPhases } from '../lib/roadmap-lanes.mjs';
import { lanesFile, readLanesFile, readLanesRaw, roadmapFile } from '../lib/lanes-file.mjs';
import { annotateReason } from '../lib/prep.mjs';
import { AnnotateRefused, analysisFile, annotateBrief, applyAnalysis, applyAnswer, briefFile, filesModified, validateAnalysis } from '../lib/annotate.mjs';

// Phase 4 waits on phase 3 here too, so that a relaxation has something to drop.
const ROADMAP4 = ROADMAP.replace('**Goal**: Docs for the API', '**Depends on**: Phase 2, Phase 3\n**Goal**: Docs for the API');
const PH = PHASES.map((p) => (p.number === '4' ? { ...p, deps: ['2', '3'] } : p));
const NOW = new Date('2026-10-13T12:00:00Z');

function project({ decisions = false } = {}) {
  const root = tmpGitRepo();
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', '.gitignore'), 'run/\nlogs/\nlocks/\n');
  fs.writeFileSync(path.join(root, '.planning', 'ROADMAP.md'), ROADMAP4);
  const dir = path.join(root, '.planning', 'phases', '03-web');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '03-CONTEXT.md'), '# ctx\n');
  fs.writeFileSync(path.join(dir, '03-01-PLAN.md'), '---\nphase: 03-web\nplan: 01\nfiles_modified:\n  - web/app.js\n  - "web/app.test.js"\n---\n\nbody\n');
  if (decisions) {
    fs.mkdirSync(path.join(root, '.planning', 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'decisions', 'INDEX.md'), '# Decisions\n');
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'planning'], { cwd: root });
  return root;
}
const subject = (root) => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, encoding: 'utf8' }).trim();
const GOOD = {
  phases: { 2: { areas: ['src/api/**', 'test/api/**'], gates: [], confidence: 'high' }, 3: { areas: ['web/**'], gates: ['prod-deploy'], confidence: 'high' }, 4: { areas: ['docs/**'], gates: [], confidence: 'high' } },
  pairs: [['2', '4', 'ok', 'no shared files'], ['2', '3', 'conflict', 'the client and the API share the schema'], ['3', '4', 'ok', 'no shared files']],
  relax: [],
};

test('filesModified: block and inline lists', () => {
  assert.deepEqual(filesModified('---\nfiles_modified: [a.js, "b/c.ts"]\n---\n'), ['a.js', 'b/c.ts']);
  assert.deepEqual(filesModified('---\nfiles_modified:\n  - x.md\n  - \'y.md\'\nautonomous: true\n---\n'), ['x.md', 'y.md']);
  assert.deepEqual(filesModified('no frontmatter'), []);
});

test('brief without lanes.json: every unfinished phase is a target, with its files; the brief file is written', () => {
  const root = project();
  const b = annotateBrief(root, { phases: PH, config: { lang: 'ru', autonomy: 'max' } });
  assert.equal(b.reason, 'phases');
  assert.deepEqual(b.targets.map((t) => t.phase), ['2', '3', '4']);
  const web = b.targets[1];
  assert.equal(web.context, '.planning/phases/03-web/03-CONTEXT.md');
  assert.deepEqual(web.plans, [{ file: '.planning/phases/03-web/03-01-PLAN.md', filesModified: ['web/app.js', 'web/app.test.js'] }]);
  assert.equal(web.dependsOn, 'Phase 2 (the API must exist)');
  assert.deepEqual(b.targets[2].deps, ['2', '3']);
  assert.deepEqual([b.lang, b.autonomy, b.others, b.answer], ['ru', 'max', [], null]);
  assert.ok(b.gates.includes('owner-signature'));
  assert.deepEqual(JSON.parse(fs.readFileSync(briefFile(root), 'utf8')), b);
  assert.equal(b.analysisFile, analysisFile(root));
});

test('apply: ROADMAP lines, a fresh lanes.json, Parallel with without dependency chains, one commit; GSD reads the same Goal and Depends on', () => {
  const root = project();
  const before = ['2', '3', '4'].map((n) => [gsdGoal(gsdSection(ROADMAP4, n)), gsdDepends(gsdSection(ROADMAP4, n))]);
  const r = applyAnalysis(root, GOOD, { phases: PH, config: {}, now: NOW });
  assert.deepEqual([r.annotated, r.low, r.pairs, r.relaxed, r.asked, r.adr], [['2', '3', '4'], [], 3, [], null, null]);
  assert.equal(r.commit.committed, true);
  assert.equal(subject(root), 'docs(turbo): lane markup for phase 2, 3, 4');
  const text = fs.readFileSync(roadmapFile(root), 'utf8');
  assert.deepEqual(['2', '3', '4'].map((n) => [gsdGoal(gsdSection(text, n)), gsdDepends(gsdSection(text, n))]), before);
  const p = Object.fromEntries(parseRoadmapPhases(text).map((s) => [s.number, s]));
  assert.deepEqual(p['2'].parallelWith, null, 'phase 4 depends on phase 2: no Parallel with');
  assert.deepEqual(p['3'].gates, ['prod-deploy']);
  const l = readLanesFile(root);
  assert.equal(l.fresh, true);
  assert.deepEqual(l.phases['2'], { areas: ['src/api/**', 'test/api/**'], gates: [], confidence: 'high' });
  assert.equal(annotateReason(root, PH), null);
});

test('an invalid analysis is refused with every problem and changes nothing', () => {
  const root = project();
  const roadmap = fs.readFileSync(roadmapFile(root), 'utf8');
  const bad = {
    phases: {
      2: { areas: ['src/{api,web}/**', '.planning/**', '/abs/x', '../up/**', 'a,b'], gates: ['deploy'], confidence: 'medium' },
      9: { areas: ['x/**'], gates: [], confidence: 'high' },
    },
    pairs: [['2', '1', 'ok', 'finished phase'], ['2', '3', 'maybe', 'x']],
    relax: [{ phase: '3', drop: ['1'], kind: 'guess', reason: '' }],
  };
  assert.throws(() => applyAnalysis(root, bad, { phases: PH, config: {}, now: NOW }), (e) => {
    assert.ok(e instanceof AnnotateRefused);
    const all = e.problems.join('\n');
    for (const n of ['phase 9 is not a phase to mark up', 'has braces', 'names .planning', 'is absolute', 'leaves the repository', 'has a comma', 'gates must be a list of', 'confidence must be high or low', 'pair 2/1: two different unfinished phases', 'pair 2/3: state must be conflict or ok', 'relax 1: drop must name dependencies phase 3 has (2)', 'relax 1: kind must be prose or imaginary', 'relax 1: needs a reason']) assert.ok(all.includes(n), n);
    return true;
  });
  assert.equal(fs.readFileSync(roadmapFile(root), 'utf8'), roadmap);
  assert.ok(!fs.existsSync(lanesFile(root)));
  assert.equal(subject(root), 'planning');
  assert.deepEqual(validateAnalysis(null, { targets: ['2'], unfinished: ['2'], gates: [], deps: new Map() }), ['the analysis is not a JSON object with a phases object']);
});

test('a target the analyst left out is recorded with low confidence; a second run marks up only the stale phase and keeps the rest', () => {
  const root = project();
  const { 4: _drop, ...two } = GOOD.phases;
  const r = applyAnalysis(root, { phases: two, pairs: [] }, { phases: PH, config: {}, now: NOW });
  assert.deepEqual(r.low, ['4']);
  assert.deepEqual(readLanesFile(root).phases['4'], { areas: ['**'], gates: [], confidence: 'low' });
  fs.writeFileSync(roadmapFile(root), fs.readFileSync(roadmapFile(root), 'utf8').replace('**Depends on**: Phase 2, Phase 3', '**Depends on**: Phase 2'));
  const PH2 = PH.map((p) => (p.number === '4' ? { ...p, deps: ['2'] } : p));
  const b = annotateBrief(root, { phases: PH2, config: {} });
  assert.deepEqual(b.targets.map((t) => t.phase), ['4']);
  assert.deepEqual(b.others.map((o) => [o.phase, o.areas]), [['2', ['src/api/**', 'test/api/**']], ['3', ['web/**']]]);
  applyAnalysis(root, { phases: { 4: GOOD.phases['4'] }, pairs: [['3', '4', 'ok', 'no shared files']] }, { phases: PH2, config: {}, now: NOW });
  const l = readLanesFile(root);
  assert.equal(l.fresh, true);
  assert.deepEqual(l.phases['3'], { areas: ['web/**'], gates: ['prod-deploy'], confidence: 'high' });
  assert.deepEqual(l.pairs, [['3', '4', 'ok', 'no shared files']]);
  assert.deepEqual(parseRoadmapPhases(fs.readFileSync(roadmapFile(root), 'utf8')).find((s) => s.number === '4').parallelWith, ['3']);
});

test('autonomy max applies a relaxation in the Phase N form and writes the decision record (DECISIONS.md without a decisions directory)', () => {
  const root = project();
  const a = { ...GOOD, relax: [{ phase: '4', drop: ['3'], kind: 'imaginary', reason: 'the docs describe the API only' }] };
  const r = applyAnalysis(root, a, { phases: PH, config: { autonomy: 'max' }, now: NOW });
  assert.deepEqual([r.relaxed, r.adr], [['r1'], '.planning/turbo/DECISIONS.md']);
  const text = fs.readFileSync(roadmapFile(root), 'utf8');
  assert.deepEqual(gsdDeps(gsdDepends(gsdSection(text, '4'))), ['2']);
  assert.equal(gsdDepends(gsdSection(text, '4')), 'Phase 2');
  const adr = fs.readFileSync(path.join(root, '.planning', 'turbo', 'DECISIONS.md'), 'utf8');
  for (const n of ['## Relaxed phase dependencies (2026-10-13)', 'Decided by: gsd-turbo (autonomy max)', '### Phase 4', '- Was: `**Depends on**: Phase 2, Phase 3`', '- Now: `**Depends on**: Phase 2`', '- Why (imaginary): the docs describe the API only', '- Roll back:']) assert.ok(adr.includes(n), n);
  assert.equal(readLanesRaw(root).proposal.state, 'applied');
  assert.equal(readLanesFile(root).fresh, true);
  const files = execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(files, ['.planning/ROADMAP.md', '.planning/turbo/DECISIONS.md', '.planning/turbo/lanes.json']);
});

test('the decision record goes into .planning/decisions/ when that directory exists', () => {
  const root = project({ decisions: true });
  applyAnalysis(root, { ...GOOD, relax: [{ phase: '4', drop: ['3'], kind: 'prose', reason: 'wording only' }] }, { phases: PH, config: { autonomy: 'max' }, now: NOW });
  assert.ok(fs.existsSync(path.join(root, '.planning', 'decisions', 'turbo-2026-10-13-relaxed-dependencies.md')));
  assert.ok(!fs.existsSync(path.join(root, '.planning', 'turbo', 'DECISIONS.md')));
});

test('standard autonomy asks one card under annotate, changes no dependency, and applies the owner\'s answer later', () => {
  const root = project();
  const a = { ...GOOD, relax: [{ phase: '4', drop: ['3'], kind: 'prose', reason: 'wording only' }] };
  const r = applyAnalysis(root, a, { phases: PH, config: { autonomy: 'standard', lang: 'en' }, now: NOW });
  assert.equal(r.asked, 'ask-1');
  assert.equal(readLaneStatus(root, 'annotate').status, 'running', 'the card does not stop the markup lane');
  assert.equal(gsdDepends(gsdSection(fs.readFileSync(roadmapFile(root), 'utf8'), '4')), 'Phase 2, Phase 3');
  const [q] = readQuestions(root, 'annotate');
  assert.deepEqual(q.options.map((o) => [o.label, o.recommended]), [['Remove all', true], ['Leave as is', false]]);
  assert.match(q.context, /Phase 4 waits for phase 3 only in its wording\. To remove only some of them, answer in your own words which\./);
  assert.equal(readLanesRaw(root).proposal.state, 'asked');
  assert.equal(annotateReason(root, PH), null, 'nothing waits for the card');
  assert.throws(() => applyAnswer(root, 'all', { phases: PH, config: {}, now: NOW }), /the owner has not answered ask-1 yet/);
  answerQuestion({ root, phase: 'annotate', id: 'ask-1', option: 1, by: 'session', commit: () => ({ committed: false, reason: 'test' }) });
  assert.equal(annotateReason(root, PH), 'answer');
  assert.deepEqual(annotateBrief(root, { phases: PH, config: {} }).answer, { id: 'ask-1', option: 1, label: 'Remove all', text: null, relax: 'all' });
  const done = applyAnswer(root, 'all', { phases: PH, config: {}, now: NOW });
  assert.deepEqual([done.applied, done.skipped], [['r1'], []]);
  assert.equal(gsdDepends(gsdSection(fs.readFileSync(roadmapFile(root), 'utf8'), '4')), 'Phase 2');
  assert.match(fs.readFileSync(path.join(root, '.planning', 'turbo', 'DECISIONS.md'), 'utf8'), /Decided by: the owner \(answer ask-1\)/);
  assert.equal(readQuestions(root, 'annotate')[0].state, 'delivered');
  assert.equal(readLanesRaw(root).proposal.state, 'applied');
  assert.equal(readLanesFile(root).fresh, true);
  assert.equal(annotateReason(root, PH), null);
  assert.equal(subject(root), 'docs(turbo): relaxed dependencies of phase 4 (owner)');
});

test('applyAnswer refuses an unknown id, skips a Depends on line edited since the card, and declines on none', () => {
  const root = project();
  applyAnalysis(root, { ...GOOD, relax: [{ phase: '4', drop: ['3'], kind: 'prose', reason: 'wording only' }] }, { phases: PH, config: {}, now: NOW });
  answerQuestion({ root, phase: 'annotate', id: 'ask-1', text: 'only the docs one', by: 'session', commit: () => ({ committed: false, reason: 'test' }) });
  assert.deepEqual(annotateBrief(root, { phases: PH, config: {} }).answer, { id: 'ask-1', option: null, label: null, text: 'only the docs one', relax: null });
  assert.throws(() => applyAnswer(root, ['r9'], { phases: PH, config: {}, now: NOW }), /no proposal r9: the card holds r1/);
  fs.writeFileSync(roadmapFile(root), fs.readFileSync(roadmapFile(root), 'utf8').replace('**Depends on**: Phase 2, Phase 3', '**Depends on**: Phase 3'));
  const r = applyAnswer(root, ['r1'], { phases: PH.map((p) => (p.number === '4' ? { ...p, deps: ['3'] } : p)), config: {}, now: NOW });
  assert.deepEqual([r.applied, r.skipped, r.adr], [[], ['r1'], null]);
  assert.equal(gsdDepends(gsdSection(fs.readFileSync(roadmapFile(root), 'utf8'), '4')), 'Phase 3', 'never overwritten');
  assert.equal(readLanesRaw(root).proposal.state, 'declined');
  assert.throws(() => applyAnswer(root, 'none', { phases: PH, config: {}, now: NOW }), /no dependency card waits for an answer/);
});

test('review: a mask with a control character is refused', () => {
  const problems = validateAnalysis({ phases: { 2: { areas: ['src/a\n## Phase 9: Evil'], gates: [], confidence: 'high' } } }, { targets: ['2'], unfinished: ['2'], gates: [], deps: new Map() });
  assert.ok(problems.some((p) => p.includes('has a control character')), problems.join('; '));
});

test('review: an answer applied while only a finished phase changed leaves the markup fresh', () => {
  const root = project();
  applyAnalysis(root, { ...GOOD, relax: [{ phase: '4', drop: ['3'], kind: 'prose', reason: 'wording only' }] }, { phases: PH, config: {}, now: NOW });
  fs.writeFileSync(roadmapFile(root), fs.readFileSync(roadmapFile(root), 'utf8').replace('**Goal**: The skeleton builds', '**Goal**: The skeleton builds and runs'));
  assert.equal(readLanesFile(root).fresh, false);
  answerQuestion({ root, phase: 'annotate', id: 'ask-1', option: 1, by: 'session', commit: () => ({ committed: false, reason: 'test' }) });
  assert.deepEqual(applyAnswer(root, 'all', { phases: PH, config: {}, now: NOW }).applied, ['r1']);
  assert.equal(readLanesFile(root).fresh, true);
});

test('v0.4.0: the dependency card may be taken automatically (autoOk: its decision record undoes it), and the record says turbo decided', () => {
  const root = project();
  applyAnalysis(root, { ...GOOD, relax: [{ phase: '4', drop: ['3'], kind: 'prose', reason: 'wording only' }] }, { phases: PH, config: { autonomy: 'standard', lang: 'en' }, now: NOW });
  const [q] = readQuestions(root, 'annotate');
  assert.equal(q.autoOk, true);
  answerQuestion({ root, phase: 'annotate', id: 'ask-1', option: 1, by: 'auto', commit: () => ({ committed: false, reason: 'test' }) });
  applyAnswer(root, 'all', { phases: PH, config: {}, now: NOW });
  assert.match(fs.readFileSync(path.join(root, '.planning', 'turbo', 'DECISIONS.md'), 'utf8'), /Decided by: gsd-turbo automatically, the owner did not answer in time \(answer ask-1\)/);
});
