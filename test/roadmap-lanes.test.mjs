import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROADMAP, gsdDeps, gsdDepends, gsdGoal, gsdSection } from './fixtures/roadmap-lanes.mjs';
import { depsText, parseRoadmapPhases, roadmapDigest, setDependsOn, writeLaneLines } from '../lib/roadmap-lanes.mjs';

const gsdRead = (text) => ['2', '3', '4'].map((n) => [gsdGoal(gsdSection(text, n)), gsdDepends(gsdSection(text, n))]);

test('parse: the phase sections outside <details>, their fields, no markup yet', () => {
  const p = parseRoadmapPhases(ROADMAP);
  assert.deepEqual(p.map((s) => [s.number, s.name]), [['1', 'Base'], ['2', 'Api'], ['3', 'Web'], ['4', 'Docs']]);
  assert.equal(p[1].goal, 'Serve the API');
  assert.equal(p[1].dependsOn, 'Phase 1');
  assert.equal(p[2].dependsOn, 'Phase 2 (the API must exist)');
  assert.equal(p[3].dependsOn, null);
  assert.equal(p[1].requirements, 'API-01, API-02');
  for (const s of p) assert.equal(s.areas, null);
  const lines = ROADMAP.split('\n');
  assert.equal(lines[p[3].end], '## Progress', 'the last phase ends at the next level-2 heading');
  assert.match(p[0].key, /^[0-9a-f]{64}$/);
});

test('G3: the markup lines sit right after Depends on (or after the Goal) and GSD reads Goal and Depends on as before', () => {
  const before = gsdRead(ROADMAP);
  let text = writeLaneLines(ROADMAP, '2', { areas: ['src/api/**', 'test/api/**'], gates: ['prod-deploy'], parallelWith: ['4'] });
  text = writeLaneLines(text, '3', { areas: ['web/**'], gates: [], parallelWith: [] });
  text = writeLaneLines(text, '4', { areas: ['docs/**'], parallelWith: ['2'] });
  assert.deepEqual(gsdRead(text), before);
  const ls = text.split('\n');
  const d2 = ls.indexOf('**Depends on**: Phase 1');
  assert.deepEqual(ls.slice(d2 + 1, d2 + 5), ['**Areas**: src/api/**, test/api/**', '**Gates**: prod-deploy', '**Parallel with**: 4', '**Requirements**: API-01, API-02']);
  const d3 = ls.indexOf('**Depends on:** Phase 2 (the API must exist)');
  assert.deepEqual(ls.slice(d3 + 1, d3 + 3), ['**Areas**: web/**', '**Requirements**: WEB-01'], 'no Gates or Parallel with line when empty');
  const g4 = ls.indexOf('and the client.');
  assert.deepEqual(ls.slice(g4 + 1, g4 + 4), ['**Areas**: docs/**', '**Parallel with**: 2', '']);
  const p = parseRoadmapPhases(text);
  assert.deepEqual([p[1].areas, p[1].gates, p[1].parallelWith], [['src/api/**', 'test/api/**'], ['prod-deploy'], ['4']]);
  assert.deepEqual([p[2].gates, p[2].parallelWith], [null, null]);
  assert.ok(!text.includes('### Phase 0.5: Spike\n**Areas**'), 'a shipped phase is never marked up');
});

test('writing is idempotent and replaces the old lines', () => {
  const once = writeLaneLines(ROADMAP, '2', { areas: ['src/**'], gates: ['owner-live'] });
  assert.equal(writeLaneLines(once, '2', { areas: ['src/**'], gates: ['owner-live'] }), once);
  const again = writeLaneLines(once, '2', { areas: ['lib/**'] });
  assert.equal(again.split('\n').filter((l) => l.startsWith('**Areas**')).length, 1);
  assert.ok(again.includes('**Areas**: lib/**') && !again.includes('**Gates**: owner-live'));
  assert.throws(() => writeLaneLines(ROADMAP, '9', { areas: ['x/**'] }), /phase 9 has no section in the ROADMAP/);
});

test('CRLF stays CRLF', () => {
  const crlf = ROADMAP.replace(/\n/g, '\r\n');
  const out = writeLaneLines(setDependsOn(crlf, '3', ['1']), '3', { areas: ['web/**'], gates: ['packaged-build'] });
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF');
  assert.deepEqual(parseRoadmapPhases(out)[2].areas, ['web/**']);
  assert.equal(roadmapDigest(crlf), roadmapDigest(ROADMAP));
});

