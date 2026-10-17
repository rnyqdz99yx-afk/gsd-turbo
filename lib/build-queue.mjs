import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normPath, planEdges, planIdOf, planInfo, planOrder, remaining, resolveDeps } from './exec-graph.mjs';
import { frontList } from './plan-drafts.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { ensureDir, readJsonState, writeJsonAtomic } from './fsx.mjs';
import { fullEntries, loadConfig } from './config.mjs';
import { dirKey, locksDir, stateRoot } from './paths.mjs';
import { BUILD_DIR, copyFiles, copyPlan, slotsDir, unlinkOutsideLinks } from './slots.mjs';
import { listWorktrees, outsideLinks } from './worktrees.mjs';
import { dropLaneQuestions, liveAnswer, readAnswers, readQuestions, withFileLock } from './questions.mjs';
import { processAlive } from './merge-lock.mjs';

// Stage 6 B2 (spec docs/specs/2026-10-17-stage-6-lean-design.md §6.3 step 5, §6.4, §6.6): the deterministic mechanics of
// the build path's build step. The phase's plans as a graph of slices (one slice = one plan, id = the plan id), the
// build state file run/build-p<N>.json, the ready queue, one git worktree per slice, the merge of a finished slice
// into the phase branch, the targeted tests of that merge, and the reconcile after a crash. No model and no sessions:
// turbo-run build (B4) drives these functions.

const GIT_TIMEOUT_MS = 120000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const zList = (out) => String(out ?? '').split('\0').filter(Boolean);
const toPosix = (p) => p.split(path.sep).join('/');

// git in a directory: its output without the last newline; { ok: true } turns exit 1 (git's documented "no") into null.
// The error names the last line git wrote and keeps all of it (err.stderr): a lock message ends in advice lines.
export function buildGit(env = process.env) {
  return (dir, args, { ok = false, timeout = GIT_TIMEOUT_MS } = {}) => {
    try {
      return String(execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024 })).replace(/\r?\n$/, '');
    } catch (err) {
      if (ok && err?.status === 1) return null;
      const stderr = String(err?.stderr ?? '');
      const why = err?.code === 'ETIMEDOUT' ? `timed out after ${timeout / 1000} s` : (stderr.trim() || String(err?.message ?? err)).split(/\r?\n/).filter((l) => l.trim()).at(-1);
      const e = new Error(`git ${args[0]} in ${dir} failed: ${why}`);
      e.stderr = stderr;
      e.status = err?.status ?? null;
      throw e;
    }
  };
}
const gitOf = (deps) => deps?.git || buildGit(deps?.env);

// --- the state file ----------------------------------------------------------------------------------------------

// A build state file that exists but cannot be read as one: never taken for a fresh start (reconcile finds orphan
// turbo-build/* branches anyway).
export class BuildStateDamaged extends Error {}

export const SLICE_STATES = Object.freeze(['waiting', 'dispatched', 'running', 'merged', 'owner', 'failed', 'blocked', 'done-before']);
// The moves the build makes; reconcile (git and disk say what happened) sets states without this table.
const MOVES = Object.freeze({
  waiting: ['dispatched', 'done-before'],
  dispatched: ['running', 'waiting'],
  running: ['merged', 'owner', 'failed', 'blocked', 'waiting'],
  owner: ['running', 'waiting'],
  failed: ['waiting'],
  blocked: ['waiting', 'merged'],
  merged: ['waiting', 'done-before'],
  'done-before': [],
});

export const buildStateFile = (runDir, phase) => path.join(runDir, `build-p${phase}.json`);

// The state of phase <N>'s build, or null when there is none. Damaged -> BuildStateDamaged('<file>: <why>').
export function loadBuildState(runDir, phase) {
  const file = buildStateFile(runDir, phase);
  const r = readJsonState(file);
  if (r.state === 'missing') return null;
  if (r.state === 'damaged') throw new BuildStateDamaged(`${file}: ${r.why}`);
  const s = r.value;
  if (s.v !== 1 || !isObj(s.slices) || !Array.isArray(s.order) || !Array.isArray(s.edges)) throw new BuildStateDamaged(`${file}: not a build state of version 1`);
  return s;
}

export function saveBuildState(runDir, phase, state) {
  writeJsonAtomic(buildStateFile(runDir, phase), state);
}

// --- the slice graph ---------------------------------------------------------------------------------------------

const listOf = (text, key) => (frontList(text, key) ?? []).map(normPath).filter(Boolean);

