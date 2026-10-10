import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { isTestFile, isRunnableTest, classifyScript, relatedTests, planRun, planEntries, runTestChanged } from '../lib/test-changed.mjs';
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

test('support files: the importing tests run, never the helper itself; a changed file in a test dir nothing imports runs full', () => {
  const files = { 'test/a.test.mjs': "import { h } from './helpers/h.mjs'", 'test/helpers/h.mjs': 'export const h = 1', 'test/helpers/lonely.mjs': '' };
  const p = { ...base, testFiles: Object.keys(files), readFile: (f) => files[f], marker: M('X') };
  const t = planRun({ ...p, changed: ['test/helpers/h.mjs'] });
  assert.equal(t.mode, 'targeted');
  assert.deepEqual(t.groups.map((g) => g.args), [['--test', 'test/a.test.mjs']]);
  // final B1: run alone it proves nothing (a fixture read by directory passes with 0 tests)
  assert.deepEqual(planRun({ ...p, changed: ['test/helpers/lonely.mjs'] }).mode, 'full');
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
  assert.deepEqual(readMarker(repo), { fullSha: green, targetedSince: 0, command: 'node --test' });

  w('src/a.js', 'export const a = 3;\n');
  git('commit', '-qam', 'break');
  assert.notEqual(await r.run(), 0);
  assert.match(r.logs.at(-1), /^targeted: /);
  assert.deepEqual(readMarker(repo), { fullSha: green, targetedSince: 0, command: 'node --test' }, 'a failing targeted run leaves the marker alone');
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
  assert.deepEqual(readMarker(repo), { fullSha: c1, targetedSince: 0, command: 'node --test' });
  w('src/a.js', 'export const a = 1; // c2\n');
  git('commit', '-qam', 'c2');
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'targeted: 1 related test file(s)');
  assert.deepEqual(readMarker(repo), { fullSha: c1, targetedSince: 1, command: 'node --test' }, 'a targeted green never moves fullSha');
  w('src/a.js', 'export const a = 1; // c3\n');
  git('commit', '-qam', 'c3');
  assert.equal(await r.run(), 0);
  assert.match(r.logs.at(-1), /^full: 1 targeted run\(s\) since the last full run/);
  assert.deepEqual(readMarker(repo), { fullSha: git('rev-parse', 'HEAD'), targetedSince: 0, command: 'node --test' });
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
    'src/__tests__/a.js': "import { test } from 'node:test'; import { a } from '../a.js'",
    'test/a.mjs': "import { test } from 'node:test'; import { a } from '../src/a.js'",
    'test/b.test.js': "import { a } from '../src/a.js'",
    'test/helpers/h.mjs': "export { a } from '../../src/a.js'",
    'test/c.test.js': "import { a } from './helpers/h.mjs'",
  };
  const p = { ...base, sourceFiles: Object.keys(files), testFiles: Object.keys(files).filter(isTestFile), readFile: (f) => files[f], changed: ['src/a.js'], marker: M('X') };
  // every importer of '../src/a.js' mentions the stem `a`; a leaf is decided by the resolved import path
  assert.deepEqual(planRun(p).groups.map((g) => g.args), [['--test', 'src/__tests__/a.js', 'test/a.mjs', 'test/b.test.js', 'test/c.test.js']], 'helpers/h.mjs is imported by path: a support file');
  assert.ok(planRun({ ...p, changed: ['test/a.mjs'] }).groups[0].args.includes('test/a.mjs'), 'a changed leaf runs itself');
  const dot = { 'test/index.mjs': "import 'node:test'; import { a } from '../src/a.js'", 'test/d.test.js': "import { a } from '../src/a.js'; 'x.y'.split('.')" };
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

// --- final fix wave, area B: false greens (safe by construction) ---------------------------

function fixtureRepo(files, script = 'node --test') {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
  w('package.json', JSON.stringify({ name: 't', type: 'module', scripts: { test: script } }));
  w('.planning/turbo/config.json', JSON.stringify({ test: { full: script } }));
  for (const [f, s] of Object.entries(files)) w(f, s);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  return { repo, git, w };
}

// Loads every file in test/fixtures/ by directory: it never names a fixture.
const READDIR_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport fs from 'node:fs';\nconst dir = new URL('./fixtures/', import.meta.url);\ntest('fixtures', async () => { for (const f of fs.readdirSync(dir)) assert.equal((await import(new URL(f, dir))).default, 1, f); });\n";
const plan = (files, extra = {}) => {
  const all = Object.keys(files);
  return planRun({ ...base, marker: M('X'), readFile: (f) => files[f] ?? '', testFiles: all.filter(isTestFile), sourceFiles: all, ...extra });
};
const groupArgs = (r) => r.groups.map((g) => g.args);

test('final B1: a changed fixture never covers itself; the consuming test runs in the full run', async () => {
  const { repo, git, w } = fixtureRepo({ 'test/fixtures/case1.js': 'export default 1;\n', 'test/fixtures.test.mjs': READDIR_TEST }, 'node --test test/*.test.mjs');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('test/fixtures/case1.js', 'export default 2;\n');
  git('commit', '-qam', 'break the fixture');
  assert.notEqual(await r.run(), 0, 'the consuming test runs and fails');
  assert.equal(r.logs.at(-1), 'full: no related test for test/fixtures/case1.js');
});

test('final B1: a fixture reached from a changed source is no test under node --test; the run is full', async () => {
  const { repo, git, w } = fixtureRepo({
    'src/a.js': 'export const a = 1;\n',
    'test/fixtures/case1.js': "export { a as default } from '../../src/a.js';\n",
    'test/fixtures.test.mjs': READDIR_TEST,
    'test/a.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../src/a.js';\ntest('a', () => assert.equal(typeof a, 'number'));\n",
  }, 'node --test test/*.test.mjs');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('src/a.js', 'export const a = 2;\n');
  git('commit', '-qam', 'break the fixture through its source');
  assert.notEqual(await r.run(), 0, 'the consuming test runs and fails');
  assert.equal(r.logs.at(-1), 'full: test/fixtures/case1.js is a test only by directory and does not import node:test');
});

