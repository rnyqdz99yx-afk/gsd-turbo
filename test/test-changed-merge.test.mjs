import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { ISOLATED } from './helpers/slots.mjs';
import { runTestChanged } from '../lib/test-changed.mjs';
import { phaseEndState } from '../lib/phase-progress.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const TEST_OF = (name) => `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { ${name} } from '../src/${name}.js';\ntest('${name}', () => assert.equal(${name}, 1));\n`;

function project(dir, { full = 'node --test', maxTargeted } = {}) {
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
  w('package.json', JSON.stringify({ name: 't', type: 'module', scripts: { test: 'node --test' } }));
  w('src/a.js', 'export const a = 1;\n');
  w('test/a.test.js', TEST_OF('a'));
  w('src/b.js', 'export const b = 1;\n');
  w('test/b.test.js', TEST_OF('b'));
  w('.planning/turbo/config.json', JSON.stringify({ test: { full, max_targeted: maxTargeted } }));
  return w;
}
const gitIn = (dir) => (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
const markerOf = (dir) => path.resolve(dir, gitIn(dir)('rev-parse', '--git-path', 'turbo-last-green'));
const markerText = (dir) => { try { return fs.readFileSync(markerOf(dir), 'utf8'); } catch { return null; } };
const readMarker = (dir) => { const t = markerText(dir); return t === null ? null : JSON.parse(t); };
const runner = (root, env = {}) => {
  const logs = [];
  return { logs, run: (merge = null) => runTestChanged({ root, env, stdio: 'ignore', log: (l) => logs.push(l), merge }) };
};

// A side branch from HEAD that runs `change`, then commits; merged back with --no-ff. Returns the merge sha.
let sides = 0;
function mergeIn(repo, change, { allowEmpty = false } = {}) {
  const git = gitIn(repo);
  const side = `side-${++sides}`;
  git('checkout', '-q', '-b', side);
  change();
  git('add', '-A');
  git('commit', '-q', ...(allowEmpty ? ['--allow-empty'] : []), '-m', `work on ${side}`);
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', `merge ${side}`, side);
  return git('rev-parse', 'HEAD');
}

// A captured process.stderr for the in-process refusals.
async function withStderr(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try { return { value: await fn(), stderr: lines.join('') }; } finally { process.stderr.write = write; }
}

function greenRepo(opts) {
  const repo = tmpGitRepo();
  const git = gitIn(repo);
  const w = project(repo, opts);
  git('add', '-A'); git('commit', '-q', '-m', 'c1');
  return { repo, git, w };
}

test('--merge runs only the tests of the files the merge brought in', async () => {
  const { repo, git, w } = greenRepo();
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  const h0 = git('rev-parse', 'HEAD');
  assert.deepEqual(readMarker(repo), { fullSha: h0, targetedSince: 0, command: 'node --test' });
  const before = markerText(repo);
  const sha = mergeIn(repo, () => w('src/b.js', 'export const b = 1; // side\n'));
  assert.equal(await r.run(sha), 0);
  assert.match(r.logs.at(-1), /^merge [0-9a-f]{7}: targeted: 1 related test file\(s\)$/);
  assert.equal(r.logs.at(-1).slice(6, 13), sha.slice(0, 7));
  assert.equal(markerText(repo), before, 'the marker is byte-identical');
});

test('--merge runs never count and never clear the count', async () => {
  const { repo, git, w } = greenRepo({ maxTargeted: 1 });
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  w('src/a.js', 'export const a = 1; // plain\n');
  git('commit', '-qam', 'plain change');
  assert.equal(await r.run(), 0);
  assert.match(r.logs.at(-1), /^targeted: /);
  assert.equal(readMarker(repo).targetedSince, 1);
  for (let i = 0; i < 4; i++) {
    const sha = mergeIn(repo, () => w('src/b.js', `export const b = 1; // merge ${i}\n`));
    assert.equal(await r.run(sha), 0);
    assert.match(r.logs.at(-1), /^merge [0-9a-f]{7}: targeted: /);
    assert.equal(readMarker(repo).targetedSince, 1, `merge ${i} leaves the count`);
  }
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'full: 1 targeted run(s) since the last full run (max_targeted 1)');
});

