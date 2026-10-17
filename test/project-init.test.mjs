import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers/tmp.mjs';
import { fakeGsdCore } from './helpers/fake-gsd.mjs';
import { InitAborted, TURBO_TEST_CMD, initChanges, initProject } from '../lib/project-init.mjs';
import { ABSENT } from '../lib/gates.mjs';

// A project with GSD's (fake) core: .planning/config.json as given, a package.json with a real test script.
function project({ gsdConfig = null, pkg = { scripts: { test: 'node --test' } } } = {}) {
  const root = tmpDir('init');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  if (gsdConfig) fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(gsdConfig));
  if (pkg) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const core = fakeGsdCore(root);
  return { root, core };
}
const kinds = (list) => list.map((c) => c.kind);
const gsdConfigOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.planning', 'config.json'), 'utf8'));

test('initChanges on a fresh project lists the turbo config, the test command and the context window, with their files', () => {
  const { root, core } = project();
  const list = initChanges(root, { core });
  assert.deepEqual(kinds(list), ['turbo-config', 'test-command', 'context-window']);
  assert.deepEqual([...new Set(list.flatMap((c) => c.paths))].sort(), ['.planning/config.json', '.planning/turbo/.gitignore', '.planning/turbo/config.json']);
  assert.equal(list.find((c) => c.kind === 'test-command').value, 'npm test');
  assert.equal(list.find((c) => c.kind === 'context-window').value, 1000000);
  for (const c of list) assert.equal(typeof c.text, 'string');
  // read-only: nothing was written
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo')), false);
  assert.equal(fs.existsSync(path.join(root, '.planning', 'config.json')), false);
});

test('after initProject, initChanges lists nothing', () => {
  const { root, core } = project();
  assert.equal(initProject(root, { core, inherit: false }), 0);
  assert.deepEqual(initChanges(root, { core }), []);
  assert.equal(gsdConfigOf(root).workflow.test_command, TURBO_TEST_CMD);
});

test('a project whose test command already runs turbo and whose context window is set lists only the missing turbo config', () => {
  const { root, core } = project({ gsdConfig: { workflow: { test_command: TURBO_TEST_CMD }, context_window: 400000 } });
  assert.deepEqual(kinds(initChanges(root, { core })), ['turbo-config']);
  // without a GSD core: only what turbo itself writes
  assert.deepEqual(kinds(initChanges(root, { core: null })), ['turbo-config']);
});

test('a project where no full test command is known gets no test-command change (init would not set it)', () => {
  const { root, core } = project({ pkg: null });
  assert.deepEqual(kinds(initChanges(root, { core })), ['turbo-config', 'context-window']);
});