test('final B1: pure decisions for fixtures and tests by directory', () => {
  const files = { 'src/a.js': '', 'test/fixtures/case1.js': "export { a as default } from '../../src/a.js'", 'test/a.test.mjs': "import 'node:test'; import '../src/a.js'" };
  const only = { 'src/a.js': '', 'test/fixtures/case1.js': files['test/fixtures/case1.js'] };
  const r = plan(only, { changed: ['src/a.js'] });
  assert.deepEqual([r.mode, r.reason], ['full', 'no related test for src/a.js'], 'a fixture alone is no proof');
  const t = plan({ ...files, 'test/fixtures/case1.js': "import 'node:test'; import '../../src/a.js'" }, { changed: ['src/a.js'] });
  assert.deepEqual(groupArgs(t), [['--test', 'test/a.test.mjs', 'test/fixtures/case1.js']], 'with node:test it is a test');
  const self = plan({ 'test/x.mjs': "import 'node:test'" }, { changed: ['test/x.mjs'] });
  assert.equal(self.mode, 'full', 'a test by directory never covers itself');
  assert.equal(plan({ 'test/x.test.mjs': "import 'node:test'" }, { changed: ['test/x.test.mjs'] }).mode, 'targeted', 'a test by name does');
});

test('final B2: a test name with glob characters runs full (node --test reads paths as globs on Node 22+)', async () => {
  const { repo, git, w } = fixtureRepo({ 'src/a.js': 'export const a = 1;\n', 'test/[id].test.js': A_TEST(1) });
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('src/a.js', 'export const a = 2;\n');
  git('commit', '-qam', 'break a');
  assert.notEqual(await r.run(), 0, 'the full command runs test/[id].test.js');
  assert.equal(r.logs.at(-1), 'full: test/[id].test.js has glob characters node --test would expand');
  for (const f of ['test/a+(b).test.js', 'test/{x}.test.js', 'test/a?.test.js', 'test/!a.test.js', 'test/@(a).test.js', 'test/a*.test.js']) {
    assert.equal(plan({ [f]: "import '../src/a.js'" }, { changed: ['src/a.js'] }).mode, 'full', f);
  }
});

test('final B3/B10: quoted or backslash-escaped flags are never carried into a targeted run', async () => {
  for (const s of ['node --test-name-pattern="unit" --test', "node --test-name-pattern='unit' --test", 'node --test-name-pattern=\\"unit\\" --test', 'jest \\--coverage', 'node --test \\--x']) {
    assert.equal(classifyScript(s).kind, 'unknown', s);
  }
  assert.deepEqual(classifyScript('node --test-name-pattern=unit --test'), { kind: 'node-test', prefix: ['--test-name-pattern=unit'] });
  const script = 'node --test-name-pattern="unit" --test';
  const { repo, git, w } = fixtureRepo({
    'src/a.js': 'export const a = 1;\n',
    'test/a.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../src/a.js';\ntest('unit a', () => assert.equal(a, 1));\n",
  }, script);
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('src/a.js', 'export const a = 2;\n');
  git('commit', '-qam', 'break a');
  assert.notEqual(await r.run(), 0, 'the full command runs the "unit" tests');
  assert.equal(r.logs.at(-1), 'full: unknown test runner in root');
});

test('final B3 (beyond the ruling): --test-isolation shares one process between files, so it runs full', () => {
  for (const s of ['node --test-isolation=none --test', 'node --experimental-test-isolation=none --test']) assert.equal(classifyScript(s).kind, 'unknown', s);
});

test('final B4: a doc read by directory or by extension runs the tests that read it', () => {
  for (const [doc, src] of [
    ['.claude/rules/style.md', "for (const f of fs.readdirSync('.claude/rules')) check(f);"],
    ['.planning/seeds/SEED-001.md', "fs.readdirSync(path.join(root, '.planning', 'seeds'))"],
    ['docs/guide/deep/x.md', "walk(path.join(root, 'docs/'))"],
    ['docs/guide/x.md', "glob('**/*.md')"],
    ['README.md', "files.filter((f) => f.endsWith('.md'))"],
  ]) {
    const r = plan({ 'test/docs.test.js': src, 'test/other.test.js': "import '../src/a.js'" }, { changed: [doc] });
    assert.deepEqual(groupArgs(r), [['--test', 'test/docs.test.js']], doc);
  }
  // only docs, which need no coverage: a test naming its directory never covers any other file
  const data = plan({ 'test/data.test.js': "fs.readdirSync(new URL('./fixtures', import.meta.url))" }, { changed: ['test/fixtures/a.json'] });
  assert.deepEqual([data.mode, data.reason], ['full', 'no related test for test/fixtures/a.json']);
});

test('final B5/B8: bare, trailing-slash and package-main directory imports reach their tests', () => {
  const cases = [
    { name: "jest __tests__ importing '..'", script: 'jest', changed: 'src/foo/bar.js',
      files: { 'src/foo/index.js': "export * from './bar'", 'src/foo/bar.js': '', 'src/foo/__tests__/foo.test.js': "import * as foo from '..'", 'src/foo/__tests__/bar.test.js': "import { b } from '../bar'" },
      want: ['src/foo/__tests__/bar.test.js', 'src/foo/__tests__/foo.test.js'] },
    { name: "require('..') of the root index.js", changed: 'lib/a.js',
      files: { 'index.js': "module.exports = require('./lib/a')", 'lib/a.js': '', 'test/index.test.js': "const m = require('..')", 'test/a.test.js': "require('../lib/a')" },
      want: ['test/a.test.js', 'test/index.test.js'] },
    { name: "require('../lib/')", changed: 'lib/y.js',
      files: { 'lib/index.js': "module.exports = require('./y')", 'lib/y.js': '', 'test/all.test.js': "require('../lib/')", 'test/y.test.js': "require('../lib/y')" },
      want: ['test/all.test.js', 'test/y.test.js'] },
    { name: "require('./') next to index.js", changed: 'lib/y.js',
      files: { 'lib/index.js': "module.exports = require('./y')", 'lib/y.js': '', 'lib/index.test.js': "require('./')", 'lib/y.test.js': "require('./y')" },
      want: ['lib/index.test.js', 'lib/y.test.js'] },
    { name: "require('..') of the package.json main", main: './lib/main.js', changed: 'lib/a.js',
      files: { 'lib/main.js': "module.exports = require('./a')", 'lib/a.js': '', 'test/pkg.test.js': "require('..')", 'test/a.test.js': "require('../lib/a')" },
      want: ['test/a.test.js', 'test/pkg.test.js'] },
  ];
  for (const c of cases) {
    const r = plan(c.files, { changed: [c.changed], packages: [{ dir: '', testScript: c.script ?? 'node --test', main: c.main }] });
    assert.equal(r.mode, 'targeted', c.name);
    const args = r.groups[0].args;
    for (const t of c.want) assert.ok(args.some((a) => a === t || a.includes(`'${t}'`)), `${c.name}: ${t} in ${args}`);
  }
});