// The plans of the phase's current round as slices: the first round's plans, or (gaps) the gap-closure plans
// (gap_closure: true), which run in rounds of their own. Edges: exec-graph's (depends_on, shared written files,
// key_links reads), only forward in plan order. A slice whose SUMMARY is in HEAD is done (done-before). graphSha
// changes when a plan of the round changes (line endings aside), is added or goes.
// -> { nodes: [{ id, plan, summary, files, deletions, reads, gapClosure, done }], edges, order: [ids], dropped, graphSha }
export function planGraph(root, phase, { gaps = false, deps = {} } = {}) {
  const dir = findPhaseDir(root, phase);
  if (!dir) throw new Error(`no phase directory for phase ${phase}`);
  const rel = toPosix(path.relative(root, dir));
  const git = gitOf(deps);
  let inHead = new Set();
  try {
    inHead = new Set(zList(git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', `${rel}/`])));
  } catch {
    // no commit yet: nothing is done
  }
  const seen = new Map();
  const all = phaseArtifacts(dir).plans.map((p) => {
    const text = fs.readFileSync(path.join(dir, p.file), 'utf8');
    const info = planInfo(text, planIdOf(p.id));
    if (seen.has(info.id)) throw new Error(`plan id ${info.id} names two plan files: ${seen.get(info.id)}, ${p.file}`);
    seen.set(info.id, p.file);
    const summary = `${rel}/${p.id}-SUMMARY.md`;
    const node = { id: info.id, plan: `${rel}/${p.file}`, summary, files: listOf(text, 'files_modified'), deletions: listOf(text, 'files_deleted'), reads: info.reads, gapClosure: info.gapClosure, done: inHead.has(summary) };
    return { info, text, node };
  });
  const round = all.filter((x) => x.node.gapClosure === Boolean(gaps));
  const infos = round.map((x) => x.info);
  const edges = planEdges(infos); // a depends_on cycle throws here
  const order = planOrder(infos).map((p) => p.id);
  const graphSha = sha256(round.map((x) => `${x.node.plan}\0${sha256(x.text.replace(/\r\n/g, '\n'))}\n`).sort().join(''));
  return { nodes: round.map((x) => x.node), edges, order, dropped: resolveDeps(infos).dropped, graphSha };
}

const newSlice = (node, now) => {
  const state = node.done ? 'done-before' : 'waiting';
  return {
    state, plan: node.plan, summary: node.summary, base: null, sessions: [], pid: null, worktree: null, branch: null, links: [], merge: null, tests: null,
    question: null, ownerQuestion: null, reason: null, retries: 0, rebuilds: 0, salvage: [], leftover: null, at: { [state]: now.toISOString() },
  };
};

// A fresh build state of one round. maxBuilders: build.max_builders (the caller reads the config).
export function newBuildState({ phase, graph, head, maxBuilders = 4, round = 0, now = new Date() }) {
  return {
    v: 1, phase: String(phase), round, startedAt: now.toISOString(), head0: head, graphSha: graph.graphSha, maxBuilders,
    edges: graph.edges, order: graph.order, red: null, hold: null,
    slices: Object.fromEntries(graph.nodes.map((n) => [n.id, newSlice(n, now)])),
  };
}

// The slice moved to `to` (or, the same state, only its fields updated), stamped at[to]. fields.session ({ id, role })
// is appended to sessions. failed -> waiting counts a retry, blocked -> waiting a rebuild.
function applySlice(slice, to, fields, now) {
  const { session, state: _state, ...rest } = fields ?? {};
  if (to !== slice.state) {
    if (slice.state === 'failed' && to === 'waiting') slice.retries += 1;
    if (slice.state === 'blocked' && to === 'waiting') slice.rebuilds += 1;
    slice.state = to;
    slice.at = { ...slice.at, [to]: now.toISOString() };
  }
  Object.assign(slice, rest);
  if (session) slice.sessions = [...slice.sessions, { id: session.id, role: session.role, at: session.at ?? now.toISOString() }];
  return slice;
}

// -> the slice; a move not in the table, or an unknown id, throws.
export function setSlice(state, id, to, fields = {}, now = new Date()) {
  const slice = state?.slices?.[id];
  if (!slice) throw new Error(`no slice ${id} in the build state of phase ${state?.phase}`);
  if (to !== slice.state && !MOVES[slice.state]?.includes(to)) throw new Error(`slice ${id}: ${slice.state} -> ${to} is not a build transition`);
  return applySlice(slice, to, fields, now);
}

const LANDED = new Set(['merged', 'done-before']);
const SEATED = new Set(['dispatched', 'running']);

// The slices to dispatch now, the longest remaining chain first, then plan order: waiting slices whose every
// predecessor is merged or done-before, at most maxBuilders minus the slices dispatched or running (a slice waiting
// for its owner takes no seat). None while the phase branch is red (state.red), on hold (state.hold: a pause, an
// attend), or while a merged slice is not yet tested (tests: null).
export function nextReady(state, { maxBuilders = state.maxBuilders } = {}) {
  if (state.red || state.hold) return [];
  const slices = state.slices;
  const ids = Object.keys(slices);
  if (ids.some((id) => slices[id].state === 'merged' && slices[id].tests === null)) return [];
  const seats = maxBuilders - ids.filter((id) => SEATED.has(slices[id].state)).length;
  if (!(seats > 0)) return [];
  const known = new Set(ids);
  const edges = state.edges.filter((e) => known.has(e.from) && known.has(e.to));
  const preds = new Map(ids.map((id) => [id, []]));
  // an edge from a slice the state no longer has holds its dependent: nothing is dispatched past it
  for (const e of state.edges) preds.get(e.to)?.push(e.from);
  const ready = ids.filter((id) => slices[id].state === 'waiting' && preds.get(id).every((p) => LANDED.has(slices[p]?.state)));
  const prio = remaining(ids.map((id) => ({ id })), edges, new Map(ids.map((id) => [id, 1])), 0);
  const rank = (id) => {
    const i = state.order.indexOf(id);
    return i < 0 ? Infinity : i;
  };
  return ready.sort((a, b) => prio.get(b) - prio.get(a) || rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true })).slice(0, seats);
}

// --- slice worktrees ---------------------------------------------------------------------------------------------

