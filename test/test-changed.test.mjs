import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { isTestFile, classifyScript, relatedTests, planRun, runTestChanged } from '../lib/test-changed.mjs';
const hasBash = () => { try { execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }); return true; } catch { return false; } };

test('isTestFile', () => {
  for (const f of ['a.test.js', 'x/b.spec.ts', 'test/c.mjs', 'tests/test_d.py', 'e_test.go']) assert.ok(isTestFile(f), f);
  for (const f of ['src/a.js', 'README.md']) assert.ok(!isTestFile(f), f);
});

test('classifyScript', () => {
  assert.deepEqual(classifyScript('node --test "scripts/**/*.test.js"'), { kind: 'node-test', prefix: [] });
  assert.deepEqual(classifyScript('node --experimental-vm-modules --test test/*.test.js'), { kind: 'node-test', prefix: ['--experimental-vm-modules'] });
  assert.equal(classifyScript('jest').kind, 'jest'); // ruling: bare runner forms only ('jest --ci' is unknown)
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

// The marker records only the last FULL green run and the targeted greens since then.
const M = (fullSha, targetedSince = 0) => ({ fullSha, targetedSince });

test('planRun decision table', () => {
  assert.equal(planRun({ ...base, changed: ['src/a.js'], marker: null }).mode, 'full');
  assert.equal(planRun({ ...base, changed: ['src/a.js'], marker: M('X'), forceFull: true }).mode, 'full');
  assert.equal(planRun({ ...base, changed: ['package.json'], marker: M('X') }).mode, 'full');
  assert.equal(planRun({ ...base, changed: ['.planning/turbo/config.json'], marker: M('X') }).mode, 'full');
  assert.equal(planRun({ ...base, changed: [], marker: M('H') }).mode, 'skip');
  assert.equal(planRun({ ...base, changed: [], marker: M('H', 2) }).mode, 'skip', 'skip only on an empty cumulative change set');
  assert.equal(planRun({ ...base, changed: ['src/a.js'], marker: M('X', 3) }).mode, 'full', 'max_targeted defaults to 3');
  assert.equal(planRun({ ...base, changed: ['src/a.js'], marker: M('X', 1), maxTargeted: 1 }).mode, 'full');
  const d = planRun({ ...base, changed: ['docs/x.md', '.planning/STATE.md'], marker: M('X') });
  assert.deepEqual([d.mode, d.groups], ['targeted', []], 'no blanket docs skip; docs no test mentions need no coverage');
  const t = planRun({ ...base, changed: ['src/a.js', 'README.md'], marker: M('X', 2) });
  assert.equal(t.mode, 'targeted');
  assert.deepEqual(t.groups, [{ cwd: '', cmd: process.execPath, args: ['--test', 'test/a.test.js'], shell: false }]);
  assert.equal(planRun({ ...base, changed: ['src/zzz.js'], marker: M('X') }).mode, 'full');
  assert.equal(planRun({ ...base, packages: [{ dir: '', testScript: 'make test' }], changed: ['src/a.js'], marker: M('X') }).mode, 'full');
});

test('support files: the importing tests run, never the helper itself; a file in a test dir nothing imports runs as a test', () => {
  const files = { 'test/a.test.mjs': "import { h } from './helpers/h.mjs'", 'test/helpers/h.mjs': 'export const h = 1', 'test/helpers/lonely.mjs': '' };
  const p = { ...base, testFiles: Object.keys(files), readFile: (f) => files[f], marker: M('X') };
  const t = planRun({ ...p, changed: ['test/helpers/h.mjs'] });
  assert.equal(t.mode, 'targeted');
  assert.deepEqual(t.groups.map((g) => g.args), [['--test', 'test/a.test.mjs']]);
  // a leaf: `node --test` runs every file under test/, so it is a test, not a support file
  assert.deepEqual(planRun({ ...p, changed: ['test/helpers/lonely.mjs'] }).groups.map((g) => g.args), [['--test', 'test/helpers/lonely.mjs']]);
  // relatedTests searches importers even when the changed file is itself a test
  assert.deepEqual(relatedTests(['test/helpers/h.mjs'], Object.keys(files), p.readFile), ['test/a.test.mjs', 'test/helpers/h.mjs']);
});

test('transitive importers and directory imports pull in their tests', () => {
  const files = {
    'src/a.js': 'export const a = 1',
    'src/b.js': "import { a } from './a.js'",
    'lib/index.js': "export * from './x.js'",
    'test/b.test.js': "import { b } from '../src/b.js'",
    'test/lib.test.js': "import * as lib from '../lib'",
  };
  const p = { ...base, testFiles: ['test/b.test.js', 'test/lib.test.js'], sourceFiles: Object.keys(files), readFile: (f) => files[f], marker: M('X') };
  assert.deepEqual(planRun({ ...p, changed: ['src/a.js'] }).groups.map((g) => g.args), [['--test', 'test/b.test.js']]);
  assert.deepEqual(planRun({ ...p, changed: ['lib/x.js'] }).groups.map((g) => g.args), [['--test', 'test/lib.test.js']]);
});

test('targeted only for package test scripts with a known simple runner; pytest is full-only', () => {
  const p = { ...base, changed: ['src/a.js'], marker: M('X') };
  assert.equal(planRun({ ...p, fullCommand: 'make test' }).mode, 'full');
  assert.equal(planRun({ ...p, fullCommand: 'node --test test/' }).mode, 'targeted', 'equal to the root scripts.test');
  for (const c of ['npm run test', 'pnpm test', 'pnpm run test', 'yarn test', 'yarn run test']) assert.equal(planRun({ ...p, fullCommand: c }).mode, 'targeted', c);
  for (const s of ['node --test && eslint .', 'node --test || true', 'node --test; echo', 'node --test | tee log']) {
    assert.equal(classifyScript(s).kind, 'unknown', s);
    assert.equal(planRun({ ...p, packages: [{ dir: '', testScript: s }] }).mode, 'full', s);
  }
  const py = planRun({ ...base, testFiles: ['tests/test_a.py'], packages: [{ dir: '', testScript: 'pytest -q' }], fullCommand: 'pytest -q', changed: ['tests/test_a.py'], marker: M('X') });
  assert.deepEqual([py.mode, py.reason], ['full', 'pytest projects run the full suite']);
});

test('jest and vitest groups run through bash -c with single-quoted file arguments', () => {
  const files = { "test/it's.test.js": "import '../src/a.js'" };
  const p = { ...base, testFiles: Object.keys(files), readFile: (f) => files[f], changed: ['src/a.js'], marker: M('X') };
  const pk = (testScript) => [{ dir: '', testScript }];
  const j = planRun({ ...p, packages: pk('jest') });
  assert.deepEqual(j.groups, [{ cwd: '', cmd: 'bash', args: ['-c', "npx --no-install jest --findRelatedTests 'test/it'\\''s.test.js'"], shell: false }]);
  const v = planRun({ ...p, packages: pk('vitest run') });
  assert.deepEqual(v.groups, [{ cwd: '', cmd: 'bash', args: ['-c', "npx --no-install vitest run 'test/it'\\''s.test.js'"], shell: false }]);
  if (hasBash()) {
    const echoed = execFileSync('bash', ['-c', j.groups[0].args[1].replace('npx --no-install jest --findRelatedTests', 'printf %s')], { encoding: 'utf8' });
    assert.equal(echoed, "test/it's.test.js", 'bash reads the quoted argument back verbatim');
  }
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
  const opts = { root: repo, env: {}, stdio: 'ignore', log: (l) => logs.push(l) };
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

function project(dir, { full = 'node --test', expected = 1, maxTargeted } = {}) {
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  w('package.json', JSON.stringify({ name: 't', type: 'module', scripts: { test: 'node --test' } }));
  w('src/a.js', 'export const a = 1;\n');
  w('test/a.test.js', A_TEST(expected));
  w('.planning/turbo/config.json', JSON.stringify({ test: { full, max_targeted: maxTargeted } }));
  return w;
}
const gitIn = (dir) => (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
const markerOf = (dir) => path.resolve(dir, gitIn(dir)('rev-parse', '--git-path', 'turbo-last-green'));
const readMarker = (dir) => { try { return JSON.parse(fs.readFileSync(markerOf(dir), 'utf8')); } catch { return null; } };
const runner = (root, env = {}) => {
  const logs = [];
  return { logs, run: () => runTestChanged({ root, env, stdio: 'ignore', log: (l) => logs.push(l) }) };
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
  assert.deepEqual(readMarker(repo), { fullSha: green, targetedSince: 0 });

  w('src/a.js', 'export const a = 3;\n');
  git('commit', '-qam', 'break');
  assert.notEqual(await r.run(), 0);
  assert.match(r.logs.at(-1), /^targeted: /);
  assert.deepEqual(readMarker(repo), { fullSha: green, targetedSince: 0 }, 'a failing targeted run leaves the marker alone');
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

// --- fix round 2: false-green repros (safe by construction) -------------------------------

const H_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../src/a.js';\nimport { expected } from './helpers/h.mjs';\ntest('a', () => assert.equal(a, expected));\n";

test('critical 1: a changed support file runs the tests that import it', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo);
  w('test/helpers/h.mjs', 'export const expected = 1;\n');
  w('test/a.test.js', H_TEST);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('test/helpers/h.mjs', 'export const expected = 2;\n');
  git('commit', '-qam', 'break the helper');
  assert.notEqual(await r.run(), 0, 'the importing test runs and fails');
  assert.equal(r.logs.at(-1), 'targeted: 1 related test file(s)');
});

test('critical 2: a rename runs the importers of the old path', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  git('mv', 'src/a.js', 'src/b.js');
  w('test/b.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../src/b.js';\ntest('b', () => assert.equal(a, 1));\n");
  git('add', '-A'); git('commit', '-q', '-m', 'rename, test/a.test.js still imports the old path');
  assert.notEqual(await r.run(), 0, 'test/a.test.js runs and fails on the missing module');
});

test('docs: a changed doc runs the tests that mention it', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo);
  w('.planning/STATE.md', 'phase: 1\n');
  w('test/state.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport fs from 'node:fs';\ntest('state', () => assert.match(fs.readFileSync(new URL('../.planning/STATE.md', import.meta.url), 'utf8'), /phase: 1/));\n");
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('.planning/STATE.md', 'phase: 2\n');
  git('commit', '-qam', 'docs change that breaks a test');
  assert.notEqual(await r.run(), 0, 'the mentioning test runs and fails');
  assert.equal(r.logs.at(-1), 'targeted: 1 related test file(s)');
});

test('max_targeted: targeted greens keep the full sha and count up; at the limit a full run resets', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo, { maxTargeted: 1 });
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  const c1 = git('rev-parse', 'HEAD');
  assert.deepEqual(readMarker(repo), { fullSha: c1, targetedSince: 0 });
  w('src/a.js', 'export const a = 1; // c2\n');
  git('commit', '-qam', 'c2');
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'targeted: 1 related test file(s)');
  assert.deepEqual(readMarker(repo), { fullSha: c1, targetedSince: 1 }, 'a targeted green never moves fullSha');
  w('src/a.js', 'export const a = 1; // c3\n');
  git('commit', '-qam', 'c3');
  assert.equal(await r.run(), 0);
  assert.match(r.logs.at(-1), /^full: 1 targeted run\(s\) since the last full run/);
  assert.deepEqual(readMarker(repo), { fullSha: git('rev-parse', 'HEAD'), targetedSince: 0 });
});

