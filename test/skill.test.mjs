import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('turbo-autonomous skill frontmatter and required steps', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  assert.match(s, /^---\nname: turbo-autonomous\ndescription: .+\n/);
  for (const needle of ['turbo-run.mjs" doctor', 'turbo-run.mjs" init', 'turbo-run.mjs" start', 'turbo-run.mjs" status', 'claude attach', 'git status --porcelain']) assert.ok(s.includes(needle), needle);
  assert.ok(!/gsd-turbo-/.test(s));
});

test('turbo-autonomous skill honours CLAUDE_CONFIG_DIR and resumes with one command', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  assert.ok(s.includes('node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs"'), 'CLAUDE_CONFIG_DIR path form');
  assert.ok(!s.includes('"$HOME/.claude/turbo'), 'no bare $HOME/.claude/turbo path');
  assert.ok(s.includes('turbo-run.mjs" resume <phase> --start'), 'resume <phase> --start');
  assert.ok(s.includes('.planning/turbo/'), 'commits the new .planning/turbo/ files');
});
