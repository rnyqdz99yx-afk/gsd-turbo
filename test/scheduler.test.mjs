import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePhase, nextPhase, relaunchDecision, isFinished, inRange, rangeBlocker, rangeLabel, ANY_AREA, annotationOf, areasOverlap, criticalPath, maskPrefix, pickPhases } from '../lib/scheduler.mjs';

const P = (number, deps = [], complete = false) => ({ number, deps, complete });
// checked off in the ROADMAP and fully implemented, but GSD reports it unfinished (verification stale)
const C = (number, deps = []) => ({ number, deps, complete: false, closed: true });

test('comparePhase orders decimals numerically', () => {
  const sorted = ['10', '2', '2.1', '2.10', '2.2', '1'].sort(comparePhase);
  assert.deepEqual(sorted, ['1', '2', '2.1', '2.2', '2.10', '10']);
});

test('comparePhase puts decimal sub-phases before letter-suffixed inserts, like GSD', () => {
  const sorted = ['3', '2A', '2', '2.1', '2B'].sort(comparePhase);
  assert.deepEqual(sorted, ['2', '2.1', '2A', '2B', '3']);
});

test('nextPhase picks lowest incomplete phase with satisfied deps', () => {
  const phases = [P('1', [], true), P('3', ['2']), P('2', ['1']), P('2.1', ['2'])];
  assert.equal(nextPhase(phases).number, '2');
});

test('deps outside the milestone count as satisfied', () => {
  assert.equal(nextPhase([P('5', ['0', '4'])]).number, '5');
});

test('nextPhase respects exclude and returns null when nothing is ready', () => {
  const phases = [P('1', [], true), P('2', ['1']), P('3', ['2'])];
  assert.equal(nextPhase(phases, { exclude: ['2'] }), null);
  assert.equal(nextPhase([P('1', [], true)]), null);
});

test('a closed phase is never started again and satisfies the deps on it', () => {
  assert.equal(nextPhase([C('1'), P('2', ['1']), P('3', ['2'])]).number, '2');
  assert.equal(nextPhase([C('1'), C('2', ['1'])]), null);
  assert.deepEqual([P('1', [], true), C('2'), P('3'), { number: '4', deps: [] }].map(isFinished), [true, true, false, false]);
});

test('a range starts only the phases inside it (comparePhase, inclusive); an unfinished dep outside it is not met', () => {
  const phases = [P('1'), P('2', ['1']), P('2.1', ['2']), P('2A'), P('3', ['2'])];
  assert.equal(nextPhase(phases, { range: { from: '2', to: '2' } }), null, 'its dep 1 is unfinished');
  assert.equal(nextPhase(phases, { range: { from: '2.1', to: null } }).number, '2A', '2.1 and 3 wait on 2');
  assert.equal(nextPhase(phases, { range: { from: null, to: '1' } }).number, '1');
  assert.equal(nextPhase(phases, { range: { from: '3', to: '3' } }), null);
  assert.equal(nextPhase(phases, { range: { from: '2B', to: '2C' } }), null);
  assert.equal(nextPhase(phases, { range: null }).number, '1');
  const finished = [P('1', [], true), C('2', ['1']), P('3', ['2']), P('4', ['9'])];
  assert.equal(nextPhase(finished, { range: { from: '3', to: '3' } }).number, '3', 'a complete or closed dep outside the range is met');
  assert.equal(nextPhase(finished, { range: { from: '4', to: '4' } }).number, '4', 'a dep outside the milestone is met');
});

test('rangeBlocker names the first phase of the range held by an unfinished dep outside it', () => {
  const phases = [P('1'), P('2', ['1']), P('3', ['2']), P('4', ['3', '1']), P('5', ['9'])];
  assert.deepEqual(rangeBlocker(phases, { from: '3', to: '4' }), { phase: '3', dep: '2' });
  assert.deepEqual(rangeBlocker(phases, { from: '4', to: '4' }), { phase: '4', dep: '1' }, 'the lowest unfinished dep');
  assert.equal(rangeBlocker(phases, { from: '5', to: '5' }), null, 'a dep outside the milestone never blocks');
  assert.equal(rangeBlocker(phases, { from: '1', to: '4' }), null);
  assert.equal(rangeBlocker(phases, null), null);
  assert.equal(rangeBlocker([P('1'), P('2', ['1'], true)], { from: '2', to: '2' }), null, 'a finished phase waits on nothing');
});

test('inRange and rangeLabel: either end may be open; no range is the whole milestone', () => {
  assert.equal(inRange('5', null), true);
  assert.equal(inRange('5', { from: '5', to: '5' }), true);
  assert.equal(inRange('5.1', { from: '5', to: '5' }), false);
  assert.equal(inRange('4', { from: '5', to: null }), false);
  assert.equal(inRange('12', { from: null, to: '9' }), false);
  assert.deepEqual([{ from: '3', to: '7' }, { from: '3', to: null }, { from: null, to: '7' }].map(rangeLabel), ['3–7', '3–end', 'start–7']);
});

