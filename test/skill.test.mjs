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
  assert.ok(!s.includes('`TURBO`'), 'no unused TURBO alias');
});

test('turbo-autonomous skill never commits during a run and commits only the setup files', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  const start = s.slice(s.indexOf('## Otherwise'));
  const status = start.indexOf('turbo-run.mjs" status');
  const porcelain = start.indexOf('git status --porcelain');
  assert.ok(status >= 0 && porcelain > status, 'the running check comes before any commit step');
  assert.ok(start.includes('supervisor: running'), 'stops when the supervisor is already running');
  const commit = start.slice(porcelain);
  for (const f of ['`.planning/turbo/config.json`', '`.planning/turbo/.gitignore`', '`.planning/config.json`']) assert.ok(commit.includes(f), `setup file ${f}`);
  assert.ok(commit.indexOf('git status --porcelain', 1) > 0, 'a final clean-tree check after the commit');
});

test('turbo-autonomous skill never sleeps and covers "no lane yet" and "not running" after start', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  assert.ok(!/\bwait\b[^.\n]*\bseconds\b/i.test(s), 'no foreground wait');
  const after = s.slice(s.indexOf('turbo-run.mjs" start'));
  assert.ok(after.includes('`lane:`') && after.includes('poll_seconds'), 'no lane yet: first phase starts within poll_seconds');
  assert.ok(after.includes('not running') && after.includes('.planning/turbo/logs/supervisor.log'), 'not running: show the log tail');
  assert.ok(s.includes('how to enable targeted tests'), 'init output: test command set, or how to enable targeted tests');
});
