import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(test|tests|__tests__)\/.+\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
const CONFIG_RE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|tsconfig[^/]*\.json|\.nvmrc|pyproject\.toml|requirements[^/]*\.txt)$|(^|\/)[^/]+\.config\.[cm]?[jt]s$/;
const DOC_RE = /(\.md$)|(^docs\/)|(^\.planning\/)/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const isTestFile = (f) => TEST_RE.test(f.replace(/\\/g, '/'));

export function classifyScript(script = '') {
  const s = String(script).trim();
  const m = /^node\s+((?:--[\w-]+(?:=\S+)?\s+)*)--test\b/.exec(s);
  if (m) return { kind: 'node-test', prefix: m[1].trim() ? m[1].trim().split(/\s+/).filter((x) => x !== '--test') : [] };
  if (/(^|\s|\/)jest(\s|$)/.test(s)) return { kind: 'jest' };
  if (/(^|\s|\/)vitest(\s|$)/.test(s)) return { kind: 'vitest' };
  if (/(^|\s)(python -m )?pytest(\s|$)/.test(s)) return { kind: 'pytest' };
  return { kind: 'unknown' };
}

export function relatedTests(changed, testFiles, readFile) {
  const out = new Set();
  for (const c of changed) {
    if (testFiles.includes(c)) { out.add(c); continue; }
    const stem = path.posix.basename(c).replace(/\.[^.]+$/, '');
    if (!stem) continue;
    const re = new RegExp(`['"\`][^'"\`]*\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[cm]?[jt]sx?)?['"\`]`);
    for (const t of testFiles) {
      const src = readFile(t);
      if (src && re.test(src)) out.add(t);
    }
  }
  return [...out].sort();
}

const pkgOf = (file, packages) => packages
  .filter((p) => p.dir === '' || file === p.dir || file.startsWith(p.dir + '/'))
  .sort((a, b) => b.dir.length - a.dir.length)[0];

const fullPlan = (reason, fullCommand) => ({ mode: 'full', reason, groups: [{ cwd: '', cmd: fullCommand, args: [], shell: true }] });

export function planRun({ changed, testFiles, packages, readFile, marker, head, forceFull, fullCommand }) {
  const full = (reason) => fullPlan(reason, fullCommand);
  if (forceFull) return full('TURBO_FULL=1');
  if (!marker) return full('no previous green run');
  if (changed.some((f) => CONFIG_RE.test(f))) return full('dependency or config file changed');
  if (!changed.length) return marker.sha === head && marker.full ? { mode: 'skip', reason: 'already fully green at HEAD', groups: [] } : full('no changes since a targeted green run');
  if (changed.every((f) => DOC_RE.test(f))) return { mode: 'skip', reason: 'docs-only change', groups: [] };
  const tests = relatedTests(changed, testFiles, readFile);
  const code = changed.filter((f) => !DOC_RE.test(f) && !isTestFile(f));
  const covered = code.every((f) => tests.some((t) => relatedTests([f], [t], readFile).length));
  if (!tests.length || !covered) return full('changed code without related tests');
  const byPkg = new Map();
  for (const t of tests) {
    const p = pkgOf(t, packages);
    if (!p) return full(`no package for ${t}`);
    const k = classifyScript(p.testScript);
    if (k.kind === 'unknown') return full(`unknown test runner in ${p.dir || 'root'}`);
    if (!byPkg.has(p.dir)) byPkg.set(p.dir, { k, files: [] });
    byPkg.get(p.dir).files.push(p.dir ? t.slice(p.dir.length + 1) : t);
  }
  const groups = [...byPkg.entries()].map(([dir, { k, files }]) => {
    if (k.kind === 'node-test') return { cwd: dir, cmd: process.execPath, args: [...k.prefix, '--test', ...files], shell: false };
    if (k.kind === 'jest') return { cwd: dir, cmd: 'npx', args: ['jest', '--findRelatedTests', ...files], shell: true };
    if (k.kind === 'vitest') return { cwd: dir, cmd: 'npx', args: ['vitest', 'run', ...files], shell: true };
    return { cwd: dir, cmd: 'python', args: ['-m', 'pytest', ...files], shell: false };
  });
  return { mode: 'targeted', reason: `${tests.length} related test file(s)`, groups };
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const lines = (s) => s.split('\n').filter(Boolean);

// A nested `node --test` that inherits NODE_TEST_CONTEXT skips every file and exits 0.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runGroup(g, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(g.cmd, g.args, { cwd, env, stdio: 'inherit', shell: g.shell, windowsHide: true });
    child.on('error', (e) => {
      process.stderr.write(`[turbo-test] cannot run ${g.cmd}: ${e.code || e.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function runTestChanged({ root, env = process.env, log = (l) => process.stdout.write(`[turbo-test] ${l}\n`) }) {
  const cfg = loadConfig(root);
  const fullCommand = String(cfg.test?.full ?? '').trim();
  const forceFull = env.TURBO_FULL === '1';
  let head = null;
  try { head = git(root, ['rev-parse', 'HEAD']); } catch { /* not a repository, no commit yet, or no git */ }

  let plan;
  let markerPath = null;
  if (!head) {
    plan = fullPlan('not a git repository', fullCommand);
  } else {
    markerPath = path.resolve(root, git(root, ['rev-parse', '--git-path', 'turbo-last-green']));
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']) !== '';
    let marker = readJson(markerPath, null);
    if (!SHA_RE.test(marker?.sha)) marker = null;
    let changed = [];
    if (marker && !dirty) {
      // --relative: same root-relative paths as ls-files when root is below the repo top level
      try { changed = lines(git(root, ['diff', '--name-only', '--relative', marker.sha, 'HEAD'])); } catch { marker = null; }
    }
    if (dirty && !forceFull) {
      plan = fullPlan('uncommitted changes in tracked files', fullCommand);
    } else {
      const all = lines(git(root, ['ls-files']));
      const packages = all.filter((f) => path.posix.basename(f) === 'package.json' && !f.includes('node_modules/'))
        .map((f) => ({ dir: path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f), testScript: readJson(path.join(root, f), {})?.scripts?.test || '' }));
      if (!packages.length) packages.push({ dir: '', testScript: fs.existsSync(path.join(root, 'pyproject.toml')) ? 'pytest' : '' });
      plan = planRun({
        changed, testFiles: all.filter(isTestFile), packages,
        readFile: (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } },
        marker, head, forceFull, fullCommand,
      });
    }
    // a run on a dirty tree proves nothing about HEAD
    if (dirty) markerPath = null;
  }

  log(`${plan.mode}: ${plan.reason}`);
  if (plan.mode === 'full' && !fullCommand) {
    process.stderr.write('[turbo-test] test.full is empty in .planning/turbo/config.json\n');
    return 1;
  }
  const cenv = childEnv();
  for (const g of plan.groups) {
    const code = await runGroup(g, path.join(root, g.cwd), cenv);
    if (code !== 0) return code;
  }
  if (markerPath && plan.mode !== 'skip') writeJsonAtomic(markerPath, { sha: head, full: plan.mode === 'full' });
  return 0;
}
