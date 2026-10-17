import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';
import { pinLean } from '../lib/phase-progress.mjs';
import { applyLean, runTestChanged } from '../lib/test-changed.mjs';

// Stage 6 L2 (spec §5.3): inside a lean phase's turbo-phase run, before its final-gate, test-changed never runs the
// full suite; the one full run is final-gate's TURBO_FULL=1, plus CI.
const E = { dir: '', command: 'npm test' };

test('applyLean: a full plan becomes a lean skip naming the phase and the reason; targeted, skip and a null deferral pass through', () => {
  const full = { mode: 'full', reason: 'unknown test runner in root', groups: [{ cwd: '', cmd: 'npm test', args: [], shell: true }] };
  const [one] = applyLean([{ entry: E, plan: full }], { phase: '3' });
  assert.deepEqual(one, { entry: E, plan: { mode: 'skip', reason: 'lean: no full run before final-gate of phase 3 (unknown test runner in root)', groups: [] } });
  const targeted = { mode: 'targeted', reason: '1 related test file(s)', groups: [] };
  const skip = { mode: 'skip', reason: 'already fully green at HEAD', groups: [] };
  const list = [{ entry: E, plan: targeted }, { entry: { dir: 'web', command: 'npm test' }, plan: skip }];
  assert.deepEqual(applyLean(list, { phase: '3' }), list);
  const fulls = [{ entry: E, plan: full }];
  assert.equal(applyLean(fulls, null), fulls);
});

const gitIn = (dir) => (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
const markerOf = (dir) => path.resolve(dir, gitIn(dir)('rev-parse', '--git-path', 'turbo-last-green'));
const runFile = (root, name) => path.join(root, '.planning', 'turbo', 'run', name);
const progress = (root, done) => writeJsonAtomic(runFile(root, 'phase-p3.json'), { phase: '3', done, updatedAt: new Date().toISOString() });
const ALL = ['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate'];

// A repository whose turbo run directory git ignores (as turbo-run init writes it), with test.full and a root script.
function repo({ script, full, extra = {} }) {
  const root = tmpGitRepo();
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  w('.gitignore', '.planning/turbo/run/\n');
  w('package.json', JSON.stringify({ name: 't', type: 'module', scripts: { test: script } }));
  w('src/a.js', 'export const a = 1;\n');
  w('test/a.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { a } from '../src/a.js';\ntest('a', () => assert.ok(a));\n");
  w('.planning/turbo/config.json', JSON.stringify({ test: { full, ...extra } }));
  w('.planning/phases/03-alpha/03-01-PLAN.md', '---\nphase: 03\nplan: 01\n---\n');
  const git = gitIn(root);
  git('add', '-A');
  git('commit', '-q', '-m', 'c1');
  return { root, w, git };
}
const runner = (root, env = {}) => {
  const logs = [];
  return { logs, run: () => runTestChanged({ root, env, stdio: 'ignore', log: (l) => logs.push(l) }) };
};

test('runTestChanged (lean): inside a lean phase before final-gate an untargetable run is skipped, passes and writes no marker', async () => {
  const { root } = repo({ script: 'make test', full: 'node -e 0' });
  progress(root, ['freshness']);
  const r = runner(root);
  assert.equal(await r.run(), 0);
  assert.match(r.logs.at(-1), /^skip: lean: no full run before final-gate of phase 3 \(/);
  assert.ok(!fs.existsSync(markerOf(root)), 'a lean skip proves nothing: no green marker');
});

test('runTestChanged (lean): TURBO_FULL=1, a phase past final-gate, lean off and no turbo-phase run keep the stage-5 full run', async () => {
  const { root } = repo({ script: 'make test', full: 'node -e 0' });
  const cases = [
    ['TURBO_FULL=1', () => progress(root, ['freshness']), { TURBO_FULL: '1' }],
    ['past final-gate', () => { progress(root, ALL); pinLean(root, '3', true); }, {}],
    ['lean off', () => { fs.rmSync(runFile(root, 'lean-p3.json')); progress(root, ['freshness']); writeJsonAtomic(path.join(root, '.planning', 'turbo', 'config.json'), { test: { full: 'node -e 0' }, lean: { enabled: false } }); }, {}],
    ['no turbo-phase run', () => { fs.rmSync(runFile(root, 'phase-p3.json')); writeJsonAtomic(path.join(root, '.planning', 'turbo', 'config.json'), { test: { full: 'node -e 0' } }); }, {}],
  ];
  for (const [name, arrange, env] of cases) {
    fs.rmSync(markerOf(root), { force: true });
    arrange();
    // the lean-off case changed the committed config: commit it so the tree is clean
    if (gitIn(root)('status', '--porcelain')) { gitIn(root)('commit', '-qam', name); }
    const r = runner(root, env);
    assert.equal(await r.run(), 0, name);
    assert.match(r.logs.at(-1), /^full: /, name);
    assert.ok(fs.existsSync(markerOf(root)), `${name}: marker written`);
  }
});

test('runTestChanged (lean): max_targeted and the phase-end rule force no full run inside the window', async () => {
  const { root, w, git } = repo({ script: 'node --test', full: 'node --test', extra: { max_targeted: 0 } });
  w('.planning/phases/03-alpha/03-01-SUMMARY.md', '# done\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'summary');
  const first = runner(root, { TURBO_FULL: '1' });
  assert.equal(await first.run(), 0);
  assert.match(first.logs.at(-1), /^full: TURBO_FULL=1/);
  w('src/a.js', 'export const a = 2;\n');
  git('commit', '-qam', 'change');
  pinLean(root, '3', true);
  progress(root, ['freshness', 'discuss', 'prologue', 'plan', 'gates-off']);
  const r = runner(root);
  assert.equal(await r.run(), 0);
  assert.match(r.logs.at(-1), /^targeted: /, 'neither max_targeted 0 nor the phase end forces a full run');
});
