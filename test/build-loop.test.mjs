import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildRig, claudeHome } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { tmpDir } from './helpers/tmp.mjs';
import { adoptRound, openBuild, runStep } from '../lib/build.mjs';
import { askOwner, markDelivered, readQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { clearAttend, writeAttend } from '../lib/attend.mjs';
import { reconcileBuildState } from '../lib/build-queue.mjs';
import { writeOwnerStop } from '../lib/autostart.mjs';

const H = claudeHome();
after(() => H.restore());
const REL = '.planning/phases/05-demo';
const OQ = 'Need you.\n## OWNER QUESTION\nQuestion: Which greeting should the bot use?\nContext: Two styles fit.\nOptions:\n1. Formal — Hello, Ann (recommended)\n2. Casual — Hi, Ann';
const spec = (name, expect) => `const test = require('node:test');\nconst assert = require('node:assert');\ntest('${name}', () => assert.equal(require('../src/${name}.js')(), ${expect}));\n`;
const files = (name, { value = 1, expect = 1 } = {}) => ({ [`src/${name}.js`]: `module.exports = () => ${value};\n`, [`test/${name}.test.js`]: spec(name, expect) });
const plan = (id, name, o = {}) => compactPlan({ id, files: [`src/${name}.js`, `test/${name}.test.js`], ...o });
const FOUR = {
  '05-01': plan('05-01', 'a'),
  '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }),
  '05-03': plan('05-03', 'c', { wave: 2, deps: ['05-02'] }),
  '05-04': plan('05-04', 'd'),
};
const BUILT = { '05-01': { files: files('a') }, '05-02': { files: files('b') }, '05-03': { files: files('c') }, '05-04': { files: files('d') } };

// A build project with these plans committed and adopted as the round's slices; ctx released after the test.
async function loopRig(t, { plans = FOUR, slices = BUILT, config = {}, script = {}, before = null } = {}) {
  const r = await buildRig({ project: { config }, script: { slices, ...script } });
  for (const [id, text] of Object.entries(plans)) r.write(`${REL}/${id}-PLAN.md`, text);
  r.commit('docs: plans');
  if (before) before(r);
  const ctx = await openBuild(r.root, '5', { deps: r.deps });
  t.after(() => ctx.release());
  ctx.state.base = r.git('rev-parse', 'HEAD');
  adoptRound(ctx, { round: 0 });
  return { ...r, ctx };
}

// Calls fn every 15 ms until it returns true (or the test ends).
function every(t, fn) {
  const timer = setInterval(() => {
    try {
      if (fn()) clearInterval(timer);
    } catch { /* a git lock: again next time */ }
  }, 15);
  t.after(() => clearInterval(timer));
}
const answer = (root, id, option) => answerQuestion({ root, phase: '5', id, option, by: 'pane', laneRunning: true });
const openCard = (root) => readQuestions(root, '5').find((q) => q.state === 'open');
const read = (r, rel) => fs.readFileSync(path.join(r.root, ...rel.split('/')), 'utf8');
const merges = (r) => Number(r.git('rev-list', '--merges', '--count', 'HEAD'));

test('slices run in parallel and an owner question holds only its dependents', async (t) => {
  const r = await loopRig(t, { slices: { ...BUILT, '05-02': { files: files('b'), ask: OQ } } });
  const { root, ctx } = r;
  let answeredAt = null;
  let statusSeen = null;
  every(t, () => {
    statusSeen ??= readLaneStatus(root, '5');
    const s = ctx.state.slices;
    if (answeredAt || s['05-01'].state !== 'merged' || s['05-04'].state !== 'merged' || openCard(root)?.id !== 'ask-1') return false;
    answer(root, 'ask-1', 1);
    answeredAt = Date.now();
    return false;
  });
  assert.equal(await runStep(ctx, 'build'), 'done');
  const s = ctx.state.slices;
  for (const id of ['05-01', '05-04']) assert.ok(Date.parse(s[id].at.dispatched) < answeredAt, `${id} ran while the card waited`);
  assert.ok(Date.parse(s['05-03'].at.dispatched) >= Date.parse(s['05-02'].at.merged));
  const first = s['05-02'].sessions[0].id;
  assert.ok(r.f.calls().some((c) => c.argv.slice(-2).join(' ') === `--resume ${first}`));
  assert.deepEqual(Object.values(s).map((x) => [x.state, x.tests]), Array(4).fill(['merged', 'green']));
  assert.equal(merges(r), 4);
  assert.equal(statusSeen, null);
  assert.equal(readLaneStatus(root, '5'), null);
  assert.deepEqual(readQuestions(root, '5').map((q) => [q.id, q.state, q.held]), [['ask-1', 'delivered', true]]);
});

test('a red merge stops new slices; one fixer fixes it; the retest clears it', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }) };
  const r = await loopRig(t, {
    plans,
    config: { build: { max_builders: 1 } },
    slices: { '05-01': { files: files('a', { value: 1, expect: 2 }) }, '05-02': { files: files('b') } },
    script: { fixes: [{ files: { 'src/a.js': 'module.exports = () => 2;\n' }, message: 'fix(05): the red test', result: 'fixed' }] },
  });
  let seen = null;
  every(t, () => {
    if (r.ctx.state.red?.after === '05-01') seen = r.ctx.state.slices['05-02'].state;
    return seen !== null;
  });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.equal(seen, 'waiting');
  const fixer = r.f.calls().filter((c) => c.stdin.startsWith('You are the fixer'));
  assert.equal(fixer.length, 1);
  assert.match(fixer[0].stdin, /is the output of tests that failed after a merge/);
  assert.equal(r.ctx.state.red, null);
  assert.equal(r.ctx.state.slices['05-02'].state, 'merged');
  assert.equal(r.a.acts().filter((x) => x.role === 'fixer').length, 1);
});

