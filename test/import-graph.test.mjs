import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { collectGraph, testsLoading } from '../lib/import-graph.mjs';
import { planRun, runTestChanged, isTestFile } from '../lib/test-changed.mjs';

const GRAPH = { fullSha: 'X', tests: { 'test/a.test.mjs': ['src/a.mjs', 'src/shared.mjs'], 'test/b.test.mjs': ['src/b.mjs', 'src/shared.mjs'] } };
const base = {
  testFiles: ['test/a.test.mjs', 'test/b.test.mjs'], packages: [{ dir: '', testScript: 'node --test test/' }], readFile: () => "import '../src/shared.mjs'",
  head: 'H', fullCommand: 'npm test', forceFull: false, marker: { fullSha: 'X', targetedSince: 0 },
};

test('collectGraph keeps project files of test entries; testsLoading finds the loaders', () => {
  const root = tmpDir('ig');
  const dir = path.join(root, 'g');
  fs.mkdirSync(dir);
  const abs = (f) => path.join(root, ...f.split('/'));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ entry: abs('test/a.test.mjs'), files: [abs('src/a.mjs'), abs('node_modules/x/i.js'), path.join(path.dirname(root), 'outside.js')] }));
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ entry: null, files: [abs('src/z.mjs')] }));
  const g = collectGraph({ root, dir, fullSha: 'X', isTest: isTestFile });
  assert.deepEqual(g.tests, { 'test/a.test.mjs': ['src/a.mjs'] });
  assert.deepEqual(testsLoading(GRAPH, 'src/shared.mjs'), ['test/a.test.mjs', 'test/b.test.mjs']);
  fs.writeFileSync(path.join(dir, 'unsupported'), 'v20');
  assert.equal(collectGraph({ root, dir, fullSha: 'X', isTest: isTestFile }), null);
});

test('planRun with a graph: the graph adds tests to a targeted run; a stage-1 full run stays full', () => {
  assert.equal(planRun({ ...base, changed: ['src/a.mjs'], graph: GRAPH }).mode, 'full', 'no test mentions src/a.mjs: full, although the graph knows a loader');
  assert.equal(planRun({ ...base, changed: ['src/new.mjs'], graph: GRAPH }).mode, 'full');
  assert.equal(planRun({ ...base, changed: ['src/shared.mjs'] }).mode, 'targeted', 'without a graph the mention rule applies');
  // test/a names src/a.mjs; test/b loads it through src/b.mjs and an import alias, which only the graph sees
  const files = { 'test/a.test.mjs': "import '../src/a.mjs'", 'test/b.test.mjs': "import '../src/b.mjs'" };
  const graph = { fullSha: 'X', tests: { 'test/a.test.mjs': ['src/a.mjs'], 'test/b.test.mjs': ['src/a.mjs', 'src/b.mjs'] } };
  const sel = (g) => planRun({ ...base, readFile: (f) => files[f], changed: ['src/a.mjs'], graph: g }).groups[0].args.slice(-2);
  assert.deepEqual(sel(graph), ['test/a.test.mjs', 'test/b.test.mjs']);
  assert.deepEqual(sel(null).slice(-1), ['test/a.test.mjs']);
});

test('planRun: a module only aliases reach stays full with a graph (a child-process loader is not in it)', () => {
  // src/engine.mjs is loaded through '#lib' by src/b.mjs (in test/b's process) and by bin/cli.mjs (test/cli spawns it)
  const files = {
    'src/engine.mjs': 'export const v = 2;\n',
    'src/b.mjs': "import { v } from '#lib';\nexport const b = v + 1;\n",
    'bin/cli.mjs': "import { v } from '#lib';\nif (v !== 1) process.exit(3);\n",
    'test/b.test.mjs': "import { test } from 'node:test';\nimport { b } from '../src/b.mjs';\ntest('b', () => {});\n",
    'test/cli.test.mjs': "import { test } from 'node:test';\nimport { execFileSync } from 'node:child_process';\ntest('cli', () => { execFileSync(process.execPath, ['bin/cli.mjs']); });\n",
  };
  const all = Object.keys(files);
  const graph = { fullSha: 'X', tests: { 'test/b.test.mjs': ['src/b.mjs', 'src/engine.mjs'], 'test/cli.test.mjs': [] } };
  const p = planRun({ ...base, testFiles: all.filter(isTestFile), sourceFiles: all.filter((f) => !isTestFile(f)), allFiles: all, packages: [{ dir: '', testScript: 'node --test' }], readFile: (f) => files[f], changed: ['src/engine.mjs'], graph });
  assert.deepEqual([p.mode, p.reason], ['full', 'no related test for src/engine.mjs']);
});

