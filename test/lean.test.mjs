import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { fakeGsdCore } from './helpers/fake-gsd.mjs';
import { ABSENT, createGsdConfig, sameConfig } from '../lib/gates.mjs';
import { LEAN_KEYS, LEAN_PREV_REL, LeanRefused, leanApply, leanChanges, leanCurrent, leanLines, leanOff } from '../lib/lean.mjs';

const ORIGINAL = { workflow: { nyquist_validation: true, auto_advance: true }, context_window: 1000000 };
const git = (root, ...args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })).trim();
const write = (root, rel, text) => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const json = (root, rel) => JSON.parse(read(root, rel));
const at = (o, k) => k.split('.').reduce((x, s) => (x && typeof x === 'object' ? x[s] : undefined), o);

// A git project on GSD (fake core in .claude/, ignored) with .planning/config.json committed (tracked: false leaves it
// out of git).
function leanProject({ config = ORIGINAL, turbo = null, tracked = true } = {}) {
  const root = tmpGitRepo();
  write(root, '.gitignore', tracked ? '.claude/\n' : '.claude/\n.planning/config.json\n');
  write(root, '.planning/config.json', JSON.stringify(config, null, 2));
  if (turbo) write(root, '.planning/turbo/config.json', JSON.stringify(turbo));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'project');
  const core = fakeGsdCore(root);
  return { root, core };
}

test('lean apply writes the ten GSD keys through config-set, keeps the previous values and commits once', () => {
  const { root, core } = leanProject();
  assert.equal(leanCurrent(root), false);
  const before = git(root, 'rev-parse', 'HEAD');
  const r = leanApply({ root, core, now: new Date('2026-10-17T10:00:00Z') });
  const cfg = json(root, '.planning/config.json');
  for (const [k, v] of LEAN_KEYS) assert.equal(at(cfg, k), v, k);
  assert.deepEqual(json(root, LEAN_PREV_REL), {
    v: 1,
    at: '2026-10-17T10:00:00.000Z',
    keys: {
      'workflow.nyquist_validation': 'true',
      'workflow.pattern_mapper': ABSENT,
      'workflow.ui_review': ABSENT,
      'workflow.security_enforcement': ABSENT,
      'workflow.auto_prune_state': ABSENT,
      'workflow.compact_content': ABSENT,
      'workflow.assumption_delta': ABSENT,
      'workflow.auto_advance': 'true',
      'graphify.auto_update': ABSENT,
      context_window: '1000000',
    },
  });
  assert.equal(r.changed.length, 10);
  assert.deepEqual(r.changed[0], { key: 'workflow.nyquist_validation', from: 'true', to: 'false' });
  assert.equal(r.enabled, null);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore(turbo): lean mode GSD settings');
  assert.equal(git(root, 'rev-list', '--count', `${before}..HEAD`), '1');
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split(/\r?\n/), ['.planning/config.json', '.planning/turbo/lean-prev.json']);
  assert.equal(r.commit.committed, true);
  assert.equal(leanCurrent(root), true);
  const lines = leanLines(r);
  assert.ok(lines.includes('lean: workflow.nyquist_validation true → false'), lines.join('\n'));
  assert.ok(lines.includes('lean: workflow.pattern_mapper absent → false'), lines.join('\n'));
  assert.ok(lines.includes('lean: previous values in .planning/turbo/lean-prev.json'), lines.join('\n'));
  assert.ok(lines.some((l) => /^lean: committed [0-9a-f]{7,} chore\(turbo\): lean mode GSD settings$/.test(l)), lines.join('\n'));
});

test('lean apply is idempotent: a second run changes nothing, commits nothing, keeps lean-prev byte for byte', () => {
  const { root, core } = leanProject();
  leanApply({ root, core });
  const prev = read(root, LEAN_PREV_REL);
  const head = git(root, 'rev-parse', 'HEAD');
  const r = leanApply({ root, core });
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.paths, []);
  assert.equal(r.commit, null);
  assert.equal(read(root, LEAN_PREV_REL), prev);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(leanLines(r), ['lean: GSD settings already lean']);
});

