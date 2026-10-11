import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RELEASE_RULE } from '../lib/lane-prompt.mjs';

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

test('turbo-autonomous skill passes the range flags to start and stops a lane on an unexpected phase', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  const hint = /^argument-hint: (.+)$/m.exec(s)[1];
  for (const f of ['--from <N>', '--to <N>', '--only <N>', '--all']) assert.ok(hint.includes(f), f);
  const at = s.indexOf('turbo-run.mjs" start <range flags>');
  assert.ok(at > s.indexOf('## Otherwise'), 'start gets the range flags');
  assert.match(s.slice(at), /not the phase the user expected[^\n]*turbo-run\.mjs" stop` at once/);
});

test('turbo-autonomous skill never sleeps and covers "no lane yet" and "not running" after start', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  assert.ok(!/\bwait\b[^.\n]*\bseconds\b/i.test(s), 'no foreground wait');
  const after = s.slice(s.indexOf('turbo-run.mjs" start'));
  assert.ok(after.includes('`lane:`') && after.includes('poll_seconds'), 'no lane yet: first phase starts within poll_seconds');
  assert.ok(after.includes('not running') && after.includes('.planning/turbo/logs/supervisor.log'), 'not running: show the log tail');
  assert.ok(s.includes('how to enable targeted tests'), 'init output: test command set, or how to enable targeted tests');
});

test('turbo-autonomous skill answers the open questions (S1): AskUserQuestion in batches of 4, recommended first, turbo-run answer --by session --rev; at start and while a run goes', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  assert.match(s, /^allowed-tools: \[Bash, Read, AskUserQuestion, Skill\]$/m);
  assert.match(s, /^argument-hint: ".*\| answer"$/m);
  const needles = [
    '## If the arguments are `answer`', '## Answer the open questions', 'turbo-run.mjs" questions --open --json', 'up to 4 questions per call', ' (Recommended)', 'Not now',
    'turbo-run.mjs" answer <phase> <id> --option <k> --by session --rev <rev>', "--text '<the words>' --by session --rev <rev>",
    '`already answered: …`', '`changed: …`', '`refused: …`', '`stopped: true` first', '`.planning/turbo/answers/`',
  ];
  for (const n of needles) assert.ok(s.includes(n), n);
  const start = s.slice(s.indexOf('## Otherwise'), s.indexOf('## Answer the open questions'));
  assert.ok(start.includes('**Answer the open questions**'), 'the start flow asks the open questions');
  const running = start.slice(start.indexOf('supervisor: running'));
  assert.ok(running.indexOf('**Answer the open questions**') < running.indexOf('**Compatibility.**'), 'also while a run goes');
});

test('turbo-autonomous attend <phase> (S4): take over the lane, questions up front, GSD execute-phase one plan at a time in this checkout, hand back', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  assert.match(s, /^argument-hint: ".*\| resume <phase> \| attend <phase> \| answer"$/m);
  const at = s.indexOf('## If the arguments are `attend <phase>`');
  assert.ok(at > s.indexOf('## If the arguments are `answer`') && at < s.indexOf('## Otherwise'), 'its own section before the start flow');
  const a = s.slice(at, s.indexOf('## Otherwise'));
  const order = [
    'turbo-run.mjs" attend <phase>', 'turbo-run.mjs" doctor', 'git worktree list --porcelain', 'turbo-run.mjs" questions <N>',
    '**Answer the open questions**', 'turbo-run.mjs" gates off <N>', 'Skill(skill="gsd-execute-phase", args="<N> --no-transition")',
    'turbo-run.mjs" state-sync <N>', 'turbo-run.mjs" attend <N> --done',
  ];
  let last = -1;
  for (const n of order) {
    const i = a.indexOf(n);
    assert.ok(i > last, `in order: ${n}`);
    last = i;
  }
  const needles = [
    'isolation="worktree"', 'query dispatch-isolation --raw --phase', '--plan <the plan id> --force-isolation none', 'before each retry',
    'questions <N> --preanswers <plan id>', '`human-action`', RELEASE_RULE, 'never kill or stop that process', '`gap_rounds`',
    'resume <N> --start', 'Commit nothing and remove no worktree on your own',
  ];
  for (const n of needles) assert.ok(a.includes(n), n);
});

test('turbo-autonomous attend: GSD\'s gates follow the gates: line of turbo-run attend, never the session\'s judgment (F1)', () => {
  const s = fs.readFileSync('skills/turbo-autonomous/SKILL.md', 'utf8');
  const a = s.slice(s.indexOf('## If the arguments are `attend <phase>`'), s.indexOf('## Otherwise'));
  const five = a.slice(a.indexOf('5. **GSD\'s gates.**'), a.indexOf('6. **Execute.**'));
  for (const n of ['`gates: turn off`', '`gates: keep on`', 'gates off <N>', 'run no `gates` command', 'never decide this yourself']) assert.ok(five.includes(n), n);
  assert.ok(five.indexOf('`gates: turn off`') < five.indexOf('gates off <N>') && five.indexOf('gates off <N>') < five.indexOf('`gates: keep on`'), 'gates off only under turn off');
  assert.ok(!a.includes('as a lane does before it executes; the lane runs those gates in parallel after the hand-back'), 'no unconditional claim');
});
