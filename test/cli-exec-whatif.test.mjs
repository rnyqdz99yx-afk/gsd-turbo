import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED, gitIn } from './helpers/slots.mjs';
import { executed, executorTranscript, phaseRepo } from './helpers/whatif.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');

// The owner runs it at home from a gsd-turbo checkout, against a project: --project, any cwd.
test('turbo-run exec-whatif --project: text and --json from outside the project, nothing written; refusals and usage', () => {
  const repo = phaseRepo({ plans: [{ id: '43-01', files: ['src/a.ts'] }, { id: '43-02', files: ['src/b.ts'] }, { id: '43-03', wave: 2, deps: ['43-01'] }], phase: '43' });
  executed(repo, '43-01', '2026-10-02T10:02:00Z', '2026-10-02T10:30:00Z');
  executed(repo, '43-02', '2026-10-02T10:03:00Z', '2026-10-02T10:08:00Z');
  repo.at('2026-10-02T10:34:00Z', 'docs(phase-43): update tracking after wave 1', ['.planning/STATE.md']);
  executed(repo, '43-03', '2026-10-02T10:36:00Z', '2026-10-02T10:50:00Z');
  const home = tmpDir('home');
  executorTranscript(home, repo.root, { agent: 'b01', description: 'Execute plan 01 of phase 43', times: ['2026-10-02T10:01:00Z', '2026-10-02T10:29:00Z'] });
  const env = { ...ISOLATED, CLAUDE_CONFIG_DIR: home };
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: tmpDir('elsewhere'), env, encoding: 'utf8', windowsHide: true });
  const before = gitIn(repo.root, 'status', '--porcelain', '--ignored');
  let r = cli('exec-whatif', '43', '--project', repo.root);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split(/\r?\n/);
  assert.equal(lines[0], 'phase 43: 3 plans');
  assert.match(lines[1], /^timings: transcripts 1 · /);
  assert.ok(lines.some((l) => l.startsWith('GSD waves: ')), r.stdout);
  r = cli('exec-whatif', '43', '--json', '--max-executors', '2', '--merge-minutes', '1', '--project', repo.root);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.phase, j.maxExecutors, j.merge.minutes, j.plans.find((p) => p.id === '43-01').source], ['43', 2, 1, 'transcripts']);
  assert.equal(gitIn(repo.root, 'status', '--porcelain', '--ignored'), before, 'the calculator writes nothing in the project');
  r = cli('exec-whatif', '44', '--project', repo.root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^refused: no single phase directory for phase 44/);
  r = cli('exec-whatif', '43', '--max-executors', '0', '--project', repo.root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^refused: --max-executors takes a number \(whole\) ≥ 1/);
  r = cli('exec-whatif', '--project', repo.root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: turbo-run exec-whatif <phase>/);
});
