import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PHASE_DIR, finishPhase, laneProject } from './helpers/lane-merge.mjs';
import { IntegrateRefused, SHARED_PLANNING, holdFile, integrateFile, integrateMain } from '../lib/integrate.mjs';
import { runPhaseCommand } from '../lib/cli-phase.mjs';
import { readJson } from '../lib/fsx.mjs';

const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
const merging = (dir) => fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'));

test('main has not moved: nothing to merge, but STATE.md, ROADMAP.md and REQUIREMENTS.md come back from main in one commit', () => {
  const p = laneProject();
  finishPhase(p);
  const mainHead = p.inMain('rev-parse', 'HEAD');
  const r = integrateMain(p.slot, '3', { git: p.git });
  assert.deepEqual([r.state, r.base, r.main, r.head], ['shared', mainHead, 'main', p.inSlot('rev-parse', 'HEAD')]);
  for (const f of SHARED_PLANNING) if (fs.existsSync(path.join(p.root, f))) assert.equal(read(p.slot, f), read(p.root, f), f);
  assert.equal(p.inSlot('log', '-1', '--format=%s'), 'chore(phase-3): take STATE.md, ROADMAP.md, REQUIREMENTS.md from main (turbo integrate)');
  assert.equal(p.inSlot('status', '--porcelain', '--untracked-files=no'), '');
  const rec = readJson(integrateFile(p.slot, '3'), null);
  assert.deepEqual([rec.phase, rec.main, rec.branch, rec.base, rec.state, rec.head], ['3', 'main', 'turbo/p3', mainHead, 'integrated', r.head]);
  assert.ok(fs.existsSync(path.join(p.root, '.planning', 'turbo', 'run', 'p3-integrate.json')), 'the record lives in the control root');
  // run again: already up to date, nothing new
  assert.equal(integrateMain(p.slot, '3', { git: p.git }).state, 'up-to-date');
});

test('main moved: merged into the phase branch; a STATE.md both sides changed takes main\'s version without a conflict', () => {
  const p = laneProject();
  finishPhase(p);
  p.writeMain('src/other.js', 'export const other = 2;\n');
  p.writeMain('.planning/STATE.md', '# State\n\nStatus: Phase 2 complete\n');
  const mainHead = p.commitMain('feat: phase 2');
  const r = integrateMain(p.slot, '3', { git: p.git });
  assert.deepEqual([r.state, r.base], ['merged', mainHead]);
  assert.equal(p.inSlot('rev-parse', 'HEAD^2'), mainHead);
  assert.equal(p.inSlot('log', '-1', '--format=%s'), 'Merge main into turbo/p3 (turbo integrate)');
  assert.equal(read(p.slot, '.planning/STATE.md'), '# State\n\nStatus: Phase 2 complete\n');
  assert.equal(read(p.slot, 'src/other.js'), 'export const other = 2;\n');
  assert.equal(read(p.slot, 'src/feature.js'), 'export const feature = 1;\n');
  assert.equal(merging(p.slot), false);
});

test('a conflict in code stays for the lane; after it resolves and stages the file, a second run commits the merge', () => {
  const p = laneProject();
  finishPhase(p, { code: { 'src/app.js': 'export const app = 3;\n' } });
  p.writeMain('src/app.js', 'export const app = 2;\n');
  p.commitMain('feat: app 2');
  const r = integrateMain(p.slot, '3', { git: p.git });
  assert.deepEqual([r.state, r.conflicts], ['conflicts', ['src/app.js']]);
  assert.equal(merging(p.slot), true);
  assert.equal(readJson(integrateFile(p.slot, '3'), null).state, 'conflicts');
  p.writeSlot('src/app.js', 'export const app = 3;\n');
  p.inSlot('add', 'src/app.js');
  const again = integrateMain(p.slot, '3', { git: p.git });
  assert.deepEqual([again.state, again.base], ['merged', r.base]);
  assert.equal(merging(p.slot), false);
  assert.equal(readJson(integrateFile(p.slot, '3'), null).state, 'integrated');
});

test('refusals change nothing: not this phase, uncommitted changes, a merge turbo did not start; outside a slot nothing to do', () => {
  const p = laneProject();
  finishPhase(p);
  assert.deepEqual(integrateMain(p.root, '3', { git: p.git }), { state: 'not-slot' });
  const refused = (phase, re) => assert.throws(() => integrateMain(p.slot, phase, { git: p.git }), (e) => e instanceof IntegrateRefused && re.test(e.message));
  refused('4', /this slot holds no active job of phase 4/);
  p.writeSlot('src/feature.js', 'dirty\n');
  refused('3', /uncommitted changes: src\/feature\.js; commit or discard them first/);
  p.inSlot('checkout', '--', 'src/feature.js');
  p.writeMain('src/feature.js', 'export const feature = 0;\n');
  p.commitMain('main side');
  p.inSlot('fetch', '-q', 'origin');
  try { p.inSlot('merge', '--no-ff', '--no-commit', 'origin/main'); } catch { /* a conflict: the merge stays in progress */ }
  refused('3', /a merge of [0-9a-f]{12} is in progress that turbo-run integrate did not start: finish it or abort it \(git merge --abort\) first/);
  assert.equal(read(p.slot, `${PHASE_DIR}/03-01-PLAN.md`).startsWith('---'), true);
});

test('turbo-run integrate N prints the base and the fix rounds; exit 4 on conflicts; --hold writes the hold in the control root', async () => {
  const p = laneProject();
  finishPhase(p);
  const lines = [];
  const run = (root, ...a) => runPhaseCommand('integrate', a, { root, out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`), deps: { slotGit: p.git } });
  assert.equal(await run(p.slot, '3'), 0);
  assert.match(lines[0], /^integrated main at [0-9a-f]{12} \(main had not moved; took STATE\.md, ROADMAP\.md and REQUIREMENTS\.md from it\)$/);
  assert.equal(lines[1], `base ${p.inMain('rev-parse', 'HEAD')}`);
  assert.equal(lines[2], 'full test rounds allowed: 2');
  assert.equal(await run(p.slot, '3', '--hold'), 0);
  assert.equal(lines.at(-1), 'phase 3: merge hold set; turbo starts no new phase until this one is merged');
  assert.deepEqual(Object.keys(readJson(holdFile(p.slot, '3'), null)).sort(), ['at', 'phase']);
  assert.ok(fs.existsSync(path.join(p.root, '.planning', 'turbo', 'run', 'p3-merge-hold.json')));
  p.writeMain('src/feature.js', 'export const feature = 0;\n');
  p.commitMain('main side');
  p.writeSlot('src/feature.js', 'export const feature = 9;\n');
  p.commitSlot('slot side');
  assert.equal(await run(p.slot, '3'), 4);
  assert.deepEqual(lines.slice(-2), ['conflicts: src/feature.js', 'resolve them within phase 3, git add each, then run turbo-run integrate 3 again (it commits the merge)']);
  assert.equal(await run(p.root, '3'), 0);
  assert.equal(lines.at(-1), 'integrate 3: not a slot (lanes.mode checkout or a hand run): nothing to integrate');
  assert.equal(await run(p.root, '3', '--hold'), 1);
  assert.match(lines.at(-1), /^ERR turbo-run integrate: --hold is for a lane in a slot/);
});
