import fs from 'node:fs';
import path from 'node:path';
import { turboDir } from './paths.mjs';
import { writeJsonAtomic, ensureDir } from './fsx.mjs';

export const DEFAULTS = Object.freeze({
  lang: 'en',
  max_lanes: 3,
  max_executors: 20,
  lane_permission_mode: 'bypassPermissions',
  lane_model: '',
  context_stop_pct: 55,
  autonomy: 'standard',
  poll_seconds: 20,
  max_restarts_without_progress: 3,
  blocked_minutes_before_notify: 10,
  notify: { desktop: true, telegram: false },
  test: { full: 'npm test', max_targeted: 3, import_graph: false },
  uat: { boot: '', base_url: '', seed: '', forbidden_hosts: [] },
  deploy: { command: '', snapshot: '', health: '', rollback: '' },
});

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
