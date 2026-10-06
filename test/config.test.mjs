import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DEFAULTS, loadConfig, initConfig, deepMerge } from '../lib/config.mjs';
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

test('writeJsonAtomic throws and leaves no tmp file when the rename fails', () => {
  const dir = tmpDir('fsx');
  const target = path.join(dir, 'occupied');
  fs.mkdirSync(target);
  assert.throws(() => writeJsonAtomic(target, { a: 1 }));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
});
