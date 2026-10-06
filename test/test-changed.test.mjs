import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { isTestFile, classifyScript, relatedTests, planRun, runTestChanged } from '../lib/test-changed.mjs';

test('isTestFile', () => {
  for (const f of ['a.test.js', 'x/b.spec.ts', 'test/c.mjs', 'tests/test_d.py', 'e_test.go']) assert.ok(isTestFile(f), f);
  for (const f of ['src/a.js', 'README.md']) assert.ok(!isTestFile(f), f);
});

test('classifyScript', () => {
  assert.deepEqual(classifyScript('node --test "scripts/**/*.test.js"'), { kind: 'node-test', prefix: [] });
  assert.deepEqual(classifyScript('node --experimental-vm-modules --test test/*.test.js'), { kind: 'node-test', prefix: ['--experimental-vm-modules'] });
  assert.equal(classifyScript('jest --ci').kind, 'jest');
  assert.equal(classifyScript('vitest run').kind, 'vitest');
  assert.equal(classifyScript('pytest -q').kind, 'pytest');
  assert.equal(classifyScript('make test').kind, 'unknown');
});

test('relatedTests by self-change and import mention', () => {
  const files = { 'test/user.test.js': "import { u } from '../src/user.js'", 'test/other.test.js': "require('../src/other')" };
  const read = (f) => files[f];
  assert.deepEqual(relatedTests(['src/user.js'], Object.keys(files), read), ['test/user.test.js']);
  assert.deepEqual(relatedTests(['test/other.test.js'], Object.keys(files), read), ['test/other.test.js']);
});

const base = { testFiles: ['test/a.test.js'], packages: [{ dir: '', testScript: 'node --test test/' }], readFile: () => "import '../src/a.js'", head: 'H', fullCommand: 'npm test', forceFull: false };

test('planRun decision table', () => {
  assert.equal(planRun({ ...base, changed: ['src/a.js'], marker: null }).mode, 'full');
  assert.equal(planRun({ ...base, changed: ['src/a.js'], marker: { sha: 'X', full: true }, forceFull: true }).mode, 'full');
  assert.equal(planRun({ ...base, changed: ['package.json'], marker: { sha: 'X', full: true } }).mode, 'full');
  assert.equal(planRun({ ...base, changed: [], marker: { sha: 'H', full: true } }).mode, 'skip');
  assert.equal(planRun({ ...base, changed: [], marker: { sha: 'H', full: false } }).mode, 'full');
  assert.equal(planRun({ ...base, changed: ['docs/x.md', '.planning/STATE.md'], marker: { sha: 'X', full: true } }).mode, 'skip');
  const t = planRun({ ...base, changed: ['src/a.js'], marker: { sha: 'X', full: true } });
  assert.equal(t.mode, 'targeted');
  assert.deepEqual(t.groups, [{ cwd: '', cmd: process.execPath, args: ['--test', 'test/a.test.js'], shell: false }]);
  assert.equal(planRun({ ...base, changed: ['src/zzz.js'], marker: { sha: 'X', full: true } }).mode, 'full');
  assert.equal(planRun({ ...base, packages: [{ dir: '', testScript: 'make test' }], changed: ['src/a.js'], marker: { sha: 'X', full: true } }).mode, 'full');
});

// Executed fixture commands use plain `node --test`: Node 22+ no longer expands a directory argument.
test('runTestChanged end-to-end in a temp git repo: full, then skip, then targeted', async () => {
  const repo = tmpGitRepo();
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  w('package.json', JSON.stringify({ name: 't', type: 'module', scripts: { test: 'node --test' } }));
  w('src/a.js', 'export const a = 1;\n');
  w('test/a.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../src/a.js';\ntest('a', () => assert.equal(a, 1));\n");
  w('.planning/turbo/config.json', JSON.stringify({ test: { full: 'node --test' } }));
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const logs = [];
  const opts = { root: repo, env: {}, log: (l) => logs.push(l) };
  assert.equal(await runTestChanged(opts), 0);
  assert.match(logs.join('\n'), /full/);
  assert.equal(await runTestChanged(opts), 0);
  assert.match(logs.at(-1), /skip/);
  w('src/a.js', 'export const a = 1; // touched\n');
  git('commit', '-qam', 'c2');
  assert.equal(await runTestChanged(opts), 0);
  assert.match(logs.at(-1), /targeted/);
});

// --- controller rulings -------------------------------------------------------------------

const A_TEST = (expected) => `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../src/a.js';\ntest('a', () => assert.equal(a, ${expected}));\n`;

function project(dir, { full = 'node --test', expected = 1 } = {}) {
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  w('package.json', JSON.stringify({ name: 't', type: 'module', scripts: { test: 'node --test' } }));
  w('src/a.js', 'export const a = 1;\n');
  w('test/a.test.js', A_TEST(expected));
  w('.planning/turbo/config.json', JSON.stringify({ test: { full } }));
  return w;
}
const gitIn = (dir) => (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
const markerOf = (dir) => path.resolve(dir, gitIn(dir)('rev-parse', '--git-path', 'turbo-last-green'));
const readMarker = (dir) => { try { return JSON.parse(fs.readFileSync(markerOf(dir), 'utf8')); } catch { return null; } };
const runner = (root, env = {}) => {
  const logs = [];
  return { logs, run: () => runTestChanged({ root, env, log: (l) => logs.push(l) }) };
};

test('a failing full or targeted run never writes the green marker', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo, { expected: 2 });
  git('add', '-A'); git('commit', '-q', '-m', 'red');
  const r = runner(repo);
  assert.notEqual(await r.run(), 0);
  assert.match(r.logs.at(-1), /^full: /);
  assert.equal(readMarker(repo), null, 'no marker after a failing full run');

  w('test/a.test.js', A_TEST(1));
  git('commit', '-qam', 'green');
  const green = git('rev-parse', 'HEAD');
  assert.equal(await r.run(), 0);
  assert.deepEqual(readMarker(repo), { sha: green, full: true });

  w('src/a.js', 'export const a = 3;\n');
  git('commit', '-qam', 'break');
  assert.notEqual(await r.run(), 0);
  assert.match(r.logs.at(-1), /^targeted: /);
  assert.deepEqual(readMarker(repo), { sha: green, full: true }, 'a failing targeted run leaves the marker alone');
  assert.equal(r.logs.length, 3, 'exactly one log line per run');
});

