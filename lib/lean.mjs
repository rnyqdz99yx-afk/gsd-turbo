import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ABSENT, CONFIG_REL, commitPaths, createGsdConfig, gatesLeftovers, gatesRel } from './gates.mjs';
import { deepMerge, leanSettings, loadConfig } from './config.mjs';
import { gsdCoreDir, turboDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

// Stage 6 §5.1 (D1): lean mode. The GSD keys it writes into the project's .planning/config.json through gsd-tools
// config-set, each with its previous value kept in .planning/turbo/lean-prev.json for `lean off`.
export const LEAN_KEYS = Object.freeze([
  ['workflow.nyquist_validation', false],
  ['workflow.pattern_mapper', false],
  ['workflow.ui_review', false],
  ['workflow.security_enforcement', false],
  ['workflow.auto_prune_state', true],
  ['workflow.compact_content', true],
  ['workflow.assumption_delta', false],
  ['workflow.auto_advance', false],
  ['graphify.auto_update', false],
  ['context_window', 400000],
].map((pair) => Object.freeze(pair)));
// GSD sizes its prompts by this; turbo's own context_window (1000000) still decides pauses
export const LEAN_CONTEXT_WINDOW = 400000;
export const LEAN_PREV_REL = '.planning/turbo/lean-prev.json';
const TURBO_CONFIG_REL = '.planning/turbo/config.json';
const APPLY_MESSAGE = 'chore(turbo): lean mode GSD settings';
const OFF_MESSAGE = 'chore(turbo): lean mode off, GSD settings restored';
const GIT_TIMEOUT_MS = 120000;

export class LeanRefused extends Error {}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const at = (o, k) => k.split('.').reduce((x, s) => (isObj(x) && Object.hasOwn(x, s) ? x[s] : undefined), o);
const abs = (root, rel) => path.join(root, ...rel.split('/'));
const firstLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0];

function git(root, args, { ok = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: GIT_TIMEOUT_MS });
  } catch (err) {
    if (ok && err?.status === 1) return null;
    throw new Error(`git ${args[0]} failed: ${firstLine(String(err?.stderr || err?.message))}`);
  }
}

// Commits the lean paths only when git already tracks .planning/config.json (as gates toggles do); the result names
// the commit for the lines.
function commitLean(root, paths, message) {
  if (git(root, ['ls-files', '--error-unmatch', '--', CONFIG_REL], { ok: true }) === null) return { committed: false, reason: 'config not tracked' };
  const c = commitPaths(root, paths, message);
  if (!c.committed) return c;
  return { committed: true, sha: git(root, ['rev-parse', '--short', 'HEAD']).trim(), subject: message };
}

// Whether .planning/config.json already holds every lean value (read directly, no gsd-tools).
export function leanCurrent(root) {
  const cfg = readJson(abs(root, CONFIG_REL), null);
  if (!isObj(cfg)) return false;
  return LEAN_KEYS.every(([k, v]) => {
    const x = at(cfg, k);
    return x !== undefined && String(x) === String(v);
  });
}

// The lean keys whose GSD value differs: from is config-get's raw text (ABSENT when unset), to the lean value's text.
// Read-only: cfg is createGsdConfig({ root, core }).
export function leanChanges({ cfg }) {
  return LEAN_KEYS.map(([key, value]) => ({ key, from: cfg.get(key), to: String(value) })).filter((c) => c.from !== c.to);
}

function gsdCore(core) {
  if (!core) throw new Error('GSD not found: no gsd-core in the project or in the Claude config directory');
  return core;
}

// The turbo config's lean.enabled as written (the file only; DEFAULTS say true).
const turboConfigFile = (root) => path.join(turboDir(root), 'config.json');
function setLeanEnabled(root, enabled) {
  const file = turboConfigFile(root);
  writeJsonAtomic(file, deepMerge(readJson(file, {}) ?? {}, { lean: { enabled } }));
}

// Refuses while a phase has GSD's built-in gates off: its gates restore would put back the pre-lean values of three
// lean keys (nyquist, security, ui) and silently undo lean.
function refuseWhileGatesOff(root) {
  const p = gatesLeftovers(root).gates[0];
  if (p !== undefined) throw new LeanRefused(`phase ${p} has GSD's built-in gates off (${gatesRel(p)}): run turbo-run gates restore ${p} first; nothing was changed`);
}

