import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { laneTmpBase, laneTmpDir, prepareLaneTmp, removeLaneTmp } from '../lib/lane-tmp.mjs';
import { laneSessionName, projectHash } from '../lib/claude.mjs';

// lane temp directories live under turbo's own directory: a throwaway one for this file
const HOME = tmpDir('home');
process.env.CLAUDE_CONFIG_DIR = HOME;
const TMP = path.join(HOME, 'turbo', 'tmp');

const LINK = process.platform === 'win32' ? 'junction' : 'dir';
const fill = (dir) => {
  fs.mkdirSync(path.join(dir, 'stand'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'stand', 'db.json'), '{}');
};
// a directory outside the project whose file must survive
const precious = (rel = path.join('tmp', 'p3')) => {
  const outside = tmpDir('outside');
  fs.mkdirSync(path.join(outside, rel), { recursive: true });
  fs.writeFileSync(path.join(outside, rel, 'precious.txt'), 'x');
  return outside;
};

// A project test may check that os.tmpdir() lies outside its checkout: inside a lane, TMP is this directory.
test('a lane\'s temp directory lives under turbo\'s own directory, per project, outside the checkout and its git directory', () => {
  const repo = tmpGitRepo();
  assert.equal(laneTmpBase(repo), path.join(TMP, projectHash(repo, 16)));
  assert.equal(laneTmpDir(repo, '3'), path.join(TMP, projectHash(repo, 16), 'p3'));
  assert.match(projectHash(repo), /^[0-9a-f]{6}$/);
  assert.match(path.basename(laneTmpBase(repo)), /^[0-9a-f]{16}$/, 'what all projects share is keyed by 16 hex');
  assert.ok(laneSessionName(repo, '3').includes(`-${projectHash(repo)}-p3`), 'the hash lane session names carry');
  const rel = path.relative(repo, laneTmpDir(repo, '3'));
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), 'never under the project root');
  // two GSD projects in one repository never share a directory
  const app = path.join(repo, 'app');
  const web = path.join(repo, 'web');
  fs.mkdirSync(app);
  fs.mkdirSync(web);
  assert.equal(laneTmpBase(app), path.join(TMP, projectHash(app, 16)));
  assert.notEqual(laneTmpDir(app, '3'), laneTmpDir(web, '3'));
  // outside a repository: the same place
  const plain = tmpDir('plain');
  assert.equal(laneTmpBase(plain), path.join(TMP, projectHash(plain, 16)));
  // prepare creates turbo's directory when it is not there yet, and nothing in the checkout
  const fresh = tmpDir('home-fresh');
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(fresh, 'not-yet');
  try {
    assert.equal(prepareLaneTmp(repo, '3'), path.join(fresh, 'not-yet', 'turbo', 'tmp', projectHash(repo, 16), 'p3'));
    assert.ok(fs.statSync(laneTmpDir(repo, '3')).isDirectory());
  } finally {
    process.env.CLAUDE_CONFIG_DIR = was;
  }
  assert.equal(fs.existsSync(path.join(repo, '.git', 'turbo')), false);
  assert.equal(fs.existsSync(path.join(repo, '.planning')), false);
});

test('prepareLaneTmp empties a stale directory and creates it; removeLaneTmp removes p<N> only', () => {
  const repo = tmpGitRepo();
  const dir = laneTmpDir(repo, '3');
  fill(dir);
  fill(laneTmpDir(repo, '4'));
  assert.equal(prepareLaneTmp(repo, '3'), dir);
  assert.deepEqual(fs.readdirSync(dir), [], 'what an earlier session left is gone');
  fill(dir);
  assert.equal(removeLaneTmp(repo, '3'), dir);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.existsSync(path.join(laneTmpDir(repo, '4'), 'stand', 'db.json')));
  assert.equal(removeLaneTmp(repo, '3'), null, 'nothing there');
});

