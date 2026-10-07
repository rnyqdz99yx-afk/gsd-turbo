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
// tsc's "path(line,col)" glued to a path: rewritten to "path:line" before tokenizing.
const TSC_LINE_RE = /(?<=[^\s([/])\((\d+)(?:,\d+)?\)/g;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const PAIRS = [['(', ')'], ['[', ']']];
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
// GSD's nested plan layout (plan-scan.cjs isNestedPlanFile), outlines and pre-bounce copies excluded.
const NESTED_PLAN_RE = /(?:^|-)PLAN-\d+.*\.md$/i;
const NOT_A_PLAN_RE = /-OUTLINE\.md$|\.pre-bounce\.md$/i;
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

// How many tokens a citation at toks[i] spans: 1 for "L12-L30", 2 for "lines 12-25", 0 for none.
const citationAt = (toks, i) => (CITE_L_RE.test(toks[i]) ? 1 : CITE_WORD_RE.test(toks[i]) && /^\d/.test(toks[i + 1] ?? '') ? 2 : 0);

// Per line: 'fence' (a fence line), 'code' (inside a fence) or 'text'. CommonMark: a closing fence
// repeats the opener's character at least as many times and carries nothing else; a fence that never
// closes leaves the rest as text, so one stray fence cannot hide the rest of the artifact.
function fenceKinds(lines) {
  const kinds = lines.map(() => 'text');
  let open = null;
  lines.forEach((l, i) => {
    const m = FENCE_RE.exec(l);
    if (open) {
      const closes = m && m[1][0] === open.ch && m[1].length >= open.len && !m[2].trim();
      kinds[i] = closes ? 'fence' : 'code';
      if (closes) open = null;
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      kinds[i] = 'fence';
      open = { ch: m[1][0], len: m[1].length, at: i };
    }
  });
  if (open) kinds.fill('text', open.at);
  return kinds;
}

// A citation in its own tokens ("lines 12-25", "(lines 1-8)", "L12") covers every path on its line and
// every path cited since the last markdown heading (GSD's PATTERNS.md puts "**Analog:** `path`" a few
// lines above its "(lines 1-8)", often after a label such as "Header/doc-comment" that looks like a
// path too). Covering too many paths can only cause a needless reground; covering the wrong one alone
// would read a stale artifact as fresh. Inside code fences paths count, citations do not.
export function extractRefs(text) {
  const paths = new Set();
  const lineRefs = new Set();
  const lines = String(text ?? '').replace(/\\/g, '/').split(/\r?\n/);
  const kinds = fenceKinds(lines);
  let section = new Set();
  lines.forEach((line, n) => {
    if (kinds[n] === 'fence') return;
    const code = kinds[n] === 'code';
    if (!code && HEADING_RE.test(line)) section = new Set();
    const toks = line.replace(TSC_LINE_RE, ':$1').split(SPLIT_RE).flatMap((raw) => raw.split('](')).map(trimToken).filter(Boolean);
    const onLine = [];
    let cited = false;
    for (let i = 0; i < toks.length; i++) {
      const refs = refsOf(toks[i]);
      for (const r of refs) {
        for (const q of r.names) {
          paths.add(q);
          if (r.line) lineRefs.add(q);
          onLine.push(q);
        }
      }
      if (refs.length || code) continue;
      const span = citationAt(toks, i);
      if (span) {
        cited = true;
        i += span - 1;
      }
    }
    if (code) return;
    for (const q of onLine) section.add(q);
    if (cited) for (const q of section) lineRefs.add(q);
  });
  return { paths: [...paths], lineRefs: [...lineRefs] };
}

// A declared path (files_modified, files_deleted) read the same way as a cited one.
function declaredRefs(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^(@?)(?:\.\/)+/, '$1').replace(/\/+$/, '');
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
  // drift under it; a deleted sibling or a changed cited line there still counts.
  const own = (p) => p === relDir || p.startsWith(`${relDir}/`);
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
    for (const [p, st] of changes) if (st === 'A' && own(p)) changes.delete(p);
    return { ...row, ...classifyArtifact({ kind, refs: [...files, ...dirs], lineRefs, changes }) };
  });
  return { head, skipped: null, artifacts };
}
