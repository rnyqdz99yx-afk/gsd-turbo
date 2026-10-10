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
// Directory identity: the real path when it exists (resolve() otherwise), forward slashes,
// case-insensitive on win32 — the normalization lane session names are hashed with.
export function dirKey(p) {
  let abs;
  try {
    abs = fs.realpathSync.native(p);
  } catch {
    abs = path.resolve(p);
  }
  const key = abs.replace(/\\/g, '/');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
export const turboDir = (root) => path.join(root, '.planning', 'turbo');
export const runDir = (root) => path.join(turboDir(root), 'run');
export const logsDir = (root) => path.join(turboDir(root), 'logs');
export const locksDir = (root) => path.join(turboDir(root), 'locks');
// A lane's own temp directory (TMP, TEMP and TMPDIR of its session); absolute.
export const laneTmpBase = (root) => path.join(runDir(path.resolve(root)), 'tmp');
export const laneTmpDir = (root, phase) => path.join(laneTmpBase(root), `p${phase}`);

// Removes run/tmp/p<phase> and nothing else: a path that resolves (links included) anywhere but directly
// inside run/tmp is refused. Returns the removed directory, null when there was none; throws on a refusal.
export function removeLaneTmp(root, phase) {
  const base = laneTmpBase(root);
  const dir = laneTmpDir(root, phase);
  if (path.dirname(dir) !== base) throw new Error(`${dir} not removed: it is not directly inside ${base}`);
  let link = false;
  try {
    link = fs.lstatSync(dir).isSymbolicLink(); // a junction too
  } catch {
    return null; // nothing there
  }
  let inside = false;
  try {
    inside = !link && path.dirname(fs.realpathSync.native(dir)) === fs.realpathSync.native(base);
  } catch { /* unresolvable: refused below */ }
  if (!inside) throw new Error(`${dir} not removed: it resolves outside ${base}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}
