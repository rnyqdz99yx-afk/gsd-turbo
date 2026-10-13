import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { MergeLocked, withMergeLock } from './merge-lock.mjs';
import { commitPendingAnswers } from './answers.mjs';
import { SlotRefused, mainBranch, readSlotRecord, slotGit } from './slots.mjs';
import { readLaneStatus, writeLaneStatus } from './run-status.mjs';
import { appendInbox } from './inbox.mjs';
import { askOwner } from './questions.mjs';
import { holdFile } from './integrate.mjs';
import { mergeRounds } from './config.mjs';

// Stage 4 §7.2: the supervisor merges a lane's verified phase into the main branch, without an LLM, one writer at a time
// (locks/merge). Its record per phase, written only here: run/p<N>-merge.json in the control root. merge_rounds is
// read through lib/config.mjs mergeRounds (reconcile R6).
export const mergeFile = (root, phase) => path.join(runDir(root), `p${phase}-merge.json`);
export const mergeState = (root, phase) => readJson(mergeFile(root, phase), null);

const SHA = /^[0-9a-f]{40}$/;
const HOLD_RE = /^p(.+)-merge-hold\.json$/;
const ANSWERS_DIR = '.planning/turbo/answers/';
const short = (s) => String(s ?? '').slice(0, 12);
const firstLine = (e) => String(e?.message ?? e).split(/\r?\n/)[0].slice(0, 300);
// git -z output as names
const zList = (s) => String(s ?? '').split('\0').map((x) => x.replace(/^\n+/, '')).filter(Boolean);
const gitOf = (deps) => deps.gitAt || slotGit(deps.env || process.env);
// 0 yes, 1 no; a missing object (128) reads as no
function isAncestor(git, root, a, b) {
  try {
    return git(root, ['merge-base', '--is-ancestor', a, b], { ok: true }) !== null;
  } catch {
    return false;
  }
}
function tryGit(git, root, args) {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}


// The phases whose owner chose to wait while main moves too fast (decision D16): L1 starts no new phase while any.
export function mergeHolds(root) {
  let names = [];
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    return [];
  }
  return names.map((n) => HOLD_RE.exec(n)?.[1]).filter(Boolean).sort();
}

// The owner's card when main moves faster than the phase can merge (spec §7.2 p.3): plain words, the recommended first.
const MERGE_CARD = {
  en: (phase, n) => ({
    question: `Phase ${phase} cannot be merged: the main branch keeps changing before the phase catches up with it`,
    context: `Turbo asked the phase to catch up ${n} times in a row, and each time another merge came first.`,
    options: [
      { label: 'Wait', description: 'Turbo starts no new phases until this one is merged, and the phase catches up once more.' },
      { label: 'I will merge it myself', description: 'The phase stops here; you merge it into the main branch yourself and then resume it.' },
    ],
    recommended: 1,
  }),
  ru: (phase, n) => ({
    question: `Фазу ${phase} не удаётся влить: основная ветка меняется быстрее, чем фаза успевает её догнать`,
    context: `Turbo ${n} раз подряд просил фазу догнать основную ветку, и каждый раз раньше вливалось что-то другое.`,
    options: [
      { label: 'Подождать', description: 'Turbo не запускает новые фазы, пока эта не вольётся, а фаза догоняет основную ветку ещё раз.' },
      { label: 'Волью сам', description: 'Фаза останавливается; вы сами вливаете её в основную ветку и затем возобновляете её.' },
    ],
    recommended: 1,
  }),
};

// Why the main checkout cannot take a merge now, or null (decision D7): on the job's main branch, no merge in progress,
// no tracked change except the owner's answers (committed after the merge, decision D6).
export function mainNotReady(git, root, want) {
  let branch;
  try {
    branch = mainBranch(root, { git });
  } catch (e) {
    if (e instanceof SlotRefused) return e.message;
    throw e;
  }
  if (branch !== want) return `the main checkout is on ${branch}, not on ${want}`;
  if (git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { ok: true }) !== null) return 'a merge is in progress in the main checkout';
  const dirty = git(root, ['status', '--porcelain', '--untracked-files=no']).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3)).filter((p) => !p.startsWith(ANSWERS_DIR));
  if (dirty.length) return `the main checkout has uncommitted changes: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''}`;
  return null;
}

