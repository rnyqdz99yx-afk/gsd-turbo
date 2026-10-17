import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { phaseArtifacts } from './phase-files.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { splitZ } from './test-changed.mjs';

export const BASE_FILE = 'turbo-base.json';
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// Brackets and parentheses are not separators: they are path segments in routing layouts
// ("app/[slug]/page.tsx", "app/(auth)/login"). trimToken strips them only where they wrap a token.
const SPLIT_RE = /[\s`'"<>{},;|*]+/;
// A token starts with a repo path: GSD's "@path" form, a "./" prefix and dot-paths (".env.example")
// included, a trailing "/" for a directory. Whatever follows the path is only read for a line
// reference (":12", ":12-30", ":12:5", ":L12", "#L12", "#12"); it never drops the path.
const SEG = String.raw`[\p{L}\p{N}_@.+()\[\]-]+`;
const PATH_RE = new RegExp(String.raw`^(${SEG}(?:\/${SEG})*)(\/?)(.*)`, 'u');
const LINE_RE = /^(?::L?|#L?)\d/;
// A citation in its own tokens: "line 4", "lines 12-25", "(lines 1-8)", "L12-L30".
const CITE_WORD_RE = /^lines?$/i;
const CITE_L_RE = /^L\d+(?:[-–—]L?\d+)?$/;
// tsc's "path(line,col)" glued to a path: the line is also read as "path:line" ("src/file(1).ts" stays too).
const TSC_LINE_RE = /(?<=[^\s([/])\((\d+)(?:,\d+)?\)/g;
const PAIRS = [['(', ')'], ['[', ']']];
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
// GSD's nested plan layout (plan-scan.cjs isNestedPlanFile), outlines and pre-bounce copies excluded.
const NESTED_PLAN_RE = /(?:^|-)PLAN-\d+.*\.md$/i;
const NOT_A_PLAN_RE = /-OUTLINE\.md$|\.pre-bounce\.md$/i;
// Top-level planning docs (STATE.md, ROADMAP.md, PROJECT.md, …): GSD rewrites them on nearly every step.
const PLANNING_DOC_RE = /^\.planning\/[^/]+\.md$/;
const GIT = ['-c', 'core.quotepath=false', '--literal-pathspecs'];
const CHUNK = 200;
const badSegment = (s) => s === '' || s === '.' || s === '..';

// Both spellings of an "@path": the existence check keeps whichever names a file.
const spellings = (p) => (p.startsWith('@') && p.length > 1 ? [p, p.slice(1)] : [p]);

const countOf = (s, c) => s.split(c).length - 1;

// True when the opener at 0 closes only at the last character: "(a/b)" yes, "(auth)/x/(y)" no.
function wraps(t, o, c) {
  if (t.length < 2 || t[0] !== o || t[t.length - 1] !== c) return false;
  let depth = 0;
  for (let i = 0; i < t.length - 1; i++) {
    if (t[i] === o) depth++;
    else if (t[i] === c && --depth === 0) return false;
  }
  return true;
}

// Sentence punctuation and the brackets around a token ("(lines", "1-8):", "[src/a.ts]") go; brackets
// that belong to a path segment stay.
function trimToken(t) {
  for (let prev = null; prev !== t;) {
    prev = t;
    t = t.replace(/[.,:;!?]+$/, '');
    for (const [o, c] of PAIRS) {
      if (wraps(t, o, c)) t = t.slice(1, -1);
      else if (t.startsWith(o) && countOf(t, o) > countOf(t, c)) t = t.slice(1);
      else if (t.endsWith(c) && countOf(t, c) > countOf(t, o)) t = t.slice(0, -1);
    }
  }
  return t;
}

// The spellings a token names as a path, and whether its own suffix cites a line; null for no path.
function refOf(tok) {
  const m = PATH_RE.exec(tok.replace(/^(@?)(?:\.\/)+/, '$1'));
  if (!m) return null;
  const p = m[1].replace(/\.+$/, '');
  const bare = p.replace(/^@/, '');
  if (!bare || p.split('/').some(badSegment)) return null;
  if (!m[2] && !bare.includes('/') && !FILE_EXT_RE.test(bare)) return null;
  return { names: spellings(p), line: LINE_RE.test(m[3]) };
}

// Every path a token names. A token with brackets also yields its bracket-split pieces, so a bracket
// glued to a path ("require(src/a.ts)", "(src/a.ts)—the analog") never hides it; a piece inherits the
// token's line suffix and one that follows it (":12"). The existence check drops the non-files.
function refsOf(tok) {
  const whole = refOf(tok);
  const out = whole ? [whole] : [];
  if (!/[()[\]]/.test(tok)) return out;
  const pieces = tok.split(/[()[\]]+/);
  pieces.forEach((piece, i) => {
    const r = refOf(trimToken(piece));
    if (r) out.push({ names: r.names, line: r.line || Boolean(whole?.line) || LINE_RE.test(pieces[i + 1] ?? '') });
  });
  return out;
}

const isCitation = (toks, i) => CITE_L_RE.test(toks[i]) || (CITE_WORD_RE.test(toks[i]) && /^\d/.test(toks[i + 1] ?? ''));

// `paths`: every repo path named anywhere in the text, code fences and fence lines included (a superset;
// the existence check drops the non-files). `lineRefs`: the paths cited with a line, by their own suffix
// (":12", "#L12", tsc's "(12,5)") or by a citation on the same line ("lines 12-25", "(L12-L30)"). They only
// word the reason: the action never depends on them.
export function extractRefs(text) {
  const paths = new Set();
  const lineRefs = new Set();
  for (const line of String(text ?? '').replace(/\\/g, '/').split(/\r?\n/)) {
    const tsc = line.replace(TSC_LINE_RE, ':$1');
    const onLine = [];
    let cited = false;
    for (const variant of tsc === line ? [line] : [line, tsc]) {
      const toks = variant.split(SPLIT_RE).flatMap((raw) => raw.split('](')).map(trimToken).filter(Boolean);
      toks.forEach((tok, i) => {
        const refs = refsOf(tok);
        for (const r of refs) {
          for (const q of r.names) {
            paths.add(q);
            if (r.line) lineRefs.add(q);
            onLine.push(q);
          }
        }
        if (!refs.length && isCitation(toks, i)) cited = true;
      });
    }
    if (cited) for (const q of onLine) lineRefs.add(q);
  }
  return { paths: [...paths], lineRefs: [...lineRefs] };
}

// A declared path (files_modified, files_deleted) read the same way as a cited one.
function declaredRefs(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^(@?)(?:\.\/)+/, '$1').replace(/\/+$/, '');
  return s && !s.split('/').some(badSegment) ? spellings(s) : [];
}

// A referenced path deleted or renamed away → rebuild; created or changed in any way → reground (CONTEXT:
// only deletions count). lineRefs only word the reason, so a missed line citation never reads as fresh.
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
    } else if (kind !== 'context') {
      if (action === 'fresh') action = 'reground';
      const why = st === 'A' ? 'created since the artifact was written' : cited.has(p) ? 'changed at a referenced line' : 'changed since the artifact was written';
      reasons.push(`${p}: ${why}`);
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

// The project's own workflow.code_review (GSD's default: on). While turbo has GSD's gates off (`.planning/turbo/gates/
// p<N>.json`, maybe for another lane), the live config says false: the value saved before gates off decides.
const CODE_REVIEW_KEY = 'workflow.code_review';
const isOff = (v) => v === false || v === 'false';
function codeReviewOn(root) {
  const dir = path.join(root, '.planning', 'turbo', 'gates');
  for (const name of readdirOrEmpty(dir).filter((n) => /^p.+\.json$/.test(n)).sort()) {
    const original = readJson(path.join(dir, name), null)?.original;
    if (original && typeof original === 'object' && Object.hasOwn(original, CODE_REVIEW_KEY)) return !isOff(original[CODE_REVIEW_KEY]);
  }
  return !isOff(readJson(path.join(root, '.planning', 'config.json'), null)?.workflow?.code_review);
}

// The status the report's frontmatter holds (human_needed, passed, ...) as the verifier wrote it; GSD's status reader
// answers `stale` instead once a covered file moved. null without a readable frontmatter status.
function reportedStatus(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.replace(/^﻿/, ''));
  const v = fm && /^status:[ \t]*(["']?)([A-Za-z_-]+)\1[ \t]*\r?$/m.exec(fm[1]);
  return v ? v[2] : null;
}

// How a stale VERIFICATION.md is made fresh again. Any UAT write after verification stales it (the UAT file is in the
// report's covered_files). When every path changed since the report's last commit (committed, staged, unstaged or
// untracked) lies under .planning/, no code changed: the code review and the green test and CI runs before that commit
// still hold, so only GSD's verifier runs again ('verifier-only'). Anything else, a report that is missing or was never
// committed included, keeps GSD's whole chain ('full'). `review` is the last commit of the phase's REVIEW.md, for the
// note.
export function verificationRoute({ root, phaseDir, git = gitRunner(root) }) {
  const a = phaseArtifacts(phaseDir);
  const relDir = path.relative(root, phaseDir).split(path.sep).join('/');
  const lastCommit = (rel) => {
    try {
      return String(git(['log', '-1', '--format=%H', '--', rel])).trim() || null;
    } catch {
      return null;
    }
  };
  const review = a.review ? lastCommit(`${relDir}/${a.review}`) : null;
  const base = { route: 'full', uatOnly: false, report: null, reported: null, since: null, review, code: [], planning: [] };
  if (!a.verification) return { ...base, reason: 'no verification report' };
  const report = `${relDir}/${a.verification}`;
  base.reported = reportedStatus(path.join(phaseDir, a.verification));
  const since = lastCommit(report);
  if (!since) return { ...base, report, reason: 'the verification report is not committed' };
  // git prints repository-root paths; the project's own .planning/ sits under the prefix of the project root
  const prefix = String(git(['rev-parse', '--show-prefix'])).trim();
  const changed = new Set([
    ...gitZ(git, ['diff', '--name-only', '-z', '--no-renames', since]),
    ...gitZ(git, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z']),
  ]);
  const all = [...changed].sort();
  const isPlanning = (p) => p.startsWith(`${prefix}.planning/`);
  const code = all.filter((p) => !isPlanning(p));
  const planning = all.filter(isPlanning);
  if (code.length) return { ...base, report, since, code, planning, reason: 'code changed since the report' };
  // the last code review must have seen the code the report verified: a code change between the two keeps the chain
  // GSD's code review is on unless the project turns workflow.code_review off: then a review must be on record
  if (!review && codeReviewOn(root)) return { ...base, report, since, planning, reason: 'code review is on, but no code review is committed' };
  const unreviewed = review ? gitZ(git, ['diff', '--name-only', '-z', '--no-renames', review, since]).filter((p) => !isPlanning(p)).sort() : [];
  if (unreviewed.length) return { ...base, report, since, code: unreviewed, planning, reason: 'code changed after the last code review' };
  const note = review
    ? `regression gate and code review not re-run: counted from the code review at ${review.slice(0, 12)}`
    : 'regression gate and code review not re-run; no code review on record';
  // uatOnly: nothing but the phase's UAT file, STATE.md, turbo's run files and the owner's answers changed, so the
  // report's human items still stand; a changed plan, context or roadmap may change them
  const uatFile = a.uat ? `${prefix}${relDir}/${a.uat}` : null;
  const uatOnly = planning.every((p) => p === uatFile || p === `${prefix}.planning/STATE.md` || p.startsWith(`${prefix}.planning/turbo/run/`) || p.startsWith(`${prefix}.planning/turbo/answers/`));
  return { ...base, route: 'verifier-only', uatOnly, report, since, planning, note };
}

// Stage 6 L2 (spec §5.3, re-gate): every path that changed since commit `sha` (committed, staged, unstaged and
// untracked), relative to the project root (git's cwd) and sorted; `planning` holds those under .planning/.
export function changedSince(git, sha) {
  const all = [...new Set([
    ...gitZ(git, ['diff', '--name-only', '-z', '--no-renames', '--relative', sha]),
    ...gitZ(git, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])].sort();
  const isPlanning = (p) => p.startsWith('.planning/');
  return { code: all.filter((p) => !isPlanning(p)), planning: all.filter(isPlanning) };
}

// The last commit that touched `rel` (project-relative), or null: never committed, or no git.
export function lastCommitOf(git, rel) {
  try {
    return String(git(['log', '-1', '--format=%H', '--', rel])).trim() || null;
  } catch {
    return null;
  }
}

// An injected `git` follows gitRunner's contract: (args, encoding = 'utf8') returns a string, or a Buffer
// when encoding is 'buffer', and throws like execFileSync (`status` 1 for an unborn HEAD).
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
  // A file created in the phase's own directory (a summary written while it runs) is its progress, not
  // drift under it; a deleted or changed file there still counts. An edit to a top-level planning doc is
  // planning context, not code drift: only its deletion counts.
  const own = (p) => p === relDir || p.startsWith(`${relDir}/`);
  const ignored = (p, st) => (st === 'A' && own(p)) || ((st === 'M' || st === 'T') && PLANNING_DOC_RE.test(p));
  const artifacts = items.map(({ kind, id, file, extra = [], missing }) => {
    const row = { kind, ...(kind === 'plan' ? { id } : {}), file, base: null, baseSource: 'uncommitted', action: 'fresh', reasons: [] };
    if (missing) return { ...row, baseSource: 'missing', action: 'rebuild', reasons: ['plan file not found'] };
    if (!head) return row;
    const base = artifactBase({ git, phaseDir, rel: `${relDir}/${file}`, key: file });
    Object.assign(row, { base: base.sha, baseSource: base.source });
    if (!base.sha || base.sha === head) return row;
    const { paths, lineRefs } = extractRefs(readText(path.join(phaseDir, file)));
    const [atBase, atHead] = [tree(base.sha), tree(head)];
    const cands = [...new Set([...extra.flatMap(declaredRefs), ...paths])];
    const files = cands.filter((p) => atBase.files.has(p) || atHead.files.has(p));
    const dirs = cands.filter((p) => !atBase.files.has(p) && !atHead.files.has(p) && (atBase.hasDir(p) || atHead.hasDir(p)));
    const changes = diffStatus(git, base.sha, files);
    for (const d of dirs) if (atBase.hasDir(d) !== atHead.hasDir(d)) changes.set(d, atBase.hasDir(d) ? 'D' : 'A');
    for (const [p, st] of changes) if (ignored(p, st)) changes.delete(p);
    return { ...row, ...classifyArtifact({ kind, refs: [...files, ...dirs], lineRefs, changes }) };
  });
  return { head, skipped: null, artifacts };
}