// Git refuses a command while another git process holds the index or the config lock: tried again after 2, 4, 8 s.
export const MERGE_RETRY_MS = Object.freeze([2000, 4000, 8000]);
export const LOCK_ERROR = /Unable to create '[^']*\.lock'|\b(?:index|config)\.lock\b/;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isLockError = (err) => LOCK_ERROR.test(`${err?.message ?? ''}\n${err?.stderr ?? ''}`);
const firstLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];

// run() again after each pause of MERGE_RETRY_MS while it fails on a held lock; then the lock error is thrown.
// before() runs ahead of each pause (a merge aborts what the failed attempt left).
function lockRetry(run, { sleep = sleepSync, before = () => {} } = {}) {
  for (let i = 0; ; i++) {
    try {
      return run();
    } catch (err) {
      if (!isLockError(err) || i >= MERGE_RETRY_MS.length) throw err;
      before();
      sleep(MERGE_RETRY_MS[i]);
    }
  }
}

const LINKS_BEGIN = '# gsd-turbo build links: begin';
const LINKS_END = '# gsd-turbo build links: end';
const ignoreLine = (rel) => `/${rel.replace(/[\\*?[]/g, '\\$&')}`;
const gitPath = (git, dir, name) => path.resolve(dir, git(dir, ['rev-parse', '--git-path', name]));
const lstatOrNull = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const hasBranch = (git, root, branch) => git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { ok: true }) !== null;
const rmTree = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
// What wt is to the repository: 'listed' (a worktree git lists, with its own .git file), 'broken' (listed, but
// prunable or without its .git file), 'none' (not listed), 'unknown' (the listing failed: nothing may be removed or
// skipped on its account). A removal Windows stops halfway leaves a folder git no longer lists, or lists without its
// .git file: git must never run in such a folder, it would find a repository above it.
function worktreeState(git, root, wt) {
  let list;
  try {
    list = listWorktrees(root, { git });
  } catch {
    return 'unknown';
  }
  const key = dirKey(wt);
  const w = list.find((x) => dirKey(x.path) === key);
  if (!w) return 'none';
  return !w.prunable && lstatOrNull(path.join(wt, '.git'))?.isFile() ? 'listed' : 'broken';
}
// The count of commits of `rev` that no other ref holds (every branch but `branch`, tags, remotes, the checkout's
// HEAD); not --all, which also counts the HEAD of the slice's own worktree.
const commitsOnNoOtherRef = (git, root, rev, branch) => Number(git(root, ['rev-list', '--count', rev, '--not', `--exclude=${branch}`, '--branches', '--tags', '--remotes', 'HEAD']));
// The slice branch deleted only when another ref holds every commit of it; a branch still checked out stays.
function dropBranch(git, root, branch) {
  if (!hasBranch(git, root, branch) || commitsOnNoOtherRef(git, root, `refs/heads/${branch}`, branch) !== 0) return false;
  try {
    git(root, ['branch', '-q', '-D', branch]);
    return true;
  } catch {
    return false;
  }
}

export const sliceBranch = (id) => `turbo-build/${id}`;

// <slots folder>/b/<plan id>: outside the lane checkout (its test runner and linters never see a slice), the same
// path every time for a slice (claude --resume finds its session by the cwd).
export function sliceWorktreePath(root, id) {
  return path.join(slotsDir(stateRoot(root), loadConfig(root)), BUILD_DIR, id);
}