test('untracked files: the full command runs but the marker is not updated', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  w('scratch.txt', 'not tracked\n');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'full: untracked files present');
  assert.equal(readMarker(repo), null);
  fs.rmSync(path.join(repo, 'scratch.txt'));
  assert.equal(await r.run(), 0);
  const green = readMarker(repo);
  assert.equal(green.targetedSince, 0);
  w('src/a.js', 'export const a = 1; // c2\n');
  git('commit', '-qam', 'c2');
  w('scratch.txt', 'not tracked\n');
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'full: untracked files present');
  assert.deepEqual(readMarker(repo), green, 'no marker write while untracked files are present');
});

test('project root in a subdirectory: a change outside the root runs full', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const root = path.join(repo, 'app');
  const w = project(root);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(root);
  assert.equal(await r.run(), 0);
  fs.writeFileSync(path.join(repo, 'tool.js'), 'export const t = 1;\n');
  git('add', '-A'); git('commit', '-q', '-m', 'top-level change');
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'full: changes outside the project root');
  w('src/a.js', 'export const a = 1; // inside\n');
  git('commit', '-qam', 'inside the root');
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'targeted: 1 related test file(s)', 'root-relative paths after the prefix is stripped');
});

// --- fix round 3: leaf directory tests, npm hooks, pytest, untracked files, bare scripts ----

