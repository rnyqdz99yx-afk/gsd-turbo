import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { install, uninstall } from '../install.mjs';

test('install ships the stage-2 skill, agent and libraries under turbo-* names only', () => {
  const home = tmpDir('home');
  const m = install({ repoDir: path.resolve('.'), claudeHome: home, dryRun: false });
  assert.equal(m.version, '0.2.2');
  for (const f of ['skills/turbo-phase/SKILL.md', 'agents/turbo-uat.md', 'turbo/lib/cli-phase.mjs', 'turbo/lib/staleness.mjs', 'turbo/lib/gates.mjs', 'turbo/lib/uat.mjs', 'turbo/lib/uat-stand.mjs']) {
    assert.ok(m.files.includes(f), f);
    assert.ok(fs.existsSync(path.join(home, f)), f);
  }
  assert.ok(m.files.every((f) => /^(turbo\/|skills\/turbo-|agents\/turbo-)/.test(f)), 'turbo namespace only');
  assert.equal(uninstall({ claudeHome: home }), m.files.length);
  assert.ok(!fs.existsSync(path.join(home, 'agents', 'turbo-uat.md')));
});
