import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { laneTmpBase, laneTmpDir, prepareLaneTmp, removeLaneTmp } from '../lib/lane-tmp.mjs';
import { laneSessionName, projectHash } from '../lib/claude.mjs';

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

test('a lane\'s temp directory lives in the git directory, per project, outside the working tree; outside a repository under run/', () => {
  const repo = tmpGitRepo();
  assert.equal(laneTmpBase(repo), path.join(repo, '.git', 'turbo', 'tmp', projectHash(repo)));
  assert.equal(laneTmpDir(repo, '3'), path.join(repo, '.git', 'turbo', 'tmp', projectHash(repo), 'p3'));
  assert.match(projectHash(repo), /^[0-9a-f]{6}$/);
  assert.ok(laneSessionName(repo, '3').includes(`-${projectHash(repo)}-p3`), 'the hash lane session names carry');
  // two GSD projects in one repository never share a directory
  const app = path.join(repo, 'app');
  const web = path.join(repo, 'web');
  fs.mkdirSync(app);
  fs.mkdirSync(web);
  assert.equal(laneTmpBase(app), path.join(repo, '.git', 'turbo', 'tmp', projectHash(app)));
  assert.notEqual(laneTmpDir(app, '3'), laneTmpDir(web, '3'));
  const plain = tmpDir('plain');
  assert.equal(laneTmpBase(plain), path.join(plain, '.planning', 'turbo', 'run', 'tmp'));
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

test('removeLaneTmp and prepareLaneTmp refuse a p<N> that is a link, and a base that is itself a link or under one', () => {
  // p3 a link to outside
  const a = tmpGitRepo();
  const outA = precious();
  fs.mkdirSync(laneTmpBase(a), { recursive: true });
  fs.symlinkSync(path.join(outA, 'tmp', 'p3'), laneTmpDir(a, '3'), LINK);
  assert.throws(() => removeLaneTmp(a, '3'), /not removed: it resolves outside/);
  assert.ok(fs.existsSync(path.join(outA, 'tmp', 'p3', 'precious.txt')));
  // .git/turbo a link: the base resolves outside, so <target>/tmp/<project key>/p3 would go
  const b = tmpGitRepo();
  const rel = path.join('tmp', projectHash(b), 'p3');
  const outB = precious(rel);
  fs.symlinkSync(outB, path.join(b, '.git', 'turbo'), LINK);
  assert.throws(() => removeLaneTmp(b, '3'), /is a link or lies under one/);
  assert.throws(() => prepareLaneTmp(b, '3'), /is a link or lies under one/);
  assert.ok(fs.existsSync(path.join(outB, rel, 'precious.txt')));
  // outside a repository: .planning/turbo/run a link
  const c = tmpDir('plain');
  const outC = precious();
  fs.mkdirSync(path.join(c, '.planning', 'turbo'), { recursive: true });
  fs.symlinkSync(outC, path.join(c, '.planning', 'turbo', 'run'), LINK);
  assert.throws(() => removeLaneTmp(c, '3'), /is a link or lies under one/);
  assert.ok(fs.existsSync(path.join(outC, 'tmp', 'p3', 'precious.txt')));
});
