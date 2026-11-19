import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildRig, claudeHome, summaryText } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { laneProject } from './helpers/lane-merge.mjs';
import { fakeGsdCore } from './helpers/fake-gsd.mjs';
import { ISOLATED } from './helpers/slots.mjs';
import { BUILD_STEPS, openBuild, runBuild, runStep, setStep } from '../lib/build.mjs';
import { readQuestions, askOwner } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { readLaneStatus, writeLaneStatus } from '../lib/run-status.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { mergeFile } from '../lib/merge.mjs';
import { appendInbox, formatInboxMessage } from '../lib/inbox.mjs';
import { recordSessionUsage } from '../lib/cost.mjs';
import { integrateMain, holdFile } from '../lib/integrate.mjs';
import { slotGit } from '../lib/slots.mjs';
import { gsdCoreDir, logsDir, runDir } from '../lib/paths.mjs';
import { runGsdJson } from '../lib/gsd.mjs';
import { gsdText } from '../lib/gates.mjs';

const H = claudeHome();
after(() => H.restore());
const REL = '.planning/phases/05-demo';
const verification = (status) => `---\nphase: 05-demo\nstatus: ${status}\n---\n\n# Verification\n`;
const uatFile = (rows) => ['---', 'status: testing', 'phase: 05-demo', '---', '', '## Tests', '', ...rows.flatMap(([n, name, result]) => [`### ${n}. ${name}`, 'expected: it works', `result: ${result}`, '']), '## Summary', ''].join('\n');

// deps.turbo as a recorder: answers[<first two args>] is { code, out } or a list taken in order (then code 0).
function turboRec(answers = {}) {
  const calls = [];
  const fn = async (args, o = {}) => {
    calls.push({ args, o });
    const a = answers[args.slice(0, 2).join(' ')];
    const pick = Array.isArray(a) ? a.shift() : a;
    const v = typeof pick === 'function' ? pick(args, o) : pick;
    return v ?? { code: 0, out: '' };
  };
  return { fn, calls, args: () => calls.map((c) => c.args) };
}
const json = (o, code = 0) => ({ code, out: JSON.stringify(o) });

async function closeRig(t, { script = {}, turbo = {}, config = {}, setup = null, deps = {} } = {}) {
  const rec = turboRec(turbo);
  const gsdCalls = [];
  const holder = {};
  const gsd = (args, { json = true } = {}) => {
    gsdCalls.push(args);
    const core = gsdCoreDir(holder.root);
    return json ? runGsdJson(core, args, { cwd: holder.root }) : gsdText(core, holder.root, args);
  };
  const r = await buildRig({ project: { config }, script, deps: { turbo: rec.fn, gsd, ...deps } });
  holder.root = r.root;
  if (setup) setup(r);
  const ctx = await openBuild(r.root, '5', { deps: r.deps });
  t.after(() => ctx.release());
  ctx.state.base = r.git('rev-parse', 'HEAD');
  ctx.save();
  return { ...r, ctx, turbo: rec, gsdCalls };
}
function every(t, fn) {
  const timer = setInterval(() => {
    try {
      if (fn()) clearInterval(timer);
    } catch { /* again */ }
  }, 15);
  t.after(() => clearInterval(timer));
}
const answerNext = (t, root, phase, option, seen = []) => {
  every(t, () => {
    const q = readQuestions(root, phase).find((x) => x.state === 'open');
    if (!q) return false;
    seen.push(q);
    answerQuestion({ root, phase, id: q.id, option, by: 'pane', laneRunning: true });
    return true;
  });
  return seen;
};