test('relaunchDecision resets on progress and halts after max no-progress restarts', () => {
  assert.deepEqual(relaunchDecision({ restarts: 2, progressed: true, maxRestarts: 3 }), { action: 'relaunch', restarts: 0 });
  assert.deepEqual(relaunchDecision({ restarts: 0, progressed: false, maxRestarts: 3 }), { action: 'relaunch', restarts: 1 });
  assert.deepEqual(relaunchDecision({ restarts: 3, progressed: false, maxRestarts: 3 }), { action: 'halt', restarts: 4 });
});

// supervisor.json is hand-editable and resume rewrites the lane: a bad count must never
// make the no-progress bound disappear.
test('relaunchDecision: a missing or invalid count starts at 0; a missing or invalid limit halts', () => {
  for (const restarts of [undefined, null, NaN, 'x', -2]) {
    assert.deepEqual(relaunchDecision({ restarts, progressed: false, maxRestarts: 3 }), { action: 'relaunch', restarts: 1 }, String(restarts));
  }
  assert.deepEqual(relaunchDecision({ restarts: '2', progressed: false, maxRestarts: 3 }), { action: 'relaunch', restarts: 3 });
  assert.deepEqual(relaunchDecision({ restarts: 1.7, progressed: false, maxRestarts: 3 }), { action: 'relaunch', restarts: 2 });
  for (const maxRestarts of [undefined, NaN, 'x']) {
    assert.equal(relaunchDecision({ restarts: 0, progressed: false, maxRestarts }).action, 'halt', String(maxRestarts));
  }
});

test('maskPrefix: the static part of a mask by path segments, lower case, Windows separators and ./ removed', () => {
  assert.deepEqual(maskPrefix('src/api/*.ts'), { segs: ['src', 'api'], partial: '' });
  assert.deepEqual(maskPrefix('src/ap*'), { segs: ['src'], partial: 'ap' });
  assert.deepEqual(maskPrefix('README.md'), { segs: ['readme.md'], partial: null });
  assert.deepEqual(maskPrefix('docs/'), { segs: ['docs'], partial: '' });
  assert.deepEqual(maskPrefix('**'), { segs: [], partial: '' });
  assert.deepEqual(maskPrefix(' ./a//b/c?.js '), { segs: ['a', 'b'], partial: 'c' });
  assert.deepEqual(maskPrefix('src\\Api\\[ab].ts'), { segs: ['src', 'api'], partial: '' });
  assert.deepEqual(maskPrefix('!src/x'), { segs: [], partial: '' });
  assert.deepEqual(maskPrefix(''), { segs: [], partial: '' });
  assert.deepEqual(ANY_AREA, ['**']);
});

test('areasOverlap (spec §6.3): one static prefix is a prefix of the other by segments; false overlaps only cost parallelism (Review Focus 4)', () => {
  const yes = [
    [['src/**'], ['src/api/x.ts']],
    [['src/api/'], ['src/api']],
    [['src/a*'], ['src/ab/c.ts']],
    [['src/a*'], ['src/ab*']],
    [['src'], ['src/x/y.ts']],
    [['**'], ['docs/a.md']],
    [['src\\api\\*.ts'], ['./SRC/Api/user.ts']],
    [['!src/x'], ['lib/y']],
    [['src/*.ts'], ['src/deep/a.js']],
    [['lib/{a,b}.js'], ['lib/c.js']],
    [['a.md', 'src/**'], ['src/z']],
    [['README.md'], ['readme.md']],
  ];
  const no = [
    [['src/a*'], ['src/b/c.ts']],
    [['src/api/**'], ['src/apix/**']],
    [['src/a.ts'], ['src/b.ts']],
    [['docs/**'], ['src/**']],
    [[], ['**']],
  ];
  for (const [a, b] of yes) {
    assert.equal(areasOverlap(a, b), true, `${a} / ${b}`);
    assert.equal(areasOverlap(b, a), true, `${b} / ${a}`);
  }
  for (const [a, b] of no) {
    assert.equal(areasOverlap(a, b), false, `${a} / ${b}`);
    assert.equal(areasOverlap(b, a), false, `${b} / ${a}`);
  }
  assert.equal(areasOverlap(undefined, ['x']), true, 'no list is everything');
});