test('final B6: a test by directory that a non-test source imports still runs', () => {
  const files = { 'src/x.js': '', 'test/a.mjs': "import 'node:test'; import { x } from '../src/x.js'", 'test/b.test.js': "import { x } from '../src/x.js'", 'scripts/run-all.mjs': "await import('../test/a.mjs')" };
  assert.deepEqual(groupArgs(plan(files, { changed: ['src/x.js'] })), [['--test', 'test/a.mjs', 'test/b.test.js']]);
});

test('final B7: an import of a.cjs never makes a.mjs a support file; ./h.js still resolves to h.ts', () => {
  const files = { 'src/x.js': '', 'test/a.mjs': "import 'node:test'; import { x } from '../src/x.js'", 'test/a.cjs': 'module.exports = 1', 'test/b.test.js': "require('./a.cjs'); require('../src/x.js')" };
  assert.deepEqual(groupArgs(plan(files, { changed: ['src/x.js'] })), [['--test', 'test/a.mjs', 'test/b.test.js']]);
  const ts = { 'src/x.ts': '', 'test/h.ts': "export * from '../src/x.js'", 'test/c.test.ts': "import './h.js'" };
  assert.deepEqual(groupArgs(plan(ts, { changed: ['src/x.ts'] })), [['--test', 'test/c.test.ts']]);
});

test('final B9: node default test names are tests', () => {
  for (const f of ['src/x_test.js', 'src/x-test.mjs', 'src/test-x.cjs', 'test.js', 'a/test.ts']) {
    assert.ok(isTestFile(f), f);
    assert.ok(isRunnableTest(f), f);
  }
  for (const f of ['src/latest.js', 'src/contest.js', 'src/test.config.js', 'src/attest-x.js']) assert.ok(!isRunnableTest(f), f);
  for (const name of ['src/x_test.js', 'src/x-test.js', 'src/test-x.js', 'test.js']) {
    const files = { 'src/x.js': '', [name]: `import 'node:test'; import { x } from '${name === 'test.js' ? './src/x.js' : './x.js'}'`, 'test/y.test.js': "import { x } from '../src/x.js'" };
    assert.deepEqual(groupArgs(plan(files, { changed: ['src/x.js'] })), [['--test', ...[name, 'test/y.test.js'].sort()]], name);
  }
});

test('final B9: under jest a test is what jest runs by default: test-utils.js is support, __tests__/* is a test', () => {
  const files = {
    'src/a.js': '', 'src/test-utils.js': "export * from './a.js'", 'src/a.test.js': "import './test-utils.js'; import './a.js'",
    'src/__tests__/helpers.js': 'export const h = 1', 'src/__tests__/b.test.js': "import { h } from './helpers.js'",
  };
  const jest = { packages: [{ dir: '', testScript: 'jest' }] };
  const u = plan(files, { ...jest, changed: ['src/test-utils.js'] });
  assert.deepEqual(u.groups.map((g) => g.args[1]), ["npx --no-install jest --findRelatedTests 'src/a.test.js'"]);
  const h = plan(files, { ...jest, changed: ['src/__tests__/helpers.js'] });
  assert.deepEqual(h.groups.map((g) => g.args[1]), ["npx --no-install jest --findRelatedTests 'src/__tests__/b.test.js' 'src/__tests__/helpers.js'"], 'jest runs it and fails a file without tests');
  const m = plan({ 'src/a.js': '', 'src/a.test.mjs': "import './a.js'" }, { ...jest, changed: ['src/a.js'] });
  assert.deepEqual([m.mode, m.reason], ['full', 'src/a.test.mjs is outside the jest default test match'], 'jest 29 runs no .mjs test by default');
});

test('final B11: a changed file loaded by a carried prefix flag, or reaching one, runs full', () => {
  const script = 'node --import=./setup.mjs --env-file=.env.test --test';
  const files = { 'setup.mjs': "import './src/a.js'", 'test/a.test.js': "import '../src/a.js'; import '../setup.mjs'", 'test/b.test.js': "import '../src/b.js'" };
  const p = { packages: [{ dir: '', testScript: script }], fullCommand: script };
  for (const c of ['setup.mjs', 'src/a.js', '.env.test']) {
    const r = plan(files, { ...p, changed: [c] });
    assert.equal(r.mode, 'full', c);
    assert.match(r.reason, /loaded by --(import|env-file)$/, c);
  }
  assert.deepEqual(groupArgs(plan(files, { ...p, changed: ['src/b.js'] })), [['--import=./setup.mjs', '--env-file=.env.test', '--test', 'test/b.test.js']]);
});

test('final B12: a jest or vitest config that changes the test set, coverage or isolation runs full', () => {
  const pk = (testScript) => [{ dir: '', testScript }];
  const p = { ...base, changed: ['src/a.js'], marker: M('X') };
  for (const [script, cfg, key] of [
    ['jest', '{"coverageThreshold":{"global":{"lines":80}},"collectCoverage":true}', 'coverageThreshold'],
    ['jest', "module.exports = { testMatch: ['**/*.it.js'] }", 'testMatch'],
    ['jest', "module.exports = { testPathIgnorePatterns: ['/fixtures/'] }", 'testPathIgnorePatterns'],
    ['vitest run', 'export default defineConfig({ test: { typecheck: { enabled: true } } })', 'typecheck'],
    ['vitest run', 'export default { test: { coverage: { thresholds: { lines: 80 } } } }', 'thresholds'],
    ['vitest run', "export default { test: { include: ['src/**/*.check.ts'] } }", 'include'],
    ['vitest run', "export default { test: { includeSource: ['src/**/*.ts'] } }", 'includeSource'],
    ['vitest', 'export default { test: { isolate: false } }', 'isolate'],
  ]) {
    const r = planRun({ ...p, packages: pk(script), runnerConfig: cfg });
    assert.deepEqual([r.mode, r.reason], ['full', `${classifyScript(script).kind} config sets ${key}`], cfg);
  }
  assert.equal(planRun({ ...p, packages: pk('jest'), runnerConfig: "module.exports = { testEnvironment: 'node' }" }).mode, 'targeted');
  assert.equal(planRun({ ...p, runnerConfig: '{"coverageThreshold":{}}' }).mode, 'targeted', 'node --test reads no jest config');
});