test('red after the fix stops for the owner', async (t) => {
  const r = await loopRig(t, {
    plans: { '05-01': plan('05-01', 'a') },
    slices: { '05-01': { files: files('a', { value: 1, expect: 2 }) } },
    script: { fixes: [{ files: {}, result: 'nothing to change' }] },
  });
  every(t, () => {
    const q = openCard(r.root);
    if (!q) return false;
    assert.equal(q.held, true);
    assert.match(q.question, /the tests stay red after one fix/);
    answer(r.root, q.id, 2);
    return true;
  });
  assert.equal(await runStep(r.ctx, 'build'), 'stopped');
  const st = readLaneStatus(r.root, '5');
  assert.deepEqual([st.status, st.reason], ['failed', 'phase 5 build stopped at step build: the tests stay red after one fix']);
  assert.equal(r.ctx.state.red.tries, 1, 'the fix round the status line shows');
  // the next run (turbo-run resume 5) tries the step afresh: one more fixer, then a new card
  r.a.set({ fixes: [{ files: {}, result: 'nothing to change' }] });
  every(t, () => {
    const q = openCard(r.root);
    if (!q) return false;
    answer(r.root, q.id, 2);
    return true;
  });
  assert.equal(await runStep(r.ctx, 'build'), 'stopped');
  assert.deepEqual(readQuestions(r.root, '5').map((q) => q.id).sort(), ['ask-1', 'ask-2']);
  assert.equal(r.a.acts().filter((x) => x.role === 'fixer').length, 2);
  assert.equal(r.ctx.state.red.tries, 2);
});

test('a red a later, unmerged, test-editing slice will fix is deferred, not halted', async (t) => {
  // 05-01 changes its source to a new value; the test that 05-02 will update still expects the old value -> red after
  // 05-01 merges, and the fixer (scoped to 05-01 = src/a.js) cannot touch the test. 05-02 edits test/a.test.js to the
  // new value -> green. No owner card; the phase finishes.
  const r = await loopRig(t, {
    plans: {
      '05-01': compactPlan({ id: '05-01', files: ['src/a.js'] }),
      '05-02': compactPlan({ id: '05-02', files: ['test/a.test.js'], deps: ['05-01'] }),
    },
    config: { build: { max_builders: 1 } },
    slices: {
      '05-01': { files: { 'src/a.js': 'module.exports = () => 2;\n' } },
      '05-02': { files: { 'test/a.test.js': spec('a', 2) } },
    },
    script: { fixes: [{ files: {}, result: 'nothing to change' }] },
    before: (r) => {
      r.write('src/a.js', 'module.exports = () => 1;\n');
      r.write('test/a.test.js', spec('a', 1));
      r.commit('feat: a is green at the phase base');
    },
  });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.deepEqual(readQuestions(r.root, '5').map((q) => q.id), [], 'no owner card was raised');
  const s = r.ctx.state.slices;
  assert.deepEqual([s['05-01'].state, s['05-01'].tests], ['merged', 'green']);
  assert.deepEqual([s['05-02'].state, s['05-02'].tests], ['merged', 'green']);
  assert.equal(r.ctx.state.red, null);
  assert.equal(r.ctx.state.pendingRed ?? null, null, 'the deferred red was cleared');
});