test('the digest: the markup lines and GSD\'s completion edits leave it, scheduling edits change it', () => {
  const d = roadmapDigest(ROADMAP);
  assert.equal(roadmapDigest(writeLaneLines(ROADMAP, '2', { areas: ['src/**'], parallelWith: ['4'] })), d);
  const completed = ROADMAP.replace('**Plans**: 0/2 plans', '**Plans**: 2/2 plans complete').replace('- [ ] **Phase 2: Api**', '- [x] **Phase 2: Api**').replace('| 1. Base | 1/1 | Complete |', '| 1. Base | 1/1 | Complete |\n| 2. Api | 2/2 | Complete |');
  assert.equal(roadmapDigest(completed), d);
  assert.notEqual(roadmapDigest(ROADMAP.replace('**Depends on**: Phase 1', '**Depends on**: Nothing')), d);
  assert.notEqual(roadmapDigest(ROADMAP.replace('## Progress', '### Phase 5: Ops\n**Goal**: Deploy it\n\n## Progress')), d);
  assert.notEqual(roadmapDigest(ROADMAP.replace('### Phase 3: Web', '### Phase 3: Web client')), d);
  const keys = (t) => parseRoadmapPhases(t).map((s) => s.key);
  const edited = keys(ROADMAP.replace('**Depends on**: Phase 1', '**Depends on**: Nothing'));
  assert.deepEqual(edited.map((k, i) => k === keys(ROADMAP)[i]), [true, false, true, true], 'only the edited section changes its key');
});

test('G4: setDependsOn writes Phase 3, Phase 4, keeps the label form, and GSD reads exactly those', () => {
  let t = setDependsOn(ROADMAP, '3', ['1', '2']);
  assert.ok(t.includes('**Depends on:** Phase 1, Phase 2'));
  assert.deepEqual(gsdDeps(gsdDepends(gsdSection(t, '3'))), ['1', '2']);
  t = setDependsOn(ROADMAP, '2', []);
  assert.equal(gsdDepends(gsdSection(t, '2')), 'Nothing');
  assert.deepEqual(gsdDeps(gsdDepends(gsdSection(t, '2'))), []);
  t = setDependsOn(ROADMAP, '4', ['2']);
  assert.equal(gsdDepends(gsdSection(t, '4')), 'Phase 2');
  assert.equal(gsdGoal(gsdSection(t, '4')), 'Docs for the API and the client.');
  assert.equal(setDependsOn(ROADMAP, '4', []), ROADMAP);
  assert.throws(() => setDependsOn(ROADMAP, '9', []), /phase 9 has no section/);
  assert.equal(depsText(['3', '4']), 'Phase 3, Phase 4');
  assert.equal(depsText([]), 'Nothing');
});

test('a no-dependency line that names a phase is a dependency to GSD; a prose relaxation of it writes Nothing alone', () => {
  const text = ROADMAP.replace('**Depends on**: Phase 1', '**Depends on**: Nothing (independent of Phase 1)');
  assert.deepEqual(gsdDeps(gsdDepends(gsdSection(text, '2'))), ['1']);
  // a relaxation dropping 1 (lib/annotate.mjs applyAnalysis, applyAnswer): no phase number is left in the line
  const t = setDependsOn(text, '2', []);
  assert.equal(gsdDepends(gsdSection(t, '2')), 'Nothing');
  assert.deepEqual(gsdDeps(gsdDepends(gsdSection(t, '2'))), []);
});

test('review: a multi-line Depends on keeps its continuation; a value with a line break is refused', () => {
  const text = ROADMAP.replace('**Depends on**: Phase 1', '**Depends on**: Phase 1,\n  and the base docs');
  const ls = writeLaneLines(text, '2', { areas: ['a/**'] }).split('\n');
  const d = ls.indexOf('  and the base docs');
  assert.equal(ls[d + 1], '**Areas**: a/**');
  assert.throws(() => writeLaneLines(ROADMAP, '2', { areas: ['src/a\n## Phase 9: Evil'] }), /line break/);
  assert.throws(() => writeLaneLines(ROADMAP, '2', { areas: ['x/**'], gates: ['a\rb'] }), /line break/);
});
