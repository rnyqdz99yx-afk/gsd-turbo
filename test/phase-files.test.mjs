import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { findPhaseDir, phaseArtifacts, allPlansSummarized } from '../lib/phase-files.mjs';

test('findPhaseDir matches padded, decimal, lettered and project-code directories', () => {
  const root = tmpDir('pf');
  for (const d of ['03-alpha', '03.1-fix', '04A-extra', 'ABC-05-coded', '12-twelve']) fs.mkdirSync(path.join(root, '.planning', 'phases', d), { recursive: true });
  const name = (p) => path.basename(findPhaseDir(root, p) || '');
  assert.equal(name('3'), '03-alpha');
  assert.equal(name('03'), '03-alpha');
  assert.equal(name('3.1'), '03.1-fix');
  assert.equal(name('4a'), '04A-extra');
  assert.equal(name('5'), 'ABC-05-coded');
  assert.equal(findPhaseDir(root, '1'), null, '1 is not a prefix match for 12');
  assert.equal(findPhaseDir(tmpDir('none'), '3'), null);
});

test('phaseArtifacts finds each kind once and pairs plans with summaries', () => {
  const dir = path.join(tmpDir('pa'), '03-alpha');
  fs.mkdirSync(dir);
  for (const f of ['03-CONTEXT.md', '03-RESEARCH.md', '03-UI-SPEC.md', '03-REVIEW.md', '03-UI-REVIEW.md', '03-REVIEW-FIX.md', '03-UAT.md', '03-01-PLAN.md', '03-01-SUMMARY.md', '03-02-PLAN.md', '03-PLAN-OUTLINE.md', 'turbo-base.json']) {
    fs.writeFileSync(path.join(dir, f), '');
  }
  const a = phaseArtifacts(dir);
  assert.equal(a.context, '03-CONTEXT.md');
  assert.equal(a.research, '03-RESEARCH.md');
  assert.equal(a.review, '03-REVIEW.md');
  assert.equal(a.uiReview, '03-UI-REVIEW.md');
  assert.equal(a.uiSpec, '03-UI-SPEC.md');
  assert.equal(a.uat, '03-UAT.md');
  assert.equal(a.patterns, null);
  assert.deepEqual(a.plans, [{ id: '03-01', file: '03-01-PLAN.md', hasSummary: true }, { id: '03-02', file: '03-02-PLAN.md', hasSummary: false }]);
  assert.equal(allPlansSummarized(dir), false);
  fs.writeFileSync(path.join(dir, '03-02-SUMMARY.md'), '');
  assert.equal(allPlansSummarized(dir), true);
  assert.equal(allPlansSummarized(path.join(dir, 'missing')), false);
  assert.deepEqual(phaseArtifacts(path.join(dir, 'missing')).plans, []);
});