// The deferred red, after the live run of 2026-11-11 (a phase where three slices each break suites that three later
// slices migrate). The phase base has src/<name>.js returning 1 and its test expecting 1.
const greenBase = (...names) => (r) => {
  for (const n of names) for (const [f, text] of Object.entries(files(n))) r.write(f, text);
  r.commit('feat: green at the phase base');
};
const src = (name, value) => ({ [`src/${name}.js`]: `module.exports = () => ${value};\n` });
const fixerActs = (r) => r.a.acts().filter((x) => x.role === 'fixer').length;
const logOf = (r) => fs.readFileSync(path.join(r.root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8');
// Stop here (the last option) on every card, so a build that asks ends instead of waiting. -> the questions asked
function stopOnCard(t, r) {
  const asked = [];
  every(t, () => {
    const q = openCard(r.root);
    if (!q) return false;
    asked.push(q.question);
    answer(r.root, q.id, q.options.length);
    return false;
  });
  return asked;
}

// the live defect: a restart while the branch was red merged two finished slices untested; the retest was deferred,
// nothing could be dispatched in that pass (a merged slice not yet tested holds the queue), and the loop read "nothing
// in flight" as "no slice left": it took the deferred red back and started a fixer with no test output (a crash, the
// supervisor's relaunch, the same again)
test('after a restart with slices merged untested, a deferred red waits for the slices ahead', async (t) => {
  const r = await loopRig(t, {
    plans: {
      '05-01': compactPlan({ id: '05-01', files: ['src/a.js'] }),
      '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }),
      '05-03': plan('05-03', 'c', { reqs: ['DEMO-03'] }),
      '05-04': compactPlan({ id: '05-04', files: ['test/a.test.js'], deps: ['05-01'], reqs: ['DEMO-04'] }),
    },
    slices: {
      '05-01': { files: src('a', 2) },
      '05-02': { files: files('b'), delayMs: 3000 },
      '05-03': { files: files('c'), delayMs: 3000 },
      '05-04': { files: { 'test/a.test.js': spec('a', 2) } },
    },
    script: { fixes: [{ files: {}, result: 'nothing to change' }] },
    before: greenBase('a'),
  });
  // the owner sits down right after 05-01's merge: its tests turn the branch red, 05-02 and 05-03 finish and wait
  r.ctx.deps.checkpoint = (n) => {
    if (n === 'merged:05-01') writeAttend(r.root, '5');
  };
  assert.equal(await runStep(r.ctx, 'build'), 'paused');
  assert.equal(r.ctx.state.red.after, '05-01');
  assert.deepEqual(['05-02', '05-03'].map((id) => r.ctx.state.slices[id].state), ['running', 'running']);
  // turbo-run build 5 --resume (lib/build.mjs resumeState): the hold ends, the reconcile merges the finished slices
  clearAttend(r.root, '5');
  r.ctx.deps.checkpoint = () => {};
  r.ctx.state.hold = null;
  r.ctx.save();
  r.ctx.state = reconcileBuildState(r.root, r.ctx.runDir, '5', { alive: () => false, now: r.ctx.deps.now() }).state;
  assert.deepEqual(['05-02', '05-03'].map((id) => [r.ctx.state.slices[id].state, r.ctx.state.slices[id].tests]), [['merged', null], ['merged', null]]);
  const asked = stopOnCard(t, r);
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.deepEqual(asked, [], 'no owner card');
  assert.equal(fixerActs(r), 1, 'the one fixer of the first red; none for the deferred red');
  assert.deepEqual(Object.values(r.ctx.state.slices).map((x) => [x.state, x.tests]), Array(4).fill(['merged', 'green']));
  assert.deepEqual([r.ctx.state.red, r.ctx.state.pendingRed ?? null], [null, null]);
});

// test-changed --merge runs what one merge's files reach: its green says nothing of the tests put off
test('a green run of an unrelated merge does not clear the deferred red: the phase is tested as it stands at the end', async (t) => {
  const r = await loopRig(t, {
    plans: {
      // a green slice first: the full green run the later, targeted runs start from
      '05-01': plan('05-01', 'z'),
      '05-02': compactPlan({ id: '05-02', files: ['src/a.js'], deps: ['05-01'], reqs: ['DEMO-02'] }),
      '05-03': plan('05-03', 'b', { reqs: ['DEMO-03'] }),
      // built on the breaker and changes an existing test, but not the red one
      '05-04': plan('05-04', 'c', { deps: ['05-02'], reqs: ['DEMO-04'] }),
    },
    config: { build: { max_builders: 1 } },
    slices: { '05-01': { files: files('z') }, '05-02': { files: src('a', 2) }, '05-03': { files: files('b') }, '05-04': { files: files('c', { value: 3, expect: 3 }) } },
    script: { fixes: [{ files: {}, result: 'nothing to change' }, { files: src('a', 1), message: 'fix(05): a as its test wants it', result: 'fixed' }] },
    before: greenBase('a', 'c'),
  });
  const asked = stopOnCard(t, r);
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.deepEqual(asked, [], 'no owner card');
  assert.match(logOf(r), /no slice left to clear the deferred red/);
  const fixer = r.f.calls().filter((c) => c.stdin.startsWith('You are the fixer'));
  assert.equal(fixer.length, 2, 'the first red\'s fixer, and one more when no slice was left to fix it');
  assert.match(fixer[1].stdin, /tests-retest-\d+\.log is the output of tests that failed after a merge/);
  assert.ok(fixer[1].stdin.includes('Change only the files of slice 05-02: src/a.js.'), fixer[1].stdin);
  assert.equal(read(r, 'src/a.js'), 'module.exports = () => 1;\n');
  assert.deepEqual(Object.values(r.ctx.state.slices).map((x) => [x.state, x.tests]), Array(4).fill(['merged', 'green']));
  assert.deepEqual([r.ctx.state.red, r.ctx.state.pendingRed ?? null], [null, null]);
});

test('a second planned break joins the deferred red without a fixer round or a card', async (t) => {
  const r = await loopRig(t, {
    plans: {
      '05-01': compactPlan({ id: '05-01', files: ['src/a.js'] }),
      '05-02': compactPlan({ id: '05-02', files: ['src/b.js'], reqs: ['DEMO-02'] }),
      '05-03': compactPlan({ id: '05-03', files: ['test/a.test.js', 'test/b.test.js'], deps: ['05-01', '05-02'], reqs: ['DEMO-03'] }),
    },
    config: { build: { max_builders: 1 } },
    slices: {
      '05-01': { files: src('a', 2) },
      '05-02': { files: src('b', 2) },
      '05-03': { files: { 'test/a.test.js': spec('a', 2), 'test/b.test.js': spec('b', 2) } },
    },
    script: { fixes: [{ files: {}, result: 'nothing to change' }] },
    before: greenBase('a', 'b'),
  });
  const asked = stopOnCard(t, r);
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.deepEqual(asked, [], 'no owner card');
  assert.equal(fixerActs(r), 1, 'the first break\'s fixer only');
  assert.match(logOf(r), /tests red after 05-02 \(.*\): a slice ahead is built on 05-02 and edits tests; put off until no slice ahead edits tests/);
  assert.deepEqual(Object.values(r.ctx.state.slices).map((x) => [x.state, x.tests]), Array(3).fill(['merged', 'green']));
  assert.deepEqual([r.ctx.state.red, r.ctx.state.pendingRed ?? null], [null, null]);
});

// a merge's tests run on the branch as it stands: after a restart several merges wait for their tests at once, and the
// run of the first is red by a later one's planned break too
test('after a crash, a red found while other merges wait for their tests is told by their planned breaks too', async (t) => {
  const r = await loopRig(t, {
    plans: {
      '05-01': compactPlan({ id: '05-01', files: ['src/a.js'] }),
      '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }),
      '05-03': compactPlan({ id: '05-03', files: ['src/c.js'], reqs: ['DEMO-03'] }),
      '05-04': compactPlan({ id: '05-04', files: ['test/a.test.js', 'test/c.test.js'], deps: ['05-01', '05-03'], reqs: ['DEMO-04'] }),
    },
    slices: {
      '05-01': { files: src('a', 2) },
      // 05-02 ends well before 05-03: it is merged first
      '05-02': { files: files('b'), delayMs: 1500 },
      '05-03': { files: src('c', 2), delayMs: 5000 },
      '05-04': { files: { 'test/a.test.js': spec('a', 2), 'test/c.test.js': spec('c', 2) } },
    },
    script: { fixes: [{ files: {}, result: 'nothing to change' }] },
    before: greenBase('a', 'c'),
  });
  // the red after 05-01 is put off; 05-02 is merged and the build dies before its tests, 05-03 built and not merged
  r.ctx.deps.checkpoint = (n) => {
    if (n === 'merged:05-02') throw new Error('crash');
  };
  await assert.rejects(runStep(r.ctx, 'build'), /crash/);
  assert.equal(r.ctx.state.pendingRed.after, '05-01');
  assert.equal(r.ctx.state.slices['05-03'].state, 'running');
  r.ctx.release();
  // turbo-run build 5 --resume: the reconcile merges 05-03; 05-02's tests then run with 05-03's break in the branch
  const ctx = await openBuild(r.root, '5', { resume: true, deps: { ...r.deps, checkpoint: () => {} } });
  t.after(() => ctx.release());
  ctx.state = reconcileBuildState(r.root, ctx.runDir, '5', { alive: () => false, now: ctx.deps.now() }).state;
  assert.deepEqual(['05-02', '05-03'].map((id) => [ctx.state.slices[id].state, ctx.state.slices[id].tests]), [['merged', null], ['merged', null]]);
  const asked = stopOnCard(t, r);
  assert.equal(await runStep(ctx, 'build'), 'done');
  assert.deepEqual(asked, [], 'no owner card');
  assert.equal(fixerActs(r), 1, 'no fixer for 05-02: the new red test is 05-03\'s planned break');
  assert.match(logOf(r), /tests red after 05-02 \(.*\): a slice ahead is built on 05-03 and edits tests; put off/);
  assert.deepEqual(Object.values(ctx.state.slices).map((x) => [x.state, x.tests]), Array(4).fill(['merged', 'green']));
  assert.deepEqual([ctx.state.red, ctx.state.pendingRed ?? null], [null, null]);
});

test('a new break no slice ahead is built on gets its fixer and the owner\'s card, deferred red or not', async (t) => {
  const r = await loopRig(t, {
    plans: {
      '05-01': compactPlan({ id: '05-01', files: ['src/a.js'] }),
      '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }),
      '05-03': compactPlan({ id: '05-03', files: ['test/a.test.js'], deps: ['05-01'], reqs: ['DEMO-03'] }),
    },
    config: { build: { max_builders: 1 } },
    slices: {
      '05-01': { files: src('a', 2) },
      '05-02': { files: files('b', { value: 1, expect: 2 }) },
      '05-03': { files: { 'test/a.test.js': spec('a', 2) } },
    },
    script: { fixes: [{ files: {}, result: 'nothing to change' }, { files: {}, result: 'nothing to change' }] },
    before: greenBase('a'),
  });
  const asked = stopOnCard(t, r);
  assert.equal(await runStep(r.ctx, 'build'), 'stopped');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /the tests stay red after one fix/);
  const fixer = r.f.calls().filter((c) => c.stdin.startsWith('You are the fixer'));
  assert.equal(fixer.length, 2);
  assert.ok(fixer[1].stdin.includes('Change only the files of slice 05-02: src/b.js, test/b.test.js.'), fixer[1].stdin);
  // the tests put off are not this slice's: its fixer is told only what its merge turned red
  assert.ok(fixer[1].stdin.includes('The merge of slice 05-02 turned these tests red: "b", "test/b.test.js > b".'), fixer[1].stdin);
  assert.equal(r.ctx.state.red.after, '05-02');
  assert.equal(r.ctx.state.pendingRed.after, '05-01', 'the planned break stays deferred');
  assert.equal(r.ctx.state.slices['05-03'].state, 'waiting', 'nothing new started while red');
});

// where every merge runs the whole suite, every merge is red by the tests put off: a join that waited for the running
// builders gave one merge per builder session
test('a red that joins the deferred red does not wait for the running builders: the free seat is filled at once', async (t) => {
  const marker = path.join(tmpDir('seat'), 'next-dispatched');
  const r = await loopRig(t, {
    plans: {
      '05-01': compactPlan({ id: '05-01', files: ['src/a.js'] }),
      '05-02': plan('05-02', 'b', { deps: ['05-01'], reqs: ['DEMO-02'] }),
      '05-03': plan('05-03', 'c', { deps: ['05-01'], reqs: ['DEMO-03'] }),
      '05-04': plan('05-04', 'd', { deps: ['05-01'], reqs: ['DEMO-04'] }),
      '05-05': compactPlan({ id: '05-05', files: ['test/a.test.js'], deps: ['05-02', '05-03', '05-04'], reqs: ['DEMO-05'] }),
    },
    config: { build: { max_builders: 2 } },
    slices: {
      '05-01': { files: src('a', 2) },
      '05-02': { files: files('b') },
      // builds until 05-04 is dispatched: that needs the seat 05-02 left, while the branch is red by the test put off
      '05-03': { files: files('c'), waitFor: marker },
      '05-04': { files: files('d') },
      '05-05': { files: { 'test/a.test.js': spec('a', 2) } },
    },
    script: { fixes: [{ files: {}, result: 'nothing to change' }] },
    before: greenBase('a'),
  });
  every(t, () => {
    if (r.ctx.state.slices['05-04'].state === 'waiting') return false;
    fs.writeFileSync(marker, '');
    return true;
  });
  const asked = stopOnCard(t, r);
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.deepEqual(asked, [], 'no owner card');
  assert.equal(fs.existsSync(`${marker}.capped`), false, '05-04 was dispatched while 05-03 was still building');
  assert.deepEqual(Object.values(r.ctx.state.slices).map((x) => [x.state, x.tests]), Array(5).fill(['merged', 'green']));
});

// «edits a test» means: changes a test that exists. A slice that only adds its own new test file fixes nobody's red.
test('a slice ahead that only adds a test of its own makes no break planned: the fixer, then the owner\'s card', async (t) => {
  const r = await loopRig(t, {
    plans: {
      '05-01': compactPlan({ id: '05-01', files: ['src/a.js'] }),
      // built on the breaker, with a new test file of its own
      '05-02': plan('05-02', 'b', { deps: ['05-01'], reqs: ['DEMO-02'] }),
    },
    config: { build: { max_builders: 1 } },
    slices: { '05-01': { files: src('a', 2) }, '05-02': { files: files('b') } },
    script: { fixes: [{ files: {}, result: 'nothing to change' }] },
    before: greenBase('a'),
  });
  const asked = stopOnCard(t, r);
  assert.equal(await runStep(r.ctx, 'build'), 'stopped');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /the tests stay red after one fix/);
  assert.equal(fixerActs(r), 1);
  assert.equal(r.ctx.state.pendingRed ?? null, null, 'nothing was put off');
  assert.equal(r.ctx.state.slices['05-02'].state, 'waiting', 'nothing new started while red');
});

