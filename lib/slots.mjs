import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirKey, slotRecordFile } from './paths.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fsx.mjs';
import { DEFAULTS, deepMerge, fullEntries, lanesSettings, loadConfig } from './config.mjs';
import { maskSecrets } from './secrets.mjs';
import { trustSlot, trustState, untrustSlot } from './trust.mjs';

// Stage 4 (spec §4): a slot is a lasting local clone of the project, <lanes.dir>/lane-<k>, where one lane, prep or
// annotate job works at a time. Its record (.git/turbo-lane.json, lib/paths.mjs slotRecordFile) names the project that
// owns it (the control root) and the job it holds; only this module writes it.
export const SLOT_RE = /^lane-([1-9]\d*)$/;
export const SETTINGS_LOCAL = '.claude/settings.local.json';
// The main checkout's local git settings a slot takes before its first checkout: the same identity, signing and line
// endings (S3: other line endings break the verification fingerprint). An absolute core.hooksPath names the main
// checkout's own hooks directory and is skipped.
export const COPIED_GIT_CONFIG = Object.freeze(['user.name', 'user.email', 'user.signingkey', 'commit.gpgsign', 'gpg.format', 'core.autocrlf', 'core.eol', 'core.safecrlf', 'core.hooksPath']);
const GIT_TIMEOUT_MS = 120000;
const CLONE_TIMEOUT_MS = 600000;
const EXCLUDE_BEGIN = '# gsd-turbo slot files: begin';
const EXCLUDE_END = '# gsd-turbo slot files: end';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
const zList = (out) => String(out ?? '').split('\0').filter(Boolean);

export class SlotRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SlotRefused';
    this.code = code;
  }
}
const refuse = (code, text) => { throw new SlotRefused(code, text); };

// git in a directory: its output without the last newline; { ok: true } turns exit 1 (git's documented "no") into null.
export function slotGit(env = process.env) {
  return (dir, args, { ok = false, timeout = GIT_TIMEOUT_MS } = {}) => {
    try {
      return String(execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024 })).replace(/\r?\n$/, '');
    } catch (err) {
      if (ok && err?.status === 1) return null;
      const why = err?.code === 'ETIMEDOUT' ? `timed out after ${timeout / 1000} s` : String(err?.stderr || err?.message || err).trim().split(/\r?\n/).at(-1);
      throw new Error(`git ${args[0]} in ${dir} failed: ${why}`);
    }
  };
}
const gitOf = (deps) => deps?.git || slotGit(deps?.env);

export function maxLanes(config) {
  const n = config?.max_lanes;
  return Number.isInteger(n) && n >= 1 ? n : DEFAULTS.max_lanes;
}

// <parent>/<repo>.turbo next to the project, or lanes.dir (a relative one counts from the project root).
export function slotsDir(root, config) {
  const { dir } = lanesSettings(config?.lanes);
  const abs = path.resolve(root);
  return dir ? path.resolve(abs, dir) : path.join(path.dirname(abs), `${path.basename(abs)}.turbo`);
}
export const slotPath = (root, config, k) => path.join(slotsDir(root, config), `lane-${k}`);

