import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BACKGROUND_MS, NO_FIELD, PANE_ID, TONES, WORDS, afterAnswer, ancestorDirs, answerArgv, answerToast, bandLine, bandStyle, clean, clockText, cut, errorWords, notSentToast, turboDir, viewArgv, diffViews, firstLine, isWindowsPath, joinPath, keepDraft, nodeCandidates, openField, paneLines, parseView, refreshMs, render, shouldAutoOpen, spanText, textWidth, toastsFor, turboRunPath, verdict } from '../mod/hooks/view-model.mjs';

const AT = '2026-01-01T11:00:00.000Z';
const agent = (over) => ({ agentId: 'a1', type: 'gsd-executor', description: '', plan: '32-07', task: '2', model: 'opus', worktreeBranch: null, state: 'running', action: { tool: 'Edit', detail: 'lib/x.mjs' }, startedAt: '2026-01-01T10:54:00.000Z', lastAt: '2026-01-01T10:59:50.000Z', elapsedMs: 360000, tokens: 166000, sessionId: 's', transcript: 't', ...over });
// The S0 contract's example (docs/plans/2026-10-10-stage-3-s0-transcripts.md) plus the keys S3 and later add: lane
// push, plans and ci, commit times, ui.
function view(over = {}, lane = {}) {
  return {
    v: 1,
    at: AT,
    supervisor: { running: true, pid: 4242, finished: false, halted: false, failingSince: null, updatedAt: '2026-01-01T10:59:40.000Z' },
    range: { from: '32', to: '34' },
    lanes: [{
      phase: '32', step: 'execute', done: [], notes: {}, status: 'running', reason: '', sessionId: '1a2b3c4d', mode: 'full', launchedAt: '2026-01-01T09:48:00.000Z', elapsedMs: 72 * 60000, transcript: null, lastAt: '2026-01-01T10:59:40.000Z', quiet: false,
      agents: [
        agent(),
        agent({ agentId: 'a2', plan: '32-08', task: null, action: { tool: 'Bash', detail: 'node --test test/view-model.test.mjs' }, elapsedMs: 120000, tokens: 41000 }),
        agent({ agentId: 'a3', type: 'gsd-verifier', plan: null, task: null, state: 'quiet', lastAt: '2026-01-01T10:44:00.000Z', tokens: null }),
        agent({ agentId: 'a4', plan: '32-06', task: null, state: 'completed', elapsedMs: 45000, tokens: 950 }),
      ],
      push: { outcome: 'pushed', sha: 'a1b2c3d', at: AT, ci: 'green' },
      plans: { done: 5, total: 9 },
      ci: { fixes: 0, rounds: 2 },
      ...lane,
    }],
    questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', kind: 'decision', header: 'Deploy', question: 'Deploy after green CI?', options: [{ label: 'Yes, by the gate' }, { label: 'Stop' }], allowOther: true, state: 'open', rev: 1 }],
    commits: [{ sha: 'a1b2c3d', at: '2026-01-01T10:48:00.000Z', subject: 'fix: lane record keeps the reason' }, { sha: 'd4e5f6a', at: '2026-01-01T08:00:00.000Z', subject: 'test: quiet agents' }],
    ui: { lang: 'en', refreshSeconds: 3 },
    ...over,
  };
}
const RU = { ui: { lang: 'ru', refreshSeconds: 3 } };
// a run with nothing to report: no question, no silent helper
const calm = (over = {}, lane = {}) => view({ questions: [], ...over }, { agents: [agent()], ...lane });
// what `turbo-run stop` (and attend) leave: the lane kept, the pid gone, the lane record still `running`
const STOPPED_SUP = { running: false, pid: null, finished: false, halted: false, failingSince: null };
// Every node of a pane tree, depth first; the first Text node whose text starts with a prefix.
const nodes = (n) => (typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(nodes)]);
const textNode = (tree, prefix) => nodes(tree).find((n) => n.type === 'Text' && spanText(n).startsWith(prefix));
const controls = (tree) => nodes(tree).filter((n) => n.type === 'Button' || n.type === 'Input');
const lines = (v, opts) => paneLines(render(v, opts));
// the first helper row (the sign of life comes before the helpers)
const helperRow = (v, opts) => lines(v, opts).find((l) => /^ {2}\S/.test(l) && !/last activity|последнее действие/.test(l));

test('render draws the run in plain words, in sections a blank line apart: verdict line with progress, sign of life, helpers, questions as cards, latest changes with their age, supervisor', () => {
  assert.deepEqual(lines(view()), [
    'Phase 32 — running plans · 5 of 9 plans done · 1h 12m · needs your answer (1)',
    '  last activity 10s ago',
    '  Executor · plan 32-07, task 2 · editing lib/x.mjs · 6m',
    '  Executor · plan 32-08 · running tests · 2m',
    '  ⚠️ Verifier silent for 16m — may be stuck',
    '  1 more helper finished',
    '',
    'Needs your answer (1):',
    '│ you can answer ahead — the phase is not waiting',
    '│ Deploy after green CI? (plan 32-09, task 3)',
    '│   [1. Yes, by the gate]  [2. Stop]',
    '│   [Your own answer…]',
    '',
    'Latest changes:',
    '  fix: lane record keeps the reason · 12m ago',
    '  test: quiet agents · 3h 0m ago',
    '',
    'Supervisor running · phases 32–34',
  ]);
});

test('render in Russian is Russian throughout, no English but paths, commands and commit subjects', () => {
  const ru = view({ ...RU, questions: [{ ...view().questions[0], question: 'Деплой фазы 32 после зелёного CI?', options: [{ label: 'Да, по гейту' }, { label: 'Стоп' }] }], commits: [{ sha: 'a1b2c3d', at: '2026-01-01T10:59:30.000Z', subject: 'исправлено: причина остановки сохраняется' }, { sha: 'b2c3d4e', at: '2025-12-29T09:00:00.000Z', subject: 'тесты: экспорт пустого чата' }] });
  assert.deepEqual(lines(ru), [
    'Фаза 32 — выполняются планы · 5 из 9 планов готово · 1 ч 12 мин · нужен ваш ответ (1)',
    '  последнее действие 10 с назад',
    '  Исполнитель · план 32-07, задача 2 · правит lib/x.mjs · 6 мин',
    '  Исполнитель · план 32-08 · запустил тесты · 2 мин',
    '  ⚠️ Проверяющий молчит 16 мин — возможно, завис',
    '  ещё 1 помощник закончил',
    '',
    'Нужен ваш ответ (1):',
    '│ можно ответить заранее — фаза не стоит',
    '│ Деплой фазы 32 после зелёного CI? (план 32-09, задача 3)',
    '│   [1. Да, по гейту]  [2. Стоп]',
    '│   [Свой ответ…]',
    '',
    'Последние изменения:',
    '  исправлено: причина остановки сохраняется · только что',
    '  тесты: экспорт пустого чата · 3 дн назад',
    '',
    'Супервизор работает · фазы 32–34',
  ]);
  // the only Latin left: the file path and CI in the owner's own question
  assert.doesNotMatch(lines(ru).join('\n').replace('lib/x.mjs', '').replace('CI?', ''), /[A-Za-z]/);
  assert.doesNotMatch(bandLine(ru).replace(/^turbo/, '').replace('CI', ''), /[A-Za-z]/);
  assert.equal(lines(view(RU, { agents: [agent(), agent({ state: 'completed' }), agent({ state: 'completed' })] }))[3], '  ещё 2 помощника закончили');
  assert.equal(lines(view(RU, { agents: [agent({ state: 'completed' }), agent({ state: 'failed' })] }))[2], '  2 помощника закончили', 'no "ещё" without a helper at work');
});

