import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { findPhaseDir, phaseDirMatches, phaseArtifacts, allPlansSummarized } from '../lib/phase-files.mjs';

const mkPhases = (dirs) => {
  const root = tmpDir('pf');
  for (const d of dirs) fs.mkdirSync(path.join(root, '.planning', 'phases', d), { recursive: true });
  return root;
};

test('findPhaseDir matches padded, decimal, lettered and project-code directories', () => {
  const root = mkPhases(['03-alpha', '03.1-fix', '04A-extra', 'ABC-05-coded', '12-twelve']);
  const name = (p) => path.basename(findPhaseDir(root, p) || '');
  assert.equal(name('3'), '03-alpha');
  assert.equal(name('03'), '03-alpha');
  assert.equal(name('3.1'), '03.1-fix');
  assert.equal(name('4a'), '04A-extra');
  assert.equal(name('5'), 'ABC-05-coded');
  assert.equal(name('ABC-05'), 'ABC-05-coded', 'a project-coded query matches like GSD normalizes it');
  assert.equal(findPhaseDir(root, '1'), null, '1 is not a prefix match for 12');
  assert.equal(findPhaseDir(tmpDir('none'), '3'), null);
});

test('findPhaseDir prefers an exact phase token and falls back to the leading digit run', () => {
  const root = mkPhases(['02-foo', '02-01-bar', '07-01-solo']);
  assert.equal(path.basename(findPhaseDir(root, '2')), '02-foo', 'exact token 02 beats 02-01');
  assert.equal(path.basename(findPhaseDir(root, '7')), '07-01-solo', 'bare integer falls back to the leading digit run');
});

test('findPhaseDir refuses a phase number that matches several directories', () => {
  const root = mkPhases(['ABC-08-one', 'XYZ-08-two', '09-nine']);
  assert.equal(findPhaseDir(root, '8'), null);
  assert.deepEqual(phaseDirMatches(root, '8'), ['ABC-08-one', 'XYZ-08-two']);
  assert.deepEqual(phaseDirMatches(root, '9'), ['09-nine']);
  assert.deepEqual(phaseDirMatches(tmpDir('none'), '8'), []);
});

test('phaseArtifacts finds each kind once and pairs plans with summaries', () => {
  const dir = path.join(tmpDir('pa'), '03-alpha');
  fs.mkdirSync(dir);
  for (const f of ['03-CONTEXT.md', '03-RESEARCH.md', '03-PATTERNS.md', '03-UI-SPEC.md', '03-AI-SPEC.md', '03-VALIDATION.md', '03-SECURITY.md',
    '03-EVAL-REVIEW.md', '03-REVIEW.md', '03-UI-REVIEW.md', '03-REVIEW-FIX.md', '03-CORRECTION-VERIFICATION.md', '03-VERIFICATION.md', '03-UAT.md',
    '03-01-PLAN.md', '03-01-SUMMARY.md', '03-02-PLAN.md', '03-PLAN-OUTLINE.md', 'turbo-base.json']) {
    fs.writeFileSync(path.join(dir, f), '');
  }
  const a = phaseArtifacts(dir);
  assert.equal(a.context, '03-CONTEXT.md');
  assert.equal(a.research, '03-RESEARCH.md');
  assert.equal(a.patterns, '03-PATTERNS.md');
  assert.equal(a.uiSpec, '03-UI-SPEC.md');
  assert.equal(a.aiSpec, '03-AI-SPEC.md');
  assert.equal(a.validation, '03-VALIDATION.md');
  assert.equal(a.security, '03-SECURITY.md');
  assert.equal(a.review, '03-REVIEW.md', 'not 03-EVAL-REVIEW.md or 03-UI-REVIEW.md');
  assert.equal(a.uiReview, '03-UI-REVIEW.md');
  assert.equal(a.verification, '03-VERIFICATION.md', 'not 03-CORRECTION-VERIFICATION.md');
  assert.equal(a.uat, '03-UAT.md');
  assert.deepEqual(a.plans, [{ id: '03-01', file: '03-01-PLAN.md', hasSummary: true }, { id: '03-02', file: '03-02-PLAN.md', hasSummary: false }]);
  assert.equal(allPlansSummarized(dir), false);
  fs.writeFileSync(path.join(dir, '03-02-SUMMARY.md'), '');
  assert.equal(allPlansSummarized(dir), true);
  assert.equal(allPlansSummarized(path.join(dir, 'missing')), false);
  const none = phaseArtifacts(path.join(dir, 'missing'));
  assert.deepEqual(none.plans, []);
  for (const kind of ['context', 'research', 'patterns', 'uiSpec', 'aiSpec', 'validation', 'security', 'review', 'uiReview', 'verification', 'uat']) {
    assert.equal(none[kind], null, kind);
  }
});

