import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir, tmpGitRepo } from './helpers/tmp.mjs';
import { LIVE_CHECK_OPTION, loopSentence, ownerGapsText, reviewFindings, reviewLoop, reviewVersions } from '../lib/review-loop.mjs';
import { jargonIn } from '../lib/questions.mjs';

// A synthetic GSD 1.16 REVIEW.md (agents/gsd-code-reviewer.md, write_review) with the given findings:
// [code, title, file] each.
const review = (findings) => `---
phase: 07-sync
reviewed: 2026-01-01T00:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - src/sync.js
  - src/queue.js
findings:
  critical: 0
  warning: ${findings.length}
  info: 0
  total: ${findings.length}
status: ${findings.length ? 'issues_found' : 'clean'}
---

# Phase 7: Code Review Report

## Narrative Findings (AI reviewer)

${findings.map(([code, title, file]) => `### ${code}: ${title}

**File:** \`${file}\`
**Issue:** ${title} happens when the queue is empty.
**Fix:**
\`\`\`js
if (!queue.length) return;
\`\`\`
`).join('\n')}`;

test('reviewFindings: code, severity, title and files of each finding, BL counted as critical, a prefixed code kept whole', () => {
  const text = `${review([['WR-01', 'Retry loop never ends', 'src/sync.js:42'], ['LOOP8-WR-02', 'Stop races the flush', 'src/queue.js:7, src/sync.js:90']])}
### BL-01: Token logged

**File:** \`src/log.js:3\`

### IN-01: Name could be clearer

**File:** \`src/queue.js:1\`
`;
  assert.deepEqual(reviewFindings(text).map((f) => [f.code, f.severity, f.title, f.files]), [
    ['WR-01', 'warning', 'Retry loop never ends', ['src/sync.js']],
    ['LOOP8-WR-02', 'warning', 'Stop races the flush', ['src/queue.js', 'src/sync.js']],
    ['BL-01', 'critical', 'Token logged', ['src/log.js']],
    ['IN-01', 'info', 'Name could be clearer', ['src/queue.js']],
  ]);
  assert.match(reviewFindings(text)[0].body, /^\*\*Issue:\*\* Retry loop never ends happens when the queue is empty\./);
  assert.deepEqual(reviewFindings('no findings here'), []);
});

test('reviewLoop: consecutive rounds that find new edges in the same files count; other files, the same findings, info only or a clean round end the streak', () => {
  const r1 = review([['WR-01', 'Retry loop never ends', 'src/sync.js:42']]);
  const r2 = review([['WR-01', 'Stop races the flush', 'src/sync.js:88']]);
  const r3 = review([['WR-01', 'Flush drops the last item', 'src/sync.js:120'], ['WR-02', 'Timer leaks', 'src/queue.js:3']]);
  assert.deepEqual(reviewLoop([]), { rounds: 0, files: [] });
  assert.deepEqual(reviewLoop([r1]), { rounds: 1, files: [] });
  assert.deepEqual(reviewLoop([r1, r2]), { rounds: 2, files: ['src/sync.js'] });
  assert.deepEqual(reviewLoop([r1, r2, r3]), { rounds: 3, files: ['src/sync.js'] });
  assert.deepEqual(reviewLoop([r1, r2, r2, r3]).rounds, 3, 'the same findings committed again are one round');
  const other = review([['WR-01', 'Bad header', 'src/http.js:1']]);
  assert.deepEqual(reviewLoop([r1, r2, other]), { rounds: 1, files: [] }, 'another file ends the streak');
  assert.equal(reviewLoop([r1, review([['WR-01', 'Retry loop never ends', 'src/sync.js:50'], ['WR-02', 'Retry loop never ends', 'src/sync.js:51']])]).rounds, 1, 'nothing new');
  assert.equal(reviewLoop([r1, review([]), r2]).rounds, 1, 'a clean round in between');
  assert.equal(reviewLoop([r1, r2, review([])]).rounds, 0, 'clean now');
  assert.equal(reviewLoop([r1, review([['IN-01', 'Naming', 'src/sync.js:1']])]).rounds, 0, 'info only is no finding');
});