test('fix 1: a test only by directory runs when nothing imports it by path; a runner that would skip it runs full', () => {
  const files = {
    'src/a.js': 'export const a = 1',
    'src/__tests__/a.js': "import { a } from '../a.js'",
    'test/a.mjs': "import { a } from '../src/a.js'",
    'test/b.test.js': "import { a } from '../src/a.js'",
    'test/helpers/h.mjs': "export { a } from '../../src/a.js'",
    'test/c.test.js': "import { a } from './helpers/h.mjs'",
  };
  const p = { ...base, sourceFiles: Object.keys(files), testFiles: Object.keys(files).filter(isTestFile), readFile: (f) => files[f], changed: ['src/a.js'], marker: M('X') };
  // every importer of '../src/a.js' mentions the stem `a`; a leaf is decided by the resolved import path
  assert.deepEqual(planRun(p).groups.map((g) => g.args), [['--test', 'src/__tests__/a.js', 'test/a.mjs', 'test/b.test.js', 'test/c.test.js']], 'helpers/h.mjs is imported by path: a support file');
  assert.ok(planRun({ ...p, changed: ['test/a.mjs'] }).groups[0].args.includes('test/a.mjs'), 'a changed leaf runs itself');
  const dot = { 'test/index.mjs': "import { a } from '../src/a.js'", 'test/d.test.js': "import { a } from '../src/a.js'; 'x.y'.split('.')" };
  assert.deepEqual(planRun({ ...base, testFiles: Object.keys(dot), readFile: (f) => dot[f], changed: ['src/a.js'], marker: M('X') }).groups.map((g) => g.args),
    [['--test', 'test/d.test.js', 'test/index.mjs']], "a bare '.' string is not a directory import of test/index.mjs");
  const pk = (testScript) => [{ dir: '', testScript }];
  const j = planRun({ ...p, packages: pk('jest') });
  assert.equal(j.mode, 'full', 'jest does not run test/a.mjs as a test by default');
  assert.match(j.reason, /test\/a\.mjs/);
  const noMjs = { ...p, testFiles: p.testFiles.filter((f) => f !== 'test/a.mjs'), sourceFiles: p.sourceFiles.filter((f) => f !== 'test/a.mjs') };
  const j2 = planRun({ ...noMjs, packages: pk('jest') });
  assert.deepEqual(j2.groups, [{ cwd: '', cmd: 'bash', args: ['-c', "npx --no-install jest --findRelatedTests 'src/__tests__/a.js' 'test/b.test.js' 'test/c.test.js'"], shell: false }], 'jest runs __tests__/** by default');
  assert.equal(planRun({ ...noMjs, packages: pk('vitest run') }).mode, 'full', 'vitest runs only *.test.* / *.spec.* by default');
});

