import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './tmp.mjs';
import { CONTROL_ENV, slotRecordFile } from '../../lib/paths.mjs';
import { DEFAULTS } from '../../lib/config.mjs';

// A test process never inherits a lane's control root: turbo's own tests may run inside a turbo lane.
delete process.env[CONTROL_ENV];

// git without the developer's global or system config (hooks, templates, autocrlf): for the tests' own git calls and,
// as deps.env, for lib/slots.mjs.
export const ISOLATED = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmpDir('gitcfg'), 'none'), GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: tmpDir('xdg') };
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

// A main checkout as a project has it: .gitignore, .planning (ROADMAP, turbo config and its .gitignore), a tracked
// api/ directory and the given files, committed. Untracked files are written afterwards with write().
export function mainProject({ ignore = ['.env', '.env.local', 'node_modules', 'dist/', '.claude/settings.local.json'], files = {} } = {}) {
  const root = tmpGitRepo();
  const write = (rel, text) => {
    const f = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  };
  write('.gitignore', `${ignore.join('\n')}\n`);
  write('.planning/ROADMAP.md', '# Roadmap\n');
  write('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  write('.planning/turbo/config.json', `${JSON.stringify({ max_lanes: 2 })}\n`);
  write('api/index.js', 'export {};\n');
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'project');
  return { root, write, git: (...a) => gitIn(root, ...a) };
}

// Where a test's slots live (a temp directory, never next to the developer's projects), its Claude Code config copy,
// its config and the deps lib/slots.mjs takes: isolated git, a fixed clock, a fake installer that records its calls.
export function slotFixture(root, { max = 2, lanes = {} } = {}) {
  const dir = path.join(tmpDir('slots'), 'app.turbo');
  const home = tmpDir('home');
  const claudeJson = path.join(home, '.claude.json');
  fs.writeFileSync(claudeJson, `${JSON.stringify({ projects: {} }, null, 2)}\n`);
  const config = { ...structuredClone(DEFAULTS), max_lanes: max, lanes: { ...DEFAULTS.lanes, dir, ...lanes } };
  const calls = [];
  const deps = {
    env: ISOLATED,
    claudeJson,
    config,
    now: () => new Date('2026-10-13T12:00:00.000Z'),
    run: (command, { cwd }) => {
      calls.push({ command, cwd });
      fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
      return { code: 0, tail: '' };
    },
  };
  return { dir, home, claudeJson, config, deps, calls };
}
