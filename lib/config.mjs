import fs from 'node:fs';
import path from 'node:path';
import { turboDir } from './paths.mjs';
import { writeJsonAtomic, ensureDir } from './fsx.mjs';

export const DEFAULTS = Object.freeze({
  lang: 'en',
  max_lanes: 3,
  // spec §6.1, §10 (Stage 4 L1): prep and annotate jobs at once; null: max_lanes
  max_prep: null,
  // spec §7.2, §10: integrations a phase repeats while main keeps moving before the owner decides (L2 counts them)
  merge_rounds: 3,
  max_executors: 20,
  lane_permission_mode: 'bypassPermissions',
  lane_model: '',
  context_stop_pct: 55,
  // tokens; what turbo-run context measures against, and what init gives GSD when GSD's config sets none
  context_window: 1000000,
  autonomy: 'standard',
  poll_seconds: 20,
  max_restarts_without_progress: 3,
  // spec §8 (S4): gap-closure rounds a phase may run after verification (execute) and after UAT (uat), each
  gap_rounds: 1,
  blocked_minutes_before_notify: 10,
  // minutes without a transcript write before turbo-run view marks a subagent or a lane quiet (a mark only)
  stall_minutes: 15,
  // seconds between two reads of the live view: the turbo-view mod and turbo-run status --watch (1–60)
  view: { refresh_seconds: 3 },
  notify: { desktop: true, telegram: false },
  // spec §5.3, §10 (S1b): answer owner questions in Telegram too; needs notify.telegram
  answer: { telegram: false },
  // v0.4.0: minutes an open owner question waits before turbo takes its recommended option itself, for the safe ones
  // only (lib/auto-answer.mjs); 0 is off
  owner: { auto_answer_minutes: 60 },
  test: { full: 'npm test', max_targeted: 3, import_graph: false },
  uat: { boot: '', base_url: '', seed: '', forbidden_hosts: [] },
  deploy: { command: '', snapshot: '', health: '', rollback: '' },
  push: { mode: 'off', remote: 'origin', ci: 'github', ci_timeout_minutes: 30, ci_fix_rounds: 2 },
  // spec §4, §10 (Stage 4 L0): where lanes work. slots: one lasting local clone per lane under lanes.dir (empty:
  // <parent>/<repo>.turbo), with the git-ignored files of lanes.copy; checkout: v0.3's single lane in this checkout
  lanes: { mode: 'slots', dir: '', copy: ['.env', '*/.env', '.env.local', '*/.env.local'], install: '', trust_write: true, gates: [] },
});

// view.refresh_seconds as the live view uses it: a whole number of seconds from 1 to 60, anything else the default.
export function viewRefreshSeconds(config) {
  const n = Number(config?.view?.refresh_seconds);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULTS.view.refresh_seconds;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a?.[k]) ? deepMerge(a[k], v) : v;
  return out;
}

const configFile = (root) => path.join(turboDir(root), 'config.json');

// Defaults only when the file is absent; any other problem must not silently widen permissions.
export function loadConfig(root) {
  const file = configFile(root);
  const invalid = (reason, cause) => new Error(`invalid turbo config ${file}: ${reason}`, { cause });
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(DEFAULTS);
    throw invalid(err.message, err);
  }
  let parsed;
  try {
    // Windows PowerShell 5.1 `Set-Content -Encoding UTF8` writes a byte order mark.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw invalid(err.message, err);
  }
  if (!isObj(parsed)) throw invalid('top-level value must be a JSON object');
  return deepMerge(structuredClone(DEFAULTS), parsed);
}