test('the pane is coloured by state with real element props: verdict, sign of life, silent helper, headings, the question cards and the recommended option', () => {
  const tree = render(view({ questions: [{ ...view().questions[0], options: [{ label: 'Yes, by the gate', recommended: true }, { label: 'Stop' }] }] }));
  const head = textNode(tree, 'Phase 32');
  assert.deepEqual(head.props, { wrap: 'wrap' }, 'the verdict line wraps rather than lose its verdict');
  assert.deepEqual(head.children[0], { type: 'Text', props: { bold: true }, children: ['Phase 32'] }, 'the phase in bold');
  assert.deepEqual(head.children.at(-1), { type: 'Text', props: { color: 'warning', bold: true }, children: ['needs your answer (1)'] }, 'the verdict in its colour');
  assert.deepEqual(head.children[2], { type: 'Text', props: { dimColor: true }, children: [' · 5 of 9 plans done · 1h 12m'] }, 'progress and time dim');
  assert.equal(textNode(tree, 'last activity').props.dimColor, true);
  assert.equal(textNode(tree, '⚠️ Verifier').props.color, 'warning');
  assert.equal(textNode(tree, '1 more helper').props.dimColor, true);
  const running = textNode(tree, 'Executor · plan 32-07');
  assert.deepEqual(running.children.filter((c) => c.props?.dimColor).map(spanText), [' · plan 32-07, task 2', ' · 6m'], 'plan ids and times dim');
  assert.deepEqual(textNode(tree, 'Needs your answer').props, { color: 'warning', bold: true });
  assert.deepEqual(textNode(tree, 'Latest changes').props, { bold: true });
  assert.equal(textNode(tree, 'fix: lane record').children[1].props.dimColor, true, 'the age of a commit dim');
  const card = nodes(tree).find((n) => n.props?.borderStyle);
  assert.deepEqual(card.props, { flexDirection: 'column', borderStyle: 'round', borderColor: 'warning', paddingX: 1 }, 'each question its own bordered card');
  assert.equal(textNode(card, 'you can answer ahead').props.dimColor, true);
  const ask = textNode(card, 'Deploy after green CI?');
  assert.deepEqual([ask.props.bold, ask.children[1].props], [true, { dimColor: true }], 'the question bold, where it comes from dim');
  const [optionsRow, otherRow] = card.children.slice(-2);
  assert.deepEqual(optionsRow.props, { flexDirection: 'row', columnGap: 2, flexWrap: 'wrap', paddingLeft: 2 }, 'option buttons on their own indented row');
  assert.deepEqual([otherRow.props, otherRow.children.map((c) => c.props.key)], [{ flexDirection: 'row', paddingLeft: 2 }, ['q:q1:other']], 'Other… on a row of its own');
  assert.deepEqual(controls(tree).map((c) => [c.props.label, c.props.variant]), [['1. Yes, by the gate ★', 'primary'], ['2. Stop', undefined], ['Your own answer…', undefined]]);
  assert.equal(textNode(tree, 'Supervisor running').props.dimColor, true);
  assert.deepEqual(TONES, { ok: { color: 'success' }, warn: { color: 'warning' }, bad: { color: 'error' }, dim: { dimColor: true }, plain: {} }, 'theme keys: the colours follow the theme');
});

test('the question the phase waits at comes first, in a red card that says so; the others can be answered ahead', () => {
  const ahead = view().questions[0];
  const held = { ...ahead, id: 'q2', plan: '32-10', task: '1', question: 'Does the export page look right?', stopped: true };
  const tree = render(view({ questions: [ahead, held] }, { status: 'needs-owner', reason: 'owner question 32-10-t1' }));
  const cards = nodes(tree).filter((n) => n.props?.borderStyle);
  assert.deepEqual(cards.map((c) => [spanText(c.children[0]), c.props.borderColor]), [['The phase waits for this answer', 'error'], ['you can answer ahead', 'warning']], 'a stopped phase: "not waiting" would be untrue');
  assert.deepEqual(textNode(cards[0], 'The phase waits').props, { color: 'error', bold: true });
  assert.equal(spanText(cards[0].children[1]), 'Does the export page look right? (plan 32-10, task 1)');
  assert.equal(spanText(render(view(RU, {}), {}).children[1].children[1].children[0]), 'можно ответить заранее — фаза не стоит');
});

test('one verdict, first match, that says whether the owner has to step in: the supervisor first, then the phase, CI, questions, silence', () => {
  const offset = { ui: { lang: 'en', refreshSeconds: 3, utcOffsetMinutes: 420 } };
  const cases = [
    [calm(), 'fine', 'success', 'all fine'],
    [view(), 'answer', 'warning', 'needs your answer (1)'],
    [calm({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 1, rounds: 2 } }), 'ciFixing', 'warning', 'CI red — the phase fixes it itself (attempt 1 of 2), nothing needed from you'],
    [calm({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 0, rounds: 2 } }), 'ciFixing', 'warning', 'CI red — the phase fixes it itself (attempt 1 of 2), nothing needed from you'],
    [calm({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 3, rounds: 2 } }), 'ciRed', 'error', 'CI red — needs your answer'],
    [calm({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 0, rounds: 0 } }), 'ciRed', 'error', 'CI red — needs your answer'],
    [calm({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: undefined }), 'ciRed', 'error', 'CI red — needs your answer'],
    [view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } }), 'answer', 'warning', 'needs your answer (1)'],
    [view({}, { status: 'needs-owner', reason: 'owner question 32-09-t3' }), 'needsOwner', 'error', 'stopped — waits for your answer'],
    [calm({}, { status: 'needs-owner', reason: 'a live check' }), 'needsOwner', 'error', 'stopped — waits for your decision'],
    [view({}, { status: 'failed' }), 'failed', 'error', 'stopped by a failure'],
    [view({ supervisor: { running: false, halted: true } }), 'halted', 'error', 'supervisor stopped'],
    [calm({ ...offset, supervisor: { ...view().supervisor, failingSince: '2026-01-01T01:10:00.000Z' } }), 'failing', 'error', 'supervisor failing since 08:10'],
    [calm({ supervisor: STOPPED_SUP, attended: ['32'] }), 'attended', 'warning', 'phase 32 is in your session — new phases wait'],
    [calm({}, { quiet: true, lastAt: '2026-01-01T10:40:00.000Z' }), 'quiet', 'warning', 'silent for 20m — may be stuck'],
    [calm({}, { agents: [agent(), agent({ agentId: 'a3', type: 'gsd-verifier', state: 'quiet', lastAt: '2026-01-01T10:44:00.000Z' })] }), 'quietHelper', 'warning', 'running, but ⚠️ Verifier silent for 16m'],
    [calm({}, { agents: [agent({ state: 'quiet', lastAt: '2026-01-01T10:50:00.000Z' }), agent({ agentId: 'a3', type: 'gsd-verifier', state: 'quiet', lastAt: '2026-01-01T10:44:00.000Z' })] }), 'quietHelper', 'warning', 'running, but ⚠️ Verifier silent for 16m (and 1 more)'],
    [calm({}, { status: 'done', step: null }), 'done', 'success', 'done'],
    [calm({}, { status: 'paused-context' }), 'paused', 'warning', 'paused: needs a fresh context'],
    [calm({ supervisor: { running: false, finished: true }, lanes: [] }), 'finished', 'success', 'all phases done'],
    [calm({ supervisor: STOPPED_SUP }), 'supStopped', 'warning', 'supervisor not running'],
    [calm({ supervisor: STOPPED_SUP }, { quiet: true, lastAt: '2026-01-01T07:00:00.000Z' }), 'supStopped', 'warning', 'supervisor not running'],
    [calm({ supervisor: null, lanes: [] }), 'never', undefined, 'supervisor never started'],
  ];
  for (const [v, kind, color, words] of cases) {
    const got = verdict(v);
    assert.deepEqual([got.kind, got.text], [kind, words], kind);
    const line = render(v).children[0].children[0];
    // a running phase ends its line with the verdict; one that is not running starts with it (`Phase 32 done`)
    const said = line.children.find((c) => typeof c !== 'string' && spanText(c).endsWith(words));
    assert.equal(said?.props.color, color, kind);
    assert.equal(said.props.bold, true, kind);
    assert.equal(bandStyle(v).color, color, `${kind}: the band takes the verdict's colour`);
  }
  // a red CI the verdict does not speak of is said under it: amber while the phase fixes it, red when it needs the owner
  const fixingUnder = render(view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 1, rounds: 2 } }));
  assert.deepEqual(textNode(fixingUnder, 'CI red').props, { color: 'warning', wrap: 'wrap' });
  assert.equal(paneLines(fixingUnder)[2], '  CI red — the phase fixes it itself (attempt 1 of 2), nothing needed from you');
  assert.equal(textNode(render(view({}, { status: 'needs-owner', push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } })), 'CI red').props.color, 'error');
  assert.equal(paneLines(render(calm({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 1, rounds: 2 } }))).filter((l) => l.includes('CI red')).length, 1, 'said once: the verdict says it');
  assert.equal(verdict(view(RU, { status: 'needs-owner' })).text, 'остановилась — ждёт вашего ответа');
  assert.equal(verdict(calm(RU, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 2, rounds: 2 } })).text, 'CI красный — фаза чинит сама (попытка 2 из 2), от вас ничего не нужно');
  assert.equal(verdict(calm(RU, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, status: 'needs-owner' })).text, 'остановилась — ждёт вашего решения', 'stopped on red CI: the phase waits, red');
  assert.equal(verdict(calm({ ...RU, supervisor: STOPPED_SUP, attended: ['32'] })).text, 'фаза 32 у вас в сессии — новые фазы ждут');
  assert.deepEqual(lines(calm({ supervisor: { running: false, finished: true }, lanes: [] }, {})).slice(0, 1), ['Run — all phases done']);
  assert.deepEqual(lines(calm({ ...RU, supervisor: null, lanes: [], commits: [] })), ['Прогон — супервизор не запускался']);
  assert.deepEqual(bandStyle(view(), { error: 'x' }), { color: 'error' });
});

