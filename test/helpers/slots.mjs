import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './tmp.mjs';
import { CONTROL_ENV, slotRecordFile } from '../../lib/paths.mjs';

// A test process never inherits a lane's control root: turbo's own tests may run inside a turbo lane.
delete process.env[CONTROL_ENV];

// git without the developer's global or system config (hooks, templates, autocrlf): for the tests' own git calls and,
// as deps.env, for lib/slots.mjs.
export const ISOLATED = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmpDir('gitcfg'), 'none'), GIT_CONFIG_NOSYSTEM: '1' };
export const gitIn = (dir, ...args) => execFileSync('git', args, { cwd: dir, env: ISOLATED, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).replace(/\r?\n$/, '');

// A main checkout with .planning/turbo/ (its run, logs and locks ignored), committed.
export function controlProject() {
  const root = tmpGitRepo();
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'turbo', '.gitignore'), 'run/\nlogs/\nlocks/\n');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'turbo');
  return root;
}

// A slot as lib/slots.mjs leaves it, built without it: a repository whose origin is the control root, with .planning
// and its record.
export function fakeSlot({ control = controlProject(), record = {} } = {}) {
  const slot = tmpDir('slot');
  gitIn(slot, 'init', '-q');
  gitIn(slot, 'remote', 'add', 'origin', control);
  fs.mkdirSync(path.join(slot, '.planning'), { recursive: true });
  fs.writeFileSync(slotRecordFile(slot), JSON.stringify({ v: 1, k: 1, path: slot, control, createdAt: '2026-10-13T10:00:00.000Z', copied: [], job: null, ...record }));
  return { control, slot };
}