test('the green marker lives in the per-worktree git dir and is never tracked or staged', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  project(repo);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  assert.equal(await runner(repo).run(), 0);
  const marker = markerOf(repo);
  assert.ok(fs.existsSync(marker), marker);
  const gitDir = path.resolve(repo, git('rev-parse', '--git-dir'));
  assert.ok(marker.startsWith(gitDir + path.sep), `${marker} inside ${gitDir}`);
  git('add', '-A');
  assert.equal(git('diff', '--cached', '--name-only'), '', 'nothing staged');
  assert.equal(git('status', '--porcelain'), '', 'nothing untracked or modified');
  assert.ok(!git('ls-files').split('\n').some((f) => f.includes('turbo-last-green')));

  const before = fs.readFileSync(marker, 'utf8');
  const wt = path.join(tmpDir('wt'), 'lane');
  git('worktree', 'add', '-q', '-b', 'lane', wt);
  const r = runner(wt);
  assert.equal(await r.run(), 0);
  assert.match(r.logs.at(-1), /^full: /, 'a new worktree starts without a marker');
  assert.notEqual(markerOf(wt), marker);
  assert.ok(fs.existsSync(markerOf(wt)));
  assert.equal(fs.readFileSync(marker, 'utf8'), before, 'the main worktree marker is untouched');
});

test('outside a git repository: always the full command, never a skip, never a marker', async (t) => {
  const dir = tmpDir('nogit');
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' });
    t.skip('the temp dir is inside a git repository');
    return;
  } catch { /* expected: not a repository */ }
  project(dir);
  const r = runner(dir);
  assert.equal(await r.run(), 0);
  assert.equal(await r.run(), 0);
  assert.deepEqual(r.logs, ['full: not a git repository', 'full: not a git repository']);
  assert.ok(!fs.existsSync(path.join(dir, '.git')));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.planning', 'package.json', 'src', 'test']);

  project(dir, { full: 'node -e "process.exit(3)"' });
  assert.equal(await runner(dir).run(), 3, 'the full command exit code is returned as is');
});

test('TURBO_FULL=1 forces a full run even when HEAD is already fully green', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  project(repo);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  assert.equal(await runner(repo).run(), 0);
  const r = runner(repo, { TURBO_FULL: '1' });
  assert.equal(await r.run(), 0);
  assert.deepEqual(r.logs, ['full: TURBO_FULL=1']);
});

test('uncommitted changes in tracked files run the full command and record no green marker', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  assert.equal(await runner(repo).run(), 0);
  const green = readMarker(repo);
  w('src/a.js', 'export const a = 1; // dirty\n');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  assert.deepEqual(r.logs, ['full: uncommitted changes in tracked files']);
  assert.deepEqual(readMarker(repo), green, 'a run on a dirty tree proves nothing about HEAD');
});

// --- fix round: bash -c for the full command, unquoted git paths ---------------------------

const hasBash = () => { try { execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }); return true; } catch { return false; } };
function nonGitDir(t) {
  const dir = tmpDir('nogit');
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'ignore' });
    t.skip('the temp dir is inside a git repository');
    return null;
  } catch { return dir; }
}

test('the full command runs through bash -c, as GSD runs workflow.test_command', async (t) => {
  if (!hasBash()) { t.skip('bash is not available'); return; }
  const dir = nonGitDir(t);
  if (!dir) return;
  project(dir, { full: 'X=1; [[ $X == 1 ]]' });
  assert.equal(await runner(dir).run(), 0, 'bash-only syntax succeeds');
  project(dir, { full: 'X=1; [[ $X == 2 ]]' });
  assert.notEqual(await runner(dir).run(), 0, 'and is really evaluated');
});

test('without bash the full command falls back to the system shell with one log line', async (t) => {
  const nodeDir = path.dirname(process.execPath);
  if (['bash', 'bash.exe'].some((b) => fs.existsSync(path.join(nodeDir, b)))) { t.skip('bash sits next to node'); return; }
  const dir = nonGitDir(t);
  if (!dir) return;
  project(dir, { full: 'node -e "process.exit(0)"' });
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const saved = process.env[key];
  process.env[key] = nodeDir; // no bash and no git on PATH
  const r = runner(dir);
  try {
    assert.equal(await r.run(), 0);
  } finally {
    process.env[key] = saved;
  }
  assert.deepEqual(r.logs, ['full: not a git repository', 'bash not found, using system shell']);
});

test('non-ASCII file names are read unquoted from git, so their tests run targeted', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  git('config', 'core.quotepath', 'true'); // git's default: octal-escaped, quoted paths
  const w = project(repo);
  w('src/über.js', 'export const u = 1;\n');
  w('test/über.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { u } from '../src/über.js';\ntest('u', () => assert.equal(u, 1));\n");
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('src/über.js', 'export const u = 1; // touched\n');
  git('commit', '-qam', 'c2');
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'targeted: 1 related test file(s)');
});
