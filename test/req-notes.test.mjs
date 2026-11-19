import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { keepRequirementNotes, keptLine, restoreNotes } from '../lib/req-notes.mjs';
import { slicePhase, compactPlan } from './helpers/slices.mjs';
import { summaryText } from './helpers/build-fake.mjs';
import { tmpDir } from './helpers/tmp.mjs';
import { REAL_CORE, REAL_VERSION, NO_REAL_GSD } from './helpers/real-gsd.mjs';
import { versionInRange } from '../lib/gsd.mjs';

const NOTE = 'Pending (waits for a live check)';
const doc = (rows, boxes, eol = '\n') => [
  '# Requirements', '', '## v1 Requirements', '', ...boxes, '',
  '## Traceability', '', '| Requirement | Phase | Status |', '|-------------|-------|--------|', ...rows, '',
].join(eol);
const before = (eol) => doc(
  [`| DEMO-01 | Phase 5 | ${NOTE} |`, '| DEMO-02 | Phase 5 | Pending |', '| DEMO-03 | Phase 6 | In Progress — half of it merged |'],
  ['- [ ] **DEMO-01**: greet works', '- [ ] **DEMO-02**: farewell works', '- [ ] **DEMO-03**: shout works'], eol);
// what GSD 1.22 leaves after it closed phase 5 and 6
const closed = (eol) => doc(
  ['| DEMO-01 | Phase 5 | Complete |', '| DEMO-02 | Phase 5 | Complete |', '| DEMO-03 | Phase 6 | Complete |'],
  ['- [x] **DEMO-01**: greet works', '- [x] **DEMO-02**: farewell works', '- [x] **DEMO-03**: shout works'], eol);

test('a row whose Status carried a note goes back as written, its checkbox too; a bare status stays advanced', () => {
  for (const eol of ['\n', '\r\n']) {
    const r = restoreNotes(before(eol), closed(eol));
    assert.deepEqual(r.kept, [{ id: 'DEMO-01', status: NOTE }, { id: 'DEMO-03', status: 'In Progress — half of it merged' }]);
    assert.equal(r.text, doc(
      [`| DEMO-01 | Phase 5 | ${NOTE} |`, '| DEMO-02 | Phase 5 | Complete |', '| DEMO-03 | Phase 6 | In Progress — half of it merged |'],
      ['- [ ] **DEMO-01**: greet works', '- [x] **DEMO-02**: farewell works', '- [ ] **DEMO-03**: shout works'], eol), JSON.stringify(eol));
  }
});

test('nothing is touched when GSD left the noted rows alone, or when no row carries a note', () => {
  const same = restoreNotes(before('\n'), before('\n').replace('| DEMO-02 | Phase 5 | Pending |', '| DEMO-02 | Phase 5 | Complete |'));
  assert.deepEqual(same.kept, []);
  const bare = doc(['| DEMO-01 | Phase 5 | Pending |'], ['- [ ] **DEMO-01**: greet works']);
  const after = bare.replace('Pending', 'Complete').replace('[ ]', '[x]');
  assert.deepEqual(restoreNotes(bare, after), { text: after, kept: [] });
  // a word glued onto the status is not a status with a note; a table without a Status column has nothing to keep
  const glued = doc(['| DEMO-01 | Phase 5 | Pendingx |'], []);
  assert.deepEqual(restoreNotes(glued, glued.replace('Pendingx', 'Complete')).kept, []);
  const noStatus = '| Requirement | Phase |\n|---|---|\n| DEMO-01 | Pending (note) |\n';
  assert.deepEqual(restoreNotes(noStatus, noStatus.replace('Pending (note)', 'Complete')).kept, []);
});

test('the Status column is found by its header, wherever it stands; an already ticked checkbox stays ticked', () => {
  const head = ['| REQ-ID | Status | Phase | Notes |', '|---|---|---|---|'];
  const was = [...head, '| AUTH-1.2 | Gaps Found: the token is not rotated | Phase 3 | x |', '', '- [x] **AUTH-1.2**: rotate'].join('\n');
  const now = was.replace('Gaps Found: the token is not rotated', 'Complete');
  const r = restoreNotes(was, now);
  assert.deepEqual(r.kept, [{ id: 'AUTH-1.2', status: 'Gaps Found: the token is not rotated' }]);
  assert.equal(r.text, was);
});

