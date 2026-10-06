import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function tmpDir(prefix = 't') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `turbo-${prefix}-`)));
}

// A repository unaffected by the developer's git config: the helper's own calls see no global or
// system config (hooks, templates, autocrlf), and the local settings below override the global
// ones for every later git call in the tests too. A missing GIT_CONFIG_GLOBAL file reads as empty
// (os.devNull does not work with Git for Windows).
export function tmpGitRepo() {
  const dir = tmpDir('git');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, '.git', 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', path.join(dir, '.git', 'hooks'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}
