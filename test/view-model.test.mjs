import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BACKGROUND_MS, NO_FIELD, PANE_ID, afterAnswer, ancestorDirs, answerArgv, bandLine, clean, cut, diffViews, firstLine, isWindowsPath, joinPath, keepDraft, nodeCandidates, openField, parseView, refreshMs, render, shouldAutoOpen, textWidth, toastsFor, turboRunPath } from '../mod/hooks/view-model.mjs';

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
  assert.equal(cut('é'.repeat(6), 4), 'ééé…', 'a combining mark stays on its letter');
  const long = render(view({ questions: [{ id: 'q1', phase: '32', plan: '32-09', task: '3', question: 'Ж'.repeat(500), options: [{ label: 'x'.repeat(90) }], state: 'open' }], commits: [{ sha: 'a1b2c3d', subject: `fix: ${'😀'.repeat(200)}` }] }));
  const q = long.rows.find((r) => r.kind === 'question');
  assert.equal(Array.from(q.text).length, '    32-09 Task 3 · '.length + 160);
  assert.equal(Array.from(q.options[0].label).length, 40);
  const subject = long.rows.at(-1).text;
  assert.ok(Array.from(subject).every((ch) => ch.codePointAt(0) < 0xd800 || ch.codePointAt(0) > 0xdfff), 'no lone surrogate');
});

