import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { writeBuildPhase4, writeLanePhase3 } from './fixtures/cost.mjs';
import { COST_USAGE } from '../lib/cost.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');

// A project with lane phase 3 and build phase 4 (synthetic), and the Claude home that holds phase 3's transcripts.
function project() {
  const root = tmpDir('cli-cost');
  const home = tmpDir('cli-cost-home');
  writeLanePhase3({ home, root });
  writeBuildPhase4(root);
  return { root, env: { ...process.env, CLAUDE_CONFIG_DIR: home } };
}
const run = (args, { root, env }) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function failure(args, p) {
  try {
    run(args, p);
  } catch (e) {
    return { status: e.status, stderr: e.stderr };
  }
  return { status: 0, stderr: '' };
}

test('turbo-run cost prints the phase by step and role with totals', () => {
  const p = project();
  const text = run(['cost', '3'], p);
  assert.match(text, /^phase 3 · path lane · wall 10m16s · ≈IEU 13\.4K$/m);
  assert.match(text, /^step\s+role\s+sessions\s+time\s+out\s+in\+create\s+cache read\s+≈IEU$/m);
  assert.match(text, /^turbo-phase\s+orchestrator\s+1\s+0m30s\s+70\s+1\.1K\s+2\.0K\s+1\.9K$/m);
  assert.match(text, /^discuss\s+gsd-assumptions-analyzer\s+1\s+3m00s\s+500\s+4\.2K\s+8\.0K\s+8\.5K$/m);
  assert.match(text, /^total\s+3\s+10m16s\s+760\s+5\.8K\s+24\.0K\s+13\.4K$/m);
  const json = JSON.parse(run(['cost', '3', '--json'], p));
  assert.equal(json.path, 'lane');
  assert.equal(json.rows.length, 4);
  assert.equal(json.total.ieu, 13385);
});

test('turbo-run cost --compare puts the other phase beside, with the ratio', () => {
  const p = project();
  const text = run(['cost', '3', '--compare', '4'], p);
  assert.match(text, /^phase 3 \(path lane\) beside phase 4 \(path build\)$/m);
  assert.match(text, /^discuss\s+orchestrator\s+1\s+6m25s\s+2\.0K\s+-\s+-\s+-$/m);
  assert.match(text, /^build\s+builder\s+-\s+-\s+-\s+2\s+15m00s\s+86\.0K$/m);
  assert.match(text, /^total\s+3\s+10m16s\s+13\.4K\s+4\s+17m00s\s+139\.4K$/m);
  assert.match(text, /^phase 3 \/ phase 4: wall 60% · ≈IEU 10%$/m);
  const json = JSON.parse(run(['cost', '3', '--compare', '4', '--json'], p));
  assert.equal(json.compare.path, 'build');
  assert.equal(json.compare.total.ieu, 139380);
});

test('turbo-run cost --log appends the cost line to supervisor.log', () => {
  const p = project();
  const line = 'phase 4 cost: path build · wall 17m00s · ≈IEU 139.4K · sessions 4 · slices 2 · fix rounds 1 · steps: slice 5m00s 46.0K, build 10m00s 86.0K, review 2m00s 7.4K';
  assert.equal(run(['cost', '4', '--log'], p), `${line}\n`);
  const log = fs.readFileSync(path.join(p.root, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8').trimEnd().split('\n');
  assert.match(log.at(-1), /^\d{4}-\d\d-\d\dT[\d:.]+Z phase 4 cost: path build · /);
  assert.equal(log.at(-1).replace(/^\S+ /, ''), line);
});

test('turbo-run cost: no data, and usage errors', () => {
  const p = project();
  assert.equal(run(['cost', '9'], p), 'phase 9: no cost data: no lane session in supervisor.log, no run/cost-p9.json\n');
  for (const args of [['cost'], ['cost', '3', '--log', '--json'], ['cost', '3', '--compare'], ['cost', '3', '--bogus']]) {
    const r = failure(args, p);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stderr.trim(), COST_USAGE, args.join(' '));
  }
});

test('turbo-run cost --project before --log measures the named project from anywhere; after --log it measures nothing', () => {
  const p = project();
  const other = tmpDir('cli-cost-other');
  fs.mkdirSync(path.join(other, '.planning'));
  const elsewhere = { ...p, root: other };
  const logOf = (root) => path.join(root, '.planning', 'turbo', 'logs', 'supervisor.log');
  assert.match(run(['cost', '4', '--project', p.root, '--log'], elsewhere), /^phase 4 cost: path build · /);
  assert.match(fs.readFileSync(logOf(p.root), 'utf8'), /Z phase 4 cost: path build · /);
  const r = failure(['cost', '4', '--log', '--project', p.root], elsewhere);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--project .* was not taken \(it must come before --log\); nothing measured/);
  assert.equal(fs.existsSync(logOf(other)), false, 'the working directory\'s project is never written');
});
