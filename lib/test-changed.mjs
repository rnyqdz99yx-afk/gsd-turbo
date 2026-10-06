import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DEFAULTS, loadConfig } from './config.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

// Targeted mode is safe by construction: anything ambiguous runs the full command.
// A false red is acceptable; a false green is a defect.

const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(test|tests|__tests__)\/.+\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
// Tests by name. A file that is a test only by directory runs as a test when no candidate imports
// it by path (a leaf); otherwise it is a support file and runs only through its importers.
const RUNNABLE_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
const JS_EXT_RE = /\.[cm]?[jt]sx?$/;
// Files read to find who imports (or mentions) a changed file.
const SOURCE_RE = /\.([cm]?[jt]sx?|vue|svelte)$/;
const CONFIG_RE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|tsconfig[^/]*\.json|\.nvmrc|pyproject\.toml|requirements[^/]*\.txt)$|(^|\/)[^/]+\.config\.[cm]?[jt]s$|^\.planning\/turbo\/config\.json$/;
// Docs are exempt from the coverage requirement; the tests that mention them still run.
const DOC_RE = /(\.md$)|(^docs\/)|(^\.planning\/)/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// test.full values that run the root package's test script.
const PACKAGE_TEST = new Set(['npm test', 'npm run test', 'pnpm test', 'pnpm run test', 'yarn test', 'yarn run test']);

export const isTestFile = (f) => TEST_RE.test(f.replace(/\\/g, '/'));
export const isRunnableTest = (f) => RUNNABLE_RE.test(f.replace(/\\/g, '/'));

// Shell syntax a targeted run could not mirror: compound commands, redirections, expansions.
const SHELL_SYNTAX_RE = /[;&|<>$`\r\n]/;
const isFlag = (token) => /^['"]*-/.test(token);
// Prefix flags whose effect depends on the set of files run: a subset could pass where the whole fails.
const FILESET_FLAG_RE = /^--(test-shard|test-coverage-(lines|branches|functions))(=|$)/;
const VITEST_SUBCOMMANDS = new Set(['watch', 'dev', 'related', 'bench', 'init', 'list', 'typecheck']);

// Targeted runs mirror only bare runner forms: `node [--flags] --test [paths]`, `jest [paths]`,
// `vitest [run] [paths]`. Env assignments, wrappers and any other flag make the script unknown.
export function classifyScript(script = '') {
  const s = String(script).trim();
  if (SHELL_SYNTAX_RE.test(s)) return { kind: 'unknown' };
  const [cmd, ...rest] = s.split(/\s+/);
  if (cmd === 'node') {
    const i = rest.indexOf('--test');
    if (i < 0) return { kind: 'unknown' };
    const prefix = rest.slice(0, i);
    const carried = prefix.every((t) => /^--[\w-]+(=\S+)?$/.test(t) && !FILESET_FLAG_RE.test(t));
    return carried && !rest.slice(i + 1).some(isFlag) ? { kind: 'node-test', prefix } : { kind: 'unknown' };
  }
  if (cmd === 'jest' && !rest.some(isFlag)) return { kind: 'jest' };
  if (cmd === 'vitest' && !VITEST_SUBCOMMANDS.has(rest[0]) && !(rest[0] === 'run' ? rest.slice(1) : rest).some(isFlag)) return { kind: 'vitest' };
  if (/(^|\s)(python -m )?pytest(\s|$)/.test(s)) return { kind: 'pytest' };
  return { kind: 'unknown' };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A quoted string that ends in the file's stem plus any extension, e.g. '../src/a.js',
// "./helpers/h", '.planning/STATE.md'. The word start is Unicode-aware (\b only knows ASCII).
function mention(file) {
  const base = path.posix.basename(file);
  const stems = [base.replace(/\.[^.]+$/, '') || base];
  // a directory import ('../lib') resolves to lib/index.*
  const dir = path.posix.basename(path.posix.dirname(file));
  if (stems[0] === 'index' && dir && dir !== '.') stems.push(dir);
  const re = new RegExp(`['"\`][^'"\`]*(?<![\\p{L}\\p{N}_$])(?:${stems.map(escRe).join('|')})(\\.[\\w.-]+)?['"\`]`, 'u');
  return (src) => Boolean(src) && stems.some((s) => src.includes(s)) && re.test(src);
}