test('textWidth counts terminal cells, so agent columns stay aligned with wide text and emoji', () => {
  for (const [s, w] of [['ab', 2], ['Ж', 1], ['日本', 4], ['ＡＢ', 4], ['한', 2], ['👍', 2], ['👍🏽', 2], ['👨‍👩‍👧', 2], ['🇺🇸', 2], ['❤️', 2], ['⚠', 1], ['é', 1], ['…·▸—', 4]]) assert.equal(textWidth(s), w, s);
  const agents = [agent({ action: { tool: 'Edit', detail: '日本語のファイル名がとても長いです.mjs' } }), agent({ agentId: 'a2', plan: '32-08', action: { tool: 'Bash', detail: '👨‍👩‍👧 npm test 🇺🇸' } }), agent({ agentId: 'a3', type: 'gsd-エグゼキュータ', plan: '32-09' })];
  const rows = render(view({}, { agents })).rows.slice(2, 5).map((r) => r.text);
  assert.deepEqual(rows.map((t) => textWidth(t.slice(0, t.indexOf('6m · ')))), [54, 54, 54], rows.join('\n'));
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

test('no drawn string carries an escape or a bidi override: rows, buttons, band and toasts (OSC 52 would rewrite the clipboard every read)', () => {
  const v = view({ range: { from: `32${EVIL}`, to: '34' }, questions: [{ id: 'q1', phase: `32${EVIL}`, plan: `32-09${EVIL}`, task: `3${EVIL}`, header: `H${EVIL}`, question: `Deploy?${EVIL}`, options: [{ label: `Yes${EVIL}` }], state: 'open' }], commits: [{ sha: `a1b2c3d${EVIL}`, subject: `fix: ${EVIL}` }] }, { phase: `32${EVIL}`, step: `execute${EVIL}`, status: `needs-owner${EVIL}`, reason: `checkpoint${EVIL}`, push: { outcome: 'pushed', sha: `b2c3d4e${EVIL}`, ci: 'red' }, agents: [agent({ type: `gsd${EVIL}`, plan: `32-07${EVIL}`, task: `2${EVIL}`, action: { tool: `Bash${EVIL}`, detail: `rm${EVIL}` } }), agent({ agentId: 'a9', type: `v${EVIL}`, state: `odd${EVIL}` })] });
  const drawn = render(v).rows.flatMap((r) => (r.kind === 'text' ? [r.text] : [r.text, ...(r.choices ?? []), ...r.options.map((o) => o.label)]));
  for (const s of [...drawn, bandLine(v), ...toastsFor(view({ questions: [] }, { status: 'running', push: null }), v)]) assert.ok(!UNSAFE.test(s), JSON.stringify(s));
  assert.ok(drawn.some((s) => s.includes('fix: redevilx2J')));
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

test('toasts diff against the last-seen lanes: a lane the same supervisor cleared is done, a lane that arrives stopped or done says so, each once', () => {
  const v1 = view();
  // the supervisor clears a lane without halting only when its phase is done (it then takes the next phase or finishes)
  const moved = view({}, { phase: '33', status: 'running', push: null });
  assert.deepEqual(toastsFor(v1, moved), ['phase 32 done']);
  assert.deepEqual(toastsFor(v1, view({ supervisor: { running: false, pid: null, finished: true, halted: false }, lanes: [] })), ['phase 32 done']);
  assert.deepEqual(toastsFor(v1, view({ supervisor: { ...v1.supervisor, pid: 5151 } }, { phase: '40', push: null })), [], 'a new supervisor (another start): phase 32 did not finish');
  assert.deepEqual(toastsFor(v1, view({ supervisor: { ...v1.supervisor, running: false, halted: true }, lanes: [] })), ['supervisor halted']);
  assert.deepEqual(toastsFor(view({}, { status: 'done' }), moved), [], 'a lane seen done had its toast');
  assert.deepEqual(toastsFor(view({}, { status: 'needs-owner' }), moved), ['phase 32 done'], 'a lane last seen stopped that the supervisor cleared finished meanwhile');
  assert.deepEqual(toastsFor(v1, view({}, { phase: '33', status: 'needs-owner', reason: 'checkpoint 33-01', push: null })), ['phase 32 done', 'phase 33 stopped: needs-owner — checkpoint 33-01']);
  assert.deepEqual(toastsFor(v1, view({}, { phase: '33', status: 'done', step: null, push: null })), ['phase 32 done', 'phase 33 done']);
  assert.deepEqual(toastsFor(v1, view({}, { phase: '33', status: 'failed', push: { outcome: 'pushed', sha: 'c3d4e5f', ci: 'red' } })), ['phase 32 done', 'phase 33 stopped: failed', 'CI red: phase 33, c3d4e5f']);
  // the memory carries over reads: a cleared lane toasts once, and one that comes back is compared with what was last seen of it
  let d = diffViews(null, v1, {});
  assert.deepEqual(d.toasts, []);
  d = diffViews(v1, moved, d.seen);
  assert.deepEqual(d.toasts, ['phase 32 done']);
  d = diffViews(moved, moved, d.seen);
  assert.deepEqual(d.toasts, []);
  const red = view({}, { push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } });
  d = diffViews(null, red, {});
  d = diffViews(red, view({ supervisor: { ...v1.supervisor, pid: 5151 } }, { phase: '40', push: null }), d.seen);
  assert.deepEqual(d.toasts, []);
  d = diffViews(view({ supervisor: { ...v1.supervisor, pid: 5151 } }, { phase: '40', push: null }), view({ supervisor: { ...v1.supervisor, pid: 5151 } }, { status: 'needs-owner', push: { outcome: 'pushed', sha: 'b2c3d4e', ci: 'red' } }), d.seen);
  assert.deepEqual(d.toasts, ['phase 40 done', 'phase 32 stopped: needs-owner'], 'the red run of phase 32 was toasted before it left');
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
  assert.deepEqual(answerArgv({ node: '/usr/bin/node', turboRun: '/h/turbo-run.mjs', question, option: 2 }), ['/usr/bin/node', '/h/turbo-run.mjs', 'answer', '32', 'q1', '--option', '2', '--by', 'pane', '--rev', '2']);
  const text = '--by telegram "x"; $(rm -rf /) да 👍';
  assert.deepEqual(answerArgv({ node: '/usr/bin/node', turboRun: '/h/turbo-run.mjs', question, text }), ['/usr/bin/node', '/h/turbo-run.mjs', 'answer', '32', 'q1', '--text', text, '--by', 'pane', '--rev', '2']);
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
