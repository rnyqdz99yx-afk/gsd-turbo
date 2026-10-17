import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outlinePlanIds, outlineRows } from '../lib/phase-files.mjs';

// GSD's own example table (gsd-core references/planner-chunked.md, outline-only mode).
const GSD_EXAMPLE = [
  '## OUTLINE COMPLETE', '',
  '**Phase:** 33-demo', '**Plans:** 2 plan(s) in 1 wave(s)', '',
  '| Plan ID | Objective | Wave | Depends On | Requirements |',
  '|---------|-----------|------|-----------|-------------|',
  '| 33-01 | [brief objective] | 1 | none | REQ-001, REQ-002 |',
  '| 33-02 | [brief objective] | 1 | none | REQ-003 |',
].join('\n');

// A long chain: 10 plans in 8 waves (the journal's phase 33), cells as planners write them.
const CHAIN = [
  '# Phase 33 plan outline', '',
  '| Plan ID | Objective | Wave | Depends On | Requirements |',
  '|:--|:--|:-:|:--|:--|',
  '| 33-01 | Schema | 1 | none | R1 |',
  '| 33-02 | Store | 2 | 33-01 | R2 |',
  '| 33-03 | Cache | 2 | 33-01 | R3 |',
  '| 33-04 | API | 3 | 33-02, 33-03 | R4 |',
  '| 33-05 | Jobs | 4 | **33-04** | R5 |',
  '| 33-06 | Events | 5 | `33-05` | R6 |',
  '| 33-07 | UI shell | 6 | [33-06](33-06-PLAN.md) | R7 |',
  '| 33-08 | UI pages | 6 | 33-06 | R8 |',
  '| 33-09 | Docs | 7 | 33-07, 33-08 | R9 |',
  '| 33-10 | Release | 8 | 33-09 | R10 |',
  '', '## OUTLINE COMPLETE', '',
].join('\n');

test('GSD\'s own example table: wave 1, no dependencies, the requirement ids', () => {
  const r = outlineRows(GSD_EXAMPLE, '33');
  assert.deepEqual(r.columns, { wave: true, dependsOn: true });
  assert.deepEqual(r.rows.map(({ id, objective, wave, dependsOn, requirements }) => ({ id, objective, wave, dependsOn, requirements })), [
    { id: '33-01', objective: '[brief objective]', wave: 1, dependsOn: [], requirements: ['REQ-001', 'REQ-002'] },
    { id: '33-02', objective: '[brief objective]', wave: 1, dependsOn: [], requirements: ['REQ-003'] },
  ]);
  assert.equal(r.rows[0].row, '| 33-01 | [brief objective] | 1 | none | REQ-001, REQ-002 |');
});

test('a 10-plan, 8-wave chain: dependency cells in bold, code, links and lists; outlinePlanIds unchanged', () => {
  const r = outlineRows(CHAIN, '33');
  assert.equal(r.rows.length, 10);
  assert.deepEqual(r.rows.map((x) => x.wave), [1, 2, 2, 3, 4, 5, 6, 6, 7, 8]);
  assert.deepEqual(r.rows.map((x) => x.dependsOn), [[], ['33-01'], ['33-01'], ['33-02', '33-03'], ['33-04'], ['33-05'], ['33-06'], ['33-06'], ['33-07', '33-08'], ['33-09']]);
  assert.deepEqual(outlinePlanIds(CHAIN, '33'), r.rows.map((x) => x.id));
  // CRLF reads the same
  const crlf = outlineRows(CHAIN.replace(/\n/g, '\r\n'), '33');
  assert.deepEqual(crlf.rows.map((x) => [x.id, x.wave, x.dependsOn]), r.rows.map((x) => [x.id, x.wave, x.dependsOn]));
  assert.deepEqual(outlinePlanIds(CHAIN.replace(/\n/g, '\r\n'), '33'), r.rows.map((x) => x.id));
});

test('blank Wave is 1 (GSD\'s rule); a wave that is not a whole number from 1 is NaN; — and - in Depends On are none', () => {
  const text = [
    '| Plan ID | Objective | Wave | Depends On | Requirements |', '|---|---|---|---|---|',
    '| 33-01 | a |  | — | R1 |',
    '| 33-02 | b | 2a | - | R2 |',
    '| 33-03 | c | 0 |  | R3 |',
    '| 33-04 | d | 2 | n/a | R4 |',
    '| 33-05 | e | 2 | TBD | R5 |',
  ].join('\n');
  const r = outlineRows(text, '33');
  assert.equal(r.rows[0].wave, 1);
  assert.ok(Number.isNaN(r.rows[1].wave));
  assert.ok(Number.isNaN(r.rows[2].wave));
  assert.deepEqual(r.rows.slice(0, 4).map((x) => x.dependsOn), [[], [], [], []]);
  // a dependency cell that names something but no plan id cannot be read: null (the caller turns drafts off)
  assert.equal(r.rows[4].dependsOn, null);
});

test('extra columns and another column order; Depends / Depends on headers; a row without an id is kept with id null', () => {
  const text = [
    '| Wave | Notes | Plan | Depends | Objective | Reqs |', '| --- | --- | --- | --- | --- | --- |',
    '| 1 | first | 33-01 | none | Schema | R1 |',
    '| 2 | x | 33-02 | 33-01 | Store | R2 |',
    '| 2 | total | — | | | |',
  ].join('\n');
  const r = outlineRows(text, '33');
  assert.deepEqual(r.columns, { wave: true, dependsOn: true });
  assert.deepEqual(r.rows.map((x) => [x.id, x.objective, x.wave, x.dependsOn, x.requirements]), [
    ['33-01', 'Schema', 1, [], ['R1']],
    ['33-02', 'Store', 2, ['33-01'], ['R2']],
    [null, '', 2, [], []],
  ]);
  assert.equal(r.rows[1].row, '| 33-02 | Store | 2 | 33-01 | R2 |');
  const lower = outlineRows('| plan id | objective | wave | depends on |\n|-|-|-|-|\n| 33-01 | a | 1 | none |', '33');
  assert.deepEqual(lower.columns, { wave: true, dependsOn: true });
});

test('a table without a Wave or Depends On column: rows with wave and dependsOn undefined, and the columns flag says so', () => {
  const r = outlineRows('| Plan ID | Objective |\n|---|---|\n| 33-01 | a |\n| 33-02 | b |', '33');
  assert.deepEqual(r.columns, { wave: false, dependsOn: false });
  assert.deepEqual(r.rows.map((x) => [x.id, x.wave, x.dependsOn]), [['33-01', undefined, undefined], ['33-02', undefined, undefined]]);
  assert.deepEqual(outlineRows('no table', '33'), { columns: { wave: false, dependsOn: false }, rows: [] });
});

test('fenced tables and tables without a plan column are ignored; only the first outline table is read', () => {
  const text = [
    '```', '| Plan ID | Objective | Wave | Depends On |', '|---|---|---|---|', '| 33-09 | fenced | 1 | none |', '```', '',
    '| File | Why |', '|---|---|', '| src/a.ts | x |', '',
    '| Plan ID | Objective | Wave | Depends On |', '|---|---|---|---|', '| 33-01 | a | 1 | none |', '| 33-02 | b | 2 | 33-01 |', '',
    '| Plan ID | Objective | Wave | Depends On |', '|---|---|---|---|', '| 33-07 | second table | 1 | none |',
  ].join('\n');
  const r = outlineRows(text, '33');
  assert.deepEqual(r.rows.map((x) => x.id), ['33-01', '33-02']);
});