test('uat: nothing to check by hand when verification passed', async (t) => {
  const r = await closeRig(t, { setup: (x) => { x.write(`${REL}/05-VERIFICATION.md`, verification('passed')); x.commit('docs: v'); } });
  assert.equal(await runStep(r.ctx, 'uat'), 'skipped');
  assert.equal(r.ctx.state.steps.uat.why, 'verification passed: nothing to check by hand');
  assert.deepEqual(r.turbo.calls, []);
  // the owner's Go on at the verify card holds here too
  const g = await closeRig(t, { setup: (x) => { x.write(`${REL}/05-VERIFICATION.md`, verification('gaps_found')); x.commit('docs: v'); } });
  setStep(g.ctx.state, 'verify', { state: 'done', accepted: 'ask-1', acceptedBy: 'pane', acceptedOn: createHash('sha256').update(verification('gaps_found')).digest('hex') });
  assert.equal(await runStep(g.ctx, 'uat'), 'skipped');
  // v0.8.1: who accepted them, and that they stay open (this report lists none in its frontmatter)
  assert.equal(g.ctx.state.steps.uat.why, `verification gaps accepted by the owner (0 goal(s) stay open in ${REL}/05-VERIFICATION.md): nothing to check by hand`);
  // a state an older turbo saved has no record of who answered: never «by the owner» by default
  const old = await closeRig(t, { setup: (x) => { x.write(`${REL}/05-VERIFICATION.md`, verification('gaps_found')); x.commit('docs: v'); } });
  setStep(old.ctx.state, 'verify', { state: 'done', accepted: 'ask-1', acceptedOn: createHash('sha256').update(verification('gaps_found')).digest('hex') });
  assert.equal(await runStep(old.ctx, 'uat'), 'skipped');
  assert.match(old.ctx.state.steps.uat.why, /^verification gaps accepted on its card \(0 goal\(s\) stay open/);
});

test('uat: human_needed runs turbo-uat and the uat commands in the skill\'s order', async (t) => {
  const setup = (x) => {
    x.write(`${REL}/05-VERIFICATION.md`, verification('human_needed'));
    x.write(`${REL}/05-UAT.md`, uatFile([[1, 'the greeting shows', '[pending]'], [2, 'the owner likes it', '[pending]']]));
    x.commit('docs: v and uat');
  };
  const script = { uatResult: { path: `${REL}/05-UAT.md`, text: uatFile([[1, 'the greeting shows', 'pass'], [2, 'the owner likes it', 'pass']]) } };
  const r = await closeRig(t, { script, setup, turbo: { 'uat plan': json({ items: [{ test: 1 }] }), 'uat owner-request': json({ needsOwner: false, sign: [] }) } });
  assert.equal(await runStep(r.ctx, 'uat'), 'done');
  assert.deepEqual(r.turbo.args(), [['uat', 'plan', '5'], ['uat', 'stand', '5', 'cleanup'], ['uat', 'defer', '5', '--rulings'], ['uat', 'owner-request', '5', '--json'], ['uat', 'settle', '5']]);
  const calls = r.f.calls();
  assert.equal(calls[0].argv[calls[0].argv.indexOf('--agent') + 1], 'turbo-uat');
  assert.equal(calls[0].stdin, `Phase 5. Phase directory: ${REL}. Run your procedure and reply with your report.`);
  // B5 A/B: no gsd-verify-work session (its verify:pre and verify:post hooks gate on files the build path does not
  // write); its own canonicalization instead: GSD's UAT predicate, then the report's status
  assert.equal(calls.length, 1);
  const has = (args) => r.gsdCalls.some((a) => JSON.stringify(a) === JSON.stringify(args));
  assert.ok(has(['query', 'uat.complete-session', `${REL}/05-UAT.md`, '--message', 'test(5): complete UAT']));
  assert.ok(has(['phase', 'uat-passed', '5', '--uat-only']));
  assert.ok(has(['query', 'frontmatter.set', `${REL}/05-VERIFICATION.md`, '--field', 'status', '--value', 'passed']));
  assert.match(fs.readFileSync(path.join(r.root, ...`${REL}/05-VERIFICATION.md`.split('/')), 'utf8'), /^status: passed$/m);
  assert.equal(r.git('log', '-1', '--format=%s'), 'docs(phase-5): verification passed after UAT');

  // a UAT with a row still pending is no pass: the report stays human_needed and the step fails
  const p = await closeRig(t, { setup, turbo: { 'uat plan': json({ items: [] }), 'uat owner-request': json({ needsOwner: false, sign: [] }) } });
  await assert.rejects(runStep(p.ctx, 'uat'), /verification human_needed after UAT/);

  // the owner's signature: a held sign-off card; Accept signs those rows, then the step starts again
  const signSetup = (x) => {
    x.write(`${REL}/05-VERIFICATION.md`, verification('human_needed'));
    // (turbo uat sign is a recorded stub here: the rows pass as signing would leave them)
    x.write(`${REL}/05-UAT.md`, uatFile([[1, 'the greeting shows', 'pass'], [2, 'the owner likes it', 'pass']]));
    x.commit('docs: v and uat');
  };
  const s = await closeRig(t, {
    script, setup: signSetup,
    turbo: { 'uat plan': json({ items: [] }), 'uat owner-request': [json({ needsOwner: true, sign: [2], reason: 'row 2' }), json({ needsOwner: false, sign: [] })] },
  });
  const seen = answerNext(t, s.root, '5', 1);
  assert.equal(await runStep(s.ctx, 'uat'), 'done');
  assert.deepEqual([seen[0].held, seen[0].sign, seen[0].signText.length], [true, [2], 1]);
  assert.ok(s.turbo.args().some((a) => a.join(' ') === `uat sign 5 --answer ${seen[0].id}`));

  // a row with an issue starts a gap round with the UAT file as the findings
  const gap = compactPlan({ id: '05-03', files: ['src/c.js'], extra: ['gap_closure: true'] });
  const u = await closeRig(t, {
    script: { plans: { [`${REL}/05-03-PLAN.md`]: gap } },
    setup: (x) => {
      for (const [id, req] of [['05-01', 'DEMO-01'], ['05-02', 'DEMO-02']]) {
        x.write(`${REL}/${id}-PLAN.md`, compactPlan({ id, files: [`src/${id}.js`], reqs: [req] }));
        x.write(`${REL}/${id}-SUMMARY.md`, summaryText({ phaseSlug: '05-demo', plan: id }));
      }
      x.write(`${REL}/05-VERIFICATION.md`, verification('human_needed'));
      x.write(`${REL}/05-UAT.md`, uatFile([[1, 'the greeting shows', 'issue']]));
      x.commit('docs: plans, v and uat');
    },
    turbo: { 'uat plan': json({ items: [] }), 'uat owner-request': json({ needsOwner: false, sign: [] }) },
  });
  assert.equal(await runStep(u.ctx, 'uat'), 'gap');
  assert.equal(u.ctx.state.gapRounds, 1);
  const slicer = u.f.calls().find((c) => c.stdin.startsWith('You are the slicer'));
  assert.ok(slicer.stdin.includes(`${REL}/05-UAT.md`));
  // B5: after the slicer read them, the issue rows go back to pending, so the next UAT step re-tests them
  const uatText = fs.readFileSync(path.join(u.root, ...`${REL}/05-UAT.md`.split('/')), 'utf8');
  assert.match(uatText, /result: \[pending\]\r?\nretest: "gap round 1: was an issue/);
  assert.ok(u.git('log', '--format=%s').split(/\r?\n/).includes('test(phase-5): UAT issues back to pending for the re-test after gap round 1'));
});

test('uat at the gap-round limit: an issue asks the owner; Try again is one more gap round (B5 A/B: the same UAT again and again)', async (t) => {
  const gap = compactPlan({ id: '05-03', files: ['src/c.js'], extra: ['gap_closure: true'] });
  const u = await closeRig(t, {
    script: { plans: { [`${REL}/05-03-PLAN.md`]: gap } },
    setup: (x) => {
      x.write(`${REL}/05-01-PLAN.md`, compactPlan({ id: '05-01', files: ['src/05-01.js'], reqs: ['DEMO-01', 'DEMO-02'] }));
      x.write(`${REL}/05-01-SUMMARY.md`, summaryText({ phaseSlug: '05-demo', plan: '05-01' }));
      x.write(`${REL}/05-VERIFICATION.md`, verification('human_needed'));
      x.write(`${REL}/05-UAT.md`, uatFile([[1, 'the greeting shows', 'issue']]));
      x.commit('docs: plan, v and uat');
    },
    turbo: { 'uat plan': json({ items: [] }), 'uat owner-request': json({ needsOwner: false, sign: [] }) },
  });
  u.ctx.state.gapRounds = 1;
  u.ctx.save();
  const seen = answerNext(t, u.root, '5', 1);
  assert.equal(await runStep(u.ctx, 'uat'), 'gap');
  assert.match(seen[0].question, /still finds gaps/);
  assert.equal(u.ctx.state.gapRounds, 2);
  assert.equal(u.turbo.args().filter((a) => a.join(' ') === 'uat plan 5').length, 1);
});

test('tests: one full run; red → one fixer → full again → else the owner', async (t) => {
  const r = await closeRig(t, { turbo: { 'test-changed': [{ code: 1, out: 'red\n' }, { code: 0, out: '' }] }, script: { fixes: [{ files: {}, result: 'x' }] } });
  assert.equal(await runStep(r.ctx, 'tests'), 'done');
  const full = r.turbo.calls.filter((c) => c.args[0] === 'test-changed');
  assert.equal(full.length, 2);
  assert.deepEqual(full[0].o.env, { TURBO_FULL: '1' });
  assert.ok(full[0].o.logFile.startsWith(path.join(runDir(r.root), 'build-p5', 'tests-full-')));
  const fixer = r.f.calls().filter((c) => c.stdin.startsWith('You are the fixer'));
  assert.equal(fixer.length, 1);
  assert.ok(fixer[0].stdin.includes('.planning/turbo/run/build-p5/tests-full-'));
  assert.match(r.ctx.state.steps.tests.why, /push\.mode off/);

  const red = await closeRig(t, { turbo: { 'test-changed': { code: 1, out: 'red\n' } } });
  const seen = answerNext(t, red.root, '5', 2);
  assert.equal(await runStep(red.ctx, 'tests'), 'stopped');
  assert.match(seen[0].question, /the tests stay red after one fix/);
});

test('push: off by default; on, push-request --wait until it ends; CI red → one fixer per round', async (t) => {
  const on = { push: { mode: 'after-phase' } };
  const a = await closeRig(t, { config: on, turbo: { 'push-request 5': [{ code: 3 }, { code: 3 }, { code: 0 }] } });
  assert.equal(await runStep(a.ctx, 'tests'), 'done');
  assert.deepEqual(a.turbo.args().filter((x) => x[0] === 'push-request'), Array(3).fill(['push-request', '5', '--at', 'phase', '--wait']));

  const holder = {};
  const red = (args) => {
    appendInbox(holder.root, '5', { kind: 'ci-red', sha: 'a'.repeat(40), run: 7, job: 'test', step: 'npm test', tail: ['boom'] });
    return { code: 1, out: 'ci red\n' };
  };
  const b = await closeRig(t, { config: on, turbo: { 'push-request 5': [red, { code: 0 }] }, setup: (x) => { holder.root = x.root; } });
  assert.equal(await runStep(b.ctx, 'tests'), 'done');
  const fixer = b.f.calls().find((c) => c.stdin.startsWith('You are the fixer'));
  const file = path.join(runDir(b.root), 'build-p5', 'ci-red-1.md');
  assert.ok(fixer.stdin.includes('.planning/turbo/run/build-p5/ci-red-1.md'));
  assert.equal(fs.readFileSync(file, 'utf8').trim(), formatInboxMessage({ kind: 'ci-red', sha: 'a'.repeat(40), run: 7, job: 'test', step: 'npm test', tail: ['boom'], seq: 1 }, { phase: '5', ciFixRounds: 2 }));
  assert.equal(b.turbo.calls.filter((c) => c.args[0] === 'test-changed').length, 2, 'full tests again after the fix');

  const holder2 = {};
  const red2 = () => {
    appendInbox(holder2.root, '5', { kind: 'ci-red', sha: 'b'.repeat(40), run: 8, tail: [] });
    return { code: 1, out: '' };
  };
  const c = await closeRig(t, { config: on, turbo: { 'push-request 5': red2 }, setup: (x) => { holder2.root = x.root; } });
  const seen = answerNext(t, c.root, '5', 2);
  assert.equal(await runStep(c.ctx, 'tests'), 'stopped');
  assert.match(seen[0].question, /CI stays red/);
  assert.equal(c.f.calls().filter((x) => x.stdin.startsWith('You are the fixer')).length, 2);
});

test('close in a checkout: phase.complete, one commit, the done record', async (t) => {
  for (const lane of ['', '1']) {
    const saved = process.env.TURBO_BUILD_LANE;
    if (lane) process.env.TURBO_BUILD_LANE = lane;
    else delete process.env.TURBO_BUILD_LANE;
    try {
      const r = await closeRig(t);
      recordSessionUsage(runDir(r.root), '5', { step: 'build', role: 'builder', sessionId: 's1', usage: { input_tokens: 1, output_tokens: 1 }, wallMs: 1000 });
      assert.equal(await runStep(r.ctx, 'close'), 'done');
      assert.match(fs.readFileSync(path.join(r.root, '.planning', 'ROADMAP.md'), 'utf8'), /^- \[x\] \*\*Phase 5/m);
      assert.equal(r.git('log', '-1', '--format=%s'), 'docs(phase-5): complete phase (build path)');
      assert.equal(readLaneStatus(r.root, '5').status, 'done');
      const log = fs.readFileSync(path.join(logsDir(r.root), 'supervisor.log'), 'utf8');
      assert.equal(/phase 5 cost: path build/.test(log), !lane, `TURBO_BUILD_LANE=${lane}`);
    } finally {
      if (saved === undefined) delete process.env.TURBO_BUILD_LANE;
      else process.env.TURBO_BUILD_LANE = saved;
    }
  }
});

// GSD 1.22 (#6293) ticks a row whose Status carries a note and drops the note: the close puts it back and says so
test('close in a checkout: a requirement row with a note in its Status stays as written and the step says so', async (t) => {
  const NOTE = 'Pending (waits for a live check)';
  const h = {};
  const gsd = (args, { json = true } = {}) => {
    const core = gsdCoreDir(h.root);
    const out = json ? runGsdJson(core, args, { cwd: h.root }) : gsdText(core, h.root, args);
    if (args[1] === 'phase.complete') fs.writeFileSync(h.req, fs.readFileSync(h.req, 'utf8').replaceAll('- [ ]', '- [x]').replace(`| ${NOTE} |`, '| Complete |').replace('| Pending |', '| Complete |'));
    return out;
  };
  const setup = (x) => {
    h.root = x.root;
    h.req = path.join(x.root, '.planning', 'REQUIREMENTS.md');
    x.write('.planning/REQUIREMENTS.md', fs.readFileSync(h.req, 'utf8').replace('| DEMO-01 | Phase 5 | Pending |', `| DEMO-01 | Phase 5 | ${NOTE} |`));
    x.commit('docs: a requirement waits for a live check');
  };
  const r = await closeRig(t, { deps: { gsd }, setup });
  assert.equal(await runStep(r.ctx, 'close'), 'done');
  const text = fs.readFileSync(h.req, 'utf8');
  assert.match(text, /^- \[ \] \*\*DEMO-01\*\*: greet works$/m);
  assert.match(text, /^\| DEMO-01 \| Phase 5 \| Pending \(waits for a live check\) \|$/m);
  assert.match(text, /^- \[x\] \*\*DEMO-02\*\*: farewell works$/m);
  assert.match(text, /^\| DEMO-02 \| Phase 5 \| Complete \|$/m);
  assert.equal(r.ctx.state.steps.close.why, `1 requirement row(s) kept as written (GSD would mark them Complete and drop the note): DEMO-01 «${NOTE}»`);
  assert.deepEqual(r.ctx.state.keptRequirements, [{ id: 'DEMO-01', status: NOTE }]);
  // the same line is in the supervisor log, where the controller reads
  assert.match(fs.readFileSync(path.join(logsDir(r.root), 'supervisor.log'), 'utf8'), /phase 5 build: step close done: 1 requirement row\(s\) kept as written/);
  assert.equal(r.git('status', '--porcelain', '--untracked-files=no', '--', '.planning/REQUIREMENTS.md'), '', 'what was put back is what the close committed');
});

// A slot of phase 5 (Stage 4 L0's helpers) with the build state's B4 fields, gsd-tools answered by a stub.
async function slotRig(t, { integrate = null, turbo = {}, script = {}, gsd: gsdFake = null } = {}) {
  const p = laneProject({ job: { kind: 'phase', phase: '5' }, files: { [`${REL}/05-CONTEXT.md`]: '# Context\n', [`${REL}/05-VERIFICATION.md`]: verification('passed'), '.planning/ROADMAP.md': '# Roadmap\n\n### Phase 5: Demo Feature\n' } });
  fakeGsdCore(p.slot);
  const rec = turboRec(turbo);
  const gsd = gsdFake ?? ((args) => {
    if (args[0] === 'init') return { phase_name: 'Demo Feature', padded_phase: '05' };
    if (args[0] === 'verification') return { status: 'passed' };
    return '{"committed":false,"reason":"nothing_to_commit"}';
  });
  const git = slotGit(ISOLATED);
  const r = await buildRig({ script, deps: { turbo: rec.fn, gsd, integrate: integrate ?? ((root, phase) => integrateMain(root, phase, { git })) } });
  const ctx = await openBuild(p.slot, '5', { deps: { ...r.deps, gsd, turbo: rec.fn, integrate: integrate ?? ((root, phase) => integrateMain(root, phase, { git })) } });
  t.after(() => ctx.release());
  return { p, r, ctx, turbo: rec, git };
}

test('close in a slot: integrate, full tests, verification, then ready', async (t) => {
  const a = await slotRig(t);
  assert.equal(await runStep(a.ctx, 'close'), 'done');
  const st = readLaneStatus(a.p.root, '5');
  assert.equal(st.status, 'ready');
  assert.equal(st.base, a.p.inMain('rev-parse', 'HEAD'));
  assert.ok(a.turbo.args().some((x) => x[0] === 'test-changed'));

  let n = 0;
  const holder = {};
  const conflictsOnce = (root, phase) => (++n === 1 ? { state: 'conflicts', conflicts: ['src/a.js'] } : integrateMain(root, phase, { git: holder.git }));
  const b = await slotRig(t, { integrate: conflictsOnce });
  holder.git = b.git;
  assert.equal(await runStep(b.ctx, 'close'), 'done');
  const sessions = b.r.f.calls();
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].stdin.startsWith("The merge of the main branch into this phase's branch stopped with conflicts in: src/a.js."));

  const c = await slotRig(t, { integrate: () => ({ state: 'conflicts', conflicts: ['src/a.js'] }) });
  const seen = answerNext(t, c.p.slot, '5', 2);
  assert.equal(await runStep(c.ctx, 'close'), 'stopped');
  assert.match(seen[0].question, /the main branch changed the same places/);

  // the supervisor's merge-rounds card, named by a needs-owner lane record
  const card = { question: 'Phase 5 cannot be merged: the main branch keeps changing before the phase catches up with it', context: 'It happened three times.', options: [{ label: 'Wait', description: 'Turbo waits and the phase catches up once more.' }, { label: 'I will merge it myself', description: 'The phase stops here.' }], recommended: 1 };
  for (const option of [1, 2]) {
    const d = await slotRig(t);
    const q = askOwner(d.p.slot, '5', card).question;
    answerQuestion({ root: d.p.slot, phase: '5', id: q.id, option, by: 'pane', laneRunning: true });
    const out = await runStep(d.ctx, 'close');
    if (option === 1) {
      assert.equal(out, 'done');
      assert.ok(fs.existsSync(holdFile(d.p.slot, '5')));
      assert.equal(readLaneStatus(d.p.root, '5').status, 'ready');
    } else {
      assert.equal(out, 'paused');
      assert.deepEqual([readLaneStatus(d.p.root, '5').status, readLaneStatus(d.p.root, '5').reason], ['needs-owner', 'the owner merges phase 5 by hand']);
    }
  }

  // the card in the supervisor's merge record, after the relaunch wrote running over the lane record: --resume of a
  // closed build opens close again and acts on it once
  {
    const m = await slotRig(t);
    for (const s of BUILD_STEPS) setStep(m.ctx.state, s, { state: 'done' });
    m.ctx.state.step = 'close';
    m.ctx.save();
    m.ctx.release();
    const q = askOwner(m.p.slot, '5', card).question;
    writeJsonAtomic(mergeFile(m.p.root, '5'), { phase: '5', state: 'needs-owner', reason: `the main branch moved 3 times in a row before phase 5 could be merged; owner question ${q.id}` });
    writeLaneStatus(m.p.slot, '5', 'running');
    answerQuestion({ root: m.p.slot, phase: '5', id: q.id, option: 2, by: 'pane', laneRunning: true });
    const out = await runBuild({ root: m.p.slot, phase: '5', resume: true, deps: { ...m.ctx.deps } });
    assert.equal(out.outcome, 'paused');
    assert.deepEqual([readLaneStatus(m.p.root, '5').status, readLaneStatus(m.p.root, '5').reason], ['needs-owner', 'the owner merges phase 5 by hand']);
  }

  // --resume with an unread reintegrate runs close again; with an unread ci-red, tests then close
  for (const kind of ['reintegrate', 'ci-red']) {
    const e = await slotRig(t, { turbo: {} });
    for (const s of BUILD_STEPS) setStep(e.ctx.state, s, { state: 'done' });
    e.ctx.state.step = 'close';
    e.ctx.save();
    e.ctx.release();
    appendInbox(e.p.slot, '5', kind === 'reintegrate' ? { kind, base: 'c'.repeat(40), was: 'd'.repeat(40), round: 1, of: 3 } : { kind, sha: 'e'.repeat(40), run: 9, tail: [] });
    const out = await runBuild({ root: e.p.slot, phase: '5', resume: true, deps: { ...e.ctx.deps } });
    assert.equal(out.outcome, 'closed', kind);
    assert.equal(readLaneStatus(e.p.root, '5').status, 'ready', kind);
    if (kind === 'ci-red') assert.ok(e.turbo.args().some((x) => x[0] === 'test-changed'));
  }
});