const inside = (root, dir) => {
  const r = path.relative(path.resolve(root), dir);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

export function readSlotRecord(slot) {
  const r = readJson(slotRecordFile(slot), null);
  return isObj(r) && Number.isInteger(r.k) && typeof r.control === 'string' && r.control ? r : null;
}
const writeSlotRecord = (slot, rec) => writeJsonAtomic(slotRecordFile(slot), rec);
const ours = (rec, root) => rec !== null && dirKey(rec.control) === dirKey(root);
const describeJob = (job) => `${job.kind}${job.phase ? ` ${job.phase}` : ''} on ${job.branch}`;

// What keeps a slot from its next job: its tracked changes always; its untracked files unless the last job ended
// merged (then they are turbo's own leftovers, such as GSD's .planning/state.json, and git clean removes them).
function blocking(record, lines) {
  const merged = record?.job?.state === 'done' && record.job.outcome === 'merged';
  return lines.filter((l) => !(merged && l.startsWith('?? ')));
}

function slotInfo(root, k, slot, git) {
  if (!fs.existsSync(slot)) return { k, path: slot, state: 'missing', record: null, dirty: [] };
  const record = readSlotRecord(slot);
  if (!ours(record, root) || record.k !== k) return { k, path: slot, state: 'foreign', record, dirty: [] };
  const lines = git(slot, ['status', '--porcelain', '--untracked-files=normal']).split(/\r?\n/).filter(Boolean);
  if (record.job?.state === 'active') return { k, path: slot, state: 'busy', record, dirty: lines };
  const dirty = blocking(record, lines);
  return { k, path: slot, state: dirty.length ? 'dirty' : 'free', record, dirty };
}

function slotNumbers(root, config) {
  const ks = new Set(Array.from({ length: maxLanes(config) }, (_, i) => i + 1));
  try {
    for (const n of fs.readdirSync(slotsDir(root, config))) {
      const m = SLOT_RE.exec(n);
      if (m) ks.add(Number(m[1]));
    }
  } catch {
    // no slots directory yet
  }
  return [...ks].sort((a, b) => a - b);
}

// Every slot place 1..max_lanes, and every lane-<k> directory beyond it, with its state.
export function listSlots(root, config, deps = {}) {
  const git = gitOf(deps);
  return slotNumbers(root, config).map((k) => {
    const slot = slotPath(root, config, k);
    try {
      return slotInfo(root, k, slot, git);
    } catch (err) {
      return { k, path: slot, state: 'broken', record: readSlotRecord(slot), dirty: [], why: errLine(err) };
    }
  });
}

// The branch of the main checkout (spec §7 <main_branch>): its current branch; never a detached HEAD or a lane branch.
export function mainBranch(root, deps = {}) {
  const b = gitOf(deps)(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: true });
  if (!b) refuse('detached', `the main checkout ${root} is not on a branch (detached HEAD): check out the main branch first`);
  if (b.startsWith('turbo/')) refuse('detached', `the main checkout is on ${b}, a lane branch: check out the main branch first`);
  return b;
}

// A lanes.copy mask as a regular expression over a path from the project root: * and ? stay within one segment, **
// spans segments.
export function maskRegExp(mask) {
  const segs = mask.split('/');
  let re = '';
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s === '**') {
      re += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    re += s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + (last ? '' : '/');
  });
  return new RegExp(`^${re}$`);
}

// The ignored files of the main checkout that lanes.copy names, and the files it names that git does not ignore.
export function copyPlan(root, config, deps = {}) {
  const git = gitOf(deps);
  const masks = lanesSettings(config?.lanes).copy.map(maskRegExp);
  const hit = (p) => masks.some((re) => re.test(p));
  const files = zList(git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])).filter((p) => !p.endsWith('/') && hit(p));
  const notIgnored = [...zList(git(root, ['ls-files', '-z'])), ...zList(git(root, ['ls-files', '-z', '--others', '--exclude-standard']))].filter(hit);
  return { files: files.sort(), notIgnored: notIgnored.sort() };
}

function checkedCopies(root, config, git) {
  const plan = copyPlan(root, config, { git });
  if (plan.notIgnored.length) refuse('copy', `lanes.copy names files git does not ignore: ${plan.notIgnored.join(', ')}; a slot copies only ignored files (add them to .gitignore, or drop the mask from lanes.copy); nothing was changed`);
  return plan.files;
}

// A path as a gitignore line (exclude block, git clean -e): anchored at the root, its pattern characters escaped.
const ignoreLine = (rel) => `/${rel.replace(/[\\*?[]/g, '\\$&').replace(/ +$/, (s) => s.replace(/ /g, '\\ '))}`;

function copyFiles(root, slot, files) {
  for (const f of files) {
    const src = path.join(root, ...f.split('/'));
    let st;
    try {
      st = fs.lstatSync(src);
    } catch {
      continue; // gone since git listed it
    }
    if (!st.isFile()) continue; // a link is never followed out of the project
    const dst = path.join(slot, ...f.split('/'));
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
  }
}

