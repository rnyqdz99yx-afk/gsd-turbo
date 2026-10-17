import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { excludeGsdRuntime, gsdCoreDir } from './paths.mjs';
import { DEFAULTS, loadConfig, initConfig, deepMerge, fullEntries, leanSettings } from './config.mjs';
import { leanLines } from './lean.mjs';
import { nestedTestPackages, realTestScript } from './test-changed.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { ABSENT, createGsdConfig } from './gates.mjs';

// turbo-run init (moved out of bin/turbo-run.mjs, Stage 5 T7): the turbo config, GSD's workflow.test_command and its
// context_window. /turbo-adopt applies the same setup (initProject) and lists it first without applying (initChanges).

// GSD runs workflow.test_command through bash -c, so the shell expands the config dir.
export const TURBO_TEST_CMD = 'node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/turbo/bin/turbo-run.mjs" test-changed';
export const TURBO_CONFIG_REL = '.planning/turbo/config.json';
export const TURBO_IGNORE_REL = '.planning/turbo/.gitignore';
export const GSD_CONFIG_REL = '.planning/config.json';
const EXEC_TIMEOUT_MS = 30000;
// Why a child process failed, without Node's "Command failed: <argv>" text.
const execWhy = (e) => (typeof e.status === 'number' ? `exit status ${e.status}` : e.code || e.signal || 'failed');

// What init stops with where bin used to die(): the message, exit 1, nothing more changed.
export class InitAborted extends Error {}

// GSD 1.16 with an empty workflow.test_command runs: xcodebuild test for an Xcode project (within
// depth 2, not under node_modules; post-merge gate), else `make test` for a Makefile with a
// test: target, else `just test` for a Justfile, else `npm test` when package.json exists.
// turbo's default full command is GSD's own choice only in the npm case, and usable only with a
// test script. Returns why it is not, or null.
function npmTestBlocker(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const isX = (n) => n.endsWith('.xcodeproj');
  let top = [];
  try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { /* reported below as no package.json */ }
  for (const e of top) if (isX(e.name)) return `GSD runs xcodebuild test for ${e.name}`;
  for (const e of top) {
    if (!e.isDirectory() || e.name === 'node_modules') continue;
    let names = [];
    try { names = fs.readdirSync(path.join(root, e.name)); } catch { /* unreadable */ }
    const x = names.find(isX);
    if (x) return `GSD runs xcodebuild test for ${e.name}/${x}`;
  }
  if (has('Makefile') && /^test:/m.test(read('Makefile'))) return 'GSD runs make test (Makefile has a test target)';
  if (has('Justfile') || has('justfile')) return 'GSD runs just test (Justfile)';
  if (!has('package.json')) return 'no package.json';
  let pkg = null;
  try { pkg = JSON.parse(read('package.json').replace(/^\uFEFF/, '')); } catch { return 'package.json cannot be parsed'; }
  const script = pkg?.scripts?.test;
  return typeof script === 'string' && script.trim() ? null : 'package.json has no test script';
}

// The full command test-changed falls back to: an explicitly set test.full (a command, or a list of entries,
// which must be valid), or the default `npm test` where GSD itself would run it. Anything else would let a gate
// pass on a subset.
export function knownFullCommand(root, config) {
  const full = config.test?.full;
  if (Array.isArray(full)) { fullEntries(full, root); return { full }; } // an invalid list throws a config error
  if (full !== DEFAULTS.test.full) return typeof full === 'string' && full.trim() ? { full } : { why: 'test.full is empty or not a string' };
  const why = npmTestBlocker(root);
  return why ? { why } : { full };
}
const showFull = (full) => (typeof full === 'string' ? full : JSON.stringify(full));

