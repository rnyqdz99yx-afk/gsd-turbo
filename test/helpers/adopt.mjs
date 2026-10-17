import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpGitRepo } from './tmp.mjs';
import { fakeGsdCore } from './fake-gsd.mjs';
import { ROADMAP } from '../fixtures/roadmap-lanes.mjs';
import { runGsdJson } from '../../lib/gsd.mjs';
import { createGsdConfig } from '../../lib/gates.mjs';

// /turbo-adopt's fixtures: a git project on GSD (fake core in .claude/, ignored) with the synthetic ROADMAP, phase 4
// waiting on 2 and 3. Phase 1 is checked off with a stale committed verification (closed-stale), 2 is fresh, 3 discussed
// (CONTEXT.md), 4 fresh.
export const ROADMAP4 = ROADMAP.replace('**Goal**: Docs for the API', '**Depends on**: Phase 2, Phase 3\n**Goal**: Docs for the API');
const row = (number, o) => ({ number, name: `P${number}`, dep_phases: [], phase_complete: false, roadmap_complete: false, implementation_complete: false, plan_count: 0, summary_count: 0, has_context: false, is_active: false, verification_status: null, disk_status: 'empty', ...o });
export const closedRow = (n, deps = []) => row(n, { dep_phases: deps, disk_status: 'executed', roadmap_complete: true, implementation_complete: true, plan_count: 1, summary_count: 1, verification_status: 'stale' });
export const MANAGER = {
  milestone_version: 'v1',
  phases: [closedRow('1'), row('2', { dep_phases: ['1'] }), row('3', { dep_phases: ['2'], has_context: true, disk_status: 'discussed' }), row('4', { dep_phases: ['2', '3'] })],
};
export const STALE_REPORT = '---\nphase: 01-base\nstatus: stale\n---\n\n# Verification\n\nold report\n';

export const gitText = (root) => (args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
export function write(root, rel, text) {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

// files: more files to commit; config: .planning/turbo/config.json (null: none, as before init).
export function adoptProject({ manager = MANAGER, files = {}, config = null, roadmap = ROADMAP4 } = {}) {
  const root = tmpGitRepo();
  write(root, '.gitignore', '.claude/\n');
  write(root, '.planning/ROADMAP.md', roadmap);
  write(root, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  write(root, '.planning/phases/01-base/01-01-PLAN.md', '---\nwave: 1\n---\n');
  write(root, '.planning/phases/01-base/01-01-SUMMARY.md', 'done\n');
  write(root, '.planning/phases/01-base/01-VERIFICATION.md', STALE_REPORT);
  write(root, '.planning/phases/03-web/03-CONTEXT.md', '# ctx\n');
  if (config) write(root, '.planning/turbo/config.json', JSON.stringify(config));
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  const git = gitText(root);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'project']);
  const core = fakeGsdCore(root, { manager });
  return { root, core, git, deps: adoptDeps(root, core) };
}

export function adoptDeps(root, core, over = {}) {
  return {
    core,
    gsd: (args) => runGsdJson(core, args, { cwd: root }),
    gsdGet: (key) => createGsdConfig({ root, core }).get(key),
    git: gitText(root),
    supervisor: () => ({ alive: false, pid: null, lanes: [], attended: [], why: null }),
    doctorMode: () => 'full',
    ...over,
  };
}

// Commits everything (the tests' own edits: adopt refuses a dirty tree).
export function commitAll(root, message = 'edit') {
  gitText(root)(['add', '-A']);
  gitText(root)(['commit', '-q', '-m', message]);
}
