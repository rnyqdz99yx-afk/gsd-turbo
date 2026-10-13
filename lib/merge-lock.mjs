import path from 'node:path';
import { locksDir } from './paths.mjs';
import { withFileLock } from './questions.mjs';

// spec §5, §4.2: one file lock orders every write to the main branch in the control root: a lane's merge (L2), an
// owner's answer commit (L0), the merge of prep and annotate (L3). A slot's locksDir is its control root's. It is held
// for the merge and its commits only: never while pushing or waiting for CI.
export const MERGE_LOCK_WAIT_MS = 30000;
// a merge (merge, phase.complete, state-sync, commit) takes minutes at most: an older lock whose owner is dead is a
// crash's; the owner's liveness decides first, the age only guards a dead pid
export const MERGE_LOCK_STALE_MS = 30 * 60 * 1000;
export class MergeLocked extends Error {}
export const mergeLockFile = (root) => path.join(locksDir(root), 'merge');

// Whether a process with this pid runs on this machine: kill(pid, 0) throws ESRCH only when there is none.
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

// The lock token is `<pid>-<uuid>` (withFileLock): a token without a pid has no owner to ask.
const ownerAlive = (alive) => (token) => {
  const pid = Number(/^(\d+)-/.exec(String(token))?.[1]);
  return Number.isInteger(pid) && pid > 0 && alive(pid);
};

export function withMergeLock(root, fn, { waitMs = MERGE_LOCK_WAIT_MS, staleMs = MERGE_LOCK_STALE_MS, platform = process.platform, alive = pidAlive } = {}) {
  const file = mergeLockFile(root);
  return withFileLock(file, fn, { waitMs, staleMs, platform, alive: ownerAlive(alive), locked: () => new MergeLocked(`main is busy: another turbo-run holds the merge lock (${path.basename(file)}); try again`) });
}