// v0.8.1 (live run 2026-11-12, phase 36, twice): a report that waits only on UAT which already passes GSD's predicate
// became a dead end at every close after an integrate that made it stale
test('close in a slot: a stale report the verifier writes human_needed again is passed by GSD\'s UAT predicate, then ready', async (t) => {
  const calls = [];
  let reads = 0;
  let status = 'human_needed';
  const gsd = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'init') return { phase_name: 'Demo Feature', padded_phase: '05' };
    // stale at the close's first look (the integrate brought commits), then what the verifier's new report says
    if (args[0] === 'verification') return { status: reads++ === 0 ? 'stale' : status };
    if (args[0] === 'phase' && args[1] === 'uat-passed') return '{"passed":true,"blockers":[]}';
    if (args[0] === 'query' && args[1] === 'frontmatter.set') {
      status = 'passed';
      return '{"updated":true}';
    }
    // gsd-tools commit: the report the verifier wrote goes into the lane's branch
    if (args[0] === 'commit' && holder.p && holder.p.inSlot('status', '--porcelain')) {
      holder.p.inSlot('add', '-A');
      holder.p.inSlot('commit', '-q', '-m', String(args[1]));
      return '{"committed":true}';
    }
    return '{"committed":false,"reason":"nothing_to_commit"}';
  };
  const holder = {};
  const a = await slotRig(t, { gsd, script: { verifications: [{ path: `${REL}/05-VERIFICATION.md`, text: verification('human_needed') }] } });
  holder.p = a.p;
  assert.equal(await runStep(a.ctx, 'close'), 'done');
  assert.equal(readLaneStatus(a.p.root, '5').status, 'ready');
  assert.ok(calls.includes('phase uat-passed 5 --uat-only'), calls.join(' | '));
  assert.ok(calls.some((c) => c.startsWith('query frontmatter.set') && c.endsWith('--field status --value passed')));

  // UAT that does not pass GSD's predicate: the close still fails, in plain words
  const st2 = 'human_needed';
  const gsd2 = (args) => {
    if (args[0] === 'init') return { phase_name: 'Demo Feature', padded_phase: '05' };
    if (args[0] === 'verification') return { status: st2 };
    if (args[0] === 'phase' && args[1] === 'uat-passed') return '{"passed":false,"blockers":["row 3"]}';
    return '{"committed":false,"reason":"nothing_to_commit"}';
  };
  const b = await slotRig(t, { gsd: gsd2 });
  await assert.rejects(runStep(b.ctx, 'close'), /verification human_needed after taking in the main branch/);
});

