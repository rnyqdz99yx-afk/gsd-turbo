import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STALE_REPORT, adoptProject, closedRow, commitAll, MANAGER, write } from './helpers/adopt.mjs';
import { setManager } from './helpers/fake-gsd.mjs';
import { jargonIn, plainWords } from '../lib/questions.mjs';
import { analysisFile } from '../lib/annotate.mjs';
import { ADOPT_REL, AdoptRefused, AdoptUsage, adoptPlan, adoptQuestions, formatPlan, parseAnswers, readReverified, reverifyResult } from '../lib/adopt.mjs';

const GOOD = {
  phases: { 2: { areas: ['src/api/**'], gates: [], confidence: 'high' }, 3: { areas: ['web/**'], gates: ['owner-live'], confidence: 'high' }, 4: { areas: ['docs/**'], gates: [], confidence: 'high' } },
  pairs: [],
  relax: [{ phase: '4', drop: ['3'], kind: 'prose', reason: 'wording only' }],
};
const kinds = (p) => p.changes.map((c) => c.kind);
const record = (o) => JSON.stringify({ v: 1, state: 'applied', at: '2026-10-14T00:00:00.000Z', staleClosed: ['1'], answers: { 'stale-closed': { value: 'keep', set: ['1'] } }, reverified: {}, paths: [ADOPT_REL], ...o });

test('parseAnswers: the A3 syntax, anything else is a usage error', () => {
  assert.deepEqual(parseAnswers('stale-closed=keep,relax=r1+r3'), { 'stale-closed': 'keep', relax: ['r1', 'r3'] });
  assert.deepEqual(parseAnswers('relax=all'), { relax: 'all' });
  assert.deepEqual(parseAnswers(''), {});
  for (const bad of ['stale=keep', 'stale-closed=maybe', 'relax=r1,r2', 'relax=1', 'stale-closed=keep,stale-closed=reverify', 'x']) assert.throws(() => parseAnswers(bad), AdoptUsage, bad);
});

test('closed phases with a stale verification: one question, keep recommended first, no own words; the Russian texts are plain words', () => {
  const { root, deps } = adoptProject({ config: { lang: 'ru' } });
  const p = adoptPlan(root, { deps });
  assert.equal(p.refused, undefined, String(p.refused));
  const [q, ...rest] = p.questions;
  assert.equal(rest.length, 0);
  assert.equal(q.id, 'stale-closed');
  assert.deepEqual(q.options.map((o) => [o.label, o.recommended]), [['Оставить закрытыми', true], ['Перепроверить', false]]);
  assert.equal(q.allowOther, false);
  assert.match(q.question, /^Фаза 1 отмечена сделанной, но её проверка устарела/);
  assert.ok(q.header.length <= 12);
  plainWords([['question', q.question], ['context', q.context], ...q.options.flatMap((o) => [['label', o.label], ['description', o.description]])], { lang: 'ru' });
  for (const t of [q.question, q.context, ...q.options.flatMap((o) => [o.label, o.description])]) assert.equal(jargonIn(t), null, t);
});

test('a question answered for the same set is not asked again; a new closed phase asks again', () => {
  const { root, core, deps } = adoptProject({ files: { [ADOPT_REL]: record() } });
  assert.deepEqual(adoptPlan(root, { deps }).questions, []);
  setManager(core, { ...MANAGER, phases: [...MANAGER.phases.slice(0, 1), closedRow('2', ['1']), ...MANAGER.phases.slice(2)] });
  const q = adoptPlan(root, { deps }).questions;
  assert.deepEqual(q.map((x) => x.id), ['stale-closed']);
  assert.match(q[0].question, /^Phases 1, 2 are checked off/);
});

test('a valid analysis with relaxations: the relax card joins the questions at standard; at max no question, the markup change carries the decision record', () => {
  const { root, deps } = adoptProject({ files: { [ADOPT_REL]: record() } });
  write(root, path.relative(root, analysisFile(root)).split(path.sep).join('/'), JSON.stringify(GOOD));
  let p = adoptPlan(root, { deps });
  assert.equal(p.analysis, 'valid');
  const [q] = p.questions;
  assert.deepEqual([q.id, q.allowOther, q.options.map((o) => o.label)], ['relax', true, ['Remove all', 'Leave as is']]);
  assert.deepEqual(q.proposals.map((x) => x.id), ['r1']);
  for (const t of [q.question, q.context]) assert.equal(jargonIn(t), null, t);
  p = adoptPlan(root, { deps, answers: { relax: 'none' } });
  assert.deepEqual(p.changes.find((c) => c.kind === 'markup').paths, ['.planning/ROADMAP.md', '.planning/turbo/lanes.json']);
  // the forecast already schedules with the markup: phase 3 holds owner-live, which the report names
  assert.deepEqual(p.owner.ownerGates, [{ phase: '3', gates: ['owner-live'] }]);

  write(root, '.planning/turbo/config.json', JSON.stringify({ autonomy: 'max' }));
  commitAll(root);
  p = adoptPlan(root, { deps });
  assert.deepEqual(p.questions, []);
  assert.deepEqual(p.changes.find((c) => c.kind === 'markup'), { kind: 'markup', paths: ['.planning/ROADMAP.md', '.planning/turbo/lanes.json', '.planning/turbo/DECISIONS.md'], value: { targets: ['2', '3', '4'], relax: ['r1'] }, text: p.changes.find((c) => c.kind === 'markup').text });
  // relaxed: 4 no longer waits on 3, so 3 and 4 run side by side after 2
  assert.deepEqual(p.forecast.after.steps, [['2'], ['3', '4']]);
});