// The links of the build worktrees hidden from git status in the common info/exclude, a block turbo replaces whole: a
// .gitignore line `node_modules/` never matches a link.
function writeLinksExclude(git, root, links) {
  const file = path.join(path.resolve(root, git(root, ['rev-parse', '--git-common-dir'])), 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // none yet
  }
  const start = text.indexOf(LINKS_BEGIN);
  const end = text.indexOf(LINKS_END);
  const block = start >= 0 && end > start;
  const had = block ? text.slice(start + LINKS_BEGIN.length, end).split(/\r?\n/).filter(Boolean) : [];
  const kept = block ? text.slice(0, start) + text.slice(end + LINKS_END.length).replace(/^\r?\n/, '') : text;
  const lines = [...new Set([...had, ...links.map(ignoreLine)])].sort();
  if (!lines.length) return;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${kept}${kept && !kept.endsWith('\n') ? '\n' : ''}${[LINKS_BEGIN, ...lines, LINKS_END].join('\n')}\n`);
}

// The lane's test marker (and its import graph) into the worktree when every full run it records is an ancestor of
// the base: the builder's tests then run targeted from the lane's last full green run.
function seedMarker(git, root, wt, baseSha) {
  const marker = readJsonState(gitPath(git, root, 'turbo-last-green')).value;
  if (!marker) return;
  const shas = [marker.fullSha, ...Object.values(isObj(marker.entries) ? marker.entries : {}).map((e) => e?.fullSha)].filter((s) => s !== undefined);
  if (!shas.length || shas.some((s) => typeof s !== 'string' || !/^[0-9a-f]{40,64}$/.test(s))) return;
  for (const s of shas) if (git(root, ['merge-base', '--is-ancestor', s, baseSha], { ok: true }) === null) return;
  writeJsonAtomic(gitPath(git, wt, 'turbo-last-green'), marker);
  const graph = readJsonState(gitPath(git, root, 'turbo-import-graph.json')).value;
  if (graph && graph.fullSha === marker.fullSha) writeJsonAtomic(gitPath(git, wt, 'turbo-import-graph.json'), graph);
}

// A worktree for slice <id> on branch turbo-build/<id> from baseSha (the phase branch's HEAD), with the lane's
// node_modules of each test.full directory as a link (a junction on Windows), the lanes.copy files and the lane's test
// marker. A worktree or branch that exists already is refused, nothing changed. -> { path, branch, links: [rel] }
// deps: { git, sleep, env }
export function createSliceWorktree(root, { phase, id, baseSha }, deps = {}) {
  const git = gitOf(deps);
  const config = loadConfig(root);
  const wt = sliceWorktreePath(root, id);
  const branch = sliceBranch(id);
  if (lstatOrNull(wt)) throw new Error(`the worktree of slice ${id} (phase ${phase}) exists: ${wt}`);
  if (hasBranch(git, root, branch)) throw new Error(`branch ${branch} of slice ${id} (phase ${phase}) exists`);
  ensureDir(path.dirname(wt));
  try {
    // a retry after an attempt that made the branch already takes the branch as it is
    const add = () => (hasBranch(git, root, branch) ? ['worktree', 'add', '-q', toPosix(wt), branch] : ['worktree', 'add', '-q', '-b', branch, toPosix(wt), baseSha]);
    lockRetry(() => git(root, add()), { sleep: deps.sleep });
    const links = [];
    for (const { dir } of fullEntries(config.test?.full, root)) {
      const rel = dir ? `${dir}/node_modules` : 'node_modules';
      const target = path.resolve(root, ...rel.split('/'));
      const link = path.join(wt, ...rel.split('/'));
      // only a real directory: a link in the lane is never chained
      if (!lstatOrNull(target)?.isDirectory() || lstatOrNull(link)) continue;
      ensureDir(path.dirname(link));
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
      links.push(rel);
    }
    writeLinksExclude(git, root, links);
    copyFiles(root, wt, copyPlan(root, config, { git }).files);
    try {
      seedMarker(git, root, wt, baseSha);
    } catch {
      // the marker only saves time (a commit it names may be gone): without it the builder's first run is full
    }
    return { path: wt, branch, links };
  } catch (err) {
    // nothing of this attempt stays: the worktree, then the branch it made (no commit of its own yet)
    removeSliceWorktree(root, { path: wt, branch, deleteBranch: false }, deps);
    dropBranch(git, root, branch);
    throw err;
  }
}

// The slice worktree removed without ever following a link: links that lead outside it are unlinked as links first,
// and nothing is removed while one remains. Its branch goes only when every commit of it is on HEAD (deleteBranch).
// A removal git or Windows refuses is no failure: { removed: false, leftover: path, why }, the branch kept. What a
// removal stopped halfway left (a folder git no longer lists) is deleted as a plain folder, now or by a later call.
// -> { removed, leftover: path | null, why: string | null }
// deps: { git, rm (a folder's recursive delete), env }
export function removeSliceWorktree(root, { path: wt, branch, deleteBranch = true }, deps = {}) {
  const git = gitOf(deps);
  const left = (why) => ({ removed: false, leftover: wt, why });
  if (lstatOrNull(wt)) {
    try {
      unlinkOutsideLinks(wt);
    } catch (err) {
      return left(`a link in it cannot be removed: ${err?.code || firstLine(err)}`);
    }
    const links = outsideLinks(wt);
    if (links.length) return left(`links outside it remain (${links.map((l) => l.path).join(', ')}); nothing was removed`);
    let ws = worktreeState(git, root, wt);
    if (ws === 'unknown') return left('git cannot list the worktrees; nothing was removed');
    if (ws === 'listed') {
      try {
        git(root, ['worktree', 'remove', '--force', toPosix(wt)]);
      } catch (err) {
        // git may have given the worktree up and left files a process holds: then what is left is a plain folder
        ws = worktreeState(git, root, wt);
        if (ws === 'listed' || ws === 'unknown') return left(firstLine(err));
      }
    }
    if (lstatOrNull(wt)) {
      try {
        (deps.rm || rmTree)(wt);
      } catch (err) {
        return left(`what is left of it is no worktree any more and cannot be deleted yet (${err?.code || firstLine(err)})`);
      }
    }
    // a record left without its folder goes with the prune below, a locked one too: the folder was turbo's own
    if (ws === 'broken') {
      try {
        git(root, ['worktree', 'unlock', toPosix(wt)]);
      } catch {
        // not locked
      }
    }
  }
  try {
    git(root, ['worktree', 'prune']);
  } catch {
    // a stale entry stays listed until the next prune
  }
  let why = null;
  if (deleteBranch && branch && hasBranch(git, root, branch)) {
    if (git(root, ['rev-list', '--count', `HEAD..refs/heads/${branch}`]) !== '0') why = `branch ${branch} has commits not on HEAD: kept`;
    else {
      try {
        git(root, ['branch', '-q', '-d', branch]);
      } catch (err) {
        why = `branch ${branch} kept: ${firstLine(err)}`;
      }
    }
  }
  return { removed: true, leftover: null, why };
}

// --- merge a slice, test the merge ---------------------------------------------------------------------------------

// One merge at a time per phase. A B4 process lock must use another file name.
export class BuildLocked extends Error {}
export const buildLockFile = (root, phase) => path.join(locksDir(root), `build-p${phase}`);
// How a merge is found again after a crash.
export const mergeSubject = (phase, id) => `chore(phase-${phase}): merge slice ${id}`;
const BUILD_LOCK_WAIT_MS = 60000;
// A lock whose owner is gone is taken over once it is this old (the moment between creating the file and writing the
// owner into it); a lock older than BUILD_LOCK_MAX_MS is a crash's even when its pid runs again (Windows reuses pids):
// a merge holds the lock for seconds, its tests run outside it.
const BUILD_LOCK_STALE_MS = 10000;
const BUILD_LOCK_MAX_MS = 30 * 60000;
// the lock token is `<pid>-<uuid>` (withFileLock)
const lockOwnerAlive = (file) => (token) => {
  const st = lstatOrNull(file);
  if (st && Date.now() - st.mtimeMs > BUILD_LOCK_MAX_MS) return false;
  const pid = Number(/^(\d+)-/.exec(String(token))?.[1]);
  return Number.isInteger(pid) && pid > 0 && processAlive(pid);
};
const SELF_CHECK_FAILED = /^##\s*Self-Check:\s*FAILED/m;
const statusNames = (out) => String(out ?? '').split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3));
const succeeds = (git, dir, args) => {
  try {
    git(dir, args);
    return true;
  } catch {
    return false;
  }
};

// The SUMMARY path (project-relative) of plan <id> of the phase: its PLAN.md's name with -SUMMARY.md; null without one.
export function sliceSummary(root, phase, id) {
  const dir = findPhaseDir(root, phase);
  const p = dir ? phaseArtifacts(dir).plans.find((x) => planIdOf(x.id) === id) : null;
  return p ? `${toPosix(path.relative(root, dir))}/${p.id}-SUMMARY.md` : null;
}

// The newest merge commit on HEAD's first-parent line whose subject is the slice's (and that holds `tip`), or null.
export function findSliceMerge(root, phase, id, { tip = null, deps = {} } = {}) {
  const git = gitOf(deps);
  const subject = mergeSubject(phase, id);
  let out = '';
  try {
    out = git(root, ['log', '--first-parent', '--merges', '-F', `--grep=${subject}`, '--format=%H%x1f%s', 'HEAD']);
  } catch {
    return null; // no commit yet
  }
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [sha, s] = line.split('\x1f');
    if (s !== subject) continue;
    if (tip && git(root, ['merge-base', '--is-ancestor', tip, sha], { ok: true }) === null) continue;
    return sha;
  }
  return null;
}

// Slice <id>'s branch merged into the phase branch (the checkout at root) with `git merge --no-ff`, under the build lock
// locks/build-p<N>. A branch already merged (a crash after the merge) is not merged again: its merge commit is found by
// its subject. Before anything is merged: the SUMMARY on the branch, at least one commit beyond HEAD, no
// `## Self-Check: FAILED`, a clean worktree and a clean checkout. A held index or config lock is waited for
// (MERGE_RETRY_MS); a conflict is aborted. Every refusal leaves the checkout as it was (no MERGE_HEAD, HEAD unchanged)
// and the branch and worktree in place. After the merge the worktree and branch go (a leftover is reported, never a
// failure).
// -> { sha, already?: true, leftover?: path } | { blocked: true, kind: 'artifacts'|'dirty'|'checkout'|'conflict'|'lock'|'git', reason }
// deps: { git, sleep (sync ms), lockWaitMs, env }
export function mergeSlice(root, { phase, id, path: wt, branch }, deps = {}) {
  const git = gitOf(deps);
  const locked = () => new BuildLocked(`the build of phase ${phase} is locked by another turbo-run (build-p${phase}); try again`);
  const file = buildLockFile(root, phase);
  return withFileLock(file, merge, { waitMs: deps.lockWaitMs ?? BUILD_LOCK_WAIT_MS, staleMs: BUILD_LOCK_STALE_MS, alive: lockOwnerAlive(file), locked });

  function merge() {
    const blocked = (kind, reason) => ({ blocked: true, kind, reason });
    const done = (sha, extra = {}) => {
      const r = removeSliceWorktree(root, { path: wt, branch }, deps);
      return { sha, ...extra, ...(r.leftover ? { leftover: r.leftover } : {}) };
    };
    const tip = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { ok: true });
    if (tip === null) {
      const found = findSliceMerge(root, phase, id, { deps });
      return found ? done(found, { already: true }) : blocked('git', `no branch ${branch}`);
    }
    if (git(root, ['merge-base', '--is-ancestor', tip, 'HEAD'], { ok: true }) !== null) {
      const found = findSliceMerge(root, phase, id, { tip, deps });
      if (found) return done(found, { already: true });
    }
    const summary = sliceSummary(root, phase, id);
    if (!summary) return blocked('artifacts', `no plan ${id} in phase ${phase}`);
    if (!succeeds(git, root, ['cat-file', '-e', `${tip}:${summary}`])) return blocked('artifacts', `no ${summary} on ${branch}`);
    if (git(root, ['rev-list', '--count', `HEAD..${tip}`]) === '0') return blocked('artifacts', `no commit on ${branch}`);
    if (SELF_CHECK_FAILED.test(git(root, ['show', `${tip}:${summary}`]))) return blocked('artifacts', `${summary} on ${branch} says Self-Check: FAILED`);
    // git runs only in a listed worktree (in a leftover folder it would find the repository above it)
    const ws = wt && lstatOrNull(wt) ? worktreeState(git, root, wt) : 'none';
    if (ws === 'unknown') return blocked('git', `git cannot list the worktrees, so the worktree of slice ${id} cannot be checked`);
    if (ws === 'listed') {
      const dirty = statusNames(git(wt, ['status', '--porcelain', '--untracked-files=normal']));
      if (dirty.length) return blocked('dirty', `uncommitted files in the worktree of slice ${id}: ${dirty.slice(0, 10).join(', ')}`);
    }
    const changed = statusNames(git(root, ['status', '--porcelain', '--untracked-files=no']));
    if (changed.length) return blocked('checkout', `uncommitted changes in the phase checkout: ${changed.slice(0, 10).join(', ')}`);
    const mergeHead = () => git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { ok: true }) !== null;
    const abort = () => {
      if (mergeHead()) git(root, ['merge', '--abort']);
    };
    try {
      lockRetry(() => git(root, ['merge', '--no-ff', '--no-edit', '-m', mergeSubject(phase, id), tip]), { sleep: deps.sleep, before: abort });
    } catch (err) {
      if (isLockError(err)) {
        abort();
        const line = `${err.stderr ?? ''}\n${err.message}`.split(/\r?\n/).find((l) => LOCK_ERROR.test(l))?.trim();
        return blocked('lock', `git merge found a lock held after ${MERGE_RETRY_MS.reduce((a, b) => a + b, 0) / 1000} s: ${line}`);
      }
      if (mergeHead()) {
        const files = (git(root, ['diff', '--name-only', '--diff-filter=U'], { ok: true }) ?? '').split(/\r?\n/).filter(Boolean);
        git(root, ['merge', '--abort']);
        if (files.length) return blocked('conflict', `merge conflict in ${files.join(', ')}`);
      }
      return blocked('git', firstLine(err));
    }
    return done(git(root, ['rev-parse', 'HEAD']));
  }
}

