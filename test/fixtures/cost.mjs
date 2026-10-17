import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic cost data for test/cost.test.mjs and test/cli-cost.test.mjs (Stage 6 M). Never a real transcript.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Phase 4 on the build path: run/cost-p4.json (four headless sessions) and two PLAN files.
export function writeBuildPhase4(root) {
  const run = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.copyFileSync(path.join(HERE, 'cost-p4.json'), path.join(run, 'cost-p4.json'));
  const dir = path.join(root, '.planning', 'phases', '04-build');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '04-01-PLAN.md'), '# plan 04-01\n');
  fs.writeFileSync(path.join(dir, '04-02-PLAN.md'), '# plan 04-02\n');
}
