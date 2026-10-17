import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED, controlProject, fakeSlot, gitIn } from './helpers/slots.mjs';
import { draftText, outline, planText } from './helpers/drafts.mjs';
import { draftFile } from '../lib/plan-drafts.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
const ENV = { ...ISOLATED, CLAUDE_CONFIG_DIR: tmpDir('home') };
const cli = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: ENV, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), first: r.stdout.split(/\r?\n/)[0] };
};
const ROWS = [['33-01', 1], ['33-02', 2, '33-01'], ['33-03', 3, '33-02']];

// A project (a git checkout with .planning/turbo) with phase 33's outline; GSD never commits the outline.
function phaseIn(root) {
  const dir = path.join(root, '.planning', 'phases', '33-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '33-CONTEXT.md'), '# context\n');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'phase 33');
  fs.writeFileSync(path.join(dir, '33-PLAN-OUTLINE.md'), outline(ROWS));
  return dir;
}
const commitPlan = (root, dir, id, text) => {
  fs.writeFileSync(path.join(dir, `${id}-PLAN.md`), text);
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', `docs(33): plan ${id} (chunked)`);
};

test('turbo-run plan-drafts: each action\'s first line and exit code', () => {
  const root = controlProject();
  const dir = phaseIn(root);
  let r = cli(root, 'plan-drafts', '33', '--plan');
  assert.deepEqual([r.code, r.first], [0, 'drafts on: 3 waves, 3 plans · draft now: 33-02, 33-03 · left to GSD: none']);
  r = cli(root, 'plan-drafts', '33', '--plan', '--json');
  assert.deepEqual(JSON.parse(r.out), { use: true, waves: [['33-01'], ['33-02'], ['33-03']], draftNow: ['33-02', '33-03'], rest: [], removed: [], commitFirst: [] });
  r = cli(root, 'plan-drafts', '33', '--drafting', '33-01');
  assert.deepEqual([r.code, r.first], [1, 'refused: 33-01 is in wave 1, the wave GSD plans now: GSD plans it']);
  r = cli(root, 'plan-drafts', '33', '--drafting', '33-02');
  assert.equal(r.code, 0);
  assert.match(r.first, /^\*\*Draft \(gsd-turbo\)\.\*\* /);
  assert.ok(r.out.includes(draftFile(root, '33', '33-02')));
  r = cli(root, 'plan-drafts', '33', '--drafted', '33-02');
  assert.equal(r.code, 1);
  assert.match(r.first, /^refused: no draft file /);
  fs.writeFileSync(draftFile(root, '33', '33-02'), draftText('33-02', 2, ['33-01']));
  assert.deepEqual(cli(root, 'plan-drafts', '33', '--drafted', '33-02').first, 'drafted 33-02');
  r = cli(root, 'plan-drafts', '33', '--reconcile', '33-02');
  assert.deepEqual([r.code, r.first], [1, 'refused: 33-01 is not committed yet: reconcile 33-02 after its commit']);
  commitPlan(root, dir, '33-01', planText('33-01', 1));
  r = cli(root, 'plan-drafts', '33', '--reconcile', '33-02');
  assert.deepEqual([r.code, r.first], [0, 'reconcile 33-02: 1 plan before it']);
  assert.deepEqual(cli(root, 'plan-drafts', '33', '--reconciled', '33-02', '--verdict', 'passed').first, 'reconciled 33-02');
  assert.deepEqual(cli(root, 'plan-drafts', '33', '--promote', '33-02').first, 'promoted 33-02: .planning/phases/33-demo/33-02-PLAN.md');
  r = cli(root, 'plan-drafts', '33', '--plan');
  assert.deepEqual(r.out.split('\n').at(-1), 'commit first: 33-02');
  r = cli(root, 'plan-drafts', '33', '--reconcile', '33-03');
  assert.deepEqual([r.code, r.first], [0, 'use: gsd (no draft)']);
  assert.deepEqual(cli(root, 'plan-drafts', '33', '--replan', '33-03', '--reason', 'no marker').first, 'replanned 33-03');
  r = cli(root, 'plan-drafts', '33', '--reconcile', '33-03');
  assert.deepEqual([r.code, r.first], [0, 'use: gsd (replanned: no marker)']);
  r = cli(root, 'plan-drafts', '33', '--reconciled', '33-03', '--verdict', 'failed');
  assert.deepEqual([r.code, r.first], [1, 'refused: 33-03 is replanned, not reconciling (run --reconcile first)']);
  // --plan takes no value: a --project after it names the project
  assert.match(cli(tmpDir('elsewhere'), 'plan-drafts', '33', '--plan', '--project', root).first, /^drafts on: 3 waves/);
  assert.equal(cli(tmpDir('elsewhere'), 'plan-drafts', '33', '--replan', '33-03', '--reason', '--project', '--project', root).first, 'replanned 33-03');
});

test('usage errors exit 2: no action, two actions, a verdict other than passed or failed, an id outside the outline', () => {
  const root = controlProject();
  phaseIn(root);
  const usage = (...a) => {
    const r = cli(root, 'plan-drafts', ...a);
    assert.equal(r.code, 2, a.join(' '));
    assert.match(r.err, /^usage: turbo-run plan-drafts <phase> --plan/);
  };
  usage('33');
  usage('33', '--plan', '--drafting', '33-02');
  usage('33', '--reconciled', '33-02', '--verdict', 'ok');
  usage('33', '--reconciled', '33-02');
  usage('33', '--promote', '33-02', '--verdict', 'passed');
  usage('33', '--drafting', '33-09');
  usage('33', '--replan', '');
  usage('../x', '--plan');
  // drafts disabled: off, and the record says why (the measurement line)
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ plan_drafts: { enabled: false } }));
  assert.equal(cli(root, 'plan-drafts', '33', '--plan').first, 'drafts off: plan_drafts.enabled is false');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.planning', 'turbo', 'run', 'drafts-p33', 'drafts.json'), 'utf8')).lastPlan.why, 'plan_drafts.enabled is false');
  // a bad value is a config error, never off
  fs.writeFileSync(path.join(root, '.planning', 'turbo', 'config.json'), JSON.stringify({ plan_drafts: { max_parallel: 0 } }));
  const r = cli(root, 'plan-drafts', '33', '--plan');
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid turbo config plan_drafts\.max_parallel/);
});

