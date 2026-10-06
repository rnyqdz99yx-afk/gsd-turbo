import fs from 'node:fs';
import path from 'node:path';
import { normalizePhaseId } from './gsd.mjs';

// GSD phase directories: "<padded id>-<slug>", optionally behind a project code ("ABC-05-slug").
const PROJECT_CODE_RE = /^[A-Z][A-Z0-9_]*-(?=\d)/i;

// Artifact kind -> file-name suffix. GSD names them "<padded id>-<SUFFIX>.md", without the project
// code; matching the whole name keeps worksheets such as "03-EVAL-REVIEW.md" or
// "03-CORRECTION-VERIFICATION.md" from passing for the phase's own report (GSD #3357).
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
const KIND_RES = Object.entries(KINDS).map(([kind, suffix]) => [kind, new RegExp(`^\\d+[A-Z]?(?:\\.\\d+)*-${suffix}\\.md$`, 'i')]);

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

// The phase directory, or null when none or several match. Several matches mean unrelated projects
// share .planning/phases; GSD refuses them (#2237), and phaseDirMatches names the candidates.
export function findPhaseDir(root, phase) {
  const hit = phaseDirMatches(root, phase);
  return hit.length === 1 ? path.join(phasesDir(root), hit[0]) : null;
}

export function phaseArtifacts(dir) {
  const files = readdirOrEmpty(dir).filter((f) => f.endsWith('.md')).sort();
  const out = {};
  for (const [kind, re] of KIND_RES) out[kind] = files.find((f) => re.test(f)) || null;
  out.plans = files.filter((f) => f.endsWith('-PLAN.md')).map((file) => {
    const id = file.slice(0, -'-PLAN.md'.length);
    return { id, file, hasSummary: files.includes(`${id}-SUMMARY.md`) };
  });
  return out;
}

export function allPlansSummarized(dir) {
  const { plans } = phaseArtifacts(dir);
  return plans.length > 0 && plans.every((p) => p.hasSummary);
}
