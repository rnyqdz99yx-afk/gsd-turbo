import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildRig, claudeHome } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { BUILD_STEPS, HALT_KINDS, BuildFailed, adoptRound, haltQuestion, openBuild, ownerAsk, setStep, stepSession, takeAnswer } from '../lib/build.mjs';
import { loadBuildState, reconcileBuildState, saveBuildState } from '../lib/build-queue.mjs';
import { runDir } from '../lib/paths.mjs';
import { laneQuestion, liveAnswer, readAnswers, readQuestions } from '../lib/questions.mjs';
import { answerQuestion, laneDeliveryMessage } from '../lib/answers.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';

const H = claudeHome();
after(() => H.restore());
const NOW = new Date('2026-10-17T12:00:00Z');
const DISCUSS = `Read and execute x/workflows/discuss-phase-assumptions.md with the arguments "5 --auto".`;
const OQ = (options) => `Need you.\n## OWNER QUESTION\nQuestion: Which greeting should the bot use?\nContext: Two styles fit.\nOptions:\n${options}`;
const TWO = '1. Formal — Hello, Ann (recommended)\n2. Casual — Hi, Ann';

async function opened(t, script = {}) {
  const rig = await buildRig({ script });
  const ctx = await openBuild(rig.root, '5', { deps: rig.deps });
  t.after(() => ctx.release());
  return { ...rig, ctx };
}

test('setStep stamps the step and refuses unknown names', () => {
  const state = { steps: {}, step: 'begin' };
  assert.deepEqual(setStep(state, 'discuss', { state: 'skipped', why: 'CONTEXT.md exists' }, NOW), { state: 'skipped', why: 'CONTEXT.md exists', at: '2026-10-17T12:00:00.000Z' });
  assert.equal(state.step, 'begin');
  setStep(state, 'discuss', { state: 'running' }, NOW);
  assert.equal(state.step, 'discuss');
  assert.throws(() => setStep(state, 'plan', {}, NOW), /unknown build step: plan/);
  assert.throws(() => setStep(state, 'discuss', { state: 'later' }, NOW), /unknown step state: later/);
  assert.equal(BUILD_STEPS.length, 11);
});

test("B4's fields survive B2's save, load and reconcile", async (t) => {
  const { root, rel, write, commit, ctx } = await opened(t);
  const s0 = loadBuildState(runDir(root), '5');
  assert.deepEqual([s0.step, s0.steps, s0.slices, s0.info], ['begin', {}, {}, { name: 'Demo Feature', padded: '05' }]);
  ctx.state.base = commit('chore: x');
  setStep(ctx.state, 'begin', { state: 'done' }, NOW);
  setStep(ctx.state, 'slice', { state: 'running' }, NOW);
  saveBuildState(runDir(root), '5', ctx.state);
  const s1 = loadBuildState(runDir(root), '5');
  assert.deepEqual([s1.step, s1.steps, s1.base, s1.info], ['slice', ctx.state.steps, ctx.state.base, { name: 'Demo Feature', padded: '05' }]);
  write(`${rel}/05-01-PLAN.md`, compactPlan({ id: '05-01' }));
  write(`${rel}/05-02-PLAN.md`, compactPlan({ id: '05-02', files: ['src/b.js'], reqs: ['DEMO-02'] }));
  commit('docs: plans');
  const steps = structuredClone(ctx.state.steps);
  adoptRound(ctx, { round: 0 });
  assert.deepEqual(Object.entries(ctx.state.slices).map(([id, s]) => [id, s.state]), [['05-01', 'waiting'], ['05-02', 'waiting']]);
  assert.deepEqual(ctx.state.steps, steps);
  const { state } = reconcileBuildState(root, runDir(root), '5');
  assert.deepEqual(state.steps, steps);
  assert.equal(state.base, ctx.state.base);
});

test('stepSession runs a role under a machine slot and records its cost', async (t) => {
  const { root, f, ctx } = await opened(t);
  const r = await stepSession(ctx, { step: 'review', role: 'reviewer', effortKey: 'reviewer', agent: 'gsd-code-reviewer', prompt: 'x', cwd: root, key: '5-review' });
  const argv = f.calls()[0].argv;
  assert.equal(argv[argv.indexOf('--agent') + 1], 'gsd-code-reviewer');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  const settings = argv[argv.indexOf('--settings') + 1];
  assert.ok(settings.startsWith(path.join(H.home, 'turbo', 'tmp')), settings);
  const cost = JSON.parse(fs.readFileSync(path.join(runDir(root), 'cost-p5.json'), 'utf8'));
  const records = cost.sessions;
  assert.equal(records.length, 1);
  assert.deepEqual([records[0].step, records[0].role, records[0].sessionId], ['review', 'reviewer', r.sessionId]);
  const s = ctx.state.steps.review.session;
  assert.equal(s.id, r.sessionId);
  assert.ok(s.transcript && s.pid && s.settings === settings);
  const slots = fs.readdirSync(path.join(H.home, 'turbo', 'sessions')).filter((n) => /^slot-/.test(n));
  assert.deepEqual(slots, []);
});