test('a supervisor that does not run never leaves a phase "running": the step as a fact, the time frozen, nobody called stuck (review M1, M2)', () => {
  // turbo-run stop: the lane stays in supervisor.json with its record `running`; 5 h later it is not "running" nor "stuck"
  const stopped = (at, elapsedMs, over = {}, lane = {}) => calm({ ...RU, at, supervisor: STOPPED_SUP, ...over }, { quiet: true, lastAt: '2026-01-01T10:59:40.000Z', elapsedMs, agents: [agent({ state: 'quiet' })], ...lane });
  const later = lines(stopped('2026-01-01T15:00:00.000Z', 5 * 3600000));
  assert.deepEqual(later.slice(0, 3), [
    'Фаза 32 остановлена на шаге: выполнение планов · 5 из 9 планов готово · 1 ч 11 мин · супервизор не работает',
    '  последнее действие 4 ч 0 мин назад',
    '  Исполнитель · план 32-07, задача 2 · тишина 4 ч 0 мин',
  ]);
  assert.equal(lines(stopped('2026-01-02T15:00:00.000Z', 29 * 3600000))[0], later[0], 'the time does not keep growing');
  assert.doesNotMatch(later.join('\n'), /идёт|завис|тишина 4 ч 0 мин —/);
  assert.equal(bandLine(stopped('2026-01-01T15:00:00.000Z', 5 * 3600000)), 'turbo · фаза 32 остановлена · супервизор не работает · CI ✓');
  // halted after an inferred failure: the same, red
  const halted = stopped(AT, 72 * 60000, { supervisor: { ...STOPPED_SUP, halted: true } });
  assert.equal(lines(halted)[0], 'Фаза 32 остановлена на шаге: выполнение планов · 5 из 9 планов готово · 1 ч 11 мин · супервизор остановился');
  assert.equal(bandStyle(halted).color, 'error');
  // a lane paused for its context outlives a supervisor that went down: never green "restarting"
  const paused = stopped(AT, 72 * 60000, {}, { status: 'paused-context', quiet: false });
  assert.equal(lines(paused)[0], 'Фаза 32 на паузе: нужен новый контекст · шаг: выполнение планов · 5 из 9 планов готово · 1 ч 11 мин · супервизор не работает');
  assert.equal(bandLine(paused), 'turbo · фаза 32 на паузе: нужен новый контекст · супервизор не работает · CI ✓');
  assert.equal(bandStyle(paused).color, 'warning');
  const pausedHalted = stopped(AT, 72 * 60000, { supervisor: { ...STOPPED_SUP, halted: true } }, { status: 'paused-context', quiet: false });
  assert.match(lines(pausedHalted)[0], /на паузе: нужен новый контекст .* супервизор остановился$/);
  const pauseLine = textNode(render(pausedHalted), 'Фаза 32');
  assert.deepEqual([pauseLine.children[0].props.color, pauseLine.children.at(-1).props.color], ['warning', 'error'], 'the pause amber, beside the red verdict');
});

test('a phase that is not running says what happened first, in its colour; where it was, dim; the reason under it in red', () => {
  const tree = render(view({ questions: [] }, { status: 'needs-owner', reason: 'checkpoint 32-09 Task 3', agents: [agent({ state: 'completed' })] }));
  assert.deepEqual(paneLines(tree).slice(0, 4), [
    'Phase 32 stopped — waits for your decision · step: plan execution · 5 of 9 plans done · 1h 11m',
    '  last activity 10s ago',
    '  Reason: checkpoint 32-09 Task 3',
    '  1 helper finished',
  ]);
  assert.equal(textNode(tree, 'Reason').props.color, 'error');
  const head = textNode(tree, 'Phase 32');
  assert.deepEqual(head.children.map((c) => [spanText(c), c.props]), [['Phase 32 stopped — waits for your decision', { color: 'error', bold: true }], [' · step: plan execution · 5 of 9 plans done · 1h 11m', { dimColor: true }]]);
  assert.equal(lines(view(RU, { status: 'needs-owner', reason: '' }))[0], 'Фаза 32 остановилась — ждёт вашего ответа · шаг: выполнение планов · 5 из 9 планов готово · 1 ч 11 мин');
  assert.equal(lines(view(RU, { status: 'paused-context', step: 'uat' }))[0], 'Фаза 32 на паузе: нужен новый контекст · шаг: приёмка · 5 из 9 планов готово · 1 ч 11 мин · нужен ваш ответ (1)');
  assert.equal(lines(view({ supervisor: { running: false, halted: true } }, { status: 'failed' }))[0], 'Phase 32 stopped by a failure · step: plan execution · 5 of 9 plans done · 1h 11m · supervisor stopped');
  assert.equal(lines(view(RU, { step: null, status: 'done' }))[0], 'Фаза 32 готова · 5 из 9 планов готово · заняла 1 ч 11 мин · нужен ваш ответ (1)');
  assert.equal(lines(view(RU, { plans: null }))[0], 'Фаза 32 — выполняются планы · 1 ч 12 мин · нужен ваш ответ (1)', 'no plans yet: no count');
});

test("a phase stopped for a question: the reason loses /turbo-phase's `owner question <plan>-t<task>` and keeps what follows; other reasons stay whole", () => {
  const stopped = (reason) => view({}, { status: 'needs-owner', reason, agents: [] });
  assert.deepEqual(lines(stopped('owner question 32-09-t3')).slice(1, 3), ['  last activity 20s ago', '']);
  assert.deepEqual(toastsFor(view(), stopped('owner question 32-09-t3')), ['Phase 32 stopped — needs your answer']);
  const locked = 'owner question 32-09-t3: app.exe holds release/app.exe; quit the app';
  assert.equal(lines(stopped(locked))[2], '  Reason: app.exe holds release/app.exe; quit the app');
  assert.deepEqual(toastsFor(view(RU), view(RU, { status: 'needs-owner', reason: locked })), ['Фаза 32 остановилась — нужен ваш ответ: app.exe holds release/app.exe; quit the app']);
  for (const reason of ['tests fail after 3 fix rounds', 'owner question is unclear', 'owner questions everywhere']) assert.equal(lines(stopped(reason))[2], `  Reason: ${reason}`, reason);
});

test('every /turbo-phase step and the usual helper types are named in words in both languages; an unknown one shows as written', () => {
  const steps = ['freshness', 'discuss', 'prologue', 'plan', 'gates-off', 'execute', 'restore', 'fanout', 'fix', 'final-gate', 'uat', 'close', 'ci'];
  for (const lang of ['en', 'ru']) {
    assert.deepEqual(Object.keys(WORDS[lang].step), steps, lang);
    for (const s of steps) assert.ok(bandLine(view({ ui: { lang } }, { step: s })).includes(`: ${WORDS[lang].step[s]} 5/9`), `${lang} ${s}`);
  }
  assert.equal(WORDS.ru.step.fanout, 'проверки качества');
  assert.equal(WORDS.ru.step.uat, 'приёмка');
  assert.equal(lines(view(RU, { step: 'gates-off' }))[0].split(' · ')[0], 'Фаза 32 — подготовка к выполнению');
  assert.equal(lines(view({}, { step: 'odd-step' }))[0].split(' · ')[0], 'Phase 32 — odd-step');
  assert.equal(lines(view(RU, { step: null }))[0], 'Фаза 32 — все шаги пройдены · 5 из 9 планов готово · 1 ч 12 мин · нужен ваш ответ (1)');
  const types = { 'gsd-executor': 'Исполнитель', 'gsd-verifier': 'Проверяющий', 'gsd-code-reviewer': 'Ревьюер', 'gsd-planner': 'Планировщик', 'gsd-plan-checker': 'Контролёр плана', 'gsd-security-auditor': 'Аудитор безопасности', 'gsd-nyquist-auditor': 'Аудитор тестов', 'turbo-uat': 'Приёмщик', 'general-purpose': 'Помощник', 'my-agent': 'my-agent' };
  for (const [type, word] of Object.entries(types)) assert.equal(helperRow(view(RU, { agents: [agent({ type, plan: null })] })), `  ${word} · правит lib/x.mjs · 6 мин`, type);
  assert.equal(helperRow(view({}, { agents: [agent({ type: null, plan: null })] })), '  Helper · editing lib/x.mjs · 6m');
  assert.deepEqual(Object.keys(WORDS.en.agent), Object.keys(WORDS.ru.agent));
});

