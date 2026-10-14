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
// one, and its resume skips a plan whose <plan id>-PLAN.md exists with frontmatter. has_plans is true from the first
// plan on, so only the outline tells a partial plan set from a whole one.
const OUTLINE_RE = /-PLAN-OUTLINE\.md$/i;
const OUTLINE_DONE_RE = /^## OUTLINE COMPLETE/m;
const PLAN_ID_RE = /^[A-Za-z0-9][\w.-]*$/;
const cellsOf = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.replace(/[`*]/g, '').trim());

// The plan ids of every table row under a header with a Plan ID column, in row order, each once.
export function outlinePlanIds(text) {
  const ids = [];
  let col = -1;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const row = line.trim();
    if (!row.startsWith('|')) {
      col = -1;
      continue;
    }
    const cells = cellsOf(row);
    if (col < 0) {
      col = cells.findIndex((c) => /^plan[\s_-]*id$/i.test(c));
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const id = cells[col] ?? '';
    if (PLAN_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

const hasFrontmatter = (file) => {
  try {
    return /^﻿?---/.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
};

// The phase's chunked plan outlines: the files, those without the closing line, the plan ids they list and the ids
// with no plan written yet. No outline: { outlines: [] }.
export function planOutline(dir) {
  const outlines = readdirOrEmpty(dir).filter((f) => OUTLINE_RE.test(f)).sort();
  const unfinished = [];
  const ids = [];
  for (const name of outlines) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      // unreadable: unfinished below
    }
    if (!OUTLINE_DONE_RE.test(text)) unfinished.push(name);
    for (const id of outlinePlanIds(text)) if (!ids.includes(id)) ids.push(id);
  }
  return { outlines, unfinished, ids, missing: ids.filter((id) => !hasFrontmatter(path.join(dir, `${id}-PLAN.md`))) };
}

export function allPlansSummarized(dir) {
  const { plans } = phaseArtifacts(dir);
  return plans.length > 0 && plans.every((p) => p.hasSummary);
}
