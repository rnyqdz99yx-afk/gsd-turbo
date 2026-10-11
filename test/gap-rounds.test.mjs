import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { UAT } from './fixtures/uat-sample.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { clearAttempts, readProgress } from '../lib/phase-progress.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { GAP_STEPS, gapEvidence, gapRound, gapRounds, uatProblems, verificationGaps } from '../lib/gap-rounds.mjs';

// The gaps of a GSD verification report (agents/gsd-verifier.md, Step 10): nested artifacts and missing lists, quoted
// and plain values, and a deferred list after them.
const LOGIN = ['  - truth: "Login: the form signs in"', '    status: failed', '    reason: "Route returns 500"', '    artifacts:', '      - path: "src/a.ts"', '        issue: "stub"', '    missing:', '      - "real handler"'];
const LOGOUT = ['  - truth: Logout clears the session', '    status: partial', "    reason: 'cookie remains'"];
const report = (gaps, { score = '3/5 must-haves verified' } = {}) => [
  '---', 'phase: 03-demo', 'status: gaps_found', `score: ${score}`, 'covered_files:', '  - src/a.ts',
  ...(gaps.length ? ['gaps:', ...gaps] : []),
  'deferred:', '  - truth: "Addressed in a later phase"', '    addressed_in: "Phase 5"',
  '---', '', '# Phase 3: Demo Verification Report', '', '- truth: not frontmatter', '',
].join('\n');

function project({ config } = {}) {
  const root = tmpDir('gap');
  const dir = path.join(root, '.planning', 'phases', '03-demo');
  fs.mkdirSync(dir, { recursive: true });
  if (config) {
    fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify(config));
  }
  return {
    root, dir,
    verification: (text) => fs.writeFileSync(path.join(dir, '03-VERIFICATION.md'), text),
    uat: (text) => fs.writeFileSync(path.join(dir, '03-UAT.md'), text),
  };
}
const round = (root, step, rounds) => gapRound(root, '3', step, { config: { ...DEFAULTS, ...(rounds === undefined ? {} : { gap_rounds: rounds }) } });

test('gap_rounds: 1 by default; a whole number of 0 or more, a digit string too; anything else is the default (Review Focus 4)', () => {
  assert.equal(DEFAULTS.gap_rounds, 1);
  assert.deepEqual(GAP_STEPS, ['execute', 'uat']);
  const cases = [[3, 3], ['3', 3], [' 2 ', 2], [0, 0], ['0', 0], [undefined, 1], [null, 1], [-1, 1], [2.5, 1], ['x', 1], ['', 1], [true, 1], ['-2', 1]];
  for (const [v, want] of cases) assert.equal(gapRounds({ gap_rounds: v }), want, JSON.stringify(v));
  assert.equal(gapRounds(undefined), 1);
});

test('verificationGaps: the score and each gap\'s status and truth; reasons, nested lists, deferred items and the body never count; CRLF reads the same', () => {
  const want = { score: '3/5 must-haves verified', gaps: [{ status: 'failed', truth: 'Login: the form signs in' }, { status: 'partial', truth: 'Logout clears the session' }] };
  assert.deepEqual(verificationGaps(report([...LOGIN, ...LOGOUT])), want);
  assert.deepEqual(verificationGaps(report([...LOGIN, ...LOGOUT]).replace(/\n/g, '\r\n')), want);
  assert.deepEqual(verificationGaps(report([])), { score: '3/5 must-haves verified', gaps: [] });
  assert.deepEqual(verificationGaps(report(['  - truth: Only a truth'])).gaps, [{ status: 'failed', truth: 'Only a truth' }]);
  assert.equal(verificationGaps('# no frontmatter\n'), null);
  assert.equal(verificationGaps('---\nstatus: gaps_found\n'), null, 'a frontmatter that never closes');
});

test('uatProblems: every UAT row that does not pass, with its result', () => {
  assert.deepEqual(uatProblems(UAT), [
    '1. Settings page shows the saved value: pending', '2. Owner signs the release: pending',
    '3. Page shows the code and an SMS arrives on the phone: pending', '4. Export button downloads a CSV: pending',
  ]);
  assert.deepEqual(uatProblems(UAT.replace(/result: \[pending\]/g, 'result: pass')), []);
});