// v0.8.1 (live runs 2026-11-12/13): the lane's own STATE.md writes pushed the file over the project's size test; the
// full run went red on a file no slice owns and a card followed. The build path never applied the STATE budget.
test('tests: STATE.md is kept within lean.state_budget_kb before the full run, in a commit of its own', async (t) => {
  const big = ['# State', '', '## Current Position', '', 'Phase: 5', '', '## Session Log', '', ...Array.from({ length: 200 }, (_, i) => `- entry ${i} ${'x'.repeat(40)}`), ''].join('\n');
  assert.ok(Buffer.byteLength(big) > 8 * 1024);
  const r = await closeRig(t, {
    config: { lean: { state_budget_kb: 4 } },
    setup: (x) => {
      x.write('.planning/STATE.md', big);
      x.commit('docs: a long STATE');
    },
  });
  assert.equal(await runStep(r.ctx, 'tests'), 'done');
  const state = fs.readFileSync(path.join(r.root, '.planning', 'STATE.md'), 'utf8');
  assert.ok(Buffer.byteLength(state) <= 4 * 1024, `${Buffer.byteLength(state)} B; log: ${fs.readFileSync(path.join(logsDir(r.root), "supervisor.log"), "utf8").slice(-600)}`);
  assert.ok(state.includes('## Current Position'), 'the protected sections stay');
  assert.ok(fs.existsSync(path.join(r.root, '.planning', 'STATE-ARCHIVE.md')));
  assert.match(fs.readFileSync(path.join(logsDir(r.root), 'supervisor.log'), 'utf8'), /STATE\.md kept within its size: the history of 1 section\(s\) moved to STATE-ARCHIVE\.md/);
  assert.equal(r.git('status', '--porcelain', '--', '.planning/STATE.md', '.planning/STATE-ARCHIVE.md'), '', 'committed before the run');
});