test('final B12: runTestChanged reads the jest config from package.json and from jest.config.*', async () => {
  for (const [jestKey, configFile, key] of [[{ coverageThreshold: { global: { lines: 90 } } }, null, 'coverageThreshold'], [undefined, "module.exports = { testMatch: ['**/*.it.js'] };\n", 'testMatch']]) {
    const repo = tmpGitRepo();
    const git = gitIn(repo);
    const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
    w('package.json', JSON.stringify({ name: 't', scripts: { test: 'jest' }, jest: jestKey }));
    if (configFile) w('jest.config.cjs', configFile);
    w('.planning/turbo/config.json', JSON.stringify({ test: { full: 'jest' } }));
    w('src/a.js', 'exports.a = 1;\n');
    w('test/a.test.js', "const { a } = require('../src/a.js');\ntest('a', () => expect(a).toBe(1));\n");
    git('add', '-A'); git('commit', '-q', '-m', 'c1');
    fs.writeFileSync(markerOf(repo), JSON.stringify({ fullSha: git('rev-parse', 'HEAD'), targetedSince: 0 }));
    w('src/a.js', 'exports.a = 2;\n');
    git('commit', '-qam', 'c2');
    const r = runner(repo);
    await r.run(); // jest is not installed here: only the plan matters
    assert.equal(r.logs[0], `full: jest config sets ${key}`);
  }
});

// a path with `"`, `\`, a control character or DEL (git would C-quote it) runs full
test('follow-up: a path git prints quoted runs full (planRun)', () => {
  const quoted = '"test/a\\"b.test.js"';
  const r = planRun({ ...base, changed: ['src/a.js'], allFiles: ['src/a.js', 'test/a.test.js', quoted], marker: M('X') });
  assert.deepEqual([r.mode, r.reason], ['full', `unusual file name: ${JSON.stringify(quoted)}`], 'a tracked test git quotes is never a candidate');
  const c = planRun({ ...base, changed: ['src/a.js', '"src/a\\177.js"'], marker: M('X') });
  assert.deepEqual([c.mode, c.reason], ['full', `unusual file name: ${JSON.stringify('"src/a\\177.js"')}`]);
  assert.equal(planRun({ ...base, changed: [], allFiles: [quoted], marker: M('H') }).mode, 'skip', 'nothing changed since the full green run');
});

test('follow-up: a test whose name git quotes is never dropped from a targeted run', async (t) => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo);
  w('test/a.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../src/a.js';\ntest('a', () => assert.equal(typeof a, 'number'));\n");
  try { w('test/q\x7f.test.js', A_TEST(1)); } catch { t.skip('the file system refuses DEL in a file name'); return; }
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('src/a.js', 'export const a = 2;\n');
  git('commit', '-qam', 'break a for the quoted test only');
  assert.notEqual(await r.run(), 0, 'the full command runs the quoted test');
  assert.equal(r.logs.at(-1), 'full: unusual file name: "test/q\\u007f.test.js"');
});

test('follow-up 2: a source under docs/ needs coverage and gains none from a test reading docs/ or naming .js', () => {
  const base2 = { 'src/util.js': 'export const u = 1', 'docs/examples/basic.js': "import { u } from '../../src/util.js'", 'test/u.test.js': "import 'node:test'; import { u } from '#utils'" };
  const byDir = plan({ ...base2, 'test/docs.test.js': "import 'node:test'; for (const f of fs.readdirSync('docs')) check(f);" }, { changed: ['src/util.js'] });
  assert.deepEqual([byDir.mode, byDir.reason], ['full', 'no related test for src/util.js'], 'a test reading docs/ by directory');
  const byExt = plan({ ...base2, 'lib/loader.js': "export const isJs = (f) => f.endsWith('.js')", 'test/loader.test.js': "import 'node:test'; import { isJs } from '../lib/loader.js'" }, { changed: ['src/util.js'] });
  assert.deepEqual([byExt.mode, byExt.reason], ['full', 'no related test for src/util.js'], "a source with a '.js' string");
  const self = plan(base2, { changed: ['docs/examples/basic.js'] });
  assert.deepEqual([self.mode, self.reason], ['full', 'no related test for docs/examples/basic.js'], 'no docs exemption for a source');
  const md = plan({ 'test/docs.test.js': "import 'node:test'; fs.readdirSync('docs')" }, { changed: ['docs/guide.md'] });
  assert.deepEqual(groupArgs(md), [['--test', 'test/docs.test.js']], 'a markdown doc still matches by directory');
});

test('follow-up 2: a test reading docs/ never stands in for the alias consumer of a source a docs example imports', async () => {
  const { repo, git, w } = fixtureRepo({
    'src/util.js': 'export const u = 1;\n',
    'docs/examples/basic.js': "import { u } from '../../src/util.js';\nconsole.log(u);\n",
    'test/docs.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport fs from 'node:fs';\ntest('docs exist', () => assert.ok(fs.readdirSync('docs').length > 0));\n",
    'test/u.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { u } from '#utils';\ntest('u', () => assert.equal(u, 1));\n",
  });
  w('package.json', JSON.stringify({ name: 't', type: 'module', imports: { '#utils': './src/util.js' }, scripts: { test: 'node --test' } }));
  git('commit', '-qam', 'package imports');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('src/util.js', 'export const u = 2;\n');
  git('commit', '-qam', 'break util');
  assert.notEqual(await r.run(), 0, 'the alias consumer runs and fails');
  assert.equal(r.logs.at(-1), 'full: no related test for src/util.js');
});

