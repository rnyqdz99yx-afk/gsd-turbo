import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STALE_REPORT, MANAGER, adoptProject, closedRow, commitAll, write } from './helpers/adopt.mjs';
import { setManager } from './helpers/fake-gsd.mjs';
import { TURBO_TEST_CMD } from '../lib/project-init.mjs';
import { closedCacheFile, closedLineFor } from '../lib/cli-adopt.mjs';
import { ADOPT_REL, adoptPlan, applyAdopt, readRecord, reverifyResult, scanProject, staleClosedLine } from '../lib/adopt.mjs';

// The fixes of the review of Stage 5 A.
const status = (git) => git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter((l) => l && !l.slice(3).startsWith('.planning/turbo/run/')).join('\n');
const headOf = (git) => git(['rev-parse', 'HEAD']).trim();
const KEEP = { 'stale-closed': 'keep' };
const confirm = (root, deps, answers = KEEP) => adoptPlan(root, { deps, answers }).plan;

test('review 1: a commit that fails (a pre-commit hook) is refused without a stack trace; the next adopt finishes it once', () => {
  const { root, git, deps } = adoptProject();
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\necho no commits today >&2\nexit 1\n', { mode: 0o755 });
  const head = headOf(git);
  const r = applyAdopt(root, { answers: KEEP, plan: confirm(root, deps), deps });
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0], /^git commit failed: .*; run \/turbo-adopt again to finish$/);
  assert.equal(headOf(git), head);
  assert.equal(readRecord(root).state, 'applied');
  fs.rmSync(hook);
  // the record is applied but not committed: an interrupted adopt, accepted and finished
  assert.deepEqual(scanProject(root, { deps }).refused, []);
  const p = adoptPlan(root, { deps, answers: {} });
  assert.equal(p.changes[0].kind, 'resume');
  assert.ok(p.changes[0].paths.includes(ADOPT_REL));
  const done = applyAdopt(root, { answers: {}, plan: p.plan, deps });
  assert.ok(done.committed, String(done.refused));
  assert.equal(git(['rev-list', '--count', `${head}..HEAD`]).trim(), '1');
  assert.equal(status(git), '');
});

test('review 2: phases finished at adopt time are decided; one that finishes later is never named or asked about', () => {
  const { root, core, deps } = adoptProject();
  applyAdopt(root, { answers: KEEP, plan: confirm(root, deps), deps });
  assert.deepEqual(readRecord(root).finished, ['1']);
  // phase 2 is checked off later, its verification stale by later work: the run's normal life
  const later = { ...MANAGER, phases: [MANAGER.phases[0], closedRow('2', ['1']), ...MANAGER.phases.slice(2)] };
  setManager(core, later);
  const phases = scanProject(root, { deps }).phases;
  assert.equal(staleClosedLine(root, phases, 'en'), null);
  const p = adoptPlan(root, { deps, answers: {} });
  assert.deepEqual(p.questions, []);
  assert.deepEqual(p.changes, []);
});

test('review 3: the closed-phases line is skipped while the supervisor runs, cached on what it depends on, and not read after an adopt', () => {
  const { root, core, deps } = adoptProject();
  const line = 'closed phases not re-verified: 1 (checked off, verification stale; turbo skips them) · /turbo-adopt';
  assert.equal(closedLineFor(root, 'en', { running: true }), null);
  assert.equal(closedLineFor(root, 'en'), line);
  assert.ok(fs.existsSync(closedCacheFile(root)));
  // GSD's answer changes, nothing the line depends on did: the cached line, init manager not asked again
  setManager(core, { ...MANAGER, phases: MANAGER.phases.slice(1) });
  assert.equal(closedLineFor(root, 'en'), line);
  // a file of a phase changed: read again
  write(root, '.planning/phases/01-base/01-UAT.md', 'x\n');
  assert.equal(closedLineFor(root, 'en'), null);
  setManager(core, MANAGER);
  fs.rmSync(path.join(root, '.planning', 'phases', '01-base', '01-UAT.md'));
  applyAdopt(root, { answers: KEEP, plan: confirm(root, deps), deps });
  // after an adopt that recorded its finished phases nothing is read: GSD may even be gone
  fs.rmSync(path.join(root, '.claude'), { recursive: true });
  assert.equal(closedLineFor(root, 'en'), null);
});

test('review 4: a re-check report GSD cannot read is moved aside first and the committed one put back; init manager failing meanwhile falls back to the disk', () => {
  const { root, deps } = adoptProject();
  const rel = '.planning/phases/01-base/01-VERIFICATION.md';
  write(root, rel, '---\nstatus: weird\n---\nnew\n');
  const broken = (args) => {
    if (args[0] === 'verification' || args[0] === 'init') throw new Error('verification status weird is not one of passed, gaps_found, human_needed');
    return deps.gsd(args);
  };
  const r = reverifyResult(root, '1', { deps: { ...deps, gsd: broken } });
  assert.deepEqual([r.status, r.kept, r.report], ['unreadable', false, '.planning/turbo/adopt/reverify-p1.md']);
  assert.match(r.reason, /^GSD cannot read the new report: /);
  assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), STALE_REPORT);
  assert.match(fs.readFileSync(path.join(root, '.planning', 'turbo', 'adopt', 'reverify-p1.md'), 'utf8'), /status: weird/);
});

test('a first adopt of a project turbo already runs in writes its record and says so; only turbo\'s files to write never touches GSD\'s config', () => {
  const gsdConfig = JSON.stringify({ workflow: { test_command: TURBO_TEST_CMD }, context_window: 400000, planning: { chunked_parallel: true } }, null, 2);
  const manager = { ...MANAGER, phases: MANAGER.phases.slice(1) };
  const { root, git, deps } = adoptProject({ manager, files: { '.planning/config.json': gsdConfig } });
  let p = adoptPlan(root, { deps, answers: {} });
  assert.deepEqual(p.changes.map((c) => c.kind), ['turbo-config', 'record']);
  let r = applyAdopt(root, { answers: {}, plan: p.plan, deps });
  assert.ok(r.committed, String(r.refused));
  assert.equal(fs.readFileSync(path.join(root, '.planning', 'config.json'), 'utf8'), gsdConfig, 'no config-set');
  assert.equal(status(git), '');

  const q = adoptProject({ manager, files: { '.planning/config.json': gsdConfig, '.planning/turbo/config.json': '{}', '.planning/turbo/.gitignore': 'run/\nlogs/\nlocks/\n' } });
  p = adoptPlan(q.root, { deps: q.deps, answers: {} });
  assert.deepEqual(p.changes.map((c) => [c.kind, c.text]), [['record', "turbo is already set up; adopt's record written (`.planning/turbo/adopt.json`)"]]);
  r = applyAdopt(q.root, { answers: {}, plan: p.plan, deps: q.deps });
  assert.ok(r.committed);
  assert.equal(readRecord(q.root).state, 'applied');
  assert.deepEqual(adoptPlan(q.root, { deps: q.deps, answers: {} }).changes, []);
});

test('the Russian report: plural forms of phases, the not-committed line in Russian', () => {
  const { root, deps } = adoptProject({ config: { lang: 'ru', lanes: { mode: 'checkout' } } });
  write(root, 'notes.md', 'x\n');
  commitAll(root);
  // .planning ignored by git: nothing can be committed
  write(root, '.git/info/exclude', '.planning/\n');
  const r = applyAdopt(root, { answers: KEEP, plan: confirm(root, deps), deps });
  const text = r.report.join('\n');
  assert.match(text, /обычный GSD: 3 фазы подряд/);
  assert.match(text, /^не закоммичено: /m);
});