// G8, S2: the slot's settings.local.json is the main checkout's with worktree.baseRef "head", so GSD runs a wave's
// plans in parallel in the slot. The project's own file is never written.
function writeSlotSettings(root, slot) {
  const src = path.join(root, ...SETTINGS_LOCAL.split('/'));
  let base = {};
  if (fs.existsSync(src)) {
    try {
      base = JSON.parse(fs.readFileSync(src, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      refuse('settings', `${SETTINGS_LOCAL} of the main checkout is not valid JSON (${errLine(err)}): fix it, then run turbo-run lanes setup again`);
    }
    if (!isObj(base)) refuse('settings', `${SETTINGS_LOCAL} of the main checkout is not a JSON object`);
  }
  writeJsonAtomic(path.join(slot, ...SETTINGS_LOCAL.split('/')), deepMerge(base, { worktree: { baseRef: 'head' } }));
}

// The copies and settings.local.json never show in the slot's git status and are never committed: turbo lists them in
// the slot's .git/info/exclude, a block it replaces whole.
function writeSlotExclude(slot, files) {
  const file = path.join(slot, '.git', 'info', 'exclude');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // a clone usually has one; none is fine
  }
  const start = text.indexOf(EXCLUDE_BEGIN);
  const end = text.indexOf(EXCLUDE_END);
  const kept = start >= 0 && end > start ? text.slice(0, start) + text.slice(end + EXCLUDE_END.length).replace(/^\r?\n/, '') : text;
  const block = [EXCLUDE_BEGIN, ...[SETTINGS_LOCAL, ...files].map(ignoreLine), EXCLUDE_END].join('\n');
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${kept}${kept && !kept.endsWith('\n') ? '\n' : ''}${block}\n`);
}

function copyGitConfig(root, slot, git) {
  for (const key of COPIED_GIT_CONFIG) {
    const v = git(root, ['config', '--local', '--get', key], { ok: true });
    if (v === null) continue;
    if (key === 'core.hooksPath' && path.isAbsolute(v)) continue;
    git(slot, ['config', '--local', key, v]);
  }
}

// The files a slot takes from the main checkout, again: local git settings, copies, settings.local.json, the exclude
// block, and the list of copies in the record (prepare keeps them out of git clean).
function refreshSlot(root, slot, files, git) {
  copyGitConfig(root, slot, git);
  copyFiles(root, slot, files);
  writeSlotSettings(root, slot);
  writeSlotExclude(slot, files);
  writeSlotRecord(slot, { ...readSlotRecord(slot), copied: files });
}

function createSlot(root, slot, k, { git, now, branch, files }) {
  ensureDir(path.dirname(slot));
  try {
    git(path.dirname(slot), ['clone', '-q', '--local', '--no-checkout', '--', root, slot], { timeout: CLONE_TIMEOUT_MS });
    copyGitConfig(root, slot, git);
    // D4: an empty index after --no-checkout would read as every file deleted
    git(slot, ['checkout', '-q', '-f', '--detach', `refs/remotes/origin/${branch}`]);
    writeSlotRecord(slot, { v: 1, k, path: slot, control: path.resolve(root), createdAt: now().toISOString(), copied: [], job: null });
    refreshSlot(root, slot, files, git);
  } catch (err) {
    // only what this call created: the directory did not exist before it
    fs.rmSync(slot, { recursive: true, force: true });
    throw err;
  }
}

// turbo-run lanes setup (spec §4): slots 1..max_lanes, each created when missing (clone, copies, settings, record) or
// refreshed when it is this project's, then trusted (§4.1). A directory in a slot's place that is not this project's
// slot is refused and never touched. Refusals of the whole setup come before any clone.
export function setupSlots(root, config, deps = {}) {
  const git = gitOf(deps);
  const now = deps.now || (() => new Date());
  const lanes = lanesSettings(config?.lanes);
  if (lanes.mode !== 'slots') refuse('mode', 'lanes.mode is checkout: lanes work in this checkout, no slots');
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (dirKey(top) !== dirKey(root)) refuse('layout', `the project root ${root} is not the top of its git repository (${top}): a slot clones the whole repository`);
  const dir = slotsDir(root, config);
  if (inside(root, dir)) refuse('inside', `lanes.dir ${dir} lies inside the project: slots live outside it (empty lanes.dir: next to the project)`);
  if (git(root, ['ls-files', '--error-unmatch', '--', SETTINGS_LOCAL], { ok: true }) !== null) refuse('settings', `${SETTINGS_LOCAL} is tracked by git: turbo writes a slot's own copy of it, which would show as a change; untrack it (git rm --cached) and ignore it`);
  const files = checkedCopies(root, config, git);
  const branch = mainBranch(root, { git });
  const run = {};
  const trust = deps.trust || ((slot) => trustSlot(slot, { file: deps.claudeJson, write: deps.trustWrite ?? lanes.trust_write, run, lang: config?.lang, now }));
  const slots = [];
  for (let k = 1; k <= maxLanes(config); k++) {
    const slot = slotPath(root, config, k);
    const exists = fs.existsSync(slot);
    const rec = exists ? readSlotRecord(slot) : null;
    if (exists && !(ours(rec, root) && rec.k === k)) {
      slots.push({ k, path: slot, action: 'refused', why: `${slot} exists and is not slot ${k} of this project: move it away, or set lanes.dir`, trust: null });
      continue;
    }
    if (exists) refreshSlot(root, slot, files, git);
    else createSlot(root, slot, k, { git, now, branch, files });
    slots.push({ k, path: slot, action: exists ? 'kept' : 'created', why: null, trust: trust(slot) });
  }
  return { dir, slots, backup: run.backup ?? null };
}

export const JOB_KINDS = Object.freeze(['phase', 'prep', 'annotate']);
export const JOB_OUTCOMES = Object.freeze(['merged', 'failed', 'abandoned']);
const BRANCH_RE = /^turbo\/[A-Za-z0-9._-]+$/;

// D6: the branch of a job: turbo/p<N>, turbo/prep-<N>, turbo/annotate.
export function jobBranch(job) {
  if (job.kind === 'phase') return `turbo/p${job.phase}`;
  if (job.kind === 'prep') return `turbo/prep-${job.phase}`;
  return 'turbo/annotate';
}

function checkJob(job) {
  if (!isObj(job) || !JOB_KINDS.includes(job.kind)) throw new Error(`job.kind must be one of ${JOB_KINDS.join(', ')}`);
  const phase = job.phase === undefined || job.phase === null ? null : String(job.phase);
  if (job.kind !== 'annotate' && !/^[A-Za-z0-9._-]+$/.test(phase ?? '')) throw new Error(`a ${job.kind} job needs a phase id`);
  const branch = job.branch ?? jobBranch({ ...job, phase });
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('.lock')) throw new Error(`job.branch must be turbo/<name> (letters, digits, . _ -), not ${branch}`);
  return { kind: job.kind, phase, branch };
}