test('follow-up 2: braces in a prefix-flag value are never carried (bash expands them in the full run)', async (t) => {
  for (const s of ['node --test-name-pattern={unit,integ} --test', 'node --test-name-pattern=a{1..3} --test']) assert.equal(classifyScript(s).kind, 'unknown', s);
  if (!hasBash()) { t.skip('bash is not available: the full run would not expand the braces'); return; }
  const script = 'node --test-name-pattern={unit,integ} --test';
  const { repo, git, w } = fixtureRepo({
    'src/a.js': 'export const a = 1;\n',
    'test/a.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../src/a.js';\ntest('unit a', () => assert.equal(a, 1));\n",
  }, script);
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('src/a.js', 'export const a = 2;\n');
  git('commit', '-qam', 'break a');
  assert.notEqual(await r.run(), 0, 'the full command runs the "unit" tests');
  assert.equal(r.logs.at(-1), 'full: unknown test runner in root');
});

// --- 0.2.2: test.full as a list of packages (each entry planned on its own) ------------------

const ROOT_E = { dir: '', command: 'npm test' };
const SERVER_E = { dir: 'server', command: 'npm test' };
const APP_E = { dir: 'app', command: 'npm test' };
const MULTI = {
  'package.json': '{}', 'src/core.js': '', 'test/core.test.js': "import '../src/core.js'",
  'server/package.json': '{}', 'server/src/store.js': '', 'server/test/store.test.js': "import '../src/store.js'",
  'app/package.json': '{}', 'app/src/view.js': '', 'app/test/view.test.js': "import '../src/view.js'",
};
const multiPkgs = (over = {}) => [
  { dir: '', testScript: 'node --test test/core.test.js', hooks: [] },
  { dir: 'server', testScript: 'node --test', hooks: [] },
  { dir: 'app', testScript: 'node --test', hooks: [] },
].map((p) => ({ ...p, ...(over[p.dir] ?? {}) }));
// every entry with a marker at X and the same window of changed files, unless given
function multi(changed, { files = {}, entries = [ROOT_E, SERVER_E, APP_E], packages = multiPkgs(), markers, windows, ...opts } = {}) {
  const all = { ...MULTI, ...files };
  return planEntries({
    entries,
    markers: markers ?? Object.fromEntries(entries.map((e) => [e.dir, M('X')])),
    windows: windows ?? Object.fromEntries(entries.map((e) => [e.dir, { changed }])),
    allFiles: Object.keys(all), packages, readFile: (f) => all[f] ?? '', head: 'H', ...opts,
  });
}
const plansOf = (r) => Object.fromEntries(r.plans.map(({ entry, plan }) => [entry.dir, plan]));

test('multi: each entry is planned on its own, relative to its directory, and runs there', () => {
  const s = plansOf(multi(['server/src/store.js']));
  assert.deepEqual([s[''].mode, s.app.mode], ['skip', 'skip']);
  assert.deepEqual([s.server.mode, s.server.groups], ['targeted', [{ cwd: 'server', cmd: process.execPath, args: ['--test', 'test/store.test.js'], shell: false }]]);
  const r = plansOf(multi(['src/core.js']));
  assert.deepEqual(r[''].groups, [{ cwd: '', cmd: process.execPath, args: ['--test', 'test/core.test.js'], shell: false }]);
  assert.deepEqual([r.server.mode, r.app.mode], ['skip', 'skip']);
  // an entry's own rules: its package.json test script, its hooks, its runner
  const hooks = plansOf(multi(['server/src/store.js'], { packages: multiPkgs({ server: { hooks: ['pretest'] } }) }));
  assert.deepEqual([hooks.server.mode, hooks.server.reason, hooks.server.groups], ['full', 'server/package.json has a pretest script', [{ cwd: 'server', cmd: 'npm test', args: [], shell: true }]]);
  const unknown = plansOf(multi(['app/src/view.js'], { packages: multiPkgs({ app: { testScript: 'node --test && eslint .' } }) }));
  assert.deepEqual([unknown.app.mode, unknown.app.reason, unknown[''].mode], ['full', 'unknown test runner in app', 'skip']);
  const none = plansOf(multi(['server/src/store.js'], { packages: multiPkgs().filter((p) => p.dir !== 'server') }));
  assert.deepEqual([none.server.mode, none.server.reason], ['full', 'unknown test runner in server'], 'no package.json of its own');
});

test('multi: a change outside an entry that the entry\'s files mention or import makes that entry run full', () => {
  const files = { 'server/test/shared.test.js': "import '../../src/core.js'" };
  const r = plansOf(multi(['src/core.js'], { files }));
  assert.equal(r[''].mode, 'targeted');
  assert.deepEqual([r.server.mode, r.server.reason], ['full', 'server/test/shared.test.js reaches src/core.js, changed outside this entry']);
  assert.deepEqual(r.server.groups, [{ cwd: 'server', cmd: 'npm test', args: [], shell: true }]);
  assert.equal(r.app.mode, 'skip', 'an entry that does not mention it is not affected');
  // and the other way round: the root imports a nested package's file
  const back = plansOf(multi(['app/src/view.js'], { files: { 'test/view-use.test.js': "import '../app/src/view.js'" } }));
  assert.deepEqual([back[''].mode, back[''].reason], ['full', 'test/view-use.test.js reaches app/src/view.js, changed outside this entry']);
  assert.equal(back.app.mode, 'targeted');
  // through a file of another entry: app imports server's barrel, which imports the root file
  const chain = plansOf(multi(['src/core.js'], { files: { 'server/src/index.js': "export * from '../../src/core.js'", 'app/src/view.js': "import '../../server/src/index.js'" } }));
  assert.deepEqual([chain.app.mode, chain.app.reason], ['full', 'app/src/view.js reaches src/core.js, changed outside this entry']);
  // a workspace import by package name, of the changed file's package or of one that reaches it
  const pk = multiPkgs({ server: { name: '@demo/server' } });
  const byName = plansOf(multi(['server/src/store.js'], { packages: pk, files: { 'app/src/view.js': "import { store } from '@demo/server/lib'" } }));
  assert.deepEqual([byName.app.mode, byName.app.reason], ['full', 'app/src/view.js imports @demo/server (server/src/store.js changed)']);
  const viaName = plansOf(multi(['src/core.js'], { packages: pk, files: { 'server/src/index.js': "export * from '../../src/core.js'", 'app/src/view.js': "import '@demo/server'" } }));
  assert.deepEqual([viaName.app.mode, viaName.app.reason], ['full', 'app/src/view.js imports @demo/server (src/core.js changed)']);
});

