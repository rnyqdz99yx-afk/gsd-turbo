import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('uninstall never deletes manifest entries outside the turbo namespace, and reports them', (t) => {
  const root = tmpDir('root');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'skills', 'gsd-help'), { recursive: true });
  fs.mkdirSync(path.join(home, 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outside.txt'), 'x');
  fs.writeFileSync(path.join(home, 'skills', 'gsd-help', 'SKILL.md'), 'gsd');
  fs.writeFileSync(path.join(home, 'turbo', 'owned.txt'), 'turbo');
  const skipped = ['../outside.txt', 'skills/gsd-help/SKILL.md', path.join(root, 'outside.txt'), 'turbo/install-manifest.json'];
  const files = [...skipped, 'turbo/owned.txt'];
  fs.writeFileSync(path.join(home, 'turbo', 'install-manifest.json'), JSON.stringify({ version: '0.0.0', installedAt: '', files }));
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  assert.equal(uninstall({ claudeHome: home }), 1);
  const reported = stderr.mock.calls.map((c) => String(c.arguments[0]));
  assert.equal(reported.length, skipped.length);
  for (const rel of skipped) assert.ok(reported.some((l) => l.includes(JSON.stringify(rel))), `not reported: ${rel}`);
  assert.ok(fs.existsSync(path.join(root, 'outside.txt')));
  assert.ok(fs.existsSync(path.join(home, 'skills', 'gsd-help', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(home, 'turbo')));
});

test('uninstall dry-run returns the count it would remove and changes nothing', () => {
  const home = tmpDir('home');
  const m = install({ repoDir: path.resolve('.'), claudeHome: home });
  const snapshot = () => fs.readdirSync(home, { recursive: true }).map(String).sort();
  const before = snapshot();
  assert.equal(uninstall({ claudeHome: home, dryRun: true }), m.files.length);
  assert.deepEqual(snapshot(), before);
});

test('a partially failed install leaves a manifest that uninstalls the copied files', (t) => {
  const home = tmpDir('home');
  fs.mkdirSync(path.join(home, 'turbo', 'package.json'), { recursive: true });
  assert.throws(() => install({ repoDir: path.resolve('.'), claudeHome: home }));
  const mf = path.join(home, 'turbo', 'install-manifest.json');
  assert.ok(fs.existsSync(mf));
  const copied = JSON.parse(fs.readFileSync(mf, 'utf8')).files.filter((f) => /^turbo\/(bin|lib)\//.test(f));
  assert.ok(copied.length > 0 && copied.every((f) => fs.existsSync(path.join(home, f))));
  t.mock.method(process.stderr, 'write', () => true);
  assert.equal(uninstall({ claudeHome: home }), copied.length);
  assert.ok(copied.every((f) => !fs.existsSync(path.join(home, f))));
  assert.ok(!fs.existsSync(mf));
  assert.ok(fs.existsSync(home));
});

test('uninstall without a manifest says so; a corrupt manifest is a one-line error that names it', () => {
  const home = tmpDir('home');
  const cli = (...args) => spawnSync(process.execPath, [path.resolve('install.mjs'), ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: home }, encoding: 'utf8' });
  assert.equal(uninstall({ claudeHome: home }), null);
  for (const args of [['--uninstall'], ['--uninstall', '--dry-run']]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '');
    assert.equal(r.stderr.trim(), `no gsd-turbo install manifest in ${home}`);
  }

  const mf = path.join(home, 'turbo', 'install-manifest.json');
  fs.mkdirSync(path.dirname(mf), { recursive: true });
  for (const text of ['{"version": ', 'null']) {
    fs.writeFileSync(mf, text);
    const want = (msg) => msg.startsWith(`invalid install manifest ${mf}: `) && msg.endsWith('; delete it to reinstall');
    assert.throws(() => uninstall({ claudeHome: home }), (e) => want(e.message), text);
    assert.throws(() => install({ repoDir: path.resolve('.'), claudeHome: home }), (e) => want(e.message), text);
    for (const args of [['--uninstall'], []]) {
      const r = cli(...args);
      assert.equal(r.status, 1, `${text} ${args}`);
      assert.equal(r.stderr.trim().split(/\r?\n/).length, 1, r.stderr);
      assert.ok(want(r.stderr.trim()), r.stderr);
    }
  }
  assert.deepEqual(fs.readdirSync(path.join(home, 'turbo')), ['install-manifest.json']);
});

test('CLI runs through a linked path, rejects unknown args, and uninstall --dry-run deletes nothing', (t) => {
  const root = tmpDir('install-cli');
  const repo = path.join(root, 'repo');
  for (const p of ['install.mjs', 'package.json', 'bin', 'lib', 'skills']) fs.cpSync(path.resolve(p), path.join(repo, p), { recursive: true });
  const link = path.join(root, 'link');
  fs.symlinkSync(repo, link, 'junction');
  t.after(() => fs.unlinkSync(link));
  const home = path.join(root, 'home');
  const run = (...args) => spawnSync(process.execPath, [path.join(link, 'install.mjs'), ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: home }, encoding: 'utf8' });
  let r = run('--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^would install gsd-turbo /);
  assert.ok(!fs.existsSync(home));
  r = run('--uninstal');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node install\.mjs \[--uninstall\] \[--dry-run\]/);
  assert.ok(!fs.existsSync(home));
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^installed gsd-turbo /);
  r = run('--uninstall', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^would remove \d+ files/);
  assert.ok(fs.existsSync(path.join(home, 'turbo', 'install-manifest.json')));
  r = run('--uninstall');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^removed \d+ files/);
  assert.ok(!fs.existsSync(path.join(home, 'turbo')));
});