// Writes the lean keys (lean-prev.json first), sets lean.enabled true when the turbo config had it false, commits once
// (commit false: the caller's own commit carries the paths), then runs the injected effort step (Task 4).
export function leanApply({ root, core = gsdCoreDir(root), exec, commit = true, dryRun = false, effort = null, now = new Date() }) {
  refuseWhileGatesOff(root);
  const cfg = createGsdConfig({ root, core: gsdCore(core), exec });
  const changed = leanChanges({ root, cfg });
  const wasEnabled = leanSettings(loadConfig(root)).enabled;
  const enabled = wasEnabled ? null : { from: false, to: true };
  if (dryRun) return { dryRun: true, changed, enabled, effort: effort ? effort({ dryRun: true }) : null, paths: [], commit: null };
  const paths = [];
  if (changed.length) {
    const file = abs(root, LEAN_PREV_REL);
    const prev = readJson(file, null);
    const keys = { ...(isObj(prev?.keys) ? prev.keys : {}) };
    for (const c of changed) keys[c.key] ??= c.from;
    if (!isObj(prev?.keys) || JSON.stringify(keys) !== JSON.stringify(prev.keys)) writeJsonAtomic(file, { v: 1, at: now.toISOString(), keys });
    for (const c of changed) cfg.set(c.key, c.to);
    paths.push(CONFIG_REL, LEAN_PREV_REL);
  }
  if (enabled) {
    setLeanEnabled(root, true);
    paths.push(TURBO_CONFIG_REL);
  }
  const committed = commit && paths.length ? commitLean(root, paths, APPLY_MESSAGE) : null;
  let effortResult = null;
  if (effort) {
    try {
      effortResult = effort();
    } catch (err) {
      effortResult = { skipped: firstLine(err) };
    }
  }
  return { changed, enabled, effort: effortResult, paths, commit: committed };
}

// Puts back every value lean-prev.json kept (ABSENT: unset), deletes it, sets lean.enabled false (or the next phase
// boundary would apply lean again) and commits once. Agent effort is machine-wide and stays: hint() says how to undo it.
export function leanOff({ root, core = gsdCoreDir(root), exec, commit = true, hint = null }) {
  const file = abs(root, LEAN_PREV_REL);
  const prev = readJson(file, null);
  const restored = [];
  if (isObj(prev?.keys) && Object.keys(prev.keys).length) {
    const cfg = createGsdConfig({ root, core: gsdCore(core), exec });
    for (const [key, to] of Object.entries(prev.keys)) {
      const from = cfg.get(key);
      if (from === String(to)) continue;
      cfg.set(key, to === ABSENT ? 'null' : String(to));
      restored.push({ key, from, to: String(to) });
    }
  }
  const hadPrev = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  const raw = readJson(turboConfigFile(root), null);
  if (at(raw, 'lean.enabled') !== false) setLeanEnabled(root, false);
  const paths = [CONFIG_REL, ...(hadPrev ? [LEAN_PREV_REL] : []), TURBO_CONFIG_REL];
  const committed = commit ? commitLean(root, paths, OFF_MESSAGE) : null;
  return { restored, paths, commit: committed, hint: hint ? hint() : null };
}

const shown = (v) => (v === ABSENT ? 'absent' : v);

// What turbo-run lean, init and the supervisor log print for a leanApply (or, with off, a leanOff) result.
export function leanLines(result, { off = false } = {}) {
  const out = [];
  if (off) {
    for (const c of result.restored) out.push(`lean: ${c.key} ${shown(c.from)} → ${shown(c.to)}`);
    if (!result.restored.length) out.push('lean: no GSD settings to restore');
    out.push('lean: lean.enabled false in .planning/turbo/config.json');
  } else {
    for (const c of result.changed) out.push(`lean: ${c.key} ${shown(c.from)} → ${shown(c.to)}`);
    if (!result.changed.length) out.push('lean: GSD settings already lean');
    if (result.enabled) out.push('lean: lean.enabled false → true in .planning/turbo/config.json');
    if (result.changed.length && !result.dryRun) out.push(`lean: previous values in ${LEAN_PREV_REL}`);
  }
  if (result.commit?.committed) out.push(`lean: committed ${result.commit.sha} ${result.commit.subject}`);
  else if (result.commit) out.push(`lean: not committed (${result.commit.reason})`);
  if (off && result.hint) out.push(result.hint);
  if (result.dryRun) out.push('lean: dry run, nothing written');
  return out;
}
