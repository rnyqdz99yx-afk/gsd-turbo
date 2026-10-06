import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function tmpDir(prefix = 't') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `turbo-${prefix}-`)));
}

export function tmpGitRepo() {
  const dir = tmpDir('git');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}
