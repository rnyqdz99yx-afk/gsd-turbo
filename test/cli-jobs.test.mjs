import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { ROADMAP } from './fixtures/roadmap-lanes.mjs';
import { slotRecordFile } from '../lib/paths.mjs';
import { roadmapDigest } from '../lib/roadmap-lanes.mjs';
import { JOB_STATUSES, jobKey, jobRecordKey, readAnnotateAttempt, readJobStatus, readLaneStatus, writeJobStatus } from '../lib/run-status.mjs';

const BIN = path.resolve('bin/turbo-run.mjs');

// A control project and one slot cloned from it, on turbo/prep-5, with L0's slot record (D1 of L0) naming its base.
function slotProject() {
  const control = tmpGitRepo();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(control, '.git', 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1', TURBO_LANE: '1', CLAUDE_CONFIG_DIR: tmpDir('claude-home') };
  delete env.TURBO_CONTROL_ROOT;
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  fs.mkdirSync(path.join(control, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(control, '.planning', 'turbo', '.gitignore'), 'run/\nlogs/\nlocks/\n');
  fs.writeFileSync(path.join(control, '.planning', 'ROADMAP.md'), ROADMAP);
  fs.writeFileSync(path.join(control, '.planning', 'STATE.md'), '# State\n');
  git(control, 'add', '-A');
  git(control, 'commit', '-q', '-m', 'planning');
  const base = git(control, 'rev-parse', 'HEAD');
  const slot = path.join(tmpDir('slots'), 'lane-1');
  git(path.dirname(slot), 'clone', '-q', '--local', control, slot);
  for (const [k, v] of [['user.email', 'test@example.invalid'], ['user.name', 'test'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(slot, 'config', k, v);
  git(slot, 'checkout', '-q', '-B', 'turbo/prep-5');
  const at = new Date().toISOString();
  fs.writeFileSync(slotRecordFile(slot), JSON.stringify({ v: 1, k: 1, path: slot, control, createdAt: at, copied: [], job: { kind: 'prep', phase: '5', branch: 'turbo/prep-5', base: { branch: 'main', sha: base }, state: 'active', startedAt: at, endedAt: null, outcome: null } }));
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: slot, env, encoding: 'utf8' });
  return { control, slot, base, git, run };
}

// L1 D3: a job's record is the lane record of its recordKey (p<N>.json for prep, pannotate.json for annotate).
const statusFile = (root, key) => path.join(root, '.planning', 'turbo', 'run', `p${key}.json`);

test('job statuses: keys, allowed statuses per kind, written as L1\'s lane records', () => {
  const root = tmpDir('jobs');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  assert.deepEqual([jobKey({ kind: 'prep', phase: '5' }), jobKey({ kind: 'annotate', phase: null })], ['prep-5', 'annotate']);
  assert.deepEqual([jobRecordKey({ kind: 'prep', phase: '5' }), jobRecordKey({ kind: 'annotate', phase: null })], ['5', 'annotate']);
  assert.deepEqual(JOB_STATUSES, { prep: ['running', 'paused-context', 'failed', 'prepped'], annotate: ['running', 'paused-context', 'failed', 'annotated'] });
  const rec = writeJobStatus(root, { kind: 'prep', phase: '5' }, 'failed', { reason: 'discuss failed', at: '2026-10-13T00:00:00.000Z' });
  assert.deepEqual(rec, { phase: '5', status: 'failed', reason: 'discuss failed', sessionId: '', at: '2026-10-13T00:00:00.000Z' });
  assert.deepEqual(readJobStatus(root, { kind: 'prep', phase: '5' }), rec);
  assert.deepEqual(readLaneStatus(root, '5'), rec, 'the same file L1 reads');
  assert.throws(() => writeJobStatus(root, { kind: 'prep', phase: '5' }, 'annotated'), /unknown prep status: annotated/);
  assert.throws(() => writeJobStatus(root, { kind: 'phase', phase: '5' }, 'running'), /unknown phase status/);
  assert.equal(readJobStatus(root, { kind: 'annotate', phase: null }), null);
  assert.equal(readAnnotateAttempt(root), null);
});

test('prepped refuses STATE.md committed by GSD, names it and the base, then passes once it is put back; the status lands in the control root', () => {
  const { control, slot, base, git, run } = slotProject();
  const dir = path.join(slot, '.planning', 'phases', '05-search');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '05-CONTEXT.md'), '# Phase 5 context\n');
  fs.writeFileSync(path.join(slot, '.planning', 'STATE.md'), '# State\nphase 5 context session\n');
  git(slot, 'add', '-A');
  git(slot, 'commit', '-q', '-m', 'docs(05): capture phase context');
  let r = run('lane-status', '5', 'prepped', '--job', 'prep');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`refused: outside the phase directory of phase 5: \\.planning/STATE\\.md \\(base ${base}\\)`));
  assert.ok(!fs.existsSync(statusFile(control, '5')));
  git(slot, 'checkout', base, '--', '.planning/STATE.md');
  git(slot, 'commit', '-q', '-m', 'chore(phase-5): leave shared planning files to the supervisor');
  r = run('lane-status', '5', 'prepped', '--job', 'prep');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'prep 5: prepped');
  assert.equal(JSON.parse(fs.readFileSync(statusFile(control, '5'), 'utf8')).status, 'prepped');
  assert.ok(!fs.existsSync(statusFile(slot, '5')), 'never in the slot');
});

test('prepped refuses an uncommitted change and a prep without CONTEXT.md; failed and running need no check', () => {
  const { control, slot, run } = slotProject();
  fs.writeFileSync(path.join(slot, 'stray.txt'), 'x');
  let r = run('lane-status', '5', 'prepped', '--job', 'prep');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refused: uncommitted changes: stray\.txt/);
  fs.rmSync(path.join(slot, 'stray.txt'));
  r = run('lane-status', '5', 'prepped', '--job', 'prep');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refused: phase 5 has no CONTEXT\.md: prep is not done/);
  r = run('lane-status', '5', 'failed', '--job', 'prep', '--reason', 'discuss produced no CONTEXT.md');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(statusFile(control, '5'), 'utf8')).reason, 'discuss produced no CONTEXT.md');
});

test('lane-status annotate: failed records the status and the ROADMAP digest; annotated needs a fresh lanes.json', () => {
  const { control, run } = slotProject();
  let r = run('lane-status', 'annotate', 'failed', '--reason', 'the analysis was refused twice');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'annotate: failed');
  assert.equal(JSON.parse(fs.readFileSync(statusFile(control, 'annotate'), 'utf8')).status, 'failed');
  assert.equal(readAnnotateAttempt(control).roadmapSha256, roadmapDigest(ROADMAP));
  r = run('lane-status', 'annotate', 'annotated');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refused: lanes\.json is missing or does not match the ROADMAP/);
});

test('usage: a status of the other kind, a missing --job kind, a bad phase id; the v0.3 form is unchanged', () => {
  const { control, run } = slotProject();
  for (const args of [['5', 'annotated', '--job', 'prep'], ['annotate', 'prepped'], ['5', 'prepped', '--job', 'phase'], ['annotate', 'failed', '--job', 'prep'], ['5/x', 'failed', '--job', 'prep']]) {
    const r = run('lane-status', ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: turbo-run lane-status <phase> <running\|paused-context\|failed\|prepped> --job prep/);
  }
  const r = spawnSync(process.execPath, [BIN, 'lane-status', '5', 'running'], { cwd: control, env: { ...process.env, TURBO_CONTROL_ROOT: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'lane 5: running');
});
