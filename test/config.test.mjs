import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { DEFAULTS, loadConfig, initConfig, deepMerge, fullEntries, pushSettings } from '../lib/config.mjs';
import { findProjectRoot, turboDir, claudeHome } from '../lib/paths.mjs';
import { writeJsonAtomic, readJson } from '../lib/fsx.mjs';

test('deepMerge merges nested objects and replaces arrays', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1] }, { a: { c: 3 }, l: [2] }), { a: { b: 1, c: 3 }, l: [2] });
});

test('loadConfig returns defaults when no file exists', () => {
  const root = tmpDir('cfg');
  fs.mkdirSync(path.join(root, '.planning'));
  assert.deepEqual(loadConfig(root), DEFAULTS);
});

test('initConfig writes config + .gitignore once and is idempotent', () => {
  const root = tmpDir('cfg');
  fs.mkdirSync(path.join(root, '.planning'));
  const first = initConfig(root, { lang: 'ru' });
  assert.equal(first.created, true);
  assert.equal(loadConfig(root).lang, 'ru');
  const ignore = fs.readFileSync(path.join(turboDir(root), '.gitignore'), 'utf8');
  assert.match(ignore, /^run\/$/m);
  assert.match(ignore, /^logs\/$/m);
  assert.match(ignore, /^locks\/$/m);
  const second = initConfig(root, { lang: 'en' });
  assert.equal(second.created, false);
  assert.equal(loadConfig(root).lang, 'ru');
});

test('findProjectRoot walks up to the directory containing .planning', () => {
  const root = tmpDir('root');
  fs.mkdirSync(path.join(root, '.planning'));
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  assert.equal(findProjectRoot(path.join(root, 'a', 'b')), root);
});

test('claudeHome honours CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeHome({ CLAUDE_CONFIG_DIR: '/x/y' }), path.resolve('/x/y'));
});

test('writeJsonAtomic + readJson round-trip; readJson falls back on missing/corrupt', () => {
  const dir = tmpDir('fsx');
  const f = path.join(dir, 'sub', 'a.json');
  writeJsonAtomic(f, { ok: 1 });
  assert.deepEqual(readJson(f), { ok: 1 });
  fs.writeFileSync(f, '{bad');
  assert.equal(readJson(f, 'fb'), 'fb');
  assert.equal(readJson(path.join(dir, 'none.json'), null), null);
});

const writeConfig = (root, text) => {
  fs.mkdirSync(turboDir(root), { recursive: true });
  const file = path.join(turboDir(root), 'config.json');
  fs.writeFileSync(file, text);
  return file;
};

test('loadConfig throws naming the file on corrupt JSON', () => {
  const root = tmpDir('cfg');
  const file = writeConfig(root, '{bad');
  assert.throws(() => loadConfig(root), (err) => err.message.includes(file));
});

test('loadConfig throws when the top-level value is not a plain object', () => {
  const root = tmpDir('cfg');
  const file = writeConfig(root, '["x"]');
  assert.throws(() => loadConfig(root), (err) => err.message.includes(file));
});

test('loadConfig throws on a read error other than a missing file', () => {
  const root = tmpDir('cfg');
  const file = path.join(turboDir(root), 'config.json');
  fs.mkdirSync(file, { recursive: true });
  assert.throws(() => loadConfig(root), (err) => err.message.includes(file));
});

test('loadConfig merges a partial nested config with defaults', () => {
  const root = tmpDir('cfg');
  writeConfig(root, '{"notify":{"telegram":true}}');
  assert.deepEqual(loadConfig(root).notify, { desktop: true, telegram: true });
});

test('loadConfig accepts a UTF-8 byte order mark (PowerShell 5.1 Set-Content -Encoding UTF8)', () => {
  const root = tmpDir('cfg');
  const file = writeConfig(root, '\uFEFF{"poll_seconds": 30}');
  assert.equal(loadConfig(root).poll_seconds, 30);
  // init merges test.full into the file through readJson: a BOM must not turn it into {}
  assert.deepEqual(readJson(file, {}), { poll_seconds: 30 });
});