test("a helper's last tool call reads as what it does: editing, writing, reading, searching, running tests, committing, a command, a helper, a skill", () => {
  const doing = (action, lang = 'ru') => helperRow(view({ ui: { lang } }, { agents: [agent({ plan: null, action })] })).replace(/^ {2}\S+ · /, '').replace(/ · \S+( \S+)?$/, '');
  const cases = [
    [{ tool: 'Edit', detail: 'lib/export.mjs' }, 'правит lib/export.mjs', 'editing lib/export.mjs'],
    [{ tool: 'MultiEdit', detail: 'a.mjs' }, 'правит a.mjs', 'editing a.mjs'],
    [{ tool: 'Write', detail: 'test/new.test.mjs' }, 'создаёт test/new.test.mjs', 'writing test/new.test.mjs'],
    [{ tool: 'Read', detail: 'README.md' }, 'читает README.md', 'reading README.md'],
    [{ tool: 'Grep', detail: 'function\\s+x' }, 'ищет в коде', 'searching the code'],
    [{ tool: 'Glob', detail: '**/*.mjs' }, 'ищет файлы', 'looking for files'],
    [{ tool: 'Bash', detail: 'node --test test/export.test.mjs' }, 'запустил тесты', 'running tests'],
    [{ tool: 'Bash', detail: 'cd backend && npm test' }, 'запустил тесты', 'running tests'],
    [{ tool: 'Bash', detail: 'npx vitest run src' }, 'запустил тесты', 'running tests'],
    [{ tool: 'Bash', detail: 'turbo-run test-changed' }, 'запустил тесты', 'running tests'],
    [{ tool: 'Bash', detail: 'git commit -m "feat: x"' }, 'делает коммит', 'committing'],
    [{ tool: 'Bash', detail: 'git status' }, 'выполняет команду: git status', 'running a command: git status'],
    [{ tool: 'Agent', detail: 'Execute plan 32-07' }, 'запустил помощника', 'started a helper'],
    [{ tool: 'Skill', detail: 'gsd-execute-phase' }, 'запустил навык', 'using a skill'],
    [{ tool: 'WebSearch', detail: 'x' }, 'ищет в интернете', 'searching the web'],
    [{ tool: 'TodoWrite', detail: '' }, 'обновляет список дел', 'updating its to-do list'],
    [{ tool: 'mcp__playwright__browser_click', detail: '' }, 'работает в браузере', 'using the browser'],
    [{ tool: 'Frobnicate', detail: 'x' }, 'Frobnicate x', 'Frobnicate x'],
    [null, 'работает', 'working'],
  ];
  for (const [action, ru, en] of cases) assert.deepEqual([doing(action), doing(action, 'en')], [ru, en], JSON.stringify(action));
  const long = doing({ tool: 'Bash', detail: `echo ${'x'.repeat(200)}` });
  assert.ok(textWidth(long) <= 'выполняет команду: '.length + 50, long);
});

test('the pane width cuts what a helper does, never its time (review nit: a 131-cell row lost its duration)', () => {
  const v = view(RU, { agents: [agent({ action: { tool: 'Bash', detail: `docker compose -f deploy/compose.prod.yml run --rm migrate ${'x'.repeat(80)}` } })] });
  const row = helperRow(v, { columns: 80 });
  assert.ok(row.endsWith(' · 6 мин'), row);
  assert.ok(textWidth(row) <= 80, `${textWidth(row)}: ${row}`);
  assert.match(row, /^ {2}Исполнитель · план 32-07, задача 2 · выполняет команду: docker comp\S*… · 6 мин$/);
  assert.ok(textWidth(helperRow(v)) > 80, 'no width known: cut only to the usual 50');
});

test('question cards: the press carries the phase, the id, the rev drawn and the 1-based option; keys stay unique per question', () => {
  const tree = render(view());
  const [one, two, other] = controls(tree);
  assert.deepEqual(one, { type: 'Button', props: { key: 'q:q1:1', label: '1. Yes, by the gate' }, press: { question: { id: 'q1', phase: '32', rev: 1 }, option: 1, label: 'Yes, by the gate' } });
  assert.deepEqual([two.props.key, two.press.option], ['q:q1:2', 2]);
  assert.deepEqual(other, { type: 'Button', props: { key: 'q:q1:other', label: 'Your own answer…' }, press: { question: { id: 'q1', phase: '32', rev: 1 }, other: true } });
  assert.equal(controls(render(view({ questions: [{ ...view().questions[0], rev: 3 }] })))[0].press.question.rev, 3);
  const noOther = render(view({ questions: [{ id: 'q9', phase: '7', question: 'Plug in the device', options: [{ label: 'I will when asked' }], allowOther: false, state: 'open' }] }));
  assert.deepEqual(controls(noOther).map((c) => c.props.label), ['1. I will when asked']);
  assert.equal(controls(noOther)[0].press.question.rev, 1, 'a question without a rev is drawn as rev 1, where S1 starts');
  assert.ok(paneLines(noOther).includes('│ Plug in the device (phase 7)'), 'no plan: the phase says where it comes from');
  assert.ok(paneLines(noOther).includes('│ you can answer ahead'), 'phase 7 does not run: no claim about it');
});

test('a long option is cut on its button with … and its number, and listed in full above the buttons; descriptions, the recommended one and the context are shown too', () => {
  // two long options that share their first 50 characters stay told apart: the owner never clicks blind
  const same = 'Deploy to production after the green CI run and then ';
  const q = { id: 'q5', phase: '32', plan: '32-09', task: '3', question: 'Which?', context: 'The deploy reaches every user; Stop leaves the phase waiting.', options: [{ label: `${same}notify`, recommended: true }, { label: `${same}wait`, description: 'nothing ships until you say so' }], state: 'open' };
  const tree = render(view({ questions: [q] }));
  const card = paneLines(tree).filter((l) => l.startsWith('│'));
  assert.deepEqual(card, [
    '│ you can answer ahead — the phase is not waiting',
    '│ Which? (plan 32-09, task 3)',
    '│ The deploy reaches every user; Stop leaves the phase waiting.',
    `│   1. ${same}notify ★ recommended`,
    `│   2. ${same}wait — nothing ships until you say so`,
    '│   [1. Deploy to production after th… ★]  [2. Deploy to production after th…]',
    '│   [Your own answer…]',
  ]);
  for (const c of controls(tree).slice(0, 2)) assert.ok(textWidth(c.props.label) <= 3 + 30 + 2, c.props.label);
  assert.equal(textNode(tree, 'The deploy').props.dimColor, true);
  assert.equal(textNode(tree, '1. Deploy').children[1].props.color, 'success');
  // short options and no descriptions: the buttons say it all, no list
  assert.equal(paneLines(render(view())).filter((l) => /^│ {3}\d\./.test(l)).length, 0);
});

test('the Other… field is drawn open, with what was typed, for the question it belongs to', () => {
  const typing = { inputFor: 'q1', draft: 'go on', draftFor: 'q1' };
  const field = controls(render(view(), { field: typing })).at(-1);
  assert.deepEqual(field, { type: 'Input', props: { key: 'q:q1:text', label: 'Your answer', placeholder: 'type and press Enter', value: 'go on', submitLabel: 'send', autoFocus: true }, input: { question: { id: 'q1', phase: '32', rev: 1 } } });
  assert.deepEqual(controls(render(view(RU), { field: typing })).at(-1).props.label, 'Ваш ответ');
  assert.equal(controls(render(view(), { field: { ...typing, inputFor: 'q7' } })).at(-1).props.key, 'q:q1:other');
});

