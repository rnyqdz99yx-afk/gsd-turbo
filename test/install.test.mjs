import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { install, uninstall } from '../install.mjs';

test('install copies runtime + skills and writes a manifest; uninstall removes only those files', () => {
  const home = tmpDir('home');
  fs.mkdirSync(path.join(home, 'skills', 'gsd-help'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'gsd-help', 'SKILL.md'), 'gsd');
  const m = install({ repoDir: path.resolve('.'), claudeHome: home, dryRun: false });
  assert.ok(fs.existsSync(path.join(home, 'turbo', 'bin', 'turbo-run.mjs')));
  assert.ok(fs.existsSync(path.join(home, 'turbo', 'lib', 'supervisor.mjs')));
  assert.ok(fs.existsSync(path.join(home, 'skills', 'turbo-autonomous', 'SKILL.md')));
  assert.ok(m.files.every((f) => !f.includes('gsd-')));
  const removed = uninstall({ claudeHome: home });
  assert.equal(removed, m.files.length);
  assert.ok(!fs.existsSync(path.join(home, 'turbo', 'bin')));
  assert.ok(fs.existsSync(path.join(home, 'skills', 'gsd-help', 'SKILL.md')));
});

test('dry-run writes nothing', () => {
  const home = tmpDir('home');
  const m = install({ repoDir: path.resolve('.'), claudeHome: home, dryRun: true });
  assert.ok(m.files.length > 0);
  assert.equal(fs.readdirSync(home).length, 0);
});

test('uninstall never deletes manifest entries outside the turbo namespace', () => {
  const root = tmpDir('root');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'skills', 'gsd-help'), { recursive: true });
  fs.mkdirSync(path.join(home, 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside.txt'), 'x');
  fs.writeFileSync(path.join(home, 'skills', 'gsd-help', 'SKILL.md'), 'gsd');
  fs.writeFileSync(path.join(home, 'turbo', 'owned.txt'), 'turbo');
  const files = ['../outside.txt', 'skills/gsd-help/SKILL.md', path.join(root, 'outside.txt'), 'turbo/owned.txt'];
  fs.writeFileSync(path.join(home, 'turbo', 'install-manifest.json'), JSON.stringify({ version: '0.0.0', installedAt: '', files }));
  assert.equal(uninstall({ claudeHome: home }), 1);
  assert.ok(fs.existsSync(path.join(root, 'outside.txt')));
  assert.ok(fs.existsSync(path.join(home, 'skills', 'gsd-help', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(home, 'turbo')));
});