test('fix 2: a pretest or posttest script in the root package.json runs full', () => {
  for (const hooks of [['pretest'], ['posttest'], ['pretest', 'posttest']]) {
    const r = planRun({ ...base, packages: [{ dir: '', testScript: 'node --test test/', hooks }], changed: ['src/a.js'], marker: M('X') });
    assert.deepEqual([r.mode, r.reason], ['full', `root package.json has a ${hooks.join('/')} script`]);
  }
});

const hasNpm = () => { try { execFileSync('bash', ['-c', 'npm --version'], { stdio: 'ignore' }); return true; } catch { return false; } };

test('fix 2: npm test with a failing pretest hook is never a targeted green', async (t) => {
  if (!hasNpm()) { t.skip('npm is not available through bash'); return; }
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo, { full: 'npm test' });
  w('package.json', JSON.stringify({ name: 't', type: 'module', scripts: { pretest: 'node lint.mjs', test: 'node --test' } }));
  w('lint.mjs', "import fs from 'node:fs';\nif (fs.readFileSync('src/a.js', 'utf8').includes('TODO')) process.exit(1);\n");
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('src/a.js', 'export const a = 1; // TODO\n');
  git('commit', '-qam', 'c2: the test still passes, the pretest lint fails');
  assert.notEqual(await r.run(), 0, 'npm test fails in pretest');
  assert.equal(r.logs.at(-1), 'full: root package.json has a pretest script');
});

test('fix 3: a pytest root runs full on any change, docs included', () => {
  for (const testScript of ['pytest -q', 'pytest']) {
    for (const changed of [['docs/x.md'], ['README.md', '.planning/STATE.md']]) {
      const r = planRun({ ...base, testFiles: ['tests/test_a.py'], readFile: () => '', packages: [{ dir: '', testScript }], fullCommand: testScript, changed, marker: M('X') });
      assert.deepEqual([r.mode, r.reason], ['full', 'pytest projects run the full suite'], `${testScript} ${changed}`);
    }
  }
});