test('render before the first read, after a failed read (the last good view below the error), and without a supervisor; the mod\'s own errors in the view\'s language', () => {
  const bare = { v: 1, at: AT, supervisor: null, range: null, lanes: [], questions: [], commits: [] };
  assert.deepEqual(lines(bare), ['Run — supervisor never started']);
  assert.deepEqual(lines(null), ['reading the run…']);
  const failed = render(view(), { error: 'invalid turbo config /p/.planning/turbo/config.json: Unexpected end of JSON input' });
  assert.deepEqual(failed.children[0], { type: 'Text', props: { color: 'error', wrap: 'truncate-end' }, children: ['⚠️ Could not read the run: invalid turbo config /p/.planning/turbo/config.json: Unexpected end of JSON input'] });
  assert.equal(paneLines(failed)[1], 'Phase 32 — running plans · 5 of 9 plans done · 1h 12m · needs your answer (1)', 'the last good view stays below the error');
  assert.deepEqual(lines(null, { error: 'node: not found' }), ['⚠️ Could not read the run: node: not found']);
  assert.deepEqual(lines(view(RU), { error: 'node not found in PATH' })[0], '⚠️ Не удалось прочитать прогон: node не найден в PATH');
  assert.equal(bandLine(view(RU), { error: 'turbo-run not found at /h/turbo/bin/turbo-run.mjs' }), 'turbo · ⚠️ turbo-run не найден: /h/turbo/bin/turbo-run.mjs');
  assert.equal(errorWords(view(RU), 'no .planning/turbo/ in this directory or above it'), 'ни здесь, ни выше нет .planning/turbo/');
  assert.equal(errorWords(view(RU), 'cannot find turbo-run: neither CLAUDE_CONFIG_DIR nor a home directory is set'), 'turbo-run не найден: не задан ни CLAUDE_CONFIG_DIR, ни домашний каталог');
  assert.equal(errorWords(view(RU), 'spawn EACCES'), 'spawn EACCES', 'an unknown error stays as it came');
  assert.equal(errorWords(view(), 'node not found in PATH'), 'node not found in PATH');
  assert.equal(notSentToast(view(RU), 'node not found in PATH'), 'Ответ не отправлен: node не найден в PATH');
});