test('lean apply after a key drifted sets it again and keeps the value from before turbo first changed it', () => {
  const { root, core } = leanProject();
  leanApply({ root, core });
  createGsdConfig({ root, core }).set('workflow.pattern_mapper', 'true');
  const r = leanApply({ root, core });
  assert.deepEqual(r.changed, [{ key: 'workflow.pattern_mapper', from: 'true', to: 'false' }]);
  assert.equal(json(root, '.planning/config.json').workflow.pattern_mapper, false);
  assert.equal(json(root, LEAN_PREV_REL).keys['workflow.pattern_mapper'], ABSENT);
});

test('lean off restores every previous value, removes absent keys, deletes lean-prev, sets lean.enabled false and commits', () => {
  const { root, core } = leanProject();
  leanApply({ root, core });
  const r = leanOff({ root, core, hint: () => 'effort: how to undo' });
  assert.ok(sameConfig(json(root, '.planning/config.json'), ORIGINAL), read(root, '.planning/config.json'));
  assert.equal(fs.existsSync(path.join(root, LEAN_PREV_REL)), false);
  assert.equal(json(root, '.planning/turbo/config.json').lean.enabled, false);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore(turbo): lean mode off, GSD settings restored');
  assert.equal(r.restored.length, 10);
  assert.ok(r.restored.some((x) => x.key === 'context_window' && x.from === '400000' && x.to === '1000000'));
  assert.equal(r.hint, 'effort: how to undo');
  const lines = leanLines(r, { off: true });
  assert.ok(lines.includes('lean: workflow.pattern_mapper false → absent'), lines.join('\n'));
  assert.ok(lines.includes('lean: lean.enabled false in .planning/turbo/config.json'), lines.join('\n'));
  assert.equal(lines.at(-1), 'effort: how to undo');
  // without lean-prev.json: nothing to restore, lean.enabled still false
  const again = leanOff({ root, core });
  assert.deepEqual(again.restored, []);
  assert.equal(json(root, '.planning/turbo/config.json').lean.enabled, false);
});

test('lean apply refuses while a phase has its gates off', () => {
  const { root, core } = leanProject();
  write(root, '.planning/turbo/gates/p3.json', JSON.stringify({ phase: '3', original: {} }));
  const bytes = read(root, '.planning/config.json');
  assert.throws(() => leanApply({ root, core }), (e) => e instanceof LeanRefused && /^phase 3 has GSD's built-in gates off \(\.planning\/turbo\/gates\/p3\.json\): run turbo-run gates restore 3 first; nothing was changed$/.test(e.message));
  assert.equal(read(root, '.planning/config.json'), bytes);
  assert.equal(fs.existsSync(path.join(root, LEAN_PREV_REL)), false);
});

test('lean apply --dry-run lists the changes and writes nothing', () => {
  const { root, core } = leanProject();
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push(args.slice(1, 3));
    return execFileSync(cmd, args, opts);
  };
  const bytes = read(root, '.planning/config.json');
  const head = git(root, 'rev-parse', 'HEAD');
  const r = leanApply({ root, core, exec, dryRun: true });
  assert.equal(r.changed.length, 10);
  assert.equal(r.commit, null);
  assert.ok(calls.every(([verb]) => verb === 'config-get'), JSON.stringify(calls));
  assert.equal(read(root, '.planning/config.json'), bytes);
  assert.equal(fs.existsSync(path.join(root, LEAN_PREV_REL)), false);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(leanLines(r).at(-1), 'lean: dry run, nothing written');
});

test('an untracked .planning/config.json is written but not committed', () => {
  const { root, core } = leanProject({ tracked: false });
  const head = git(root, 'rev-parse', 'HEAD');
  const r = leanApply({ root, core });
  assert.equal(leanCurrent(root), true);
  assert.deepEqual(r.commit, { committed: false, reason: 'config not tracked' });
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.ok(leanLines(r).includes('lean: not committed (config not tracked)'));
});

test('lean apply sets lean.enabled true when the turbo config had it false', () => {
  const { root, core } = leanProject({ turbo: { lean: { enabled: false } } });
  const r = leanApply({ root, core });
  assert.deepEqual(r.enabled, { from: false, to: true });
  assert.equal(json(root, '.planning/turbo/config.json').lean.enabled, true);
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split(/\r?\n/).sort(), ['.planning/config.json', '.planning/turbo/config.json', '.planning/turbo/lean-prev.json']);
  // leanChanges is read-only: nothing left to change
  assert.deepEqual(leanChanges({ root, cfg: createGsdConfig({ root, core }) }), []);
});