test('the loop sentence and the live-check option, plain and without ids, in both languages', () => {
  assert.equal(loopSentence('ru', 3), 'Ревью в третий раз подряд находит новые крайние случаи в том же коде: шлифовать так можно долго, а живая проверка покажет, мешают ли они на деле.');
  assert.match(loopSentence('ru', 2), /^Ревью во второй раз подряд /);
  assert.match(loopSentence('ru', 12), /^Ревью в 12-й раз подряд /);
  assert.equal(loopSentence('en', 3), 'The code review has found new edge cases in the same code for the third time in a row: polishing could go on for long, and the live check shows whether they matter in practice.');
  assert.match(loopSentence('en', 11), /for the 11th time/);
  assert.match(loopSentence('xx', 2), /second time/);
  for (const lang of ['en', 'ru']) {
    const o = LIVE_CHECK_OPTION(lang);
    for (const t of [loopSentence(lang, 3), o.label, o.description]) assert.equal(jargonIn(t), null, t);
  }
  assert.equal(LIVE_CHECK_OPTION('ru').label, 'Хватит шлифовать — живая проверка');
});

test('ownerGapsText: the chosen review findings and verification gaps as gaps of this round, for the gsd-planner prompt; an unknown one is refused', () => {
  const rev = review([['WR-01', 'Retry loop never ends', 'src/sync.js:42'], ['WR-02', 'Timer leaks', 'src/queue.js:3']]);
  const ver = `---
phase: 07-sync
status: gaps_found
score: 3/4 must-haves verified
gaps:
  - truth: "A stopped sync leaves no timer"
    status: failed
---
`;
  const text = ownerGapsText({ review: rev, verification: ver, codes: ['wr-02'], numbers: [1] });
  assert.match(text, /^Owner-chosen gaps: the owner chose to close these findings in this gap round\. Plan each as a gap of this round/);
  assert.match(text, / 1\. Code review finding WR-02 \(warning\) in src\/queue\.js: Timer leaks\. \*\*Issue:\*\* Timer leaks happens when the queue is empty\./);
  assert.match(text, / 2\. Verification gap 1 \(failed\): A stopped sync leaves no timer\.$/);
  assert.ok(!text.includes('Retry loop'), 'only the chosen ones');
  assert.throws(() => ownerGapsText({ review: rev, verification: ver, codes: ['WR-09'], numbers: [] }), /no finding WR-09 in REVIEW\.md; it has WR-01, WR-02/);
  assert.throws(() => ownerGapsText({ review: rev, verification: ver, codes: [], numbers: [2] }), /no gap 2 in VERIFICATION\.md; it has 1/);
  assert.throws(() => ownerGapsText({ review: rev, verification: null, codes: [], numbers: [] }), /name the findings/);
  assert.throws(() => ownerGapsText({ review: null, verification: ver, codes: ['WR-01'], numbers: [] }), /no REVIEW\.md/);
});

test('reviewVersions: the REVIEW.md of each commit, oldest first, and an uncommitted working copy last; outside git only the file', () => {
  const root = tmpGitRepo();
  const dir = path.join(root, '.planning', 'phases', '07-sync');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '07-REVIEW.md');
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  const versions = ['one', 'two', 'three'].map((t) => review([['WR-01', `Edge ${t}`, 'src/sync.js:1']]));
  for (const v of versions.slice(0, 2)) {
    fs.writeFileSync(file, v);
    git('add', '-A');
    git('commit', '-q', '-m', 'review');
  }
  assert.deepEqual(reviewVersions(root, '7'), versions.slice(0, 2));
  fs.writeFileSync(file, versions[2]);
  assert.deepEqual(reviewVersions(root, '7'), versions);
  const plain = tmpDir('rv');
  fs.mkdirSync(path.join(plain, '.planning', 'phases', '07-sync'), { recursive: true });
  fs.writeFileSync(path.join(plain, '.planning', 'phases', '07-sync', '07-REVIEW.md'), versions[0]);
  assert.deepEqual(reviewVersions(plain, '7'), [versions[0]]);
  assert.deepEqual(reviewVersions(plain, '8'), []);
});
