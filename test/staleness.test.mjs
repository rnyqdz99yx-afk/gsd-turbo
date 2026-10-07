import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { extractRefs, classifyArtifact, stalenessReport, recordBases, gitRunner, BASE_FILE } from '../lib/staleness.mjs';
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

test('extractRefs reads GSD reference forms: @paths, dot-paths, directories, any line suffix', () => {
  const r = extractRefs([
    '@src/a.ts:12 @.planning/STATE.md',
    '<read_first>.env.example, .github/workflows/ci.yml</read_first>',
    'src/b.ts:12:5 src/c.ts:L12 src/d.ts:12—30 src/e.ts#30 src/f.ts:',
    'src/components/ ../outside.js src/../up.js',
  ].join('\n'));
  for (const p of ['src/a.ts', '@src/a.ts', '.planning/STATE.md', '.env.example', '.github/workflows/ci.yml', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/components']) {
    assert.ok(r.paths.includes(p), p);
  }
  assert.deepEqual(r.lineRefs.sort(), ['@src/a.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
  assert.ok(!r.paths.some((p) => p.includes('..')), r.paths.join());
});

test('stalenessReport: @-cited and dot-path deletions rebuild, an @-cited changed line regrounds, a created own-phase file ignored', () => {
  const r = repo();
  r.write('src/x.ts', 'x\n');
  r.write('src/a.ts', '1\n2\n');
  r.write('.env.example', 'A=1\n');
  r.write('src/components/c.tsx', 'c\n');
  const dir = '.planning/phases/03-alpha';
  r.write(`${dir}/03-01-PLAN.md`, 'Context: @src/x.ts\n');
  r.write(`${dir}/03-02-PLAN.md`, '<read_first>.env.example</read_first>\n');
  r.write(`${dir}/03-03-PLAN.md`, 'See @src/a.ts:2 and @.planning/phases/03-alpha/03-01-SUMMARY.md\n');
  r.write(`${dir}/03-04-PLAN.md`, 'Put it in src/components/\n');
  r.commit('plan');
  r.g('rm', '-q', 'src/x.ts', '.env.example', 'src/components/c.tsx');
  r.write('src/a.ts', '1\nTWO\n');
  r.write(`${dir}/03-01-SUMMARY.md`, 'done\n');
  r.commit('later');
  const plans = ['03-01', '03-02', '03-03', '03-04'].map((id) => ({ id, files_modified: [], has_summary: false }));
  const by = Object.fromEntries(stalenessReport({ root: r.root, phaseDir: path.join(r.root, dir), plans }).artifacts.map((x) => [x.file, x]));
  assert.deepEqual(by['03-01-PLAN.md'].reasons, ['src/x.ts: deleted or renamed']);
  assert.equal(by['03-01-PLAN.md'].action, 'rebuild');
  assert.deepEqual([by['03-02-PLAN.md'].action, by['03-02-PLAN.md'].reasons], ['rebuild', ['.env.example: deleted or renamed']]);
  assert.deepEqual([by['03-03-PLAN.md'].action, by['03-03-PLAN.md'].reasons], ['reground', ['src/a.ts: changed at a referenced line']]);
  assert.deepEqual([by['03-04-PLAN.md'].action, by['03-04-PLAN.md'].reasons], ['rebuild', ['src/components: deleted or renamed']]);
});

test('files_modified paths are normalized like cited paths', () => {
  const r = repo();
  r.write('src/m.ts', 'm\n');
  r.write('.planning/phases/03-alpha/03-01-PLAN.md', 'plan\n');
  r.commit('plan');
  r.g('rm', '-q', 'src/m.ts');
  r.commit('drop');
  const plans = [{ id: '03-01', files_modified: ['./src\\m.ts'], has_summary: false }];
  const rep = stalenessReport({ root: r.root, phaseDir: path.join(r.root, '.planning/phases/03-alpha'), plans });
  assert.deepEqual(rep.artifacts.map((x) => [x.action, x.reasons]), [['rebuild', ['src/m.ts: deleted or renamed']]]);
});

test('bare PLAN.md and nested plans/PLAN-NN.md are checked; a plan without its file is reported, never dropped', async () => {
  const r = repo();
  r.write('src/x.ts', 'x\n');
  const dir = '.planning/phases/03-alpha';
  r.write(`${dir}/PLAN.md`, 'Uses @src/x.ts\n');
  r.write(`${dir}/plans/PLAN-02.md`, 'Edit src/x.ts:1\n');
  r.commit('plan');
  r.g('rm', '-q', 'src/x.ts');
  r.commit('drop x');
  const plans = ['', 'plans/PLAN-02.md', '03-09'].map((id) => ({ id, files_modified: [], has_summary: false }));
  const phaseDir = path.join(r.root, dir);
  const rep = stalenessReport({ root: r.root, phaseDir, plans });
  assert.deepEqual(rep.artifacts.map((x) => [x.id, x.file, x.action]), [
    ['', 'PLAN.md', 'rebuild'],
    ['plans/PLAN-02.md', 'plans/PLAN-02.md', 'rebuild'],
    ['03-09', '03-09-PLAN.md', 'rebuild'],
  ]);
  assert.deepEqual(rep.artifacts[2].reasons, ['plan file not found']);
  const lines = [];
  const run = (...a) => runPhaseCommand('staleness', a, { root: r.root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps: { planIndex: () => plans } });
  assert.equal(await run('3', '--record', `${dir}/plans/PLAN-02.md`, 'PLAN.md'), 0);
  const again = stalenessReport({ root: r.root, phaseDir, plans });
  assert.deepEqual(again.artifacts.slice(0, 2).map((x) => [x.action, x.baseSource]), [['fresh', 'record'], ['fresh', 'record']]);
});

test('staleness CLI fails on a phase-plan-index error instead of checking no plans', async () => {
  const r = repo();
  r.write('.planning/phases/03-alpha/03-01-PLAN.md', 'Edit README.md:1\n');
  const core = path.join(r.root, '.claude', 'gsd-core');
  fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(core, 'VERSION'), '1.16.0');
  fs.writeFileSync(path.join(core, 'bin', 'gsd-tools.cjs'), "process.stdout.write(JSON.stringify({ phase: '3', error: 'Phase not found', plans: [] }));\n");
  const lines = [];
  assert.equal(await runPhaseCommand('staleness', ['3'], { root: r.root, out: (l) => lines.push(l), err: (l) => lines.push(l) }), 1);
  assert.match(lines.at(-1), /phase-plan-index 3: Phase not found/);
});

test('a repository without commits: every artifact uncommitted and fresh, no tree reads, nothing recorded', async () => {
  const root = tmpDir('stale');
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
  const phaseDir = path.join(root, '.planning', 'phases', '03-alpha');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '03-CONTEXT.md'), 'About README.md\n');
  fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), 'Edit README.md:1\n');
  const calls = [];
  const real = gitRunner(root);
  const git = (args, enc) => { calls.push(args[0]); return real(args, enc); };
  const rep = stalenessReport({ root, phaseDir, plans: [{ id: '03-01', files_modified: ['README.md'], has_summary: false }], git });
  assert.equal(rep.head, null);
  assert.deepEqual(rep.artifacts.map((x) => [x.file, x.action, x.baseSource]), [['03-CONTEXT.md', 'fresh', 'uncommitted'], ['03-01-PLAN.md', 'fresh', 'uncommitted']]);
  assert.ok(!calls.some((c) => c === 'ls-files' || c === 'ls-tree' || c === 'diff'), calls.join());
  const lines = [];
  const run = (...a) => runPhaseCommand('staleness', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(l), deps: { planIndex: () => [{ id: '03-01', has_summary: false }] } });
  assert.equal(await run('3'), 0);
  assert.equal(await run('3', '--record-all'), 0);
  assert.equal(lines.at(-1), 'no commit yet: nothing recorded');
  assert.ok(!fs.existsSync(path.join(phaseDir, BASE_FILE)));
});