// A slot given as its number, its path or a Slot: always looked up again at its place for this project, so a path
// never leads turbo elsewhere.
function slotK(slot) {
  const k = typeof slot === 'number' ? slot : slot?.k ?? Number(SLOT_RE.exec(path.basename(String(slot)))?.[1]);
  if (!Number.isInteger(k) || k < 1) throw new Error(`not a slot: ${String(slot?.path ?? slot)}`);
  return k;
}

// D10: the lockfiles of npm, pnpm and yarn and their install commands, first match per directory.
export const LOCKFILES = Object.freeze([
  ['package-lock.json', 'npm ci'],
  ['npm-shrinkwrap.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --immutable'],
]);
export const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
export const depsFile = (slot) => path.join(slot, '.git', 'turbo-deps.json');
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// For each directory of test.full: its lockfile, the install command (lanes.install or by the lockfile), the hash of
// both, and whether the slot's last install had that hash.
export function depsPlan(slot, config) {
  const lanes = lanesSettings(config?.lanes);
  const saved = readJson(depsFile(slot), null);
  const entries = isObj(saved?.entries) ? saved.entries : {};
  return fullEntries(config?.test?.full, slot).map(({ dir }) => {
    const cwd = dir ? path.join(slot, ...dir.split('/')) : slot;
    const found = LOCKFILES.find(([f]) => fs.existsSync(path.join(cwd, f)));
    if (!found) return { dir, cwd, lockfile: null, command: null, sha256: null, action: 'none' };
    const [lockfile, auto] = found;
    const command = lanes.install || auto;
    const sha256 = createHash('sha256').update(fs.readFileSync(path.join(cwd, lockfile))).update('\0').update(command).digest('hex');
    return { dir, cwd, lockfile, command, sha256, action: entries[dir]?.sha256 === sha256 ? 'unchanged' : 'install' };
  });
}

// The install command through bash -c, as test.full runs (GSD runs commands that way); the system shell without bash.
export function runInstall(command, { cwd, timeout = INSTALL_TIMEOUT_MS } = {}) {
  const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 };
  let r = spawnSync('bash', ['-c', command], opts);
  if (r.error?.code === 'ENOENT') r = spawnSync(command, { ...opts, shell: true });
  if (r.error) return { code: 1, tail: r.error.code || errLine(r.error) };
  const tail = maskSecrets(String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ')).slice(-300);
  return { code: r.status ?? 1, tail };
}

