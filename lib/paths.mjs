import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
export const runDir = (root) => path.join(turboDir(root), 'run');
export const logsDir = (root) => path.join(turboDir(root), 'logs');
export const locksDir = (root) => path.join(turboDir(root), 'locks');
