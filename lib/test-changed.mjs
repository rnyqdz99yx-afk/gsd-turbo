import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import nodeModule from 'node:module';
import { DEFAULTS, loadConfig, fullEntries } from './config.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { collectGraph, graphEnv, testsLoading } from './import-graph.mjs';
import { phaseEndState } from './phase-progress.mjs';

// Targeted mode is safe by construction: anything ambiguous runs the full command.
// A false red is acceptable; a false green is a defect.

const TEST_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)test(-[^/]*)?\.[cm]?[jt]sx?$|[-_]test\.[cm]?[jt]sx?$|(^|\/)(test|tests|__tests__)\/.+\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
// Tests by name: *.test.*, *.spec.* and node's default names (test.*, test-*.*, *-test.*, *_test.*). A file that
// is a test only by directory runs as a test when no test imports it by path (a leaf); otherwise it is a support
// file and runs only through its importers.
const RUNNABLE_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)test(-[^/]*)?\.[cm]?[jt]sx?$|[-_]test\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$/;
// *.test.* and *.spec.*: tests under any runner, and all that vitest runs by default.
const NAMED_TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
// What jest runs by default (testMatch of jest 29; no .mjs/.cjs): the gate a selected test must pass.
const JEST_RE = /(^|\/)__tests__\/.+\.[jt]sx?$|(^|[/.])(test|spec)\.[jt]sx?$/;
// What jest 30 runs by default (testMatch adds .mjs/.cjs): used to select tests, so one that only jest 30
// runs is never left out silently; the narrow gate above then makes the run full.
const JEST_WIDE_RE = /(^|\/)__tests__\/.+\.[mc]?[jt]sx?$|(^|[/.])(test|spec)\.[mc]?[jt]sx?$/;
const NODE_TEST_RE = /['"`]node:test['"`]/;
// Node 22+ reads a `node --test` path argument as a glob: `test/[id].test.js` would match nothing and pass.
const GLOB_RE = /[*?[\]{}()!+@]/;
const JS_EXT_RE = /\.[cm]?[jt]sx?$/;
// Files read to find who imports (or mentions) a changed file.
const SOURCE_RE = /\.([cm]?[jt]sx?|vue|svelte)$/;
const CONFIG_RE = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|tsconfig[^/]*\.json|\.nvmrc|pyproject\.toml|requirements[^/]*\.txt)$|(^|\/)[^/]+\.config\.[cm]?[jt]s$|^\.planning\/turbo\/config\.json$/;
// Docs are exempt from the coverage requirement; the tests that mention them still run. A source under
// docs/ or .planning/ (docs/examples/basic.js) is a candidate others reach, so it needs coverage like any source.
const DOC_RE = /(\.md$)|(^docs\/)|(^\.planning\/)/;
const isDoc = (f) => DOC_RE.test(f) && !SOURCE_RE.test(f);
// Root files jest and vitest read their config from (package.json "jest" is added separately).
const RUNNER_CONFIG_FILE_RE = /^(jest|vitest|vite)\.config\.[^/]+$|^vitest\.(workspace|projects)\.[^/]+$/;
// Runner config under which a subset can pass where the whole run fails: coverage thresholds, type checking,
// which files are tests, state shared between files.
const RUNNER_CONFIG_RE = /\w*(threshold|typecheck)\w*|\b(testMatch|testRegex|testPathIgnorePatterns|roots|projects|workspace|includeSource|include|exclude|dir|root|isolate|shard)\b/i;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// test.full values that run the root package's test script.
const PACKAGE_TEST = new Set(['npm test', 'npm run test', 'pnpm test', 'pnpm run test', 'yarn test', 'yarn run test']);

export const isTestFile = (f) => TEST_RE.test(f.replace(/\\/g, '/'));
export const isRunnableTest = (f) => RUNNABLE_RE.test(f.replace(/\\/g, '/'));

