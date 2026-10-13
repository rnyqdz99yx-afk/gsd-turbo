import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson } from './fsx.mjs';

export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}
export function turboHome(env = process.env) {
  return path.join(claudeHome(env), 'turbo');
}
export function findProjectRoot(start = process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, '.planning'))) return d;
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
}
export function gsdCoreDir(projectRoot, env = process.env) {
  const candidates = [];
  if (projectRoot) candidates.push(path.join(projectRoot, '.claude', 'gsd-core'));
  candidates.push(path.join(claudeHome(env), 'gsd-core'));
  return candidates.find((c) => fs.existsSync(path.join(c, 'VERSION'))) || null;
}
// Directory identity: the real path, forward slashes, case-insensitive on win32 — the normalization lane
// session names are hashed with. A path that does not exist is the real path of its nearest existing parent
// plus the rest, so links and 8.3 short names above it key the same as for its existing siblings.
export function dirKey(p) {
  let head = path.resolve(p);
  const rest = [];
  let abs = null;
  while (abs === null) {
    try {
      abs = fs.realpathSync.native(head);
    } catch {
      const up = path.dirname(head);
      if (up === head) abs = head; // nothing above exists: keep the resolved path
      else {
        rest.unshift(path.basename(head));
        head = up;
      }
    }
  }
  abs = path.join(abs, ...rest);
  const key = abs.replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
export const turboDir = (root) => path.join(root, '.planning', 'turbo');

// Stage 4 (spec §4.2): the main checkout that owns a lane's slot (the control root) keeps turbo's state: run/, logs/,
// locks/ and the owner's answers. A slot names it in its record, kept in the slot's git directory, where no checkout,
// clean or commit reaches it; the record's presence is what makes a directory a slot.
export const CONTROL_ENV = 'TURBO_CONTROL_ROOT';
export const SLOT_RECORD = 'turbo-lane.json';
export const slotRecordFile = (slot) => path.join(slot, '.git', SLOT_RECORD);
export const isSlot = (root) => Boolean(root) && fs.existsSync(slotRecordFile(root));

// The local directory a git remote URL names, or null for a URL of another host (https, ssh, scp-like host:path).
export function localRemotePath(url) {
  const u = String(url ?? '').trim();
  if (!u) return null;
  if (/^file:\/\//i.test(u)) {
    try {
      return fileURLToPath(u);
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(u)) return null;
  if (!/^[A-Za-z]:[\\/]/.test(u) && /^[^/\\]+:/.test(u)) return null;
  return path.resolve(u);
}

function originUrl(dir) {
  try {
    return String(execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000, killSignal: 'SIGKILL' })).trim();
  } catch {
    return '';
  }
}

// A slot's control root: the directory its record names, confirmed by TURBO_CONTROL_ROOT (the lane session's env) or
// else by the slot's remote.origin.url, with .planning/turbo/ in it. Anything else throws: a slot never keeps turbo's
// state itself (the next job's git clean would erase it).
function slotControl(slot, env) {
  const rec = readJson(slotRecordFile(slot), null);
  const named = rec && typeof rec.control === 'string' && rec.control ? path.resolve(rec.control) : null;
  if (!named) throw new Error(`${slotRecordFile(slot)} names no control root: turbo's state of this slot has nowhere to go; repair or remove the slot by hand`);
  const fromEnv = env?.[CONTROL_ENV] ? String(env[CONTROL_ENV]) : '';
  const via = fromEnv ? CONTROL_ENV : 'remote.origin.url';
  const candidate = fromEnv ? path.resolve(fromEnv) : localRemotePath(originUrl(slot));
  if (!candidate) throw new Error(`slot ${slot}: no ${CONTROL_ENV} and its remote.origin.url names no local checkout; its control root is ${named}`);
  if (dirKey(candidate) !== dirKey(named)) throw new Error(`slot ${slot}: ${via} names ${candidate}, but the slot belongs to ${named}`);
  if (!fs.existsSync(turboDir(named))) throw new Error(`slot ${slot}: its control root ${named} has no .planning/turbo`);
  return named;
}

const controls = new Map();
// Where the state of the project at root lives: root itself, or for a slot its control root (remembered per slot
// and TURBO_CONTROL_ROOT value; a failure is never remembered).
export function stateRoot(root, env = process.env) {
  if (!isSlot(root)) return root;
  const slot = path.resolve(root);
  const key = `${slot}\0${env?.[CONTROL_ENV] ?? ''}`;
  if (!controls.has(key)) controls.set(key, slotControl(slot, env));
  return controls.get(key);
}

// The control root for a directory inside a project (spec §4.2), or null outside any project.
export function controlRoot(cwd = process.cwd(), env = process.env) {
  const root = findProjectRoot(cwd);
  return root === null ? null : stateRoot(root, env);
}

// turbo's state: a slot's lands in its control root, so every turbo-run command a lane calls in its slot reads and
// writes it there without knowing about slots.
export const runDir = (root) => path.join(turboDir(stateRoot(root)), 'run');
export const logsDir = (root) => path.join(turboDir(stateRoot(root)), 'logs');
export const locksDir = (root) => path.join(turboDir(stateRoot(root)), 'locks');
// The run directory of the checkout itself: what describes this checkout's own GSD config (lib/gates.mjs).
export const localRunDir = (root) => path.join(turboDir(root), 'run');