test('multi review 1: an entry\'s own change selects the entry\'s tests that reach it through another entry\'s files', () => {
  // the root test reaches lib/config.js only through server/app.js; the root's script does not run server/
  const files = {
    'lib/config.js': '', 'test/config.test.js': "import '../lib/config.js'",
    'test/e2e.test.js': "import '../server/app.js'", 'server/app.js': "import '../lib/config.js'",
  };
  const r = plansOf(multi(['lib/config.js'], { files, packages: multiPkgs({ '': { testScript: 'node --test "test/*.test.js"' } }) }));
  assert.deepEqual(r[''].groups.map((g) => g.args), [['--test', 'test/config.test.js', 'test/e2e.test.js']]);
  assert.equal(r.server.mode, 'full', 'server/app.js reaches it');
  // the mirror: a nested test reaches the nested file through a root helper
  const mirror = {
    'server/src/a.js': '', 'server/test/a.test.js': "import '../src/a.js'",
    'server/test/x.test.js': "import '../../lib/helper.js'", 'lib/helper.js': "import '../server/src/a.js'",
  };
  const s = plansOf(multi(['server/src/a.js'], { files: mirror }));
  assert.deepEqual(s.server.groups.map((g) => [g.cwd, g.args]), [['server', ['--test', 'test/a.test.js', 'test/x.test.js']]]);
});

test('multi re-review N1: a single nested entry selects its test that reaches its change through a root helper', () => {
  // what init writes for a workspaces root with one package: no root entry
  const files = {
    'server/src/model.js': '', 'server/test/model.test.js': "import '../src/model.js'",
    'test-utils/factory.js': "import '../server/src/model.js'", 'server/test/factory.test.js': "import '../../test-utils/factory.js'",
  };
  const r = plansOf(multi(['server/src/model.js'], { files, entries: [SERVER_E] }));
  assert.deepEqual(r.server.groups.map((g) => [g.cwd, g.args]), [['server', ['--test', 'test/factory.test.js', 'test/model.test.js']]]);
});

test('multi review 3: a relative import of a package directory reaches every file of that package', () => {
  // '../server' resolves through server/package.json "main", which an index.* rule never sees
  const main = plansOf(multi(['server/src/main.js'], {
    files: { 'server/src/main.js': '', 'server/test/main.test.js': "import '../src/main.js'", 'test/e2e.test.js': "import '../server'" },
    packages: multiPkgs({ server: { main: 'src/main.js' } }),
  }));
  assert.deepEqual([main[''].mode, main[''].reason], ['full', 'test/e2e.test.js reaches server/src/main.js, changed outside this entry']);
  // a package that is no entry, built to dist/: its sources reach whoever imports its directory
  const shared = plansOf(multi(['shared/src/x.js'], {
    files: { 'shared/package.json': '{}', 'shared/src/x.js': '', 'server/app.js': "const s = require('../shared');" },
    packages: [...multiPkgs(), { dir: 'shared', testScript: '', hooks: [], main: 'dist/lib.js' }],
  }));
  assert.deepEqual([shared.server.mode, shared.server.reason], ['full', 'server/app.js reaches shared/src/x.js, changed outside this entry']);
  assert.equal(shared.app.mode, 'skip');
});

test('multi review 1 e2e: a root test that reaches a changed root file through a nested entry runs and fails', async () => {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
  const script = 'node --test test/config.test.mjs test/e2e.test.mjs';
  const T = (from, name, check) => `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { ${name} } from '${from}';\ntest('${name}', () => assert.ok(${check}));\n`;
  w('package.json', JSON.stringify({ name: 'demo-root', type: 'module', scripts: { test: script } }));
  w('lib/config.mjs', 'export const v = 1;\n');
  w('test/config.test.mjs', T('../lib/config.mjs', 'v', "typeof v === 'number'"));
  w('test/e2e.test.mjs', T('../server/app.mjs', 'app', 'app === 2'));
  w('server/package.json', JSON.stringify({ name: 'demo-server', type: 'module', scripts: { test: 'node --test' } }));
  w('server/app.mjs', "import { v } from '../lib/config.mjs';\nexport const app = v + 1;\n");
  w('server/test/app.test.mjs', T('../app.mjs', 'app', "typeof app === 'number'"));
  w('.planning/turbo/config.json', JSON.stringify({ test: { full: [script, { dir: 'server', command: 'node --test' }] } }));
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('lib/config.mjs', 'export const v = 5;\n');
  git('commit', '-qam', 'break the e2e test through server/app.mjs');
  r.logs.length = 0;
  assert.notEqual(await r.run(), 0, 'test/e2e.test.mjs runs and fails');
  assert.equal(r.logs[0], '(root): targeted: 2 related test file(s)');
});

test('multi: a dependency or config file changed anywhere makes every entry run full', () => {
  // review 2: another entry may load the nested package's code (its "type", its dependencies, a tsconfig it extends)
  for (const f of ['package-lock.json', 'tsconfig.json', '.planning/turbo/config.json', 'tools/vite.config.js', 'server/package.json', 'server/package-lock.json', 'app/tsconfig.json']) {
    const r = plansOf(multi([f]));
    assert.deepEqual(Object.values(r).map((p) => p.mode), ['full', 'full', 'full'], f);
    const foreign = f.startsWith('server/') ? r.app : r.server;
    assert.equal(foreign.reason, `dependency or config file changed: ${f}`, f);
  }
  assert.equal(plansOf(multi(['server/package.json'])).server.reason, 'dependency or config file changed', 'the entry\'s own file');
});

