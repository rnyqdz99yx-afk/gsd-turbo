import fs from 'node:fs';
import path from 'node:path';
import { normalizePhaseId } from './gsd.mjs';

// GSD phase directories: "<padded id>-<slug>", optionally behind a project code ("ABC-05-slug").
const PROJECT_CODE_RE = /^[A-Z][A-Z0-9_]*-(?=\d)/i;

// Artifact kind -> file-name suffix. GSD names them "<padded id>-<SUFFIX>.md" (milestone-prefixed:
// "02-01-<SUFFIX>.md"), without the project code; matching the whole name keeps worksheets such as
// "03-EVAL-REVIEW.md" or "03-CORRECTION-VERIFICATION.md" from passing for the phase's own report
// (GSD #3357). The captured stem must name the directory's own phase (GSD #3511).
const KINDS = {
  context: 'CONTEXT',
  research: 'RESEARCH',
  patterns: 'PATTERNS',
  uiSpec: 'UI-SPEC',
  aiSpec: 'AI-SPEC',
  validation: 'VALIDATION',
  security: 'SECURITY',
  review: 'REVIEW',
  uiReview: 'UI-REVIEW',
  verification: 'VERIFICATION',
  uat: 'UAT',
};
const KIND_RES = Object.entries(KINDS).map(([kind, suffix]) => [kind, new RegExp(`^(\\d+[A-Z]?(?:\\.\\d+)*(?:-\\d{2})*)-${suffix}\\.md$`, 'i')]);

export const phasesDir = (root) => path.join(root, '.planning', 'phases');

