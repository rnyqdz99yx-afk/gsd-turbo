import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { install, modNote, uninstall } from '../install.mjs';

const MOD_FILES = ['skills/turbo-view/.claude-plugin/plugin.json', 'skills/turbo-view/hooks/hooks.json', 'skills/turbo-view/hooks/register.mjs', 'skills/turbo-view/hooks/view-model.mjs'];
const modFiles = (m) => m.files.filter((f) => f.startsWith('skills/turbo-view/')).sort();

test('on Claude Code 2.1.290 or newer the turbo-view mod goes to skills/turbo-view without its tests; uninstall removes it', () => {
  const home = tmpDir('home');
  const m = install({ repoDir: path.resolve('.'), claudeHome: home, claudeVersion: '2.1.296 (Claude Code)' });
  assert.deepEqual(modFiles(m), MOD_FILES);
  for (const f of MOD_FILES) assert.ok(fs.existsSync(path.join(home, f)), f);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'turbo-view', 'hooks', 'register.test.tsx')), false);
  assert.equal(uninstall({ claudeHome: home }), m.files.length);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'turbo-view')), false);
});

test('an older or unknown Claude Code gets no mod, and install says why', () => {
  for (const claudeVersion of ['2.1.289 (Claude Code)', null, 'garbage']) {
    const m = install({ repoDir: path.resolve('.'), claudeHome: tmpDir('home'), dryRun: true, claudeVersion });
    assert.deepEqual(modFiles(m), [], String(claudeVersion));
  }
  assert.equal(modNote('2.1.290 (Claude Code)'), null);
  assert.equal(modNote('2.1.289 (Claude Code)'), 'turbo-view mod not installed: Claude Code 2.1.289 (Claude Code) is older than 2.1.290; turbo-run status --watch shows the run instead');
  assert.equal(modNote(null), 'turbo-view mod not installed: the Claude Code version is unknown (claude --version failed); turbo-run status --watch shows the run instead');
});

test('files Claude Code writes into a mod loaded with --plugin-dir, and harness tests, are never installed', () => {
  const repo = tmpDir('repo');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/types/claude-code/index.d.ts', 'tsconfig.json', 'hooks/hooks.json', 'hooks/register.mjs', 'hooks/register.test.tsx', 'hooks/x.test.ts']) {
    fs.mkdirSync(path.dirname(path.join(repo, 'mod', f)), { recursive: true });
    fs.writeFileSync(path.join(repo, 'mod', f), 'x');
  }
  const m = install({ repoDir: repo, claudeHome: tmpDir('home'), dryRun: true, claudeVersion: '2.2.0' });
  assert.deepEqual(modFiles(m), ['skills/turbo-view/.claude-plugin/plugin.json', 'skills/turbo-view/hooks/hooks.json', 'skills/turbo-view/hooks/register.mjs']);
});