test('a run red as a whole (no failing test to tell it by) is never deferred', async (t) => {
  const r = await loopRig(t, {
    plans: {
      '05-01': compactPlan({ id: '05-01', files: ['src/boom.js'] }),
      // changes an existing test and is built on 05-01: by its tests alone the break would count as planned
      '05-02': compactPlan({ id: '05-02', files: ['test/a.test.js'], deps: ['05-01'], reqs: ['DEMO-02'] }),
    },
    config: { build: { max_builders: 1 }, test: { full: 'node tests.cjs' } },
    slices: { '05-01': { files: { 'src/boom.js': 'module.exports = 1;\n' } }, '05-02': { files: { 'test/a.test.js': spec('a', 2) } } },
    script: { fixes: [{ files: {}, result: 'nothing to change' }] },
    before: (r) => {
      // the project's test command: once src/boom.js is there it ends with exit code 3 and names no test
      r.write('tests.cjs', "process.exit(require('node:fs').existsSync('src/boom.js') ? 3 : 0);\n");
      r.write('test/a.test.js', spec('a', 1));
      r.commit('test: a test command that crashes with src/boom.js');
    },
  });
  const asked = stopOnCard(t, r);
  assert.equal(await runStep(r.ctx, 'build'), 'stopped');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /the tests stay red after one fix/);
  assert.equal(r.ctx.state.pendingRed ?? null, null);
  assert.equal(r.ctx.state.slices['05-02'].state, 'waiting', 'nothing new started while red');
});

