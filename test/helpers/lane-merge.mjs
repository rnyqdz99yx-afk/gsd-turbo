import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ISOLATED, gitIn, mainProject, slotFixture } from './slots.mjs';
import { prepareSlot, setupSlots, slotGit } from '../../lib/slots.mjs';

export const PHASE_DIR = '.planning/phases/03-demo';
const put = (dir, rel, text) => {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

// A project (the control root) and its slot 1 holding one job (phase 3 by default) on its turbo/* branch, built with
// L0's own setup and prepare. Git runs isolated from the developer's config.
export function laneProject({ files = {}, config = {}, job = { kind: 'phase', phase: '3' } } = {}) {
  const main = mainProject({
    files: {
      '.planning/STATE.md': '# State\n\nStatus: Ready to execute\n',
      '.planning/REQUIREMENTS.md': '# Requirements\n\n- [ ] REQ-1\n',
      '.planning/turbo/config.json': `${JSON.stringify({ max_lanes: 1, ...config })}\n`,
      'src/app.js': 'export const app = 1;\n',
      ...files,
    },
  });
  const fx = slotFixture(main.root, { max: 1 });
  setupSlots(main.root, fx.config, fx.deps);
  const slot = prepareSlot(main.root, 1, job, fx.deps).path;
  const commitIn = (dir, message) => {
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', message);
    return gitIn(dir, 'rev-parse', 'HEAD');
  };
  return {
    root: main.root, slot, config: fx.config, fx, git: slotGit(ISOLATED),
    inMain: (...a) => gitIn(main.root, ...a), inSlot: (...a) => gitIn(slot, ...a),
    writeMain: (rel, text) => put(main.root, rel, text), writeSlot: (rel, text) => put(slot, rel, text),
    commitMain: (m) => commitIn(main.root, m), commitSlot: (m) => commitIn(slot, m),
  };
}

// The digest a fake gsd-tools gives, in GSD 1.16's v3 shape: each covered file's path and sha256 over its working-tree
// bytes, the phase's own plans and summaries added, repo-wide planning documents left out.
export function fakeDigest(root, files, phaseDir) {
  const own = fs.readdirSync(phaseDir).filter((f) => /-(PLAN|SUMMARY)\.md$/.test(f)).map((f) => path.relative(root, path.join(phaseDir, f)).split(path.sep).join('/'));
  const set = [...new Set([...files, ...own])].filter((f) => !/^\.planning\/[^/]+$/.test(f)).sort();
  const parts = set.map((f) => `${f}\n${createHash('sha256').update(fs.readFileSync(path.join(root, ...f.split('/')))).digest('hex')}\n`).join('');
  return `v3:sha256:${createHash('sha256').update(`v3\n${parts}`).digest('hex')}`;
}

// What a phase leaves in its slot: code, one plan with its summary, GSD's own STATE.md edit, and a passed verification
// fingerprinted over the slot's bytes. Returns the slot's new head.
export function finishPhase(p, { code = { 'src/feature.js': 'export const feature = 1;\n' } } = {}) {
  for (const [rel, text] of Object.entries(code)) p.writeSlot(rel, text);
  p.writeSlot(`${PHASE_DIR}/03-01-PLAN.md`, '---\nphase: 03-demo\nplan: 01\n---\n# Plan\n');
  p.writeSlot(`${PHASE_DIR}/03-01-SUMMARY.md`, '---\nphase: 03-demo\nplan: 01\n---\n# Summary\n');
  p.writeSlot('.planning/STATE.md', '# State\n\nStatus: Executing Phase 03\n');
  const files = Object.keys(code);
  const digest = fakeDigest(p.slot, files, path.join(p.slot, ...PHASE_DIR.split('/')));
  p.writeSlot(`${PHASE_DIR}/03-VERIFICATION.md`, ['---', 'phase: 03-demo', 'status: passed', 'score: 2/2 must-haves verified', 'covered_files:', ...files.map((f) => `  - ${f}`), `covered_digest: "${digest}"`, '---', '', '# Verification', ''].join('\n'));
  return p.commitSlot('feat(03): demo');
}