test('long and multi-code-point text is cut by grapheme clusters to a cell width with an ellipsis, never splitting an emoji (Review Focus 4)', () => {
  assert.equal(cut('a'.repeat(10), 5), 'aaaa…');
  assert.equal(cut('👍'.repeat(10), 3), '👍…', 'an emoji takes two cells');
  assert.equal(cut('line one\n  line two', 100), 'line one line two');
  const family = '👨‍👩‍👧';
  assert.equal(cut(family.repeat(5), 5), `${family}${family}…`, 'a ZWJ sequence is one cluster of two cells');
  assert.equal(cut('🇺🇸🇩🇪🇫🇷', 4), '🇺🇸…', 'a flag is never cut into regional indicators');
  assert.equal(cut('👍🏽👍🏽👍🏽', 4), '👍🏽…', 'a skin tone stays on its emoji');
  assert.equal(cut('日本語テキスト', 6), '日本…', 'East Asian wide characters take two cells');
  assert.equal(cut('日本', 4), '日本');
  assert.equal(cut('é'.repeat(6), 4), 'ééé…', 'a combining mark stays on its letter');
  const long = render(view({ questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', question: 'Ж'.repeat(500), options: [{ label: 'x'.repeat(90) }], state: 'open' }], commits: [{ sha: 'a1b2c3d', subject: `fix: ${'😀'.repeat(200)}` }] }));
  assert.equal(Array.from(spanText(textNode(long, 'Ж'))).length, 300 + ' (plan 32-09, task 3)'.length, 'the question up to 300 characters (S1 QUESTION_MAX), wrapped by the pane');
  assert.equal(Array.from(paneLines(long).find((l) => l.startsWith('│   1. '))).length, '│   1. '.length + 80, 'an option label up to 80 (S1 LABEL_MAX) in the list');
  const subject = spanText(textNode(long, 'a1b2c3d'));
  assert.ok(Array.from(subject).every((ch) => ch.codePointAt(0) < 0xd800 || ch.codePointAt(0) > 0xdfff), 'no lone surrogate');
});

test('textWidth counts terminal cells, so wide text and emoji are cut by what the terminal draws', () => {
  for (const [s, w] of [['ab', 2], ['Ж', 1], ['日本', 4], ['ＡＢ', 4], ['한', 2], ['👍', 2], ['👍🏽', 2], ['👨‍👩‍👧', 2], ['🇺🇸', 2], ['❤️', 2], ['⚠', 1], ['⚠️', 2], ['é', 1], ['…·▸—', 4]]) assert.equal(textWidth(s), w, s);
  const row = helperRow(view({}, { agents: [agent({ plan: null, action: { tool: 'Edit', detail: `日本語のファイル名がとても長いです${'👨‍👩‍👧'.repeat(30)}.mjs` } })] }));
  const detail = row.slice('  Executor · editing '.length, row.lastIndexOf(' · '));
  assert.ok(textWidth(detail) <= 60 && detail.endsWith('…'), detail);
  assert.ok(Array.from(row).every((ch) => ch.codePointAt(0) < 0xd800 || ch.codePointAt(0) > 0xdfff), 'no lone surrogate');
});

// Repository data as an attacker would write it (built at run time): OSC 52 (clipboard), ESC[2J (clear), colors, a C1
// CSI, a carriage return, NUL and bidi overrides and isolates.
const E = String.fromCharCode(27);
const EVIL = `${E}]52;c;SGVsbG8=${String.fromCharCode(7)}${E}[2J${E}[31mred${E}[0m‮evil⁦x⁩\r${String.fromCharCode(0x9b)}2J\u0000`;
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

test('clean drops terminal escape sequences, control characters and bidi overrides', () => {
  assert.equal(clean(EVIL), 'redevilx2J');
  assert.equal(clean(`a${E}[31mb${E}[0mc`), 'abc');
  assert.equal(clean(`${E}]52;c;SGVsbG8=${E}\\ok`), 'ok', 'OSC ended by ST');
  assert.equal(clean(`${E}]0;title`), '', 'an unterminated OSC is dropped to its end');
  assert.equal(clean('a‮b⁧c'), 'abc');
  assert.equal(clean('tab\tand\nnewline stay; Ж 👍 日本'), 'tab\tand\nnewline stay; Ж 👍 日本');
});

test('no drawn string carries an escape or a bidi override: every text, label and prop, the band, the toasts and the answer toasts (OSC 52 would rewrite the clipboard every read)', () => {
  const v = view({ range: { from: `32${EVIL}`, to: '34' }, attended: [`32${EVIL}`], supervisor: { ...view().supervisor, failingSince: `x${EVIL}` }, questions: [{ id: 'q1', phase: `32${EVIL}`, plan: `32-09${EVIL}`, task: `3${EVIL}`, header: `H${EVIL}`, question: `Deploy?${EVIL}`, context: `ctx${EVIL}`, stopped: true, options: [{ label: `Yes${EVIL}`, description: `d${EVIL}`, recommended: true }, { label: `${'L'.repeat(40)}${EVIL}` }], state: 'open' }], commits: [{ sha: `a1b2c3d${EVIL}`, at: `x${EVIL}`, subject: `fix: ${EVIL}` }, { sha: 'b', at: '2026-01-01T10:00:00.000Z', subject: `feat: ${EVIL}` }] }, { phase: `32${EVIL}`, step: `execute${EVIL}`, status: `needs-owner${EVIL}`, reason: `checkpoint${EVIL}`, push: { outcome: 'pushed', sha: `b2c3d4e${EVIL}`, ci: 'red' }, agents: [agent({ type: `gsd${EVIL}`, plan: `32-07${EVIL}`, task: `2${EVIL}`, action: { tool: `Bash${EVIL}`, detail: `rm${EVIL}` } }), agent({ agentId: 'a9', type: `v${EVIL}`, state: `odd${EVIL}` }), agent({ agentId: 'a8', state: 'quiet', type: `q${EVIL}` })] });
  const strings = (n) => (typeof n === 'string' ? [n] : [...Object.values(n.props ?? {}).filter((x) => typeof x === 'string'), ...(n.children ?? []).flatMap(strings)]);
  const drawn = [...strings(render(v)), ...strings(render(v, { columns: 60 })), ...strings(render({ ...v, attended: [] }))];
  const answers = [
    answerToast(v, { code: 0, stdout: `answered q1: x, pane, 2026-01-01T10:00:00Z · not committed: ${EVIL}`, sent: `s${EVIL}`, nowMs: 0 }),
    answerToast(v, { code: 1, stdout: `refused: ${EVIL}` }),
    answerToast(v, { code: 3, stdout: `already answered: x${EVIL}, telegram, 2026-01-01T10:00:00Z` }),
  ];
  // review m2: the exit-3 case reaches the parse, through the escapes, the lone CR and the NUL
  assert.match(answers[2], /^Already answered \(in Telegram, \d\d:\d\d\): “x/, answers[2]);
  for (const s of [...drawn, ...paneLines(render(v)), bandLine(v), bandLine({ ...v, attended: [] }), ...toastsFor(view({ questions: [] }, { status: 'running', push: null }), v), ...answers]) assert.ok(!UNSAFE.test(s), JSON.stringify(s));
  assert.ok(drawn.some((s) => s.includes('fix: redevilx2J')));
});

test('bandLine is one line in words: each phase (running: step and plans done; otherwise what happened), the verdict, the questions waiting, CI; absent where turbo never ran (Review Focus 1)', () => {
  assert.equal(bandLine(view()), 'turbo · phase 32: running plans 5/9 · ❓ 1 question waits for you · CI ✓');
  assert.equal(bandLine(view(RU)), 'turbo · фаза 32: выполняются планы 5/9 · ❓ 1 вопрос ждёт вас · CI ✓');
  assert.equal(bandLine(view({ ...RU, questions: [view().questions[0], { ...view().questions[0], id: 'q2' }] })), 'turbo · фаза 32: выполняются планы 5/9 · ❓ 2 вопроса ждут вас · CI ✓');
  assert.equal(bandLine(calm(RU)), 'turbo · фаза 32: выполняются планы 5/9 · всё в порядке · CI ✓');
  assert.equal(bandLine(calm(RU, { plans: null })), 'turbo · фаза 32: выполняются планы · всё в порядке · CI ✓');
  assert.equal(bandLine(view({ supervisor: { running: false, halted: true } }, { status: 'needs-owner', agents: [], push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' } })), 'turbo · phase 32 stopped — waits for your answer · supervisor stopped · ❓ 1 question waits for you · CI ✗');
  // a phase that is not running says what happened, never its step beside "stopped"
  assert.equal(bandLine(view(RU, { status: 'needs-owner' })), 'turbo · фаза 32 остановилась — ждёт вашего ответа · ❓ 1 вопрос ждёт вас · CI ✓');
  assert.equal(bandLine(calm(RU, { status: 'done', step: null })), 'turbo · фаза 32 готова · CI ✓');
  assert.equal(bandLine(calm({}, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 1, rounds: 2 } })), 'turbo · phase 32: running plans 5/9 · CI red — the phase fixes it itself (attempt 1 of 2), nothing needed from you', 'CI red in words once');
  assert.equal(bandLine(calm({}, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 3, rounds: 2 } })), 'turbo · phase 32: running plans 5/9 · CI red — needs your answer');
  assert.equal(bandLine(view({}, { push: { outcome: 'refused', sha: null, ci: null } })), 'turbo · phase 32: running plans 5/9 · ❓ 1 question waits for you · push ✗');
  assert.equal(bandLine(view(RU, { push: { outcome: 'refused', sha: null, ci: null } })), 'turbo · фаза 32: выполняются планы 5/9 · ❓ 1 вопрос ждёт вас · отправка ✗');
  assert.equal(bandLine(view({}, { push: null })), 'turbo · phase 32: running plans 5/9 · ❓ 1 question waits for you');
  // S2 keeps the latest request apart from the last push: a refused request beside the last push's red CI shows both
  assert.equal(bandLine(view({}, { push: { outcome: 'refused', sha: 'a1b2c3d', ci: 'red' }, ci: { fixes: 9, rounds: 2 } })), 'turbo · phase 32: running plans 5/9 · CI red — needs your answer · ❓ 1 question waits for you · push ✗');
  assert.equal(bandLine(view({}, { push: { outcome: 'pushed', sha: 'a1b2c3d', ci: 'cancelled' } })), 'turbo · phase 32: running plans 5/9 · ❓ 1 question waits for you · CI ?');
  assert.equal(bandLine(calm({ supervisor: { running: false, finished: true }, lanes: [] })), 'turbo · all phases done');
  assert.equal(bandLine({ v: 1, at: AT, supervisor: null, range: null, lanes: [], questions: [], commits: [] }), null);
  assert.equal(bandLine(null), null);
  assert.equal(bandLine(view(), { error: 'invalid turbo config x: y' }), 'turbo · ⚠️ invalid turbo config x: y');
});

test('toastsFor: nothing on the first view; a new question, phase done, red CI (whether the phase fixes it), a stopped phase and a stopped supervisor once each, in words', () => {
  const v1 = view();
  assert.deepEqual(toastsFor(null, v1), []);
  assert.deepEqual(toastsFor(v1, view()), []);
  const q2 = { id: 'q2', phase: '32', plan: '32-10', task: '1', question: 'Looks right?', options: [], state: 'open' };
  assert.deepEqual(toastsFor(v1, view({ questions: [...v1.questions, q2] })), ['New question (phase 32): “Looks right?”']);
  assert.deepEqual(toastsFor(v1, view({ questions: [q2, { ...q2, id: 'q3' }] })), ['2 new questions']);
  assert.deepEqual(toastsFor(v1, view({}, { status: 'done' })), ['Phase 32 done']);
  const red = view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 0, rounds: 2 } });
  assert.deepEqual(toastsFor(v1, red), ['CI red: phase 32 — fixing it itself (attempt 1 of 2)']);
  assert.deepEqual(toastsFor(red, view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } })), [], 'the same red run toasts once');
  assert.deepEqual(toastsFor(v1, view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 2, rounds: 2 }, status: 'needs-owner' })), ['Phase 32 stopped — needs your answer', 'CI red: phase 32 — needs your answer']);
  assert.deepEqual(toastsFor(v1, view({}, { status: 'needs-owner', reason: 'checkpoint 32-09' })), ['Phase 32 stopped — needs your answer: checkpoint 32-09']);
  assert.deepEqual(toastsFor(v1, view({}, { status: 'failed' })), ['Phase 32 stopped by a failure']);
  assert.deepEqual(toastsFor(v1, view({ supervisor: { ...v1.supervisor, running: false, halted: true } })), ['The supervisor stopped']);
  const ru = (over, lane) => view({ ...RU, ...over }, lane);
  assert.deepEqual(toastsFor(ru(), ru({}, { status: 'done' })), ['Фаза 32 готова']);
  assert.deepEqual(toastsFor(ru(), ru({ questions: [...v1.questions, { ...q2, question: 'Страница выглядит верно?' }] })), ['Новый вопрос (фаза 32): «Страница выглядит верно?»']);
  assert.deepEqual(toastsFor(ru(), ru({}, { status: 'needs-owner' })), ['Фаза 32 остановилась — нужен ваш ответ']);
  assert.deepEqual(toastsFor(ru(), ru({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 1, rounds: 2 } })), ['CI красный: фаза 32 — чинит сама (попытка 1 из 2)']);
  assert.deepEqual(toastsFor(ru(), ru({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' }, ci: { fixes: 0, rounds: 0 } })), ['CI красный: фаза 32 — нужен ваш ответ']);
  assert.deepEqual(toastsFor(ru(), ru({ supervisor: { ...v1.supervisor, running: false, halted: true } })), ['Супервизор остановился']);
});

test('toasts diff against the last-seen lanes: a lane the same supervisor cleared is done, a lane that arrives stopped or done says so, each once', () => {
  const v1 = view();
  // the supervisor clears a lane without halting only when its phase is done (it then takes the next phase or finishes)
  const moved = view({}, { phase: '33', status: 'running', push: null });
  assert.deepEqual(toastsFor(v1, moved), ['Phase 32 done']);
  assert.deepEqual(toastsFor(v1, view({ supervisor: { running: false, pid: null, finished: true, halted: false }, lanes: [] })), ['Phase 32 done']);
  assert.deepEqual(toastsFor(v1, view({ supervisor: { ...v1.supervisor, pid: 5151 } }, { phase: '40', push: null })), [], 'a new supervisor (another start): phase 32 did not finish');
  assert.deepEqual(toastsFor(v1, view({ supervisor: { ...v1.supervisor, running: false, halted: true }, lanes: [] })), ['The supervisor stopped']);
  assert.deepEqual(toastsFor(view({}, { status: 'done' }), moved), [], 'a lane seen done had its toast');
  assert.deepEqual(toastsFor(view({}, { status: 'needs-owner' }), moved), ['Phase 32 done'], 'a lane last seen stopped that the supervisor cleared finished meanwhile');
  assert.deepEqual(toastsFor(v1, view({}, { phase: '33', status: 'needs-owner', reason: 'checkpoint 33-01', push: null })), ['Phase 32 done', 'Phase 33 stopped — needs your answer: checkpoint 33-01']);
  assert.deepEqual(toastsFor(v1, view({}, { phase: '33', status: 'done', step: null, push: null })), ['Phase 32 done', 'Phase 33 done']);
  assert.deepEqual(toastsFor(v1, view({}, { phase: '33', status: 'failed', push: { outcome: 'pushed', sha: 'c3d4e5f', ci: 'red' } })), ['Phase 32 done', 'Phase 33 stopped by a failure', 'CI red: phase 33 — needs your answer']);
  // the memory carries over reads: a cleared lane toasts once, and one that comes back is compared with what was last seen of it
  let d = diffViews(null, v1, {});
  assert.deepEqual(d.toasts, []);
  d = diffViews(v1, moved, d.seen);
  assert.deepEqual(d.toasts, ['Phase 32 done']);
  d = diffViews(moved, moved, d.seen);
  assert.deepEqual(d.toasts, []);
  const red = view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } });
  d = diffViews(null, red, {});
  d = diffViews(red, view({ supervisor: { ...v1.supervisor, pid: 5151 } }, { phase: '40', push: null }), d.seen);
  assert.deepEqual(d.toasts, []);
  d = diffViews(view({ supervisor: { ...v1.supervisor, pid: 5151 } }, { phase: '40', push: null }), view({ supervisor: { ...v1.supervisor, pid: 5151 } }, { status: 'needs-owner', push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } }), d.seen);
  assert.deepEqual(d.toasts, ['Phase 40 done', 'Phase 32 stopped — needs your answer'], 'the red run of phase 32 was toasted before it left');
});

