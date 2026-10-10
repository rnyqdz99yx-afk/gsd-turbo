import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_MS, NO_FIELD, PANE_ID, afterAnswer, ancestorDirs, answerArgv, bandLine, cut, firstLine, joinPath, keepDraft, openField, parseView, refreshMs, render, shouldAutoOpen, toastsFor, turboRunPath } from '../mod/hooks/view-model.mjs';

const AT = '2026-01-01T11:00:00.000Z';
const agent = (over) => ({ agentId: 'a1', type: 'gsd-executor', description: '', plan: '32-07', task: '2', model: 'opus', worktreeBranch: null, state: 'running', action: { tool: 'Edit', detail: 'lib/x.mjs' }, startedAt: '2026-01-01T10:54:00.000Z', lastAt: '2026-01-01T10:59:50.000Z', elapsedMs: 360000, tokens: 166000, sessionId: 's', transcript: 't', ...over });
// The S0 contract's example (docs/plans/2026-10-10-stage-3-s0-transcripts.md) plus the keys S3 adds: lane push, ui.
function view(over = {}, lane = {}) {
  return {
    v: 1,
    at: AT,
    supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: '2026-01-01T10:59:40.000Z' },
    range: { from: '32', to: '34' },
    lanes: [{
      phase: '32', step: 'execute', done: [], notes: {}, status: 'running', reason: '', sessionId: '1a2b3c4d', mode: 'full', launchedAt: '2026-01-01T09:48:00.000Z', elapsedMs: 72 * 60000, transcript: null, lastAt: AT, quiet: false,
      agents: [
        agent(),
        agent({ agentId: 'a2', plan: '32-08', task: null, action: { tool: 'Bash', detail: 'node --test test/view-model.test.mjs' }, elapsedMs: 120000, tokens: 41000 }),
        agent({ agentId: 'a3', type: 'gsd-verifier', plan: null, task: null, state: 'quiet', lastAt: '2026-01-01T10:44:00.000Z', tokens: null }),
        agent({ agentId: 'a4', plan: '32-06', task: null, state: 'completed', elapsedMs: 45000, tokens: 950 }),
      ],
      push: { outcome: 'pushed', sha: 'a1b2c3d', at: AT, ci: 'green' },
      ...lane,
    }],
    questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: 'Deploy after green CI?', options: [{ label: 'Yes, by the gate' }, { label: 'Stop' }], allowOther: true, state: 'open', rev: 1 }],
    commits: [{ sha: 'a1b2c3d', subject: 'fix: lane record keeps the reason' }, { sha: 'd4e5f6a', subject: 'test: quiet agents' }],
    ui: { lang: 'en', refreshSeconds: 3 },
    ...over,
  };
}
const texts = (model) => model.rows.map((r) => (r.kind === 'text' ? r.text : `${r.text} [${r.options.map((o) => o.label).join('] [')}]${r.other ? ` [${r.otherLabel}]` : ''}`));

test('render draws the spec §7 tree: supervisor, lane → step → subagents, questions with their buttons, commits', () => {
  assert.deepEqual(texts(render(view())), [
    'turbo · phases 32–34 · supervisor running',
    '▸ p32  execute  · 1h 12m · lane running',
    '    gsd-executor  32-07 Task 2  Edit lib/x.mjs        6m · 166k',
    '    gsd-executor  32-08         Bash node --test tes… 2m · 41k',
    '    gsd-verifier  —             quiet 16m             ⚠',
    '    gsd-executor  32-06         completed             45s · 950',
    '? 1 question',
    '    32-09 Task 3 · Deploy after green CI? [Yes, by the gate] [Stop] [Other…]',
    'commits:',
    '  a1b2c3d fix: lane record keeps the reason',
    '  d4e5f6a test: quiet agents',
  ]);
  const tones = render(view()).rows.filter((r) => r.kind === 'text').map((r) => r.tone);
  assert.deepEqual(tones, ['title', 'normal', 'normal', 'normal', 'warn', 'dim', 'warn', 'dim', 'dim', 'dim']);
});