// spec §4: install only where the lockfile (or the command) changed since the slot's last install. A failure refuses
// the job and leaves that directory's record as it was; a node_modules that is a link refuses before anything runs.
export function ensureDeps(slot, config, deps = {}) {
  const run = deps.run || runInstall;
  const now = deps.now || (() => new Date());
  const plan = depsPlan(slot, config);
  const saved = readJson(depsFile(slot), null);
  const entries = isObj(saved?.entries) ? { ...saved.entries } : {};
  for (const p of plan) {
    if (p.action !== 'install') continue;
    const nm = path.join(p.cwd, 'node_modules');
    if (isLink(nm)) refuse('link', `${nm} is a link: node_modules is a link; a slot installs its own dependencies, never another checkout's (remove the link, not its target)`);
    const r = run(p.command, { cwd: p.cwd });
    if (r.code !== 0) refuse('install', `${p.command} in ${p.dir || 'the project root'} of ${slot} failed (exit ${r.code})${r.tail ? `: ${r.tail}` : ''}`);
    entries[p.dir] = { lockfile: p.lockfile, sha256: p.sha256, command: p.command, at: now().toISOString() };
    writeJsonAtomic(depsFile(slot), { v: 1, entries });
  }
  return plan.map(({ dir, lockfile, command, action }) => ({ dir, lockfile, command, action: action === 'install' ? 'installed' : action }));
}

// spec §4 Подготовка к задаче: fetch the main checkout, a fresh turbo/<job> branch at its main branch, git clean of
// everything but the copies and node_modules, the copies and settings again, the dependencies, then the job record.
// Only a free slot (D12); every refusal changes nothing.
export function prepareSlot(root, slot, job, deps = {}) {
  const git = gitOf(deps);
  const now = deps.now || (() => new Date());
  const config = deps.config || loadConfig(root);
  if (lanesSettings(config.lanes).mode !== 'slots') refuse('mode', 'lanes.mode is checkout: lanes work in this checkout, no slots');
  const j = checkJob(job);
  const k = slotK(slot);
  const s = slotPath(root, config, k);
  let info;
  try {
    info = slotInfo(root, k, s, git);
  } catch (err) {
    refuse('broken', `slot ${k} cannot be read (${errLine(err)}): nothing was changed; look at ${s}`);
  }
  if (info.state === 'missing') refuse('missing', `slot ${k} does not exist (${s}): turbo-run lanes setup`);
  if (info.state === 'foreign') refuse('foreign', `${s} is not slot ${k} of this project: turbo never uses it`);
  if (info.state === 'busy') refuse('busy', `slot ${k} holds ${describeJob(info.record.job)}: release it first; its work is never overwritten`);
  if (info.state === 'dirty') refuse('dirty', `slot ${k} has changes no finished job explains (${info.dirty.slice(0, 10).join('; ')}${info.dirty.length > 10 ? '; …' : ''}): nothing was changed; look at ${s}`);
  const files = checkedCopies(root, config, git);
  const branch = mainBranch(root, { git });
  const prev = git(s, ['symbolic-ref', '-q', '--short', 'HEAD'], { ok: true });
  git(s, ['fetch', '-q', '--prune', 'origin']);
  const sha = git(s, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`]);
  const keep = ['-e', 'node_modules', ...[SETTINGS_LOCAL, ...(info.record.copied || [])].flatMap((f) => ['-e', ignoreLine(f)])];
  git(s, ['clean', '-q', '-f', '-d', '-x', ...keep]);
  git(s, ['checkout', '-q', '--no-track', '-B', j.branch, `refs/remotes/origin/${branch}`]);
  git(s, ['clean', '-q', '-f', '-d', '-x', ...keep]);
  if (prev && prev !== j.branch && prev.startsWith('turbo/')) {
    try {
      git(s, ['branch', '-q', '-D', prev], { ok: true });
    } catch (err) {
      deps.log?.(`slot ${k}: the old branch ${prev} was kept (${errLine(err)})`);
    }
  }
  refreshSlot(root, s, files, git);
  const installed = ensureDeps(s, config, { run: deps.run, now });
  const record = {
    ...readSlotRecord(s),
    job: { kind: j.kind, phase: j.phase, branch: j.branch, base: { branch, sha }, state: 'active', startedAt: now().toISOString(), endedAt: null, outcome: null },
  };
  writeSlotRecord(s, record);
  return { k, path: s, branch: j.branch, base: { branch, sha }, deps: installed, record };
}

// The job of the slot is over (L2 after the merge and green CI, L1 when a lane fails or is abandoned). The slot keeps
// its branch and files until its next prepare.
export function releaseSlot(root, slot, { outcome = 'merged', now = () => new Date(), config } = {}) {
  if (!JOB_OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${JOB_OUTCOMES.join(', ')}`);
  const k = slotK(slot);
  const s = slotPath(root, config ?? loadConfig(root), k);
  const rec = readSlotRecord(s);
  if (!ours(rec, root) || rec.k !== k) refuse('foreign', `${s} is not slot ${k} of this project`);
  if (!rec.job || rec.job.state === 'done') return rec;
  const next = { ...rec, job: { ...rec.job, state: 'done', endedAt: now().toISOString(), outcome } };
  writeSlotRecord(s, next);
  return next;
}

