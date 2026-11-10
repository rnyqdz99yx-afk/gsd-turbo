import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { laneSystemPrompt } from '../lib/lane-prompt.mjs';
import { fanoutJobs, prologueJobs } from '../lib/phase-jobs.mjs';
import { sha256, stripLean } from './helpers/lean.mjs';

// Stage 6 L2, Review Focus 1: with lean off every skill line, lane prompt and job list stays stage-5's. The fixture was
// written once on the stage-5 code (GOLDEN_WRITE=1); every later change must keep it.
const FIXTURE = 'test/fixtures/lean-off-golden.json';
const step = (capId, ref = {}) => ({ kind: 'step', capId, ref });
const safe = { phase: '3', turboRun: 'node /t/turbo-run.mjs', contextPct: 55, autonomy: 'standard' };
const PROMPTS = {
  safe,
  full: { ...safe, mode: 'full', tmpDir: '/tmp/lane-3', pushMode: 'after-wave', slots: true },
  max: { ...safe, mode: 'full', autonomy: 'max' },
};
const P = { phase: '3', hooks: [step('research'), step('ui'), step('ai-integration'), step('intel', { command: 'intel api-surface' })], artifacts: { plans: [] }, frontend: true, goal: 'an LLM agent' };
const F = { phase: '3', active: ['security', 'ui', 'code-review', 'nyquist'], artifacts: { uiSpec: '03-UI-SPEC.md' } };

// Deliberate changes of the lean-off text since stage 5, per skill [now, stage-5's]: each is put back before the hash,
// so the fixture stays stage-5's and every other line stays pinned. v0.5.1: the fan-out commit names the gates that ran;
// v0.7.0: the inbox's note messages.
const SINCE_STAGE5 = {
  'turbo-phase': [[
    '`gsd-tools commit "docs(phase-N): gate fan-out (<gates>)" --files <each of the phase\'s SECURITY.md, UI-REVIEW.md and REVIEW.md that exists>`, where `<gates>` names only the read-only gates point 3 ran, in this order: `security`, `UI review`, `code review`, comma-separated (only the code review ran: `docs(phase-N): gate fan-out (code review)`).',
    '`gsd-tools commit "docs(phase-N): gate fan-out (security, UI review, code review)" --files <each of the phase\'s SECURITY.md, UI-REVIEW.md and REVIEW.md that exists>`.',
  ], [
    // v0.7.0: note messages in the inbox (turbo-run note, a parked phase, the main branch moved)
    " `note` messages → information for this phase, from the owner (`turbo-run note`) or from turbo (a phase this one depends on is parked: it started without that phase's work). Take each into account in every later step, and put it in the prompt of every subagent you dispatch after it (planner, checker, executors, fixer) under a heading \"Notes for this phase\"; the plan and the owner's answers still decide. A note that says the main branch already holds a fix or a change: run step **integrate** before acting on anything it touches.",
    '',
  ]],
};
const skill = (name) => {
  let text = stripLean(fs.readFileSync(`skills/${name}/SKILL.md`, 'utf8'));
  for (const [now, was] of SINCE_STAGE5[name] ?? []) {
    assert.equal(text.split(now).length, 2, `${name}: the v0.5.1 line appears once`);
    text = text.replace(now, () => was);
  }
  return sha256(text);
};
const prompts = (extra) => Object.fromEntries(Object.entries(PROMPTS).map(([k, v]) => [k, sha256(laneSystemPrompt({ ...v, ...extra }))]));
const current = () => ({ turboPhase: skill('turbo-phase'), turboPrep: skill('turbo-prep'), lanePrompts: prompts({}), prologue: prologueJobs(P), fanout: fanoutJobs(F) });

test('lean-off golden: the skills without their Lean text, the lane prompts and the job lists are stage-5 byte for byte', () => {
  if (process.env.GOLDEN_WRITE === '1') {
    if (fs.existsSync(FIXTURE)) throw new Error(`${FIXTURE} exists: the golden is written once, on the stage-5 code`);
    fs.writeFileSync(FIXTURE, `${JSON.stringify(current(), null, 2)}\n`);
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(current(), fixture);
  assert.deepEqual(prompts({ lean: false }), fixture.lanePrompts);
});
