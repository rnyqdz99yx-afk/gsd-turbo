import { execFileSync } from 'node:child_process';
import { dirNameMatchesPhase } from './phase-files.mjs';
import { LANES_REL, ROADMAP_REL } from './lanes-file.mjs';

// spec §6.2 (D9): the owner's dependency card lives under this pseudo-phase id; it is never a phase.
export const ANNOTATE_PHASE = 'annotate';
export const DECISIONS_DIR_REL = '.planning/decisions';
export const DECISIONS_FILE_REL = '.planning/turbo/DECISIONS.md';

const segments = (rel) => String(rel).replace(/\\/g, '/').split('/');
const unsafe = (parts) => parts.some((s) => s === '' || s === '.' || s === '..');

// spec §6.1: a prep branch changes only .planning/phases/<N>-*/** (files inside the phase's own directory).
export function prepAllowed(phase) {
  return (rel) => {
    const parts = segments(rel);
    return !unsafe(parts) && parts.length >= 4 && parts[0] === '.planning' && parts[1] === 'phases' && dirNameMatchesPhase(parts[2], phase);
  };
}

// spec §6.2: an annotate branch changes only the ROADMAP, lanes.json and the decision files.
export function annotateAllowed() {
  return (rel) => {
    const parts = segments(rel);
    if (unsafe(parts)) return false;
    const p = parts.join('/');
    return p === ROADMAP_REL || p === LANES_REL || p === DECISIONS_FILE_REL || (p.startsWith(`${DECISIONS_DIR_REL}/`) && parts.length > 2);
  };
}

// L2's mergePlanningOnly(ctx, lane, { allowed }) gets this predicate for a prep or annotate lane.
export function allowedFor(job) {
  if (job?.kind === 'prep') return prepAllowed(job.phase);
  if (job?.kind === 'annotate') return annotateAllowed();
  throw new Error(`no planning-only merge for a ${job?.kind} job`);
}

export const gitIn = (root) => (args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })).replace(/\r/g, '');

// What would keep this job's branch from a planning-only merge: uncommitted paths (a merge takes commits only), and the
// paths the branch changed since base (net: a path put back is no change) that the job may not change.
export function outOfScope(root, job, { base = null, git = gitIn(root) } = {}) {
  const allowed = allowedFor(job);
  const dirty = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean).map((l) => l.slice(3));
  const changed = base ? git(['diff', '--name-only', '--no-renames', base, 'HEAD']).split('\n').filter(Boolean) : [];
  return { dirty, outside: changed.filter((p) => !allowed(p)) };
}
