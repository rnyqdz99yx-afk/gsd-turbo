import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STEPS } from '../lib/phase-progress.mjs';

test('turbo-phase skill: frontmatter, every step in order, the commands it drives', () => {
  const s = fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');
  assert.match(s, /^---\nname: turbo-phase\ndescription: .+\nargument-hint: .+\nallowed-tools: \[Bash, Read, Write, Edit, Grep, Glob, Agent, Skill\]\n---\n/);
  let at = -1;
  for (const step of STEPS) {
    const i = s.indexOf(`\n### ${step}\n`);
    assert.ok(i > at, `step ${step} in order`);
    at = i;
  }
  const needles = [
    'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs"',
    'turbo-run phase-step N', 'turbo-run phase-step N --done', 'turbo-run lane-status N paused-context', 'turbo-run lane-status N needs-owner',
    'turbo-run lane-status N done', 'gsd-pause-work', 'turbo-run staleness N --json', 'turbo-run staleness N --record-all',
    'turbo-run gates off N', 'turbo-run gates restore N', 'turbo-run gates docs-off N', 'turbo-run gates docs-restore N', 'turbo-run gates chunked',
    'turbo-run jobs N prologue --json', 'turbo-run jobs N fanout --json', 'turbo-run jobs N outcome --json', 'TURBO_FULL=1 turbo-run test-changed',
    'isolation="worktree"', 'subagent_type="turbo-uat"', 'turbo-run uat owner-request N --json',
    'args="N --no-transition"', 'args="N --gaps-only --no-transition"', 'args="N --chunked"', '--research-phase N', 'discuss-phase-assumptions.md',
    'auto_advance', 'args="N --fix"', 'Verify all open threats', 'gsd-verify-work', 'planner-revision.md', 'ONE message', 'gsd-tools commit',
    'gsd-tools phase uat-passed N --uat-only',
  ];
  for (const n of needles) assert.ok(s.includes(n), n);
  assert.ok(!/gsd-turbo-/.test(s));
});
