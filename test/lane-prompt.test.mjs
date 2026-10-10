import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneSystemPrompt, laneUserPrompt } from '../lib/lane-prompt.mjs';

test('system prompt carries rules, no double quotes or percent signs', () => {
  const s = laneSystemPrompt({ phase: '3', turboRun: 'node /h/.claude/turbo/bin/turbo-run.mjs', contextPct: 55, autonomy: 'standard' });
  for (const needle of ['AskUserQuestion', 'lane-status 3 done', 'lane-status 3 needs-owner', 'lane-status 3 paused-context', 'gsd-pause-work', 'Playwright', 'force-push', '55 percent']) assert.ok(s.includes(needle), needle);
  assert.ok(!s.includes('"') && !s.includes('%'));
});

test('temporary files, stands and data copies go under the lane\'s temp directory, never the system temp directory', () => {
  for (const mode of ['safe', 'full']) {
    const s = laneSystemPrompt({ phase: '3', turboRun: 'x', contextPct: 55, autonomy: 'standard', mode, tmpDir: 'C:\\p\\.planning\\turbo\\run\\tmp\\p3' });
    const rule = s.split('\n').find((l) => l.includes('C:/p/.planning/turbo/run/tmp/p3'));
    assert.ok(rule, mode);
    assert.match(rule, /stands/);
    assert.match(rule, /never \/tmp or the system temp directory/);
    assert.ok(!s.includes('"') && !s.includes('%'), mode);
  }
});

// spec 6.2: with autonomy standard, deploying is the owner's (class D); max deploys itself
test('standard reserves deploying for the owner; max deploys with safeguards', () => {
  const OWNER_DEPLOY = 'deploying to any server or environment outside this machine';
  const SAFEGUARDS = 'snapshot or backup first';
  const standard = laneSystemPrompt({ phase: '3', turboRun: 'x', contextPct: 55, autonomy: 'standard' });
  const max = laneSystemPrompt({ phase: '3', turboRun: 'x', contextPct: 55, autonomy: 'max' });
  const needsOwner = (s) => s.split('\n').find((l) => l.includes('lane-status 3 needs-owner'));
  assert.ok(needsOwner(standard).includes(OWNER_DEPLOY));
  assert.ok(!standard.includes(SAFEGUARDS));
  assert.ok(max.includes(SAFEGUARDS));
  assert.ok(!max.includes(OWNER_DEPLOY));
  for (const s of [standard, max]) assert.ok(!s.includes('"') && !s.includes('%'));
});

test('user prompt runs gsd-autonomous --only N; resume variant mentions handoff', () => {
  assert.match(laneUserPrompt({ phase: '3' }), /gsd-autonomous.*--only 3/);
  assert.match(laneUserPrompt({ phase: '3', resume: true }), /HANDOFF/);
  assert.ok(!laneUserPrompt({ phase: '3', resume: true }).includes('"'));
});

// claude --bg gets the prompts as plain argv values with no `--` separator, so a leading
// dash would be parsed as an option.
test('prompts never start with a dash, whatever the inputs', () => {
  for (const autonomy of ['standard', 'max']) {
    assert.ok(!laneSystemPrompt({ phase: '-3', turboRun: '--x', contextPct: 55, autonomy }).startsWith('-'), autonomy);
  }
  for (const resume of [false, true]) assert.ok(!laneUserPrompt({ phase: '-3', resume }).startsWith('-'), String(resume));
});