test('fix 4: untracked files run full and leave the marker alone, even when HEAD is fully green', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  const green = readMarker(repo);
  w('test/new.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('new', () => assert.fail('red'));\n");
  assert.notEqual(await r.run(), 0, 'the full command runs the untracked failing test');
  assert.equal(r.logs.at(-1), 'full: untracked files present');
  assert.deepEqual(readMarker(repo), green);
});

test('fix 5: targeted only for bare runner scripts; env, wrappers, extra flags and expansions run full', () => {
  const unknown = [
    'node --test --test-coverage-lines=80', 'node --test test/ --test-reporter=dot', 'node --test -- test/a.test.js',
    'node --test-coverage-lines=80 --experimental-test-coverage --test', 'node --test-shard=1/2 --test',
    'node --test $TEST_ARGS', 'node --test `ls test`', 'node --test\nnode extra.js', 'node --test > out.log',
    'jest --ci', 'jest --config jest.ci.js', 'jest src "--coverage"', 'cross-env NODE_ENV=test jest', 'NODE_ENV=test jest', 'npx jest', 'dotenv -- jest',
    'vitest --typecheck', 'vitest run --typecheck', 'npx vitest run', 'vitest bench', 'vitest watch', 'NODE_ENV=test node --test',
  ];
  for (const s of unknown) {
    assert.equal(classifyScript(s).kind, 'unknown', s);
    assert.equal(planRun({ ...base, packages: [{ dir: '', testScript: s }], changed: ['src/a.js'], marker: M('X') }).mode, 'full', s);
  }
  const known = [['node --test', 'node-test'], ['node --test "test/**/*.test.mjs" test/x.js', 'node-test'], ['jest', 'jest'], ['jest src/', 'jest'], ['vitest', 'vitest'], ['vitest run', 'vitest'], ['vitest run src', 'vitest']];
  for (const [s, kind] of known) assert.equal(classifyScript(s).kind, kind, s);
  assert.deepEqual(classifyScript('node --experimental-vm-modules --test-reporter=dot --test test/'), { kind: 'node-test', prefix: ['--experimental-vm-modules', '--test-reporter=dot'] });
  // the root script is what the full command runs: it must be a bare runner wherever the tests live
  const files = { 'web/test/a.test.js': "import '../src/a.js'" };
  // (the root-script gate comes before the nested-package gate of fix 3b)
  for (const rootScript of ['npm test --workspaces', 'lerna run test', 'NODE_ENV=test node --test', '']) {
    const r = planRun({ ...base, testFiles: Object.keys(files), readFile: (f) => files[f], changed: ['web/src/a.js'], marker: M('X'), packages: [{ dir: '', testScript: rootScript }, { dir: 'web', testScript: 'jest' }] });
    assert.deepEqual([r.mode, r.reason], ['full', 'unknown test runner in root'], rootScript);
  }
});

test('fix 3b: a changed file or a selected test under a nested package runs full', () => {
  // the full command (root `node --test`) runs web/**/*.test.js under node; a jest group in web/ would not mirror it
  const files = { 'web/test/a.test.js': "import '../src/a.js'", 'web/test/b.test.js': "import '../../src/b.js'", 'test/b.test.js': "import '../src/b.js'" };
  const pkgs = [{ dir: '', testScript: 'node --test' }, { dir: 'web', testScript: 'jest' }];
  const p = { ...base, testFiles: Object.keys(files), readFile: (f) => files[f], packages: pkgs, marker: M('X') };
  for (const changed of [['web/src/a.js'], ['web/README.md'], ['src/b.js', 'web/test/a.test.js']]) {
    assert.deepEqual([planRun({ ...p, changed }).mode, planRun({ ...p, changed }).reason], ['full', 'changes in a nested package'], String(changed));
  }
  const r = planRun({ ...p, changed: ['src/b.js'] }); // root change, but web/test/b.test.js imports it
  assert.deepEqual([r.mode, r.reason], ['full', 'web/test/b.test.js is in a nested package']);
  const rootOnly = planRun({ ...p, packages: [pkgs[0]], changed: ['src/b.js'] });
  assert.deepEqual(rootOnly.groups.map((g) => g.args), [['--test', 'test/b.test.js', 'web/test/b.test.js']], 'without web/package.json the root governs web/');
});
