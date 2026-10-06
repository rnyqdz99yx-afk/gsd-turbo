import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const run = (args, cwd) => execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('lane-status writes the run file from inside the project', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning', 'phases'), { recursive: true });
  run(['lane-status', '4', 'needs-owner', '--reason', 'owner sign-off'], path.join(root, '.planning', 'phases'));
  const rec = JSON.parse(fs.readFileSync(path.join(root, '.planning', 'turbo', 'run', 'p4.json'), 'utf8'));
  assert.equal(rec.status, 'needs-owner');
  assert.equal(rec.reason, 'owner sign-off');
});

test('lane-status rejects an unknown status with a non-zero exit', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning'));
  assert.throws(() => run(['lane-status', '4', 'bogus'], root));
});

test('status without a supervisor prints not running', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning'));
  assert.match(run(['status'], root), /not running/i);
});

test('unknown command exits non-zero with usage', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning'));
  assert.throws(() => run(['frobnicate'], root), /usage/i);
});

test('a corrupt turbo config is a one-line error with exit 1, never a stack trace', () => {
  const root = tmpDir('cli');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), '{\n  "lang": \n}\n');
  for (const cmd of ['status', 'notify']) {
    assert.throws(() => run([cmd], root), (err) => {
      assert.equal(err.status, 1, cmd);
      assert.match(err.stderr, /invalid turbo config/, cmd);
      assert.equal(err.stderr.trim().split(/\r?\n/).length, 1, `${cmd}: ${err.stderr}`);
      assert.doesNotMatch(err.stderr, /\bat .+:\d+:\d+/, cmd);
      return true;
    });
  }
});

test('status shows failingSince in text and json output', () => {
  const root = tmpDir('cli');
  const run1 = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run1, { recursive: true });
  const since = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(path.join(run1, 'supervisor.json'), JSON.stringify({ lane: null, finished: false, halted: false, failingSince: since }));
  assert.match(run(['status'], root), new RegExp(`failing since ${since.replace(/\./g, '\\.')}`));
  const json = JSON.parse(run(['status', '--json'], root));
  assert.equal(json.running, false);
  assert.equal(json.failingSince, since);
});
