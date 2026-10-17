import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('turbo-plan-milestone: frontmatter, the checks before start, start --plan-only with the range flags', () => {
  const s = fs.readFileSync('skills/turbo-plan-milestone/SKILL.md', 'utf8');
  assert.match(s, /^---\nname: turbo-plan-milestone\ndescription: .+\nargument-hint: "\[--from <N>\] \[--to <N>\] \| --only <N> \| --all"\nallowed-tools: \[Bash, Read, AskUserQuestion, Skill\]\n---\n/);
  const order = ['turbo-run status', 'supervisor: running', 'turbo-run doctor', 'mode: safe', 'points 3 and 4', '`lanes.mode`', 'turbo-run start --plan-only <range flags>', '.planning/turbo/logs/supervisor.log'];
  let last = -1;
  for (const n of order) {
    const i = s.indexOf(n, last + 1);
    assert.ok(i > last, `in order: ${n}`);
    last = i;
  }
  for (const n of ['node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs"', '`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/turbo-autonomous/SKILL.md`', '`checkout`', 'no phase is planned or executed', '/turbo-autonomous']) assert.ok(s.includes(n), n);
});

test('turbo-new-milestone: gsd-new-milestone with the user, then turbo-plan-milestone; never while a run goes', () => {
  const s = fs.readFileSync('skills/turbo-new-milestone/SKILL.md', 'utf8');
  assert.match(s, /^---\nname: turbo-new-milestone\ndescription: .+\nargument-hint: .+\nallowed-tools: \[Bash, Read, Write, Edit, Grep, Glob, Agent, AskUserQuestion, Skill\]\n---\n/);
  const a = s.indexOf('supervisor: running');
  const b = s.indexOf('Skill(skill="gsd-new-milestone"');
  const c = s.indexOf('Skill(skill="turbo-plan-milestone")');
  assert.ok(a > 0 && b > a && c > b, 'status, then GSD, then the plan');
  assert.ok(s.includes('nothing is prepared'));
});

test('Stage 6 §5.5: both skills prepare the next prep.lookahead phases and mark up only when three or more phases are independent', () => {
  for (const f of ['skills/turbo-plan-milestone/SKILL.md', 'skills/turbo-new-milestone/SKILL.md']) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(s.includes('prep.lookahead'), f);
    assert.ok(s.includes('three or more phases are independent'), f);
  }
});
