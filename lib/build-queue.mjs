import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { normPath, planEdges, planIdOf, planInfo, planOrder, remaining, resolveDeps } from './exec-graph.mjs';
import { frontList } from './plan-drafts.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { ensureDir, readJsonState, writeJsonAtomic } from './fsx.mjs';
import { fullEntries, loadConfig } from './config.mjs';
import { stateRoot } from './paths.mjs';
import { BUILD_DIR, copyFiles, copyPlan, slotsDir, unlinkOutsideLinks } from './slots.mjs';
import { outsideLinks } from './worktrees.mjs';

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
  lockRetry(() => git(root, ['worktree', 'add', '-q', '-b', branch, toPosix(wt), baseSha]), { sleep: deps.sleep });
  try {
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
    seedMarker(git, root, wt, baseSha);
    return { path: wt, branch, links };
  } catch (err) {
    removeSliceWorktree(root, { path: wt, branch }, deps);
    throw err;
  }
}

// The slice worktree removed without ever following a link: links that lead outside it are unlinked as links first,
// and nothing is removed while one remains. Its branch goes only when every commit of it is on HEAD (deleteBranch).
// A removal git or Windows refuses is no failure: { removed: false, leftover: path, why }, the branch kept.
// -> { removed, leftover: path | null, why: string | null }
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
    try {
      git(root, ['worktree', 'remove', '--force', toPosix(wt)]);
    } catch (err) {
      return left(firstLine(err));
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