// v0.8.1 (live run 2026-11-12, phase 36: «the only go-on button writes a false record»)
test('the sign-off card offers Defer: the rows become open follow-ups with a true reason, nothing is signed, the step goes on', async (t) => {
  const setup = (x) => {
    x.write(`${REL}/05-VERIFICATION.md`, verification('human_needed'));
    x.write(`${REL}/05-UAT.md`, uatFile([[1, 'the greeting shows', 'pass'], [2, 'the release runs on the server', 'pass']]));
    x.commit('docs: v and uat');
  };
  const s = await closeRig(t, {
    setup,
    turbo: { 'uat plan': json({ items: [] }), 'uat owner-request': [json({ needsOwner: true, sign: [2], reason: 'row 2' }), json({ needsOwner: false, sign: [] })] },
  });
  const seen = answerNext(t, s.root, '5', 3);
  assert.equal(await runStep(s.ctx, 'uat'), 'done');
  assert.deepEqual(seen[0].options.map((o) => o.label), ['Accept', 'Not now', 'Defer']);
  assert.equal(seen[0].header, 'Checks');
  const calls = s.turbo.args().map((a) => a.join(' '));
  assert.ok(!calls.some((c) => c.startsWith('uat sign')), 'nothing is signed');
  const defer = s.turbo.args().find((a) => a[1] === 'defer' && a[3] === '2');
  assert.deepEqual(defer.slice(0, 5), ['uat', 'defer', '5', '2', '--reason']);
  assert.equal(defer[5], 'deferred at the sign-off card by the owner: not checked and not signed; it waits for what comes after this phase (its merge or a live step)');
  assert.match(fs.readFileSync(path.join(logsDir(s.root), 'supervisor.log'), 'utf8'), /ask-1: UAT rows 2 deferred by the owner, not signed/);
});

// v0.8.1: `--by agent` must never fail a build: an assistant's Accept on a sign-off card is refused at the answer
test('an assistant cannot accept a sign-off card; it may defer', async (t) => {
  const r = await closeRig(t);
  const q = askOwner(r.root, '5', { question: 'Phase 5: please check these items yourself and accept them.', context: '', sign: [2], signText: ['the release runs on the server'], signDefer: true }, { lang: 'en', keepRunning: true }).question;
  assert.throws(() => answerQuestion({ root: r.root, phase: '5', id: q.id, option: 1, by: 'agent', laneRunning: true }), /accepting these items is the owner's own signature/);
  assert.equal(readQuestions(r.root, '5').find((x) => x.id === q.id).state, 'open', 'nothing was recorded');
  assert.doesNotThrow(() => answerQuestion({ root: r.root, phase: '5', id: q.id, option: 3, by: 'agent', laneRunning: true }));
  assert.equal(readQuestions(r.root, '5').find((x) => x.id === q.id).answer.by, 'agent');
});
