import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { classifyScript, planRun, runTestChanged, splitZ } from '../lib/test-changed.mjs';

const M = { fullSha: 'X', targetedSince: 0 };

test('splitZ keeps names verbatim and flags names that are not UTF-8', () => {
  const buf = Buffer.concat([Buffer.from(' lead.js\0dir/b.js\0'), Buffer.from([0x66, 0xff, 0x2e, 0x6a, 0x73, 0]), Buffer.from('tail.js')]);
  assert.deepEqual(splitZ(buf), { names: [' lead.js', 'dir/b.js', 'tail.js'], bad: true });
  assert.deepEqual(splitZ(Buffer.from('')), { names: [], bad: false });
});

function repo(files, script = 'node --test') {
  const root = tmpGitRepo();
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  w('package.json', JSON.stringify({ name: 't', type: 'module', scripts: { test: script } }));
  w('.planning/turbo/config.json', JSON.stringify({ test: { full: script } }));
  for (const [f, s] of Object.entries(files)) w(f, s);
  git('add', '-A');
  git('commit', '-q', '-m', 'c1');
  const logs = [];
  return { root, git, w, logs, run: () => runTestChanged({ root, env: {}, stdio: 'ignore', log: (l) => logs.push(l) }) };
}
const T = (from, v) => `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { v } from '${from}';\ntest('v', () => assert.equal(v, ${v}));\n`;

test('a changed file whose name starts with a space keeps its own tests (git output is never trimmed)', async () => {
  const r = repo({ ' a.mjs': 'export const v = 1;\n', 'a.mjs': 'export const v = 1;\n', 'test/space.test.mjs': T('../ a.mjs', 1), 'test/a.test.mjs': T('../a.mjs', 1) });
  assert.equal(await r.run(), 0);
  r.w(' a.mjs', 'export const v = 2;\n');
  r.git('commit', '-qam', 'break the space-named module');
  assert.notEqual(await r.run(), 0, 'the test of " a.mjs" runs and fails');
  assert.equal(r.logs.at(-1), 'targeted: 1 related test file(s)');
});

test('a file name that is not UTF-8 runs the full suite', { skip: process.platform !== 'linux' && 'needs a file system that keeps non-UTF-8 names' }, async () => {
  const r = repo({ 'src/a.js': 'export const v = 1;\n', 'test/a.test.js': T('../src/a.js', 1) });
  const odd = Buffer.concat([Buffer.from(path.join(r.root, 'src') + path.sep), Buffer.from([0x62, 0xff, 0x2e, 0x6a, 0x73])]);
  fs.writeFileSync(odd, 'export const b = 1;\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'odd name');
  assert.equal(await r.run(), 0);
  fs.writeFileSync(odd, 'export const b = 2;\n');
  r.git('commit', '-qam', 'touch it');
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'full: a file name is not valid UTF-8');
});

test('braces anywhere in the test script make it unknown (bash expands them into hidden flags)', () => {
  for (const s of ['node --test {--test-coverage-lines=90,}', 'node --test "test/*.{test,spec}.js"', 'jest {--coverage,}']) assert.equal(classifyScript(s).kind, 'unknown', s);
});

test('jest: a test jest 30 runs (.mjs) is selected even when another test imports it, so the jest 29 gate runs full', () => {
  const files = {
    'test/a.test.js': "const { a } = require('../src/a.js');\nrequire('./shared.test.mjs');",
    'test/shared.test.mjs': "import { a } from '../src/a.js';\ntest('shared', () => {});",
  };
  const r = planRun({
    changed: ['src/a.js'], testFiles: Object.keys(files), sourceFiles: ['src/a.js'], allFiles: ['src/a.js', ...Object.keys(files)],
    packages: [{ dir: '', testScript: 'jest', hooks: [] }], readFile: (f) => files[f] ?? '', marker: M, head: 'H', forceFull: false, fullCommand: 'npm test',
  });
  assert.deepEqual([r.mode, r.reason], ['full', 'test/shared.test.mjs is outside the jest default test match']);
});

test('a changed source under docs/ also runs the tests that read its directory, without counting them as coverage', () => {
  const files = {
    'test/basic.test.js': "import { test } from 'node:test';\nimport '../docs/examples/basic.js';",
    'test/docs.test.js': "import { test } from 'node:test';\nimport fs from 'node:fs';\nfs.readdirSync('docs/examples');",
  };
  const base = {
    testFiles: Object.keys(files), sourceFiles: ['docs/examples/basic.js'], allFiles: ['docs/examples/basic.js', ...Object.keys(files)],
    packages: [{ dir: '', testScript: 'node --test', hooks: [] }], readFile: (f) => files[f] ?? '', marker: M, head: 'H', forceFull: false, fullCommand: 'npm test',
  };
  const r = planRun({ ...base, changed: ['docs/examples/basic.js'] });
  assert.equal(r.mode, 'targeted');
  assert.deepEqual(r.groups[0].args.slice(-2), ['test/basic.test.js', 'test/docs.test.js']);
  // the directory reader alone is no coverage: with no test that names the file, the run is full
  const alone = planRun({ ...base, testFiles: ['test/docs.test.js'], allFiles: ['docs/examples/basic.js', 'test/docs.test.js'], changed: ['docs/examples/basic.js'] });
  assert.equal(alone.mode, 'full');
});