// The slot whose active job is this phase's (kind phase by default; prep, or annotate with phase null). Records only:
// no git call.
export function slotForPhase(root, config, phase, { kind = 'phase' } = {}) {
  const want = phase === null || phase === undefined ? null : String(phase);
  for (const k of slotNumbers(root, config)) {
    const p = slotPath(root, config, k);
    const rec = readSlotRecord(p);
    if (ours(rec, root) && rec.k === k && rec.job?.state === 'active' && rec.job.kind === kind && (rec.job.phase ?? null) === want) return { k, path: p, record: rec };
  }
  return null;
}

// spec §5 p.4: the first slot that is free and that Claude Code trusts, or null.
export function freeSlot(root, config, deps = {}) {
  return listSlots(root, config, deps).find((s) => s.state === 'free' && trustState(s.path, { file: deps.claudeJson, platform: deps.platform }) === 'trusted') ?? null;
}

function removeLink(p) {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EISDIR') fs.rmdirSync(p);
    else throw err;
  }
}

// Links inside a slot that lead outside it (a junction into another checkout's node_modules, say) are removed first,
// as links: the recursive delete never reaches what they point to.
function unlinkOutsideLinks(dir) {
  const base = fs.realpathSync.native(dir);
  const within = (p) => {
    const r = path.relative(base, p);
    return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  };
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.realpathSync.native(p);
        } catch {
          // a dangling link goes too
        }
        if (target === null || !within(target)) removeLink(p);
      } else if (e.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(dir);
}

// turbo-run lanes remove (spec §4): only a free slot without lane branches the main branch lacks; its trust goes first
// (§4.1 rules), then its outside links, then the directory.
export function removeSlot(root, config, k, deps = {}) {
  const git = gitOf(deps);
  const s = slotPath(root, config, k);
  const info = slotInfo(root, k, s, git);
  if (info.state === 'missing') return { k, path: s, removed: false, why: 'missing', untrust: null };
  if (info.state === 'foreign') refuse('foreign', `${s} is not slot ${k} of this project: turbo never deletes it`);
  if (info.state === 'busy') refuse('busy', `slot ${k} holds ${describeJob(info.record.job)}: release it first`);
  if (info.state !== 'free') refuse('dirty', `slot ${k} has changes (${info.dirty.slice(0, 10).join('; ')}): nothing was removed; look at ${s}`);
  const branch = mainBranch(root, { git });
  git(s, ['fetch', '-q', '--prune', 'origin']);
  const unmerged = (git(s, ['for-each-ref', '--format=%(refname:short)', '--no-merged', `refs/remotes/origin/${branch}`, 'refs/heads/turbo']) || '').split(/\r?\n/).filter(Boolean);
  if (unmerged.length) refuse('unmerged', `slot ${k} has lane branches with commits ${branch} does not have (${unmerged.join(', ')}): nothing was removed; when their work is not needed, delete them in ${s} (git branch -D <branch>)`);
  const lanes = lanesSettings(config?.lanes);
  const untrust = (deps.untrust || ((p) => untrustSlot(p, { file: deps.claudeJson, write: deps.trustWrite ?? lanes.trust_write, now: deps.now })))(s);
  unlinkOutsideLinks(s);
  fs.rmSync(s, { recursive: true, force: true, maxRetries: 3 });
  return { k, path: s, removed: true, why: null, untrust };
}