test('initProject prints the lines of turbo-run init: the previous test command kept verbatim as test.full', () => {
  const prev = 'pytest -k "not slow"';
  const { root, core } = project({ gsdConfig: { workflow: { test_command: prev } } });
  const lines = [];
  initProject(root, { core, out: (l) => lines.push(l), inherit: false });
  assert.deepEqual(lines, [
    `kept previous workflow.test_command as test.full: ${prev}`,
    `workflow.test_command set to turbo-run test-changed (full test command: ${prev})`,
    'context_window set to 1000000 in .planning/config.json (GSD had none; its default is 200000)',
    `created ${path.join(root, '.planning', 'turbo', 'config.json')}`,
  ]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.planning', 'turbo', 'config.json'), 'utf8')).test.full, prev);
  // the changes list named the same command
  const again = project({ gsdConfig: { workflow: { test_command: prev } } });
  assert.equal(initChanges(again.root, { core: again.core }).find((c) => c.kind === 'test-command').value, prev);
});

test('initProject keeps GSD\'s runtime files out of git status through the checkout\'s exclude, once, with a line; outside git nothing (v0.5.1)', () => {
  const { root, core } = project();
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  const lines = [];
  initProject(root, { core, out: (l) => lines.push(l), inherit: false });
  const exclude = path.resolve(root, git('rev-parse', '--git-path', 'info/exclude'));
  assert.ok(lines.includes(`GSD's runtime files (.planning/state.json, milestone.lock and its locks) kept out of git status: ${exclude}`), lines.join('\n'));
  assert.match(lines.at(-1), /^created /);
  for (const f of ['state.json', 'milestone.lock', 'STATE.md.lock', 'WAITING.json']) fs.writeFileSync(path.join(root, '.planning', f), '{}\n');
  assert.equal(git('status', '--porcelain', '--untracked-files=all', '--', '.planning/state.json', '.planning/milestone.lock', '.planning/STATE.md.lock', '.planning/WAITING.json'), '');
  const again = [];
  initProject(root, { core, out: (l) => again.push(l), inherit: false });
  assert.ok(!again.some((l) => l.startsWith("GSD's runtime files")), again.join('\n'));
  assert.equal(fs.readFileSync(exclude, 'utf8').split('# gsd-turbo: GSD runtime files: begin').length, 2);
  // a project below the repository's top: its own .planning paths
  const top = tmpDir('init-top');
  execFileSync('git', ['init', '-q'], { cwd: top });
  const sub = path.join(top, 'app');
  fs.mkdirSync(path.join(sub, '.planning'), { recursive: true });
  initProject(sub, { core: fakeGsdCore(sub), inherit: false });
  assert.match(fs.readFileSync(path.join(top, '.git', 'info', 'exclude'), 'utf8'), /^\/app\/\.planning\/state\.json$/m);
});

test('initProject stops with InitAborted when GSD cannot read its test command; nothing is written', () => {
  const { root, core } = project();
  fs.writeFileSync(path.join(core, 'bin', 'gsd-tools.cjs'), 'process.stderr.write("broken\\n"); process.exit(1);\n');
  assert.throws(() => initProject(root, { core, inherit: false }), (e) => e instanceof InitAborted && /^init aborted: gsd-tools config-get workflow\.test_command failed \(exit status 1\): broken; nothing was changed$/.test(e.message));
  assert.throws(() => initChanges(root, { core }), InitAborted);
  assert.equal(fs.existsSync(path.join(root, '.planning', 'turbo')), false);
});

test('initProject calls the lean function after its own setup when lean.enabled, prints its lines, and only warns when it fails', () => {
  const { root, core } = project();
  const calls = [];
  const lines = [];
  const lean = (o) => {
    calls.push({ ...o, gsd: gsdConfigOf(root) });
    return { changed: [{ key: 'workflow.nyquist_validation', from: ABSENT, to: 'false' }], enabled: null, effort: null, paths: [], commit: null };
  };
  assert.equal(initProject(root, { core, out: (l) => lines.push(l), inherit: false, lean }), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].root, calls[0].core, calls[0].commit, typeof calls[0].exec], [root, core, false, 'function']);
  // after init's own config-set calls
  assert.equal(calls[0].gsd.workflow.test_command, TURBO_TEST_CMD);
  assert.equal(calls[0].gsd.context_window, 1000000);
  assert.deepEqual(lines.slice(-3), ['lean: workflow.nyquist_validation absent → false', 'lean: previous values in .planning/turbo/lean-prev.json', `created ${path.join(root, '.planning', 'turbo', 'config.json')}`]);
  // lean off in the turbo config: not called
  const off = project();
  fs.mkdirSync(path.join(off.root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(off.root, '.planning', 'turbo', 'config.json'), JSON.stringify({ lean: { enabled: false } }));
  let called = false;
  initProject(off.root, { core: off.core, inherit: false, lean: () => { called = true; } });
  assert.equal(called, false);
  // without GSD (no core): not called either
  const none = project();
  initProject(none.root, { core: null, inherit: false, lean: () => { called = true; } });
  assert.equal(called, false);
  // a lean that throws: a warning, init still succeeds
  const bad = project();
  const out = [];
  assert.equal(initProject(bad.root, { core: bad.core, out: (l) => out.push(l), inherit: false, lean: () => { throw new Error('boom\nmore'); } }), 0);
  assert.ok(out.includes('warn: lean mode not applied: boom; run turbo-run lean apply'), out.join('\n'));
  assert.match(out.at(-1), /^created /);
});