test('annotationOf: lanes.json areas and gates; a missing phase, low confidence or no file is ** with its gates', () => {
  const file = { fresh: true, phases: { 3: { areas: ['src/a/**'], gates: ['prod-deploy'], confidence: 'high' }, 4: { areas: ['src/b/**'], gates: ['owner-live'], confidence: 'low' } } };
  assert.deepEqual(annotationOf(file, '3'), { areas: ['src/a/**'], gates: ['prod-deploy'] });
  assert.deepEqual(annotationOf(file, '4'), { areas: ['**'], gates: ['owner-live'] });
  assert.deepEqual(annotationOf(file, '5'), { areas: ['**'], gates: [] });
  assert.deepEqual(annotationOf(null, '3'), { areas: ['**'], gates: [] });
  assert.deepEqual(annotationOf({ fresh: true, phases: { 3: { areas: 'src', gates: null } } }, '3'), { areas: ['**'], gates: [] });
});

test('criticalPath: the longest chain of unfinished phases waiting on each phase; finished phases do not count; a cycle ends', () => {
  const P2 = (number, deps = [], complete = false) => ({ number, deps, complete });
  const cp = criticalPath([P2('1'), P2('2', ['1']), P2('3', ['2']), P2('4'), P2('5', ['4']), P2('6', [], true), P2('7', ['6'])]);
  assert.deepEqual(Object.fromEntries(cp), { 1: 3, 2: 2, 3: 1, 4: 2, 5: 1, 7: 1 });
  assert.equal(criticalPath([P2('8', ['9']), P2('9', ['8'])]).size, 2);
});

const A = (areas, gates = [], confidence = 'high') => ({ areas: Array.isArray(areas) ? areas : [areas], gates, confidence });

test('pickPhases: deps, areas, gates, held locks and slots; the critical path first (spec §5)', () => {
  const phases = [P('1'), P('2'), P('3', ['1']), P('4'), P('5', ['9'])]; // 9 is not in the milestone: satisfied
  const file = { fresh: true, phases: { 1: A('src/a/**'), 2: A('src/b/**', ['prod-deploy']), 3: A('src/c/**'), 4: A('src/a/x.ts'), 5: A('docs/**', ['prod-deploy']) } };
  const annotation = (n) => annotationOf(file, n);
  // 1 leads (3 waits on it), then 2; 4 overlaps 1 (src/a); 5 shares prod-deploy with 2
  let r = pickPhases(phases, { annotation, slots: 3 });
  assert.deepEqual(r.picked.map((p) => p.number), ['1', '2']);
  assert.deepEqual(r.next, { phase: '4', why: 'areas', waitsFor: ['1'] });
  r = pickPhases(phases, { annotation, slots: 3, running: [{ phase: '1', areas: ['src/a/**'], gates: [] }] });
  assert.deepEqual(r.picked.map((p) => p.number), ['2']);
  r = pickPhases(phases, { annotation, slots: 1 });
  assert.deepEqual(r.picked.map((p) => p.number), ['1']);
  assert.deepEqual(r.next, { phase: '2', why: 'slots', waitsFor: [] });
  r = pickPhases(phases, { annotation, slots: 3, heldGates: [{ gate: 'prod-deploy', phase: '7' }] });
  assert.deepEqual(r.picked.map((p) => p.number), ['1']);
  assert.deepEqual(r.next, { phase: '2', why: 'gates', waitsFor: ['7'], gate: 'prod-deploy' });
  r = pickPhases(phases, { annotation, slots: 3, exclude: ['2', '4'] });
  assert.deepEqual(r.picked.map((p) => p.number), ['1', '5']);
  assert.deepEqual(pickPhases([P('1'), P('2', ['1'])], { slots: 2, running: [{ phase: '1', areas: ['**'], gates: [] }] }), { picked: [], next: { phase: '2', why: 'deps', waitsFor: ['1'] } });
  assert.deepEqual(pickPhases([P('1', [], true)], { slots: 2 }), { picked: [], next: null });
  assert.deepEqual(pickPhases([P('1'), P('2')], { slots: 2, range: { from: '2', to: null }, annotation }).picked.map((p) => p.number), ['2']);
});

test('pickPhases: one phase lane without a fresh annotation; a phase missing from it overlaps every other (Review Focus 4)', () => {
  const phases = [P('1'), P('2'), P('3')];
  assert.deepEqual(pickPhases(phases, { slots: 3, oneLane: true }).picked.map((p) => p.number), ['1']);
  assert.deepEqual(pickPhases(phases, { slots: 3, oneLane: true, running: [{ phase: '1', areas: ['src/**'], gates: [] }] }), { picked: [], next: { phase: '2', why: 'annotation', waitsFor: ['1'] } });
  const file = { fresh: true, phases: { 1: A('a/**'), 2: A('b/**') } };
  const r = pickPhases(phases, { slots: 3, annotation: (n) => annotationOf(file, n) });
  assert.deepEqual(r.picked.map((p) => p.number), ['1', '2']);
  assert.deepEqual(r.next, { phase: '3', why: 'areas', waitsFor: ['1'] });
  // without an annotation function every phase is **
  assert.deepEqual(pickPhases(phases, { slots: 3 }).picked.map((p) => p.number), ['1']);
});