test("the answer toast is built from turbo-run answer's exit code and what was sent: words, local HH:MM, no question id, no channel code", () => {
  // 08:18 in a zone 7 hours east of UTC; the view carries the owner's offset (lib/view.mjs ui.utcOffsetMinutes)
  const nowMs = Date.parse('2026-01-01T01:18:16.769Z');
  const en = view({ ui: { lang: 'en', refreshSeconds: 3, utcOffsetMinutes: 420 } });
  const ru = view({ ui: { lang: 'ru', refreshSeconds: 3, utcOffsetMinutes: 420 } });
  const stdout = (line) => `${line}\n`;
  assert.equal(answerToast(ru, { code: 0, stdout: stdout('answered q1: Стоп, pane, 2026-01-01T01:18:16.769Z · committed'), sent: 'Стоп', nowMs }), 'Ответ принят: «Стоп» · 08:18');
  assert.equal(answerToast(en, { code: 0, stdout: stdout('answered q1: Stop, pane, 2026-01-01T01:18:16.769Z'), sent: 'Stop', nowMs }), 'Answer recorded: “Stop” · 08:18');
  // review m6: an answer recorded but not committed says so
  assert.equal(answerToast(ru, { code: 0, stdout: stdout('answered q1: Стоп, pane, 2026-01-01T01:18:16.769Z · not committed: index.lock is held'), sent: 'Стоп', nowMs }), 'Ответ принят: «Стоп» · 08:18 · не сохранён в git: index.lock is held');
  assert.equal(answerToast(en, { code: 0, stdout: stdout('answered q1: go\non, pane, 2026-01-01T01:18:16.769Z · not committed: unknown reason'), sent: 'go\non', nowMs }), 'Answer recorded: “go on” · 08:18 · not committed to git: unknown reason');
  assert.equal(answerToast(ru, { code: 0, sent: `проверка 👍 ${'длинно '.repeat(20)}`, nowMs }).length <= 'Ответ принят: «» · 08:18'.length + 60, true, 'own words are cut');
  assert.equal(answerToast(ru, { code: 0, sent: 'Стоп' }), 'Ответ принят: «Стоп»', 'no time known: none shown');
  const already = stdout('already answered: Да, по гейту, telegram, 2026-01-01T01:15:00.000Z');
  assert.equal(answerToast(ru, { code: 3, stdout: already }), 'Уже отвечено (в Telegram, 08:15): «Да, по гейту»', 'an answer holding a comma stays whole');
  assert.equal(answerToast(en, { code: 3, stdout: stdout('already answered: Stop, session, 2026-01-01T01:15:00.000Z') }), 'Already answered (in a session, 08:15): “Stop”');
  assert.equal(answerToast(ru, { code: 3, stdout: stdout('already answered: Стоп, standing-rule, 2026-01-01T01:15:00.000Z') }), 'Уже отвечено (по постоянному правилу, 08:15): «Стоп»');
  assert.equal(answerToast(ru, { code: 3, stdout: stdout('already answered: unknown') }), 'Уже отвечено');
  // review m1: own words with a line break that reads like a channel and a time: the channel and time are the last ones
  assert.equal(answerToast(ru, { code: 3, stdout: stdout('already answered: ok, telegram, 1999-12-31T21:00:00Z\nrest, pane, 2026-01-01T01:15:00.000Z') }), 'Уже отвечено (в панели, 08:15): «ok, telegram, 1999-12-31T21:00:00Z rest»');
  const changed = 'changed: question q1 changed since it was shown (now rev 2, shown rev 1); read it again and answer the new version';
  assert.equal(answerToast(ru, { code: 4, stdout: stdout(changed) }), 'Вопрос изменился — панель показала новый, ответьте ещё раз');
  assert.equal(answerToast(en, { code: 4, stdout: stdout(changed) }), 'The question changed — the pane now shows the new one; answer again');
  const refusals = [
    ['refused: the answer looks like it contains a secret (GitHub token); nothing was recorded: rephrase it without the secret', 'Не принято: похоже, в ответе секрет — напишите без него', 'Not recorded: the answer looks like it holds a secret — say it without'],
    ['refused: the answer is longer than 2000 characters', 'Не принято: ответ длиннее 2000 символов', 'Not recorded: the answer is longer than 2000 characters'],
    ['refused: the answer is empty', 'Не принято: пустой ответ', 'Not recorded: the answer is empty'],
    ['refused: no question q1 in phase 32', 'Не принято: вопрос уже закрыт', 'Not recorded: the question is closed'],
    ['refused: question q1 has no option 5; its options are 1 to 2', 'Не принято: такого варианта нет', 'Not recorded: no such option'],
    ['refused: question q1 takes one of its options only, no own words', 'Не принято: этот вопрос принимает только варианты из списка', 'Not recorded: this question takes one of its options only'],
    ["refused: a lane never answers the owner's questions; the owner answers them (/turbo-autonomous answer, the turbo-view pane or Telegram)", 'Не принято: из сессии самой фазы отвечать нельзя', "Not recorded: a phase's own session cannot answer"],
  ];
  for (const [line, r, e] of refusals) assert.deepEqual([answerToast(ru, { code: 1, stdout: stdout(line) }), answerToast(en, { code: 1, stdout: stdout(line) })], [r, e], line);
  assert.equal(answerToast(ru, { code: 2, stdout: '', stderr: 'usage: answer …' }), 'Ответ не отправлен: turbo-run не принял команду (код 2)');
  assert.equal(answerToast(en, { code: 9 }), 'Answer not sent: turbo-run exited with 9');
  for (const code of [0, 3, 4]) {
    const s = answerToast(en, { code, stdout: code === 3 ? stdout('already answered: Stop, pane, 2026-01-01T01:15:00.000Z') : stdout('answered q1: Stop, pane, 2026-01-01T01:18:16.769Z'), sent: 'Stop', nowMs });
    assert.doesNotMatch(s, /\bq1\b|, pane\b|T\d\d:\d\d|Z\b/, s);
  }
});

