import fs from 'node:fs';
import path from 'node:path';
import { normalizePhaseId } from './gsd.mjs';

// GSD phase directories: "<padded id>-<slug>", optionally behind a project code ("ABC-05-slug").
const PHASE_DIR_RE = /^(?:[A-Z][A-Z0-9_]*-)?(\d+[A-Z]?(?:\.\d+)*)-/i;

// Artifact kind -> file-name suffix (GSD names them "<padded>-<SUFFIX>.md").
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

export const phasesDir = (root) => path.join(root, '.planning', 'phases');

export function findPhaseDir(root, phase) {
  let names;
  try {
    names = fs.readdirSync(phasesDir(root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return null;
  }
  const want = normalizePhaseId(phase);
  const hit = names.filter((n) => {
    const m = PHASE_DIR_RE.exec(n);
    return m !== null && normalizePhaseId(m[1]) === want;
  }).sort();
  return hit.length ? path.join(phasesDir(root), hit[0]) : null;
}

export function phaseArtifacts(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    // missing directory: no artifacts
  }
  const out = {};
  for (const [kind, suffix] of Object.entries(KINDS)) {
    // "-REVIEW.md" must not pick up "-UI-REVIEW.md"
    out[kind] = files.find((f) => f.endsWith(`-${suffix}.md`) && !(suffix === 'REVIEW' && f.endsWith('-UI-REVIEW.md'))) || null;
  }
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
