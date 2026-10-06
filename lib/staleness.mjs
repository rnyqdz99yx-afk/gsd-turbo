import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { phaseArtifacts } from './phase-files.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { splitZ } from './test-changed.mjs';

export const BASE_FILE = 'turbo-base.json';
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SPLIT_RE = /[\s`'"()<>[\]{},;|*]+/;
// A token starts with a repo path: GSD's "@path" form, a "./" prefix and dot-paths (".env.example")
// included, a trailing "/" for a directory. Whatever follows the path is only read for a line
// reference (":12", ":12-30", ":12:5", ":L12", "#L12", "#12"); it never drops the path.
const PATH_RE = /^(?:\.\/)*([\p{L}\p{N}_@.+-]+(?:\/[\p{L}\p{N}_@.+-]+)*)(\/?)(.*)/u;
const LINE_RE = /^(?::L?|#L?)\d/;
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
// GSD's nested plan layout (plan-scan.cjs isNestedPlanFile), outlines and pre-bounce copies excluded.
const NESTED_PLAN_RE = /(?:^|-)PLAN-\d+.*\.md$/i;
const NOT_A_PLAN_RE = /-OUTLINE\.md$|\.pre-bounce\.md$/i;
const GIT = ['-c', 'core.quotepath=false', '--literal-pathspecs'];
const CHUNK = 200;
const badSegment = (s) => s === '' || s === '.' || s === '..';

// Both spellings of an "@path": the existence check keeps whichever names a file.
const spellings = (p) => (p.startsWith('@') && p.length > 1 ? [p, p.slice(1)] : [p]);

export function extractRefs(text) {
  const paths = new Set();
  const lineRefs = new Set();
  for (const raw of String(text ?? '').replace(/\\/g, '/').split(SPLIT_RE)) {
    const m = PATH_RE.exec(raw);
    if (!m) continue;
    const p = m[1].replace(/\.+$/, '');
    const bare = p.replace(/^@/, '');
    if (!bare || p.split('/').some(badSegment)) continue;
    if (!m[2] && !bare.includes('/') && !FILE_EXT_RE.test(bare)) continue;
    const line = LINE_RE.test(m[3]);
    for (const q of spellings(p)) {
      paths.add(q);
      if (line) lineRefs.add(q);
    }
  }
  return { paths: [...paths], lineRefs: [...lineRefs] };
}

// A declared path (files_modified, files_deleted) read the same way as a cited one.
function declaredRefs(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return s && !s.split('/').some(badSegment) ? spellings(s) : [];
}

export function classifyArtifact({ kind, refs, lineRefs = [], changes }) {
  const cited = new Set(lineRefs);
  const reasons = [];
  let action = 'fresh';
  for (const p of [...refs].sort()) {
    const st = changes.get(p);
    if (!st) continue;
    if (st === 'D') {
      action = 'rebuild';
      reasons.push(`${p}: deleted or renamed`);
    } else if (kind !== 'context' && (st === 'A' || cited.has(p))) {
      if (action === 'fresh') action = 'reground';
      reasons.push(st === 'A' ? `${p}: created since the artifact was written` : `${p}: changed at a referenced line`);
    }
  }
  return { action, reasons };
}

// (args, encoding = 'utf8') => stdout; encoding 'buffer' returns the raw bytes (for -z output).
export function gitRunner(root) {
  return (args, encoding = 'utf8') => execFileSync('git', [...GIT, ...args], {
    cwd: root, encoding, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 * 1024,
  });
}

const gitZ = (git, args) => splitZ(git(args, 'buffer')).names;

// The HEAD commit, or null before the first commit (an unborn HEAD exits 1 under --verify -q).
export function headSha(git) {
  try {
    return String(git(['rev-parse', '--verify', '-q', 'HEAD'])).trim() || null;
  } catch (e) {
    if (e?.status === 1) return null;
    throw e;
  }
}

export function diffStatus(git, base, paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += CHUNK) {
    // -z with --no-renames: "<status>\0<path>\0" pairs
    const z = gitZ(git, ['diff', '--name-status', '-z', '--no-renames', '--relative', base, 'HEAD', '--', ...paths.slice(i, i + CHUNK)]);
    for (let j = 0; j + 1 < z.length; j++) {
      if (!/^[A-Z]\d*$/.test(z[j])) continue;
      out.set(z[j + 1], z[j][0]);
      j++;
    }
  }
  return out;
}

// The files of one commit, and (built on first use) every directory that holds one.
function treeIndex(git, sha) {
  const files = new Set(gitZ(git, ['ls-tree', '-r', '--name-only', '-z', sha]));
  let dirs = null;
  const hasDir = (d) => {
    if (!dirs) {
      dirs = new Set();
      for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
    }
    return dirs.has(d);
  };
  return { files, hasDir };
}

// `key` is the artifact's path inside the phase directory ("03-01-PLAN.md", "plans/PLAN-01.md").
export function artifactBase({ git, phaseDir, rel, key = path.posix.basename(rel) }) {
  const raw = readJson(path.join(phaseDir, BASE_FILE), null);
  const rec = raw && typeof raw === 'object' ? raw[key] : null;
  if (rec && SHA_RE.test(String(rec.base_sha))) {
    try {
      git(['cat-file', '-e', `${rec.base_sha}^{commit}`]);
      return { sha: rec.base_sha, source: 'record' };
    } catch {
      // the recorded commit is gone (rewritten history): fall back to the artifact's own commit
    }
  }
  let last = '';
  try {
    last = git(['log', '-1', '--format=%H', '--', rel]).trim();
  } catch {
    // no history yet
  }
  return last ? { sha: last, source: 'commit' } : { sha: null, source: 'uncommitted' };
}

// Code-unit order, never locale order: the committed file must not depend on who wrote it.
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

export function recordBases(phaseDir, files, sha, now = new Date()) {
  const f = path.join(phaseDir, BASE_FILE);
  const raw = readJson(f, null);
  const cur = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const name of files) cur[name] = { base_sha: sha, recorded_at: now.toISOString() };
  writeJsonAtomic(f, Object.fromEntries(Object.entries(cur).sort(byKey)));
  return f;
}

// GSD plan-document.cjs planIdFromFile, reversed: "<id>-PLAN.md", the bare "PLAN.md" (id ''), and the
// nested layout, whose id is its own "plans/..." path.
export const planFileOf = (id) => (id === '' ? 'PLAN.md' : id.includes('/') ? id : `${id}-PLAN.md`);

function readdirOrEmpty(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
}

// Every artifact the report can check, as phase-directory paths: CONTEXT, RESEARCH, PATTERNS and the
// plans in GSD's root ("<id>-PLAN.md", "PLAN.md") and nested ("plans/PLAN-NN....md") layouts.
export function artifactFiles(phaseDir) {
  const a = phaseArtifacts(phaseDir);
  const bare = fs.existsSync(path.join(phaseDir, 'PLAN.md')) ? ['PLAN.md'] : [];
  const nested = readdirOrEmpty(path.join(phaseDir, 'plans')).filter((f) => NESTED_PLAN_RE.test(f) && !NOT_A_PLAN_RE.test(f)).sort().map((f) => `plans/${f}`);
  return [a.context, a.research, a.patterns, ...a.plans.map((p) => p.file), ...bare, ...nested].filter(Boolean);
}

export function stalenessReport({ root, phaseDir, plans = [], git = gitRunner(root), readText = (f) => fs.readFileSync(f, 'utf8') }) {
  const pending = plans.filter((p) => !p.has_summary);
  if (plans.length && !pending.length) return { head: null, skipped: 'every plan has a summary', artifacts: [] };
  const a = phaseArtifacts(phaseDir);
  const relDir = path.relative(root, phaseDir).split(path.sep).join('/');
  const items = [];
  for (const kind of ['context', 'research', 'patterns']) if (a[kind]) items.push({ kind, file: a[kind], extra: [] });
  for (const p of pending) {
    const id = String(p.id ?? '');
    const file = planFileOf(id);
    const extra = [...(p.files_modified || []), ...(p.files_deleted || [])];
    items.push({ kind: 'plan', id, file, extra, missing: !fs.existsSync(path.join(phaseDir, file)) });
  }
  const head = headSha(git);
  const trees = new Map();
  const tree = (sha) => {
    if (!trees.has(sha)) trees.set(sha, treeIndex(git, sha));
    return trees.get(sha);
  };
  // The phase's own files (its summaries, its other plans) are its progress, not drift under it.
  const outside = (p) => p !== relDir && !p.startsWith(`${relDir}/`);
  const artifacts = items.map(({ kind, id, file, extra = [], missing }) => {
    const row = { kind, ...(kind === 'plan' ? { id } : {}), file, base: null, baseSource: 'uncommitted', action: 'fresh', reasons: [] };
    if (missing) return { ...row, baseSource: 'missing', action: 'rebuild', reasons: ['plan file not found'] };
    if (!head) return row;
    const base = artifactBase({ git, phaseDir, rel: `${relDir}/${file}`, key: file });
    Object.assign(row, { base: base.sha, baseSource: base.source });
    if (!base.sha || base.sha === head) return row;
    const { paths, lineRefs } = extractRefs(readText(path.join(phaseDir, file)));
    const [atBase, atHead] = [tree(base.sha), tree(head)];
    const cands = [...new Set([...extra.flatMap(declaredRefs), ...paths])].filter(outside);
    const files = cands.filter((p) => atBase.files.has(p) || atHead.files.has(p));
    const dirs = cands.filter((p) => !atBase.files.has(p) && !atHead.files.has(p) && (atBase.hasDir(p) || atHead.hasDir(p)));
    const changes = diffStatus(git, base.sha, files);
    for (const d of dirs) if (atBase.hasDir(d) !== atHead.hasDir(d)) changes.set(d, atBase.hasDir(d) ? 'D' : 'A');
    return { ...row, ...classifyArtifact({ kind, refs: [...files, ...dirs], lineRefs, changes }) };
  });
  return { head, skipped: null, artifacts };
}
