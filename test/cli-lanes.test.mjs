import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { ISOLATED, mainProject, slotFixture } from './helpers/slots.mjs';
import { runLanesCommand } from '../lib/cli-lanes.mjs';
import { prepareSlot, slotPath } from '../lib/slots.mjs';
import { trustLine, trustState } from '../lib/trust.mjs';

const CLI = path.resolve('bin/turbo-run.mjs');
function lanes(root, t, args, env = {}) {
  const out = [];
  const err = [];
  const code = runLanesCommand(args, { root, out: (l) => out.push(l), err: (l) => err.push(l), env: { TURBO_LANE: '', ...env }, deps: t.deps });
  return { code, out, err };
}

test('turbo-run lanes setup creates and trusts the slots, then keeps them; remove takes the trust with it; trust and --no-trust-write', () => {
  const p = mainProject();
  const t = slotFixture(p.root);
  const s1 = slotPath(p.root, t.config, 1);
  const s2 = slotPath(p.root, t.config, 2);
  let r = lanes(p.root, t, ['setup']);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.deepEqual(r.out, [`lane-1: created ${s1}`, 'lane-1: trusted', `lane-2: created ${s2}`, 'lane-2: trusted', `backup of ${t.claudeJson}: ${t.claudeJson}.turbo-bak-20261013T120000Z`]);
  r = lanes(p.root, t, ['setup']);
  assert.deepEqual([r.code, r.out], [0, [`lane-1: kept ${s1}`, 'lane-1: trusted (already)', `lane-2: kept ${s2}`, 'lane-2: trusted (already)']]);
  r = lanes(p.root, t, ['remove', '2']);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(r.out[0], `lane-2: removed ${s2}`);
  assert.match(r.out[1], /^backup of /);
  assert.equal(fs.existsSync(s2), false);
  assert.equal(trustState(s2, { file: t.claudeJson }), 'untrusted');
  const bytes = fs.readFileSync(t.claudeJson, 'utf8');
  r = lanes(p.root, t, ['setup', '--no-trust-write']);
  assert.equal(r.code, 3);
  assert.ok(r.out.includes(`lane-2: ${trustLine(s2)} (writing the trust is off: lanes.trust_write is false or --no-trust-write was given)`), r.out.join('\n'));
  assert.equal(fs.readFileSync(t.claudeJson, 'utf8'), bytes);
  r = lanes(p.root, t, ['trust']);
  assert.deepEqual([r.code, r.out.slice(0, 2)], [0, ['lane-1: trusted (already)', 'lane-2: trusted']]);
  assert.match(r.out[2], /^backup of /);
  prepareSlot(p.root, 1, { kind: 'phase', phase: '3' }, t.deps);
  r = lanes(p.root, t, ['remove']);
  assert.equal(r.code, 1);
  assert.match(r.err.join('\n'), /lane-1: refused: slot 1 holds phase 3 on turbo\/p3/);
  assert.equal(r.out[0], `lane-2: removed ${s2}`);
  assert.equal(fs.existsSync(s1), true);
});

test('turbo-run lanes remove makes one backup per command: with more slots than backups kept, the one from before the command stays', () => {
  const p = mainProject();
  const t = slotFixture(p.root, { max: 6 });
  assert.equal(lanes(p.root, t, ['setup']).code, 0);
  const before = fs.readFileSync(t.claudeJson, 'utf8');
  const baks = () => fs.readdirSync(t.home).filter((n) => n.startsWith('.claude.json.turbo-bak-')).sort();
  const had = baks();
  const r = lanes(p.root, t, ['remove']);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(r.out.filter((l) => l.startsWith('lane-') && l.includes(': removed ')).length, 6, r.out.join('\n'));
  const lines = r.out.filter((l) => l.startsWith('backup of '));
  assert.equal(lines.length, 1, r.out.join('\n'));
  const made = baks().filter((n) => !had.includes(n));
  assert.equal(made.length, 1, baks().join('\n'));
  assert.equal(lines[0], `backup of ${t.claudeJson}: ${path.join(t.home, made[0])}`);
  assert.equal(fs.readFileSync(path.join(t.home, made[0]), 'utf8'), before, 'the backup holds the file from before the command');
  assert.deepEqual(baks(), [...had, ...made].sort(), 'no earlier backup pruned');
});

test('turbo-run lanes refuses inside a lane and inside a slot; a bad subcommand prints its usage (exit 2)', () => {
  const p = mainProject();
  const t = slotFixture(p.root);
  const inLane = lanes(p.root, t, ['setup'], { TURBO_LANE: '1' });
  assert.equal(inLane.code, 1);
  assert.match(inLane.err[0], /a lane never runs it/);
  assert.equal(fs.existsSync(t.dir), false);
  lanes(p.root, t, ['setup']);
  const inSlot = lanes(slotPath(p.root, t.config, 1), t, ['setup']);
  assert.equal(inSlot.code, 1);
  assert.match(inSlot.err[0], /is a lane slot: run turbo-run lanes in the main checkout/);
  assert.equal(lanes(p.root, t, ['remove', 'x']).code, 2);
  assert.equal(lanes(p.root, t, ['trust', '1']).code, 2);
  const home = tmpDir('home');
  const u = spawnSync(process.execPath, [CLI, 'lanes'], { cwd: p.root, env: { ...ISOLATED, TURBO_LANE: '', CLAUDE_CONFIG_DIR: home }, encoding: 'utf8', windowsHide: true });
  assert.equal(u.status, 2);
  assert.match(u.stderr, /usage: turbo-run lanes setup \[--no-trust-write\] \| lanes trust \[--no-trust-write\] \| lanes remove \[<k>\]/);
});