test('an owner question becomes a held card; its answer resumes the same session once', async (t) => {
  const { root, f, a, ctx } = await opened(t, { results: [OQ(TWO)] });
  const r = await stepSession(ctx, { step: 'discuss', role: 'discuss', effortKey: 'lane', prompt: DISCUSS, cwd: root, key: '5-discuss' });
  assert.equal(await ownerAsk(ctx, r, { step: 'discuss' }), 'asked');
  const [q] = readQuestions(root, '5');
  assert.deepEqual([q.id, q.held, q.state], ['ask-1', true, 'open']);
  assert.equal(readLaneStatus(root, '5'), null);
  assert.deepEqual([ctx.state.steps.discuss.state, ctx.state.steps.discuss.question, ctx.state.steps.discuss.session.id], ['owner', 'ask-1', r.sessionId]);
  assert.equal(await takeAnswer(ctx, 'ask-1'), null);
  answerQuestion({ root, phase: '5', id: 'ask-1', option: 2, by: 'pane', laneRunning: true });
  const resumed = await takeAnswer(ctx, 'ask-1');
  assert.equal(resumed.sessionId, r.sessionId);
  const card = readQuestions(root, '5').find((x) => x.id === 'ask-1');
  assert.deepEqual([card.state, card.delivery.path], ['delivered', 'lane']);
  const call = f.calls().at(-1);
  assert.deepEqual(call.argv.slice(-2), ['--resume', r.sessionId]);
  assert.equal(call.stdin, laneDeliveryMessage(card, liveAnswer(readAnswers(root, '5'), 'ask-1')));
  assert.equal(await takeAnswer(ctx, 'ask-1'), null);
  assert.equal(a.acts().length, 2);
});

test('a question the card refuses is rewritten once by the same session, then the step fails', async (t) => {
  const one = OQ('1. Formal — Hello, Ann (recommended)');
  const { root, f, ctx } = await opened(t, { results: [one, OQ(TWO)] });
  const r = await stepSession(ctx, { step: 'discuss', role: 'discuss', effortKey: 'lane', prompt: DISCUSS, cwd: root, key: '5-discuss' });
  await ownerAsk(ctx, r, { step: 'discuss' });
  assert.match(f.calls()[1].stdin, /^Your OWNER QUESTION could not be asked: a question needs 2 to 4 options/);
  assert.deepEqual(f.calls()[1].argv.slice(-2), ['--resume', r.sessionId]);
  assert.deepEqual(readQuestions(root, '5').map((q) => q.id), ['ask-1']);

  const bad = await opened(t, { results: [one, one] });
  const r2 = await stepSession(bad.ctx, { step: 'discuss', role: 'discuss', effortKey: 'lane', prompt: DISCUSS, cwd: bad.root, key: '5-discuss' });
  await assert.rejects(ownerAsk(bad.ctx, r2, { step: 'discuss' }), (err) => err instanceof BuildFailed && /owner question refused twice: /.test(err.message));
});

test('haltQuestion: plain words in the owner\'s language', () => {
  assert.deepEqual(haltQuestion('red', { phase: '5', lang: 'en' }), {
    question: 'Phase 5: the tests stay red after one fix. What should the build do?',
    context: '',
    options: [{ label: 'Try again', description: 'the build runs this step once more' }, { label: 'Stop here', description: 'the phase waits; `turbo-run resume 5` starts it again' }],
    recommended: 1,
  });
  assert.deepEqual(haltQuestion('review', { phase: '5', lang: 'en' }).options[1], { label: 'Go on', description: 'accept it as it is and go to the next step' });
  const ru = haltQuestion('red', { phase: '5', lang: 'ru' });
  assert.equal(ru.question, 'Фаза 5: тесты остаются красными после одного исправления. Что делать сборке?');
  assert.deepEqual(ru.options.map((o) => o.label), ['Ещё раз', 'Остановить']);
  for (const lang of ['en', 'ru']) {
    for (const kind of HALT_KINDS) assert.doesNotThrow(() => laneQuestion({ ...haltQuestion(kind, { phase: '5', lang }), phase: '5', id: 'ask-1', lang }), `${kind} ${lang}`);
  }
});
