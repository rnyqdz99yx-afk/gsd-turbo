import fs from 'node:fs';
import path from 'node:path';
import { gsdCoreDir, runDir } from './paths.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { gsdText } from './gates.mjs';
import { stateSync } from './state-sync.mjs';
import { describeRecord, recordFile, requestPush } from './push.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { MergeLocked, withMergeLock } from './merge-lock.mjs';
import { commitPendingAnswers } from './answers.mjs';
import { SlotRefused, mainBranch, readSlotRecord, releaseSlot, slotGit } from './slots.mjs';
import { completeStep, nextStep, readProgress } from './phase-progress.mjs';
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

const DIGEST = /^v\d+:sha256:[0-9a-f]{64}$/;
// GSD 1.16 isSharedPlanningDoc: a direct child of .planning/ never enters a phase's digest
const SHARED_DOC = /^\.planning\/[^/]+$/;

// covered_files and covered_digest of a *-VERIFICATION.md frontmatter (GSD 1.16 #4155): a block or a flow list, quoted
// or plain values. null for a report without both (GSD's legacy mtime check).
export function verificationFingerprint(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? '').replace(/^\uFEFF/, ''));
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
  let files = null;
  let digest = null;
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    if (kv[1] === 'covered_digest') digest = unquote(kv[2]);
    if (kv[1] !== 'covered_files') continue;
    const flow = /^\[(.*)\]$/.exec(kv[2].trim());
    if (flow) files = flow[1].split(',').map(unquote).filter(Boolean);
    else {
      files = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) files.push(unquote(lines[++i].replace(/^\s*-\s+/, '')));
    }
  }
  return files?.length && digest ? { files, digest } : null;
}

