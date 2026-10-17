import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, tmpGitRepo } from './tmp.mjs';
import { gitIn } from './slots.mjs';
import { planText } from './whatif.mjs';

// A lane checkout for the build path (Stage 6 B2): phase <phase>'s plans (planText of helpers/whatif.mjs) in
// .planning/phases/<phase>-demo, turbo's config (slice worktrees under a temp lanes.dir, test.full node --test) with its
// run/logs/locks ignored, a package.json and a .gitignore for node_modules/, committed.
// Returns { root, rel, lanesDir, git(...args), write(rel, text), commit(msg) -> sha }.
export function buildRepo({ phase = '33', plans = [], config = {} } = {}) {
  const root = tmpGitRepo();
  const rel = `.planning/phases/${phase}-demo`;
  const lanesDir = path.join(tmpDir('slots'), 'app.turbo');
  const write = (f, text) => {
    const abs = path.join(root, ...f.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  const git = (...a) => gitIn(root, ...a);
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  for (const p of plans) write(`${rel}/${p.id}-PLAN.md`, planText(p));
  write('.planning/turbo/.gitignore', 'run/\nlogs/\nlocks/\n');
  write('.planning/turbo/config.json', `${JSON.stringify({ lanes: { dir: lanesDir }, test: { full: 'node --test' }, ...config }, null, 2)}\n`);
  write('package.json', `${JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } })}\n`);
  write('.gitignore', 'node_modules/\n.env\n');
  commit(`docs(${phase}): plans`);
  return { root, rel, lanesDir, git, write, commit };
}
