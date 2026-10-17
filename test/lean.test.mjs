import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { fakeGsdCore } from './helpers/fake-gsd.mjs';
import { effortHome } from './helpers/effort-gsd.mjs';
import { ABSENT, createGsdConfig, sameConfig } from '../lib/gates.mjs';
import { LEAN_KEYS, LEAN_PREV_REL, LeanRefused, effortApply, effortOffHint, executeBegun, leanApply, leanBoundary, leanChanges, leanCurrent, leanLines, leanOff } from '../lib/lean.mjs';
import { completeStep } from '../lib/phase-progress.mjs';
import { mergeLockFile } from '../lib/merge-lock.mjs';

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
    base: before,
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
  const bytes = read(root, '.planning/config.json');
  leanApply({ root, core });
  const r = leanOff({ root, core, hint: () => 'effort: how to undo' });
  assert.ok(sameConfig(json(root, '.planning/config.json'), ORIGINAL), read(root, '.planning/config.json'));
  // the bytes from before lean (no "graphify": {} left behind by config-set)
  assert.equal(read(root, '.planning/config.json'), bytes);
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

test('lean off refuses while a phase has its gates off: its restore would put lean\'s values back as the originals', () => {
  const { root, core } = leanProject();
  leanApply({ root, core });
  write(root, '.planning/turbo/gates/p4.json', JSON.stringify({ phase: '4', original: {} }));
  const bytes = read(root, '.planning/config.json');
  const prev = read(root, LEAN_PREV_REL);
  assert.throws(() => leanOff({ root, core }), (e) => e instanceof LeanRefused && /^phase 4 has GSD's built-in gates off/.test(e.message));
  assert.equal(read(root, '.planning/config.json'), bytes);
  assert.equal(read(root, LEAN_PREV_REL), prev);
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo', 'config.json')), false);
});

test('a failing commit or no repository: the keys are written, the commit is named not made, never an error', () => {
  const { root, core } = leanProject();
  // a pre-commit hook that refuses (core.hooksPath is the repository's own hooks directory)
  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho no >&2\nexit 1\n', { mode: 0o755 });
  const r = leanApply({ root, core });
  assert.equal(leanCurrent(root), true);
  assert.equal(r.commit.committed, false);
  assert.match(leanLines(r).find((l) => l.startsWith('lean: not committed')), /^lean: not committed \(git commit failed: /);
  // outside git: written, not committed
  const bare = fs.mkdtempSync(path.join(path.dirname(root), 'turbo-lean-nogit-'));
  write(bare, '.planning/config.json', '{}');
  const coreBare = fakeGsdCore(bare);
  const logs = [];
  assert.equal(leanBoundary({ root: bare, phase: '1', core: coreBare, log: (l) => logs.push(l) }).applied, true);
  assert.ok(logs.some((l) => /^lean: not committed \(git ls-files failed: /.test(l)), logs.join('\n'));
  assert.equal(leanCurrent(bare), true);
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

test('lean apply with an effort step returns its result and prints effort lines; lean off prints the hint', () => {
  const { root, core } = leanProject();
  const h = effortHome();
  const r = leanApply({ root, core, effort: (o = {}) => effortApply({ root, env: h.env, home: h.home, ...o }) });
  assert.equal(r.effort.changes.length, 3);
  const lines = leanLines(r);
  assert.ok(lines.includes('lean: effort gsd-planner xhigh → high (GSD effort sync, every project on this machine)'), lines.join('\n'));
  // the effort step runs after the commit: the lean commit is the last one and holds only the project's files
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore(turbo): lean mode GSD settings');
  assert.ok(leanLines(leanApply({ root, core, effort: () => effortApply({ root, env: h.env, home: h.home }) })).includes('lean: effort already lean'));
  // a failing effort step never undoes the keys: its error is the skipped reason
  const failing = leanApply({ root, core, effort: () => { throw new Error('gsd-tools effort sync failed: boom'); } });
  assert.deepEqual(leanLines(failing).at(-1), 'lean: effort not changed: gsd-tools effort sync failed: boom');
  const off = leanOff({ root, core, hint: () => effortOffHint({ env: h.env, home: h.home }) });
  assert.match(leanLines(off, { off: true }).at(-1), /^effort: GSD's agents keep gsd-planner high, gsd-assumptions-analyzer high, gsd-phase-researcher medium on this machine\. To return to GSD's defaults/);
});

// --- Task 9: lean at the phase boundary (D10) ---
const PLANNED = ['freshness', 'discuss', 'prologue', 'plan'];
const steps = (root, phase, list) => { for (const st of list) completeStep(root, phase, st); };
// counts the gsd-tools calls (config-get and config-set) of the lean step
const execSpy = () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push(args[1]);
    return execFileSync(cmd, args, opts);
  };
  return { exec, calls };
};

test('leanBoundary applies before a phase whose execute step has not begun and commits once', () => {
  const { root, core } = leanProject();
  steps(root, '4', PLANNED);
  assert.equal(executeBegun(root, '4'), false);
  const head = git(root, 'rev-parse', 'HEAD');
  const logs = [];
  const r = leanBoundary({ root, phase: '4', core, log: (l) => logs.push(l) });
  assert.equal(r.applied, true);
  assert.equal(logs[0], 'lean: applied before phase 4: 10 GSD settings');
  assert.ok(logs.some((l) => /^lean: committed [0-9a-f]+ chore\(turbo\): lean mode GSD settings$/.test(l)), logs.join('\n'));
  assert.equal(git(root, 'rev-list', '--count', `${head}..HEAD`), '1');
  assert.equal(leanCurrent(root), true);
});

test('leanBoundary leaves a phase whose execute step began alone and says why', () => {
  const NOT = 'lean: not applied before phase 4: its execute step has begun (lean applies at the next phase)';
  // turbo's record: gates-off done
  const a = leanProject();
  steps(a.root, '4', [...PLANNED, 'gates-off']);
  const bytes = read(a.root, '.planning/config.json');
  let logs = [];
  assert.equal(executeBegun(a.root, '4'), true);
  assert.deepEqual(leanBoundary({ root: a.root, phase: '4', core: a.core, log: (l) => logs.push(l) }), { applied: false, why: 'its execute step has begun' });
  assert.deepEqual(logs, [NOT]);
  assert.equal(read(a.root, '.planning/config.json'), bytes);
  // no turbo record (a safe-mode lane): a plan SUMMARY says the same
  const b = leanProject();
  write(b.root, '.planning/phases/04-work/04-01-PLAN.md', '---\nwave: 1\n---\n');
  write(b.root, '.planning/phases/04-work/04-01-SUMMARY.md', '# done\n');
  logs = [];
  assert.deepEqual(leanBoundary({ root: b.root, phase: '4', core: b.core, log: (l) => logs.push(l) }), { applied: false, why: 'its execute step has begun' });
  assert.deepEqual(logs, [NOT]);
  // no turbo record and no SUMMARY yet, but GSD's begin-phase marked STATE.md: execute has begun
  const s = leanProject();
  write(s.root, '.planning/STATE.md', '# Project State\n\n## Current Position\n\nPhase: 4 of 5 (Work)\nStatus: Executing Phase 04\n');
  logs = [];
  assert.equal(executeBegun(s.root, '4'), true);
  assert.equal(executeBegun(s.root, '5'), false, 'another phase executing is no sign for this one');
  assert.deepEqual(leanBoundary({ root: s.root, phase: '4', core: s.core, log: (l) => logs.push(l) }), { applied: false, why: 'its execute step has begun' });
  write(s.root, '.planning/STATE.md', '# Project State\n\n## Current Position\n\n**Status:** Ready to execute (Executing Phase 4)\n');
  assert.equal(executeBegun(s.root, '4'), true);
  write(s.root, '.planning/STATE.md', '# Project State\n\nStatus: Phase complete\n\nNotes: Executing Phase 4 went well\n');
  assert.equal(executeBegun(s.root, '4'), false, 'only the Status line counts');
  // another phase's gates are off: lean waits for their restore
  const c = leanProject();
  write(c.root, '.planning/turbo/gates/p3.json', JSON.stringify({ phase: '3', original: {} }));
  logs = [];
  const r = leanBoundary({ root: c.root, phase: '4', core: c.core, log: (l) => logs.push(l) });
  assert.equal(r.applied, false);
  assert.match(r.why, /turbo-run gates restore 3/);
  assert.deepEqual(logs, [`lean: not applied before phase 4: ${r.why}`]);
});

test('leanBoundary is silent and calls no gsd-tools when lean is off or already current', () => {
  const { root, core } = leanProject({ turbo: { lean: { enabled: false } } });
  const spy = execSpy();
  const logs = [];
  const at = () => leanBoundary({ root, phase: '4', core, exec: spy.exec, log: (l) => logs.push(l) });
  assert.deepEqual(at(), { applied: false, why: 'lean off' });
  assert.deepEqual([spy.calls.length, logs], [0, []]);
  // the config is read fresh at every call
  write(root, '.planning/turbo/config.json', JSON.stringify({ lean: { enabled: true } }));
  assert.equal(at().applied, true);
  const calls = spy.calls.length;
  logs.length = 0;
  assert.deepEqual(at(), { applied: false, why: 'current' });
  assert.deepEqual([spy.calls.length, logs], [calls, []]);
  write(root, '.planning/turbo/config.json', JSON.stringify({ lean: { enabled: false } }));
  createGsdConfig({ root, core }).set('workflow.pattern_mapper', 'true');
  assert.deepEqual(at(), { applied: false, why: 'lean off' });
  assert.deepEqual([spy.calls.length, logs], [calls, []]);
});

test('a held merge lock or a failing gsd-tools: not applied, logged, never thrown', () => {
  const { root, core } = leanProject();
  const bytes = read(root, '.planning/config.json');
  const file = mergeLockFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${process.pid}-held`);
  const logs = [];
  const r = leanBoundary({ root, phase: '4', core, log: (l) => logs.push(l), lockWaitMs: 50 });
  assert.equal(r.applied, false);
  assert.match(r.why, /merge lock/);
  assert.deepEqual(logs, [`lean: not applied before phase 4: ${r.why}`]);
  assert.equal(read(root, '.planning/config.json'), bytes);
  fs.rmSync(file);
  const failing = leanBoundary({ root, phase: '4', core, exec: () => { throw Object.assign(new Error('boom'), { stderr: 'gsd broke' }); }, log: () => {} });
  assert.equal(failing.applied, false);
  assert.match(failing.why, /^gsd-tools config-get workflow\.nyquist_validation failed: gsd broke$/);
});

test('leanBoundary runs GSD\'s effort sync after the merge lock is released, and logs its lines', () => {
  const { root, core } = leanProject();
  let held = null;
  const logs = [];
  const r = leanBoundary({ root, phase: '4', core, log: (l) => logs.push(l), effort: () => {
    held = fs.existsSync(mergeLockFile(root));
    return { defaultsChanged: true, changes: [{ agent: 'gsd-planner', from: 'xhigh', to: 'high' }] };
  } });
  assert.equal(r.applied, true);
  assert.equal(held, false);
  assert.ok(logs.includes('lean: effort gsd-planner xhigh → high (GSD effort sync, every project on this machine)'), logs.join('\n'));
});