// A failed removal is never a launch failure: the lane gets the directory as it is.
test('prepareLaneTmp is best effort about a stale directory: a refused removal is logged and the lane gets the directory as it is', () => {
  const a = tmpGitRepo();
  const outA = precious();
  fs.mkdirSync(laneTmpBase(a), { recursive: true });
  fs.symlinkSync(path.join(outA, 'tmp', 'p3'), laneTmpDir(a, '3'), LINK);
  const logs = [];
  assert.equal(prepareLaneTmp(a, '3', (l) => logs.push(l)), laneTmpDir(a, '3'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^lane temp directory .*p3 kept: .*not removed: it resolves outside/);
  assert.ok(fs.existsSync(path.join(outA, 'tmp', 'p3', 'precious.txt')));
});

// Windows refuses to delete a directory a process has as its cwd; a plain recursive delete would remove the
// files around it first. The stale directory is renamed away as a whole first, or left as it is.
test('a stale directory a leftover stand still works in is never partly deleted', async (t) => {
  const repo = tmpGitRepo();
  const dir = laneTmpDir(repo, '3');
  fill(dir);
  const stand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path.join(dir, 'stand'), stdio: 'ignore', windowsHide: true });
  t.after(() => { try { stand.kill(); } catch { /* gone */ } });
  await new Promise((resolve) => stand.once('spawn', resolve));
  const logs = [];
  assert.equal(prepareLaneTmp(repo, '3', (l) => logs.push(l)), dir);
  if (process.platform === 'win32') {
    assert.ok(fs.existsSync(path.join(dir, 'stand', 'db.json')), 'nothing was deleted');
    assert.match(logs.join('\n'), /p3 kept: .*EPERM|EBUSY|EACCES/);
  } else {
    assert.deepEqual(fs.readdirSync(dir), [], 'POSIX lets it go');
  }
  assert.deepEqual(fs.readdirSync(laneTmpBase(repo)).filter((n) => n !== 'p3'), [], 'no renamed leftover stays behind');
});

test('removeLaneTmp and prepareLaneTmp refuse a p<N> that is a link, and a base that is itself a link', () => {
  // p3 a link to outside
  const a = tmpGitRepo();
  const outA = precious();
  fs.mkdirSync(laneTmpBase(a), { recursive: true });
  fs.symlinkSync(path.join(outA, 'tmp', 'p3'), laneTmpDir(a, '3'), LINK);
  assert.throws(() => removeLaneTmp(a, '3'), /not removed: it resolves outside/);
  assert.ok(fs.existsSync(path.join(outA, 'tmp', 'p3', 'precious.txt')));
  // the project's base a link: <target>/p3 would go
  const b = tmpGitRepo();
  const outB = precious('p3');
  fs.mkdirSync(TMP, { recursive: true });
  fs.symlinkSync(outB, laneTmpBase(b), LINK);
  assert.throws(() => removeLaneTmp(b, '3'), /is a link or lies under one/);
  assert.throws(() => prepareLaneTmp(b, '3'), /is a link or lies under one/);
  assert.ok(fs.existsSync(path.join(outB, 'p3', 'precious.txt')));
});

test('a turbo tmp directory that is a link is refused for every project', () => {
  const home = tmpDir('home-link');
  const c = tmpGitRepo();
  const rel = path.join(projectHash(c, 16), 'p3');
  const outC = precious(rel);
  fs.mkdirSync(path.join(home, 'turbo'), { recursive: true });
  fs.symlinkSync(outC, path.join(home, 'turbo', 'tmp'), LINK);
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    assert.throws(() => removeLaneTmp(c, '3'), /is a link or lies under one/);
    assert.throws(() => prepareLaneTmp(c, '3'), /is a link or lies under one/);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = was;
  }
  assert.ok(fs.existsSync(path.join(outC, rel, 'precious.txt')));
});

test('a config directory inside the project never puts the lane temp directory back in the tree: it moves to the system temp directory, and the launch log says so', () => {
  const repo = tmpGitRepo();
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(repo, 'claude-home');
  try {
    const expected = path.join(os.tmpdir(), 'gsd-turbo', 'tmp', projectHash(repo, 16));
    assert.equal(laneTmpBase(repo), expected);
    const logs = [];
    assert.equal(prepareLaneTmp(repo, '3', (l) => logs.push(l)), path.join(expected, 'p3'));
    assert.match(logs.join('\n'), /lies inside the project .*; the lane temp directory is .*gsd-turbo/);
    assert.equal(fs.existsSync(path.join(repo, 'claude-home', 'turbo', 'tmp')), false);
    assert.equal(removeLaneTmp(repo, '3'), path.join(expected, 'p3'));
  } finally {
    process.env.CLAUDE_CONFIG_DIR = was;
  }
});