test('--merge: its own full rules hold', async () => {
  const { repo, git, w } = greenRepo();
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  const sha = mergeIn(repo, () => w('package.json', JSON.stringify({ name: 't', description: 'd', type: 'module', scripts: { test: 'node --test' } })));
  assert.equal(await r.run(sha), 0);
  assert.match(r.logs.at(-1), /^merge [0-9a-f]{7}: full: dependency or config file changed/);
  assert.deepEqual(readMarker(repo), { fullSha: git('rev-parse', 'HEAD'), targetedSince: 0, command: 'node --test' });

  const forced = runner(repo, { TURBO_FULL: '1' });
  assert.equal(await forced.run(sha), 0);
  assert.equal(forced.logs.at(-1), `merge ${sha.slice(0, 7)}: full: TURBO_FULL=1`);

  const fresh = greenRepo();
  const m = mergeIn(fresh.repo, () => fresh.w('src/b.js', 'export const b = 1; // x\n'));
  const f = runner(fresh.repo);
  assert.equal(await f.run(m), 0);
  assert.equal(f.logs.at(-1), `merge ${m.slice(0, 7)}: full: no previous full green run`);
  assert.equal(readMarker(fresh.repo).fullSha, m, 'a full merge run records its full green run');
});

test('--merge: the phase-end rule does not apply to a merge', async () => {
  const { repo, git, w } = greenRepo();
  w('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  w('.planning/phases/03-alpha/03-01-PLAN.md', 'plan\n');
  w('.planning/phases/03-alpha/03-01-SUMMARY.md', 'summary\n');
  git('add', '-A'); git('commit', '-q', '-m', 'phase 3 executed');
  writeJsonAtomic(path.join(repo, '.planning', 'turbo', 'run', 'supervisor.json'), { lane: { phase: '3' } });
  assert.deepEqual(phaseEndState(repo), { phase: '3' });
  const r = runner(repo);
  assert.equal(await r.run(), 0); // the first full green run
  const before = markerText(repo);
  const sha = mergeIn(repo, () => w('src/b.js', 'export const b = 1; // late\n'));
  assert.equal(await r.run(sha), 0);
  assert.match(r.logs.at(-1), /^merge [0-9a-f]{7}: targeted: /);
  assert.equal(markerText(repo), before);
  assert.equal(await r.run(), 0);
  assert.equal(r.logs.at(-1), 'full: phase 3 end: every plan has a summary');
});

test('--merge: a merge that changed no files', async () => {
  const { repo } = greenRepo();
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  const before = markerText(repo);
  const sha = mergeIn(repo, () => {}, { allowEmpty: true });
  assert.equal(await r.run(sha), 0);
  assert.equal(r.logs.at(-1), `merge ${sha.slice(0, 7)}: skip: the merge changed no files`);
  assert.equal(markerText(repo), before);
});

test('--merge refuses what is no merge on this branch', async () => {
  const { repo, git, w } = greenRepo();
  const r = runner(repo);
  assert.equal(await r.run(), 0);
  const plain = git('rev-parse', 'HEAD');
  // a merge kept on another branch only
  const elsewhere = mergeIn(repo, () => w('src/b.js', 'export const b = 1; // other\n'));
  git('branch', 'other', elsewhere);
  git('reset', '-q', '--hard', plain);
  const before = markerText(repo);
  for (const arg of [plain, 'f'.repeat(40), 'no-such-ref', elsewhere, '--help']) {
    const n = r.logs.length;
    const { value, stderr } = await withStderr(() => r.run(arg));
    assert.equal(value, 2, arg);
    assert.equal(stderr, `[turbo-test] --merge needs a merge commit on this branch: ${arg}\n`);
    assert.equal(r.logs.length, n, 'nothing planned or run');
  }
  assert.equal(markerText(repo), before);
});

test('CLI: turbo-run test-changed --merge <sha>', async () => {
  const { repo, w } = greenRepo();
  assert.equal(await runner(repo).run(), 0);
  const sha = mergeIn(repo, () => w('src/b.js', 'export const b = 1; // cli\n'));
  const cli = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: repo, env: ISOLATED, encoding: 'utf8', windowsHide: true });
  const ok = cli('test-changed', '--merge', sha);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /\[turbo-test\] merge [0-9a-f]{7}: targeted: 1 related test file\(s\)/);
  for (const args of [['test-changed', '--merge'], ['test-changed', '--merge', '--project', repo]]) {
    const bad = cli(...args);
    assert.equal(bad.status, 2, args.join(' '));
    assert.match(bad.stderr, /^usage: turbo-run test-changed \[--merge <sha>\]/);
  }
  const notMerge = cli('test-changed', '--merge', `${sha}^1`);
  assert.equal(notMerge.status, 2);
  assert.match(notMerge.stderr, /--merge needs a merge commit on this branch/);
});
