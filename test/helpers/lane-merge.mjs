import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ISOLATED, gitIn, mainProject, slotFixture } from './slots.mjs';
import { prepareSlot, setupSlots, slotGit } from '../../lib/slots.mjs';
import { writeLaneStatus } from '../../lib/run-status.mjs';
import { integrateMain, readyRecord } from '../../lib/integrate.mjs';
import { createGit } from '../../lib/push.mjs';
import { pushSettings } from '../../lib/config.mjs';

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

// The lane's end of §7.1, as turbo-run integrate 3 and turbo-run lane-status 3 ready --base <sha> do it. Each ready
// record gets its own time a second apart: the merge decides once per record (decision D5), keyed by its at.
let readyCount = 0;
export function reportReady(p, { reason = 'integrated' } = {}) {
  const r = integrateMain(p.slot, '3', { git: p.git });
  if (r.state === 'conflicts') throw new Error(`conflicts: ${r.conflicts.join(', ')}`);
  readyCount += 1;
  const at = new Date(Date.parse('2026-10-13T12:00:00.000Z') + readyCount * 1000).toISOString();
  writeLaneStatus(p.slot, '3', 'ready', { reason, at, fields: readyRecord(p.slot, '3', { base: r.base, git: p.git }) });
  return r;
}

// The supervisor.json lane entry of phase 3 in slot 1 (L0's Interfaces: owned by L1).
export const laneOf = (p) => ({ key: '3', job: 'phase', phase: '3', slot: 1, slotPath: p.slot, branch: 'turbo/p3', sessionId: null, launchedAt: '2026-10-13T12:00:00.000Z', restarts: 0, notified: {}, mode: 'full' });

const fpOf = (text) => ({
  files: [...text.matchAll(/^ {2}- (.+?)\r?$/gm)].map((m) => m[1]),
  digest: /^covered_digest: "?([^"\r\n]+)"?\r?$/m.exec(text)?.[1] ?? null,
  status: /^status: (\w+)\r?$/m.exec(text)?.[1] ?? null,
});

// gsd-tools as lib/merge.mjs calls it (deps.gsd), on the files of cwd: GSD 1.16's verification.fingerprint (--raw),
// verification status and phase.complete (which refuses a stale or not-passed report, then marks ROADMAP and STATE).
// fail: { '<first two args>': '<stderr line>' } makes that call fail as gsdText reports it.
export function fakeGsd({ calls = [], fail = {} } = {}) {
  return (args, { cwd }) => {
    calls.push(args.join(' '));
    const key = args.slice(0, 2).join(' ');
    if (fail[key]) throw new Error(`gsd-tools ${key} failed: ${fail[key]}`);
    const status = (dir) => {
      const name = fs.readdirSync(dir).find((n) => n.endsWith('-VERIFICATION.md'));
      if (!name) return 'missing';
      const v = fpOf(fs.readFileSync(path.join(dir, name), 'utf8'));
      return v.digest === fakeDigest(cwd, v.files, dir) ? v.status : 'stale';
    };
    if (key === 'query verification.fingerprint') return `${fakeDigest(cwd, args.slice(3).filter((a) => a !== '--raw'), args[2])}\n`;
    if (key === 'verification status') return JSON.stringify({ status: status(args[2]) });
    if (key === 'query phase.complete') {
      const s = status(path.join(cwd, ...PHASE_DIR.split('/')));
      if (s !== 'passed') throw new Error(`gsd-tools query phase.complete failed: Error: Phase ${args[2]} verification is incomplete: ${s === 'stale' ? 'Verification is stale' : `status ${s}`}`);
      fs.appendFileSync(path.join(cwd, '.planning', 'ROADMAP.md'), `- [x] Phase ${args[2]} complete\n`);
      fs.writeFileSync(path.join(cwd, '.planning', 'STATE.md'), `# State\n\nStatus: Phase ${args[2]} complete\n`);
      return JSON.stringify({ completed_phase: args[2], roadmap_updated: true, state_updated: true, requirements_updated: false, warnings: [] });
    }
    throw new Error(`fake gsd-tools: unexpected call ${args.join(' ')}`);
  };
}

// The supervisor's ctx for lib/merge.mjs: isolated git, the fake gsd-tools, no state-sync, recorded notifications.
export function mergeCtx(p, { push = { mode: 'off' }, lang = 'en', merge_rounds, gsd, now = '2026-10-13T13:00:00.000Z' } = {}) {
  const notes = [];
  const logs = [];
  const calls = [];
  const config = { ...p.config, lang, push: pushSettings(push), ...(merge_rounds === undefined ? {} : { merge_rounds }) };
  const ctx = {
    root: p.root,
    config,
    deps: {
      log: (line) => logs.push(line),
      notify: async (key, vars) => { notes.push([key, vars]); },
      now: () => new Date(now),
      gitAt: p.git,
      git: createGit(p.root, { env: ISOLATED }),
      gsd: gsd || fakeGsd({ calls }),
      stateSync: () => ({ synced: false, reason: 'test' }),
      mergeLockWaitMs: 200,
    },
  };
  return { ctx, notes, logs, calls };
}