test('recordBases orders keys by code unit, independent of locale', () => {
  const dir = tmpDir('stale');
  const f = recordBases(dir, ['a.md', 'B.md', 'plans/PLAN-01.md', 'PLAN.md'], 'f'.repeat(40), new Date(0));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))), ['B.md', 'PLAN.md', 'a.md', 'plans/PLAN-01.md']);
});

test('extractRefs: separate line citations and bracketed path segments', () => {
  const r = extractRefs([
    'Copy auth pattern from `src/controllers/users.ts` lines 12-25.',
    'Analog `src/a.ts` (L12-L30), and src/b.ts at line 4; see lines 3-5 of src/c.ts',
    '**Analog:** `src/d.ts`',
    '',
    '**Imports pattern** (lines 1-8):',
    '```typescript',
    "import { x } from './src/fenced.ts'; // lines 9-10",
    '```',
    '**Auth pattern** (lines 12-18):',
    'Untouched src/e.ts, then src/f.ts',
    '<read_first>src/app/[slug]/page.tsx, app/(auth)/login/page.tsx</read_first> [src/g.ts](src/g.ts) files_modified: [src/h.ts, src/i.ts]',
    'Also @./src/j.ts',
  ].join('\n'));
  for (const p of ['src/controllers/users.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/fenced.ts', 'src/e.ts', 'src/f.ts',
    'src/app/[slug]/page.tsx', 'app/(auth)/login/page.tsx', 'src/g.ts', 'src/h.ts', 'src/i.ts', 'src/j.ts', '@src/j.ts']) {
    assert.ok(r.paths.includes(p), p);
  }
  assert.deepEqual(r.lineRefs.sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/controllers/users.ts', 'src/d.ts']);
  assert.ok(!r.paths.includes('src/app') && !r.paths.includes('app'), r.paths.join());
});

test('stalenessReport: a changed analog range regrounds; a deleted bracketed path or sibling plan rebuilds', () => {
  const r = repo();
  r.write('src/controllers/users.ts', '1\n2\n3\n');
  r.write('src/app/[slug]/page.tsx', 'p\n');
  const dir = '.planning/phases/03-alpha';
  r.write(`${dir}/03-PATTERNS.md`, [
    '### `src/controllers/auth.ts` (controller, request-response)',
    '',
    '**Analog:** `src/controllers/users.ts`',
    '',
    '**Auth pattern** (lines 2-3):',
    '```typescript',
    'router.use(authenticate);',
    '```',
    '',
  ].join('\n'));
  r.write(`${dir}/03-01-PLAN.md`, 'Copy auth pattern from `src/controllers/users.ts` lines 2-3.\n');
  r.write(`${dir}/03-02-PLAN.md`, '<read_first>src/app/[slug]/page.tsx</read_first>\n');
  r.write(`${dir}/03-03-PLAN.md`, 'Builds on @.planning/phases/03-alpha/03-09-PLAN.md\n');
  r.write(`${dir}/03-09-PLAN.md`, 'dropped later\n');
  r.commit('plan');
  r.write('src/controllers/users.ts', '1\nTWO\n3\n');
  r.g('rm', '-q', 'src/app/[slug]/page.tsx', `${dir}/03-09-PLAN.md`);
  r.commit('later');
  const plans = ['03-01', '03-02', '03-03'].map((id) => ({ id, files_modified: [], has_summary: false }));
  const by = Object.fromEntries(stalenessReport({ root: r.root, phaseDir: path.join(r.root, dir), plans }).artifacts.map((x) => [x.file, x]));
  assert.deepEqual([by['03-PATTERNS.md'].action, by['03-PATTERNS.md'].reasons], ['reground', ['src/controllers/users.ts: changed at a referenced line']]);
  assert.deepEqual([by['03-01-PLAN.md'].action, by['03-01-PLAN.md'].reasons], ['reground', ['src/controllers/users.ts: changed at a referenced line']]);
  assert.deepEqual([by['03-02-PLAN.md'].action, by['03-02-PLAN.md'].reasons], ['rebuild', ['src/app/[slug]/page.tsx: deleted or renamed']]);
  assert.deepEqual([by['03-03-PLAN.md'].action, by['03-03-PLAN.md'].reasons], ['rebuild', [`${dir}/03-09-PLAN.md: deleted or renamed`]]);
});
