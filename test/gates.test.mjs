import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './helpers/tmp.mjs';
import { ABSENT, GATE_KEYS, gatesRel, createGsdConfig, gatesOff, gatesRestore, gatesActive, docsCommitsOff, docsCommitsRestore, ensureChunkedParallel, sameConfig } from '../lib/gates.mjs';

const git = (root, ...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const cfgPath = (root) => path.join(root, '.planning', 'config.json');

// Behaves like gsd-tools config-get/config-set on .planning/config.json (G7), including the rewrite format.
function fakeCfg(root, active = ['nyquist', 'security', 'ui', 'code-review']) {
  const load = () => JSON.parse(fs.readFileSync(cfgPath(root), 'utf8'));
  const at = (o, k) => k.split('.').reduce((x, s) => (x && typeof x === 'object' && Object.hasOwn(x, s) ? x[s] : undefined), o);
  return {
    get(k) {
      const v = at(load(), k);
      return v === undefined ? ABSENT : typeof v === 'string' ? v : JSON.stringify(v);
    },
    set(k, raw) {
      const c = load();
      const parts = k.split('.');
      let cur = c;
      for (const s of parts.slice(0, -1)) cur = cur[s] && typeof cur[s] === 'object' ? cur[s] : (cur[s] = {});
      if (raw === 'null') delete cur[parts.at(-1)];
      else cur[parts.at(-1)] = raw === 'true' ? true : raw === 'false' ? false : raw;
      fs.writeFileSync(cfgPath(root), JSON.stringify(c, null, 2));
    },
    activeCaps: () => active,
  };
}

// Byte-exact assertions: a global core.autocrlf=true (common on Windows) must not rewrite line ends.
function repo() {
  const root = tmpGitRepo();
  git(root, 'config', 'core.autocrlf', 'false');
  return root;
}

function project(text) {
  const root = repo();
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', '.gitignore'), 'run/\nlogs/\nlocks/\n'); // as turbo-run init writes it
  fs.writeFileSync(cfgPath(root), text);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'config');
  return root;
}

test('gates off commits config + state; restore brings back the exact bytes, removes the state, keeps the active list', () => {
  const original = '{\n  "workflow": {\n    "code_review": true,\n    "ui_review": false\n  }\n}\n';
  const root = project(original);
  const cfg = fakeCfg(root, ['security', 'code-review']);
  assert.equal(gatesActive(root, '3'), null);
  const off = gatesOff({ root, phase: '3', cfg });
  assert.equal(off.changed, true);
  assert.equal(off.commit.committed, true);
  assert.deepEqual(off.state.active, ['security', 'code-review']);
  assert.equal(off.state.original[GATE_KEYS.nyquist], ABSENT);
  assert.equal(off.state.original[GATE_KEYS.ui], 'false');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath(root), 'utf8')).workflow, { code_review: false, ui_review: false, nyquist_validation: false, security_enforcement: false });
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.deepEqual(gatesActive(root, '3'), ['security', 'code-review']);
  assert.equal(gatesOff({ root, phase: '3', cfg }).changed, false, 'idempotent');
  cfg.set('workflow._auto_chain_active', 'false'); // GSD's execute-phase writes this key itself
  const back = gatesRestore({ root, phase: '3', cfg });
  assert.equal(back.changed, true);
  assert.equal(fs.readFileSync(cfgPath(root), 'utf8'), original);
  assert.ok(!fs.existsSync(path.join(root, gatesRel('3'))));
  assert.deepEqual(gatesActive(root, '3'), ['security', 'code-review'], 'the fan-out after the restore still knows the active gates');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.deepEqual(git(root, 'log', '-2', '--format=%s').split('\n'), ['chore(turbo): phase 3 built-in gates restored', 'chore(turbo): phase 3 built-in gates off while GSD executes']);
  assert.equal(gatesRestore({ root, phase: '3', cfg }).changed, false, 'idempotent');
});