// A missing directory reads as empty; any other error (EACCES, ENOTDIR) surfaces.
function readdirOrEmpty(dir, options) {
  try {
    return fs.readdirSync(dir, options);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// GSD's directory token (phase-id.cjs extractPhaseToken): the leading segment after an optional
// project code, plus following 2-digit segments ("02-01-bar" -> "02-01"), minus a final lowercase
// digit+letter slug word.
function dirToken(name) {
  const segs = name.replace(PROJECT_CODE_RE, '').split('-');
  if (!/^\d/.test(segs[0])) return null;
  const tok = [segs[0]];
  for (const s of segs.slice(1)) {
    if (!/^\d{2}(?!\d)/.test(s)) break;
    tok.push(s);
  }
  if (tok.length > 1 && /^\d{2}[a-z][a-z0-9]*$/.test(tok[tok.length - 1])) tok.pop();
  return tok.join('-');
}

const unpad = (digits) => digits.replace(/^0+(?=\d)/, '');

// Canonical phase stem: every "-" segment normalized ("02-01" -> "2-1", "03.1" -> "3.1").
const canon = (id) => id.split('-').map(normalizePhaseId).join('-');

// The phase numbers the directory's own artifacts may carry: its token first, then its bare leading
// number ("02-01-bar" -> ["2-1", "2"]). null when the name has no phase token; then every file
// counts as the phase's own, as in GSD's isPhaseArtifact.
function ownPhaseIds(dirName) {
  const tok = dirToken(dirName);
  if (tok === null) return null;
  const m = /^(\d+)(?:-|$)/.exec(dirName.replace(PROJECT_CODE_RE, ''));
  return m ? [canon(tok), unpad(m[1])] : [canon(tok)];
}

// Every phase directory name the phase id selects, mirroring GSD's matchPhaseDirs (#2528):
// exact token matches first; only when there are none, a bare integer matches the leading digit run.
export function phaseDirMatches(root, phase) {
  const names = readdirOrEmpty(phasesDir(root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const want = normalizePhaseId(String(phase).replace(PROJECT_CODE_RE, ''));
  const exact = names.filter((n) => {
    const tok = dirToken(n);
    return tok !== null && normalizePhaseId(tok) === want;
  });
  if (exact.length || !/^\d+$/.test(want)) return exact;
  return names.filter((n) => {
    const m = /^(\d+)(?:-|$)/.exec(n.replace(PROJECT_CODE_RE, ''));
    return m !== null && unpad(m[1]) === want;
  });
}

// The directory name is phase N's own (GSD's directory token, exact), whether or not the directory exists yet: the
// prep merge's predicate (spec §6.1, .planning/phases/<N>-*).
export function dirNameMatchesPhase(name, phase) {
  const tok = dirToken(String(name));
  return tok !== null && normalizePhaseId(tok) === normalizePhaseId(String(phase).replace(PROJECT_CODE_RE, ''));
}

// The phase directory, or null when none or several match. Several matches mean unrelated projects
// share .planning/phases; GSD refuses them (#2237), and phaseDirMatches names the candidates.
export function findPhaseDir(root, phase) {
  const hit = phaseDirMatches(root, phase);
  return hit.length === 1 ? path.join(phasesDir(root), hit[0]) : null;
}

export function phaseArtifacts(dir) {
  const files = readdirOrEmpty(dir).filter((f) => f.endsWith('.md')).sort();
  const own = ownPhaseIds(path.basename(dir));
  const out = {};
  for (const [kind, re] of KIND_RES) {
    const stems = new Map(files.map((f) => [f, re.exec(f)]).filter(([, m]) => m).map(([f, m]) => [f, canon(m[1])]));
    const hits = [...stems.keys()].filter((f) => own === null || own.includes(stems.get(f)));
    // GSD's tier 1 (verification.cjs resolvePhaseArtifactFile): the file named by the own token wins.
    out[kind] = hits.find((f) => own !== null && stems.get(f) === own[0]) || hits[0] || null;
  }
  out.plans = files.filter((f) => f.endsWith('-PLAN.md')).map((file) => {
    const id = file.slice(0, -'-PLAN.md'.length);
    return { id, file, hasSummary: files.includes(`${id}-SUMMARY.md`) };
  });
  return out;
}

// GSD 1.16 chunked planning (workflows/plan-phase/steps/chunked-planning-mode.md): the outline
// <padded phase>-PLAN-OUTLINE.md, never committed, lists every plan of the phase in a table (Plan ID | Objective | Wave |
// Depends On | Requirements) and ends with a line "## OUTLINE COMPLETE"; GSD then writes and commits the plans one by
// one, plan id <padded phase>-<NN>, and its resume skips a plan whose <plan id>-PLAN.md starts with frontmatter (---).
// has_plans is true from the first plan on, so only the outline tells a partial plan set from a whole one.
const OUTLINE_RE = /^(\d+[A-Z]?(?:\.\d+)*(?:-\d{2})*)-PLAN-OUTLINE\.md$/i;
const OUTLINE_DONE_RE = /^## OUTLINE COMPLETE/m;
const FENCE_RE = /^\s*(?:```|~~~)/;
const PIPE_RE = /(?<!\\)\|/;
const PLAN_HEADER_RE = /^(?:plan[\s_-]*ids?|plans?|ids?)$/i;
const SEPARATOR_RE = /^:?-+:?$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A table row's cells: split on pipes no backslash escapes, the outer pipes optional, emphasis and code marks dropped.
const cellsOf = (row) => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(PIPE_RE).map((c) => c.replace(/[`*]/g, '').trim());

// The plan ids the outline lists for the phase whose padded id is prefix: from the Plan ID column (Plan, Plan IDs or ID
// as well) of each table outside code fences, the first <prefix>-<NN> of each cell (a link, a file name or a note
// around it is dropped), in row order, each once. A row that names no such id (a total, TBD) is no plan.
export function outlinePlanIds(text, prefix) {
  const idRe = new RegExp(`(?:^|[^\\w.])(${escapeRe(String(prefix))}-\\d+[A-Za-z]?)(?!\\w)`);
  const ids = [];
  let col = null; // null: outside a table; -1: a table without a plan column
  let fence = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      fence = !fence;
      col = null;
      continue;
    }
    if (fence || !PIPE_RE.test(line)) {
      col = null;
      continue;
    }
    const cells = cellsOf(line);
    if (col === null) {
      col = cells.findIndex((c) => PLAN_HEADER_RE.test(c));
      continue;
    }
    if (col < 0 || cells.every((c) => SEPARATOR_RE.test(c))) continue;
    const id = idRe.exec(cells[col] ?? '')?.[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// GSD's resume check: head -1 <plan file> | grep -q '^---'
const hasFrontmatter = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').startsWith('---');
  } catch {
    return false;
  }
};

// Any plan file in the phase directory, flat or in GSD's nested plans/ layout (outlines and pre-bounce copies are none).
function plansOnDisk(dir) {
  const plan = (f) => /(?:^|-)PLAN(?:-\d+.*)?\.md$/i.test(f) && !/-OUTLINE\.md$|\.pre-bounce\.md$|-PLAN-REVIEW\.md$/i.test(f);
  return readdirOrEmpty(dir).some(plan) || readdirOrEmpty(path.join(dir, 'plans')).some(plan);
}

// The phase's own chunked plan outline (the name GSD reads: the directory's phase token; every one when the name has
// none): the files, those without the closing line, the plan ids they list, the ids with no plan written yet, and
// whether the phase has plan files at all. No outline: { outlines: [] }.
export function planOutline(dir) {
  const own = ownPhaseIds(path.basename(dir));
  const found = readdirOrEmpty(dir).map((f) => [f, OUTLINE_RE.exec(f)]).filter(([, m]) => m && (own === null || canon(m[1]) === own[0])).sort(([a], [b]) => a.localeCompare(b));
  const unfinished = [];
  const ids = [];
  for (const [name, m] of found) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      // unreadable: unfinished below
    }
    if (!OUTLINE_DONE_RE.test(text)) unfinished.push(name);
    for (const id of outlinePlanIds(text, m[1])) if (!ids.includes(id)) ids.push(id);
  }
  return {
    outlines: found.map(([name]) => name),
    unfinished,
    ids,
    missing: ids.filter((id) => !hasFrontmatter(path.join(dir, `${id}-PLAN.md`))),
    plans: found.length ? plansOnDisk(dir) : false,
  };
}

export function allPlansSummarized(dir) {
  const { plans } = phaseArtifacts(dir);
  return plans.length > 0 && plans.every((p) => p.hasSummary);
}