// Inside the merge lock, synchronous (withFileLock releases when fn returns): every git and gsd-tools call is sync, and
// the notifications are returned for mergeReady to send after the lock.
function mergeLocked(ctx, lane, rec) {
  const { root, config, deps } = ctx;
  const git = gitOf(deps);
  const phase = String(lane.phase);
  const nowDate = deps.now ? deps.now() : new Date();
  const now = nowDate.toISOString();
  const notes = [];
  const mr = mergeState(root, phase) || { v: 1, phase, rounds: 0 };
  const save = (fields) => writeJsonAtomic(mergeFile(root, phase), Object.assign(mr, fields, { at: now }));
  const wait = (reason) => ({ result: { outcome: 'wait', reason }, notes });
  const done = (result, fields) => {
    save({ ...fields, readyAt: rec.at, outcome: result.outcome, reason: result.reason ?? null });
    return { result, notes };
  };
  // L1's mergeStep tells the owner about a needs-owner outcome (laneNeedsOwner, once per lane): no second notification
  const owner = (reason, fields = {}) => {
    writeLaneStatus(root, phase, 'needs-owner', { reason, at: now });
    return done({ outcome: 'needs-owner', reason }, { state: 'needs-owner', ...fields });
  };
  // decision D5: one decision per ready record; only a merge a crash interrupted is taken up again
  if (mr.readyAt === rec.at && mr.state !== 'merging') return wait(`phase ${phase}'s ready record was handled already (${mr.state})`);
  const want = readSlotRecord(lane.slotPath)?.job?.base?.branch;
  if (!want) return wait(`slot ${lane.slot} holds no job record for phase ${phase}`);
  const why = mainNotReady(git, root, want);
  if (why) {
    if (mr.waitNotified !== why) {
      notes.push(['mergeWaiting', { phase, why }]);
      save({ waitNotified: why });
    }
    return wait(why);
  }
  const head = git(root, ['rev-parse', 'HEAD']);
  // decision D9: the lane's head already in main (a restart after a crash, a repeat after needs-owner): no second merge
  const inMain = isAncestor(git, root, rec.head, 'HEAD');
  let mergeSha = inMain ? (mr.mergeSha ?? null) : null;
  if (!inMain) {
    if (head !== rec.base) {
      // spec §7.2 p.3: main moved since the lane's integrate; up to merge_rounds in a row, then the owner (D16)
      const max = mergeRounds(config);
      const hold = readJson(holdFile(root, phase), null);
      const fresh = typeof hold?.at === 'string' && hold.at !== mr.holdAt;
      const round = (fresh ? 0 : Number(mr.rounds) || 0) + 1;
      const holdFields = fresh ? { holdAt: hold.at } : {};
      if (round > max) {
        const lang = config.lang === 'ru' ? 'ru' : 'en';
        const asked = askOwner(root, phase, MERGE_CARD[lang](phase, max), { lang, now: nowDate });
        return done({ outcome: 'needs-owner', reason: `the main branch moved ${max} times in a row before phase ${phase} could be merged; owner question ${asked.question.id}` }, { state: 'needs-owner', rounds: max, ...holdFields });
      }
      appendInbox(root, phase, { kind: 'reintegrate', base: head, was: rec.base, round, of: max }, { now: nowDate });
      return done({ outcome: 'reintegrate', reason: `main is at ${short(head)}, the lane integrated ${short(rec.base)} (round ${round} of ${max})` }, { state: 'reintegrate', rounds: round, ...holdFields });
    }
    // spec §7.2 p.2 (D8): exactly the tip the lane verified and reported ready
    git(root, ['fetch', '--quiet', '--no-tags', lane.slotPath, `refs/heads/${lane.branch}`]);
    const tip = git(root, ['rev-parse', 'FETCH_HEAD']);
    if (tip !== rec.head) return wait(`the lane's branch ${lane.branch} is at ${short(tip)}, not at the ${short(rec.head)} it reported ready; waiting for its next ready`);
    save({ state: 'merging', readyAt: rec.at, laneHead: rec.head, base: rec.base, slot: lane.slot, branch: lane.branch, mergeSha: null, waitNotified: null });
    try {
      git(root, ['merge', '--no-ff', '--no-edit', '-m', `Merge phase ${phase} (turbo lane ${lane.slot})`, rec.head]);
    } catch (e) {
      tryGit(git, root, ['merge', '--abort']);
      return owner(`merging phase ${phase} into ${want} failed: ${firstLine(e)}; nothing was merged`);
    }
    mergeSha = git(root, ['rev-parse', 'HEAD']);
    save({ mergeSha });
  } else if (mr.state !== 'merging') {
    save({ state: 'merging', readyAt: rec.at, laneHead: rec.head, base: rec.base, slot: lane.slot, branch: lane.branch, waitNotified: null });
  }
  // decision D6: the owner's answers that came in meanwhile go on top of the merge
  try {
    commitPendingAnswers(root);
  } catch (e) {
    deps.log(`merge p${phase}: owner answers not committed: ${firstLine(e)}`);
  }
  // §7.2 p.4–6: Task 5 (re-stamp, phase.complete, the commit, the push request)
  const finalSha = git(root, ['rev-parse', 'HEAD']);
  return done({ outcome: 'merged', sha: finalSha }, { state: 'merged', rounds: 0, mergeSha, finalSha, ciRed: null, ownerNotified: null });
}

// Stage 4 §7.2, called by L1 for a lane whose record says ready. At most one decision per ready record (D5); every
// other call waits. Notifications go out after the lock (D19): only mergeWaiting, since L1 notifies needs-owner itself.
export async function mergeReady(ctx, lane) {
  const { root, deps } = ctx;
  const phase = String(lane?.phase ?? '');
  const rec = readLaneStatus(root, phase);
  if (rec?.status !== 'ready' || !SHA.test(String(rec.base ?? '')) || !SHA.test(String(rec.head ?? '')) || rec.branch !== lane?.branch) {
    return { outcome: 'wait', reason: `phase ${phase} has no ready record for ${lane?.branch}` };
  }
  let r;
  try {
    r = withMergeLock(root, () => mergeLocked(ctx, lane, rec), { waitMs: deps.mergeLockWaitMs ?? 2000 });
  } catch (e) {
    if (e instanceof MergeLocked) return { outcome: 'wait', reason: e.message };
    deps.log(`merge p${phase}: ${firstLine(e)}`);
    return { outcome: 'wait', reason: `the merge stopped: ${firstLine(e)}` };
  }
  for (const [key, vars] of r.notes) {
    try {
      await deps.notify(key, vars);
    } catch (e) {
      deps.log(`merge p${phase}: notify ${key}: ${firstLine(e)}`);
    }
  }
  const { outcome, reason, sha } = r.result;
  if (outcome !== 'wait') deps.log(`merge p${phase}: ${outcome}${sha ? ` ${short(sha)}` : ''}${reason ? `: ${reason}` : ''}`);
  return r.result;
}

// Stage 4 §7.2 p.6–7, called by L1 every tick while mergeState says merged (reconcile R5): push, CI, release. Until
// the follow-up lands it keeps the slot.
export async function mergeFollowUp() {
  return { outcome: 'wait', reason: 'the merge follow-up is not implemented yet' };
}
