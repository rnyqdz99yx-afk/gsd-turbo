import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildRig, claudeHome } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { adoptRound, openBuild, runStep } from '../lib/build.mjs';
import { askOwner, markDelivered, readQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { readLaneStatus } from '../lib/run-status.mjs';
import { writeAttend } from '../lib/attend.mjs';
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
