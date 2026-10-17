import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildRig, claudeHome, summaryText } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { adoptRound, openBuild, runStep, setStep } from '../lib/build.mjs';
import { needsSecurity, readPhaseInfo } from '../lib/phase-signals.mjs';
import { readQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { runDir } from '../lib/paths.mjs';

const H = claudeHome();
after(() => H.restore());
const REL = '.planning/phases/05-demo';
const REVIEW = `${REL}/05-REVIEW.md`;
const clean = { path: REVIEW, text: '---\nstatus: clean\n---\n\n# Code Review\n\nNo findings.\n' };
const finding = (code, title, file = 'src/a.js:3') => `### ${code}: ${title}\n\n**File:** \`${file}\`\n**Issue:** it breaks.\n`;
const reviewOf = (...items) => ({ path: REVIEW, text: `---\nstatus: issues_found\n---\n\n# Code Review\n\n## Findings\n\n${items.join('\n')}` });
const verification = (status) => ({ path: `${REL}/05-VERIFICATION.md`, text: `---\nphase: 05-demo\nstatus: ${status}\n---\n\n# Verification\n` });

// A build project whose base is recorded, with src/a.js and a planning note committed after it.
async function gatesRig(t, { script = {}, setup = null } = {}) {
  const r = await buildRig({ script });
  if (setup) setup(r);
  const ctx = await openBuild(r.root, '5', { deps: r.deps });
  t.after(() => ctx.release());
  ctx.state.base = r.git('rev-parse', 'HEAD');
  r.write('src/a.js', 'module.exports = (n) => `Hello, ${n}`;\n');
  r.write('.planning/notes.md', 'notes\n');
  r.commit('feat: a');
  ctx.save();
  return { ...r, ctx };
}

function every(t, fn) {
  const timer = setInterval(() => {
    try {
      if (fn()) clearInterval(timer);
    } catch { /* again */ }
  }, 15);
  t.after(() => clearInterval(timer));
}
// Answers the next open card with the option (by its label) once it shows; records its question.
function answerCard(t, root, label, seen = []) {
  every(t, () => {
    const q = readQuestions(root, '5').find((x) => x.state === 'open');
    if (!q) return false;
    seen.push(q);
    const option = q.options.findIndex((o) => o.label === label) + 1;
    answerQuestion({ root, phase: '5', id: q.id, option, by: 'pane', laneRunning: true });
    return true;
  });
  return seen;
}
const byAgent = (r, agent) => r.f.calls().filter((c) => c.argv[c.argv.indexOf('--agent') + 1] === agent && c.argv.includes('--agent'));
const fixers = (r) => r.f.calls().filter((c) => c.stdin.startsWith('You are the fixer'));

test('review: a clean review ends the step', async (t) => {
  const r = await gatesRig(t, { script: { reviews: [clean] } });
  const base = r.ctx.state.base;
  assert.equal(await runStep(r.ctx, 'review'), 'done');
  const calls = byAgent(r, 'gsd-code-reviewer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argv[calls[0].argv.indexOf('--effort') + 1], 'high');
  for (const s of ['depth: standard', `phase_dir: ${REL}`, `review_path: ${REVIEW}`, `diff_base: ${base}`, 'files:\n  - src/a.js']) assert.ok(calls[0].stdin.includes(s), s);
  assert.equal(calls[0].stdin.includes('.planning/notes.md'), false);
  assert.equal(r.git('log', '-1', '--format=%s'), 'docs(phase-5): code review');

  const none = await buildRig({});
  const ctx = await openBuild(none.root, '5', { deps: none.deps });
  t.after(() => ctx.release());
  ctx.state.base = none.git('rev-parse', 'HEAD');
  assert.equal(await runStep(ctx, 'review'), 'skipped');
  assert.equal(ctx.state.steps.review.why, 'no code changed in this phase');
});

test('review: one fixer pass, then a review of the fix diff only', async (t) => {
  const fix = { files: { 'src/a.js': 'module.exports = (n) => `Hello, ${n ?? "you"}`;\n' }, message: 'fix(05): CR-01 null check', result: 'CR-01 — fixed abc1234\nWR-01 — not fixed: needs a design choice' };
  const r = await gatesRig(t, { script: { reviews: [reviewOf(finding('CR-01', 'greet crashes on null'), finding('WR-01', 'no trim', 'src/a.js'), finding('IN-01', 'naming')), clean], fixes: [fix] } });
  const base = r.ctx.state.base;
  assert.equal(await runStep(r.ctx, 'review'), 'done');
  const before = r.ctx.state.steps.review.since;
  assert.equal(r.git('log', '-1', '--format=%s', before), 'docs(phase-5): code review');
  const [fixer] = fixers(r);
  assert.ok(fixer.stdin.includes('05-REVIEW.md is a GSD code review.'), fixer.stdin);
  assert.ok(fixer.stdin.includes(`git diff ${base}..${before}`));
  const second = byAgent(r, 'gsd-code-reviewer')[1];
  assert.ok(second.stdin.includes(`Lean review of the fixes: review only what changed since commit ${before}`));
  assert.ok(second.stdin.includes('1. WR-01 (warning, the fixer did not fix it): no trim'), second.stdin);
  assert.equal(r.ctx.state.steps.review.rounds, 1);
  assert.ok(fs.readdirSync(path.join(runDir(r.root), 'build-p5')).some((n) => /^tests-retest-\d+\.log$/.test(n)), 'a plain test-changed ran after the fixer');
});

test('review: a second round only for a new critical', async (t) => {
  const fix1 = { files: { 'src/a.js': 'module.exports = (n) => `Hello, ${n ?? ""}`;\n' }, message: 'fix(05): CR-01 null check', result: 'CR-01 — fixed abc1234' };
  const fix2 = { files: { 'src/a.js': 'module.exports = (n) => `Hello, ${n ?? "x"}`;\n' }, message: 'fix(05): CR-02 race', result: 'CR-02 — fixed def5678' };
  const r = await gatesRig(t, { script: { reviews: [reviewOf(finding('CR-01', 'greet crashes on null')), reviewOf(finding('CR-02', 'race on save')), clean], fixes: [fix1, fix2] } });
  assert.equal(await runStep(r.ctx, 'review'), 'done');
  const f = fixers(r);
  assert.equal(f.length, 2);
  assert.match(f[1].stdin, /Fix exactly these: CR-02;/);
  assert.equal(byAgent(r, 'gsd-code-reviewer').length, 3);
  assert.equal(r.ctx.state.steps.review.rounds, 2);
});

test('review: an old critical still open goes to the owner, never a second round', async (t) => {
  const fix = { files: { 'src/a.js': 'module.exports = (n) => `Hi, ${n}`;\n' }, message: 'fix(05): CR-01 try', result: 'CR-01 — fixed abc1234' };
  const r = await gatesRig(t, { script: { reviews: [reviewOf(finding('CR-01', 'greet crashes on null')), reviewOf(finding('CR-01', 'greet crashes on null'))], fixes: [fix] } });
  const seen = answerCard(t, r.root, 'Go on');
  assert.equal(await runStep(r.ctx, 'review'), 'done');
  assert.equal(fixers(r).length, 1);
  assert.match(seen[0].question, /the code review still finds a serious problem/);
  assert.equal(seen[0].held, true);
  assert.equal(r.ctx.state.steps.review.accepted, 'ask-1');
});

test('verify: passed ends; gaps start a gap round through the slicer, at most gap_rounds', async (t) => {
  const gap = compactPlan({ id: '05-03', files: ['src/c.js'], extra: ['gap_closure: true'] });
  const r = await gatesRig(t, {
    script: { verifications: [verification('passed')] },
    setup: (x) => {
      for (const [id, file] of [['05-01', 'src/a.js'], ['05-02', 'src/b.js']]) {
        x.write(`${REL}/${id}-PLAN.md`, compactPlan({ id, files: [file], reqs: [id === '05-01' ? 'DEMO-01' : 'DEMO-02'] }));
        x.write(`${REL}/${id}-SUMMARY.md`, summaryText({ phaseSlug: '05-demo', plan: id }));
      }
      x.commit('docs: plans and summaries');
    },
  });
  assert.equal(await runStep(r.ctx, 'verify'), 'done');
  const [v] = byAgent(r, 'gsd-verifier');
  assert.ok(v.stdin.startsWith('Verify phase 5 goal achievement.'));
  for (const s of [`Phase directory: ${REL}`, 'Phase goal: Ship the demo', 'Phase requirement IDs: DEMO-01, DEMO-02', 'Create VERIFICATION.md.']) assert.ok(v.stdin.includes(s), s);
  assert.equal(v.argv[v.argv.indexOf('--effort') + 1], 'medium');
  assert.equal(r.git('log', '-1', '--format=%s'), 'docs(phase-5): verification');

  r.a.set({ verifications: [verification('gaps_found'), verification('gaps_found')], plans: { [`${REL}/05-03-PLAN.md`]: gap } });
  const { ctx } = r;
  adoptRound(ctx, { round: 0 });
  for (const s of ['slice', 'build', 'review']) setStep(ctx.state, s, { state: 'done' });
  delete ctx.state.steps.verify;
  assert.equal(await runStep(ctx, 'verify'), 'gap');
  const slicer = r.f.calls().find((c) => c.stdin.startsWith('You are the slicer'));
  assert.match(slicer.stdin, /## Gap round/);
  assert.equal(r.git('log', '-1', '--format=%s'), 'docs(phase-5): gap slices (round 1)');
  assert.deepEqual([ctx.state.round, Object.keys(ctx.state.slices), ctx.state.gapRounds, ctx.state.roundBase], [1, ['05-03'], 1, r.git('rev-parse', 'HEAD')]);
  assert.deepEqual([ctx.state.steps.build, ctx.state.steps.review, ctx.state.steps.verify, ctx.state.step], [undefined, undefined, undefined, 'build']);
  assert.equal(ctx.state.steps.slice.state, 'done');

  const seen = answerCard(t, r.root, 'Go on');
  assert.equal(await runStep(ctx, 'verify'), 'done');
  assert.match(seen[0].question, /the check against the phase goals still finds gaps/);
  assert.equal(ctx.state.gapRounds, 1);
});

test('security: by the phase\'s signal; the auditor\'s verdict becomes SECURITY.md', async (t) => {
  const neutral = await gatesRig(t);
  assert.equal(await runStep(neutral.ctx, 'security'), 'skipped');
  assert.equal(neutral.ctx.state.steps.security.why, needsSecurity(readPhaseInfo(neutral.root, '5')).why);

  const auth = (x) => {
    x.write(`${REL}/05-01-PLAN.md`, compactPlan({ id: '05-01', files: ['src/auth/session.js'] }));
    x.commit('docs: auth plan');
  };
  const SECURED = '## SECURED\n\n**Phase:** 5\n**threats_open:** 0\n';
  const OPEN = '## OPEN_THREATS\n\n**threats_open:** 1\n\n### Open (blocking)\n\n| Threat ID | Category | Severity | Mitigation |\n|---|---|---|---|\n| T-5-01 | Spoofing | high | session check |\n';
  const fix = { files: { 'src/auth/session.js': 'module.exports = 1;\n' }, message: 'fix(05): T-5-01 session check', result: 'T-5-01 — fixed abc1234' };
  const a = await gatesRig(t, { script: { audits: [SECURED] }, setup: auth });
  assert.equal(await runStep(a.ctx, 'security'), 'done');
  const [audit] = byAgent(a, 'gsd-security-auditor');
  assert.equal(audit.argv[audit.argv.indexOf('--effort') + 1], 'high');
  assert.ok(audit.stdin.includes('<config>asvs_level: 1, block_on: high</config>'));
  assert.ok(audit.stdin.includes('register_authored_at_plan_time: false — Retroactive-STRIDE'));
  const report = fs.readFileSync(path.join(a.phaseDir, '05-SECURITY.md'), 'utf8');
  assert.match(report, /^threats_open: 0$/m);
  assert.match(report, /^status: secured$/m);
  assert.ok(report.includes(SECURED.trim()));
  assert.equal(a.git('log', '-1', '--format=%s'), 'docs(phase-5): security audit');

  const b = await gatesRig(t, { script: { audits: [OPEN, SECURED], fixes: [fix] }, setup: auth });
  assert.equal(await runStep(b.ctx, 'security'), 'done');
  assert.match(fixers(b)[0].stdin, /Fix exactly these: T-5-01;/);

  const c = await gatesRig(t, { script: { audits: [OPEN, OPEN], fixes: [fix] }, setup: auth });
  const seenC = answerCard(t, c.root, 'Stop here');
  assert.equal(await runStep(c.ctx, 'security'), 'stopped');
  assert.match(seenC[0].question, /the security check still finds an open threat/);

  const d = await gatesRig(t, { script: { audits: ['## ESCALATE\n\nNeeds a person.\n'] }, setup: auth });
  const seenD = answerCard(t, d.root, 'Go on');
  assert.equal(await runStep(d.ctx, 'security'), 'done');
  assert.equal(fixers(d).length, 0);
  assert.match(seenD[0].question, /security check/);
});