test('gates off again retries the commit an interrupted run left undone', () => {
  const root = project('{}\n');
  const cfg = fakeCfg(root);
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'gates'), { recursive: true });
  fs.writeFileSync(path.join(root, gatesRel('3')), JSON.stringify({ phase: '3', active: ['security'] }));
  cfg.set(GATE_KEYS.security, 'false');
  const again = gatesOff({ root, phase: '3', cfg });
  assert.deepEqual([again.changed, again.commit.committed], [false, true]);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('a git-ignored or untracked .planning/config.json: toggles work, nothing is committed, nothing fails', () => {
  const root = repo();
  fs.writeFileSync(path.join(root, '.gitignore'), '.planning/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'ignore planning');
  fs.mkdirSync(path.join(root, '.planning'));
  fs.writeFileSync(cfgPath(root), '{}');
  const cfg = fakeCfg(root);
  const off = gatesOff({ root, phase: '3', cfg });
  assert.equal(off.commit.committed, false);
  assert.equal(gatesRestore({ root, phase: '3', cfg }).changed, true);
  assert.ok(sameConfig(JSON.parse(fs.readFileSync(cfgPath(root), 'utf8')), {}));
  assert.equal(git(root, 'status', '--porcelain'), '');

  const loose = repo(); // .planning/config.json exists, is not ignored, and git does not track it
  fs.mkdirSync(path.join(loose, '.planning'));
  fs.writeFileSync(cfgPath(loose), '{}');
  const looseCfg = fakeCfg(loose);
  const head = git(loose, 'rev-parse', 'HEAD');
  assert.deepEqual(gatesOff({ root: loose, phase: '3', cfg: looseCfg }).commit, { committed: false, reason: 'config not tracked' });
  assert.equal(gatesRestore({ root: loose, phase: '3', cfg: looseCfg }).commit.committed, false);
  assert.equal(ensureChunkedParallel({ root: loose, cfg: looseCfg }).commit.committed, false);
  assert.equal(git(loose, 'rev-parse', 'HEAD'), head);
  assert.equal(git(loose, 'ls-files', '--', '.planning'), '');
});

test('sameConfig: empty objects and GSD\'s own workflow._auto_chain_active false mean the same configuration', () => {
  assert.ok(sameConfig({ workflow: {} }, {}));
  assert.ok(sameConfig({ workflow: { _auto_chain_active: false, code_review: true } }, { workflow: { code_review: true } }));
  assert.ok(sameConfig({ workflow: { _auto_chain_active: false } }, {}));
  assert.ok(!sameConfig({ workflow: { _auto_chain_active: true } }, {}));
  assert.ok(!sameConfig({ workflow: { code_review: false } }, { workflow: { code_review: true } }));
});

test('docs commits off/restore for one phase leaves the committed config untouched', () => {
  const original = '{\n  "commit_docs": true\n}\n';
  const root = project(original);
  const cfg = fakeCfg(root);
  assert.equal(docsCommitsOff({ root, phase: '3', cfg }).changed, true);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath(root), 'utf8')).phase_commit_docs['3'], false);
  assert.equal(docsCommitsOff({ root, phase: '3', cfg }).changed, false);
  assert.equal(docsCommitsRestore({ root, phase: '3', cfg }).changed, true);
  assert.equal(fs.readFileSync(cfgPath(root), 'utf8'), original);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('ensureChunkedParallel sets the key only when absent and respects an explicit false', () => {
  const root = project('{}\n');
  const cfg = fakeCfg(root);
  const first = ensureChunkedParallel({ root, cfg });
  assert.deepEqual([first.changed, first.value, first.commit.committed], [true, true, true]);
  assert.equal(ensureChunkedParallel({ root, cfg }).changed, false);
  cfg.set('planning.chunked_parallel', 'false');
  const off = ensureChunkedParallel({ root, cfg });
  assert.deepEqual([off.changed, off.value], [false, false]);
  assert.match(off.note, /set to false/);
});

test('createGsdConfig calls gsd-tools with argument arrays, a sentinel default and a timeout', () => {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return args.includes('render-hooks') ? JSON.stringify({ activeHooks: [{ kind: 'step', capId: 'security' }, { kind: 'gate', capId: 'nyquist' }] }) : 'true\n';
  };
  const cfg = createGsdConfig({ root: '/p', core: '/core', exec });
  assert.equal(cfg.get('workflow.code_review'), 'true');
  cfg.set('workflow.code_review', 'false');
  assert.deepEqual(cfg.activeCaps(), ['security']);
  assert.deepEqual(calls[0].args.slice(1), ['config-get', 'workflow.code_review', '--default', ABSENT, '--raw', '--cwd', '/p']);
  assert.deepEqual(calls[1].args.slice(1), ['config-set', 'workflow.code_review', 'false', '--cwd', '/p']);
  assert.equal(calls[0].opts.timeout, 30000);
  assert.ok(calls.every((c) => c.cmd === process.execPath && c.args[0] === path.join('/core', 'bin', 'gsd-tools.cjs')));
  const broken = createGsdConfig({ root: '/p', core: '/core', exec: () => { throw new Error('boom'); } });
  assert.deepEqual(broken.activeCaps(), ['nyquist', 'security', 'ui', 'code-review']);
});