test('a pause or a stop while the tests are red ends with merges still queued', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }) };
  const slices = { '05-01': { files: files('a', { value: 1, expect: 2 }) }, '05-02': { files: files('b'), delayMs: 3000 } };
  // attend while red and 05-02 still builds: 05-02 finishes, waits for its merge, and the build pauses (no fixer)
  const a = await loopRig(t, { plans, slices });
  // the attend mark right after 05-01's merge, before its tests turn the branch red (no race with the fixer)
  a.ctx.deps.checkpoint = (n) => {
    if (n === 'merged:05-01') writeAttend(a.root, '5');
  };
  assert.equal(await runStep(a.ctx, 'build'), 'paused');
  assert.equal(a.ctx.state.slices['05-02'].state, 'running');
  assert.equal(a.a.acts().filter((x) => x.role === 'fixer').length, 0);
  // Stop here on the red card while 05-02 waits for its merge: the step stops
  const s = await loopRig(t, { plans, slices, script: { fixes: [{ files: {}, result: 'nothing to change' }] } });
  every(t, () => {
    const q = openCard(s.root);
    if (!q) return false;
    answer(s.root, q.id, 2);
    return true;
  });
  assert.equal(await runStep(s.ctx, 'build'), 'stopped');
});

test('a slice built again gets the answer it took before in its prompt', async (t) => {
  const r = await loopRig(t, { plans: { '05-01': plan('05-01', 'a') }, slices: { '05-01': { files: files('a') } } });
  const q = askOwner(r.root, '5', { question: 'Which greeting should the bot use?', context: '', options: [{ label: 'Formal', description: 'Hello, Ann' }, { label: 'Casual', description: 'Hi, Ann' }], recommended: 1 }, { keepRunning: true }).question;
  answer(r.root, q.id, 2);
  markDelivered(r.root, '5', q.id, 'lane');
  r.ctx.state.slices['05-01'].answered = [q.id];
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  const builder = r.f.calls().find((c) => c.stdin.startsWith('You are a builder'));
  assert.match(builder.stdin, /## Owner answers given ahead/);
  assert.match(builder.stdin, /Which greeting should the bot use\?/);
  assert.match(builder.stdin, /option 2, Casual — Hi, Ann/);
});

test('a merge conflict rebuilds the slice once from the new HEAD, then asks the owner', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-04': plan('05-04', 'd') };
  const shared = (id, delayMs = 0) => ({ files: { ...files(id === '05-01' ? 'a' : 'd'), 'src/shared.js': `module.exports = '${id}';\n` }, delayMs });
  const r = await loopRig(t, { plans, slices: { '05-01': shared('05-01'), '05-04': shared('05-04', 300) } });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  const s = r.ctx.state.slices;
  const again = Object.keys(s).find((id) => s[id].rebuilds === 1);
  assert.ok(again, JSON.stringify(s));
  assert.match(s[again].salvage[0], /^turbo-salvage\/05-0[14]-\d{8}T\d{6}Z$/);
  assert.equal(r.git('branch', '--list', s[again].salvage[0]).trim().replace(/^\*?\s*/, ''), s[again].salvage[0]);
  assert.deepEqual(Object.values(s).map((x) => x.state), ['merged', 'merged']);

  const r2 = await loopRig(t, { plans, slices: { '05-01': shared('05-01', 800), '05-04': shared('05-04', 800) } });
  let moved = false;
  every(t, () => {
    const x = Object.values(r2.ctx.state.slices).find((y) => y.rebuilds === 1);
    // dispatched until its session starts, then running while the fake act waits before it writes
    if (!moved && ['dispatched', 'running'].includes(x?.state)) {
      r2.write('src/shared.js', "module.exports = 'main';\n");
      r2.commit('feat: shared on the phase branch');
      moved = true;
    }
    const q = moved && openCard(r2.root);
    if (!q) return false;
    assert.match(q.question, /one part of the work did not get built/);
    answer(r2.root, q.id, 2);
    return true;
  });
  assert.equal(await runStep(r2.ctx, 'build'), 'stopped');
});

