import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { PHASES, ROADMAP } from './fixtures/roadmap-lanes.mjs';
import { writeLaneLines } from '../lib/roadmap-lanes.mjs';
import { EVERYTHING, areasOf, gatesOf, lanesFile, readLanesFile, readLanesRaw, roadmapFile, stalePhases, writeLanesFile } from '../lib/lanes-file.mjs';

function project(text = ROADMAP) {
  const root = tmpDir('lanes');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'ROADMAP.md'), text);
  return root;
}
const MARKUP = {
  phases: { '02': { areas: ['src/api/**'], gates: [], confidence: 'high' }, 3: { areas: ['web/**'], gates: ['prod-deploy'], confidence: 'high' }, 4: { areas: ['docs/**'], gates: [], confidence: 'low' } },
  pairs: [['4', '2', 'ok', 'no shared files'], ['2', '3', 'conflict', 'shared schema']],
};

test('no lanes.json, junk, or a file without roadmap_sha256 reads as null', () => {
  const root = project();
  assert.equal(readLanesFile(root), null);
  fs.writeFileSync(lanesFile(root), '{ not json');
  assert.equal(readLanesFile(root), null);
  fs.writeFileSync(lanesFile(root), JSON.stringify({ phases: {} }));
  assert.equal(readLanesFile(root), null);
});

test('write then read: the pinned shape, normalized ids and pairs, fresh against the ROADMAP', () => {
  const root = project();
  const written = writeLanesFile(root, MARKUP);
  assert.equal(written.v, 1);
  assert.match(written.roadmap_sha256, /^[0-9a-f]{64}$/);
  assert.match(written.phases['2'].section, /^[0-9a-f]{64}$/);
  const l = readLanesFile(root);
  assert.deepEqual(Object.keys(l).sort(), ['fresh', 'pairs', 'phases', 'roadmapSha256']);
  assert.equal(l.fresh, true);
  assert.deepEqual(l.phases, {
    2: { areas: ['src/api/**'], gates: [], confidence: 'high' },
    3: { areas: ['web/**'], gates: ['prod-deploy'], confidence: 'high' },
    4: { areas: ['docs/**'], gates: [], confidence: 'low' },
  });
  assert.deepEqual(l.pairs, [['2', '4', 'ok', 'no shared files'], ['2', '3', 'conflict', 'shared schema']]);
});

test('fresh survives the markup lines and GSD\'s completion edits; a scheduling edit makes only its phase stale', () => {
  const root = project();
  writeLanesFile(root, MARKUP);
  const edit = (from, to) => fs.writeFileSync(roadmapFile(root), fs.readFileSync(roadmapFile(root), 'utf8').replace(from, to));
  fs.writeFileSync(roadmapFile(root), writeLaneLines(ROADMAP, '2', { areas: ['src/api/**'] }));
  edit('**Plans**: 0/2 plans', '**Plans**: 2/2 plans complete');
  edit('- [ ] **Phase 2: Api**', '- [x] **Phase 2: Api**');
  assert.equal(readLanesFile(root).fresh, true);
  assert.deepEqual(stalePhases(root, PHASES), []);
  edit('**Depends on**: Phase 1', '**Depends on**: Nothing');
  assert.equal(readLanesFile(root).fresh, false);
  assert.deepEqual(stalePhases(root, PHASES), ['2']);
  assert.deepEqual(Object.keys(readLanesFile(root).phases), ['3', '4'], 'the changed phase is left out');
  assert.deepEqual(areasOf(readLanesFile(root), '2'), [EVERYTHING]);
  edit('## Progress', '### Phase 5: Ops\n**Goal**: Deploy it\n\n## Progress');
  assert.deepEqual(stalePhases(root, [...PHASES, { number: '5', name: 'Ops', deps: [], complete: false, closed: false }]), ['2', '5']);
  assert.deepEqual(stalePhases(root, PHASES.map((p) => (p.number === '2' ? { ...p, complete: true } : p))), [], 'a finished phase is never stale');
});

test('without lanes.json every unfinished phase with a section is stale', () => {
  assert.deepEqual(stalePhases(project(), PHASES), ['2', '3', '4']);
});

test('areasOf: low confidence, a missing phase, no file, corrupt values all read as everything; gatesOf', () => {
  const root = project();
  writeLanesFile(root, MARKUP);
  const raw = JSON.parse(fs.readFileSync(lanesFile(root), 'utf8'));
  raw.phases['5'] = { areas: 'src/**', gates: ['Bad Gate', 'owner-live'], confidence: 'medium' };
  fs.writeFileSync(lanesFile(root), JSON.stringify(raw));
  const l = readLanesFile(root);
  assert.deepEqual(areasOf(l, '2'), ['src/api/**']);
  assert.deepEqual(areasOf(l, '4'), [EVERYTHING]);
  assert.deepEqual(areasOf(l, '5'), [EVERYTHING]);
  assert.deepEqual(areasOf(l, '9'), [EVERYTHING]);
  assert.deepEqual(areasOf(null, '2'), [EVERYTHING]);
  assert.deepEqual(gatesOf(l, '3'), ['prod-deploy']);
  assert.deepEqual(gatesOf(l, '5'), [], 'a phase without a ROADMAP section is left out');
  assert.deepEqual(gatesOf(l, '9'), []);
  assert.deepEqual(readLanesRaw(root).phases['5'], { areas: [EVERYTHING], gates: ['owner-live'], confidence: 'low', section: null });
});

test('writeLanesFile needs a ROADMAP', () => {
  const root = tmpDir('lanes-none');
  fs.mkdirSync(path.join(root, '.planning', 'turbo'), { recursive: true });
  assert.throws(() => writeLanesFile(root, MARKUP), /no \.planning\/ROADMAP\.md/);
});

test('Stage 5 D1: a phase marked low without its CONTEXT.md goes stale once the CONTEXT.md exists; high, no key or context true never', () => {
  const root = project();
  const phases = PHASES;
  const mark = (e4) => writeLanesFile(root, { phases: { 2: { areas: ['src/**'], gates: [], confidence: 'high', context: false }, 3: { areas: ['web/**'], gates: [], confidence: 'high' }, 4: e4 } });
  mark({ areas: ['**'], gates: [], confidence: 'low', context: false });
  assert.deepEqual(stalePhases(root, phases), []);
  assert.equal(readLanesRaw(root).phases['4'].context, false);
  const dir = path.join(root, '.planning', 'phases', '04-docs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '04-CONTEXT.md'), '# ctx\n');
  assert.deepEqual(stalePhases(root, phases), ['4']);
  fs.mkdirSync(path.join(root, '.planning', 'phases', '02-api'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'phases', '02-api', '02-CONTEXT.md'), '# ctx\n');
  assert.deepEqual(stalePhases(root, phases), ['4'], 'phase 2 has high confidence');
  mark({ areas: ['**'], gates: [], confidence: 'low' });
  assert.deepEqual(stalePhases(root, phases), [], 'no context key: a v0.4 markup');
  mark({ areas: ['**'], gates: [], confidence: 'low', context: true });
  assert.deepEqual(stalePhases(root, phases), [], 'marked up again with its context: no loop');
});
