import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IN_PHASE_FACTOR, forecast, phaseHours, stepsLine } from '../lib/adopt-forecast.mjs';

const P = (number, deps = [], complete = false) => ({ number, deps, complete, closed: false });
const disjoint = (n) => ({ areas: [`src/p${n}/**`], gates: [] });

test('a chain runs one phase after another: no gain from lanes', () => {
  const f = forecast({ phases: [P('1'), P('2', ['1']), P('3', ['2'])], annotation: disjoint });
  assert.deepEqual(f.after.steps, [['1'], ['2'], ['3']]);
  assert.deepEqual([f.before.phases, f.before.hours, f.after.hours, f.speedUp.lanes], [3, 3, 3, 1]);
  assert.equal(f.unit, 'phase');
  assert.equal(f.withPhaseSpeedUp.hours, 3 * IN_PHASE_FACTOR);
  assert.equal(f.speedUp.total, 3 / (3 * IN_PHASE_FACTOR));
});

test('two independent branches with disjoint areas run side by side', () => {
  const phases = [P('1'), P('2', ['1']), P('3', ['1']), P('4', ['2', '3'])];
  const f = forecast({ phases, annotation: disjoint });
  assert.deepEqual(f.after.steps, [['1'], ['2', '3'], ['4']]);
  assert.equal(f.speedUp.lanes, 4 / 3);
  assert.equal(stepsLine(f.after.steps), '1 → 2 ∥ 3 → 4');
});

test('shared areas, a shared gate, one slot (checkout) and no markup keep the phases serial', () => {
  const phases = [P('1'), P('2', ['1']), P('3', ['1']), P('4', ['2', '3'])];
  const serial = [['1'], ['2'], ['3'], ['4']];
  assert.deepEqual(forecast({ phases, annotation: (n) => ({ areas: n === '2' || n === '3' ? ['api/**'] : [`p${n}/**`], gates: [] }) }).after.steps, serial);
  assert.deepEqual(forecast({ phases, annotation: (n) => ({ areas: [`p${n}/**`], gates: ['owner-live'] }) }).after.steps, serial);
  assert.deepEqual(forecast({ phases, annotation: disjoint, slots: 1 }).after.steps, serial);
  assert.deepEqual(forecast({ phases }).after.steps, serial, 'every phase ** without markup');
});

test('done and closed phases are not counted and satisfy their dependents; hours scale the result', () => {
  const phases = [P('1', [], true), { ...P('2', ['1']), closed: true }, P('3', ['2']), P('4', ['1'])];
  const f = forecast({ phases, annotation: disjoint, hours: 2.5 });
  assert.deepEqual(f.after.steps, [['3', '4']]);
  assert.deepEqual([f.before.phases, f.before.hours, f.after.hours, f.unit], [2, 5, 2.5, 'hour']);
});

test('relaxations are the caller\'s: a dropped dependency in deps lets the phase start earlier', () => {
  const f = forecast({ phases: [P('1'), P('2')], annotation: disjoint });
  assert.deepEqual(f.after.steps, [['1', '2']]);
});

test('a dependency cycle ends the simulation with the phases left', () => {
  const f = forecast({ phases: [P('1', ['2']), P('2', ['1']), P('3')], annotation: disjoint });
  assert.deepEqual(f.after.steps, [['3']]);
  assert.deepEqual(f.left, ['1', '2']);
});

test('phaseHours: the median span of the last done phases, one decimal; none without history', () => {
  const h = 3600;
  const log = { 'p/1': [0, 2 * h], 'p/2': [10 * h, 14 * h], 'p/3': [5 * h], 'p/4': [0, 9 * h] };
  const git = (args) => (log[args.at(-1)] || []).join('\n');
  const phases = [P('1', [], true), P('2', [], true), P('3', [], true), P('4')];
  assert.equal(phaseHours(phases, { git, phaseDirOf: (n) => `p/${n}` }), 3);
  assert.equal(phaseHours([P('4')], { git, phaseDirOf: (n) => `p/${n}` }), null);
  assert.equal(phaseHours(phases, { git: () => { throw new Error('no git'); }, phaseDirOf: (n) => `p/${n}` }), null);
});