test('render in Russian follows lang: durations, quiet, plurals and the Other button', () => {
  const lines = texts(render(view({ ui: { lang: 'ru', refreshSeconds: 3 } })));
  assert.equal(lines[0], 'turbo · фазы 32–34 · супервизор работает');
  assert.equal(lines[1], '▸ p32  execute  · 1 ч 12 мин · лейн running');
  assert.equal(lines[4], '    gsd-verifier  —             тихо 16 мин           ⚠');
  assert.equal(lines[5], '    gsd-executor  32-06         готов                 45 с · 950');
  assert.equal(lines[6], '? 1 вопрос');
  assert.match(lines[7], /\[Другое…\]$/);
  assert.equal(lines[8], 'коммиты:');
});

test('question rows carry the phase, the id, the rev drawn, 1-based option numbers and unique control keys', () => {
  const [q] = render(view()).rows.filter((r) => r.kind === 'question');
  assert.deepEqual([q.phase, q.id, q.rev, q.other], ['32', 'q1', 1, true]);
  assert.equal(render(view({ questions: [{ ...view().questions[0], rev: 3 }] })).rows.find((r) => r.kind === 'question').rev, 3);
  assert.deepEqual(q.options, [{ key: 'q:q1:1', label: 'Yes, by the gate', option: 1 }, { key: 'q:q1:2', label: 'Stop', option: 2 }]);
  assert.deepEqual([q.otherKey, q.inputKey, q.inputLabel, q.submitLabel], ['q:q1:other', 'q:q1:text', 'Answer', 'send']);
  const noOther = render(view({ questions: [{ id: 'q9', phase: '7', question: 'Plug in the device', options: [{ label: 'I will when asked' }], allowOther: false, state: 'open' }] })).rows.find((r) => r.kind === 'question');
  assert.equal(noOther.other, false);
  assert.equal(noOther.rev, 1, 'a question without a rev is drawn as rev 1, where S1 starts');
  assert.equal(noOther.text, '    — · Plug in the device');
});

test('render shows the lane reason, more than three finished agents as a count, and a stopped lane in the warn tone', () => {
  const done = Array.from({ length: 5 }, (_, i) => agent({ agentId: `d${i}`, plan: `32-0${i}`, state: 'completed' }));
  const rows = render(view({}, { status: 'needs-owner', reason: 'checkpoint 32-09 Task 3', agents: done })).rows;
  assert.deepEqual(rows.slice(1, 3).map((r) => [r.text, r.tone]), [['▸ p32  execute  · 1h 12m · lane needs-owner', 'warn'], ['    reason: checkpoint 32-09 Task 3', 'warn']]);
  assert.equal(rows.filter((r) => r.text?.includes('completed')).length, 3);
  assert.equal(rows[6].text, '    + 2 more');
});

test('render without a supervisor, without the S3 keys (an S0-only view), before the first read and after a failed read', () => {
  const bare = { v: 1, at: AT, supervisor: null, range: null, lanes: [], questions: [], commits: [] };
  assert.deepEqual(texts(render(bare)), ['turbo · supervisor never started']);
  assert.deepEqual(texts(render(null)), ['reading the run…']);
  const failed = render(view(), { error: 'invalid turbo config /p/.planning/turbo/config.json: Unexpected end of JSON input' });
  assert.deepEqual(failed.rows[0], { kind: 'text', text: '⚠ turbo-run view failed: invalid turbo config /p/.planning/turbo/config.json: Unexpected end of JSON input', tone: 'error' });
  assert.equal(failed.rows[1].text, 'turbo · phases 32–34 · supervisor running', 'the last good view stays below the error');
  assert.deepEqual(texts(render(null, { error: 'node: not found' })), ['⚠ turbo-run view failed: node: not found']);
});