// Nested packages with their own test script that test.full does not run. A config this init created gets
// test.full as a list: the root command first (none when the root package.json is missing or has no real test
// script: a workspaces root, npm's stub), then one entry per package. Otherwise init only warns and prints the
// entries to add. Returns the list it wrote, or null.
function coverNestedPackages(root, res, known, out) {
  const nested = nestedTestPackages(root);
  if (!nested.length) return null;
  const entries = fullEntries(loadConfig(root).test?.full, root);
  const missing = nested.filter((p) => !entries.some((e) => e.dir === p.dir));
  if (!missing.length) return null;
  const rootTests = realTestScript(readJson(path.join(root, 'package.json'), null)?.scripts?.test);
  const noRootTests = ['no package.json', 'package.json has no test script'].includes(known.why) || (known.full === DEFAULTS.test.full && !rootTests);
  const rootCommand = noRootTests ? '' : typeof known.full === 'string' ? known.full : null;
  if (res.created && rootCommand !== null) {
    const list = [...(rootCommand ? [rootCommand] : []), ...missing];
    writeJsonAtomic(res.file, deepMerge(readJson(res.file, {}), { test: { full: list } }));
    out(`test.full set to the root command and every nested package with its own test script: ${JSON.stringify(list)}`);
    return list;
  }
  for (const p of missing) out(`warn: nested package ${p.dir} has its own test script that test.full does not run`);
  out(`to run them, add to test.full (a list) in .planning/turbo/config.json: ${JSON.stringify(missing)}`);
  return null;
}

