import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitIn, mainProject, slotFixture } from './helpers/slots.mjs';
import { controlRoot, dirKey, localRemotePath } from '../lib/paths.mjs';
import { SlotRefused, installBash, listSlots, maskRegExp, readSlotRecord, runInstall, setupSlots, slotPath, slotsDir } from '../lib/slots.mjs';
import { trustLine, trustState } from '../lib/trust.mjs';

const refused = (fn, code, re) => assert.throws(fn, (e) => e instanceof SlotRefused && e.code === code && (!re || re.test(e.message)), `${code} ${re ?? ''}`);
const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('lanes.copy masks: * and ? within one path segment, ** across segments', () => {
  const cases = [
    ['.env', '.env', true], ['.env', 'api/.env', false],
    ['*/.env', 'api/.env', true], ['*/.env', '.env', false], ['*/.env', 'a/b/.env', false],
    ['**/.env', '.env', true], ['**/.env', 'a/b/.env', true], ['config/*.env', 'config/dev.env', true],
    ['.env.?', '.env.1', true], ['.env.?', '.env.12', false], ['a+b/(x).env', 'a+b/(x).env', true],
  ];
  for (const [mask, p, want] of cases) assert.equal(maskRegExp(mask).test(p), want, `${mask} ${p}`);
});

test('setup clones each slot next to the project, copies the ignored files lanes.copy names, sets baseRef head and trusts it', () => {
  const p = mainProject();
  p.write('.env', 'A=1\n');
  p.write('api/.env', 'B=2\n');
  p.write('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  p.git('config', '--local', 'core.longpaths', 'true');
  p.git('config', '--local', 'core.symlinks', 'true');
  const t = slotFixture(p.root);
  assert.equal(slotsDir(p.root, t.config), t.dir);
  const r = setupSlots(p.root, t.config, t.deps);
  assert.deepEqual(r.slots.map((s) => [s.k, s.action, s.trust.status]), [[1, 'created', 'trusted'], [2, 'created', 'trusted']]);
  assert.equal(r.backup, `${t.claudeJson}.turbo-bak-20261013T120000Z`);
  for (const k of [1, 2]) {
    const s = slotPath(p.root, t.config, k);
    assert.equal(s, path.join(t.dir, `lane-${k}`));
    assert.equal(fs.readFileSync(path.join(s, '.env'), 'utf8'), 'A=1\n');
    assert.equal(fs.readFileSync(path.join(s, 'api', '.env'), 'utf8'), 'B=2\n');
    assert.deepEqual(readJsonFile(path.join(s, '.claude', 'settings.local.json')), { permissions: { allow: ['Bash(ls)'] }, worktree: { baseRef: 'head' } });
    assert.equal(gitIn(s, 'status', '--porcelain', '--untracked-files=all'), '', 'copies never show');
    assert.equal(dirKey(localRemotePath(gitIn(s, 'config', '--get', 'remote.origin.url'))), dirKey(p.root));
    assert.deepEqual([gitIn(s, 'config', '--local', '--get', 'core.autocrlf'), gitIn(s, 'config', '--local', '--get', 'user.name')], ['false', 'test']);
    assert.deepEqual(['core.longpaths', 'core.symlinks'].map((key) => gitIn(s, 'config', '--local', '--get', key)), ['true', 'true'], 'M5');
    assert.equal(gitIn(s, 'rev-parse', 'HEAD'), p.git('rev-parse', 'HEAD'));
    const rec = readSlotRecord(s);
    assert.deepEqual([rec.v, rec.k, rec.path, rec.job, rec.copied, rec.createdAt], [1, k, s, null, ['.env', 'api/.env'], '2026-10-13T12:00:00.000Z']);
    assert.equal(dirKey(rec.control), dirKey(p.root));
    assert.equal(trustState(s, { file: t.claudeJson }), 'trusted');
  }
  assert.deepEqual(readJsonFile(path.join(p.root, '.claude', 'settings.local.json')), { permissions: { allow: ['Bash(ls)'] } }, 'the project file is untouched');
  assert.equal(dirKey(controlRoot(path.join(slotPath(p.root, t.config, 1), 'api'), {})), dirKey(p.root));
  assert.deepEqual(listSlots(p.root, t.config, t.deps).map((s) => [s.k, s.state]), [[1, 'free'], [2, 'free']]);
  // again: kept, nothing cloned again, the trust already there
  const again = setupSlots(p.root, t.config, t.deps);
  assert.deepEqual(again.slots.map((s) => [s.k, s.action, s.trust.status]), [[1, 'kept', 'already'], [2, 'kept', 'already']]);
  assert.equal(again.backup, null);
});

test('settings.local.json stays hidden in a slot even when the project does not ignore it; trust_write false gives the owner\'s line (Review Focus 4)', () => {
  const p = mainProject({ ignore: ['.env'] });
  p.write('.claude/settings.local.json', '{}');
  const t = slotFixture(p.root, { max: 1, lanes: { trust_write: false } });
  const bytes = fs.readFileSync(t.claudeJson, 'utf8');
  const r = setupSlots(p.root, t.config, t.deps);
  const s = slotPath(p.root, t.config, 1);
  assert.deepEqual([r.slots[0].trust.status, r.slots[0].trust.line], ['manual', trustLine(s)]);
  assert.equal(fs.readFileSync(t.claudeJson, 'utf8'), bytes);
  assert.equal(gitIn(s, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.match(fs.readFileSync(path.join(s, '.git', 'info', 'exclude'), 'utf8'), /# gsd-turbo slot files: begin\n\/\.claude\/settings\.local\.json\n# gsd-turbo slot files: end\n/);
});

test('GSD\'s runtime files never show in a slot\'s git status: setup lists them in its exclude once, however often it runs; other files still show (v0.5.1)', () => {
  const p = mainProject();
  const t = slotFixture(p.root, { max: 1 });
  setupSlots(p.root, t.config, t.deps);
  const s = slotPath(p.root, t.config, 1);
  const first = fs.readFileSync(path.join(s, '.git', 'info', 'exclude'), 'utf8');
  setupSlots(p.root, t.config, t.deps);
  assert.equal(fs.readFileSync(path.join(s, '.git', 'info', 'exclude'), 'utf8'), first, 'each block stays where it is');
  for (const f of ['state.json', 'milestone.lock', 'STATE.md.lock', '.lock', '.WINDOWS.lock', 'WAITING.json', 'workstreams/ws1/state.json']) {
    fs.mkdirSync(path.dirname(path.join(s, '.planning', f)), { recursive: true });
    fs.writeFileSync(path.join(s, '.planning', f), '{}\n');
  }
  assert.equal(gitIn(s, 'status', '--porcelain', '--untracked-files=all'), '');
  const exclude = fs.readFileSync(path.join(s, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('# gsd-turbo: GSD runtime files: begin').length, 2, exclude);
  assert.match(exclude, /^\/\.planning\/state\.json$/m);
  assert.match(exclude, /^\/\.planning\/workstreams\/\*\/milestone\.lock$/m);
  fs.writeFileSync(path.join(s, '.planning', 'notes.json'), '{}\n');
  assert.equal(gitIn(s, 'status', '--porcelain', '--untracked-files=all'), '?? .planning/notes.json');
  assert.deepEqual(listSlots(p.root, t.config, t.deps).map((x) => x.state), ['dirty']);
});

test('setup refuses, creating nothing: a lanes.copy file git does not ignore, lanes.dir inside the project, a detached main checkout, lanes.mode checkout, a tracked settings.local.json (Review Focus 4)', () => {
  const tracked = mainProject({ ignore: ['node_modules'], files: { '.env': 'A=1\n' } });
  let t = slotFixture(tracked.root);
  refused(() => setupSlots(tracked.root, t.config, t.deps), 'copy', /lanes\.copy names files git does not ignore: \.env/);
  assert.equal(fs.existsSync(t.dir), false);

  const loose = mainProject({ ignore: ['node_modules'] });
  loose.write('api/.env', 'B=2\n');
  t = slotFixture(loose.root);
  refused(() => setupSlots(loose.root, t.config, t.deps), 'copy', /api\/\.env/);
  assert.equal(fs.existsSync(t.dir), false);

  const p = mainProject();
  refused(() => setupSlots(p.root, slotFixture(p.root, { lanes: { dir: 'slots' } }).config, t.deps), 'inside');
  refused(() => setupSlots(p.root, slotFixture(p.root, { lanes: { mode: 'checkout' } }).config, t.deps), 'mode');
  t = slotFixture(p.root);
  p.git('checkout', '-q', '--detach');
  refused(() => setupSlots(p.root, t.config, t.deps), 'detached');
  assert.equal(fs.existsSync(t.dir), false);
  p.git('checkout', '-q', 'main');

  const s = mainProject({ ignore: ['.env'], files: { '.claude/settings.local.json': '{}' } });
  t = slotFixture(s.root);
  refused(() => setupSlots(s.root, t.config, t.deps), 'settings', /is tracked by git/);
});

test('a directory in a slot\'s place that is not a slot of this project is never touched', () => {
  const p = mainProject();
  const t = slotFixture(p.root);
  fs.mkdirSync(path.join(t.dir, 'lane-1'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'lane-1', 'notes.txt'), 'mine');
  const r = setupSlots(p.root, t.config, t.deps);
  assert.deepEqual(r.slots.map((s) => [s.k, s.action]), [[1, 'refused'], [2, 'created']]);
  assert.match(r.slots[0].why, /exists and is not slot 1 of this project/);
  assert.equal(fs.readFileSync(path.join(t.dir, 'lane-1', 'notes.txt'), 'utf8'), 'mine');
  assert.deepEqual(listSlots(p.root, t.config, t.deps).map((s) => [s.k, s.state]), [[1, 'foreign'], [2, 'free']]);
});

test('the install shell on Windows: Git Bash by its absolute path; a WSL bash ahead of it in PATH is refused with a clear message (M9)', () => {
  const env = { PATH: String.raw`C:\Windows\System32;C:\Program Files\Git\bin` };
  const cwd = String.raw`C:\Users\dev\app`;
  const gitBash = String.raw`C:\Program Files\Git\bin\bash.exe`;
  const wsl = installBash({ env, platform: 'win32', cwd, exists: (f) => /bash\.exe$/i.test(f) });
  assert.equal(wsl.bash, null);
  assert.ok(wsl.refused.startsWith(String.raw`C:\Windows\System32\bash.exe is WSL's bash`), wsl.refused);
  const r = runInstall('npm ci', { cwd, platform: 'win32', env, exists: (f) => /bash\.exe$/i.test(f) });
  assert.equal(r.code, 1);
  assert.match(r.tail, /WSL/);
  assert.deepEqual(installBash({ env, platform: 'win32', cwd, exists: (f) => f === gitBash }), { bash: gitBash, refused: null });
  assert.deepEqual(installBash({ env: { PATH: '' }, platform: 'win32', cwd, exists: () => false }), { bash: null, refused: null });
  assert.deepEqual(installBash({ platform: 'linux' }), { bash: 'bash', refused: null });
});
