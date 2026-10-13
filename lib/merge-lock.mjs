import path from 'node:path';
import { locksDir } from './paths.mjs';
import { withFileLock } from './questions.mjs';

// spec §5, §4.2: one file lock orders every write to the main branch in the control root: a lane's merge (L2), an
// owner's answer commit (L0), the merge of prep and annotate (L3). A slot's locksDir is its control root's.
export const MERGE_LOCK_WAIT_MS = 30000;
// a merge (merge, phase.complete, state-sync, commit) takes minutes at most: an older lock is a crash's
export const MERGE_LOCK_STALE_MS = 30 * 60 * 1000;
export class MergeLocked extends Error {}
export const mergeLockFile = (root) => path.join(locksDir(root), 'merge');

export function withMergeLock(root, fn, { waitMs = MERGE_LOCK_WAIT_MS, staleMs = MERGE_LOCK_STALE_MS, platform = process.platform } = {}) {
  const file = mergeLockFile(root);
  return withFileLock(file, fn, { waitMs, staleMs, platform, locked: () => new MergeLocked(`main is busy: another turbo-run holds the merge lock (${path.basename(file)}); try again`) });
}