test('tmpGitRepo ignores the global git config (hooks, autocrlf)', (t) => {
  const dir = tmpDir('gitglobal');
  const hooks = path.join(dir, 'hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const cfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(cfg, `[core]\n\thooksPath = ${hooks.replace(/\\/g, '/')}\n\tautocrlf = true\n`);
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  t.after(() => { if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prev; });
  const repo = tmpGitRepo(); // the global pre-commit hook would fail its commit
  const get = (key) => execFileSync('git', ['config', key], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(get('core.autocrlf'), 'false');
  assert.notEqual(path.resolve(repo, get('core.hooksPath')), path.resolve(hooks));
});

test('writeJsonAtomic throws and leaves no tmp file when the rename fails', () => {
  const dir = tmpDir('fsx');
  const target = path.join(dir, 'occupied');
  fs.mkdirSync(target);
  assert.throws(() => writeJsonAtomic(target, { a: 1 }));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
});

// --- test.full as a list of packages ------------------------------------------------------------

function entriesRoot() {
  const root = tmpDir('cfg');
  fs.mkdirSync(path.join(root, '.planning'));
  for (const d of ['server', 'app/web']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'a file, not a directory\n');
  return root;
}

test('fullEntries: a string is the root command; a list holds root strings and { dir, command } entries', () => {
  const root = entriesRoot();
  assert.deepEqual(fullEntries('npm test', root), [{ dir: '', command: 'npm test' }]);
  assert.deepEqual(fullEntries('  make check ', root), [{ dir: '', command: 'make check' }]);
  assert.deepEqual(fullEntries('', root), [{ dir: '', command: '' }], 'an empty string stays an error of the full run, as before');
  assert.deepEqual(fullEntries(undefined, root), [{ dir: '', command: '' }]);
  assert.deepEqual(fullEntries(['npm test', { dir: 'server', command: 'npm test' }, { dir: './app/web/', command: ' pnpm test ' }], root), [
    { dir: '', command: 'npm test' }, { dir: 'server', command: 'npm test' }, { dir: 'app/web', command: 'pnpm test' },
  ]);
  assert.deepEqual(fullEntries([{ dir: '.', command: 'npm test' }, { dir: 'server', command: 'npm test' }], root).map((e) => e.dir), ['', 'server']);
  assert.deepEqual(fullEntries([{ dir: 'server', command: 'npm test' }], root), [{ dir: 'server', command: 'npm test' }], 'no root entry is allowed');
});

test('fullEntries: an invalid list is a config error naming the file and the entry, never a fallback', () => {
  const root = entriesRoot();
  const file = path.join(turboDir(root), 'config.json');
  const cases = [
    [42, /test\.full must be a command string or a list/],
    [{ dir: 'server', command: 'npm test' }, /test\.full must be a command string or a list/],
    [[], /test\.full is an empty list/],
    [[7], /test\.full\[0\] must be a command string or/],
    [['npm test', { dir: 'server' }], /test\.full\[1\]\.command must be a string/],
    [[{ command: 'npm test' }], /test\.full\[0\]\.dir must be a string/],
    [[{ dir: 'server', command: '  ' }], /test\.full\[0\] has an empty command/],
    [['  '], /test\.full\[0\] has an empty command/],
    [[{ dir: 'server', command: 'npm test', cwd: 'x' }], /test\.full\[0\] has an unknown key "cwd"/],
    [[{ dir: '/srv', command: 'npm test' }], /test\.full\[0\]\.dir "\/srv" must be relative to the project root/],
    [[{ dir: 'C:/srv', command: 'npm test' }], /must be relative to the project root/],
    [[{ dir: '../server', command: 'npm test' }], /test\.full\[0\]\.dir "\.\.\/server" must stay inside the project root \(no "\.\."\)/],
    [[{ dir: 'server/../app', command: 'npm test' }], /must stay inside the project root/],
    [[{ dir: 'app\\web', command: 'npm test' }], /test\.full\[0\]\.dir "app\\web" must use forward slashes/],
    [[{ dir: 'missing', command: 'npm test' }], /test\.full\[0\]\.dir "missing" is not a directory in the project/],
    [[{ dir: 'notes.txt', command: 'npm test' }], /is not a directory in the project/],
    [['npm test', { dir: 'server', command: 'a' }, { dir: './server/', command: 'b' }], /test\.full\[2\]\.dir "server" is listed twice/],
    [['npm test', 'npm run lint'], /test\.full\[1\] runs at the project root, which is listed twice/],
    [['npm test', { dir: '.', command: 'b' }], /test\.full\[1\] runs at the project root, which is listed twice/],
  ];
  for (const [full, re] of cases) {
    assert.throws(() => fullEntries(full, root), (err) => {
      assert.match(err.message, /^invalid turbo config /, JSON.stringify(full));
      assert.ok(err.message.includes(file), err.message);
      assert.match(err.message, re, JSON.stringify(full));
      return true;
    }, JSON.stringify(full));
  }
});

test('fullEntries review 4/6: a dir that leads outside through a link, or names a listed directory again, is a config error', (t) => {
  const root = entriesRoot();
  const outside = tmpDir('outside');
  try {
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    fs.symlinkSync(path.join(root, 'server'), path.join(root, 'alias'), 'junction');
  } catch (err) {
    t.skip(`cannot create a directory link here (${err.code})`);
    return;
  }
  assert.throws(() => fullEntries(['npm test', { dir: 'linked', command: 'npm test' }], root), /test\.full\[1\]\.dir "linked" leads outside the project root \(through a link\)/);
  assert.throws(() => fullEntries(['npm test', { dir: 'server', command: 'a' }, { dir: 'alias', command: 'b' }], root), /test\.full\[2\]\.dir "alias" is listed twice \(as test\.full\[1\]\)/);
  // a case-insensitive file system (Windows, macOS): another spelling is the same directory
  const other = [{ dir: 'server', command: 'a' }, { dir: 'SERVER', command: 'b' }];
  const insensitive = fs.existsSync(path.join(root, 'SERVER'));
  assert.throws(() => fullEntries(other, root), insensitive ? /test\.full\[1\]\.dir "SERVER" is listed twice \(as test\.full\[0\]\)/ : /test\.full\[1\]\.dir "SERVER" is not a directory in the project/);
});

test('pushSettings: off by default; every key validated; a bad value is a one-line config error (S2)', () => {
  assert.deepEqual(pushSettings(), { mode: 'off', remote: 'origin', ci: 'github', ci_timeout_minutes: 30, ci_fix_rounds: 2 });
  assert.deepEqual(DEFAULTS.push, pushSettings());
  const all = { mode: 'after-wave', remote: 'up-stream_2', ci: 'none', ci_timeout_minutes: 5, ci_fix_rounds: 0 };
  assert.deepEqual(pushSettings(all), all);
  const cases = [
    [{ mode: 'after_wave' }, /^invalid turbo config push\.mode: must be one of off, after-wave, after-phase$/],
    [{ mode: true }, /push\.mode/],
    [{ remote: '--upload-pack=x' }, /push\.remote/],
    [{ remote: 'https://example.com/r.git' }, /push\.remote/],
    [{ remote: '' }, /push\.remote/],
    [{ remote: 'a..b' }, /push\.remote/],
    [{ ci: 'gitlab' }, /push\.ci: must be github or none/],
    [{ ci_timeout_minutes: 0 }, /push\.ci_timeout_minutes/],
    [{ ci_timeout_minutes: '30' }, /push\.ci_timeout_minutes/],
    [{ ci_fix_rounds: -1 }, /push\.ci_fix_rounds/],
    [{ ci_fix_rounds: 1.5 }, /push\.ci_fix_rounds/],
  ];
  for (const [raw, re] of cases) {
    assert.throws(() => pushSettings(raw), (e) => re.test(e.message) && /^invalid turbo config /.test(e.message), JSON.stringify(raw));
  }
  assert.throws(() => pushSettings(null), { message: /^invalid turbo config push: must be an object$/ });
  // a partial push object in the config file keeps the other defaults
  const root = tmpDir('cfg');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ push: { mode: 'after-phase' } }));
  assert.deepEqual(pushSettings(loadConfig(root).push), { ...DEFAULTS.push, mode: 'after-phase' });
});