test('long and multi-code-point text is cut by code points with an ellipsis, never splitting an emoji (Review Focus 4)', () => {
  assert.equal(cut('a'.repeat(10), 5), 'aaaa…');
  assert.equal(cut('👍'.repeat(10), 3), '👍👍…');
  assert.equal(cut('line one\n  line two', 100), 'line one line two');
  const long = render(view({ questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', question: 'Ж'.repeat(500), options: [{ label: 'x'.repeat(90) }], state: 'open' }], commits: [{ sha: 'a1b2c3d', subject: `fix: ${'😀'.repeat(200)}` }] }));
  const q = long.rows.find((r) => r.kind === 'question');
  assert.equal(Array.from(q.text).length, '    32-09 Task 3 · '.length + 160);
  assert.equal(Array.from(q.options[0].label).length, 40);
  const subject = long.rows.at(-1).text;
  assert.ok(Array.from(subject).every((ch) => ch.codePointAt(0) < 0xd800 || ch.codePointAt(0) > 0xdfff), 'no lone surrogate');
});

test('bandLine is the spec §7 line, names a stopped supervisor or lane, and is absent where turbo never ran (Review Focus 1)', () => {
  assert.equal(bandLine(view()), 'turbo p32 execute · 3 agents · ? 1 question · CI ✓');
  assert.equal(bandLine(view({ ui: { lang: 'ru', refreshSeconds: 3 } })), 'turbo p32 execute · 3 агента · ? 1 вопрос · CI ✓');
  assert.equal(bandLine(view({ supervisor: { running: false, halted: true } }, { status: 'needs-owner', agents: [], push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' } })), 'turbo p32 execute (needs-owner) · supervisor halted · ? 1 question · CI ✗');
  assert.equal(bandLine(view({}, { push: { outcome: 'refused', sha: null, ci: null } })), 'turbo p32 execute · 3 agents · ? 1 question · push ✗');
  assert.equal(bandLine(view({}, { push: null })), 'turbo p32 execute · 3 agents · ? 1 question');
  assert.equal(bandLine({ v: 1, at: AT, supervisor: null, range: null, lanes: [], questions: [], commits: [] }), null);
  assert.equal(bandLine(null), null);
  assert.equal(bandLine(view(), { error: 'invalid turbo config x: y' }), 'turbo · ⚠ invalid turbo config x: y');
});

test('toastsFor: nothing on the first view; a new question, phase done, red CI, a stopped lane and a halt once each', () => {
  const v1 = view();
  assert.deepEqual(toastsFor(null, v1), []);
  assert.deepEqual(toastsFor(v1, view()), []);
  const q2 = { id: 'q2', phase: '32', plan: '32-10', task: '1', question: 'Looks right?', options: [], state: 'open' };
  assert.deepEqual(toastsFor(v1, view({ questions: [...v1.questions, q2] })), ['new question: 32-10 Task 1 — Looks right?']);
  assert.deepEqual(toastsFor(v1, view({ questions: [q2, { ...q2, id: 'q3' }] })), ['2 new questions']);
  assert.deepEqual(toastsFor(v1, view({}, { status: 'done' })), ['phase 32 done']);
  const red = view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } });
  assert.deepEqual(toastsFor(v1, red), ['CI red: phase 32, b2c3d4e']);
  assert.deepEqual(toastsFor(red, view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } })), [], 'the same red run toasts once');
  assert.deepEqual(toastsFor(v1, view({}, { status: 'needs-owner', reason: 'checkpoint 32-09' })), ['phase 32 stopped: needs-owner — checkpoint 32-09']);
  assert.deepEqual(toastsFor(v1, view({ supervisor: { ...v1.supervisor, running: false, halted: true } })), ['supervisor halted']);
  assert.deepEqual(toastsFor(view({ ui: { lang: 'ru', refreshSeconds: 3 } }), view({ ui: { lang: 'ru', refreshSeconds: 3 } }, { status: 'done' })), ['фаза 32 готова']);
});

test('parseView accepts v1 and rejects other output with one line (Review Focus 1)', () => {
  assert.deepEqual(parseView(JSON.stringify(view())), view());
  assert.throws(() => parseView('Error: boom\n    at x'), { message: 'turbo-run view --json printed no JSON' });
  assert.throws(() => parseView('{"v":1}'), { message: 'turbo-run view --json printed an object this mod cannot read' });
  assert.throws(() => parseView(JSON.stringify(view({ v: 2 }))), { message: 'turbo-run view --json is v2; this mod reads v1: run node install.mjs again' });
});

test('refreshMs: view.refresh_seconds in the foreground (1–60, else 3), at least 15 s in the background (Review Focus 5)', () => {
  assert.equal(refreshMs(view(), true), 3000);
  assert.equal(refreshMs(view({ ui: { lang: 'en', refreshSeconds: 10 } }), true), 10000);
  assert.equal(refreshMs(view({ ui: { lang: 'en', refreshSeconds: 0 } }), true), 3000);
  assert.equal(refreshMs(null, true), 3000);
  assert.equal(refreshMs(view(), false), BACKGROUND_MS);
  assert.equal(refreshMs(view({ ui: { lang: 'en', refreshSeconds: 30 } }), false), 30000);
});

test('the pane opens by itself only while the supervisor runs or a question is open', () => {
  assert.equal(shouldAutoOpen(view()), true);
  assert.equal(shouldAutoOpen(view({ supervisor: { running: false }, questions: [] })), false);
  assert.equal(shouldAutoOpen(view({ supervisor: null })), true);
  assert.equal(shouldAutoOpen(null), false);
  assert.equal(PANE_ID, 'turbo-view');
});

test('answerArgv passes the option number or the free text as one argument, whatever it holds, and always the drawn rev (Review Focus 2)', () => {
  const question = { phase: '32', id: 'q1', rev: 2 };
  assert.deepEqual(answerArgv({ turboRun: '/h/turbo-run.mjs', question, option: 2 }), ['node', '/h/turbo-run.mjs', 'answer', '32', 'q1', '--option', '2', '--by', 'pane', '--rev', '2']);
  const text = '--by telegram "x"; $(rm -rf /) да 👍';
  assert.deepEqual(answerArgv({ turboRun: '/h/turbo-run.mjs', question, text }), ['node', '/h/turbo-run.mjs', 'answer', '32', 'q1', '--text', text, '--by', 'pane', '--rev', '2']);
});

test('the Other… field after an answer: 0 and 3 close it and drop the draft, 4 closes it and keeps the draft, 1 and 2 leave both; a draft dies with its question (Review Focus 3)', () => {
  const typing = { inputFor: 'q1', draft: 'go on', draftFor: 'q1' };
  assert.deepEqual(openField(NO_FIELD, 'q1'), { inputFor: 'q1', draft: '', draftFor: 'q1' });
  for (const code of [0, 3]) assert.deepEqual(afterAnswer(typing, 'q1', code), NO_FIELD, String(code));
  const changed = afterAnswer(typing, 'q1', 4);
  assert.deepEqual(changed, { inputFor: null, draft: 'go on', draftFor: 'q1' });
  assert.deepEqual(openField(changed, 'q1'), typing, 'reopened with the kept text');
  assert.deepEqual(openField(changed, 'q2'), { inputFor: 'q2', draft: '', draftFor: 'q2' });
  for (const code of [1, 2]) assert.deepEqual(afterAnswer(typing, 'q1', code), typing, String(code));
  assert.deepEqual(afterAnswer(typing, 'q2', 0), typing, 'an answer to another question leaves the field alone');
  assert.equal(keepDraft(changed, view()), changed);
  assert.deepEqual(keepDraft(changed, view({ questions: [] })), NO_FIELD);
  assert.deepEqual(keepDraft(typing, view({ questions: [] })), NO_FIELD);
});

test('paths: ancestors on Windows and POSIX, the turbo-run location from CLAUDE_CONFIG_DIR or the home directory', () => {
  assert.deepEqual(ancestorDirs('C:\\Users\\dev\\app'), ['C:/Users/dev/app', 'C:/Users/dev', 'C:/Users', 'C:/']);
  assert.deepEqual(ancestorDirs('/home/dev/app/'), ['/home/dev/app', '/home/dev', '/home', '/']);
  assert.equal(joinPath('C:/', '.planning'), 'C:/.planning');
  assert.equal(joinPath('/', '.planning', 'turbo'), '/.planning/turbo');
  assert.equal(turboRunPath({ configDir: 'D:\\cfg\\' }), 'D:\\cfg/turbo/bin/turbo-run.mjs');
  assert.equal(turboRunPath({ home: '/home/dev' }), '/home/dev/.claude/turbo/bin/turbo-run.mjs');
  assert.equal(turboRunPath({ bin: '/tmp/fake.mjs', home: '/home/dev' }), '/tmp/fake.mjs');
  assert.equal(turboRunPath({}), null);
  assert.equal(firstLine('\n  invalid turbo config x\n    at y'), 'invalid turbo config x');
});