test('clockText is HH:MM in the owner zone the view names, else the runtime zone; null for an unknown time', () => {
  const ms = Date.parse('2026-01-01T23:05:00.000Z');
  assert.equal(clockText(ms, 0), '23:05');
  assert.equal(clockText(ms, 180), '02:05');
  assert.equal(clockText(ms, -330), '17:35');
  const local = new Date(ms);
  assert.equal(clockText(ms), `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`);
  assert.equal(clockText(NaN, 0), null);
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

test('answerArgv names the project first, then the option number or, last, the free text as one argument whatever it holds, and always the drawn rev (Review Focus 2)', () => {
  const question = { phase: '32', id: 'q1', rev: 2 };
  const run = { node: '/usr/bin/node', turboRun: '/h/turbo/bin/turbo-run.mjs', root: '/work' };
  const head = ['/usr/bin/node', '/h/turbo/bin/turbo-run.mjs', 'answer', '--project', '/work', '32', 'q1'];
  assert.deepEqual(answerArgv({ ...run, question, option: 2 }), [...head, '--option', '2', '--by', 'pane', '--rev', '2']);
  // a text that reads like a flag comes after every real flag, so no parser takes it for --project, --by or --rev
  for (const text of ['--project', '--by', '--rev', '-x', '--by telegram "x"; $(rm -rf /) да 👍', 'a" --by telegram "b \\']) {
    assert.deepEqual(answerArgv({ ...run, question, text }), [...head, '--by', 'pane', '--rev', '2', '--text', text], text);
  }
  assert.deepEqual(viewArgv(run), ['/usr/bin/node', '/h/turbo/bin/turbo-run.mjs', 'view', '--project', '/work', '--json']);
});

test('turbo-run runs in its install directory, never in the project: a version manager pins nothing there', () => {
  assert.equal(turboDir('/home/dev/.claude/turbo/bin/turbo-run.mjs'), '/home/dev/.claude/turbo');
  assert.equal(turboDir('C:\\Users\\dev\\.claude/turbo/bin/turbo-run.mjs'), 'C:/Users/dev/.claude/turbo');
  assert.equal(turboDir('C:\\dev\\gsd-turbo\\scripts\\turbo-view-demo.mjs'), 'C:/dev/gsd-turbo');
  assert.equal(turboDir('/bin/x.mjs'), '/');
  assert.equal(turboDir('x.mjs'), null);
  // a config directory on a network share keeps its \\server\share prefix (as ancestorDirs does)
  assert.equal(turboDir('\\\\srv\\share\\cfg\\turbo\\bin\\turbo-run.mjs'), '//srv/share/cfg/turbo');
  assert.equal(turboDir('\\\\srv\\share\\cfg/turbo/bin/turbo-run.mjs'), '//srv/share/cfg/turbo');
  assert.equal(turboDir('\\\\srv\\share\\bin\\turbo-run.mjs'), '//srv/share');
  assert.equal(turboDir('\\\\?\\UNC\\srv\\share\\cfg\\turbo\\bin\\turbo-run.mjs'), '//srv/share/cfg/turbo');
  assert.equal(turboDir('\\\\?\\C:\\cfg\\turbo\\bin\\turbo-run.mjs'), 'C:/cfg/turbo');
  assert.equal(turboDir('\\\\srv\\bin\\turbo-run.mjs'), null, 'a server without a share is no directory');
});

test('node is looked for in absolute PATH directories only: a node.exe in the project (the child cwd) or under a relative entry never runs', () => {
  assert.deepEqual(nodeCandidates({ pathVar: '.;C:\\Program Files\\nodejs\\;"C:\\tools\\node";;relative\\bin;\\\\srv\\share\\bin;C:\\Program Files\\nodejs', windows: true }), ['C:\\Program Files\\nodejs/node.exe', 'C:\\tools\\node/node.exe', '\\\\srv\\share\\bin/node.exe']);
  assert.deepEqual(nodeCandidates({ pathVar: ':/usr/local/bin::.:bin:/usr/bin/', windows: false }), ['/usr/local/bin/node', '/usr/bin/node']);
  assert.deepEqual(nodeCandidates({ pathVar: undefined, windows: false }), []);
  for (const [p, w] of [['C:\\work', true], ['c:/work', true], ['//srv/share/work', true], ['/home/dev/work', false]]) assert.equal(isWindowsPath(p), w, p);
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
  // a network directory climbs to its share, never to the current drive's root
  assert.deepEqual(ancestorDirs('\\\\server\\share\\dev\\app'), ['//server/share/dev/app', '//server/share/dev', '//server/share']);
  assert.deepEqual(ancestorDirs('\\\\server\\share\\'), ['//server/share']);
  assert.deepEqual(ancestorDirs('//server/share/app'), ['//server/share/app', '//server/share']);
  assert.deepEqual(ancestorDirs('\\\\?\\UNC\\server\\share\\app'), ['//server/share/app', '//server/share']);
  assert.deepEqual(ancestorDirs('\\\\?\\C:\\dev\\app'), ['C:/dev/app', 'C:/dev', 'C:/']);
  assert.deepEqual(ancestorDirs('\\\\server'), [], 'a server without a share has nothing to climb');
  assert.equal(joinPath('C:/', '.planning'), 'C:/.planning');
  assert.equal(joinPath('/', '.planning', 'turbo'), '/.planning/turbo');
  assert.equal(turboRunPath({ configDir: 'D:\\cfg\\' }), 'D:\\cfg/turbo/bin/turbo-run.mjs');
  assert.equal(turboRunPath({ home: '/home/dev' }), '/home/dev/.claude/turbo/bin/turbo-run.mjs');
  assert.equal(turboRunPath({ bin: '/tmp/fake.mjs', home: '/home/dev' }), '/tmp/fake.mjs');
  assert.equal(turboRunPath({}), null);
  assert.equal(firstLine('\n  invalid turbo config x\n    at y'), 'invalid turbo config x');
});

test('the mod is a plugin whose hooks module loads in plain Node and registers its four hooks; its version follows package.json', async () => {
  const plugin = JSON.parse(fs.readFileSync('mod/.claude-plugin/plugin.json', 'utf8'));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.deepEqual([plugin.name, plugin.version], ['turbo-view', pkg.version]);
  assert.deepEqual(JSON.parse(fs.readFileSync('mod/hooks/hooks.json', 'utf8')), { modules: ['./register.mjs'] });
  const { register } = await import('../mod/hooks/register.mjs');
  const hooks = [];
  register((event, matcher) => {
    hooks.push([event, typeof matcher === 'function' ? null : matcher]);
    return { catch() {} };
  });
  assert.deepEqual(hooks, [['session.start', null], ['command.run', { command: 'turbo-view' }], ['ui.render', { component: 'AbovePrompt' }], ['ui.render', { component: 'Pane', requestId: PANE_ID }]]);
});

// The mod shell driven in plain Node through a fake $, for what the claude plugin test kit cannot stub: a $.clock.every
// that fails (mock.clock owns clock.every). Each call loads a fresh copy of the module (its state is module-level).
async function shell(name) {
  const { register } = await import(`../mod/hooks/register.mjs?${name}`);
  const hooks = {};
  register((event, a, b) => {
    hooks[typeof a === 'function' ? event : `${event}:${Object.values(a).join(':')}`] = typeof a === 'function' ? a : b;
    return { catch() {} };
  });
  const BIN = '/home/dev/.claude/turbo/bin/turbo-run.mjs';
  const timers = [];
  const runs = [];
  let starts = 0;
  const $ = {
    session: { cwd: async () => '/work', surfaces: async () => ['terminal'] },
    fs: { exists: async (p) => ['/work/.planning', '/work/.planning/turbo', BIN, '/usr/bin/node'].includes(p) },
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: '/home/dev/.claude', PATH: '/usr/bin' })[name] },
    process: { run: async (argv) => (runs.push(argv), { exitCode: 0, stdout: JSON.stringify(view()), stderr: '' }) },
    clock: {
      every: (ms, fn) => {
        if (++starts === 1) throw new Error('clock unavailable');
        const t = { ms, fn, cancelled: false, cancel: () => { t.cancelled = true; } };
        timers.push(t);
        return t;
      },
    },
    ui: { open: async () => ({ isPlaced: true }), toast() {}, log() {}, invalidate() {}, resolve: () => ({ Box: (p) => p, Text: (p) => p }) },
    command: { register: async () => {} },
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  await hooks['session.start']($, { isInteractive: true }, (e) => e);
  // the first band draw starts the reads (session.start alone spawns nothing)
  await hooks['ui.render:AbovePrompt']($, { component: 'AbovePrompt' }, async () => null);
  await settle();
  return { hooks, $, timers, runs, settle, live: () => timers.filter((t) => !t.cancelled) };
}

test('a clock that failed to start at the first read is started by the next band draw, and the view keeps reading', async () => {
  const s = await shell('band');
  assert.deepEqual([s.runs.length, s.timers.length], [1, 0], 'one read, no clock');
  await s.hooks['ui.render:AbovePrompt'](s.$, { component: 'AbovePrompt' }, async () => null);
  await s.settle();
  assert.deepEqual(s.live().map((t) => t.ms), [3000]);
  await s.live()[0].fn();
  await s.settle();
  assert.equal(s.runs.length, 2);
  await s.hooks['ui.render:AbovePrompt'](s.$, { component: 'AbovePrompt' }, async () => null);
  await s.settle();
  assert.equal(s.live().length, 1, 'never a second clock');
});

test('a clock that failed to start at the first read is started by /turbo-view', async () => {
  const s = await shell('command');
  assert.equal(s.timers.length, 0);
  assert.deepEqual(await s.hooks['command.run:turbo-view'](s.$, { command: 'turbo-view', args: '' }), {});
  await s.settle();
  assert.deepEqual(s.live().map((t) => t.ms), [3000]);
});