test('a failed builder gets one fresh try, then the owner', async (t) => {
  const plans = { '05-01': plan('05-01', 'a') };
  const r = await loopRig(t, { plans, slices: { '05-01': { files: files('a'), fail: 1 } } });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.deepEqual([r.ctx.state.slices['05-01'].retries, r.ctx.state.slices['05-01'].state], [1, 'merged']);

  const r2 = await loopRig(t, { plans, slices: { '05-01': { files: files('a'), fail: 2 } } });
  every(t, () => {
    const q = openCard(r2.root);
    if (!q) return false;
    assert.match(q.question, /one part of the work did not get built after two tries/);
    answer(r2.root, q.id, 2);
    return true;
  });
  assert.equal(await runStep(r2.ctx, 'build'), 'stopped');
  // Stop here leaves no answered card behind: the next run builds the slice afresh (its third try succeeds)
  assert.equal(await runStep(r2.ctx, 'build'), 'done');
  assert.equal(r2.ctx.state.slices['05-01'].state, 'merged');
  assert.equal(r2.a.acts().filter((x) => x.role === 'builder').length, 3);
});

test('a builder blocked for a file no unmerged slice lists: the slice takes it and is built again, once (B5 A/B)', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b') };
  const shared = { ...files('a'), 'src/shared.js': 'module.exports = 2;\n' };
  const r = await loopRig(t, { plans, slices: { '05-01': { files: shared, blocked: 'src/shared.js' }, '05-02': { files: files('b') } } });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  const s = r.ctx.state.slices['05-01'];
  assert.equal(s.state, 'merged');
  assert.deepEqual(s.widened, ['src/shared.js']);
  assert.match(read(r, `${REL}/05-01-PLAN.md`), /^files_modified: \[src\/a\.js, test\/a\.test\.js, src\/shared\.js\]$/m);
  assert.ok(r.git('log', '--format=%s').split('\n').includes('docs(phase-5): slice 05-01 takes src/shared.js'));
  const builds = r.f.calls().filter((c) => c.stdin.includes('05-01-PLAN.md') && c.stdin.includes('You may create, change or delete only:'));
  assert.equal(builds.length, 2);
  assert.ok(!builds[0].stdin.includes('src/shared.js') && builds[1].stdin.includes('src/shared.js'));
  assert.deepEqual(readQuestions(r.root, '5'), []);
  assert.equal(read(r, 'src/shared.js'), 'module.exports = 2;\n');
});

test('a builder blocked for a file another unmerged slice lists, or GSD\'s own: the plan stays; one retry, then the owner', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b', { wave: 2, deps: ['05-01'] }) };
  for (const needed of ['src/b.js', '.planning/STATE.md']) {
    const r = await loopRig(t, { plans, slices: { '05-01': { files: files('a'), blocked: needed, blockedTimes: 2 }, '05-02': { files: files('b') } } });
    every(t, () => {
      const q = openCard(r.root);
      if (!q) return false;
      answer(r.root, q.id, 2);
      return true;
    });
    assert.equal(await runStep(r.ctx, 'build'), 'stopped', needed);
    assert.equal(r.ctx.state.slices['05-01'].widened, undefined, needed);
    assert.equal(read(r, `${REL}/05-01-PLAN.md`), plans['05-01'], needed);
    assert.equal(r.a.acts().filter((x) => x.role === 'builder' && x.plan === '05-01').length, 2, needed);
  }
});

test('a slice without its SUMMARY is told once in the same session', async (t) => {
  const r = await loopRig(t, { plans: { '05-01': plan('05-01', 'a') }, slices: { '05-01': { files: files('a'), noSummary: 1 } } });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  const resumed = r.f.calls().find((c) => c.argv.includes('--resume'));
  assert.ok(resumed.stdin.startsWith(`The merge found: no ${REL}/05-01-SUMMARY.md on turbo-build/05-01. Finish the slice:`), resumed.stdin);
  assert.equal(resumed.argv.at(-1), r.ctx.state.slices['05-01'].sessions[0].id);
  assert.equal(r.ctx.state.slices['05-01'].state, 'merged');
});