test('multi: an entry whose test command may also run another entry\'s files runs full when that entry changes', () => {
  const plan = (rootScript, extra = {}) => plansOf(multi(['server/src/store.js'], { packages: multiPkgs({ '': { testScript: rootScript, ...extra } }) }))[''];
  for (const s of ['node --test', 'node --test "**/*.test.js"', 'node --test server/', 'node --test ./server/test/x.test.js', 'node --test "*/test/*.test.js"', 'jest', 'vitest run']) {
    const p = plan(s);
    assert.deepEqual([p.mode, p.reason], ['full', 'server/src/store.js changed in server, whose tests this command may also run'], s);
  }
  for (const s of ['node --test test/core.test.js', 'node --test "test/**/*.test.js"', 'node --test "scripts/*.test.js" test/']) assert.equal(plan(s).mode, 'skip', s);
  assert.equal(plansOf(multi(['server/src/store.js'], { entries: [{ dir: '', command: 'make test' }, SERVER_E, APP_E] }))[''].mode, 'full', 'a command that is not the package script may run anything');
  assert.equal(plan('node --test test/core.test.js', { hooks: ['posttest'] }).mode, 'full', 'a hook may run anything');
  // a nested entry whose script reaches outside its directory
  const out = plansOf(multi(['src/core.js'], { packages: multiPkgs({ server: { testScript: 'node --test ../test/core.test.js' } }) }));
  assert.deepEqual([out.server.mode, out.server.reason], ['full', 'src/core.js changed outside server, where this command may also run tests']);
  // the root's selection then includes the reached entry's tests, which its runner would run as a nested package
  const reached = plansOf(multi(['src/core.js'], { files: { 'server/test/core-use.test.js': "import '../../src/core.js'" }, packages: multiPkgs({ '': { testScript: 'node --test' } }) }));
  assert.deepEqual([reached[''].mode, reached[''].reason], ['full', 'server/test/core-use.test.js is in a nested package']);
});

test('multi: a change in a nested package no entry covers warns and runs as today', () => {
  const r = multi(['app/src/view.js'], { entries: [ROOT_E, SERVER_E] });
  assert.deepEqual(r.warnings, ['changes in nested package app, which has its own test script that test.full does not run']);
  assert.deepEqual([plansOf(r)[''].mode, plansOf(r)[''].reason, plansOf(r).server.mode], ['full', 'changes in a nested package', 'skip']);
  assert.deepEqual(multi(['app/src/view.js']).warnings, [], 'covered');
  const stub = multi(['app/src/view.js'], { entries: [ROOT_E, SERVER_E], packages: multiPkgs({ app: { testScript: 'echo "Error: no test specified" && exit 1' } }) });
  assert.deepEqual(stub.warnings, [], "npm's default stub is no test script");
  // review 7d: a package under fixtures/ is test data
  const fixture = multi(['test/fixtures/demo/index.js', 'src/__fixtures__/sample/a.js'], {
    packages: [...multiPkgs(), { dir: 'test/fixtures/demo', testScript: 'node --test', hooks: [] }, { dir: 'src/__fixtures__/sample', testScript: 'jest', hooks: [] }],
  });
  assert.deepEqual(fixture.warnings, []);
});

test('multi: per-entry markers, windows and max_targeted; the phase end runs every changed entry full', () => {
  const r = plansOf(multi([], {
    markers: { '': M('X', 1), server: null, app: M('Y', 3) },
    windows: { '': { changed: ['src/core.js'] }, app: { changed: ['app/src/view.js'] } },
  }));
  assert.deepEqual([r[''].mode, r.server.mode, r.server.reason, r.app.mode], ['targeted', 'full', 'no previous full green run', 'full']);
  assert.match(r.app.reason, /^3 targeted run\(s\) since the last full run/);
  const outside = plansOf(multi([], { windows: { '': { changed: [] }, server: { changed: ['server/src/store.js'], outside: true }, app: { changed: [] } } }));
  assert.deepEqual([outside[''].reason, outside.server.reason], ['no file changes since the last full green run', 'changes outside the project root']);
  const end = plansOf(multi(['server/src/store.js'], { phaseEnd: { phase: '3' } }));
  assert.deepEqual(Object.values(end).map((p) => [p.mode, p.reason]), Array(3).fill(['full', 'phase 3 end: every plan has a summary']));
  assert.deepEqual(Object.values(plansOf(multi(['.planning/STATE.md'], { phaseEnd: { phase: '3' } }))).map((p) => p.mode), ['targeted', 'skip', 'skip'], 'docs only');
});

function multiRepo({ config, broken = [] } = {}) {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
  // each test also checks that it runs in its own package directory
  const T = (mod) => `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport fs from 'node:fs';\nimport { v } from '../src/${mod}.mjs';\ntest('${mod}', () => { assert.ok(fs.existsSync('src/${mod}.mjs'), process.cwd()); assert.equal(v, 1); });\n`;
  w('package.json', JSON.stringify({ name: 'demo-root', type: 'module', scripts: { test: 'node --test test/core.test.mjs' } }));
  w('src/core.mjs', 'export const v = 1;\n');
  w('test/core.test.mjs', T('core'));
  for (const [dir, mod] of [['server', 'store'], ['app', 'view']]) {
    w(`${dir}/package.json`, JSON.stringify({ name: `demo-${dir}`, type: 'module', scripts: { test: 'node --test' } }));
    w(`${dir}/src/${mod}.mjs`, `export const v = ${broken.includes(dir) ? 2 : 1};\n`);
    w(`${dir}/test/${mod}.test.mjs`, T(mod));
  }
  w('.planning/turbo/config.json', JSON.stringify({ test: { full: config ?? ['node --test test/core.test.mjs', { dir: 'server', command: 'node --test' }, { dir: 'app', command: 'node --test' }] } }));
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  return { repo, git, w };
}

// a marker record: the entry's last full green run, the targeted runs since, and the command that ran full
const ROOT_CMD = 'node --test test/core.test.mjs';
const rec = (fullSha, targetedSince, command = 'node --test') => ({ fullSha, targetedSince, command });

