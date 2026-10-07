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

test('planRun with a graph: exactly the loading tests; a file no test loads → full', () => {
  const a = planRun({ ...base, changed: ['src/a.mjs'], graph: GRAPH });
  assert.deepEqual([a.mode, a.groups[0].args.slice(-1)], ['targeted', ['test/a.test.mjs']]);
  assert.equal(planRun({ ...base, changed: ['src/new.mjs'], graph: GRAPH }).mode, 'full');
  assert.equal(planRun({ ...base, changed: ['src/shared.mjs'] }).mode, 'targeted', 'without a graph the mention rule applies');
});

test('a full run records the graph; the next targeted run uses it', { skip: typeof module.registerHooks !== 'function' && 'needs Node >= 22.15' }, async () => {
  const root = tmpGitRepo();
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  // plain `node --test` (default patterns): Node 24 imports a directory argument like `test/` as a module and fails
  write('package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  write('src/a.mjs', 'export const a = 1;\n');
  write('src/b.mjs', 'export const b = 1;\n');
  write('test/a.test.mjs', "import { test } from 'node:test';\nimport { a } from '../src/a.mjs';\ntest('a', () => {});\n");
  write('test/b.test.mjs', "import { test } from 'node:test';\nimport { b } from '../src/b.mjs';\ntest('b', () => {});\n");
  write('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  write('.planning/turbo/config.json', JSON.stringify({ test: { full: 'npm test', import_graph: true } }));
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  assert.equal(await runTestChanged({ root, env: process.env, stdio: 'ignore', log: () => {} }), 0);
  const graph = JSON.parse(fs.readFileSync(path.resolve(root, g('rev-parse', '--git-path', 'turbo-import-graph.json')), 'utf8'));
  assert.ok(graph.tests['test/a.test.mjs'].includes('src/a.mjs'));
  write('src/a.mjs', 'export const a = 2;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'change a');
  const logs = [];
  assert.equal(await runTestChanged({ root, env: process.env, stdio: 'ignore', log: (l) => logs.push(l) }), 0);
  assert.ok(logs.some((l) => /^targeted: 1 related test file/.test(l)), logs.join('\n'));
});
