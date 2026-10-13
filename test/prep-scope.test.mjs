import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { dirNameMatchesPhase } from '../lib/phase-files.mjs';
import { readProgress, readPrepProgress } from '../lib/phase-progress.mjs';
import { localRunDir } from '../lib/paths.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { allowedFor, annotateAllowed, outOfScope, prepAllowed } from '../lib/prep.mjs';

test('dirNameMatchesPhase: GSD\'s directory token, exact', () => {
  assert.ok(dirNameMatchesPhase('05-auth', '5'));
  assert.ok(dirNameMatchesPhase('ABC-05-auth', '5'));
  assert.ok(dirNameMatchesPhase('02.1-hotfix', '2.1'));
  assert.ok(!dirNameMatchesPhase('06-auth', '5'));
  assert.ok(!dirNameMatchesPhase('02.1-hotfix', '2'));
  assert.ok(!dirNameMatchesPhase('notes', '5'));
});

test('prepAllowed: only files inside the phase\'s own directory', () => {
  const ok = prepAllowed('5');
  assert.ok(ok('.planning/phases/05-auth/05-CONTEXT.md'));
  assert.ok(ok('.planning/phases/05-auth/turbo-base.json'));
  assert.ok(ok('.planning\\phases\\05-auth\\05-RESEARCH.md'), 'backslashes read as /');
  for (const p of ['.planning/phases/05-auth', '.planning/phases/06-x/06-CONTEXT.md', '.planning/STATE.md', '.planning/ROADMAP.md', '.planning/config.json', 'src/a.js', '.planning/phases/05-auth/../06-x/a.md', '.planning/phases//a.md']) assert.ok(!ok(p), p);
});

test('annotateAllowed: the ROADMAP, lanes.json and the decision files only', () => {
  const ok = annotateAllowed();
  for (const p of ['.planning/ROADMAP.md', '.planning/turbo/lanes.json', '.planning/turbo/DECISIONS.md', '.planning/decisions/turbo-2026-10-13-relaxed-dependencies.md', '.planning/decisions/sub/INDEX.md']) assert.ok(ok(p), p);
  for (const p of ['.planning/decisions', '.planning/STATE.md', '.planning/turbo/config.json', '.planning/decisions/../STATE.md', 'ROADMAP.md']) assert.ok(!ok(p), p);
  assert.ok(allowedFor({ kind: 'prep', phase: '5' })('.planning/phases/05-a/x.md'));
  assert.ok(allowedFor({ kind: 'annotate', phase: null })('.planning/ROADMAP.md'));
  assert.throws(() => allowedFor({ kind: 'phase', phase: '5' }), /no planning-only merge for a phase job/);
});

test('outOfScope: the net diff from the base and the uncommitted paths', () => {
  const root = tmpGitRepo();
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  fs.mkdirSync(path.join(root, '.planning', 'phases', '05-auth'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'STATE.md'), '# State\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, '.planning', 'phases', '05-auth', '05-CONTEXT.md'), '# ctx\n');
  fs.writeFileSync(path.join(root, '.planning', 'STATE.md'), '# State\nchanged\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'prep');
  const job = { kind: 'prep', phase: '5' };
  assert.deepEqual(outOfScope(root, job, { base }), { dirty: [], outside: ['.planning/STATE.md'] });
  git('checkout', base, '--', '.planning/STATE.md');
  git('commit', '-q', '-m', 'put back');
  assert.deepEqual(outOfScope(root, job, { base }), { dirty: [], outside: [] }, 'a path put back is no change');
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  assert.deepEqual(outOfScope(root, job, { base }).dirty, ['stray.txt']);
  assert.deepEqual(outOfScope(root, job, { base: null }).outside, [], 'no base: nothing to compare');
});

test('phase-step --prep: its own three steps, in the slot\'s own run directory, apart from the phase\'s progress', async () => {
  const root = tmpDir('prep-step');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  const lines = [];
  const errs = [];
  const run = (...a) => runPhaseCommand('phase-step', a, { root, out: (l) => lines.push(l), err: (l) => errs.push(l) });
  assert.equal(await run('05', '--prep'), 0);
  assert.equal(lines.at(-1), 'phase 5: prep next freshness');
  assert.equal(await run('5', '--prep', '--done', 'discuss'), 1);
  assert.match(errs.at(-1), /out of order \(next is freshness\)/);
  assert.equal(await run('5', '--prep', '--done', 'freshness', '--note', 'nothing stale'), 0);
  assert.equal(lines.at(-1), 'phase 5: prep next discuss (done: freshness)');
  await run('5', '--prep', '--done', 'discuss');
  await run('5', '--prep', '--done', 'prologue');
  assert.equal(await run('5', '--prep', '--json'), 0);
  assert.deepEqual(JSON.parse(lines.at(-1)), { phase: '5', prep: true, done: ['freshness', 'discuss', 'prologue'], next: null, steps: ['freshness', 'discuss', 'prologue'] });
  assert.ok(fs.existsSync(path.join(localRunDir(root), 'prep-p5.json')));
  assert.deepEqual(readPrepProgress(root, '5').notes, { freshness: 'nothing stale' });
  assert.deepEqual(readProgress(root, '5').done, [], 'the phase\'s own record is untouched');
  assert.equal(await run('5', '--prep', '--attempt', 'discuss'), 2);
  assert.equal(await run('5', '--prep', '--reset'), 2);
});
