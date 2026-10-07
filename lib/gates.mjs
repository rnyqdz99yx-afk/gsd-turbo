import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { runGsdJson } from './gsd.mjs';
import { gitRunner } from './staleness.mjs';

export const ABSENT = '__turbo_absent__';
export const CONFIG_REL = '.planning/config.json';
// GSD's built-in gates that turbo runs itself during the fan-out (G6).
export const GATE_KEYS = Object.freeze({
  nyquist: 'workflow.nyquist_validation',
  security: 'workflow.security_enforcement',
  ui: 'workflow.ui_review',
  'code-review': 'workflow.code_review',
});
const CAPS = Object.keys(GATE_KEYS);
const TIMEOUT_MS = 30000;

export const gatesRel = (phase) => `.planning/turbo/gates/p${phase}.json`;
const docsFile = (root, phase) => path.join(runDir(root), `docs-p${phase}.json`);
const activeFile = (root, phase) => path.join(runDir(root), `gates-active-p${phase}.json`);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function gsdText(core, root, args, exec = execFileSync) {
  try {
    return String(exec(process.execPath, [path.join(core, 'bin', 'gsd-tools.cjs'), ...args, '--cwd', root], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: TIMEOUT_MS, killSignal: 'SIGKILL',
    }));
  } catch (err) {
    const why = err?.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT_MS / 1000} s` : String(err?.stderr || err?.message || err).trim().split(/\r?\n/)[0];
    throw new Error(`gsd-tools ${args.slice(0, 2).join(' ')} failed: ${why}`);
  }
}

export function createGsdConfig({ root, core, exec = execFileSync }) {
  return {
    get: (key) => gsdText(core, root, ['config-get', key, '--default', ABSENT, '--raw'], exec).replace(/\r?\n$/, ''),
    set: (key, raw) => { gsdText(core, root, ['config-set', key, raw], exec); },
    activeCaps() {
      try {
        const ids = new Set();
        for (const point of ['verify:post', 'execute:post']) {
          for (const h of runGsdJson(core, ['loop', 'render-hooks', point], { cwd: root, exec }).activeHooks || []) if (h.kind === 'step') ids.add(h.capId);
        }
        return CAPS.filter((c) => ids.has(c));
      } catch {
        return [...CAPS]; // GSD cannot say which gates are on: run all of them
      }
    },
  };
}

// gitRunner with a soft-fail switch: { ok: true } returns null instead of throwing.
function gitIn(root) {
  const run = gitRunner(root);
  return (args, { ok = false } = {}) => {
    try {
      return run(args);
    } catch (err) {
      if (ok) return null;
      throw new Error(`git ${args.find((a) => !a.startsWith('-'))} failed: ${String(err?.stderr || err?.message).trim().split(/\r?\n/)[0]}`);
    }
  };
}

// Commits exactly these paths (tracked, or new and not ignored); other staged work stays staged.
export function commitPaths(root, paths, message, git = gitIn(root)) {
  const eligible = paths.filter((p) => git(['ls-files', '--error-unmatch', '--', p], { ok: true }) !== null
    || (fs.existsSync(path.join(root, p)) && git(['check-ignore', '-q', '--', p], { ok: true }) === null));
  if (!eligible.length) return { committed: false, reason: 'not tracked by git' };
  git(['add', '-A', '--', ...eligible]);
  if (git(['diff', '--cached', '--quiet', '--', ...eligible], { ok: true }) !== null) return { committed: false, reason: 'no changes' };
  git(['commit', '-q', '-m', message, '--', ...eligible]);
  return { committed: true };
}

// A toggle commits only a config that git already tracks; it never adds .planning/config.json to git.
function commitConfig(root, paths, message, git) {
  if (git(['ls-files', '--error-unmatch', '--', CONFIG_REL], { ok: true }) === null) return { committed: false, reason: 'config not tracked' };
  return commitPaths(root, paths, message, git);
}

// GSD's execute-phase writes workflow._auto_chain_active false on its own; absent means the same.
function dropGsdOwn(v) {
  if (!isObj(v) || !isObj(v.workflow) || ![false, 'false'].includes(v.workflow._auto_chain_active)) return v;
  const { _auto_chain_active: _ignored, ...workflow } = v.workflow;
  return { ...v, workflow };
}

function prune(v) {
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const p = prune(x);
    if (!(isObj(p) && Object.keys(p).length === 0)) out[k] = p;
  }
  return out;
}
const canon = (v) => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
export const sameConfig = (a, b) => canon(prune(dropGsdOwn(a))) === canon(prune(dropGsdOwn(b)));

// Puts back the committed bytes of .planning/config.json when the working copy means the same thing.
function restoreBytes(root, git, rev) {
  const blob = git(['show', `${rev}:${CONFIG_REL}`], { ok: true });
  if (blob === null) return false;
  let cur;
  let old;
  try {
    cur = JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
    old = JSON.parse(blob);
  } catch {
    return false;
  }
  if (!sameConfig(cur, old)) return false;
  git(['checkout', rev, '--', CONFIG_REL]);
  return true;
}

export function gatesOff({ root, phase, cfg, git = gitIn(root), now = new Date() }) {
  const rel = gatesRel(phase);
  const message = `chore(turbo): phase ${phase} built-in gates off while GSD executes`;
  const saved = readJson(path.join(root, rel), null);
  // already off: commit what an interrupted run may have left uncommitted (a no-op when clean)
  if (saved) return { changed: false, state: saved, commit: commitConfig(root, [CONFIG_REL, rel], message, git) };
  const base = git(['rev-parse', 'HEAD']).trim();
  const original = Object.fromEntries(Object.values(GATE_KEYS).map((k) => [k, cfg.get(k)]));
  const state = { phase: String(phase), base, original, active: cfg.activeCaps(), at: now.toISOString() };
  writeJsonAtomic(path.join(root, rel), state); // saved before anything changes
  for (const k of Object.values(GATE_KEYS)) cfg.set(k, 'false');
  const commit = commitConfig(root, [CONFIG_REL, rel], message, git);
  return { changed: true, state, commit };
}

// Which gates were on before `gates off`: the state while they are off, else the list the restore kept.
export function gatesActive(root, phase) {
  const state = readJson(path.join(root, gatesRel(phase)), null) ?? readJson(activeFile(root, phase), null);
  return state && Array.isArray(state.active) ? state.active : null;
}

export function gatesRestore({ root, phase, cfg, git = gitIn(root) }) {
  const rel = gatesRel(phase);
  const saved = readJson(path.join(root, rel), null);
  if (!saved) return { changed: false };
  // the fan-out runs after the restore and still needs the list of gates that were on
  writeJsonAtomic(activeFile(root, phase), { phase: String(phase), active: Array.isArray(saved.active) ? saved.active : [] });
  const original = isObj(saved.original) ? saved.original : {};
  for (const k of Object.values(GATE_KEYS)) {
    if (!Object.hasOwn(original, k)) continue;
    cfg.set(k, original[k] === ABSENT ? 'null' : String(original[k]));
  }
  if (saved.base) restoreBytes(root, git, saved.base);
  fs.rmSync(path.join(root, rel), { force: true });
  const commit = commitConfig(root, [CONFIG_REL, rel], `chore(turbo): phase ${phase} built-in gates restored`, git);
  return { changed: true, state: saved, commit };
}

export function docsCommitsOff({ root, phase, cfg }) {
  const file = docsFile(root, phase);
  if (readJson(file, null)) return { changed: false };
  const key = `phase_commit_docs.${phase}`;
  writeJsonAtomic(file, { key, original: cfg.get(key) });
  cfg.set(key, 'false');
  return { changed: true };
}

export function docsCommitsRestore({ root, phase, cfg, git = gitIn(root) }) {
  const file = docsFile(root, phase);
  const saved = readJson(file, null);
  if (!saved) return { changed: false };
  cfg.set(saved.key, saved.original === ABSENT ? 'null' : String(saved.original));
  restoreBytes(root, git, 'HEAD');
  fs.rmSync(file, { force: true });
  return { changed: true };
}

export function ensureChunkedParallel({ root, cfg, git = gitIn(root) }) {
  const v = cfg.get('planning.chunked_parallel');
  if (v === 'true') return { changed: false, value: true };
  if (v !== ABSENT) return { changed: false, value: false, note: 'planning.chunked_parallel is set to false in .planning/config.json; per-plan planning stays serial' };
  cfg.set('planning.chunked_parallel', 'true');
  const commit = commitConfig(root, [CONFIG_REL], 'chore(turbo): enable parallel chunked planning (planning.chunked_parallel)', git);
  return { changed: true, value: true, commit };
}
