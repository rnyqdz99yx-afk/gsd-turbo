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
  test: { full: 'npm test', max_targeted: 3 },
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
    parsed = JSON.parse(text);
  } catch (err) {
    throw invalid(err.message, err);
  }
  if (!isObj(parsed)) throw invalid('top-level value must be a JSON object');
  return deepMerge(structuredClone(DEFAULTS), parsed);
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
