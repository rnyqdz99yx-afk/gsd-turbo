import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { ACTION_PLAN, writePhase } from './helpers/plans.mjs';
import { readAnswers, readQuestions, refreshQuestions, stopQuestion } from '../lib/questions.mjs';
import { AnswerRefused, answerQuestion } from '../lib/answers.mjs';
import { parkPhase, parkedFile, parkedNote, readParked, unparkPhase } from '../lib/park.mjs';
import { pickPhases } from '../lib/scheduler.mjs';
import { appendInbox, formatInboxMessage, notesBlock, phaseNotes } from '../lib/inbox.mjs';
import { rolePrompt } from '../lib/roles.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';

// live run 2026-11-11: a phase waited for two offline owner sittings and the phases after it waited for it; the owner
// asked to skip it and go on. Parking does that without answering the phase's questions.
const NOW = new Date('2026-01-01T10:00:00.000Z');
const AG = 'a0123456789abcdef';
const P = (number, deps = [], complete = false) => ({ number, deps, complete });
const run = async (root, cmd, args, env = {}) => {
  const lines = [];
  const code = await runPhaseCommand(cmd, args, { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), deps: { env, now: () => NOW } });
  return { code, lines };
};
function stopped() {
  const root = tmpDir('park');
  writePhase(root, '32-auth', { '32-11-PLAN.md': ACTION_PLAN });
  refreshQuestions(root, '32');
  stopQuestion(root, '32', '32-11-t2', { agentId: AG });
  return root;
}

test('the scheduler never launches a parked phase, and no phase after it waits for it', () => {
  const phases = [P('33', [], true), P('34', ['33']), P('35', ['34']), P('36', ['35'])];
  assert.deepEqual(pickPhases(phases, { slots: 2 }).picked.map((p) => p.number), ['34']);
  const r = pickPhases(phases, { slots: 2, parked: ['34'] });
  assert.deepEqual(r.picked.map((p) => p.number), ['35']);
  assert.deepEqual(r.next, { phase: '36', why: 'deps', waitsFor: ['35'] });
  // no markup (one lane at a time): the supervisor leaves the parked lane out of running, so the next one starts
  assert.deepEqual(pickPhases(phases, { slots: 1, parked: ['34'], oneLane: true, exclude: ['34'] }).picked.map((p) => p.number), ['35']);
});

test('park marks: new once, kept, undone; the note names the parked phases in the project language', () => {
  const root = tmpDir('park');
  fs.mkdirSync(path.join(root, '.planning', 'turbo', 'run'), { recursive: true });
  assert.deepEqual(readParked(root), {});
  assert.equal(parkPhase(root, '34', { by: 'pane', now: NOW, question: '34-05-t2' }).parked, true);
  assert.equal(parkPhase(root, '34', { by: 'session', now: NOW }).parked, false);
  assert.deepEqual(readParked(root), { 34: { at: NOW.toISOString(), by: 'pane', question: '34-05-t2' } });
  assert.equal(unparkPhase(root, '34').unparked, true);
  assert.equal(unparkPhase(root, '34').unparked, false);
  fs.writeFileSync(parkedFile(root), '[1,2]');
  assert.deepEqual(readParked(root), {}, 'a damaged file parks nothing');
  assert.match(parkedNote(['34'], 'ru'), /^Фаза 34 отложена владельцем: .* планируйте последним, за вопросом владельцу\.$/);
  assert.match(parkedNote(['33', '34'], 'en'), /^Phase 33, 34 is parked by the owner/);
});

