import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { install, uninstall } from '../install.mjs';

const skill = () => fs.readFileSync('skills/turbo-adopt/SKILL.md', 'utf8');

test('turbo-adopt: frontmatter with Agent and AskUserQuestion, no Skill; the full turbo-run form', () => {
  const s = skill();
  assert.match(s, /^---\nname: turbo-adopt\ndescription: .+\nargument-hint: ""\nallowed-tools: \[Bash, Read, Agent, AskUserQuestion\]\n---\n/);
  assert.ok(!/allowed-tools: .*Skill/.test(s));
  assert.ok(s.includes('`turbo-run` means `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs"`; always run that full form'));
});

test('turbo-adopt: the six points in order, one batch of questions, ONE confirmation, re-checks only through verifier_dispatch', () => {
  const s = skill();
  const points = ['1. **Check.**', '2. **Markup.**', '3. **Questions.**', '4. **Changes.**', '5. **Re-verify**', '6. **Apply.**'];
  const at = points.map((p) => s.indexOf(p));
  assert.ok(at.every((i) => i > 0), points.filter((p, i) => at[i] < 0).join(', '));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order');
  for (const n of [
    'turbo-run adopt scan --lang', 'turbo-run annotate brief', 'subagent_type="turbo-lane-analyst"', 'Ask every question of its `questions` in ONE AskUserQuestion call',
    'section **Answer the open questions** of the turbo-autonomous skill', '"Other" means the question is asked again', 'turbo-run adopt plan --answers',
    'Ask ONE AskUserQuestion: apply these changes in one commit', 'Cancel, or "Other": say nothing was changed and stop',
    'make only the Agent call of step `verifier_dispatch`', 'Skip its hooks, code review and regression gate', 'one at a time', 'at most 3 at a time',
    '`reverify pending:`', 'turbo-run adopt reverify <N>', 'left by the verifier', 'turbo-run adopt apply --answers <the same> --plan-sha',
    'Do not run that command.',
  ]) assert.ok(s.includes(n), n);
});

test('turbo-adopt never starts the run: start, resume, /turbo-autonomous and GSD phase commands appear only where the skill forbids them', () => {
  const lines = skill().split('\n').filter((l) => /turbo-run start|turbo-run resume|(^|[\s`(])\/(turbo-autonomous|gsd-)/.test(l));
  assert.ok(lines.length >= 1);
  // the description names the command the report ends with, and says the skill does not run it
  for (const l of lines) assert.match(l, /Never start the supervisor, a lane or a GSD phase command here: do not run|^description: .*the \/turbo-autonomous command\. Does not start the run\.$/, l);
});

test('install ships skills/turbo-adopt and the adopt libraries; uninstall removes them', () => {
  const home = tmpDir('home');
  const m = install({ repoDir: path.resolve('.'), claudeHome: home });
  const files = ['skills/turbo-adopt/SKILL.md', 'turbo/lib/adopt.mjs', 'turbo/lib/adopt-forecast.mjs', 'turbo/lib/cli-adopt.mjs', 'turbo/lib/project-init.mjs'];
  for (const f of files) {
    assert.ok(m.files.includes(f), f);
    assert.ok(fs.existsSync(path.join(home, f)), f);
  }
  assert.equal(uninstall({ claudeHome: home }), m.files.length);
  for (const f of files) assert.ok(!fs.existsSync(path.join(home, f)), f);
  assert.ok(!fs.existsSync(path.join(home, 'skills', 'turbo-adopt')));
});