test('in a slot the record lands in the slot\'s run directory and the measurement line in the control root\'s log', () => {
  const { control, slot } = fakeSlot();
  gitIn(slot, 'config', 'user.email', 'test@example.invalid');
  gitIn(slot, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(slot, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(slot, '.planning', 'turbo', '.gitignore'), 'run/\nlogs/\nlocks/\n');
  const dir = phaseIn(slot);
  assert.match(cli(slot, 'plan-drafts', '33', '--plan').first, /^drafts on: /);
  assert.ok(fs.existsSync(path.join(slot, '.planning', 'turbo', 'run', 'drafts-p33', 'drafts.json')));
  assert.equal(fs.existsSync(path.join(control, '.planning', 'turbo', 'run', 'drafts-p33')), false);
  for (const s of ['freshness', 'discuss', 'prologue']) assert.equal(cli(slot, 'phase-step', '33', '--done', s).code, 0);
  for (const id of ['33-01', '33-02', '33-03']) commitPlan(slot, dir, id, planText(id, ROWS.find((x) => x[0] === id)[1]));
  assert.equal(cli(slot, 'phase-step', '33', '--plan-checked', '--note', 'passed').code, 0);
  const r = cli(slot, 'phase-step', '33', '--done', 'plan');
  assert.equal(r.code, 0, r.err);
  assert.match(fs.readFileSync(path.join(control, '.planning', 'turbo', 'logs', 'supervisor.log'), 'utf8'), / phase 33 plan: \d+h\d{2}m wall clock · drafts on: 3 plans in 3 waves, 0 drafted, 0 reconciled, 0 replanned\n$/);
  assert.equal(fs.existsSync(path.join(slot, '.planning', 'turbo', 'logs')), false);
});