test('attend and stop pause the queue: running slices finish and merge, nothing new starts', async (t) => {
  const plans = { ...FOUR, '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'], wave: 2, deps: ['05-01'] }), '05-03': plan('05-03', 'c') };
  const slices = { ...BUILT, '05-01': { files: files('a'), delayMs: 1500 } };
  for (const how of ['attend', 'stop']) {
    const r = await loopRig(t, { plans, slices, config: { build: { max_builders: 1 } } });
    every(t, () => {
      if (!['dispatched', 'running'].includes(r.ctx.state.slices['05-01'].state)) return false;
      if (how === 'attend') writeAttend(r.root, '5');
      else writeOwnerStop(r.root);
      return true;
    });
    assert.equal(await runStep(r.ctx, 'build'), 'paused', how);
    assert.equal(r.ctx.state.hold.reason, how);
    const s = r.ctx.state.slices;
    assert.equal(s['05-01'].state, 'merged');
    assert.deepEqual(['05-02', '05-03', '05-04'].map((id) => s[id].state), ['waiting', 'waiting', 'waiting']);
  }
  const old = await loopRig(t, { plans, slices: BUILT, before: (r) => writeOwnerStop(r.root, new Date(Date.now() - 60000).toISOString()) });
  assert.equal(await runStep(old.ctx, 'build'), 'done');
  assert.equal(old.ctx.state.hold, null);
});

// v0.6.1 (A/B on a real phase: a test red on the base made an unrelated merge red, and the fixer edited another
// slice's files): a merge is red only by the tests it turned red; the fixer works within the slice that turned them red
const OLD_RED = { 'test/old.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\ntest('old is red', () => assert.equal(1, 2));\n" };
const redBase = (r) => {
  for (const [f, text] of Object.entries(OLD_RED)) r.write(f, text);
  r.commit('test: a test that is red before the phase');
};

test('a test red at the phase base makes no merge red: no fixer, every slice merged green', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }) };
  const r = await loopRig(t, { plans, slices: { '05-01': { files: files('a') }, '05-02': { files: files('b') } }, before: redBase });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.equal(r.a.acts().filter((x) => x.role === 'fixer').length, 0);
  assert.deepEqual(Object.values(r.ctx.state.slices).map((s) => [s.state, s.tests]), [['merged', 'green'], ['merged', 'green']]);
  const base = r.ctx.state.baseRed;
  assert.deepEqual([base.sha, base.known, base.tests], [r.ctx.state.base, true, ['old is red', 'test/old.test.js > old is red']]);
  const log = fs.readFileSync(path.join(r.root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8');
  assert.match(log, /tests after 05-0[12]: only tests red at the phase base already failed \(old is red; test\/old\.test\.js > old is red\); the merge counts green/);
  assert.equal((log.match(/the tests at the phase base [0-9a-f]{7} run once/g) ?? []).length, 1, 'the base runs once a phase');
  // the base's worktree is gone
  assert.ok(!r.git('worktree', 'list').includes('base-p5'));
});

test('with a red base, the fixer of a red merge gets only the tests it turned red and its slice\'s files', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }) };
  const r = await loopRig(t, {
    plans,
    config: { build: { max_builders: 1 } },
    slices: { '05-01': { files: files('a', { value: 1, expect: 2 }) }, '05-02': { files: files('b') } },
    script: { fixes: [{ files: { 'src/a.js': 'module.exports = () => 2;\n' }, message: 'fix(05): the red test', result: 'fixed' }] },
    before: redBase,
  });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  const fixer = r.f.calls().filter((c) => c.stdin.startsWith('You are the fixer'));
  assert.equal(fixer.length, 1);
  assert.ok(fixer[0].stdin.includes('The merge of slice 05-01 turned these tests red: "a", "test/a.test.js > a". Other failures in the output were red before this phase: leave them alone.'), fixer[0].stdin);
  assert.ok(fixer[0].stdin.includes('Change only the files of slice 05-01: src/a.js, test/a.test.js. Code checks your commits against that list'), fixer[0].stdin);
  assert.ok(!fixer[0].stdin.includes('"old is red"'));
  assert.equal(r.ctx.state.red, null, 'the retest is green but for the base\'s red test');
  assert.deepEqual(Object.values(r.ctx.state.slices).map((s) => s.state), ['merged', 'merged']);
});

test('a fixer that changes another slice\'s file is refused: its commits set aside, the owner asked', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }) };
  const r = await loopRig(t, {
    plans,
    config: { build: { max_builders: 1 } },
    slices: { '05-01': { files: files('a', { value: 1, expect: 2 }) }, '05-02': { files: files('b') } },
    script: { fixes: [{ files: { 'src/a.js': 'module.exports = () => 2;\n', 'src/b.js': 'module.exports = () => 9;\n' }, message: 'fix(05): the red test', result: 'fixed' }] },
  });
  let fixBase = null;
  every(t, () => {
    fixBase ??= r.ctx.state.red?.fixBase ?? null;
    const q = openCard(r.root);
    if (!q) return false;
    assert.match(q.question, /fixing the tests one part of the work turned red needed changes outside that part/);
    answer(r.root, q.id, 3); // Stop here (2 keeps the fix)
    return true;
  });
  assert.equal(await runStep(r.ctx, 'build'), 'stopped');
  const red = r.ctx.state.red;
  assert.deepEqual(red.scope, ['src/b.js']);
  assert.equal(r.git('rev-parse', 'HEAD'), fixBase, 'the fixer\'s commit is off the phase branch');
  assert.match(red.setAside[0], /^turbo-salvage\/fix-05-01-\d{8}T\d{6}Z$/);
  assert.equal(r.git('log', '-1', '--format=%s', red.setAside[0]), 'fix(05): the red test');
  assert.equal(fs.existsSync(path.join(r.root, 'src', 'b.js')), false);
  assert.equal(readLaneStatus(r.root, '5').reason, 'phase 5 build stopped at step build: fixing the tests one part of the work turned red needed changes outside that part');
  assert.equal(r.ctx.state.slices['05-02'].state, 'waiting', 'nothing new started while red');
});

