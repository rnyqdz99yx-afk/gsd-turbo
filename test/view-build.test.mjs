import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { entry, usage, writeSession } from './helpers/transcripts.mjs';
import { buildView, formatView, buildRows, WORDS } from '../lib/view.mjs';
import { BUILD_STEPS } from '../lib/build.mjs';
import { SLICE_STATES } from '../lib/build-queue.mjs';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
const S2 = 'b4000000-0000-4000-8000-000000000002';
const SR = 'b4000000-0000-4000-8000-000000000009';

// A checkout whose supervisor runs phase 5 on the build path: 05-01 merged, 05-02 building (its session edits
// src/b.js, started 6 min ago), 05-03 waiting for the owner's card ask-1, 05-04 waiting.
function buildLaneProject({ step = 'build', red = null, path: lanePath = 'build', state = true } = {}) {
  const root = tmpDir('view-build');
  const run = path.join(root, '.planning', 'turbo', 'run');
  fs.mkdirSync(run, { recursive: true });
  const home = tmpDir('home');
  const wt = tmpDir('wt');
  const logs = tmpDir('transcripts');
  const t2 = writeSession(logs, S2, [entry.user('You are a builder', ago(6)), entry.assistant({ ts: ago(1), tool: { name: 'Edit', input: { file_path: path.join(wt, 'src', 'b.js') } }, usage: usage(1, 1, 1) })]);
  const tr = writeSession(logs, SR, [entry.user('<config>', ago(3)), entry.assistant({ ts: ago(2), tool: { name: 'Read', input: { file_path: path.join(root, 'src', 'a.js') } }, usage: usage(1, 1, 1) })]);
  const slice = (st, fields = {}) => ({ state: st, plan: '', summary: '', base: null, sessions: [], pid: null, worktree: null, branch: null, links: [], merge: null, tests: null, question: null, ownerQuestion: null, reason: null, retries: 0, rebuilds: 0, salvage: [], leftover: null, at: {}, ...fields });
  if (state) {
    fs.writeFileSync(path.join(run, 'build-p5.json'), JSON.stringify({
      v: 1, phase: '5', round: 0, startedAt: ago(20), head0: null, graphSha: null, maxBuilders: 4, edges: [], order: ['05-01', '05-02', '05-03', '05-04'], red, hold: null,
      slices: {
        '05-01': slice('merged', { tests: 'green' }),
        '05-02': slice('running', { worktree: wt, pid: 777, sessions: [{ id: S2, role: 'builder', at: ago(6), transcript: t2 }] }),
        '05-03': slice('owner', { question: 'ask-1' }),
        '05-04': slice('waiting'),
      },
      step, steps: { review: { state: 'running', at: ago(3), session: { id: SR, role: 'reviewer', transcript: tr, cwd: root, pid: 777 } } }, base: null, roundBase: null, gapRounds: 0, info: { name: 'Demo', padded: '05' },
    }));
  }
  const sup = { pid: 4242, updatedAt: ago(0), finished: false, halted: false, range: { from: '5', to: '5' }, lane: { phase: '5', ...(lanePath ? { path: lanePath, pid: 4242 } : {}), sessionId: null, launchedAt: ago(10), mode: 'full', restarts: 0, notified: {} } };
  return { root, sup, env: { CLAUDE_CONFIG_DIR: home } };
}
const viewOf = (p, over = {}) => ({ ...buildView({ root: p.root, sup: p.sup, running: true, env: p.env, now: NOW, commits: () => [] }), ...over });

test("a build lane's view: step, active slices with their last action, the counts", () => {
  const v = viewOf(buildLaneProject());
  assert.deepEqual(v.lanes[0].build, {
    step: 'build', round: 0, red: false, hold: null, merged: 1, total: 4,
    slices: [
      { id: '05-02', state: 'running', question: null, action: { tool: 'Edit', detail: 'src/b.js' }, elapsedMs: 360000, lastAt: ago(1) },
      { id: '05-03', state: 'owner', question: 'ask-1', action: null, elapsedMs: null, lastAt: null },
    ],
    session: null,
  });
  const review = viewOf(buildLaneProject({ step: 'review' })).lanes[0].build;
  assert.deepEqual(review.session, { role: 'reviewer', action: { tool: 'Read', detail: 'src/a.js' }, elapsedMs: 180000, lastAt: ago(2) });
  assert.equal(viewOf(buildLaneProject({ path: null, state: false })).lanes[0].build, null);
  assert.equal(viewOf(buildLaneProject({ state: false })).lanes[0].build.step, 'begin');
});

test('the text view and the pane print the same build lines', async () => {
  const pane = await import('../mod/hooks/view-model.mjs');
  const base = viewOf(buildLaneProject());
  const en = formatView(base).split('\n');
  assert.ok(en.some((l) => l.startsWith('Phase 5 — building slices')), en.join('\n'));
  for (const row of ['  Slices: 1 of 4 merged · 1 building · 1 waits for you', '    05-02 · building · editing src/b.js · 6m', '    05-03 · waits for you']) assert.ok(en.includes(row), `${row}\n${en.join('\n')}`);
  assert.equal(en.some((l) => /Now:/.test(l)), false, 'a build lane has no Now row');
  const ru = { ...base, ui: { ...base.ui, lang: 'ru' } };
  const ruLines = formatView(ru).split('\n');
  assert.ok(ruLines.some((l) => l.startsWith('Фаза 5 — собираю куски')), ruLines.join('\n'));
  assert.ok(ruLines.includes('  Куски: слито 1 из 4 · собираются 1 · ждут вас 1'));
  assert.ok(ruLines.some((l) => l.startsWith('    05-02 · собирается · ')));
  const red = viewOf(buildLaneProject({ red: { after: '05-01' } }));
  assert.ok(formatView(red).split('\n').includes('  Slices: 1 of 4 merged · 1 building · 1 waits for you · tests red, fixing'));
  assert.deepEqual(buildRows(red.lanes[0].build, 'ru')[0], 'Куски: слито 1 из 4 · собираются 1 · ждут вас 1 · тесты красные, чиню');
  // a step of its own session (review): what it does now, under the lane line
  const review = viewOf(buildLaneProject({ step: 'review' }));
  assert.ok(formatView(review).split('\n').includes('  Now: reading src/a.js · 3m'), formatView(review));
  for (const v of [base, ru, red, review]) assert.equal(formatView(v), pane.paneLines(pane.render(v)).join('\n'), v.ui.lang);
});

test('the band names the build step', async () => {
  const pane = await import('../mod/hooks/view-model.mjs');
  assert.match(pane.bandLine(viewOf(buildLaneProject())), /phase 5: building slices/);
});

test('the word tables match the steps and the slice states', async () => {
  const pane = await import('../mod/hooks/view-model.mjs');
  for (const words of [WORDS, pane.WORDS]) {
    for (const lang of ['en', 'ru']) {
      assert.deepEqual(Object.keys(words[lang].buildStep), [...BUILD_STEPS]);
      assert.deepEqual(Object.keys(words[lang].sliceState), [...SLICE_STATES]);
    }
  }
});
