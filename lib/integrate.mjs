import path from 'node:path';
import { isSlot, runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { readSlotRecord, slotGit } from './slots.mjs';

// Stage 4 §7.1 p.1: the files whose main-branch version a lane always takes; the supervisor marks the phase in them
// after the merge (gsd-tools phase.complete in main).
export const SHARED_PLANNING = Object.freeze(['.planning/STATE.md', '.planning/ROADMAP.md', '.planning/REQUIREMENTS.md']);
// run files of the lane (stateRoot: they land in the control root)
export const integrateFile = (root, phase) => path.join(runDir(root), `p${phase}-integrate.json`);
export const holdFile = (root, phase) => path.join(runDir(root), `p${phase}-merge-hold.json`);

export class IntegrateRefused extends Error {}
const refuse = (text) => { throw new IntegrateRefused(text); };
const lines = (s) => String(s ?? '').split(/\r?\n/).filter(Boolean);
const changedTracked = (git, root) => lines(git(root, ['status', '--porcelain', '--untracked-files=no'])).map((l) => l.slice(3));
const inMerge = (git, root) => git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { ok: true }) !== null;

// The slot's active job for this phase, or a refusal.
function phaseJob(root, phase) {
  const job = readSlotRecord(root)?.job;
  if (!job || job.kind !== 'phase' || String(job.phase) !== String(phase) || job.state !== 'active') refuse(`this slot holds no active job of phase ${phase}`);
  return job;
}

function onJobBranch(git, root, job) {
  const current = git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: true });
  if (current !== job.branch) refuse(`the slot is on ${current || 'a detached HEAD'}, not on ${job.branch}`);
}

// Stage 4 §7.1 p.1, in the lane's slot: fetch the main branch, merge it into the phase branch, take main's three shared
// planning files, and commit at once when nothing conflicts (decision D2). A conflicted merge stays in progress for the
// lane; the next call, after the lane staged its resolutions, takes the three files again and commits.
export function integrateMain(root, phase, { git = slotGit(), now = new Date() } = {}) {
  if (!isSlot(root)) return { state: 'not-slot' };
  const job = phaseJob(root, phase);
  const main = job.base.branch;
  onJobBranch(git, root, job);
  const record = (fields) => writeJsonAtomic(integrateFile(root, phase), { phase: String(phase), main, branch: job.branch, ...fields, at: now.toISOString() });
  let base;
  if (inMerge(git, root)) {
    base = git(root, ['rev-parse', 'MERGE_HEAD']);
    const rec = readJson(integrateFile(root, phase), null);
    if (rec?.base !== base) refuse(`a merge of ${base.slice(0, 12)} is in progress that turbo-run integrate did not start: finish it or abort it (git merge --abort) first`);
  } else {
    const dirty = changedTracked(git, root);
    if (dirty.length) refuse(`uncommitted changes: ${dirty.slice(0, 5).join(', ')}; commit or discard them first`);
    git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${main}:refs/remotes/origin/${main}`]);
    base = git(root, ['rev-parse', '--verify', `refs/remotes/origin/${main}^{commit}`]);
    record({ base, state: 'merging' });
    try {
      git(root, ['merge', '--no-ff', '--no-commit', '--no-edit', base]);
    } catch (e) {
      // exit 1 with MERGE_HEAD: conflicts, handled below; anything else never started a merge
      if (!inMerge(git, root)) refuse(`git merge ${base.slice(0, 12)} did not start: ${String(e?.message ?? e).split(/\r?\n/)[0]}`);
    }
  }
  // §7.1 p.1: main's version of the three files, at a conflict and always after the merge (decision D3)
  for (const f of SHARED_PLANNING) {
    if (git(root, ['ls-tree', '--name-only', base, '--', f])) git(root, ['checkout', base, '--', f]);
    else git(root, ['rm', '-q', '-f', '--ignore-unmatch', '--', f]);
  }
  const conflicts = lines(git(root, ['diff', '--name-only', '--diff-filter=U']));
  if (conflicts.length) {
    record({ base, state: 'conflicts', conflicts });
    return { state: 'conflicts', base, main, conflicts };
  }
  let state = 'up-to-date';
  if (inMerge(git, root)) {
    git(root, ['commit', '-q', '-m', `Merge ${main} into ${job.branch} (turbo integrate)`]);
    state = 'merged';
  } else if (git(root, ['diff', '--cached', '--quiet'], { ok: true }) === null) {
    git(root, ['commit', '-q', '-m', `chore(phase-${phase}): take ${SHARED_PLANNING.map((f) => path.posix.basename(f)).join(', ')} from ${main} (turbo integrate)`]);
    state = 'shared';
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  record({ base, state: 'integrated', head });
  return { state, base, main, head };
}

// Decision D16: the owner chose to wait while main moves faster than this phase merges; L1 starts no new phase while a
// hold exists, and the supervisor's merge gives the phase a fresh round budget. Removed at the slot's release.
export function setMergeHold(root, phase, { now = new Date() } = {}) {
  if (!isSlot(root)) throw new IntegrateRefused('--hold is for a lane in a slot (lanes.mode slots)');
  const rec = { phase: String(phase), at: now.toISOString() };
  writeJsonAtomic(holdFile(root, phase), rec);
  return rec;
}

const SHA = /^[0-9a-f]{40}$/;

// Stage 4 §7.1 p.4 (decision D1): what turbo-run lane-status N ready --base <sha> records for the supervisor. Refuses
// anything the supervisor must not merge: another base than the last finished integrate, another branch, uncommitted
// tracked changes, a merge in progress, a head that does not hold the base.
export function readyRecord(root, phase, { base, git = slotGit() } = {}) {
  if (!isSlot(root)) refuse('lane-status ready is for a lane in a slot (lanes.mode slots); outside a slot the close step records done');
  if (!SHA.test(String(base ?? ''))) refuse('--base needs the full 40-hex sha that turbo-run integrate printed on its base line');
  const job = phaseJob(root, phase);
  const rec = readJson(integrateFile(root, phase), null);
  if (rec?.state !== 'integrated' || rec.base !== base) {
    refuse(`--base ${base.slice(0, 12)} is not the base of the last finished turbo-run integrate ${phase}${rec?.base ? ` (that is ${rec.base.slice(0, 12)}, ${rec.state})` : ''}: run turbo-run integrate ${phase} first`);
  }
  onJobBranch(git, root, job);
  if (inMerge(git, root)) refuse(`a merge is still in progress: finish it with turbo-run integrate ${phase}`);
  const dirty = changedTracked(git, root);
  if (dirty.length) refuse(`uncommitted changes: ${dirty.slice(0, 5).join(', ')}; commit them first`);
  if (git(root, ['merge-base', '--is-ancestor', base, 'HEAD'], { ok: true }) === null) refuse(`HEAD does not hold the base ${base.slice(0, 12)}: run turbo-run integrate ${phase} again`);
  return { base, head: git(root, ['rev-parse', 'HEAD']), branch: job.branch, slot: readSlotRecord(root).k };
}
