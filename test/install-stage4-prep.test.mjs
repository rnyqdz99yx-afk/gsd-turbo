import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { install, uninstall } from '../install.mjs';

test('install ships the prep skills, the lane analyst and their libraries; uninstall removes them with their directories', () => {
  const home = tmpDir('home');
  const m = install({ repoDir: path.resolve('.'), claudeHome: home });
  const files = [
    'skills/turbo-prep/SKILL.md', 'skills/turbo-plan-milestone/SKILL.md', 'skills/turbo-new-milestone/SKILL.md', 'agents/turbo-lane-analyst.md',
    'turbo/lib/prep.mjs', 'turbo/lib/lanes-file.mjs', 'turbo/lib/roadmap-lanes.mjs', 'turbo/lib/annotate.mjs', 'turbo/lib/cli-jobs.mjs',
  ];
  for (const f of files) {
    assert.ok(m.files.includes(f), f);
    assert.ok(fs.existsSync(path.join(home, f)), f);
  }
  assert.equal(uninstall({ claudeHome: home }), m.files.length);
  for (const f of files) assert.ok(!fs.existsSync(path.join(home, f)), f);
  for (const d of ['skills/turbo-prep', 'skills/turbo-plan-milestone', 'skills/turbo-new-milestone']) assert.ok(!fs.existsSync(path.join(home, d)), d);
});