// reach(file) = the file plus every candidate that mentions it, directly or through other
// candidates (transitive importers).
function dependents(candidates, readFile) {
  const importers = new Map();
  const importersOf = (x) => {
    if (!importers.has(x)) {
      const hit = mention(x);
      importers.set(x, candidates.filter((f) => f !== x && hit(readFile(f))));
    }
    return importers.get(x);
  };
  return (start) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      for (const f of importersOf(queue.shift())) if (!seen.has(f)) { seen.add(f); queue.push(f); }
    }
    return seen;
  };
}

// isImported(f): does another candidate import f by a relative path ('./x', '../y/f.js', './dir/')?
// The stem mention above also matches every file with the same base name, so it cannot tell a
// support file from a test; when unsure this answers "no", and the file then runs as a test.
// Bare '.' and '..' are left out: as plain strings (split('.')) they are far more common than imports.
function importedByPath(candidates, readFile) {
  let importers = null; // resolved path without JS extension -> importing files
  const build = () => {
    importers = new Map();
    for (const f of candidates) {
      for (const m of String(readFile(f) ?? '').matchAll(/['"`](\.\.?\/[^'"`\n]+)['"`]/g)) {
        const key = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])).replace(/\/$/, '').replace(JS_EXT_RE, '');
        if (!importers.has(key)) importers.set(key, new Set());
        importers.get(key).add(f);
      }
    }
  };
  return (f) => {
    if (!importers) build();
    const keys = [f.replace(JS_EXT_RE, '')];
    if (/^index\./.test(path.posix.basename(f))) keys.push(path.posix.dirname(f));
    return keys.some((k) => [...(importers.get(k) ?? [])].some((x) => x !== f));
  };
}

// Changed files that are in `files`, plus every file in `files` that depends on a changed file.
export function relatedTests(changed, files, readFile) {
  const inFiles = new Set(files);
  const reach = dependents(files, readFile);
  const out = new Set();
  for (const c of changed) for (const f of reach(c)) if (inFiles.has(f)) out.add(f);
  return [...out].sort();
}

const pkgOf = (file, packages) => packages
  .filter((p) => p.dir === '' || file === p.dir || file.startsWith(p.dir + '/'))
  .sort((a, b) => b.dir.length - a.dir.length)[0];

// POSIX single quotes: the only character that needs care inside them is the quote itself.
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const bashGroup = (cwd, words, files) => ({ cwd, cmd: 'bash', args: ['-c', [...words, ...files.map(shq)].join(' ')], shell: false });

const fullPlan = (reason, fullCommand) => ({ mode: 'full', reason, groups: [{ cwd: '', cmd: fullCommand, args: [], shell: true }] });

export function planRun({ changed, testFiles, sourceFiles = [], packages, readFile, marker, head, forceFull, fullCommand, maxTargeted = DEFAULTS.test.max_targeted }) {
  const full = (reason) => fullPlan(reason, fullCommand);
  if (forceFull) return full('TURBO_FULL=1');
  if (!marker) return full('no previous full green run');
  if (!changed.length) return { mode: 'skip', reason: marker.fullSha === head ? 'already fully green at HEAD' : 'no file changes since the last full green run', groups: [] };
  if (changed.some((f) => CONFIG_RE.test(f))) return full('dependency or config file changed');
  if (marker.targetedSince >= maxTargeted) return full(`${marker.targetedSince} targeted run(s) since the last full run (max_targeted ${maxTargeted})`);
  const root = packages.find((p) => p.dir === '');
  const rootScript = String(root?.testScript ?? '').trim();
  if (!PACKAGE_TEST.has(fullCommand) && fullCommand !== rootScript) return full('test.full is not the package test script');
  // The full command runs the root script, plus its pre/post hooks under npm and yarn v1.
  const rootKind = classifyScript(rootScript).kind;
  if (rootKind === 'pytest') return full('pytest projects run the full suite');
  if (rootKind === 'unknown') return full('unknown test runner in root');
  if (root.hooks?.length) return full(`root package.json has a ${root.hooks.join('/')} script`);

  const candidates = [...new Set([...testFiles, ...sourceFiles])];
  const tracked = new Set(candidates);
  const reach = dependents(candidates, readFile);
  const isImported = importedByPath(candidates, readFile);
  const runnable = (f) => tracked.has(f) && (isRunnableTest(f) || (isTestFile(f) && !isImported(f)));
  const tests = new Set();
  for (const c of changed) {
    const hit = [...reach(c)].filter(runnable);
    if (!hit.length && !DOC_RE.test(c)) return full(`no related test for ${c}`);
    for (const t of hit) tests.add(t);
  }

  const byPkg = new Map();
  for (const t of [...tests].sort()) {
    const p = pkgOf(t, packages);
    if (!p) return full(`no package for ${t}`);
    const k = classifyScript(p.testScript);
    if (k.kind === 'pytest') return full('pytest projects run the full suite');
    if (k.kind === 'unknown') return full(`unknown test runner in ${p.dir || 'root'}`);
    const rel = p.dir ? t.slice(p.dir.length + 1) : t;
    // node --test runs any file it is given; jest matches __tests__/** by default; vitest only *.test.*/*.spec.*
    if (!isRunnableTest(t) && k.kind !== 'node-test' && !(k.kind === 'jest' && /(^|\/)__tests__\//.test(rel))) {
      return full(`${t} is a test only by directory, outside the ${k.kind} default test match`);
    }
    if (!byPkg.has(p.dir)) byPkg.set(p.dir, { k, files: [] });
    byPkg.get(p.dir).files.push(rel);
  }
  const groups = [...byPkg.entries()].map(([dir, { k, files }]) => {
    if (k.kind === 'node-test') return { cwd: dir, cmd: process.execPath, args: [...k.prefix, '--test', ...files], shell: false };
    if (k.kind === 'jest') return bashGroup(dir, ['npx', '--no-install', 'jest', '--findRelatedTests'], files);
    return bashGroup(dir, ['npx', '--no-install', 'vitest', 'run'], files);
  });
  return { mode: 'targeted', reason: tests.size ? `${tests.size} related test file(s)` : 'no test mentions the changed docs', groups };
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const lines = (s) => s.split('\n').filter(Boolean);
// Non-ASCII paths verbatim instead of "\303\274"-quoted; only control characters, `"` and `\` stay quoted.
const UNQUOTED = ['-c', 'core.quotepath=false'];

// A nested `node --test` that inherits NODE_TEST_CONTEXT skips every file and exits 0.
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function spawnWait(cmd, args, opts) {
  return new Promise((resolve) => {
    const o = { ...opts, windowsHide: true };
    const child = args ? spawn(cmd, args, o) : spawn(cmd, o);
    child.on('error', (error) => resolve({ error })); // fires before 'close' on a failed spawn
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });
}

function exitCode(r, cmd) {
  if (!r.error) return r.code;
  process.stderr.write(`[turbo-test] cannot run ${cmd}: ${r.error.code || r.error.message}\n`);
  return 1;
}

// GSD runs workflow.test_command through bash -c, so the preserved test.full may use bash syntax.
async function runFull(cmd, opts, log) {
  let r = await spawnWait('bash', ['-c', cmd], opts);
  if (r.error?.code === 'ENOENT') {
    log('bash not found, using system shell');
    r = await spawnWait(cmd, null, { ...opts, shell: true });
  }
  return exitCode(r, cmd);
}

const validMarker = (m) => (SHA_RE.test(m?.fullSha) && Number.isInteger(m.targetedSince) && m.targetedSince >= 0 ? m : null);

// Marker (per worktree, inside the git dir): the last FULL green run and the number of targeted
// green runs since. The change set is always cumulative from that full run.
export async function runTestChanged({ root, env = process.env, stdio = 'inherit', log = (l) => process.stdout.write(`[turbo-test] ${l}\n`) }) {
  const cfg = loadConfig(root);
  const fullCommand = String(cfg.test?.full ?? '').trim();
  const max = cfg.test?.max_targeted;
  const maxTargeted = Number.isInteger(max) && max >= 0 ? max : DEFAULTS.test.max_targeted;
  const forceFull = env.TURBO_FULL === '1';
  let head = null;
  try { head = git(root, ['rev-parse', 'HEAD']); } catch { /* not a repository, no commit yet, or no git */ }

  let plan;
  let marker = null;
  let markerPath = null;
  if (!head) {
    plan = fullPlan('not a git repository', fullCommand);
  } else {
    markerPath = path.resolve(root, git(root, ['rev-parse', '--git-path', 'turbo-last-green']));
    const status = lines(git(root, ['status', '--porcelain', '--untracked-files=normal']));
    const dirty = status.some((l) => !l.startsWith('??'));
    const untracked = status.some((l) => l.startsWith('??'));
    marker = validMarker(readJson(markerPath, null));
    let changed = [];
    let outside = false;
    if (marker && !dirty && !untracked && !forceFull) {
      try {
        // whole-repo paths (no --relative), so a change outside the project root is seen
        const prefix = git(root, ['rev-parse', '--show-prefix']);
        for (const f of lines(git(root, [...UNQUOTED, 'diff', '--name-only', '--no-renames', '--no-relative', marker.fullSha, 'HEAD']))) {
          if (f.startsWith(prefix)) changed.push(f.slice(prefix.length));
          else outside = true;
        }
      } catch { marker = null; }
    }
    if (dirty && !forceFull) {
      plan = fullPlan('uncommitted changes in tracked files', fullCommand);
    } else if (untracked && !forceFull) {
      // the full command may pick untracked files up (an untracked test, a module it imports)
      plan = fullPlan('untracked files present', fullCommand);
    } else if (outside) {
      plan = fullPlan('changes outside the project root', fullCommand);
    } else {
      const all = lines(git(root, [...UNQUOTED, 'ls-files']));
      const packages = all.filter((f) => path.posix.basename(f) === 'package.json' && !f.includes('node_modules/'))
        .map((f) => {
          const s = readJson(path.join(root, f), {})?.scripts;
          const scripts = s && typeof s === 'object' ? s : {};
          const hooks = ['pretest', 'posttest'].filter((h) => Object.hasOwn(scripts, h));
          return { dir: path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f), testScript: scripts.test || '', hooks };
        });
      if (!packages.length) packages.push({ dir: '', testScript: fs.existsSync(path.join(root, 'pyproject.toml')) ? 'pytest' : '', hooks: [] });
      const cache = new Map();
      const readFile = (f) => {
        if (!cache.has(f)) {
          let s = '';
          try { s = fs.readFileSync(path.join(root, f), 'utf8'); } catch { /* deleted or unreadable */ }
          cache.set(f, s);
        }
        return cache.get(f);
      };
      plan = planRun({
        changed, packages, readFile, marker, head, forceFull, fullCommand, maxTargeted,
        testFiles: all.filter(isTestFile),
        sourceFiles: all.filter((f) => SOURCE_RE.test(f) && !f.includes('node_modules/')),
      });
    }
    // a dirty tree proves nothing about HEAD; untracked files may be part of what passed
    if (dirty || untracked) markerPath = null;
  }

  log(`${plan.mode}: ${plan.reason}`);
  if (plan.mode === 'full' && !fullCommand) {
    process.stderr.write('[turbo-test] test.full is empty in .planning/turbo/config.json\n');
    return 1;
  }
  const cenv = childEnv();
  for (const g of plan.groups) {
    const opts = { cwd: path.join(root, g.cwd), env: cenv, stdio };
    const code = plan.mode === 'full' ? await runFull(g.cmd, opts, log) : exitCode(await spawnWait(g.cmd, g.args, opts), g.cmd);
    if (code !== 0) return code;
  }
  if (markerPath && plan.mode === 'full') writeJsonAtomic(markerPath, { fullSha: head, targetedSince: 0 });
  if (markerPath && plan.mode === 'targeted') writeJsonAtomic(markerPath, { fullSha: marker.fullSha, targetedSince: marker.targetedSince + 1 });
  return 0;
}