test('planRun with a graph never selects fewer tests than the mention rule', () => {
  // test/cli spawns bin/cli.mjs, which imports src/a.mjs: the child process is not in test/cli's recorded graph
  const files = {
    'src/a.mjs': 'export const a = 2;\n',
    'bin/cli.mjs': "import { a } from '../src/a.mjs';\nconsole.log(a);\n",
    'test/a.test.mjs': "import { test } from 'node:test';\nimport { a } from '../src/a.mjs';\ntest('x', () => {});\n",
    'test/cli.test.mjs': "import { test } from 'node:test';\nimport { execFileSync } from 'node:child_process';\ntest('cli', () => execFileSync(process.execPath, ['bin/cli.mjs']));\n",
    'test/new.test.mjs': "import { test } from 'node:test';\ntest('new', () => {});\n",
  };
  const all = Object.keys(files);
  const graph = { fullSha: 'X', tests: { 'test/a.test.mjs': ['src/a.mjs'], 'test/cli.test.mjs': [] } };
  const opts = { ...base, testFiles: all.filter(isTestFile), sourceFiles: all.filter((f) => !isTestFile(f)), allFiles: all, packages: [{ dir: '', testScript: 'node --test' }], readFile: (f) => files[f] };
  const sel = (changed, g) => planRun({ ...opts, changed, graph: g }).groups[0]?.args.filter((x) => x.startsWith('test/'));
  assert.deepEqual(sel(['src/a.mjs'], graph), ['test/a.test.mjs', 'test/cli.test.mjs']);
  assert.deepEqual(sel(['src/a.mjs'], graph), sel(['src/a.mjs'], null));
  assert.deepEqual(sel(['test/new.test.mjs'], graph), ['test/new.test.mjs'], 'a test added after the full run selects itself');
});

test('a full run records the graph; targeted runs add its tests only for the marker\'s full run and only when on', { skip: typeof module.registerHooks !== 'function' && 'needs Node >= 22.15' }, async () => {
  const root = tmpGitRepo();
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  const commit = (m) => { g('add', '-A'); g('commit', '-q', '-m', m); };
  const config = (on) => write('.planning/turbo/config.json', JSON.stringify({ test: { full: 'npm test', import_graph: on } }));
  const run = async (extra = {}) => {
    const logs = [];
    assert.equal(await runTestChanged({ root, env: { ...process.env, ...extra }, stdio: 'ignore', log: (l) => logs.push(l) }), 0);
    return logs;
  };
  // plain `node --test` (default patterns): Node 24 imports a directory argument like `test/` as a module and fails.
  // src/b.mjs reaches src/a.mjs through a package.json "imports" alias, an edge only the recorded graph sees.
  write('package.json', JSON.stringify({ scripts: { test: 'node --test' }, imports: { '#core': './src/a.mjs' } }));
  write('src/a.mjs', 'export const a = 1;\n');
  write('src/b.mjs', "import { a } from '#core';\nexport const b = a + 1;\n");
  write('test/a.test.mjs', "import { test } from 'node:test';\nimport { a } from '../src/a.mjs';\ntest('a', () => {});\n");
  write('test/b.test.mjs', "import { test } from 'node:test';\nimport { b } from '../src/b.mjs';\ntest('b', () => {});\n");
  write('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  config(true);
  commit('init');
  const graphPath = path.resolve(root, g('rev-parse', '--git-path', 'turbo-import-graph.json'));
  // a graph that cannot be saved leaves the green full run green
  fs.mkdirSync(path.join(graphPath, 'blocker'), { recursive: true });
  let logs = await run();
  assert.ok(logs.some((l) => l.startsWith('import graph: not saved')), logs.join('\n'));
  fs.rmSync(graphPath, { recursive: true });
  logs = await run({ TURBO_FULL: '1' });
  assert.ok(logs.includes('import graph: recorded (2 test file(s))'), logs.join('\n'));
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  assert.ok(graph.tests['test/b.test.mjs'].includes('src/a.mjs'), 'the alias edge is recorded');
  const changeA = (n) => { write('src/a.mjs', `export const a = ${n};\n`); commit(`a ${n}`); };
  changeA(2);
  logs = await run();
  assert.ok(logs.includes('targeted: 2 related test file(s)') && logs.includes('import graph: used with the mention rule'), logs.join('\n'));
  // a graph of another full run is ignored: the mention rule alone finds test/a only
  fs.writeFileSync(graphPath, JSON.stringify({ ...graph, fullSha: 'f'.repeat(40) }));
  logs = await run();
  assert.ok(logs.includes('targeted: 1 related test file(s)') && logs.includes('import graph: none for the last full green run; mention rule only'), logs.join('\n'));
  // import_graph: false ignores a graph of the marker's full run
  config(false);
  commit('graph off');
  assert.match((await run())[0], /^full: /);
  const marker = JSON.parse(fs.readFileSync(path.resolve(root, g('rev-parse', '--git-path', 'turbo-last-green')), 'utf8'));
  fs.writeFileSync(graphPath, JSON.stringify({ ...graph, fullSha: marker.fullSha }));
  changeA(3);
  logs = await run();
  assert.deepEqual(logs, ['targeted: 1 related test file(s)']);
});
