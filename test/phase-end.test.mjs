import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { phaseEndState } from '../lib/phase-progress.mjs';
import { planRun, runTestChanged } from '../lib/test-changed.mjs';
import { writeJsonAtomic } from '../lib/fsx.mjs';

const hasBash = () => { try { execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }); return true; } catch { return false; } };
const base = {
  testFiles: ['test/a.test.js'], packages: [{ dir: '', testScript: 'node --test test/' }], readFile: () => "import '../src/a.js'",
  head: 'H', fullCommand: 'npm test', forceFull: false, marker: { fullSha: 'X', targetedSince: 0 },
};

test('planRun: phase end forces a full run unless only docs changed', () => {
  assert.equal(planRun({ ...base, changed: ['src/a.js'] }).mode, 'targeted');
  const p = planRun({ ...base, changed: ['src/a.js'], phaseEnd: { phase: '3' } });
  assert.equal(p.mode, 'full');
  assert.match(p.reason, /phase 3 end/);
  assert.notEqual(planRun({ ...base, changed: ['.planning/phases/03-x/03-VERIFICATION.md'], phaseEnd: { phase: '3' } }).mode, 'full');
  assert.equal(planRun({ ...base, changed: [], phaseEnd: { phase: '3' } }).mode, 'skip');
});

test('phaseEndState: the supervisor lane phase with every plan summarized', () => {
  const root = tmpDir('pe');
  const dir = path.join(root, '.planning', 'phases', '03-alpha');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '03-01-PLAN.md'), '');
  assert.equal(phaseEndState(root), null, 'no active phase');
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), { lane: { phase: '3' } });
  assert.equal(phaseEndState(root), null, 'a plan without summary');
  fs.writeFileSync(path.join(dir, '03-01-SUMMARY.md'), '');
  assert.deepEqual(phaseEndState(root), { phase: '3' });
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'phase-p3.json'), { phase: '3', done: ['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute'] });
  assert.equal(phaseEndState(root), null, 'after execute the fan-out and fixes run targeted tests');
});

test('runTestChanged runs the full command at phase end', { skip: !hasBash() && 'bash not available' }, async () => {
  const root = tmpGitRepo();
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const ran = path.join(tmpDir('ran'), 'full-ran').replace(/\\/g, '/');
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  write('package.json', JSON.stringify({ scripts: { test: 'node --test test/' } }));
  write('src/a.js', 'export const a = 1;\n');
  write('test/a.test.js', "import '../src/a.js';\n");
  write('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  write('.planning/turbo/config.json', JSON.stringify({ test: { full: `node -e "require('fs').writeFileSync(process.argv[1], 'full')" '${ran}'` } }));
  write('.planning/phases/03-alpha/03-01-PLAN.md', 'plan\n');
  write('.planning/phases/03-alpha/03-01-SUMMARY.md', 'summary\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'phase 3 executed');
  const first = g('rev-parse', 'HEAD');
  write('src/a.js', 'export const a = 2;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'last wave');
  fs.writeFileSync(path.resolve(root, g('rev-parse', '--git-path', 'turbo-last-green')), JSON.stringify({ fullSha: first, targetedSince: 0 }));
  writeJsonAtomic(path.join(root, '.planning', 'turbo', 'run', 'supervisor.json'), { lane: { phase: '3' } });
  const logs = [];
  const code = await runTestChanged({ root, env: {}, stdio: 'ignore', log: (l) => logs.push(l) });
  assert.equal(code, 0);
  assert.ok(fs.existsSync(ran), 'the full command ran');
  assert.ok(logs.some((l) => /phase 3 end/.test(l)), logs.join('\n'));
});