// The report with its one covered_digest line carrying digest, its quotes and line ending kept; null unless the
// frontmatter has exactly one such line (decision D11).
export function restampDigest(text, digest) {
  let n = 0;
  const out = String(text).replace(/^(---\r?\n[\s\S]*?\r?\n---)/, (fm) => fm.replace(/^(covered_digest:[ \t]*)(["']?)[^\r\n"']*\2([ \t]*)$/gm, (_, key, q, tail) => {
    n += 1;
    return `${key}${q}${digest}${q}${tail}`;
  }));
  return n === 1 ? out : null;
}

// decision D13: state-sync's own commit is folded into the merge's one commit
export function quietCommits(gsd) {
  return (args) => (args[0] === 'commit' ? { committed: false, skipped: true, reason: 'the turbo merge commits it' } : gsd(args));
}

function gsdOf(root, deps) {
  if (deps.gsd) return deps.gsd;
  return (args, { cwd }) => {
    const core = gsdCoreDir(root);
    if (!core) throw new Error('gsd-core not found (run turbo-run doctor)');
    return gsdText(core, cwd, args);
  };
}
const jsonOf = (text) => {
  const s = String(text ?? '');
  const at = s.indexOf('{');
  try {
    return at < 0 ? null : JSON.parse(s.slice(at));
  } catch {
    return null;
  }
};
function syncState(root, phase, deps) {
  if (deps.stateSync) return deps.stateSync(root, phase);
  const gsd = gsdOf(root, deps);
  return stateSync({ root, phase, gsd: quietCommits((args) => jsonOf(gsd(args, { cwd: root }))) });
}

// Every tracked change under .planning/ in one commit (decision D13); the new head, or null when nothing changed.
function commitPlanning(git, root, message) {
  if (!zList(git(root, ['diff', '--name-only', '-z', 'HEAD', '--', '.planning'])).length) return null;
  git(root, ['add', '-u', '--', '.planning']);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
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
  // spec §7.2 p.4 (S3, D10, D11): the covered files are the lane's blobs; this checkout's bytes may differ (core.autocrlf),
  // so the fingerprint is taken again here and written into the report
  const gsd = gsdOf(root, deps);
  let stage = 'the verification fingerprint';
  let stamped = false;
  try {
    const dir = findPhaseDir(root, phase);
    const name = dir ? phaseArtifacts(dir).verification : null;
    const file = name ? path.join(dir, name) : null;
    const fp = file ? verificationFingerprint(fs.readFileSync(file, 'utf8')) : null;
    if (fp) {
      const relDir = path.relative(root, dir).split(path.sep).join('/');
      const differ = zList(git(root, ['diff', '--name-only', '-z', '--no-renames', rec.head, 'HEAD', '--', ...fp.files, relDir])).filter((f) => !SHARED_DOC.test(f));
      if (differ.length) return owner(`the merged tree differs from what phase ${phase}'s verification covered: ${differ.slice(0, 10).join(', ')}${differ.length > 10 ? ` and ${differ.length - 10} more` : ''}; the merge stays`, { mergeSha });
      const digest = String(gsd(['query', 'verification.fingerprint', dir, ...fp.files, '--raw'], { cwd: root })).trim();
      if (!DIGEST.test(digest)) return owner(`gsd-tools verification.fingerprint gave no digest for phase ${phase} (${digest.slice(0, 80)}); the merge stays`, { mergeSha });
      if (digest !== fp.digest) {
        const text = restampDigest(fs.readFileSync(file, 'utf8'), digest);
        if (text === null) return owner(`phase ${phase}'s verification report has no single covered_digest line to re-stamp; the merge stays`, { mergeSha });
        fs.writeFileSync(file, text);
        stamped = true;
      }
    }
    if (!mr.completed) {
      // spec §7.2 p.5 (G6, D12, D13): GSD marks the phase in ROADMAP, REQUIREMENTS and STATE; turbo commits once
      stage = 'gsd-tools query phase.complete';
      try {
        gsd(['query', 'phase.complete', phase], { cwd: root });
      } catch (e) {
        const stampSha = stamped ? commitPlanning(git, root, `docs(phase-${phase}): re-stamp verification after the merge (turbo merge)`) : null;
        return owner(`phase.complete failed after the merge of phase ${phase}: ${firstLine(e)}; the merge stays`, { mergeSha, stampSha });
      }
      stage = 'state-sync';
      try {
        syncState(root, phase, deps);
      } catch (e) {
        deps.log(`merge p${phase}: state-sync: ${firstLine(e)}`);
      }
      stage = 'the commit';
      save({ completed: true, completeSha: commitPlanning(git, root, `docs(phase-${phase}): complete phase (turbo merge)`) });
    } else if (stamped) {
      // a fix merged after the phase was completed (red CI): only the fingerprint
      stage = 'the commit';
      commitPlanning(git, root, `docs(phase-${phase}): re-stamp verification (turbo merge)`);
    }
  } catch (e) {
    return owner(`${stage} failed after the merge of phase ${phase}: ${firstLine(e)}; the merge stays`, { mergeSha });
  }
  // spec §7.2 p.6 (D14): main goes to the remote through the supervisor's push work; red CI reaches this phase's inbox
  const finalSha = git(root, ['rev-parse', 'HEAD']);
  let pushRequestId = null;
  if (config.push?.mode && config.push.mode !== 'off') {
    try {
      pushRequestId = requestPush({ root, phase, point: 'phase', settings: config.push, git: deps.git, now: nowDate }).request?.id ?? null;
    } catch (e) {
      return owner(`the push request for main after phase ${phase} failed: ${firstLine(e)}; the merge stays`, { mergeSha });
    }
  }
  return done({ outcome: 'merged', sha: finalSha }, { state: 'merged', rounds: 0, mergeSha, finalSha, pushRequestId, ciRed: null, ownerNotified: null });
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

const RECORD_RE = /^p(.+)-push\.json$/;
// CI verdicts that free the slot (decision D15): cancelled ran nothing, as S2's lanes treat it
const RELEASE_CI = new Set(['green', 'none', 'cancelled']);

// A later push of main superseded this merge's CI watch: the newest push whose commit holds the merge decides.
function coveringPush(root, git, mr) {
  let names = [];
  try {
    names = fs.readdirSync(runDir(root));
  } catch {
    // no run directory: nothing pushed
  }
  const later = names.map((n) => RECORD_RE.exec(n)?.[1]).filter(Boolean)
    .map((p) => readJson(recordFile(root, p), null)?.lastPush)
    .filter((lp) => lp && SHA.test(String(lp.sha)) && lp.ci?.state !== 'superseded' && isAncestor(git, root, mr.finalSha, lp.sha))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const lp = later[0];
  if (!lp) return { state: 'wait', reason: `a later push superseded the CI of ${short(mr.finalSha)}, and no push that holds it has a result yet` };
  if (RELEASE_CI.has(lp.ci?.state)) return { state: lp.ci.state };
  return { state: 'wait', reason: `the CI of the later push ${short(lp.sha)} that holds this merge is ${lp.ci?.state ?? 'unknown'}` };
}

// What S2's push work made of this merge's push request.
function pushVerdict(root, git, mr) {
  const rec = readJson(recordFile(root, mr.phase), null);
  if (rec?.requestId !== mr.pushRequestId) return { state: 'wait', reason: `the supervisor has not pushed main at ${short(mr.finalSha)} yet` };
  if (rec.outcome !== 'pushed') return { state: 'owner', reason: describeRecord(rec).line, key: `${rec.requestId}:${rec.outcome}` };
  const lp = rec.lastPush?.requestId === rec.requestId ? rec.lastPush : null;
  if (rec.already || !lp) return { state: 'none' };
  const s = lp.ci?.state;
  if (s === 'pending') return { state: 'wait', reason: `CI on ${short(lp.sha)} is still running` };
  if (s === 'red') return { state: 'red', sha: lp.sha };
  if (s === 'timeout') return { state: 'owner', reason: describeRecord(rec).line, key: `${rec.requestId}:timeout` };
  if (s === 'superseded') return coveringPush(root, git, mr);
  return { state: RELEASE_CI.has(s) ? s : 'none' };
}

// Stage 4 §7.2 p.6–7, called by L1 every tick while mergeState(root, N).state is 'merged': the slot stays held until
// main's CI is green (or at once with push.mode off); red CI goes back to the lane, once per red commit.
export async function mergeFollowUp(ctx, lane) {
  const { root, config, deps } = ctx;
  const phase = String(lane?.phase ?? '');
  const mr = mergeState(root, phase);
  if (mr?.state !== 'merged') return { outcome: 'wait', reason: `phase ${phase} has nothing merged to follow (${mr?.state ?? 'no merge record'})` };
  const git = gitOf(deps);
  const nowDate = deps.now ? deps.now() : new Date();
  const now = nowDate.toISOString();
  const save = (fields) => writeJsonAtomic(mergeFile(root, phase), { ...mr, ...fields, at: now });
  let ci = 'off';
  if (config.push?.mode && config.push.mode !== 'off' && mr.pushRequestId) {
    const v = pushVerdict(root, git, mr);
    if (v.state === 'wait') return { outcome: 'wait', reason: v.reason };
    if (v.state === 'red') {
      if (mr.ciRed === v.sha) return { outcome: 'wait', reason: `CI is red on ${short(v.sha)}; phase ${phase} fixes it` };
      save({ ciRed: v.sha });
      deps.log(`merge p${phase}: CI red on ${short(v.sha)}; the lane fixes it`);
      return { outcome: 'ci-red', reason: `CI is red on main at ${short(v.sha)} after the merge of phase ${phase}`, sha: v.sha };
    }
    if (v.state === 'owner') {
      // L1's followUpStep holds the lane while this lasts and tells the owner once per reason; the lane record once
      if (mr.ownerNotified !== v.key) {
        save({ ownerNotified: v.key });
        writeLaneStatus(root, phase, 'needs-owner', { reason: v.reason, at: now });
      }
      return { outcome: 'needs-owner', reason: v.reason };
    }
    ci = v.state;
  }
  const note = `merged into main at ${short(mr.finalSha)}; CI ${ci}`;
  releaseSlot(root, lane.slot, { outcome: 'merged', now: () => nowDate, config });
  if (nextStep(readProgress(root, phase)) === 'integrate') completeStep(root, phase, 'integrate', { note, now: nowDate });
  writeLaneStatus(root, phase, 'done', { reason: note, at: now });
  fs.rmSync(holdFile(root, phase), { force: true });
  save({ state: 'released', released: { ci, at: now } });
  deps.log(`merge p${phase}: released slot ${lane.slot} (CI ${ci})`);
  return { outcome: 'released', sha: mr.finalSha };
}