test('the park option of a stopped owner action parks the phase and records nothing: the question stays open', () => {
  const root = stopped();
  const q = readQuestions(root, '32').find((x) => x.id === '32-11-t2');
  const k = q.options.findIndex((o) => o.park === true) + 1;
  assert.ok(k > 1, 'the park option comes after Done');
  const r = answerQuestion({ root, phase: '32', id: '32-11-t2', option: k, by: 'telegram', now: NOW, laneRunning: true });
  assert.deepEqual([r.status, r.fresh], ['parked', true]);
  assert.deepEqual(readAnswers(root, '32'), []);
  assert.equal(readQuestions(root, '32').find((x) => x.id === '32-11-t2').state, 'open');
  assert.equal(readParked(root)['32'].by, 'telegram');
  // the real answer comes later and wins as usual
  assert.equal(answerQuestion({ root, phase: '32', id: '32-11-t2', option: 1, by: 'session', now: NOW, laneRunning: true }).status, 'recorded');
  // turbo never parks for the owner
  const other = stopped();
  assert.throws(() => answerQuestion({ root: other, phase: '32', id: '32-11-t2', option: k, by: 'auto', now: NOW, laneRunning: true }), (e) => e instanceof AnswerRefused && /owner's alone/.test(e.message));
});

test('turbo-run park / answer with the park option / park --undo, and refused inside a lane', async () => {
  const root = stopped();
  const k = readQuestions(root, '32').find((x) => x.id === '32-11-t2').options.findIndex((o) => o.park === true) + 1;
  const a = await run(root, 'answer', ['32', '32-11-t2', '--option', String(k), '--by', 'pane']);
  assert.equal(a.code, 0);
  assert.match(a.lines[0], /^parked phase 32: the phases that wait for it may start; 32-11-t2 stays open/);
  const again = await run(root, 'park', ['32']);
  assert.match(again.lines[0], /^phase 32 is parked already/);
  const undo = await run(root, 'park', ['32', '--undo']);
  assert.match(undo.lines[0], /^unparked phase 32/);
  assert.deepEqual(readParked(root), {});
  const fresh = await run(root, 'park', ['32']);
  assert.match(fresh.lines[0], /^parked phase 32: /);
  const lane = await run(root, 'park', ['33'], { TURBO_LANE: '1' });
  assert.deepEqual([lane.code, lane.lines[0].startsWith('refused:')], [1, true]);
});

test('turbo-run note: the phase reads it in its inbox and every build role gets it; secrets and lanes are refused', async () => {
  const root = stopped();
  const n = await run(root, 'note', ['32', 'The main branch already holds the login fix (commit range 5a0c..ae54); do not fix it again.']);
  assert.deepEqual([n.code, n.lines[0]], [0, 'noted for phase 32: it reads the note before its next step and gives it to every step after it']);
  appendInbox(root, '32', { kind: 'note', by: 'turbo', text: parkedNote(['31'], 'en') }, { now: NOW });
  const notes = phaseNotes(root, '32');
  assert.deepEqual(notes.map((x) => x.by), ['owner', 'turbo']);
  assert.match(formatInboxMessage({ kind: 'note', by: 'owner', at: NOW.toISOString(), text: 'x  y' }, { phase: '32', ciFixRounds: 2 }), /^note · from the owner at 2026-01-01 10:00 UTC\n {2}x y\n/);
  const block = notesBlock(notes);
  assert.match(block, /^## Notes for this phase\n/);
  assert.match(block, /- owner, .*: The main branch already holds the login fix/);
  assert.match(block, /- turbo, .*: Phase 31 is parked by the owner/);
  fs.writeFileSync(path.join(root, '.planning', 'phases', '32-auth', '32-CONTEXT.md'), '# ctx\n');
  const prompt = rolePrompt('builder', { root, phase: '32', contextPath: '.planning/phases/32-auth/32-CONTEXT.md', planPath: '.planning/phases/32-auth/32-11-PLAN.md', lang: 'en' });
  assert.match(prompt, /## Notes for this phase/);
  const secret = await run(root, 'note', ['32', `use ${'pass'}word=${'hunter2'.repeat(2)}`]);
  assert.equal(secret.code, 1);
  assert.match(secret.lines[0], /^refused: the note looks like it contains a secret/);
  const lane = await run(root, 'note', ['32', 'x'], { TURBO_LANE: '1' });
  assert.equal(lane.code, 1);
});
