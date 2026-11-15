import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildRig, claudeHome, summaryText } from './helpers/build-fake.mjs';
import { compactPlan } from './helpers/slices.mjs';
import { adoptRound, openBuild, resultWith, runStep, setStep, whoAnswered } from '../lib/build.mjs';
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

test('verify at the gap-round limit: Try again is one more gap round, never the same check again (B5 A/B: it looped)', async (t) => {
  const gap = compactPlan({ id: '05-04', files: ['src/d.js'], extra: ['gap_closure: true'] });
  const r = await gatesRig(t, {
    script: { verifications: [verification('gaps_found')], plans: { [`${REL}/05-04-PLAN.md`]: gap } },
    setup: (x) => {
      x.write(`${REL}/05-01-PLAN.md`, compactPlan({ id: '05-01', files: ['src/a.js'], reqs: ['DEMO-01', 'DEMO-02'] }));
      x.write(`${REL}/05-01-SUMMARY.md`, summaryText({ phaseSlug: '05-demo', plan: '05-01' }));
      x.commit('docs: plan and summary');
    },
  });
  const { ctx } = r;
  adoptRound(ctx, { round: 0 });
  for (const s of ['slice', 'build', 'review']) setStep(ctx.state, s, { state: 'done' });
  ctx.state.gapRounds = 1;
  ctx.save();
  const seen = answerCard(t, r.root, 'Try again');
  assert.equal(await runStep(ctx, 'verify'), 'gap');
  assert.equal(seen[0].options[0].description, 'the build runs one more round of fixes for the gaps, then checks again');
  assert.equal(byAgent(r, 'gsd-verifier').length, 1);
  assert.equal(ctx.state.gapRounds, 2);
  assert.match(r.f.calls().find((c) => c.stdin.startsWith('You are the slicer')).stdin, /## Gap round/);
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

test('security: while GSD\'s own workflow.security_enforcement is on the audit runs whatever the signals (B5 demo: GSD\'s verify-work needs SECURITY.md)', async (t) => {
  const enforce = (value) => (x) => {
    x.write('.planning/config.json', `${JSON.stringify({ workflow: { security_enforcement: value } })}\n`);
    x.commit('chore: GSD security switch');
  };
  const on = await gatesRig(t, { script: { audits: ['## SECURED\n\n**threats_open:** 0\n'] }, setup: enforce(true) });
  assert.equal(needsSecurity(readPhaseInfo(on.root, '5')).yes, false);
  assert.equal(await runStep(on.ctx, 'security'), 'done');
  assert.equal(byAgent(on, 'gsd-security-auditor').length, 1);
  assert.match(fs.readFileSync(path.join(on.phaseDir, '05-SECURITY.md'), 'utf8'), /^threats_open: 0$/m);

  const off = await gatesRig(t, { setup: enforce(false) });
  assert.equal(await runStep(off.ctx, 'security'), 'skipped');
  assert.equal(byAgent(off, 'gsd-security-auditor').length, 0);
});

test('security: OPEN_THREATS with threats_open 0 (only threats below block_on) passes, as GSD\'s gate does (B5 demo: a fixer with nothing to fix, then a card, again and again)', async (t) => {
  const LOW = '## OPEN_THREATS\n\n**threats_open:** 0\n\n### Open (non-blocking, below block_on)\n\n| Threat ID | Category | Severity | Mitigation |\n|---|---|---|---|\n| T-5-05 | Tampering | low | escape control characters |\n';
  const r = await gatesRig(t, { script: { audits: [LOW] }, setup: (x) => {
    x.write(`${REL}/05-01-PLAN.md`, compactPlan({ id: '05-01', files: ['src/auth/session.js'] }));
    x.commit('docs: auth plan');
  } });
  assert.equal(await runStep(r.ctx, 'security'), 'done');
  assert.equal(byAgent(r, 'gsd-security-auditor').length, 1);
  assert.equal(fixers(r).length, 0);
  assert.deepEqual(readQuestions(r.root, '5'), []);
  const report = fs.readFileSync(path.join(r.phaseDir, '05-SECURITY.md'), 'utf8');
  assert.match(report, /^threats_open: 0$/m);
  assert.match(report, /^status: secured$/m);
  assert.ok(report.includes('T-5-05'));
});

// v0.8.1 (live run 2026-11-12, phase 36: «a gate's verdict was replaced by a remark and a halt card with a false
// statement went to the owner»)
test('security: a remark after the verdict does not replace it; the report holds the register', async (t) => {
  const auth = (x) => {
    x.write(`${REL}/05-01-PLAN.md`, compactPlan({ id: '05-01', files: ['src/auth/session.js'] }));
    x.commit('docs: auth plan');
  };
  const VERDICT = '## OPEN_THREATS\n\n**threats_open:** 0\n\n| Threat ID | Category | Severity |\n|---|---|---|\n| T-5-26 | Tampering | medium |\n';
  const a = await gatesRig(t, { script: { audits: [{ texts: [VERDICT], result: 'A background command I had started timed out; the verdict above stands.' }] }, setup: auth });
  assert.equal(await runStep(a.ctx, 'security'), 'done');
  const report = fs.readFileSync(path.join(a.phaseDir, '05-SECURITY.md'), 'utf8');
  assert.match(report, /^status: secured$/m);
  assert.ok(report.includes('| T-5-26 | Tampering | medium |'), 'the register, not the remark');
  assert.ok(!report.includes('timed out'));
  assert.equal(readQuestions(a.root, '5').length, 0);
  assert.match(fs.readFileSync(path.join(a.root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8'), /security: the verdict is taken from an earlier message of the auditor/);
  assert.equal(resultWith({ messages: ['## SECURED\nfirst', 'chat'], result: '## ESCALATE\nlast' }, /^##\s*(?:SECURED|ESCALATE)\b/m), '## ESCALATE\nlast');
  assert.equal(resultWith({ messages: ['chat'], result: 'more chat' }, /^##\s*SECURED\b/m), null);
});

test('security: an answer with no verdict writes nothing and runs once more; twice, the card says so', async (t) => {
  const auth = (x) => {
    x.write(`${REL}/05-01-PLAN.md`, compactPlan({ id: '05-01', files: ['src/auth/session.js'] }));
    x.commit('docs: auth plan');
  };
  const SECURED = '## SECURED\n\n**threats_open:** 0\n';
  const a = await gatesRig(t, { script: { audits: ['I looked around and it seems fine.', SECURED] }, setup: auth });
  assert.equal(await runStep(a.ctx, 'security'), 'done');
  assert.equal(byAgent(a, 'gsd-security-auditor').length, 2);
  assert.equal(readQuestions(a.root, '5').length, 0, 'no card for one answer without a verdict');
  assert.match(fs.readFileSync(path.join(a.phaseDir, '05-SECURITY.md'), 'utf8'), /^status: secured$/m);

  const b = await gatesRig(t, { script: { audits: ['Nothing to say.', 'Still nothing.', SECURED] }, setup: auth });
  const seen = answerCard(t, b.root, 'Try again');
  assert.equal(await runStep(b.ctx, 'security'), 'done');
  assert.equal(seen[0].question, 'Phase 5: the security check gave no result twice. What should the build do?');
  assert.equal(seen[0].context, 'Its answer held no result both times; nothing was checked.');
  assert.equal(byAgent(b, 'gsd-security-auditor').length, 3);
  assert.equal(fixers(b).length, 0, 'no fixer for an audit that gave no verdict');
});

test('the review, verify and security cards say what they halted on', async (t) => {
  const auth = (x) => {
    x.write(`${REL}/05-01-PLAN.md`, compactPlan({ id: '05-01', files: ['src/auth/session.js'] }));
    x.commit('docs: auth plan');
  };
  const d = await gatesRig(t, { script: { audits: ['## ESCALATE\n\n**threats_open:** 1\n\n### Open (blocking)\n\n| Threat ID | Category |\n|---|---|\n| T-5-24 | Spoofing |\n'] }, setup: auth });
  const seen = answerCard(t, d.root, 'Go on');
  assert.equal(await runStep(d.ctx, 'security'), 'done');
  assert.equal(seen[0].question, 'Phase 5: the security check found something it cannot close by itself and hands the decision to you. What should the build do?');
  assert.match(seen[0].context, /^Open threats that block the phase: 1\. No fix was tried\./);
  assert.deepEqual(seen[0].details, ['verdict: escalate, threats_open 1', 'blocking: T-5-24', `report: ${REL}/05-SECURITY.md`]);
  assert.equal(seen[0].header, 'Security');
});

// v0.8.1 (live run 2026-11-13: the controller's «Дальше» on a verify card was logged «accepted by the owner»)
test('a Go on from the owner\'s assistant is on record as such: the card names the open goals, the uat skip says who accepted them', async (t) => {
  const gaps = { path: `${REL}/05-VERIFICATION.md`, text: '---\nphase: 05-demo\nstatus: gaps_found\nscore: 1/3 must-haves verified\ngaps:\n  - truth: "the release is live on the server"\n    status: failed\n    reason: "live step not run"\n  - truth: "the keys are rotated"\n    status: failed\n    reason: "live step not run"\n---\n\n# Verification\n' };
  const r = await gatesRig(t, {
    script: { verifications: [gaps] },
    setup: (x) => {
      x.write(`${REL}/05-01-PLAN.md`, compactPlan({ id: '05-01', files: ['src/a.js'], reqs: ['DEMO-01', 'DEMO-02'] }));
      x.write(`${REL}/05-01-SUMMARY.md`, summaryText({ phaseSlug: '05-demo', plan: '05-01' }));
      x.commit('docs: plan and summary');
    },
  });
  const { ctx } = r;
  adoptRound(ctx, { round: 0 });
  for (const s of ['slice', 'build', 'review']) setStep(ctx.state, s, { state: 'done' });
  ctx.state.gapRounds = 1;
  ctx.save();
  const seen = [];
  every(t, () => {
    const q = readQuestions(r.root, '5').find((x) => x.state === 'open');
    if (!q) return false;
    seen.push(q);
    answerQuestion({ root: r.root, phase: '5', id: q.id, option: 2, by: 'agent', laneRunning: true });
    return true;
  });
  assert.equal(await runStep(ctx, 'verify'), 'done');
  assert.match(seen[0].context, /^Goals not met: 2\. Extra rounds of work so far: 1\./);
  assert.deepEqual(seen[0].details, ['score: 1/3 must-haves verified', 'failed: the release is live on the server', 'failed: the keys are rotated', `report: ${REL}/05-VERIFICATION.md`]);
  assert.deepEqual([ctx.state.steps.verify.accepted, ctx.state.steps.verify.acceptedBy], [seen[0].id, 'agent']);
  const log = fs.readFileSync(path.join(r.root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8');
  assert.match(log, /ask-1 \(halt: verify\) answered by the owner's assistant, not by the owner: go on/);
  assert.equal(await runStep(ctx, 'uat'), 'skipped');
  assert.equal(ctx.state.steps.uat.why, `verification gaps accepted by the owner's assistant, not by the owner (2 goal(s) stay open in ${REL}/05-VERIFICATION.md): nothing to check by hand`);
  assert.equal(whoAnswered('pane'), 'by the owner');
  assert.equal(whoAnswered('session'), 'by the owner');
  assert.equal(whoAnswered('auto'), 'by turbo itself');
  assert.equal(whoAnswered(null), 'on its card');
  // the owner's alone stay the owner's: an assistant's answer parks no phase
  assert.throws(() => answerQuestion({ root: r.root, phase: '5', id: 'nope', option: 1, by: 'robot', laneRunning: true }), /unknown channel robot/);
});