test('execute gap rounds: the first always runs; rewording the same gaps is no new evidence (Review Focus 3)', () => {
  const p = project();
  p.verification(report([...LOGIN, ...LOGOUT]));
  let r = round(p.root, 'execute', 3);
  assert.deepEqual([r.n, r.max, r.go, r.failing, r.file], [1, 3, true, 2, '03-VERIFICATION.md']);
  // the verifier ran again: other words, CRLF, the same must-haves failed the same way
  p.verification(report([...LOGIN.map((l) => l.replace('Route returns 500', 'The route still answers 500')), ...LOGOUT]).replace(/\n/g, '\r\n'));
  r = round(p.root, 'execute', 3);
  assert.deepEqual([r.n, r.go, r.reason], [2, false, 'no new evidence: round 1 left the same 2 failing item(s) in 03-VERIFICATION.md']);
  assert.equal(readProgress(p.root, '3').attempts.execute, 2, 'counted like every attempt');
});

test('execute gap rounds: a closed gap or a moved score is new evidence; the budget still ends the rounds; the owner\'s resume starts afresh', () => {
  const p = project();
  p.verification(report([...LOGIN, ...LOGOUT]));
  assert.equal(round(p.root, 'execute', 3).go, true);
  p.verification(report(LOGIN, { score: '4/5 must-haves verified' }));
  assert.equal(round(p.root, 'execute', 3).go, true);
  let r = round(p.root, 'execute', 3);
  assert.deepEqual([r.n, r.go, r.reason], [3, false, 'no new evidence: round 2 left the same 1 failing item(s) in 03-VERIFICATION.md']);

  const q = project();
  q.verification(report([...LOGIN, ...LOGOUT]));
  assert.equal(round(q.root, 'execute').go, true, 'default budget 1');
  q.verification(report(LOGIN));
  r = round(q.root, 'execute');
  assert.deepEqual([r.n, r.max, r.go, r.reason], [2, 1, false, 'the gap_rounds budget of 1 is used up across sessions']);
  clearAttempts(q.root, '3');
  r = round(q.root, 'execute');
  assert.deepEqual([r.n, r.go], [1, true], 'the owner\'s resume: a fresh budget');

  const z = project();
  z.verification(report(LOGIN));
  r = round(z.root, 'execute', 0);
  assert.deepEqual([r.n, r.max, r.go, r.reason], [1, 0, false, 'the gap_rounds budget of 0 is used up across sessions']);
});

test('uat gap rounds compare the UAT rows that do not pass; without a result to read, a later round stops', () => {
  const p = project();
  p.uat(UAT);
  assert.equal(gapEvidence(p.root, '3', 'uat').failing, 4);
  assert.equal(round(p.root, 'uat', 3).go, true);
  p.uat(UAT.replace('result: pass', 'result: issue'));
  assert.equal(round(p.root, 'uat', 3).go, true, 'a row failed differently');
  let r = round(p.root, 'uat', 3);
  assert.deepEqual([r.go, r.reason], [false, 'no new evidence: round 2 left the same 5 failing item(s) in 03-UAT.md']);

  const q = project();
  q.verification(report(LOGIN));
  assert.equal(round(q.root, 'execute', 3).go, true);
  fs.rmSync(path.join(q.dir, '03-VERIFICATION.md'));
  r = round(q.root, 'execute', 3);
  assert.deepEqual([r.go, r.reason], [false, 'no result to compare: no VERIFICATION.md for phase 3']);
});

test('turbo-run phase-step N --attempt execute|uat prints the round and its verdict; other attempts print as before', async () => {
  const p = project({ config: { gap_rounds: '2' } });
  p.verification(report(LOGIN));
  const lines = [];
  const run = (...a) => runPhaseCommand('phase-step', a, { root: p.root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) });
  assert.equal(await run('3', '--attempt', 'execute'), 0);
  assert.equal(lines.at(-1), 'attempt execute 1 of 2: go');
  assert.equal(await run('3', '--attempt', 'execute'), 0);
  assert.equal(lines.at(-1), 'attempt execute 2 of 2: stop: no new evidence: round 1 left the same 1 failing item(s) in 03-VERIFICATION.md');
  assert.equal(await run('3', '--attempt', 'uat'), 0);
  assert.equal(lines.at(-1), 'attempt uat 1 of 2: go');
  assert.equal(await run('3', '--attempt', 'fix'), 0);
  assert.equal(lines.at(-1), 'attempt fix 1');
  assert.ok(fs.existsSync(path.join(p.root, '.planning', 'turbo', 'run', 'p3-gap-rounds.json')));
});
