import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dirKey, slotRecordFile } from './paths.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fsx.mjs';
import { DEFAULTS, deepMerge, lanesSettings } from './config.mjs';
import { trustSlot } from './trust.mjs';

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