// GSD's workflow.test_command, read before anything is written: it is never overwritten without first being kept as
// test.full.
function previousTestCommand(root, tool, exec) {
  try {
    return String(exec(process.execPath, [tool, 'config-get', 'workflow.test_command', '--default', '', '--raw', '--cwd', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL' })).replace(/\r?\n$/, '');
  } catch (e) {
    const detail = String(e.stderr || '').trim().split(/\r?\n/)[0] || '';
    throw new InitAborted(`init aborted: gsd-tools config-get workflow.test_command failed (${execWhy(e)})${detail ? `: ${detail}` : ''}; nothing was changed`);
  }
}

// turbo-run init: exactly its lines and its changes. inherit: config-set's output goes to this process's (init's own
// behaviour); adopt passes false and keeps its output to itself. Throws InitAborted where init stops (exit 1), a
// config error as it is.
// gsd false: turbo's own files only, GSD's config left as it is (adopt, when its list names no GSD change).
// lean (Stage 6 §5.1): bin's lean step (lib/lean.mjs leanApply with its effort step), called last with { root, core,
// exec, commit: false } when GSD is in play and lean.enabled; its failure is a warning, never init's.
export function initProject(root, { lang = 'en', autonomy = 'standard', core = gsdCoreDir(root), out = () => {}, exec = execFileSync, inherit = true, gsd = true, lean = null } = {}) {
  const tool = core && gsd ? path.join(core, 'bin', 'gsd-tools.cjs') : null;
  const prev = tool ? previousTestCommand(root, tool, exec) : '';
  const res = initConfig(root, { lang, autonomy });
  const config = loadConfig(root); // an existing corrupt config fails init
  const prevIsTurbo = prev.includes('turbo-run.mjs');
  let known;
  if (prev && !prevIsTurbo) {
    writeJsonAtomic(res.file, deepMerge(readJson(res.file, {}), { test: { full: prev } }));
    out(`kept previous workflow.test_command as test.full: ${prev}`);
    known = { full: prev };
  } else {
    known = knownFullCommand(root, config);
  }
  const list = coverNestedPackages(root, res, known, out);
  if (list) known = { full: list };
  if (tool) {
    if (known.full !== undefined) {
      try {
        exec(process.execPath, [tool, 'config-set', 'workflow.test_command', TURBO_TEST_CMD, '--cwd', root], { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL' });
      } catch (e) { throw new InitAborted(`gsd-tools config-set workflow.test_command failed (${execWhy(e)})`); }
      out(`workflow.test_command set to turbo-run test-changed (full test command: ${showFull(known.full)})`);
    } else {
      // GSD keeps choosing the test runner itself; nothing in the GSD config changes
      out(`no known full test command: ${known.why}`);
      out('targeted tests not enabled: set test.full in .planning/turbo/config.json, then run init again');
      if (prevIsTurbo) out('warn: workflow.test_command already runs turbo-run test-changed, but no full test command is known: set test.full and run init again, or reset workflow.test_command (see the README, Uninstall)');
    }
    // GSD's adaptive prompts key on its own context_window (200000 when unset); a value the project set stays
    const gsdCfg = createGsdConfig({ root, core, exec });
    const window = config.context_window;
    try {
      if (gsdCfg.get('context_window') === ABSENT) {
        if (!Number.isInteger(window) || window <= 0) out(`warn: context_window ${JSON.stringify(window)} in .planning/turbo/config.json is not a positive integer; GSD's context_window not set`);
        else {
          gsdCfg.set('context_window', String(window));
          out(`context_window set to ${window} in .planning/config.json (GSD had none; its default is 200000)`);
        }
      }
    } catch (e) { throw new InitAborted(`init: ${e.message}`); }
  } else if (gsd) {
    out('gsd-core not found: workflow.test_command not set');
  }
  if (tool && lean && leanSettings(config).enabled) {
    try {
      for (const l of leanLines(lean({ root, core, exec, commit: false }))) out(l);
    } catch (e) {
      out(`warn: lean mode not applied: ${String(e?.message ?? e).split(/\r?\n/)[0]}; run turbo-run lean apply`);
    }
  }
  // v0.5.1: GSD's runtime files never show in git status (a local git setting, never committed); no repository, no
  // exclude
  try {
    const ex = excludeGsdRuntime(root);
    if (ex.changed) out(`GSD's runtime files (.planning/state.json, milestone.lock and its locks) kept out of git status: ${ex.file}`);
  } catch {
    // not a git repository, or git is missing
  }
  out(`${res.created ? 'created' : 'kept'} ${res.file}`);
  return 0;
}

// What initProject would change now, read-only, in its order: [{ kind, text, paths, value }]. turbo-config: the config
// file or its .gitignore is missing; test-command: GSD's workflow.test_command does not run turbo yet and a full test
// command is known (init sets it); context-window: GSD has none and turbo's is a positive integer. Without a GSD core
// only turbo-config. Throws InitAborted when GSD's config cannot be read, a config error as it is.
export function initChanges(root, { core = gsdCoreDir(root), exec = execFileSync } = {}) {
  const changes = [];
  const missing = [TURBO_CONFIG_REL, TURBO_IGNORE_REL].filter((rel) => !fs.existsSync(path.join(root, ...rel.split('/'))));
  if (missing.length) changes.push({ kind: 'turbo-config', text: `turbo's own settings: ${missing.map((r) => `\`${r}\``).join(', ')}`, paths: [TURBO_CONFIG_REL, TURBO_IGNORE_REL], value: null });
  if (!core) return changes;
  const tool = path.join(core, 'bin', 'gsd-tools.cjs');
  const prev = previousTestCommand(root, tool, exec);
  const config = loadConfig(root);
  if (!prev.includes('turbo-run.mjs')) {
    const known = prev ? { full: prev } : knownFullCommand(root, config);
    if (known.full !== undefined) changes.push({ kind: 'test-command', text: `GSD's test command runs only the tests a change touches (\`turbo-run test-changed\`); the full command stays: ${showFull(known.full)}`, paths: [GSD_CONFIG_REL, TURBO_CONFIG_REL], value: known.full });
  }
  const window = config.context_window;
  let absent;
  try {
    absent = createGsdConfig({ root, core, exec }).get('context_window') === ABSENT;
  } catch (e) { throw new InitAborted(`init: ${e.message}`); }
  if (absent && Number.isInteger(window) && window > 0) changes.push({ kind: 'context-window', text: `GSD's context window: ${window} tokens (GSD had none; its default is 200000)`, paths: [GSD_CONFIG_REL], value: window });
  return changes;
}
