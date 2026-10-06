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
export const turboDir = (root) => path.join(root, '.planning', 'turbo');
export const runDir = (root) => path.join(turboDir(root), 'run');
export const logsDir = (root) => path.join(turboDir(root), 'logs');
export const locksDir = (root) => path.join(turboDir(root), 'locks');
