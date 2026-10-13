import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { PHASES, ROADMAP } from './fixtures/roadmap-lanes.mjs';
import { analysisFile } from '../lib/annotate.mjs';
import { runAnnotateCommand } from '../lib/cli-jobs.mjs';

function project() {
  const root = tmpGitRepo();
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', '.gitignore'), 'run/\nlogs/\nlocks/\n');
  fs.writeFileSync(path.join(root, '.planning', 'ROADMAP.md'), ROADMAP);
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'planning'], { cwd: root });
  return root;
}
function cli(root) {
  const out = [];
  const err = [];
  const run = (...args) => runAnnotateCommand(args, { root, out: (l) => out.push(l), err: (l) => err.push(l), deps: { phases: PHASES, config: { lang: 'en', autonomy: 'standard' } } });
  return { out, err, run };
}
const ANALYSIS = {
  phases: { 2: { areas: ['src/api/**'], gates: [], confidence: 'high' }, 3: { areas: ['web/**'], gates: [], confidence: 'high' }, 4: { areas: ['docs/**'], gates: [], confidence: 'low' } },
  pairs: [['2', '4', 'ok', 'no shared files']],
  relax: [],
};

test('annotate brief prints its reason, the two paths and the targets; --json prints the brief', () => {
  const root = project();
  const { out, run } = cli(root);
  assert.equal(run('brief'), 0);
  assert.deepEqual(out.slice(0, 4), ['reason: phases', `brief: ${path.join(root, '.planning', 'turbo', 'run', 'annotate', 'brief.json')}`, `analysis: ${analysisFile(root)}`, 'targets: 2, 3, 4']);
  assert.equal(run('brief', '--json'), 0);
  assert.equal(JSON.parse(out.at(-1)).reason, 'phases');
});

test('annotate apply: no analysis, a refused one, then a good one', () => {
  const root = project();
  const { out, err, run } = cli(root);
  run('brief');
  assert.equal(run('apply'), 1);
  assert.match(err.at(-1), /^refused: no analysis at .+: dispatch turbo-lane-analyst with the brief first$/);
  fs.writeFileSync(analysisFile(root), JSON.stringify({ phases: { 2: { areas: ['{a,b}/**'], gates: [], confidence: 'high' } } }));
  assert.equal(run('apply'), 1);
  assert.ok(err.some((l) => l === 'refused: phase 2: area {a,b}/** has braces (write each alternative as its own mask)'));
  fs.writeFileSync(analysisFile(root), JSON.stringify(ANALYSIS));
  assert.equal(run('apply'), 0);
  assert.deepEqual(out.slice(-3), ['marked up: phase 2, 3, 4', 'pairs: 1', 'committed']);
  run('brief');
  assert.equal(out.at(-4), 'reason: none');
});

test('annotate apply --relax: the forms it takes, and its refusal without a card', () => {
  const root = project();
  const { err, run } = cli(root);
  for (const bad of [['apply', '--relax', 'some'], ['apply', '--relax', 'r1,'], ['brief', '--relax', 'all'], ['apply', 'extra'], ['nothing'], []]) {
    assert.equal(run(...bad), 2, bad.join(' '));
    assert.match(err.at(-1), /^usage: turbo-run annotate brief \[--json\] \| annotate apply \[--relax all\|none\|<id>,<id>…\]$/);
  }
  assert.equal(run('apply', '--relax', 'all'), 1);
  assert.equal(err.at(-1), 'refused: no dependency card waits for an answer');
});

test('bin routes annotate; without a GSD core brief says so', () => {
  const root = project();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: tmpDir('claude-home'), GIT_CONFIG_NOSYSTEM: '1' };
  delete env.TURBO_CONTROL_ROOT;
  const run = (...a) => spawnSync(process.execPath, [path.resolve('bin/turbo-run.mjs'), ...a], { cwd: root, env, encoding: 'utf8' });
  let r = run('annotate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: turbo-run annotate brief/);
  r = run('annotate', 'brief');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /turbo-run annotate: gsd-core not found \(run turbo-run doctor\)/);
});