// test.full: one command run at the project root, or a list of entries, each a command run at the root (a string)
// or { dir, command } run in that directory. Returns [{ dir, command }], dir '' for the root. A list that is not
// valid throws the same config error as a broken file: a wrong directory must never shrink the full run.
export function fullEntries(full, root) {
  const invalid = (reason) => new Error(`invalid turbo config ${configFile(root)}: ${reason}`);
  if (full == null || typeof full === 'string') return [{ dir: '', command: String(full ?? '').trim() }];
  if (!Array.isArray(full)) throw invalid('test.full must be a command string or a list of entries');
  if (!full.length) throw invalid('test.full is an empty list');
  // directories compare by their real path: a link and a case-insensitive file system give one directory two names
  const base = fs.realpathSync.native(root);
  const seen = new Map();
  return full.map((e, i) => {
    const at = `test.full[${i}]`;
    if (typeof e !== 'string' && !isObj(e)) throw invalid(`${at} must be a command string or { "dir": "<directory>", "command": "<command>" }`);
    const extra = typeof e === 'string' ? undefined : Object.keys(e).find((k) => k !== 'dir' && k !== 'command');
    if (extra !== undefined) throw invalid(`${at} has an unknown key ${JSON.stringify(extra)} (only "dir" and "command")`);
    if (typeof e !== 'string' && typeof e.dir !== 'string') throw invalid(`${at}.dir must be a string`);
    if (typeof e !== 'string' && typeof e.command !== 'string') throw invalid(`${at}.command must be a string`);
    const command = (typeof e === 'string' ? e : e.command).trim();
    if (!command) throw invalid(`${at} has an empty command`);
    const raw = typeof e === 'string' ? '' : e.dir;
    const name = `${at}.dir "${raw}"`;
    if (raw.includes('\\')) throw invalid(`${name} must use forward slashes`);
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw invalid(`${name} must be relative to the project root`);
    const parts = raw.split('/').filter((p) => p && p !== '.');
    if (parts.includes('..')) throw invalid(`${name} must stay inside the project root (no "..")`);
    const dir = parts.join('/');
    let real = null;
    try { real = fs.realpathSync.native(path.join(root, dir)); } catch { /* missing */ }
    if (!real || !fs.statSync(real).isDirectory()) throw invalid(`${name} is not a directory in the project`);
    const inside = path.relative(base, real);
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw invalid(`${name} leads outside the project root (through a link)`);
    if (seen.has(real)) throw invalid(`${dir ? `${at}.dir "${dir}" is` : `${at} runs at the project root, which is`} listed twice (as test.full[${seen.get(real)}])`);
    seen.set(real, i);
    return { dir, command };
  });
}

