import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { extractRefs, classifyArtifact, stalenessReport, recordBases, BASE_FILE } from '../lib/staleness.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';

function repo() {
  const root = tmpGitRepo();
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
  const commit = (m) => { g('add', '-A'); g('commit', '-q', '-m', m); return g('rev-parse', 'HEAD'); };
  return { root, g, write, commit };
}

test('extractRefs finds paths and line references', () => {
  const r = extractRefs('Edit `lib/a.mjs:12-20` and lib/b.mjs, see ./docs/x.md#L4. <read_first>src/c.ts, src/d.ts</read_first> README.md');
  for (const p of ['lib/a.mjs', 'lib/b.mjs', 'docs/x.md', 'src/c.ts', 'src/d.ts', 'README.md']) assert.ok(r.paths.includes(p), p);
  assert.deepEqual(r.lineRefs.sort(), ['docs/x.md', 'lib/a.mjs']);
  assert.ok(!r.paths.includes('read_first') && !r.paths.includes('/read_first'));
});

test('classifyArtifact: deleted → rebuild, cited line changed or file created → reground, context only on deletion', () => {
  const changes = new Map([['a.js', 'D'], ['b.js', 'M'], ['c.js', 'M'], ['n.js', 'A']]);
  assert.equal(classifyArtifact({ kind: 'plan', refs: ['b.js'], lineRefs: ['b.js'], changes }).action, 'reground');
  assert.equal(classifyArtifact({ kind: 'plan', refs: ['c.js'], lineRefs: [], changes }).action, 'fresh');
  assert.equal(classifyArtifact({ kind: 'plan', refs: ['n.js'], changes }).action, 'reground');
  const both = classifyArtifact({ kind: 'plan', refs: ['b.js', 'a.js'], lineRefs: ['b.js'], changes });
  assert.equal(both.action, 'rebuild');
  assert.equal(both.reasons.length, 2);
  assert.equal(classifyArtifact({ kind: 'context', refs: ['b.js', 'n.js'], lineRefs: ['b.js'], changes }).action, 'fresh');
  assert.equal(classifyArtifact({ kind: 'context', refs: ['a.js'], changes }).action, 'rebuild');
});

test('stalenessReport: commit base, recorded base, executed plans skipped', () => {
  const r = repo();
  r.write('src/keep.js', 'k\n');
  r.write('src/gone.js', 'g\n');
  r.write('src/lines.js', '1\n2\n3\n');
  const dir = '.planning/phases/03-alpha';
  r.write(`${dir}/03-CONTEXT.md`, 'Decisions about `src/keep.js`.\n');
  r.write(`${dir}/03-01-PLAN.md`, '---\nfiles_modified: [src/keep.js]\n---\n<read_first>src/gone.js</read_first>\n');
  r.write(`${dir}/03-02-PLAN.md`, 'Change src/lines.js:2 only.\n');
  r.write(`${dir}/03-03-PLAN.md`, 'Untouched src/keep.js.\n');
  r.commit('plan');
  r.g('rm', '-q', 'src/gone.js');
  r.write('src/lines.js', '1\nTWO\n3\n');
  r.write('src/keep.js', 'k2\n');
  r.commit('a later phase');
  const plans = [
    { id: '03-01', files_modified: ['src/keep.js'], has_summary: false },
    { id: '03-02', files_modified: [], has_summary: false },
    { id: '03-03', files_modified: [], has_summary: false },
  ];
  const phaseDir = path.join(r.root, dir);
  const rep = stalenessReport({ root: r.root, phaseDir, plans });
  const by = Object.fromEntries(rep.artifacts.map((x) => [x.file, x]));
  assert.equal(by['03-CONTEXT.md'].action, 'fresh');
  assert.equal(by['03-CONTEXT.md'].baseSource, 'commit');
  assert.equal(by['03-01-PLAN.md'].action, 'rebuild');
  assert.match(by['03-01-PLAN.md'].reasons.join(), /src\/gone\.js: deleted/);
  assert.equal(by['03-02-PLAN.md'].action, 'reground');
  assert.equal(by['03-03-PLAN.md'].action, 'fresh');
  recordBases(phaseDir, ['03-01-PLAN.md', '03-02-PLAN.md'], rep.head);
  const again = stalenessReport({ root: r.root, phaseDir, plans });
  const p1 = again.artifacts.find((x) => x.file === '03-01-PLAN.md');
  assert.deepEqual([p1.action, p1.baseSource], ['fresh', 'record']);
  const done = stalenessReport({ root: r.root, phaseDir, plans: plans.map((p) => ({ ...p, has_summary: true })) });
  assert.equal(done.skipped, 'every plan has a summary');
});

test('an artifact that was never committed (git-ignored .planning) is fresh, never an error', () => {
  const r = repo();
  r.write('.gitignore', '.planning/\n');
  r.commit('ignore planning');
  const phaseDir = path.join(r.root, '.planning', 'phases', '03-alpha');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), 'Edit README.md:1\n');
  const rep = stalenessReport({ root: r.root, phaseDir, plans: [{ id: '03-01', files_modified: [], has_summary: false }] });
  assert.deepEqual(rep.artifacts.map((x) => [x.action, x.baseSource]), [['fresh', 'uncommitted']]);
});

test('staleness CLI prints the report and records bases', async () => {
  const r = repo();
  r.write('.planning/phases/03-alpha/03-01-PLAN.md', 'Edit README.md:1\n');
  r.commit('plan');
  r.write('README.md', '# changed\n');
  r.commit('change');
  const lines = [];
  const deps = { planIndex: () => [{ id: '03-01', files_modified: [], has_summary: false }] };
  const run = (...a) => runPhaseCommand('staleness', a, { root: r.root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps });
  assert.equal(await run('3'), 0);
  assert.match(lines.at(-1), /^reground +03-01-PLAN\.md: README\.md: changed at a referenced line/);
  assert.equal(await run('3', '--record', '03-01-PLAN.md'), 0);
  assert.ok(fs.existsSync(path.join(r.root, '.planning/phases/03-alpha', BASE_FILE)));
  assert.equal(await run('3', '--json'), 0);
  assert.equal(JSON.parse(lines.at(-1)).artifacts[0].action, 'fresh');
  assert.equal(await run('3', '--record', 'nope.md'), 1);
});

test('staleness CLI names the candidates when the phase directory is ambiguous', async () => {
  const root = tmpDir('stale');
  for (const d of ['03-alpha', '03-beta']) fs.mkdirSync(path.join(root, '.planning', 'phases', d), { recursive: true });
  const lines = [];
  const run = (...a) => runPhaseCommand('staleness', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps: { planIndex: () => [] } });
  assert.equal(await run('3'), 1);
  assert.match(lines.at(-1), /phase 3 is ambiguous: 03-alpha, 03-beta — resolve it in \.planning\/phases$/);
  assert.equal(await run('9'), 1);
  assert.match(lines.at(-1), /no phase directory for phase 9/);
});