test('keepRequirementNotes wraps the close: the file is put back, the rows are named; no file, nothing to do', () => {
  const root = tmpDir('req-notes');
  assert.deepEqual(keepRequirementNotes(root, () => 'closed'), { result: 'closed', kept: [] });
  fs.mkdirSync(path.join(root, '.planning'));
  const file = path.join(root, '.planning', 'REQUIREMENTS.md');
  fs.writeFileSync(file, before('\n'));
  const r = keepRequirementNotes(root, () => { fs.writeFileSync(file, closed('\n')); return 7; });
  assert.equal(r.result, 7);
  assert.match(fs.readFileSync(file, 'utf8'), /\| DEMO-01 \| Phase 5 \| Pending \(waits for a live check\) \|\n\| DEMO-02 \| Phase 5 \| Complete \|/);
  assert.equal(keptLine(r.kept), `2 requirement row(s) kept as written (GSD would mark them Complete and drop the note): DEMO-01 «${NOTE}»; DEMO-03 «In Progress — half of it merged»`);
  // a close that throws is not swallowed, and the file is left for the caller's own undo
  fs.writeFileSync(file, before('\n'));
  assert.throws(() => keepRequirementNotes(root, () => { fs.writeFileSync(file, closed('\n')); throw new Error('boom'); }), /boom/);
  assert.equal(fs.readFileSync(file, 'utf8'), closed('\n'));
});

// The installed GSD closes the phase: 1.22 (#6293) advances the noted row and drops the note, 1.16–1.21 leave it.
// With turbo's wrapper the file reads the same on both.
test('phase complete of the installed GSD under the wrapper: the noted row and its checkbox stay as written', { skip: NO_REAL_GSD, timeout: 120000 }, () => {
  const root = slicePhase();
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const file = path.join(root, '.planning', 'REQUIREMENTS.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('| DEMO-01 | Phase 5 | Pending |', `| DEMO-01 | Phase 5 | ${NOTE} |`));
  const dir = path.join(root, '.planning', 'phases', '05-demo');
  fs.writeFileSync(path.join(dir, '05-01-PLAN.md'), compactPlan({ id: '05-01', reqs: ['DEMO-01', 'DEMO-02'], decisions: ['D-01', 'D-02'] }));
  fs.writeFileSync(path.join(dir, '05-01-SUMMARY.md'), summaryText({ phaseSlug: '05-demo', plan: '05-01', reqs: ['DEMO-01', 'DEMO-02'] }));
  fs.writeFileSync(path.join(dir, '05-VERIFICATION.md'), ['---', 'phase: 05-demo', 'verified: 2026-01-02T00:00:00Z', 'status: passed', 'score: 1/1 must-haves verified', '---', '', '# Phase 5: Verification', ''].join('\n'));
  git('add', '-A');
  git('commit', '-q', '-m', 'docs(05): the phase is built and verified');
  const { result, kept } = keepRequirementNotes(root, () => spawnSync(process.execPath, [path.join(REAL_CORE, 'bin', 'gsd-tools.cjs'), 'phase', 'complete', '5', '--cwd', root], { encoding: 'utf8', windowsHide: true }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^- \[ \] \*\*DEMO-01\*\*: greet works$/m);
  assert.match(text, /^\| DEMO-01 \| Phase 5 \| Pending \(waits for a live check\) \|$/m);
  assert.match(text, /^- \[x\] \*\*DEMO-02\*\*: farewell works$/m);
  assert.match(text, /^\| DEMO-02 \| Phase 5 \| Complete \|$/m);
  // 1.22 and newer: the wrapper put the row back; 1.16–1.21: GSD never touched it
  assert.deepEqual(kept, versionInRange(REAL_VERSION, '>=1.22.0') ? [{ id: 'DEMO-01', status: NOTE }] : []);
  assert.match(fs.readFileSync(path.join(root, '.planning', 'ROADMAP.md'), 'utf8'), /^- \[x\] \*\*Phase 5: Demo Feature\*\*/m);
});