test('an invalid analysis is refused with its problems and adds no markup change', () => {
  const { root, deps } = adoptProject();
  write(root, '.planning/turbo/run/annotate/analysis.json', JSON.stringify({ phases: { 9: { areas: [], gates: [], confidence: 'x' } } }));
  const p = adoptPlan(root, { deps, answers: { 'stale-closed': 'keep' } });
  assert.equal(p.analysis, 'refused');
  assert.ok(p.problems.length >= 1);
  assert.ok(!kinds(p).includes('markup'));
  assert.match(formatPlan(p).join('\n'), /^markup refused: /m);
});

test('the change list in its fixed order, and the plan digest: stable, and changed by an answer', () => {
  const { root, deps } = adoptProject({ config: null });
  const a = adoptPlan(root, { deps, answers: { 'stale-closed': 'keep' } });
  assert.deepEqual(kinds(a), ['turbo-config', 'test-command', 'context-window', 'chunked', 'record']);
  assert.match(a.plan, /^[0-9a-f]{64}$/);
  assert.equal(adoptPlan(root, { deps, answers: { 'stale-closed': 'keep' } }).plan, a.plan);
  const b = adoptPlan(root, { deps, answers: { 'stale-closed': 'reverify' } });
  assert.notEqual(b.plan, a.plan);
  assert.deepEqual(kinds(b), ['turbo-config', 'test-command', 'context-window', 'chunked', 'reverify', 'record']);
  assert.deepEqual(b.reverify, ['1']);
  assert.deepEqual(b.changes.find((c) => c.kind === 'reverify').paths, ['.planning/phases/01-base/01-VERIFICATION.md', '.planning/turbo/adopt/reverify-p1.md']);
  // a question asked with --answers given but not answered is a usage error
  assert.throws(() => adoptPlan(root, { deps, answers: {} }), AdoptUsage);
  // explicit chunked_parallel false is the project's and stays; GSD's own branching is turned off in slots mode only
  write(root, '.planning/config.json', JSON.stringify({ planning: { chunked_parallel: false }, git: { branching_strategy: 'phase' } }));
  commitAll(root);
  const c = adoptPlan(root, { deps, answers: { 'stale-closed': 'keep' } });
  assert.ok(!kinds(c).includes('chunked'));
  assert.deepEqual(c.changes.find((x) => x.kind === 'branching').value, { from: 'phase', to: 'none' });
});

test('adoptQuestions: no closed-stale phase, no question', () => {
  assert.deepEqual(adoptQuestions({ staleClosed: [] }, {}), []);
});

test('reverifyResult: passed keeps the fresh report; gaps_found moves it aside and puts the committed one back byte for byte', () => {
  const { root, deps } = adoptProject();
  const rel = '.planning/phases/01-base/01-VERIFICATION.md';
  write(root, rel, '---\nphase: 01-base\nstatus: passed\n---\n\nfresh\n');
  let r = reverifyResult(root, '1', { deps });
  assert.deepEqual([r.status, r.kept, r.report, r.others], ['passed', true, null, []]);
  assert.deepEqual(readReverified(root)['1'], { status: 'passed', files: [rel] });

  const q = adoptProject();
  write(q.root, rel, '---\nphase: 01-base\nstatus: gaps_found\n---\n\nnew gaps\n');
  write(q.root, 'tmp-artifact.log', 'left by the verifier\n');
  r = reverifyResult(q.root, '01', { deps: q.deps });
  assert.deepEqual([r.status, r.kept, r.report, r.others], ['gaps_found', false, '.planning/turbo/adopt/reverify-p1.md', ['tmp-artifact.log']]);
  assert.equal(fs.readFileSync(path.join(q.root, rel), 'utf8'), STALE_REPORT);
  assert.match(fs.readFileSync(path.join(q.root, '.planning', 'turbo', 'adopt', 'reverify-p1.md'), 'utf8'), /new gaps/);
  // the re-verified phase still counts as closed-stale; a phase that is not one is refused
  assert.throws(() => reverifyResult(q.root, '3', { deps: q.deps }), (e) => e instanceof AdoptRefused && /phase 3 is not a closed phase with a stale verification/.test(e.message));
});

test('reverifyResult: a verifier that wrote nothing new moves nothing', () => {
  const { root, deps } = adoptProject();
  const r = reverifyResult(root, '1', { deps });
  assert.deepEqual([r.status, r.report, r.reason], ['stale', null, 'the verifier wrote no new report']);
  assert.deepEqual(readReverified(root)['1'].files, []);
});
