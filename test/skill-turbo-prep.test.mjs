import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PREP_STEPS } from '../lib/phase-progress.mjs';

const prep = () => fs.readFileSync('skills/turbo-prep/SKILL.md', 'utf8');
const phase = () => fs.readFileSync('skills/turbo-phase/SKILL.md', 'utf8');

test('turbo-prep: frontmatter, /turbo-phase\'s three steps by reference, its own statuses', () => {
  const s = prep();
  assert.match(s, /^---\nname: turbo-prep\ndescription: .+\nargument-hint: "<phase> \[--resume\]"\nallowed-tools: \[Bash, Read, Write, Edit, Grep, Glob, Agent, Skill\]\n---\n/);
  const needles = [
    'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs"', '`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/turbo-phase/SKILL.md`',
    'turbo-run phase-step <that token> --prep', 'turbo-run phase-step N --prep --done', 'mode: full', 'turbo-run context N',
    '`turbo-run gates chunked`', '`gsdTools`', 'turbo-run gates docs-restore N',
    'turbo-run lane-status N prepped --job prep', 'turbo-run lane-status N failed --job prep', 'turbo-run lane-status N paused-context --job prep',
    'git cat-file -e <sha>:<path>', 'git checkout <sha> -- <path>', 'git rm -q -- <path>', 'never `turbo-run ask`',
  ];
  for (const n of needles) assert.ok(s.includes(n), n);
  assert.ok(s.includes(PREP_STEPS.map((x) => `**${x}**`).join(', ').replace(/, (\*\*[a-z]+\*\*)$/, ' and $1')), 'names the three steps in order');
  for (const banned of ['args="N --chunked"', 'gsd-execute-phase', 'turbo-run ask N', 'needs-owner --job', 'git push', 'gsd-turbo-']) assert.ok(!s.includes(banned), banned);
});

test('turbo-prep skill (lean): its sections follow the Lean mode section when phase-step --prep prints lean: on', () => {
  const s = prep().replace(/\r\n/g, '\n');
  const conv = s.slice(s.indexOf('\n## Conventions\n'), s.indexOf('\n## Changes for prep\n')).split('\n');
  const line = conv.find((l) => l.startsWith('- **Lean:** '));
  for (const n of ['`turbo-run phase-step N --prep`', '`lean: on`', '**Lean mode**', '**Finish**']) assert.ok(line?.includes(n), n);
  assert.ok(conv.indexOf(line) === conv.findIndex((l) => l.startsWith('- The steps are')) + 1, 'right after the bullet on /turbo-phase\'s steps');
  assert.ok(phase().includes('\n## Lean mode\n'), 'the section it names exists');
});

test('turbo-prep relies on /turbo-phase sections that exist and say what prep overrides', () => {
  const p = phase();
  for (const step of PREP_STEPS) assert.ok(p.includes(`\n### ${step}\n`), `turbo-phase has ### ${step}`);
  const prologue = p.slice(p.indexOf('\n### prologue\n'), p.indexOf('\n### plan\n'));
  assert.match(prologue, /^1\. `turbo-run gates chunked`/m, 'prologue point 1 is gates chunked');
  assert.match(prologue, /^4\. .*`gsdTools`/m, 'prologue point 4 runs the gsdTools jobs');
  assert.ok(p.includes('## Conventions'));
});