// Shell syntax a targeted run could not mirror: compound commands, redirections, expansions, escapes,
// brace words (`{--test-coverage-lines=90,}` expands into a flag the targeted run never sees).
const SHELL_SYNTAX_RE = /[;&|<>$`\\{}\r\n]/;
const isFlag = (token) => /^['"]*-/.test(token);
// Prefix flags whose effect depends on the set of files run: a subset could pass where the whole fails.
const FILESET_FLAG_RE = /^--(test-shard|test-coverage-(lines|branches|functions)|(experimental-)?test-isolation)(=|$)/;
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
    // quotes and braces would reach the targeted spawn verbatim; only the shell strips or expands them
    const carried = prefix.every((t) => /^--[\w-]+(=[^\s'"\\{}]+)?$/.test(t) && !FILESET_FLAG_RE.test(t));
    return carried && !rest.slice(i + 1).some(isFlag) ? { kind: 'node-test', prefix } : { kind: 'unknown' };
  }
  if (cmd === 'jest' && !rest.some(isFlag)) return { kind: 'jest' };
  if (cmd === 'vitest' && !VITEST_SUBCOMMANDS.has(rest[0]) && !(rest[0] === 'run' ? rest.slice(1) : rest).some(isFlag)) return { kind: 'vitest' };
  if (/(^|\s)(python -m )?pytest(\s|$)/.test(s)) return { kind: 'pytest' };
  return { kind: 'unknown' };
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A quoted string that ends in the file's stem plus any extension, e.g. '../src/a.js', "./helpers/h",
// '.planning/STATE.md'. The word start is Unicode-aware (\b only knows ASCII). A doc is also read by a
// directory it is in ('.claude/rules', 'docs/') or by its extension ('**/*.md', '.md'). Docs need no
// coverage, so these matches only add tests; any other file is covered only by a test that names it.
// `stem: false, location: true`: only the directory and extension checks, for a source under docs/.
function mention(file, { stem = true, location = isDoc(file) } = {}) {
  const base = path.posix.basename(file);
  const stems = [base.replace(/\.[^.]+$/, '') || base];
  const dir = path.posix.dirname(file);
  // a directory import ('../lib') resolves to lib/index.*
  if (stems[0] === 'index' && dir !== '.') stems.push(path.posix.basename(dir));
  const word = (words, tail) => new RegExp(`['"\`][^'"\`]*(?<![\\p{L}\\p{N}_$])(?:${words.map(escRe).join('|')})${tail}['"\`]`, 'u');
  const checks = stem ? [[stems, word(stems, '(\\.[\\w.-]+)?')]] : [];
  if (location) {
    const dirs = dir === '.' ? [] : dir.split('/');
    const ext = path.posix.extname(base);
    if (dirs.length) checks.push([dirs, word(dirs, '\\/?')]);
    if (ext) checks.push([[ext], new RegExp(`['"\`](?:[^'"\`]*[*/])?${escRe(ext)}['"\`]`)]);
  }
  return (src) => Boolean(src) && checks.some(([words, re]) => words.some((w) => src.includes(w)) && re.test(src));
}

