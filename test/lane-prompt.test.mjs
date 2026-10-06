import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laneSystemPrompt, laneUserPrompt } from '../lib/lane-prompt.mjs';

test('system prompt carries rules, no double quotes or percent signs', () => {
  const s = laneSystemPrompt({ phase: '3', turboRun: 'node /h/.claude/turbo/bin/turbo-run.mjs', contextPct: 55, autonomy: 'standard' });
  for (const needle of ['AskUserQuestion', 'lane-status 3 done', 'lane-status 3 needs-owner', 'lane-status 3 paused-context', 'gsd-pause-work', 'Playwright', 'force-push', '55 percent']) assert.ok(s.includes(needle), needle);
  assert.ok(!s.includes('"') && !s.includes('%'));
  assert.ok(!s.includes('deploy'));
  assert.ok(laneSystemPrompt({ phase: '3', turboRun: 'x', contextPct: 55, autonomy: 'max' }).includes('deploy'));
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