const TREE_TIMEOUT = fileURLToPath(new URL('./tree-timeout.mjs', import.meta.url));
const TURBO_RUN = fileURLToPath(new URL('../bin/turbo-run.mjs', import.meta.url));

// The targeted tests of one merge (turbo-run test-changed --merge <sha>), or with sha null a plain test-changed (the
// retest after a fix, counted as usual), under a time limit that ends the whole process tree. Output to
// <runDir>/build-p<N>/tests-<sha7>.log (tests-retest-<ms>.log). -> { green, code, line (the last line written), log }
export async function runMergeTests(root, runDir, phase, { sha = null, timeoutMin = 30 } = {}) {
  const dir = path.join(runDir, `build-p${phase}`);
  ensureDir(dir);
  const log = path.join(dir, sha ? `tests-${String(sha).slice(0, 7)}.log` : `tests-retest-${Date.now()}.log`);
  // a nested node --test that inherits NODE_TEST_CONTEXT skips every file and exits 0
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const args = [TREE_TIMEOUT, String(timeoutMin * 60000), process.execPath, TURBO_RUN, 'test-changed', '--project', root, ...(sha ? ['--merge', sha] : [])];
  const fd = fs.openSync(log, 'w');
  let code;
  try {
    code = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true });
      child.on('error', () => resolve(127));
      child.on('close', (c) => resolve(c ?? 1));
    });
  } finally {
    fs.closeSync(fd);
  }
  let text = '';
  try {
    text = fs.readFileSync(log, 'utf8');
  } catch {
    // nothing written
  }
  return { green: code === 0, code, line: redLine(text), log };
}