export function initConfig(root, overrides = {}) {
  const file = configFile(root);
  ensureDir(turboDir(root));
  const ignore = path.join(turboDir(root), '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'run/\nlogs/\nlocks/\n');
  if (fs.existsSync(file)) return { created: false, file };
  writeJsonAtomic(file, deepMerge(structuredClone(DEFAULTS), overrides));
  return { created: true, file };
}

export const PUSH_MODES = Object.freeze(['off', 'after-wave', 'after-phase']);
// a git remote name as it appears in refs/remotes/<remote>/: never an option ("-…"), a path or a URL
const REMOTE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

// push.* (spec §6, S2), checked where a run loads its config: a typo must never read as "off" or reach git as an option.
export function pushSettings(raw = DEFAULTS.push) {
  if (!isObj(raw)) throw new Error('invalid turbo config push: must be an object');
  const bad = (key, why) => new Error(`invalid turbo config push.${key}: ${why}`);
  const p = { ...DEFAULTS.push, ...raw };
  if (!PUSH_MODES.includes(p.mode)) throw bad('mode', `must be one of ${PUSH_MODES.join(', ')}`);
  if (typeof p.remote !== 'string' || !REMOTE_RE.test(p.remote) || p.remote.includes('..')) throw bad('remote', 'must be the name of a git remote (letters, digits, . _ -), for example origin');
  if (!['github', 'none'].includes(p.ci)) throw bad('ci', 'must be github or none');
  if (!Number.isInteger(p.ci_timeout_minutes) || p.ci_timeout_minutes < 1) throw bad('ci_timeout_minutes', 'must be a whole number of minutes, at least 1');
  if (!Number.isInteger(p.ci_fix_rounds) || p.ci_fix_rounds < 0) throw bad('ci_fix_rounds', 'must be a whole number, at least 0');
  return { mode: p.mode, remote: p.remote, ci: p.ci, ci_timeout_minutes: p.ci_timeout_minutes, ci_fix_rounds: p.ci_fix_rounds };
}

export const LANE_MODES = Object.freeze(['slots', 'checkout']);

// lanes.* (spec §4, §10, Stage 4 L0), checked where slots are built or read: a typo must never widen what turbo copies
// or where it clones. Keys of later sub-projects (lanes.gates) pass through unchecked, left to them.
export function lanesSettings(raw = DEFAULTS.lanes) {
  if (!isObj(raw)) throw new Error('invalid turbo config lanes: must be an object');
  const bad = (key, why) => new Error(`invalid turbo config lanes.${key}: ${why}`);
  const l = { ...DEFAULTS.lanes, ...raw };
  if (!LANE_MODES.includes(l.mode)) throw bad('mode', `must be one of ${LANE_MODES.join(', ')}`);
  if (typeof l.dir !== 'string') throw bad('dir', 'must be a path (empty: next to the project, <repo>.turbo)');
  if (!Array.isArray(l.copy) || l.copy.some((m) => typeof m !== 'string' || !m.trim())) throw bad('copy', 'must be a list of path masks');
  const copy = l.copy.map((m) => m.trim());
  for (const m of copy) {
    if (m.includes('\\')) throw bad('copy', `"${m}" must use forward slashes`);
    if (m.startsWith('/') || /^[A-Za-z]:/.test(m)) throw bad('copy', `"${m}" must be relative to the project root`);
    if (m.split('/').includes('..')) throw bad('copy', `"${m}" must stay inside the project (no "..")`);
    if (m.split('/').includes('.git')) throw bad('copy', `"${m}" must not name .git`);
  }
  if (typeof l.install !== 'string') throw bad('install', 'must be a command string (empty: by the lockfile)');
  if (typeof l.trust_write !== 'boolean') throw bad('trust_write', 'must be true or false');
  return { ...raw, mode: l.mode, dir: l.dir.trim(), copy, install: l.install.trim(), trust_write: l.trust_write };
}

// spec §6.2, §10 (Stage 4 L1): the shared resources a phase may hold for its whole run (its ROADMAP Gates line) or for
// one action (turbo-run lock): this dictionary and the project's own lanes.gates.
export const GATE_NAMES = Object.freeze(['prod-deploy', 'owner-live', 'owner-signature', 'packaged-build']);
export const GATE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// The dictionary, then the project's own gates, each once. A bad name stops with the key named: it becomes a file name
// in locks/gates/.
export function laneGates(config) {
  const own = config?.lanes?.gates ?? [];
  if (!Array.isArray(own) || own.some((g) => typeof g !== 'string' || !GATE_RE.test(g.trim()))) {
    throw new Error('invalid turbo config lanes.gates: must be a list of names (lower-case letters, digits and -, at most 40, not starting with -)');
  }
  return [...new Set([...GATE_NAMES, ...own.map((g) => g.trim())])];
}

// merge_rounds: a whole number from 1 to 20; a digit string too (the file is edited by hand).
export function mergeRounds(config) {
  const v = config?.merge_rounds ?? DEFAULTS.merge_rounds;
  const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('invalid turbo config merge_rounds: must be a whole number from 1 to 20');
  return n;
}

// max_prep: null (the default) is max_lanes (lanes); else a whole number from 0 (no prep) to max_lanes.
export function maxPrep(config, lanes) {
  const v = config?.max_prep ?? null;
  if (v === null) return lanes;
  if (!Number.isInteger(v) || v < 0 || v > lanes) throw new Error(`invalid turbo config max_prep: must be null or a whole number from 0 to max_lanes (${lanes})`);
  return v;
}
