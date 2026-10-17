import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildRig, claudeHome } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { BuildFailed, openBuild, runStep } from '../lib/build.mjs';
import { runGsdJson } from '../lib/gsd.mjs';
import { gsdText } from '../lib/gates.mjs';
import { gsdCoreDir } from '../lib/paths.mjs';
import { needsResearch, readPhaseInfo } from '../lib/phase-signals.mjs';
import { rolePrompt } from '../lib/roles.mjs';
import { formatProblems } from '../lib/slice-lint.mjs';
import { LEAN_RESEARCH_RULE } from '../lib/lane-prompt.mjs';
import { readQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';

const H = claudeHome();
after(() => H.restore());
const REL = '.planning/phases/05-demo';
const PLAN1 = compactPlan({ id: '05-01' });
const PLAN2 = compactPlan({ id: '05-02', wave: 2, deps: ['05-01'], files: ['src/b.js', 'test/b.test.js'], reqs: ['DEMO-02'], decisions: ['D-02'] });
const PLANS = { [`${REL}/05-01-PLAN.md`]: PLAN1, [`${REL}/05-02-PLAN.md`]: PLAN2 };

// A rig whose gsd records its calls; ctx opened and released after the test.
async function rig(t, { project = {}, script = {}, deps = {} } = {}) {
  const calls = [];
  const holder = {};
  const gsd = (args, { json = true } = {}) => {
    calls.push(args);
    const core = gsdCoreDir(holder.root);
    return json ? runGsdJson(core, args, { cwd: holder.root }) : gsdText(core, holder.root, args);
  };
  const r = await buildRig({ project, script, deps: { gsd, ...deps } });
  holder.root = r.root;
  const ctx = await openBuild(r.root, '5', { deps: r.deps });
  t.after(() => ctx.release());
  return { ...r, ctx, calls };
}

// Answers the first open card of phase 5 with this option once it appears.
function answerWhenAsked(root, option, { id = null } = {}) {
  const timer = setInterval(() => {
    const q = readQuestions(root, '5').find((x) => x.state === 'open' && (!id || x.id === id));
    if (!q) return;
    clearInterval(timer);
    answerQuestion({ root, phase: '5', id: q.id, option, by: 'pane', laneRunning: true });
  }, 20);
  return () => clearInterval(timer);
}

test('begin records the phase base and begins the phase in GSD', async (t) => {
  const { root, git, ctx, calls, lines } = await rig(t);
  assert.equal(await runStep(ctx, 'begin'), 'done');
  assert.ok(calls.some((a) => JSON.stringify(a) === JSON.stringify(['query', 'state.begin-phase', '--phase', '5', '--name', 'Demo Feature', '--plans', '0'])));
  assert.equal(ctx.state.base, git('rev-parse', 'HEAD'));
  assert.ok(lines.some((l) => / phase 5 build: warn: state-sync: /.test(l)), lines.join('\n'));
  assert.equal(await runStep(ctx, 'begin'), 'done');
  assert.equal(root, ctx.root);
});

test('discuss: skipped with a CONTEXT.md; otherwise one session runs GSD\'s assumptions workflow with --auto', async (t) => {
  const a = await rig(t);
  assert.equal(await runStep(a.ctx, 'discuss'), 'skipped');
  assert.equal(a.ctx.state.steps.discuss.why, 'CONTEXT.md exists');
  assert.deepEqual(a.a.acts(), []);

  const ctxText = fs.readFileSync(path.join(a.phaseDir, '05-CONTEXT.md'), 'utf8');
  const b = await rig(t, { project: { context: false }, script: { context: { path: `${REL}/05-CONTEXT.md`, text: ctxText } } });
  assert.equal(await runStep(b.ctx, 'discuss'), 'done');
  assert.deepEqual(b.a.acts().map((x) => x.role), ['discuss']);
  const call = b.f.calls()[0];
  const core = gsdCoreDir(b.root).split(path.sep).join('/');
  assert.ok(call.stdin.startsWith(`Read and execute ${core}/workflows/discuss-phase-assumptions.md with the arguments "5 --auto".`), call.stdin);
  assert.match(call.stdin, /skip the workflow's auto_advance step/);
  assert.match(call.stdin, /## OWNER QUESTION\nQuestion: <one line>/);
  assert.equal(call.argv[call.argv.indexOf('--effort') + 1], 'high');
  assert.equal(call.argv.includes('--agent'), false);

  const c = await rig(t, { project: { context: false } });
  await assert.rejects(runStep(c.ctx, 'discuss'), (err) => err instanceof BuildFailed && err.message === 'discuss produced no CONTEXT.md');
});

test('research: by the phase\'s signals', async (t) => {
  const a = await rig(t);
  assert.equal(await runStep(a.ctx, 'research'), 'skipped');
  assert.equal(a.ctx.state.steps.research.why, needsResearch(readPhaseInfo(a.root, '5')).why);

  const b = await rig(t, { script: { research: { path: `${REL}/05-RESEARCH.md`, text: '# Research\n' } } });
  const roadmap = path.join(b.root, '.planning', 'ROADMAP.md');
  fs.writeFileSync(roadmap, fs.readFileSync(roadmap, 'utf8').replace('**Goal**: Ship the demo', '**Goal**: Ship the demo through the Stripe API'));
  b.commit('docs: stripe');
  assert.equal(await runStep(b.ctx, 'research'), 'done');
  const call = b.f.calls()[0];
  assert.equal(call.argv[call.argv.indexOf('--agent') + 1], 'gsd-phase-researcher');
  assert.equal(call.argv[call.argv.indexOf('--effort') + 1], 'medium');
  for (const s of ['Research how to implement Phase 5: Demo Feature', `Write to: ${REL}/05-RESEARCH.md`, LEAN_RESEARCH_RULE, 'Keep RESEARCH.md under 25 KB.']) assert.ok(call.stdin.includes(s), s);
  assert.equal(b.git('log', '-1', '--format=%s'), 'docs(phase-5): research');

  const c = await rig(t);
  c.write(`${REL}/05-RESEARCH.md`, '# Research\n');
  c.commit('docs: research');
  assert.equal(await runStep(c.ctx, 'research'), 'skipped');
  assert.equal(c.ctx.state.steps.research.why, 'RESEARCH.md exists');
  const d = await rig(t);
  d.write(`${REL}/05-RESEARCH.md`, '# Research\n');
  assert.equal(await runStep(d.ctx, 'research'), 'done');
  assert.equal(d.git('log', '-1', '--format=%s'), 'docs(phase-5): research');
  assert.deepEqual(d.a.acts(), []);
});

test('slice: plans written, checked, committed', async (t) => {
  const { root, git, f, ctx } = await rig(t, { script: { plans: PLANS } });
  const expected = rolePrompt('slicer', { root, phase: '5', contextPath: `${REL}/05-CONTEXT.md`, lang: 'en' });
  assert.equal(await runStep(ctx, 'slice'), 'done');
  assert.equal(git('log', '-1', '--format=%s'), 'docs(phase-5): slice plans');
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [`${REL}/05-01-PLAN.md`, `${REL}/05-02-PLAN.md`]);
  assert.deepEqual(Object.entries(ctx.state.slices).map(([id, s]) => [id, s.state]), [['05-01', 'waiting'], ['05-02', 'waiting']]);
  assert.deepEqual(ctx.state.edges, [{ from: '05-01', to: '05-02', kind: 'depends', why: '' }]);
  assert.equal(f.calls()[0].stdin, expected);
});

test('slice: one revision by the same session, then a held card', async (t) => {
  const P = [{ plan: '05-01', kind: 'tasks', detail: 'no task' }];
  let n = 0;
  const once = (r) => (++n === 1 ? { ok: false, problems: P, edges: [] } : { ok: true, problems: [], edges: [] });
  const a = await rig(t, { script: { plans: PLANS }, deps: { lint: () => once() } });
  assert.equal(await runStep(a.ctx, 'slice'), 'done');
  const [first, second] = a.f.calls();
  assert.equal(second.stdin, formatProblems(P));
  assert.deepEqual(second.argv.slice(-2), ['--resume', a.ctx.state.steps.slice.session.id]);
  assert.equal(a.ctx.state.steps.slice.revised, true);
  assert.ok(first);

  const bad = () => ({ ok: false, problems: P, edges: [] });
  const b = await rig(t, { script: { plans: PLANS }, deps: { lint: bad } });
  const stop = answerWhenAsked(b.root, 2);
  t.after(stop);
  assert.equal(await runStep(b.ctx, 'slice'), 'done');
  const card = readQuestions(b.root, '5')[0];
  assert.equal(card.held, true);
  assert.match(card.question, /automatic check of the work plan/);
  assert.equal(b.git('log', '-1', '--format=%s'), 'docs(phase-5): slice plans');

  let k = 0;
  const c = await rig(t, { script: { plans: PLANS }, deps: { lint: () => (++k <= 2 ? bad() : { ok: true, problems: [], edges: [] }) } });
  const stop2 = answerWhenAsked(c.root, 1);
  t.after(stop2);
  assert.equal(await runStep(c.ctx, 'slice'), 'done');
  assert.deepEqual(readQuestions(c.root, '5').map((q) => [q.held, q.state]), [[true, 'delivered']]);
  const fresh = c.f.calls().filter((x) => !x.argv.includes('--resume'));
  assert.equal(fresh.length, 2, 'Try again starts a new slicer session');
});

test('slice: a check that could not run is no revision', async (t) => {
  const lint = () => ({ ok: false, problems: [{ plan: null, kind: 'gsd', detail: 'GSD core not found' }], edges: [] });
  const { f, ctx } = await rig(t, { script: { plans: PLANS }, deps: { lint } });
  await assert.rejects(runStep(ctx, 'slice'), (err) => err instanceof BuildFailed && /^gsd-tools could not check the slices: GSD core not found$/.test(err.message));
  assert.equal(f.calls().filter((x) => x.argv.includes('--resume')).length, 0);
});

test('slice: a CONTEXT GSD cannot read goes to the owner, not back to the slicer', async (t) => {
  const lint = () => ({ ok: false, problems: [{ plan: null, kind: 'decisions', detail: 'could-not-parse' }], edges: [] });
  const { root, f, ctx } = await rig(t, { script: { plans: PLANS }, deps: { lint } });
  const stop = answerWhenAsked(root, 2);
  t.after(stop);
  assert.equal(await runStep(ctx, 'slice'), 'done');
  assert.equal(f.calls().filter((x) => x.argv.includes('--resume')).length, 0);
  assert.equal(readQuestions(root, '5').length, 1);
});

test('slice: adopted GSD plans skip the slicer', async (t) => {
  const { write, commit, a, ctx } = await rig(t, { project: { config: { build: { adopt_plans: true } } } });
  write(`${REL}/05-01-PLAN.md`, PLAN1);
  write(`${REL}/05-02-PLAN.md`, PLAN2);
  commit('docs: GSD plans');
  assert.equal(await runStep(ctx, 'slice'), 'skipped');
  assert.equal(ctx.state.steps.slice.why, 'GSD plans adopted (2)');
  assert.deepEqual(a.acts(), []);
  assert.deepEqual(Object.keys(ctx.state.slices), ['05-01', '05-02']);
});