test('multi e2e: a full run runs every entry in order in its own directory; the marker holds one record per entry', async () => {
  const { repo, git, w } = multiRepo();
  const c1 = git('rev-parse', 'HEAD');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  assert.deepEqual(r.logs, ['(root): full: no previous full green run', 'server: full: no previous full green run', 'app: full: no previous full green run']);
  assert.deepEqual(readMarker(repo), { ...rec(c1, 0, ROOT_CMD), entries: { server: rec(c1, 0), app: rec(c1, 0) } });
  r.logs.length = 0;
  assert.equal(await r.run(), 0);
  assert.deepEqual(r.logs, ['(root): skip: already fully green at HEAD', 'server: skip: already fully green at HEAD', 'app: skip: already fully green at HEAD']);

  w('server/src/store.mjs', 'export const v = 2;\n');
  git('commit', '-qam', 'break the server');
  r.logs.length = 0;
  assert.notEqual(await r.run(), 0, 'the nested package\'s targeted run catches it');
  assert.deepEqual(r.logs, ['(root): skip: no changes that concern this entry since its last full green run', 'server: targeted: 1 related test file(s)', 'app: skip: no changes that concern this entry since its last full green run', 'server: failed (exit code 1)']);
  assert.equal(readMarker(repo).entries.server.targetedSince, 0, 'a red run writes no marker');

  w('server/src/store.mjs', 'export const v = 1; // fixed\n');
  git('commit', '-qam', 'fix the server');
  assert.equal(await r.run(), 0);
  assert.deepEqual(readMarker(repo), { ...rec(c1, 0, ROOT_CMD), entries: { server: rec(c1, 1), app: rec(c1, 0) } });

  const t = runner(repo, { TURBO_FULL: '1' });
  assert.equal(await t.run(), 0);
  assert.deepEqual(t.logs, ['(root): full: TURBO_FULL=1', 'server: full: TURBO_FULL=1', 'app: full: TURBO_FULL=1']);
  const head = git('rev-parse', 'HEAD');
  assert.deepEqual(readMarker(repo), { ...rec(head, 0, ROOT_CMD), entries: { server: rec(head, 0), app: rec(head, 0) } });
});

test('multi review 7c: an entry whose command changed since its last full green run runs full', () => {
  const r = plansOf(multi(['src/core.js'], { markers: { '': { ...M('X'), command: 'npm test' }, server: { ...M('X'), command: 'npm run test:unit' }, app: M('X') } }));
  assert.deepEqual([r[''].mode, r.server.mode, r.server.reason, r.app.mode], ['targeted', 'full', 'test.full command changed since its last full green run', 'skip'], 'a record without a command (older marker) still counts');
});

test('multi e2e review 7c: a command changed in a config git does not track runs that entry full', async () => {
  const { repo, git, w } = multiRepo();
  w('.gitignore', '.planning/turbo/config.json\n');
  git('rm', '-q', '--cached', '.planning/turbo/config.json');
  git('add', '-A'); git('commit', '-q', '-m', 'the turbo config is not tracked');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('.planning/turbo/config.json', JSON.stringify({ test: { full: [ROOT_CMD, { dir: 'server', command: 'node --test test/store.test.mjs' }, { dir: 'app', command: 'node --test' }] } }));
  r.logs.length = 0;
  assert.equal(await r.run(), 0);
  assert.deepEqual(r.logs, ['(root): skip: already fully green at HEAD', 'server: full: test.full command changed since its last full green run', 'app: skip: already fully green at HEAD']);
  assert.equal(readMarker(repo).entries.server.command, 'node --test test/store.test.mjs');
});

test('multi e2e: a red nested package fails the full run, which goes on, names every red entry and writes no marker', async () => {
  const { repo } = multiRepo({ broken: ['server', 'app'] });
  const r = runner(repo);
  assert.notEqual(await r.run(), 0);
  assert.deepEqual(r.logs.slice(3), ['server: failed (exit code 1)', 'app: failed (exit code 1)']);
  assert.equal(readMarker(repo), null);
  // the exit code is the first red entry's
  const codes = multiRepo({ config: ['node --test test/core.test.mjs', { dir: 'server', command: 'node -e "process.exit(3)"' }, { dir: 'app', command: 'node -e "process.exit(4)"' }] });
  const c = runner(codes.repo);
  assert.equal(await c.run(), 3);
  assert.deepEqual(c.logs.slice(3), ['server: failed (exit code 3)', 'app: failed (exit code 4)']);
});

test('multi e2e review 7a: an entry directory that disappeared during the run is reported as missing', async () => {
  const { repo } = multiRepo({ config: ['node -e "require(\'fs\').rmSync(\'app\', { recursive: true })"', { dir: 'server', command: 'node --test' }, { dir: 'app', command: 'node --test' }] });
  const r = runner(repo);
  assert.equal(await r.run(), 1);
  assert.deepEqual(r.logs.slice(3), ['app: failed (its directory app is missing)']);
});

test('multi e2e: an old single-entry marker is read as the root entry\'s', async () => {
  const { repo, git, w } = multiRepo();
  const c1 = git('rev-parse', 'HEAD');
  fs.writeFileSync(markerOf(repo), JSON.stringify({ fullSha: c1, targetedSince: 1 }));
  w('src/core.mjs', 'export const v = 1; // touched\n');
  git('commit', '-qam', 'c2');
  const c2 = git('rev-parse', 'HEAD');
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  assert.deepEqual(r.logs, ['(root): targeted: 1 related test file(s)', 'server: full: no previous full green run', 'app: full: no previous full green run']);
  // the root record stays an older one (no command) until its next full run
  assert.deepEqual(readMarker(repo), { fullSha: c1, targetedSince: 2, entries: { server: rec(c2, 0), app: rec(c2, 0) } });
});

test('multi e2e: an invalid test.full list stops test-changed with a config error and runs nothing', async () => {
  const { repo } = multiRepo({ config: ['node --test test/core.test.mjs', { dir: 'missing', command: 'node --test' }] });
  const r = runner(repo);
  await assert.rejects(r.run(), /^Error: invalid turbo config .*test\.full\[1\]\.dir "missing" is not a directory in the project/);
  assert.deepEqual(r.logs, []);
  assert.equal(readMarker(repo), null);
});

test('multi e2e: with a single test.full command, a change in a nested package with its own tests warns and runs full', async () => {
  const { repo, git, w } = multiRepo({ config: 'node --test test/core.test.mjs' });
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('app/src/view.mjs', 'export const v = 1; // touched\n');
  git('commit', '-qam', 'c2');
  r.logs.length = 0;
  assert.equal(await r.run(), 0);
  assert.deepEqual(r.logs, ['warn: changes in nested package app, which has its own test script that test.full does not run', 'full: changes in a nested package']);
});