test('the owner keeps a fix that went outside the slice: its commits come back and the retest decides', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }) };
  const r = await loopRig(t, {
    plans,
    config: { build: { max_builders: 1 } },
    slices: { '05-01': { files: files('a', { value: 1, expect: 2 }) }, '05-02': { files: files('b') } },
    script: { fixes: [{ files: { 'src/a.js': 'module.exports = () => 2;\n', 'src/shared.js': 'module.exports = 1;\n' }, message: 'fix(05): the red test', result: 'fixed' }] },
  });
  every(t, () => {
    const q = openCard(r.root);
    if (!q) return false;
    answer(r.root, q.id, 2); // Go on: keep that fix
    return true;
  });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.equal(r.ctx.state.red, null);
  assert.ok(r.git('log', '--format=%s').split('\n').includes('fix(05): the red test'), 'the kept fix is on the phase branch');
  assert.equal(read(r, 'src/shared.js'), 'module.exports = 1;\n');
  assert.equal(r.a.acts().filter((x) => x.role === 'fixer').length, 1, 'no second fixer');
  assert.deepEqual(Object.values(r.ctx.state.slices).map((s) => s.state), ['merged', 'merged']);
});

// v0.6.1 (review): a slice a restart's reconcile merged while the fixer's window was open is no fixer's commit, and its
// merge keeps the fixer's commits on the branch (no reset)
test('fixerWindow: the first-parent commits that are no merge; a merge on the line is told', async (t) => {
  const { fixerWindow } = await import('../lib/build.mjs');
  const r = await loopRig(t, { plans: { '05-01': plan('05-01', 'a') } });
  const from = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', '-b', 'side');
  r.write('src/slice.js', 'module.exports = 1;\n');
  r.commit('feat(05-02): a slice commit');
  r.git('checkout', '-q', '-');
  r.write('src/fix.js', 'module.exports = 2;\n');
  r.write('.planning/STATE.md', '# state\n');
  r.commit('fix(05): the fixer');
  r.git('merge', '-q', '--no-ff', '-m', 'chore(phase-5): merge slice 05-02', 'side');
  const w = fixerWindow(r.root, from);
  assert.deepEqual(w.files, ['src/fix.js']);
  assert.equal(w.shas.length, 1);
  assert.equal(w.merges.length, 1);
});

// live run 2026-11-11: a fixer asked the owner whether it may change test files outside its slice, the owner said yes,
// the fixer changed exactly those, and the scope guard set them aside and asked again (ask-8 -> ask-9).
const SCOPE_ASK = 'Need you.\n## OWNER QUESTION\nQuestion: May I update the shared inventory test outside this slice?\nContext: It lists every file; the new one is missing.\nFiles: src/shared.js\nOptions:\n1. Yes — update it (recommended) (grants)\n2. No — leave it red';
const scopeRig = (t, ask = SCOPE_ASK) => loopRig(t, {
  plans: { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }) },
  config: { build: { max_builders: 1 } },
  slices: { '05-01': { files: files('a', { value: 1, expect: 2 }) }, '05-02': { files: files('b') } },
  script: { fixes: [{ ask, files: { 'src/a.js': 'module.exports = () => 2;\n', 'src/shared.js': 'module.exports = 1;\n' }, message: 'fix(05): the red test', result: 'fixed' }] },
});

test('a fixer that asked the owner during its round keeps its changes outside the slice: no second card', async (t) => {
  const plans = { '05-01': plan('05-01', 'a'), '05-02': plan('05-02', 'b', { reqs: ['DEMO-02'] }) };
  const ask = SCOPE_ASK;
  const r = await loopRig(t, {
    plans,
    config: { build: { max_builders: 1 } },
    slices: { '05-01': { files: files('a', { value: 1, expect: 2 }) }, '05-02': { files: files('b') } },
    script: { fixes: [{ ask, files: { 'src/a.js': 'module.exports = () => 2;\n', 'src/shared.js': 'module.exports = 1;\n' }, message: 'fix(05): the red test', result: 'fixed' }] },
  });
  const asked = [];
  every(t, () => {
    const q = openCard(r.root);
    if (!q) return false;
    asked.push(q.question);
    answer(r.root, q.id, 1);
    return true;
  });
  assert.equal(await runStep(r.ctx, 'build'), 'done');
  assert.deepEqual(asked, ['May I update the shared inventory test outside this slice?'], 'only the fixer\'s own question');
  assert.equal(r.ctx.state.red, null);
  assert.equal(read(r, 'src/shared.js'), 'module.exports = 1;\n');
  const log = fs.readFileSync(path.join(r.root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8');
  assert.match(log, /the fixer changed files outside slice 05-01 \(src\/shared\.js\), as the owner allowed in ask-\d+: kept/);
});

// the side check of 2026-11-11: only the option that allows the change counts, and only for the files it names
test('the owner\'s «no», or an allowing option without the file in Files, keeps the scope guard: the fix goes aside', async (t) => {
  for (const [option, ask] of [[2, SCOPE_ASK], [1, SCOPE_ASK.replace('Files: src/shared.js', 'Files: src/other.js')]]) {
    const r = await scopeRig(t, ask);
    const asked = [];
    every(t, () => {
      const q = openCard(r.root);
      if (!q) return false;
      asked.push(q.question);
      // the fixer's question gets the option under test; the guard's card: Stop here (then the poller ends)
      answer(r.root, q.id, asked.length === 1 ? option : 3);
      return asked.length >= 2;
    });
    assert.equal(await runStep(r.ctx, 'build'), 'stopped');
    assert.equal(asked.length, 2, `option ${option}: the guard asked after the fixer's question`);
    assert.deepEqual(r.ctx.state.red.scope, ['src/shared.js']);
    assert.equal(fs.existsSync(path.join(r.root, 'src', 'shared.js')), false, 'the fix is off the phase branch');
  }
});