test('phaseArtifacts ignores worksheets that only end with an artifact suffix', () => {
  const dir = path.join(tmpDir('pw'), '03-alpha');
  fs.mkdirSync(dir);
  for (const f of ['03-EVAL-REVIEW.md', '03-CORRECTION-VERIFICATION.md']) fs.writeFileSync(path.join(dir, f), '');
  const a = phaseArtifacts(dir);
  assert.equal(a.review, null);
  assert.equal(a.verification, null);
});

test('phaseArtifacts ignores artifacts of other phases in the directory', () => {
  const dir = path.join(tmpDir('po'), '03-alpha');
  fs.mkdirSync(dir);
  for (const f of ['02-VERIFICATION.md', '03-VERIFICATION.md', '02-REVIEW.md', '03-REVIEW.md', '02-UAT.md', '03.1-CONTEXT.md', '03-01-SECURITY.md']) {
    fs.writeFileSync(path.join(dir, f), '');
  }
  const a = phaseArtifacts(dir);
  assert.equal(a.verification, '03-VERIFICATION.md');
  assert.equal(a.review, '03-REVIEW.md');
  assert.equal(a.uat, null, 'only a foreign 02-UAT.md exists');
  assert.equal(a.context, null, '03.1 is another phase');
  assert.equal(a.security, null, '03-01 is not phase 03');
});

test('phaseArtifacts finds milestone-prefixed artifacts and prefers the own-token file', () => {
  const dir = path.join(tmpDir('pm'), '02-01-bar');
  fs.mkdirSync(dir);
  for (const f of ['02-01-CONTEXT.md', '02-01-VERIFICATION.md', '02-02-REVIEW.md', '02-UAT.md', '2-01-UAT.md']) fs.writeFileSync(path.join(dir, f), '');
  const a = phaseArtifacts(dir);
  assert.equal(a.context, '02-01-CONTEXT.md');
  assert.equal(a.verification, '02-01-VERIFICATION.md');
  assert.equal(a.review, null, '02-02 is a sibling phase');
  assert.equal(a.uat, '2-01-UAT.md', 'the token 02-01 wins over the bare leading number 02, though 02-UAT.md sorts first');
  const odd = path.join(tmpDir('pn'), 'notes');
  fs.mkdirSync(odd);
  fs.writeFileSync(path.join(odd, '02-REVIEW.md'), '');
  assert.equal(phaseArtifacts(odd).review, '02-REVIEW.md', 'a directory without a phase token accepts every phase');
});

test('directory read errors other than a missing directory surface', () => {
  const root = tmpDir('pe');
  const file = path.join(root, 'not-a-dir');
  fs.writeFileSync(file, '');
  assert.throws(() => phaseArtifacts(file), { code: 'ENOTDIR' });
  fs.mkdirSync(path.join(root, '.planning'));
  fs.writeFileSync(path.join(root, '.planning', 'phases'), '');
  assert.throws(() => findPhaseDir(root, '3'), { code: 'ENOTDIR' });
});