// reach(file) = the file plus every candidate that mentions it or imports its directory, directly or
// through other candidates (transitive importers). A directory import ('..', '../', './lib/') resolves to
// D/index.*, and the project root also to package.json "main".
function dependents(candidates, readFile, main = '') {
  const mainKey = main ? path.posix.normalize(main).replace(/^\.\//, '').replace(/\/$/, '').replace(JS_EXT_RE, '') : '';
  const dirKeys = (x) => {
    const keys = /^index\./.test(path.posix.basename(x)) ? [path.posix.dirname(x)] : [];
    if (mainKey && mainKey !== '.' && [mainKey, `${mainKey}/index`].includes(x.replace(JS_EXT_RE, ''))) keys.push('.');
    return keys;
  };
  let dirImporters = null; // the directory a relative specifier resolves to -> files that contain it
  const importersByDir = (x) => {
    const keys = dirKeys(x);
    if (!keys.length) return [];
    if (!dirImporters) {
      dirImporters = new Map();
      for (const f of candidates) {
        for (const m of String(readFile(f) ?? '').matchAll(/['"`](\.\.?(?:\/[^'"`\n]*)?)['"`]/g)) {
          const key = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])).replace(/\/$/, '');
          if (!dirImporters.has(key)) dirImporters.set(key, new Set());
          dirImporters.get(key).add(f);
        }
      }
    }
    return keys.flatMap((k) => [...(dirImporters.get(k) ?? [])]);
  };
  const importers = new Map();
  const importersOf = (x) => {
    if (!importers.has(x)) {
      const hit = mention(x);
      importers.set(x, [...new Set([...candidates.filter((f) => hit(readFile(f))), ...importersByDir(x)])].filter((f) => f !== x));
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

// isImported(f): does a test file import f by a relative path ('./x', '../y/f.js', './dir/')?
// The stem mention above also matches every file with the same base name, so it cannot tell a
// support file from a test; when unsure this answers "no", and the file then runs as a test.
// Bare '.' and '..' are left out: as plain strings (split('.')) they are far more common than imports.
function importedByPath(candidates, readFile) {
  let importers = null; // resolved path (the exact file if it exists, else without JS extension) -> importing tests
  const build = () => {
    importers = new Map();
    const known = new Set(candidates);
    for (const f of candidates.filter(isTestFile)) {
      for (const m of String(readFile(f) ?? '').matchAll(/['"`](\.\.?\/[^'"`\n]+)['"`]/g)) {
        const p = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1])).replace(/\/$/, '');
        const key = known.has(p) ? p : p.replace(JS_EXT_RE, ''); // './a.cjs' never means a.mjs; './a.js' may mean a.ts
        if (!importers.has(key)) importers.set(key, new Set());
        importers.get(key).add(f);
      }
    }
  };
  return (f) => {
    if (!importers) build();
    const keys = [f, f.replace(JS_EXT_RE, '')];
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

// A file under a package.json below the project root: the root script may not run it the way that package does.
const inNestedPackage = (file, packages) => packages.some((p) => p.dir !== '' && file.startsWith(p.dir + '/'));

// POSIX single quotes: the only character that needs care inside them is the quote itself.
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const bashGroup = (cwd, words, files) => ({ cwd, cmd: 'bash', args: ['-c', [...words, ...files.map(shq)].join(' ')], shell: false });

const fullPlan = (reason, fullCommand, cwd = '') => ({ mode: 'full', reason, groups: [{ cwd, cmd: fullCommand, args: [], shell: true }] });

// `allFiles`: every path `git ls-files -z` printed, verbatim. A path with `"`, `\`, a control character or
// DEL runs full: logs and runner globs mangle such names. All paths are relative to the package planned; `dir`
// (its project-relative directory, '' for the root) only names it in the reasons.
export function planRun({ changed, testFiles, sourceFiles = [], allFiles = [], packages, readFile, marker, head, forceFull, fullCommand, maxTargeted = DEFAULTS.test.max_targeted, runnerConfig = '', phaseEnd = null, graph = null, dir = '' }) {
  const full = (reason) => fullPlan(reason, fullCommand);
  if (forceFull) return full('TURBO_FULL=1');
  if (!marker) return full('no previous full green run');
  if (!changed.length) return { mode: 'skip', reason: marker.fullSha === head ? 'already fully green at HEAD' : 'no file changes since the last full green run', groups: [] };
  // Every phase ends with a full run: once all plans of the active phase have summaries,
  // the last post-merge gate and GSD's regression gate see the whole suite (spec §4.7).
  if (phaseEnd && changed.some((f) => !DOC_RE.test(f))) return full(`phase ${phaseEnd.phase} end: every plan has a summary`);
  // names git would C-quote (a control character, `"` or `\`): logs and runner globs mangle them
  const unusual = [...changed, ...allFiles].find((f) => /["\\\x00-\x1f\x7f]/.test(f));
  if (unusual) return full(`unusual file name: ${JSON.stringify(unusual).replace(/\x7f/g, '\\u007f')}`);
  if (changed.some((f) => CONFIG_RE.test(f))) return full('dependency or config file changed');
  if (marker.targetedSince >= maxTargeted) return full(`${marker.targetedSince} targeted run(s) since the last full run (max_targeted ${maxTargeted})`);
  const root = packages.find((p) => p.dir === '');
  const rootScript = String(root?.testScript ?? '').trim();
  if (!PACKAGE_TEST.has(fullCommand) && fullCommand !== rootScript) return full('test.full is not the package test script');
  // The full command runs the root script, plus its pre/post hooks under npm and yarn v1.
  const k = classifyScript(rootScript);
  if (k.kind === 'pytest') return full('pytest projects run the full suite');
  if (k.kind === 'unknown') return full(`unknown test runner in ${dir || 'root'}`);
  if (root.hooks?.length) return full(`${dir ? `${dir}/package.json` : 'root package.json'} has a ${root.hooks.join('/')} script`);
  const setting = k.kind === 'node-test' ? null : String(runnerConfig).match(RUNNER_CONFIG_RE);
  if (setting) return full(`${k.kind} config sets ${setting[0]}`);
  // Targeted runs use the root runner only, so every changed file and selected test must be governed by the root.
  if (changed.some((f) => inNestedPackage(f, packages))) return full('changes in a nested package');

  const candidates = [...new Set([...testFiles, ...sourceFiles])];
  const tracked = new Set(candidates);
  const reach = dependents(candidates, readFile, root.main);
  const isImported = importedByPath(candidates, readFile);
  // a test by name is one the root runner runs as a test when given the file
  const byName = { 'node-test': isRunnableTest, jest: (f) => JEST_RE.test(f), vitest: (f) => NAMED_TEST_RE.test(f) }[k.kind];
  // selection reads jest's testMatch widely (jest 30); the gate below reads it narrowly (jest 29)
  const selectByName = k.kind === 'jest' ? (f) => JEST_WIDE_RE.test(f) : byName;
  const runnable = (f) => tracked.has(f) && (selectByName(f) || (isTestFile(f) && !isImported(f)));
  // node --test passes a file without tests, so run alone a fixture or a helper proves nothing
  // (jest and vitest fail such a file)
  const proves = (f) => k.kind !== 'node-test' || NAMED_TEST_RE.test(f) || NODE_TEST_RE.test(readFile(f) ?? '');
  // files a carried prefix flag loads for every test file (--import=, --require=, --env-file=, ...)
  const flagFiles = (k.prefix ?? []).filter((t) => t.includes('='))
    .map((t) => [t.slice(0, t.indexOf('=')), path.posix.normalize(t.slice(t.indexOf('=') + 1)).replace(/^\.\//, '')]);
  const tests = new Set();
  for (const c of changed) {
    const reached = [...reach(c)];
    for (const [flag, file] of flagFiles) {
      const f = reached.find((x) => x === file || x.replace(JS_EXT_RE, '') === file);
      if (f) return full(f === c ? `${c} is loaded by ${flag}` : `${c} reaches ${f}, loaded by ${flag}`);
    }
    const hit = reached.filter(runnable);
    // a changed file must reach a test that proves something: itself only when it is a test by name
    if (!hit.some((t) => (t !== c || byName(c)) && proves(t)) && !isDoc(c)) return full(`no related test for ${c}`);
    // test.import_graph: once the mention rule targets the file, the tests whose recorded graph loads it
    // (through other modules or import aliases) join them. The graph never turns a full run into a targeted
    // one: a child process, a worker or a file read is missing from it.
    if (graph && k.kind === 'node-test' && JS_EXT_RE.test(c)) {
      for (const t of testsLoading(graph, c).filter(runnable)) if (!hit.includes(t)) hit.push(t);
    }
    for (const t of hit) tests.add(t);
    // a source under docs/ or .planning/ is also read by directory or extension (a test that globs
    // docs/examples): those tests run too, for this file only and without counting as its coverage
    if (DOC_RE.test(c) && SOURCE_RE.test(c)) {
      const reads = mention(c, { stem: false, location: true });
      for (const t of candidates) if (runnable(t) && reads(readFile(t))) tests.add(t);
    }
  }

  const files = [...tests].sort();
  for (const t of files) {
    if (inNestedPackage(t, packages)) return full(`${t} is in a nested package`);
    if (k.kind !== 'node-test') {
      // jest matches __tests__/** and *.test.*/*.spec.* by default; vitest only *.test.*/*.spec.*
      if (!byName(t)) return full(`${t} is outside the ${k.kind} default test match`);
    } else if (GLOB_RE.test(t)) {
      return full(`${t} has glob characters node --test would expand`);
    } else if (!byName(t) && !proves(t)) {
      return full(`${t} is a test only by directory and does not import node:test`);
    }
  }
  const group = () => {
    if (k.kind === 'node-test') return { cwd: '', cmd: process.execPath, args: [...k.prefix, '--test', ...files], shell: false };
    if (k.kind === 'jest') return bashGroup('', ['npx', '--no-install', 'jest', '--findRelatedTests'], files);
    return bashGroup('', ['npx', '--no-install', 'vitest', 'run'], files);
  };
  return { mode: 'targeted', reason: files.length ? `${files.length} related test file(s)` : 'no test mentions the changed docs', groups: files.length ? [group()] : [] };
}

// --- test.full as a list of entries ------------------------------------------------------------

const within = (f, d) => d === '' || f === d || f.startsWith(`${d}/`);
const overlaps = (a, b) => within(a, b) || within(b, a);
// npm init's placeholder is no test script
const NPM_STUB_RE = /^echo\s+"Error: no test specified"\s*&&\s*exit 1$/;
export const realTestScript = (s) => typeof s === 'string' && s.trim() !== '' && !NPM_STUB_RE.test(s.trim());

const LOCKFILE_COMMANDS = [['pnpm-lock.yaml', 'pnpm test'], ['yarn.lock', 'yarn test'], ['package-lock.json', 'npm test']];

// The tracked files of the project (relative to it); none outside a git repository.
export function trackedFiles(root) {
  try { return gitZ(root, ['ls-files', '-z']).names; } catch { return []; }
}

// Nested packages: a package.json among `files` (project-relative) below the root and outside node_modules/,
// whose test script is a real one. `command` is its package manager's test command, from the nearest lockfile
// in or above its directory (`npm test` without one).
export function nestedTestPackages(root, files = trackedFiles(root)) {
  const command = (dir) => {
    for (let d = dir; ; d = path.posix.dirname(d)) {
      const hit = LOCKFILE_COMMANDS.find(([f]) => fs.existsSync(path.join(root, d, f)));
      if (hit) return hit[1];
      if (d === '.') return 'npm test';
    }
  };
  return files.filter((f) => f.endsWith('/package.json') && !f.split('/').includes('node_modules'))
    .map((f) => path.posix.dirname(f))
    .filter((dir) => realTestScript(readJson(path.join(root, dir, 'package.json'), null)?.scripts?.test))
    .sort()
    .map((dir) => ({ dir, command: command(dir) }));
}

// Directories (project-relative, '' = the whole project) an entry's command may run test files from, or null
// when that cannot be told. Only a command that mirrors its package test script without hooks is read: the path
// arguments of `node --test` up to their first glob character (none: node's default patterns, the whole entry
// directory), and the directory jest or vitest searches unless their config says which files or roots they run.
function testRoots(e, pkg, runnerConfig) {
  const script = String(pkg?.testScript ?? '').trim();
  if (!pkg || pkg.hooks?.length || (!PACKAGE_TEST.has(e.command) && e.command !== script)) return null;
  const k = classifyScript(script);
  if (k.kind === 'jest' || k.kind === 'vitest') return RUNNER_CONFIG_RE.test(runnerConfig) ? null : [e.dir];
  if (k.kind !== 'node-test') return null;
  const resolve = (p) => {
    if (path.posix.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return null;
    const r = path.posix.normalize(path.posix.join(e.dir || '.', p || '.')).replace(/\/$/, '');
    return r === '..' || r.startsWith('../') ? null : r === '.' ? '' : r;
  };
  // a file a prefix flag loads (--import=, --require=) outside the entry is a file it runs
  for (const t of k.prefix) {
    const v = t.includes('=') ? resolve(t.slice(t.indexOf('=') + 1)) : '';
    if (v === null || (t.includes('=') && !within(v, e.dir))) return null;
  }
  const words = script.split(/\s+/);
  const args = words.slice(words.indexOf('--test') + 1).map((a) => a.replace(/^['"]+|['"]+$/g, ''));
  if (!args.length) return [e.dir];
  const roots = [];
  for (const a of args) {
    const g = a.search(GLOB_RE);
    const r = resolve(g < 0 ? a : a.slice(0, a.lastIndexOf('/', g) + 1));
    if (r === null) return null;
    roots.push(r);
  }
  return roots;
}

// One plan per test.full entry ({ dir, command }, dir '' for the root), each made by planRun relative to the
// entry's directory and run there. A file belongs to the entry with the deepest directory containing it; the
// root entry takes the rest. `markers[dir]`: the entry's last full green run; `windows[dir]`: every project file
// changed since then ({ changed, outside, bad }), absent when the entry has no usable marker. Paths are
// project-relative. A change that is not the entry's own makes the entry run full when the entry may depend on it:
// a dependency or config file outside every nested entry, a file of another entry the entry's command may also
// run, a file the entry's files mention or import, or a package the entry's files import by name. The import
// graph is used for the root entry only; nested entries use the mention rule.
export function planEntries({ entries, markers = {}, windows = {}, allFiles = [], packages = [], readFile, head, maxTargeted = DEFAULTS.test.max_targeted, phaseEnd = null, graph = null, trackedBad = false }) {
  const nested = entries.filter((e) => e.dir);
  const deepest = (list, f) => list.reduce((o, x) => (within(f, x.dir) && (!o || x.dir.length > o.dir.length) ? x : o), null);
  const changedAll = [...new Set(Object.values(windows).flatMap((w) => w?.changed ?? []))];
  const warnings = packages
    .filter((p) => p.dir && realTestScript(p.testScript) && !entries.some((e) => e.dir === p.dir) && changedAll.some((f) => within(f, p.dir)))
    .map((p) => `changes in nested package ${p.dir}, which has its own test script that test.full does not run`);
  return { plans: entries.map((entry) => ({ entry, plan: planEntry(entry) })), warnings };

  function planEntry(e) {
    const full = (reason) => fullPlan(reason, e.command, e.dir);
    const m = markers[e.dir] ?? null;
    const w = m ? windows[e.dir] : null;
    if (w?.outside) return full('changes outside the project root');
    if (w?.bad || trackedBad) return full('a file name is not valid UTF-8');
    if (!w) return full('no previous full green run');
    if (!w.changed.length) return { mode: 'skip', reason: m.fullSha === head ? 'already fully green at HEAD' : 'no file changes since the last full green run', groups: [] };
    if (phaseEnd && w.changed.some((f) => !DOC_RE.test(f))) return full(`phase ${phaseEnd.phase} end: every plan has a summary`);
    const rel = (f) => (e.dir ? f.slice(e.dir.length + 1) : f);
    const mine = allFiles.filter((f) => within(f, e.dir));
    const pkg = packages.find((p) => p.dir === e.dir);
    const runnerConfig = [pkg?.jest === undefined ? '' : JSON.stringify(pkg.jest), ...mine.filter((f) => RUNNER_CONFIG_FILE_RE.test(rel(f))).map(readFile)].join('\n');
    const roots = testRoots(e, pkg, runnerConfig);
    const reaches = (d) => roots === null || roots.some((r) => overlaps(r, d.dir));
    // what the entry's command runs: its own files, and those of a nested entry it may reach
    const scope = mine.filter((f) => { const o = deepest(entries, f); return o === e || reaches(o); });
    const owned = w.changed.filter((f) => deepest(entries, f) === e);
    let plan = { mode: 'skip', reason: 'no changes that concern this entry since its last full green run', groups: [] };
    if (owned.length) {
      const pkgs = packages.filter((p) => within(p.dir, e.dir)).map((p) => ({ ...p, dir: rel(p.dir) }));
      if (!pkgs.length) pkgs.push({ dir: '', testScript: allFiles.includes(path.posix.join(e.dir, 'pyproject.toml')) ? 'pytest' : '', hooks: [] });
      const files = scope.map(rel);
      plan = planRun({
        changed: owned.map(rel), packages: pkgs, readFile: (f) => readFile(e.dir ? `${e.dir}/${f}` : f), marker: m, head, forceFull: false,
        fullCommand: e.command, maxTargeted, runnerConfig, graph: e.dir ? null : graph, dir: e.dir, allFiles: mine.map(rel),
        testFiles: files.filter(isTestFile), sourceFiles: files.filter((f) => SOURCE_RE.test(f) && !f.includes('node_modules/')),
      });
      if (plan.mode === 'full') return full(plan.reason);
    }
    const sources = scope.filter((f) => (isTestFile(f) || SOURCE_RE.test(f)) && !f.includes('node_modules/'));
    let reach = null;
    for (const c of w.changed) {
      const o = deepest(entries, c);
      if (o === e) continue;
      if (CONFIG_RE.test(c) && !nested.some((d) => within(c, d.dir))) return full(`dependency or config file changed outside the nested entries: ${c}`);
      if (within(c, e.dir) && reaches(o)) return full(`${c} changed in ${o.dir}, whose tests this command may also run`);
      if (!within(c, e.dir) && (roots === null || roots.some((r) => !within(r, e.dir)))) return full(`${c} changed outside ${e.dir}, where this command may also run tests`);
      reach ??= dependents(sources, readFile);
      const by = [...reach(c)].find((f) => f !== c);
      if (by) return full(`${by} mentions ${c}, changed outside this entry`);
      const p = deepest(packages, c);
      if (p?.name && p.dir !== e.dir) {
        const re = new RegExp(`['"\`]${escRe(p.name)}(?:/[^'"\`]*)?['"\`]`);
        const user = sources.find((f) => re.test(readFile(f) ?? ''));
        if (user) return full(`${user} imports ${p.name}, where ${c} changed`);
      }
    }
    return { ...plan, groups: plan.groups.map((g) => ({ ...g, cwd: e.dir })) };
  }
}

// One trailing newline off, nothing else: a path may begin or end with a space.
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r?\n$/, '');

// NUL-separated git output (-z), verbatim: no trimming, no quoting. A name that is not valid UTF-8
// cannot be matched against the working tree, so it is only reported (`bad`) and the run goes full.
export function splitZ(buf) {
  const names = [];
  let bad = false;
  for (let start = 0; start < buf.length;) {
    let end = buf.indexOf(0, start);
    if (end < 0) end = buf.length;
    const part = buf.subarray(start, end);
    if (part.length) {
      if (isUtf8(part)) names.push(part.toString('utf8'));
      else bad = true;
    }
    start = end + 1;
  }
  return { names, bad };
}
const gitZ = (root, args) => splitZ(execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }));

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

// The recorded graph counts only for the full run the marker names.
function storedGraph(cfg, file, marker) {
  if (cfg.test?.import_graph !== true || !file || !marker) return null;
  const g = readJson(file, null);
  return g && g.fullSha === marker.fullSha && g.tests && typeof g.tests === 'object' ? g : null;
}

// The files changed between a full green run and HEAD: whole-repo paths (no --relative), so a change outside
// the project root is seen. null when git cannot diff (the commit is gone).
function diffWindow(root, prefix, sha) {
  try {
    const diff = gitZ(root, ['diff', '--name-only', '--no-renames', '--no-relative', '-z', sha, 'HEAD']);
    const w = { changed: [], outside: false, bad: diff.bad };
    for (const f of diff.names) {
      if (f.startsWith(prefix)) w.changed.push(f.slice(prefix.length));
      else w.outside = true;
    }
    return w;
  } catch {
    return null;
  }
}

// The marker after a green run: the root entry's record at the top level (the format of a single test.full
// command, so an older marker reads as the root's), the nested entries' under `entries`.
function nextMarker(plans, markers, head) {
  const record = ({ entry, plan }) => {
    const m = markers[entry.dir];
    if (plan.mode === 'full') return { fullSha: head, targetedSince: 0 };
    return plan.mode === 'targeted' ? { fullSha: m.fullSha, targetedSince: m.targetedSince + 1 } : m;
  };
  const top = plans.find(({ entry }) => !entry.dir);
  const nested = plans.filter(({ entry }) => entry.dir);
  return { ...(top ? record(top) : {}), ...(nested.length ? { entries: Object.fromEntries(nested.map((p) => [p.entry.dir, record(p)])) } : {}) };
}

const entryLabel = (e) => e.dir || '(root)';

// Marker (per worktree, inside the git dir): per test.full entry, the last FULL green run and the number of
// targeted green runs since. An entry's change set is always cumulative from its own full run.
export async function runTestChanged({ root, env = process.env, stdio = 'inherit', log = (l) => process.stdout.write(`[turbo-test] ${l}\n`) }) {
  const cfg = loadConfig(root);
  const entries = fullEntries(cfg.test?.full, root); // an invalid list throws a config error before anything runs
  const single = entries.length === 1 && entries[0].dir === '';
  const rootEntry = entries.find((e) => e.dir === '') ?? null;
  const max = cfg.test?.max_targeted;
  const maxTargeted = Number.isInteger(max) && max >= 0 ? max : DEFAULTS.test.max_targeted;
  const forceFull = env.TURBO_FULL === '1';
  let head = null;
  try { head = git(root, ['rev-parse', 'HEAD']); } catch { /* not a repository, no commit yet, or no git */ }

  const allFull = (reason) => entries.map((entry) => ({ entry, plan: fullPlan(reason, entry.command, entry.dir) }));
  let plans;
  let warnings = [];
  const markers = {};
  let markerPath = null;
  let graphFile = null;
  let graph = null;
  if (!head) {
    plans = allFull('not a git repository');
  } else {
    markerPath = path.resolve(root, git(root, ['rev-parse', '--git-path', 'turbo-last-green']));
    graphFile = path.resolve(root, git(root, ['rev-parse', '--git-path', 'turbo-import-graph.json']));
    const status = gitZ(root, ['status', '--porcelain', '--untracked-files=normal', '-z']);
    // a rename adds a second NUL field without a status code: it counts as dirty, and so is the rename
    const dirty = status.bad || status.names.some((l) => !l.startsWith('?? '));
    const untracked = status.names.some((l) => l.startsWith('?? '));
    const saved = readJson(markerPath, null);
    for (const e of entries) markers[e.dir] = validMarker(e.dir ? saved?.entries?.[e.dir] : saved);
    if (forceFull) {
      plans = allFull('TURBO_FULL=1');
    } else if (dirty) {
      plans = allFull('uncommitted changes in tracked files');
    } else if (untracked) {
      // the full command may pick untracked files up (an untracked test, a module it imports)
      plans = allFull('untracked files present');
    } else {
      let prefix = null;
      try { prefix = git(root, ['rev-parse', '--show-prefix']); } catch { /* no window: every entry runs full */ }
      const windows = {};
      const bySha = new Map();
      for (const e of entries) {
        const sha = markers[e.dir]?.fullSha;
        if (!sha || prefix === null) continue;
        if (!bySha.has(sha)) bySha.set(sha, diffWindow(root, prefix, sha));
        if (bySha.get(sha)) windows[e.dir] = bySha.get(sha);
      }
      const tracked = gitZ(root, ['ls-files', '-z']);
      const all = tracked.names;
      const packages = all.filter((f) => path.posix.basename(f) === 'package.json' && !f.includes('node_modules/'))
        .map((f) => {
          const pkg = readJson(path.join(root, f), {});
          const s = pkg?.scripts;
          const scripts = s && typeof s === 'object' ? s : {};
          const hooks = ['pretest', 'posttest'].filter((h) => Object.hasOwn(scripts, h));
          const dir = path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f);
          return { dir, testScript: scripts.test || '', hooks, main: typeof pkg?.main === 'string' ? pkg.main : '', name: typeof pkg?.name === 'string' ? pkg.name : '', jest: pkg?.jest };
        });
      const cache = new Map();
      const readFile = (f) => {
        if (!cache.has(f)) {
          let s = '';
          try { s = fs.readFileSync(path.join(root, f), 'utf8'); } catch { /* deleted or unreadable */ }
          cache.set(f, s);
        }
        return cache.get(f);
      };
      let phaseEnd = null;
      try {
        phaseEnd = phaseEndState(root);
      } catch {
        // unreadable turbo state: no phase-end rule
      }
      graph = rootEntry ? storedGraph(cfg, graphFile, markers['']) : null;
      ({ plans, warnings } = planEntries({ entries, markers, windows, allFiles: all, packages, readFile, head, maxTargeted, phaseEnd, graph, trackedBad: tracked.bad }));
    }
    // a dirty tree proves nothing about HEAD; untracked files may be part of what passed
    if (dirty || untracked) markerPath = null;
  }

  for (const w of warnings) log(`warn: ${w}`);
  for (const { entry, plan } of plans) log(`${single ? '' : `${entryLabel(entry)}: `}${plan.mode}: ${plan.reason}`);
  if (plans.some(({ plan }) => plan.mode === 'full' && !plan.groups[0].cmd)) {
    process.stderr.write('[turbo-test] test.full is empty in .planning/turbo/config.json\n');
    return 1;
  }
  // test.import_graph: a clean full run of the root entry under a node --test root runner records what each test
  // loads (the recording hook needs module.registerHooks, Node >= 22.15)
  const graphOn = cfg.test?.import_graph === true;
  const rootPlan = plans.find(({ entry }) => entry === rootEntry)?.plan ?? null;
  const rootKind = classifyScript(String(readJson(path.join(root, 'package.json'), null)?.scripts?.test ?? '')).kind;
  const graphDir = rootPlan?.mode === 'full' && markerPath && graphOn && rootKind === 'node-test' && typeof nodeModule.registerHooks === 'function'
    ? path.resolve(root, git(root, ['rev-parse', '--git-path', 'turbo-graph-run']))
    : null;
  if (graphOn && rootPlan?.mode === 'targeted') log(graph ? 'import graph: used with the mention rule' : 'import graph: none for the last full green run; mention rule only');
  if (graphOn && rootPlan?.mode === 'full' && !graphDir) log('import graph: not recorded (needs a clean tree, a plain `node --test` root script and Node >= 22.15)');
  if (graphDir) fs.rmSync(graphDir, { recursive: true, force: true });
  // entries run in order, each in its own directory; the first red one ends the run
  for (const { entry, plan } of plans) {
    const cenv = graphDir && entry === rootEntry ? graphEnv(childEnv(), graphDir) : childEnv();
    for (const g of plan.groups) {
      const opts = { cwd: path.join(root, g.cwd), env: cenv, stdio };
      const code = plan.mode === 'full' ? await runFull(g.cmd, opts, log) : exitCode(await spawnWait(g.cmd, g.args, opts), g.cmd);
      if (code !== 0) {
        if (!single) log(`${entryLabel(entry)}: failed (exit code ${code})`);
        return code;
      }
    }
  }
  // written only once every entry is green
  if (markerPath && plans.some(({ plan }) => plan.mode !== 'skip')) writeJsonAtomic(markerPath, nextMarker(plans, markers, head));
  if (graphDir) {
    // a green full run stays green: without a graph, targeted runs use the mention rule only
    try {
      const recorded = collectGraph({ root, dir: graphDir, fullSha: head, isTest: (f) => isRunnableTest(f) || isTestFile(f) });
      if (recorded) writeJsonAtomic(graphFile, recorded);
      else fs.rmSync(graphFile, { force: true });
      fs.rmSync(graphDir, { recursive: true, force: true });
      log(recorded ? `import graph: recorded (${Object.keys(recorded.tests).length} test file(s))` : 'import graph: discarded (no test process recorded what it loaded)');
    } catch (err) {
      log(`import graph: not saved (${err.code || err.message}); targeted runs use the mention rule only`);
    }
  }
  return 0;
}
