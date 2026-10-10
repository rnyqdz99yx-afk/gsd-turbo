import fs from 'node:fs';
import path from 'node:path';

const isFile = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

// The absolute path of a program in PATH, found the way it is safe to run it from a project. Windows looks for a bare
// program name in the child's working directory first (unless NoDefaultCurrentDirectoryInExePath is set), so a
// git.exe placed in a project would run; an empty or relative PATH entry names the working directory too. Only
// absolute PATH directories outside every `exclude` directory (the project) count, and on Windows the program is
// <name>.exe. null when none has it.
export function whichAbsolute(name, { env = process.env, platform = process.platform, exclude = [], exists = isFile } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const key = Object.keys(env).find((k) => (win ? k.toUpperCase() === 'PATH' : k === 'PATH'));
  const absolute = (d) => (win ? /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(d) : d.startsWith('/'));
  const inside = (dir, root) => {
    const rel = p.relative(p.resolve(root), p.resolve(dir));
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
  };
  for (const entry of String(key ? env[key] : '').split(win ? ';' : ':')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!absolute(dir) || exclude.some((root) => root && inside(dir, root))) continue;
    const file = p.join(dir, win ? `${name}.exe` : name);
    if (exists(file)) return file;
  }
  return null;
}