// The line that names a red run: its first failing test (node --test ✖, TAP not ok, vitest FAIL, pytest FAILED), else
// its last line (B5 demo: node's last line is an error object's closing brace).
const FAIL_LINE = /^(?:✖ (?!failing tests:?$)|not ok\b|FAIL(?:ED)?\b|×)/;
export function redLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => FAIL_LINE.test(l)) ?? lines.at(-1) ?? '';
}

// --- after a crash (spec §6.6) -------------------------------------------------------------------------------------

// 2026-10-17T12:00:00.000Z -> 20261017T120000Z
const utcStamp = (now) => now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
const IN_FLIGHT = new Set(['dispatched', 'running']);

// The build state checked against git and the disk at every `build N` start, before any dispatch; saved. Nothing is
// lost or done twice: a branch already merged is found by its merge subject, a finished slice (SUMMARY on its branch)
// is merged, partial work (commits on no other ref, uncommitted files) goes to turbo-salvage/<id>-<UTC> before its
// worktree goes, and the slice is built again. A slice whose recorded pid is alive is left to the caller (never
// killed); a slice waiting for its owner follows its card. The plans are read again when they changed.
// -> { state | null (no state file), actions: [{ id, action, detail }] }; actions graph, alive, merged (sha), blocked,
// salvaged (branch), requeued, done-before, answered, reask, cleaned, retest, test. alive, answered, reask, retest and
// test stand until the caller acts on them.
export function reconcileBuildState(root, runDir, phase, { alive = (s) => Boolean(s.pid) && processAlive(s.pid), now = new Date(), deps = {} } = {}) {
  const state = loadBuildState(runDir, phase);
  if (!state) return { state: null, actions: [] };
  const git = gitOf(deps);
  const actions = [];
  const act = (id, action, detail = null) => actions.push({ id, action, detail });
  try {
    git(root, ['worktree', 'prune']);
  } catch {
    // the entries of worktrees gone stay listed until the next prune
  }

  // the plans changed since the state was made: new plans join as waiting, kept slices keep their states, a waiting
  // slice whose plan is gone goes (after its branch is settled below)
  const graph = planGraph(root, phase, { gaps: state.round > 0, deps });
  const gone = new Set();
  let graphAct = null;
  if (graph.graphSha !== state.graphSha) {
    const added = [];
    for (const n of graph.nodes) {
      if (state.slices[n.id]) Object.assign(state.slices[n.id], { plan: n.plan, summary: n.summary });
      else {
        state.slices[n.id] = newSlice(n, now);
        added.push(n.id);
      }
    }
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const id of Object.keys(state.slices)) if (!ids.has(id)) gone.add(id);
    Object.assign(state, { edges: graph.edges, order: graph.order, graphSha: graph.graphSha });
    graphAct = { id: null, action: 'graph', detail: added.length ? `new: ${added.join(', ')}` : 'plans changed' };
    actions.push(graphAct);
  }

  const onHead = (rel) => Boolean(rel) && succeeds(git, root, ['cat-file', '-e', `HEAD:${rel}`]);
  const isAncestor = (a, b) => git(root, ['merge-base', '--is-ancestor', a, b], { ok: true }) !== null;
  const set = (s, to, fields) => applySlice(s, to, fields, now);
  const gotten = (s, id, sha, leftover = null) => {
    set(s, 'merged', { merge: sha, tests: null, pid: null, worktree: null, branch: null, leftover });
    act(id, 'merged', sha);
  };
  // no branch (any more): the SUMMARY on HEAD says merged (by its merge commit) or done before; else built again
  const final = (s, id, { requeue = true } = {}) => {
    if (onHead(s.summary)) {
      const found = findSliceMerge(root, phase, id, { deps });
      if (found) return gotten(s, id, found);
      set(s, 'done-before', { pid: null, worktree: null, branch: null, merge: null, tests: null });
      return act(id, 'done-before');
    }
    set(s, 'waiting', { pid: null, worktree: null, branch: null, base: null, links: [], merge: null, tests: null, question: null, ownerQuestion: null });
    if (requeue) act(id, 'requeued');
  };
  // a ref turbo-salvage/<id>-<UTC> (-2, -3, … when taken) made for sha, checked to hold it
  const keep = (s, id, sha) => {
    const stem = `turbo-salvage/${id}-${utcStamp(now)}`;
    let name = stem;
    for (let i = 2; hasBranch(git, root, name); i++) name = `${stem}-${i}`;
    git(root, ['update-ref', `refs/heads/${name}`, sha, '']);
    if (git(root, ['rev-parse', `refs/heads/${name}`]) !== sha) throw new Error(`${name} does not hold ${sha}`);
    s.salvage = [...(s.salvage ?? []), name];
    act(id, 'salvaged', name);
  };
  // partial work kept before the worktree goes: uncommitted files as a wip commit on the worktree's HEAD (made with
  // git's plumbing, so no hook or commit message rule of the project can refuse it), the worktree's HEAD when the
  // builder left the slice branch, the slice branch's own commits; then the worktree goes, and the slice branch once
  // the salvage refs hold every commit of it. -> false when it failed (the slice blocked, nothing removed)
  const salvage = (s, id, branch, wt, { dirty, wtHead, tip, uniqueTip, uniqueHead }) => {
    try {
      let top = wtHead;
      if (dirty) {
        git(wt, ['add', '-A']);
        top = git(wt, ['commit-tree', git(wt, ['write-tree']), '-p', wtHead, '-m', `wip(${id}): uncommitted work salvaged by turbo`]);
        // the worktree's HEAD (its branch) moves to the wip commit: a worktree that outlives a refused removal is clean,
        // so a later reconcile does not salvage it again
        git(wt, ['update-ref', 'HEAD', top, wtHead]);
      }
      const shas = dirty || uniqueHead ? [top] : [];
      if (uniqueTip && !(shas.length && isAncestor(tip, shas[0]))) shas.push(tip);
      for (const sha of shas) keep(s, id, sha);
      const r = removeSliceWorktree(root, { path: wt, branch, deleteBranch: false }, deps);
      s.leftover = r.leftover;
      dropBranch(git, root, branch);
      return true;
    } catch (err) {
      set(s, 'blocked', { reason: `salvage failed: ${firstLine(err)}`, pid: null, worktree: wt, branch });
      act(id, 'blocked', s.reason);
      return false;
    }
  };
  // a slice with no live session: what its branch and worktree hold decides
  const settle = (s, id) => {
    const branch = s.branch ?? sliceBranch(id);
    const wt = s.worktree ?? s.leftover ?? sliceWorktreePath(root, id);
    const tip = hasBranch(git, root, branch) ? git(root, ['rev-parse', `refs/heads/${branch}`]) : null;
    if (tip && isAncestor(tip, 'HEAD')) {
      const found = findSliceMerge(root, phase, id, { tip, deps });
      if (found) return gotten(s, id, found, removeSliceWorktree(root, { path: wt, branch }, deps).leftover);
    } else if (tip && succeeds(git, root, ['cat-file', '-e', `${tip}:${s.summary}`])) {
      const r = mergeSlice(root, { phase, id, path: wt, branch }, deps);
      if (!r.blocked) return gotten(s, id, r.sha, r.leftover ?? null);
      set(s, 'blocked', { reason: `${r.kind}: ${r.reason}`, pid: null, worktree: wt, branch });
      return act(id, 'blocked', r.reason);
    }
    // git runs only in a listed worktree: a folder a removal left behind is no worktree any more
    const ws = lstatOrNull(wt) ? worktreeState(git, root, wt) : 'none';
    if (ws === 'unknown') {
      set(s, 'blocked', { reason: 'git cannot list the worktrees: nothing was salvaged or removed', pid: null, worktree: wt, branch: tip ? branch : null });
      return act(id, 'blocked', s.reason);
    }
    const listed = ws === 'listed';
    const wtHead = listed ? git(wt, ['rev-parse', 'HEAD']) : null;
    const dirty = listed && statusNames(git(wt, ['status', '--porcelain', '--untracked-files=normal'])).length > 0;
    const uniqueTip = Boolean(tip) && commitsOnNoOtherRef(git, root, tip, branch) > 0;
    // a HEAD the builder moved off the slice branch, with commits of its own (not one the branch holds already)
    const uniqueHead = Boolean(wtHead) && wtHead !== tip && !(tip && isAncestor(wtHead, tip)) && commitsOnNoOtherRef(git, root, wtHead, branch) > 0;
    if (dirty || uniqueTip || uniqueHead) {
      if (!salvage(s, id, branch, wt, { dirty, wtHead, tip, uniqueTip, uniqueHead })) return;
      return final(s, id, { requeue: false });
    }
    if (lstatOrNull(wt)) s.leftover = removeSliceWorktree(root, { path: wt, branch, deleteBranch: false }, deps).leftover;
    if (tip) dropBranch(git, root, branch);
    return final(s, id);
  };
  let cards = null;
  const card = (ask) => {
    cards ??= { questions: readQuestions(root, phase), answers: readAnswers(root, phase) };
    const q = cards.questions.find((x) => x.id === ask);
    // a delivered lane card leaves the questions file on its next refresh; its answer stays in the answers file
    return q ? q.state : ask && liveAnswer(cards.answers, ask) ? 'delivered' : null;
  };

  const ids = [...state.order.filter((id) => state.slices[id]), ...Object.keys(state.slices).filter((id) => !state.order.includes(id))];
  for (const id of ids) {
    const s = state.slices[id];
    const branch = s.branch ?? sliceBranch(id);
    if (s.state === 'merged') {
      if (s.merge && isAncestor(s.merge, 'HEAD') && onHead(s.summary)) {
        const wt = s.leftover ?? s.worktree ?? sliceWorktreePath(root, id);
        if (lstatOrNull(wt) || hasBranch(git, root, branch)) {
          const r = removeSliceWorktree(root, { path: wt, branch }, deps);
          s.leftover = r.leftover;
          if (!r.leftover) act(id, 'cleaned', wt);
        }
        continue;
      }
      // the merge left HEAD (a reset): the slice's commits, which its deleted branch no longer holds, are kept first
      try {
        const work = s.merge ? git(root, ['rev-parse', '--verify', '--quiet', `${s.merge}^2`], { ok: true }) : null;
        if (work && commitsOnNoOtherRef(git, root, work, branch) > 0) keep(s, id, work);
      } catch (err) {
        set(s, 'blocked', { reason: `salvage failed: ${firstLine(err)}`, pid: null });
        act(id, 'blocked', s.reason);
        continue;
      }
      settle(s, id);
      continue;
    }
    if (s.state === 'done-before' && s.leftover) {
      // what a removal left behind (its work was kept before) goes once nothing holds it
      const wt = s.leftover;
      s.leftover = removeSliceWorktree(root, { path: wt, branch: null }, deps).leftover;
      if (!s.leftover) act(id, 'cleaned', wt);
      continue;
    }
    if (s.state === 'owner') {
      // built while the owner sat with the phase (attend): its card is closed, its partial work kept
      if (onHead(s.summary)) {
        settle(s, id);
        if (s.question) dropLaneQuestions(root, phase, { ids: [s.question] });
        continue;
      }
      const c = card(s.question);
      if (c === 'open') continue;
      if (c === 'answered') {
        act(id, 'answered', s.question);
        continue;
      }
      if (c !== 'delivered') {
        act(id, 'reask', s.question);
        continue;
      }
    } else if (s.state === 'waiting') {
      // an orphan branch (a crash between worktree add and the save) or a folder a removal left is in flight; a plan
      // built in an attend sitting is done
      if (!hasBranch(git, root, branch) && !lstatOrNull(s.leftover ?? sliceWorktreePath(root, id))) {
        if (onHead(s.summary)) final(s, id);
        continue;
      }
    } else if (!IN_FLIGHT.has(s.state)) {
      continue; // failed, blocked, done-before: the caller's
    }
    if (alive(s)) {
      act(id, 'alive', s.pid ?? null);
      continue;
    }
    settle(s, id);
  }
  const removed = [...gone].filter((id) => state.slices[id]?.state === 'waiting');
  for (const id of removed) delete state.slices[id];
  if (graphAct && removed.length) graphAct.detail += `; gone: ${removed.join(', ')}`;
  if (state.red) act(null, 'retest', state.red.merge ?? null);
  for (const id of ids) if (state.slices[id]?.state === 'merged' && state.slices[id].tests === null) act(id, 'test', state.slices[id].merge);
  saveBuildState(runDir, phase, state);
  return { state, actions };
}
