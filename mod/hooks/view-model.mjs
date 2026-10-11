// The turbo-view mod's view model (spec §7): what the pane, the band above the prompt and the toasts show for one
// `turbo-run view --json` object (S0's contract, v 1), in plain words: a verdict first, then the phase, its helpers,
// the questions waiting for the owner and the latest commits. Pure functions without imports or host APIs: the mod's
// hooks module imports this file, and node --test runs it in CI (test/view-model.test.mjs).

export const PANE_ID = 'turbo-view';
export const PANE_TITLE = 'turbo';
// How often a session nobody looks at (no surface attached) reads the view, and how often the mod looks for
// .planning/turbo/ again outside a turbo project.
export const BACKGROUND_MS = 15000;
export const DEFAULT_REFRESH_SECONDS = 3;
// S1's limits on what a question holds: the question text and each option label
const QUESTION_MAX = 300;
const LABEL_MAX = 80;
// An option's text on its button: a longer one is cut there with … and listed in full above the buttons, so two long
// options never read alike on their buttons alone
const BUTTON_MAX = 30;
const CONTEXT_MAX = 200;
const ACTIVE = new Set(['running', 'quiet']);
const STOPPED = new Set(['needs-owner', 'failed']);
// S2's CI states; none and superseded show no mark, cancelled (nothing was tested) shows as unknown
const CI_MARK = { green: 'CI ✓', red: 'CI ✗', pending: 'CI …', timeout: 'CI ?', cancelled: 'CI ?' };
// The look of each tone: theme keys, so the colours follow the person's theme
export const TONES = Object.freeze({ ok: { color: 'success' }, warn: { color: 'warning' }, bad: { color: 'error' }, dim: { dimColor: true }, plain: {} });

const ruPlural = (n, one, few, many) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

// The /turbo-phase steps (lib/phase-progress.mjs STEPS, and ci) and the subagent types, in words; anything else is
// shown as written. lib/view.mjs keeps the same tables for turbo-run view and status --watch (test/view.test.mjs
// holds the two equal).
export const WORDS = {
  en: {
    step: { freshness: 'freshness check', discuss: 'discussion', prologue: 'planning prep', plan: 'planning', 'gates-off': 'execution prep', execute: 'running plans', restore: 'restoring settings', fanout: 'quality checks', fix: 'fixes', 'final-gate': 'final check', uat: 'acceptance', close: 'wrap-up', ci: 'CI check' },
    agent: { 'gsd-executor': 'Executor', 'gsd-verifier': 'Verifier', 'gsd-code-reviewer': 'Reviewer', 'gsd-code-fixer': 'Fixer', 'gsd-planner': 'Planner', 'gsd-plan-checker': 'Plan checker', 'gsd-phase-researcher': 'Researcher', 'gsd-security-auditor': 'Security auditor', 'gsd-nyquist-auditor': 'Test auditor', 'gsd-integration-checker': 'Integration checker', 'gsd-debugger': 'Debugger', 'turbo-uat': 'Acceptance tester', 'general-purpose': 'Helper', Explore: 'Scout' },
  },
  ru: {
    step: { freshness: 'проверка актуальности', discuss: 'обсуждение', prologue: 'подготовка к планированию', plan: 'планирование', 'gates-off': 'подготовка к выполнению', execute: 'выполняются планы', restore: 'восстановление настроек', fanout: 'проверки качества', fix: 'исправления', 'final-gate': 'финальная проверка', uat: 'приёмка', close: 'завершение', ci: 'проверка CI' },
    // all masculine, so «… молчит — возможно, завис» agrees with each
    agent: { 'gsd-executor': 'Исполнитель', 'gsd-verifier': 'Проверяющий', 'gsd-code-reviewer': 'Ревьюер', 'gsd-code-fixer': 'Исправляющий', 'gsd-planner': 'Планировщик', 'gsd-plan-checker': 'Контролёр плана', 'gsd-phase-researcher': 'Исследователь', 'gsd-security-auditor': 'Аудитор безопасности', 'gsd-nyquist-auditor': 'Аудитор тестов', 'gsd-integration-checker': 'Контролёр связей', 'gsd-debugger': 'Отладчик', 'turbo-uat': 'Приёмщик', 'general-purpose': 'Помощник', Explore: 'Разведчик' },
  },
};

// The words of the run (verdicts, steps, helpers, questions, commits, the supervisor): lib/view.mjs carries the same
// for turbo-run view and status --watch; test/view.test.mjs holds every one of them equal. The mod's own (controls,
// the band, toasts) follow in TEXT.
const VIEW_WORDS = {
  en: {
    ...WORDS.en,
    allDone: 'all steps done',
    phase: (p) => `Phase ${p}`,
    phaseOnly: (p) => `phase ${p}`,
    plan: (p, task) => `plan ${p}${task ? `, task ${task}` : ''}`,
    plans: (done, total) => `${done} of ${total} plans done`,
    run: 'Run',
    took: (d) => `took ${d}`,
    // a stopped phase names its step as a noun: `step: plan execution`
    stepAt: { execute: 'plan execution' },
    atStep: (s) => `step: ${s}`,
    stoppedAt: (s) => (s ? `stopped at step: ${s}` : 'stopped'),
    verdict: {
      fine: 'all fine', answer: (n) => `needs your answer (${n})`, ciRed: (asked) => (asked ? 'CI red — needs your answer' : 'CI red — needs your decision'), ciFixing: (n, m) => `CI red — the phase fixes it itself (attempt ${n} of ${m}), nothing needed from you`,
      ciLast: "CI red — the phase's last attempt; if it fails, it will ask you", fullMode: 'waits for you: its final checks need full mode',
      needsOwner: (asked) => (asked ? 'stopped — waits for your answer' : 'stopped — waits for your decision'), failed: 'stopped by a failure',
      quiet: (d) => `silent${d ? ` for ${d}` : ''} — may be stuck`, quietHelper: (who, d, more) => `running, but ⚠️ ${who} silent${d ? ` for ${d}` : ''}${more ? ` (and ${more} more)` : ''}`,
      paused: 'paused: needs a fresh context', done: 'done', halted: 'supervisor stopped', failing: (at) => `supervisor failing${at ? ` since ${at}` : ''}`,
      attended: (p) => `phase ${p} is in your session — new phases wait`, supStopped: 'supervisor not running', finished: 'all phases done', never: 'supervisor never started',
    },
    reason: 'Reason',
    life: (d) => `last activity ${d} ago`,
    doing: { edit: (x) => `editing ${x}`, write: (x) => `writing ${x}`, read: (x) => `reading ${x}`, search: 'searching the code', files: 'looking for files', tests: 'running tests', commit: 'committing', command: (x) => `running a command: ${x}`, helper: 'started a helper', skill: 'using a skill', web: 'searching the web', todo: 'updating its to-do list', message: 'messaging a helper', browser: 'using the browser', working: 'working' },
    state: { completed: 'done', stopped: 'stopped', failed: 'failed' },
    idle: (d) => `silent${d ? ` for ${d}` : ''}`,
    quietAgent: (who, d) => `⚠️ ${who} silent${d ? ` for ${d}` : ''} — may be stuck`,
    helpersDone: (n, more) => `${n} ${more ? 'more ' : ''}${n === 1 ? 'helper' : 'helpers'} finished`,
    askHead: (n) => `Needs your answer (${n}):`,
    holds: 'The phase waits for this answer',
    ahead: (running) => (running ? 'you can answer ahead — the phase is not waiting' : 'you can answer ahead'),
    recommended: 'recommended',
    changes: 'Latest changes:',
    ago: (d) => `${d} ago`,
    justNow: 'just now',
    days: (n) => `${n}d`,
    sup: { running: 'Supervisor running', stopped: 'Supervisor not running', finished: 'Supervisor finished', halted: 'Supervisor stopped', never: 'Supervisor never started' },
    phases: (from, to) => `phases ${from}–${to}`,
    duration: (h, m, s) => (h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`),
  },
  ru: {
    ...WORDS.ru,
    allDone: 'все шаги пройдены',
    phase: (p) => `Фаза ${p}`,
    phaseOnly: (p) => `фаза ${p}`,
    plan: (p, task) => `план ${p}${task ? `, задача ${task}` : ''}`,
    plans: (done, total) => `${done} из ${total} планов готово`,
    run: 'Прогон',
    took: (d) => `заняла ${d}`,
    stepAt: { execute: 'выполнение планов' },
    atStep: (s) => `шаг: ${s}`,
    stoppedAt: (s) => (s ? `остановлена на шаге: ${s}` : 'остановлена'),
    verdict: {
      fine: 'всё в порядке', answer: (n) => `нужен ваш ответ (${n})`, ciRed: (asked) => (asked ? 'CI красный — нужен ваш ответ' : 'CI красный — нужно ваше решение'), ciFixing: (n, m) => `CI красный — фаза чинит сама (попытка ${n} из ${m}), от вас ничего не нужно`,
      ciLast: 'CI красный — последняя попытка фазы; если не выйдет, она спросит вас', fullMode: 'ждёт вас: для финальных проверок нужен полный режим',
      needsOwner: (asked) => (asked ? 'остановилась — ждёт вашего ответа' : 'остановилась — ждёт вашего решения'), failed: 'остановилась из-за сбоя',
      quiet: (d) => `тишина${d ? ` ${d}` : ''} — возможно, зависла`, quietHelper: (who, d, more) => `идёт, но ⚠️ ${who} молчит${d ? ` ${d}` : ''}${more ? ` (и ещё ${more})` : ''}`,
      paused: 'на паузе: нужен новый контекст', done: 'готова', halted: 'супервизор остановился', failing: (at) => `супервизор сбоит${at ? ` с ${at}` : ''}`,
      attended: (p) => `фаза ${p} у вас в сессии — новые фазы ждут`, supStopped: 'супервизор не работает', finished: 'все фазы готовы', never: 'супервизор не запускался',
    },
    reason: 'Причина',
    life: (d) => `последнее действие ${d} назад`,
    doing: { edit: (x) => `правит ${x}`, write: (x) => `создаёт ${x}`, read: (x) => `читает ${x}`, search: 'ищет в коде', files: 'ищет файлы', tests: 'запустил тесты', commit: 'делает коммит', command: (x) => `выполняет команду: ${x}`, helper: 'запустил помощника', skill: 'запустил навык', web: 'ищет в интернете', todo: 'обновляет список дел', message: 'пишет помощнику', browser: 'работает в браузере', working: 'работает' },
    state: { completed: 'готов', stopped: 'остановлен', failed: 'сбой' },
    idle: (d) => `тишина${d ? ` ${d}` : ''}`,
    quietAgent: (who, d) => `⚠️ ${who} молчит${d ? ` ${d}` : ''} — возможно, завис`,
    helpersDone: (n, more) => `${more ? 'ещё ' : ''}${n} ${ruPlural(n, 'помощник закончил', 'помощника закончили', 'помощников закончили')}`,
    askHead: (n) => `Нужен ваш ответ (${n}):`,
    holds: 'Фаза ждёт этот ответ',
    ahead: (running) => (running ? 'можно ответить заранее — фаза не стоит' : 'можно ответить заранее'),
    recommended: 'рекомендуется',
    changes: 'Последние изменения:',
    ago: (d) => `${d} назад`,
    justNow: 'только что',
    days: (n) => `${n} дн`,
    sup: { running: 'Супервизор работает', stopped: 'Супервизор не работает', finished: 'Супервизор закончил', halted: 'Супервизор остановился', never: 'Супервизор не запускался' },
    phases: (from, to) => `фазы ${from}–${to}`,
    duration: (h, m, s) => (h ? `${h} ч ${m} мин` : m ? `${m} мин` : `${s} с`),
  },
};

export const TEXT = {
  en: {
    ...VIEW_WORDS.en,
    other: 'Your own answer…',
    answer: 'Your answer',
    answerHint: 'type and press Enter',
    send: 'send',
    loading: 'reading the run…',
    failed: 'Could not read the run',
    bandPhase: (p, step) => `phase ${p}: ${step}`,
    stoppedShort: 'stopped',
    waiting: (n) => `❓ ${n} ${n === 1 ? 'question waits' : 'questions wait'} for you`,
    pushFailed: 'push ✗',
    newQuestion: (p, q) => `New question (phase ${p}): “${q}”`,
    newQuestions: (n) => `${n} new questions`,
    phaseDone: (p) => `Phase ${p} done`,
    ciRed: (p, fix, asked) => `CI red: phase ${p} — ${fix ? (fix.last ? 'last attempt; if it fails, it will ask you' : `fixing it itself (attempt ${fix.n} of ${fix.m})`) : asked ? 'needs your answer' : 'needs your decision'}`,
    laneNeedsOwner: (p, why) => `Phase ${p} stopped — needs your answer${why ? `: ${why}` : ''}`,
    laneFailed: (p, why) => `Phase ${p} stopped by a failure${why ? `: ${why}` : ''}`,
    halted: 'The supervisor stopped',
    answered: (what, at, note) => `Answer recorded: “${what}”${at ? ` · ${at}` : ''}${note ? ` · not committed to git: ${note}` : ''}`,
    already: (what, how, at) => `Already answered${how || at ? ` (${[how, at].filter(Boolean).join(', ')})` : ''}${what ? `: “${what}”` : ''}`,
    channel: { session: 'in a session', pane: 'in the pane', telegram: 'in Telegram', 'standing-rule': 'by a standing rule' },
    changed: 'The question changed — the pane now shows the new one; answer again',
    refused: (why) => `Not recorded: ${why}`,
    refusal: { secret: 'the answer looks like it holds a secret — say it without', tooLong: (n) => `the answer is longer than ${n} characters`, empty: 'the answer is empty', gone: 'the question is closed', noOption: 'no such option', optionsOnly: 'this question takes one of its options only', lane: "a phase's own session cannot answer" },
    usage: 'Answer not sent: turbo-run did not take the call (exit 2)',
    exited: (code) => `Answer not sent: turbo-run exited with ${code}`,
    notSent: (why) => `Answer not sent: ${why}`,
    paneNotOpened: (why) => `turbo-view: pane not opened: ${why}`,
  },
  ru: {
    ...VIEW_WORDS.ru,
    other: 'Свой ответ…',
    answer: 'Ваш ответ',
    answerHint: 'напишите и нажмите Enter',
    send: 'отправить',
    loading: 'читаю прогон…',
    failed: 'Не удалось прочитать прогон',
    bandPhase: (p, step) => `фаза ${p}: ${step}`,
    stoppedShort: 'остановлена',
    waiting: (n) => `❓ ${n} ${ruPlural(n, 'вопрос ждёт', 'вопроса ждут', 'вопросов ждут')} вас`,
    pushFailed: 'отправка ✗',
    newQuestion: (p, q) => `Новый вопрос (фаза ${p}): «${q}»`,
    newQuestions: (n) => `Новых вопросов: ${n}`,
    phaseDone: (p) => `Фаза ${p} готова`,
    ciRed: (p, fix, asked) => `CI красный: фаза ${p} — ${fix ? (fix.last ? 'последняя попытка; если не выйдет, спросит вас' : `чинит сама (попытка ${fix.n} из ${fix.m})`) : asked ? 'нужен ваш ответ' : 'нужно ваше решение'}`,
    laneNeedsOwner: (p, why) => `Фаза ${p} остановилась — нужен ваш ответ${why ? `: ${why}` : ''}`,
    laneFailed: (p, why) => `Фаза ${p} остановилась из-за сбоя${why ? `: ${why}` : ''}`,
    halted: 'Супервизор остановился',
    answered: (what, at, note) => `Ответ принят: «${what}»${at ? ` · ${at}` : ''}${note ? ` · не сохранён в git: ${note}` : ''}`,
    already: (what, how, at) => `Уже отвечено${how || at ? ` (${[how, at].filter(Boolean).join(', ')})` : ''}${what ? `: «${what}»` : ''}`,
    channel: { session: 'в сессии', pane: 'в панели', telegram: 'в Telegram', 'standing-rule': 'по постоянному правилу' },
    changed: 'Вопрос изменился — панель показала новый, ответьте ещё раз',
    refused: (why) => `Не принято: ${why}`,
    refusal: { secret: 'похоже, в ответе секрет — напишите без него', tooLong: (n) => `ответ длиннее ${n} символов`, empty: 'пустой ответ', gone: 'вопрос уже закрыт', noOption: 'такого варианта нет', optionsOnly: 'этот вопрос принимает только варианты из списка', lane: 'из сессии самой фазы отвечать нельзя' },
    usage: 'Ответ не отправлен: turbo-run не принял команду (код 2)',
    exited: (code) => `Ответ не отправлен: turbo-run завершился с кодом ${code}`,
    notSent: (why) => `Ответ не отправлен: ${why}`,
    paneNotOpened: (why) => `turbo-view: панель не открылась: ${why}`,
  },
};

const textOf = (view) => TEXT[view?.ui?.lang === 'ru' ? 'ru' : 'en'];
// The words of the view's language (en before the first read), for the toasts the mod raises itself.
export const wordsFor = textOf;
const list = (v) => (Array.isArray(v) ? v : []);

// Repository data (commit subjects, reasons, questions, agent actions) can hold terminal escapes and bidi controls:
// OSC 52 rewrites the clipboard, ESC[2J clears the screen, U+202E reverses what follows. clean drops escape
// sequences (CSI, OSC, DCS/SOS/PM/APC, two-character ones), C0/C1 controls except tab and newline, and bidi
// overrides and isolates. Every string the mod draws goes through it.
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
export const clean = (text) => String(text ?? '').replace(ESCAPES, '').replace(CONTROLS, '');

// Grapheme clusters (what a terminal draws as one character: an emoji with its skin tone or ZWJ sequence, a flag, a
// letter with its combining marks); code points where the runtime has no Intl.Segmenter.
const SEGMENTER = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
const graphemes = (s) => (SEGMENTER ? Array.from(SEGMENTER.segment(s), (x) => x.segment) : Array.from(s));

// East Asian Wide and Fullwidth code points, drawn two cells wide.
const WIDE = [[0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3040, 0x3247], [0x3250, 0x4dbf], [0x4e00, 0xa4c6], [0xa960, 0xa97c], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6b], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x1b000, 0x1b001], [0x1f200, 0x1f251], [0x20000, 0x3fffd]];
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|\p{Regional_Indicator}|⃣/u;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u;

function cellWidth(g) {
  if (ZERO_WIDTH.test(g)) return 0;
  if (EMOJI.test(g)) return 2;
  const cp = g.codePointAt(0);
  return WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
}

// The terminal cells a text takes: two for a wide character or an emoji, one for others.
export const textWidth = (text) => graphemes(String(text ?? '')).reduce((n, g) => n + cellWidth(g), 0);

// One line at most max cells wide, whitespace collapsed, cut between grapheme clusters (an emoji, a flag or a letter
// with its marks is never split) and ended with … when cut.
export function cut(text, max) {
  const s = clean(text).replace(/\s+/g, ' ').trim();
  if (textWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const g of graphemes(s)) {
    const cw = cellWidth(g);
    if (w + cw > max - 1) break;
    out += g;
    w += cw;
  }
  return `${out}…`;
}

export const firstLine = (text) => String(text ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';

function fmtDuration(t, ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return t.duration(Math.floor(m / 60), m % 60, s);
}

// The time between two ISO times in words, or null when either is unknown.
function since(t, from, to) {
  const d = fmtDuration(t, Date.parse(to) - Date.parse(from));
  return d === '-' ? null : d;
}

// How long ago, in words: just now under a minute, days from a day on; null when unknown.
function agoText(t, from, to) {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms)) return null;
  if (ms < 60000) return t.justNow;
  return t.ago(ms >= 86400000 ? t.days(Math.floor(ms / 86400000)) : fmtDuration(t, ms));
}

// HH:MM of a time in milliseconds, in the zone utcOffsetMinutes east of UTC (turbo-run view's ui.utcOffsetMinutes,
// the owner's machine), or in the runtime's own zone without one; null for an unknown time. The offset is the one in
// force when the view was read: a time from before a daylight-saving switch shows an hour off, which a toast can bear.
export function clockText(ms, utcOffsetMinutes = null) {
  if (!Number.isFinite(ms)) return null;
  const shifted = Number.isFinite(utcOffsetMinutes);
  const d = new Date(shifted ? ms + utcOffsetMinutes * 60000 : ms);
  const [h, m] = shifted ? [d.getUTCHours(), d.getUTCMinutes()] : [d.getHours(), d.getMinutes()];
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// A lane's reason without the `owner question <id>` /turbo-phase puts first when it stops for a question (an id is
// `<plan>-t<task>`): the verdict and the questions say that already, and the id is turbo's own. What follows it stays;
// '' when nothing does.
export const laneReason = (reason) => clean(reason).replace(/^owner questions?\s+[\w.-]+-t\d+\b\s*:?\s*/i, '').trim();

const stepWord = (t, step) => (step == null ? t.allDone : t.step[step] ?? cut(step, 40));
const stepNoun = (t, step) => (step == null ? null : t.stepAt[step] ?? stepWord(t, step));
const agentWord = (t, type) => (type ? t.agent[type] ?? cut(type, 40) : t.agent['general-purpose']);
const planWords = (t, x) => (x?.plan ? t.plan(x.plan, x.task) : null);
const plansWords = (t, lane) => (lane?.plans?.total > 0 ? t.plans(lane.plans.done, lane.plans.total) : null);

const TEST_RUN = /\b(?:node\s+--test|npm\s+(?:run\s+)?test|npx\s+(?:jest|vitest|mocha)|jest|vitest|mocha|pytest|go\s+test|cargo\s+test|test-changed|plugin\s+test)\b/;
const COMMIT = /\bgit\b.*\bcommit\b/;
const EDITS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);

// What a running subagent does, in words, from its last tool call ({ tool, detail }, S0's actionOf).
function doingWords(t, action) {
  const d = t.doing;
  if (!action) return d.working;
  const tool = String(action.tool ?? '');
  const raw = String(action.detail ?? '');
  const x = cut(raw, 60);
  if (EDITS.has(tool)) return d.edit(x).trim();
  if (tool === 'Write') return d.write(x).trim();
  if (tool === 'Read') return d.read(x).trim();
  if (tool === 'Grep') return d.search;
  if (tool === 'Glob' || tool === 'LS') return d.files;
  if (tool === 'Bash' || tool === 'PowerShell') return TEST_RUN.test(raw) ? d.tests : COMMIT.test(raw) ? d.commit : d.command(cut(raw, 50)).trim();
  if (tool === 'Agent' || tool === 'Task') return d.helper;
  if (tool === 'Skill') return d.skill;
  if (tool === 'WebFetch' || tool === 'WebSearch') return d.web;
  if (tool === 'TodoWrite') return d.todo;
  if (tool === 'SendMessage') return d.message;
  if (/^mcp__.*(?:playwright|browser|chrome)/i.test(tool)) return d.browser;
  return `${cut(tool, 40)} ${x}`.trim();
}

// A red CI the running phase still fixes itself: { n, m } (attempt n of the m S2 allows: push.ci_fix_rounds,
// counted in phase-p<N>.json attempts.ci), or null when it cannot (no rounds, all used, or no count in the view).
function ciFixing(lane) {
  const m = lane?.ci?.rounds;
  const fixes = Number.isInteger(lane?.ci?.fixes) ? lane.ci.fixes : 0;
  if (lane?.push?.ci !== 'red' || lane.status !== 'running' || lane.held || !Number.isInteger(m) || m < 1) return null;
  // at the bound or past it the run in progress is the last one: never "nothing needed from you"
  return { n: Math.min(Math.max(1, fixes), m), m, last: fixes >= m };
}

// A red CI the phase fixes itself, in words: the attempt, or at the bound the last one (the owner may be asked next).
const ciWords = (t, fix) => (fix.last ? t.verdict.ciLast : t.verdict.ciFixing(fix.n, fix.m));

// The one verdict of the run, the answer to "do I have to step in", first match: the supervisor stopped or failing,
// a phase in the owner's own session, the supervisor not running, a failed or stopped phase, CI red that needs the
// owner, questions waiting, CI red the phase fixes itself, a silent phase or helper, a phase done, a phase paused for
// its context, then the supervisor's own state. Silence counts only while the supervisor runs: a run the owner stopped
// is not stuck. { kind, tone (TONES), text }.
function verdictOf(t, view) {
  const lanes = list(view?.lanes);
  const sup = view?.supervisor;
  const live = Boolean(sup?.running);
  const asked = list(view?.questions).length;
  const has = (s) => lanes.some((l) => l.status === s);
  const v = (kind, tone, text = t.verdict[kind]) => ({ kind, tone, text });
  if (sup?.halted) return v('halted', 'bad');
  if (live && sup.failingSince) return v('failing', 'bad', t.verdict.failing(clockText(Date.parse(sup.failingSince), view?.ui?.utcOffsetMinutes)));
  const attended = list(view?.attended)[0];
  if (attended != null) return v('attended', 'warn', t.verdict.attended(cut(attended, 20)));
  if (sup && !live && !sup.finished) return v('supStopped', 'warn');
  if (has('failed')) return v('failed', 'bad');
  if (has('needs-owner')) return v('needsOwner', 'bad', t.verdict.needsOwner(asked));
  if (lanes.some((l) => l.held === 'fullMode')) return v('fullMode', 'bad');
  const red = lanes.find((l) => l.push?.ci === 'red');
  const fixing = red ? ciFixing(red) : null;
  if (red && !fixing) return v('ciRed', 'bad', t.verdict.ciRed(asked));
  if (asked) return v('answer', 'warn', t.verdict.answer(asked));
  if (fixing) return v('ciFixing', 'warn', ciWords(t, fixing));
  if (live) {
    const quiet = lanes.find((l) => l.quiet && l.status === 'running');
    if (quiet) return v('quiet', 'warn', t.verdict.quiet(since(t, quiet.lastAt, view.at)));
    const silent = lanes.filter((l) => l.status === 'running').flatMap((l) => list(l.agents)).filter((a) => a.state === 'quiet').sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));
    if (silent.length) return v('quietHelper', 'warn', t.verdict.quietHelper(agentWord(t, silent[0].type), since(t, silent[0].lastAt, view.at), silent.length - 1));
  }
  if (lanes.length && lanes.every((l) => l.status === 'done')) return v('done', 'ok');
  if (has('paused-context')) return v('paused', 'warn');
  if (!sup) return lanes.length ? v('fine', 'ok') : v('never', 'dim');
  if (!live) return v('finished', 'ok');
  return v('fine', 'ok');
}

export const verdict = (view) => verdictOf(textOf(view), view);

function supWord(t, sup) {
  if (!sup) return t.sup.never;
  if (sup.running) return t.sup.running;
  if (sup.halted) return t.sup.halted;
  return sup.finished ? t.sup.finished : t.sup.stopped;
}

// The pane is a tree of plain nodes the hooks module turns into the surface's elements: { type: 'Box' | 'Text',
// props, children } (props are Box layout and Text style props, colours as theme keys), a Button { props, press }
// (press: { question, option, label } or { question, other: true }) or an Input { props, input: { question } }. Every
// string in it went through clean.
const text = (props, ...children) => ({ type: 'Text', props, children: children.flat().filter((x) => x !== null && x !== undefined && x !== '').map((x) => (typeof x === 'string' ? clean(x) : x)) });
const box = (props, ...children) => ({ type: 'Box', props, children: children.flat().filter(Boolean) });
const toned = (tone, extra = {}) => ({ ...TONES[tone], ...extra });

// What a lane that is not running says about itself (`Фаза 32 остановилась — ждёт вашего ответа`), or null while it
// runs: { kind (the verdict's), tone, text }.
const LANE_KINDS = { 'needs-owner': ['needsOwner', 'bad'], failed: ['failed', 'bad'], done: ['done', 'ok'], 'paused-context': ['paused', 'warn'] };
function laneState(t, lane, asked) {
  if (lane.held === 'fullMode') return { kind: 'fullMode', tone: 'bad', text: t.verdict.fullMode };
  const [kind, tone] = LANE_KINDS[lane.status] ?? [];
  return kind ? { kind, tone, text: kind === 'needsOwner' ? t.verdict.needsOwner(asked) : t.verdict[kind] } : null;
}

// How a lane line reads: 'state' (it stopped, finished or pauses: that first), 'held' (it would run, but the supervisor
// does not: never «идёт»), else 'running'.
function laneForm(view, lane) {
  if (LANE_KINDS[lane.status] || lane.held === 'fullMode') return 'state';
  const sup = view?.supervisor;
  return sup && !sup.running ? 'held' : 'running';
}

// How long the lane ran: while it runs, until now; otherwise until its last activity, so the time stops growing.
function laneTime(t, lane, form) {
  const ran = form === 'running' ? lane.elapsedMs : Date.parse(lane.lastAt) - Date.parse(lane.launchedAt);
  const d = fmtDuration(t, Number.isFinite(ran) ? ran : lane.elapsedMs);
  return d === '-' ? null : d;
}

// The lane line. Running: `Фаза 32 — выполняются планы · 5 из 9 планов готово · 1 ч 12 мин · <verdict>`. Stopped,
// finished or paused: that first, in its colour, then where it was: `Фаза 32 остановилась — ждёт вашего ответа · шаг:
// выполнение планов · 5 из 9 планов готово · 1 ч 12 мин`, and the run's verdict only when it says something else.
// Held by a supervisor that does not run: `Фаза 32 остановлена на шаге: выполнение планов · … · <verdict>`.
function laneLine(t, view, lane, v, asked) {
  const form = laneForm(view, lane);
  const dur = laneTime(t, lane, form);
  const phase = t.phase(cut(lane.phase, 20));
  const plans = plansWords(t, lane);
  const state = form === 'state' ? laneState(t, lane, asked) : null;
  const tail = v && v.kind !== state?.kind ? [' · ', text(toned(v.tone, { bold: true }), v.text)] : null;
  const dimmed = (parts) => (parts.filter(Boolean).length ? text(TONES.dim, ` · ${parts.filter(Boolean).join(' · ')}`) : null);
  if (form === 'running') return text({ wrap: 'wrap' }, text({ bold: true }, phase), ` — ${stepWord(t, lane.step)}`, dimmed([plans, dur]), tail);
  if (form === 'held') return text({ wrap: 'wrap' }, text({ bold: true }, `${phase} ${t.stoppedAt(stepNoun(t, lane.step))}`), dimmed([plans, dur]), tail);
  const where = [stepNoun(t, lane.step) && t.atStep(stepNoun(t, lane.step)), plans, dur && (lane.status === 'done' ? t.took(dur) : dur)];
  return text({ wrap: 'wrap' }, text(toned(state.tone, { bold: true }), `${phase} ${state.text}`), dimmed(where), tail);
}

// A helper: what it does now, its plan and time dim; `columns` (the pane's width) cuts what it does, never the time.
// While the supervisor does not run, nothing is called stuck: a silent helper says how long it is silent, dim.
function agentRow(t, a, at, live, columns) {
  const who = agentWord(t, a.type);
  const plan = planWords(t, a);
  if (a.state === 'quiet' && live) return text(toned('warn', { wrap: 'truncate-end' }), t.quietAgent(who, since(t, a.lastAt, at)), plan ? text(TONES.dim, ` · ${plan}`) : null);
  if (a.state === 'quiet') return text(toned('dim', { wrap: 'truncate-end' }), [who, plan, t.idle(since(t, a.lastAt, at))].filter(Boolean).join(' · '));
  const d = fmtDuration(t, a.elapsedMs);
  const dur = d === '-' ? '' : ` · ${d}`;
  const head = `${who}${plan ? ` · ${plan}` : ''} · `;
  const room = Number.isFinite(columns) ? columns - 2 - textWidth(head) - textWidth(dur) - 1 : Infinity;
  const doing = room < Infinity ? cut(doingWords(t, a.action), Math.max(10, room)) : doingWords(t, a.action);
  return text(live ? { wrap: 'truncate-end' } : toned('dim', { wrap: 'truncate-end' }), who, plan ? text(TONES.dim, ` · ${plan}`) : null, ` · ${doing}`, dur ? text(TONES.dim, dur) : null);
}

// The newest sign of the lane: its transcript's last write or a helper's, as ISO; null when unknown.
function lastSign(lane) {
  const times = [lane.lastAt, ...list(lane.agents).map((a) => a.lastAt)].filter((x) => Number.isFinite(Date.parse(x)));
  return times.length ? times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

// The verdict line, then, indented: the sign of life (amber once the phase reads as silent), the reason it stopped,
// the helpers at work, and the finished ones as one dim count.
function runSection(t, view, v, columns) {
  const lanes = list(view.lanes);
  const live = Boolean(view.supervisor?.running);
  const asked = list(view.questions).length;
  const rows = lanes.length ? [] : [text({ wrap: 'wrap' }, text({ bold: true }, t.run), ' — ', text(toned(v.tone, { bold: true }), v.text))];
  lanes.forEach((lane, i) => {
    rows.push(laneLine(t, view, lane, i === 0 ? v : null, asked));
    const agents = list(lane.agents);
    const working = agents.filter((a) => ACTIVE.has(a.state));
    const finished = agents.length - working.length;
    const why = laneReason(lane.reason);
    const sign = lastSign(lane);
    // a red CI the verdict does not speak of (an answer waits, the phase stopped) is said under it all the same
    const fixing = live ? ciFixing(lane) : null;
    const red = lane.push?.ci === 'red' && !(i === 0 && (v.kind === 'ciRed' || v.kind === 'ciFixing'));
    const under = [
      sign ? text(toned(live && lane.quiet ? 'warn' : 'dim', { wrap: 'truncate-end' }), t.life(since(t, sign, view.at) ?? '-')) : null,
      red ? text(toned(fixing ? 'warn' : 'bad', { wrap: 'wrap' }), fixing ? ciWords(t, fixing) : t.verdict.ciRed(asked)) : null,
      why ? text(toned(STOPPED.has(lane.status) ? 'bad' : 'dim', { wrap: 'wrap' }), `${t.reason}: ${cut(why, 200)}`) : null,
      ...working.map((a) => agentRow(t, a, view.at, live, columns)),
      finished ? text(TONES.dim, t.helpersDone(finished, working.length > 0)) : null,
    ].filter(Boolean);
    if (under.length) rows.push(box({ flexDirection: 'column', paddingLeft: 2 }, under));
  });
  return box({ flexDirection: 'column' }, rows);
}

// One question as a card: whether the phase waits for it (red) or it can be answered ahead (dim), the question in bold
// with where it comes from, its context dim, the options listed in full when a button would cut one or an option has a
// description, a row of option buttons (number and text, ★ and the primary look for the recommended one) and, on a row
// of its own, Other… or its field while it is open.
function questionCard(t, view, q, field) {
  const id = String(q.id);
  // the revision drawn (S1: every question starts at rev 1); turbo-run answer gets it as --rev
  const question = { id, phase: String(q.phase ?? ''), rev: Number.isInteger(q.rev) && q.rev > 0 ? q.rev : 1 };
  const where = planWords(t, { plan: q.plan == null ? null : cut(q.plan, 20), task: q.task == null ? null : cut(q.task, 10) }) ?? (question.phase ? t.phaseOnly(cut(question.phase, 20)) : null);
  const holds = q.stopped === true;
  const running = Boolean(view.supervisor?.running) && list(view.lanes).some((l) => String(l.phase) === question.phase && l.status === 'running');
  const options = list(q.options).map((o, i) => ({ n: i + 1, label: cut(typeof o === 'string' ? o : o?.label ?? '', LABEL_MAX), description: cut(o?.description ?? '', CONTEXT_MAX), recommended: o?.recommended === true }));
  const listed = options.some((o) => o.description || textWidth(o.label) > BUTTON_MAX);
  const buttons = options.map((o) => ({ type: 'Button', props: { key: `q:${id}:${o.n}`, label: `${o.n}. ${cut(o.label, BUTTON_MAX)}${o.recommended ? ' ★' : ''}`, ...(o.recommended ? { variant: 'primary' } : {}) }, press: { question, option: o.n, label: o.label } }));
  const other = q.allowOther === false ? null : field.inputFor === id
    ? { type: 'Input', props: { key: `q:${id}:text`, label: t.answer, placeholder: t.answerHint, value: field.draft, submitLabel: t.send, autoFocus: true }, input: { question } }
    : { type: 'Button', props: { key: `q:${id}:other`, label: t.other }, press: { question, other: true } };
  return box({ flexDirection: 'column', borderStyle: 'round', borderColor: (holds ? TONES.bad : TONES.warn).color, paddingX: 1 },
    holds ? text(toned('bad', { bold: true }), t.holds) : text(TONES.dim, t.ahead(running)),
    text({ bold: true, wrap: 'wrap' }, cut(q.question || q.header || '', QUESTION_MAX), where ? text(TONES.dim, ` (${where})`) : null),
    q.context ? text(toned('dim', { wrap: 'truncate-end' }), cut(q.context, CONTEXT_MAX)) : null,
    listed ? box({ flexDirection: 'column', paddingLeft: 2 }, options.map((o) => text({ wrap: 'wrap' }, `${o.n}. ${o.label}`, o.recommended ? text(TONES.ok, ` ★ ${t.recommended}`) : null, o.description ? text(TONES.dim, ` — ${o.description}`) : null))) : null,
    buttons.length ? box({ flexDirection: 'row', columnGap: 2, flexWrap: 'wrap', paddingLeft: 2 }, buttons) : null,
    other ? box({ flexDirection: 'row', paddingLeft: 2 }, other) : null);
}

// A commit: its subject, and how long ago dim; an older view without the commit time shows the short hash instead.
function commitRow(t, view, c) {
  const ago = agoText(t, c.at, view.at);
  return ago ? text({ wrap: 'truncate-end' }, cut(c.subject, 100), text(TONES.dim, ` · ${ago}`)) : text({ wrap: 'truncate-end' }, text(TONES.dim, cut(c.sha, 12)), ` ${cut(c.subject, 100)}`);
}

// The pane: the verdict and the run, the questions waiting for the owner (the ones the phase waits for first), the
// latest commits and the supervisor, in sections a blank line apart. error is why the last refresh failed; the last
// good view stays below it. field is the Other… field (NO_FIELD, openField). columns is the pane's width, when known.
export function render(view, { error = null, field = NO_FIELD, columns = null } = {}) {
  const t = textOf(view);
  const parts = [];
  if (error) parts.push(text(toned('bad', { wrap: 'truncate-end' }), `⚠️ ${t.failed}: ${errorWords(view, cut(error, 200))}`));
  if (!view) return box({ flexDirection: 'column' }, parts.length ? parts : [text(TONES.dim, t.loading)]);
  parts.push(runSection(t, view, verdictOf(t, view), columns));
  const questions = [...list(view.questions)].sort((a, b) => (b?.stopped === true) - (a?.stopped === true));
  if (questions.length) parts.push(box({ flexDirection: 'column', marginTop: 1 }, text(toned('warn', { bold: true }), t.askHead(questions.length)), questions.map((q) => questionCard(t, view, q, field))));
  const commits = list(view.commits);
  if (commits.length) parts.push(box({ flexDirection: 'column', marginTop: 1 }, text({ bold: true }, t.changes), box({ flexDirection: 'column', paddingLeft: 2 }, commits.map((c) => commitRow(t, view, c)))));
  if (view.supervisor) {
    const range = view.range ? t.phases(cut(view.range.from ?? '…', 20), cut(view.range.to ?? '…', 20)) : null;
    parts.push(box({ marginTop: 1 }, text(toned('dim', { wrap: 'truncate-end' }), [supWord(t, view.supervisor), range].filter(Boolean).join(' · '))));
  }
  return box({ flexDirection: 'column' }, parts);
}

// A Text node's text: its strings and those of the Text nodes inside it, in order.
export const spanText = (node) => (typeof node === 'string' ? node : list(node?.children).map(spanText).join(''));

// The pane as plain lines (the visual check's checklist, the tests): a Text is one line, a row of controls one line
// of [labels], a Box's top margin blank lines and its padding an indent, a border │.
export function paneLines(node) {
  if (typeof node === 'string') return [node];
  const p = node.props ?? {};
  if (node.type === 'Text') return [spanText(node)];
  if (node.type === 'Button') return [`[${p.label}]`];
  if (node.type === 'Input') return [`[${p.label}: ${p.value ?? ''}]`];
  const kids = list(node.children);
  const pad = `${p.borderStyle ? '│' : ''}${' '.repeat(p.paddingLeft ?? p.paddingX ?? p.padding ?? 0)}`;
  const body = p.flexDirection === 'row' ? [kids.flatMap(paneLines).join(' '.repeat(p.columnGap ?? 1))] : kids.flatMap(paneLines);
  return [...Array(p.marginTop ?? 0).fill(''), ...body.map((l) => (l ? pad + l : l))];
}

// The push marks of a lane: a push that did not go out, and the CI state of the last push (S2 keeps the two apart, so
// a refused request beside a red CI run shows both); ci false leaves the CI state out.
function pushMarks(t, push, ci = true) {
  return push ? [push.outcome !== 'pushed' ? t.pushFailed : null, ci ? CI_MARK[push.ci] ?? null : null].filter(Boolean) : [];
}

// The one line above the prompt: turbo, each phase (running: its step and plans done, `5/9`; otherwise what happened),
// the verdict, the questions waiting and the CI mark (`turbo · фаза 32: выполняются планы 5/9 · ❓ 1 вопрос ждёт вас ·
// CI ✓`), or null when the project has no turbo run and no open question. bandStyle is its colour, the verdict's.
export function bandLine(view, { error = null } = {}) {
  if (error) return `turbo · ⚠️ ${errorWords(view, cut(error, 100))}`;
  const questions = list(view?.questions);
  if (!view || (!view.supervisor && !questions.length)) return null;
  const t = textOf(view);
  const v = verdictOf(t, view);
  const lanes = list(view.lanes);
  const states = lanes.map((l) => (laneForm(view, l) === 'state' ? laneState(t, l, questions.length) : null));
  const lanePart = (l, i) => {
    const p = cut(l.phase, 20);
    if (states[i]) return `${t.phaseOnly(p)} ${states[i].text}`;
    if (laneForm(view, l) === 'held') return `${t.phaseOnly(p)} ${t.stoppedShort}`;
    return `${t.bandPhase(p, stepWord(t, l.step))}${l.plans?.total > 0 ? ` ${l.plans.done}/${l.plans.total}` : ''}`;
  };
  const parts = ['turbo', ...lanes.map(lanePart)];
  if (v.kind !== 'answer' && !states.some((s) => s?.kind === v.kind)) parts.push(v.text);
  if (questions.length) parts.push(t.waiting(questions.length));
  // a red CI verdict says it in words already
  parts.push(...(lanes.map((l) => pushMarks(t, l.push, v.kind !== 'ciRed' && v.kind !== 'ciFixing')).find((m) => m.length) ?? []));
  return clean(parts.join(' · '));
}

export const bandStyle = (view, { error = null } = {}) => ({ ...TONES[error ? 'bad' : verdictOf(textOf(view), view).tone] });

// What the toasts remember of each lane between reads: { [phase]: { status, red } }, red the sha of the red CI run
// already toasted. A lane that left the view stays, with status 'gone'.
const redOf = (lane) => (lane.push?.ci === 'red' ? lane.push.sha ?? '' : null);
const lanesSeen = (view) => Object.fromEntries(list(view?.lanes).map((l) => [String(l.phase), { status: l.status, red: redOf(l) }]));

// Toasts for what changed between two views, against seen (the lanes as last seen, kept by the caller across reads;
// prev's lanes when not given): a new question, a phase done, red CI (whether the phase fixes it itself), a lane that
// stopped (needs-owner, failed) or a halted supervisor. A lane the same supervisor cleared without halting is a phase
// done (the supervisor clears a lane only when its phase is done, then takes the next one or finishes); a lane that
// arrives already done or stopped says so. The first view of a session (prev null) shows none. Returns
// { toasts, seen } (seen after next).
export function diffViews(prev, next, seen = lanesSeen(prev)) {
  if (!next) return { toasts: [], seen };
  if (!prev) return { toasts: [], seen: { ...seen, ...lanesSeen(next) } };
  const t = textOf(next);
  const out = [];
  const asked = new Set(list(prev.questions).map((q) => q.id));
  const fresh = list(next.questions).filter((q) => !asked.has(q.id));
  if (fresh.length === 1) out.push(t.newQuestion(cut(fresh[0].phase ?? '', 20), cut(fresh[0].question || fresh[0].header || '', 80)));
  else if (fresh.length > 1) out.push(t.newQuestions(fresh.length));
  const after = { ...seen };
  const lanes = list(next.lanes);
  const sup = next.supervisor;
  const cleared = Boolean(sup && !sup.halted && (sup.finished || (sup.pid != null && sup.pid === prev.supervisor?.pid)));
  for (const [phase, last] of Object.entries(seen)) {
    if (last.status === 'gone' || lanes.some((l) => String(l.phase) === phase)) continue;
    if (cleared && last.status !== 'done') out.push(t.phaseDone(phase));
    after[phase] = { ...last, status: 'gone' };
  }
  for (const n of lanes) {
    const phase = String(n.phase);
    const last = seen[phase] ?? { status: null, red: null };
    if (n.status === 'done' && last.status !== 'done') out.push(t.phaseDone(phase));
    if (STOPPED.has(n.status) && n.status !== last.status) out.push((n.status === 'failed' ? t.laneFailed : t.laneNeedsOwner)(phase, cut(laneReason(n.reason), 80)));
    const red = redOf(n);
    if (red !== null && red !== last.red) out.push(t.ciRed(phase, sup?.running ? ciFixing(n) : null, list(next.questions).length));
    after[phase] = { status: n.status, red };
  }
  if (!prev.supervisor?.halted && sup?.halted) out.push(t.halted);
  return { toasts: out.map((s) => cut(s, 300)), seen: after };
}

export const toastsFor = (prev, next, seen) => diffViews(prev, next, seen).toasts;

// The mod's own errors in the view's language; one it does not know stays as it came, after the words around it.
const ERRORS_RU = [
  [/^node not found in PATH$/, () => 'node не найден в PATH'],
  [/^turbo-run not found at (.+)$/, (m) => `turbo-run не найден: ${m[1]}`],
  [/^no \.planning\/turbo\/ in this directory or above it$/, () => 'ни здесь, ни выше нет .planning/turbo/'],
  [/^cannot find turbo-run: /, () => 'turbo-run не найден: не задан ни CLAUDE_CONFIG_DIR, ни домашний каталог'],
  [/^turbo-run view --json printed no JSON$/, () => 'turbo-run view --json вывел не JSON'],
];
export function errorWords(view, why) {
  const s = String(why ?? '');
  if (view?.ui?.lang !== 'ru') return s;
  for (const [re, say] of ERRORS_RU) {
    const m = re.exec(s);
    if (m) return say(m);
  }
  return s;
}

// The toast for an answer that never reached turbo-run (no turbo-run, no node, no project).
export const notSentToast = (view, why) => textOf(view).notSent(errorWords(view, why));

// S1's refusals (lib/answers.mjs, lib/cli-phase.mjs) in words; one this mod does not know stays as turbo-run said it.
function refusalWords(t, why) {
  const long = /longer than (\d+) characters/.exec(why);
  if (/secret/.test(why)) return t.refusal.secret;
  if (long) return t.refusal.tooLong(long[1]);
  if (/answer is empty/.test(why)) return t.refusal.empty;
  if (/^no question /.test(why)) return t.refusal.gone;
  if (/has no option/.test(why)) return t.refusal.noOption;
  if (/takes one of its options only/.test(why)) return t.refusal.optionsOnly;
  if (/lane never answers/.test(why)) return t.refusal.lane;
  return why;
}

// turbo-run answer's line for exit 3: the first answer, its channel and time. The answer may be own words with line
// breaks (describeAnswer cuts it, newlines kept), so the whole output is read as one line and the channel and time are
// taken from its end.
const ALREADY = /^already answered: (.*), (session|pane|telegram|standing-rule), (\S+)$/;
const NOT_COMMITTED = / · not committed: (.*)$/;

// The toast after `turbo-run answer` exits, from S1's exit code (0 recorded, 3 already answered, 4 changed since it
// was shown, 1 refused, 2 usage) and what the pane sent (sent: the option's label or the own words), in the view's
// language with the local time (nowMs, the press; exit 3 reads the first answer's time from turbo-run's line). Never
// the question's internal id or the channel's code name. An answer recorded but not committed says so.
export function answerToast(view, { code, stdout = '', stderr = '', sent = '', nowMs = NaN }) {
  const t = textOf(view);
  const offset = view?.ui?.utcOffsetMinutes;
  const joined = (s) => clean(s).trim().replace(/\s*\n\s*/g, ' ');
  const line = joined(stdout) || joined(stderr);
  if (code === 0) return cut(t.answered(cut(sent, 60), clockText(nowMs, offset), cut(NOT_COMMITTED.exec(line)?.[1] ?? '', 80)), 300);
  if (code === 3) {
    const m = ALREADY.exec(line);
    return clean(m ? t.already(cut(m[1], 60), t.channel[m[2]], clockText(Date.parse(m[3]), offset)) : t.already('', null, null));
  }
  if (code === 4) return t.changed;
  if (code === 1 && line) return cut(t.refused(refusalWords(t, line.replace(/^refused: /, ''))), 300);
  return code === 2 ? t.usage : t.exited(code);
}

// The view object from `turbo-run view --json` output; throws a one-line Error for anything else.
export function parseView(stdout) {
  let v;
  try {
    v = JSON.parse(String(stdout));
  } catch {
    throw new Error('turbo-run view --json printed no JSON');
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.lanes) || !Array.isArray(v.questions) || !Array.isArray(v.commits)) throw new Error('turbo-run view --json printed an object this mod cannot read');
  if (v.v !== 1) throw new Error(`turbo-run view --json is v${v.v}; this mod reads v1: run node install.mjs again`);
  return v;
}

// Milliseconds between two reads: view.refresh_seconds (ui.refreshSeconds in the view, 1–60, else 3) while a
// surface is attached, else at least BACKGROUND_MS.
export function refreshMs(view, foreground) {
  const n = Number(view?.ui?.refreshSeconds);
  const ms = (Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULT_REFRESH_SECONDS) * 1000;
  return foreground ? ms : Math.max(BACKGROUND_MS, ms);
}

// The mod opens the pane by itself only while there is something live to watch; Claude Code places such a pane
// from 144 columns (110 once the person opened it), and /turbo-view opens it at any width.
export const shouldAutoOpen = (view) => Boolean(view?.supervisor?.running || list(view?.questions).length);

// The argv of S1's single answer arbiter (spec §5.3) for a press in the pane: option is the 1-based option number,
// text a free answer, passed as one argument (no shell); --rev is always the revision the pane drew, so an answer to
// a question that changed since records nothing (exit 4). node is the absolute node the mod found (nodeCandidates);
// root is the project, named with --project before anything else; a free text comes last, after every real flag, so
// a text that reads like a flag (--project, --by, --rev) is never taken for one.
export function answerArgv({ node, turboRun, root, question, option = null, text = null }) {
  const head = [node, turboRun, 'answer', '--project', root, String(question.phase), String(question.id)];
  const tail = ['--by', 'pane', '--rev', String(question.rev)];
  return text !== null ? [...head, ...tail, '--text', String(text)] : [...head, '--option', String(option), ...tail];
}

// The argv of the view read: the project is named, never taken from the working directory.
export const viewArgv = ({ node, turboRun, root }) => [node, turboRun, 'view', '--project', root, '--json'];

// The directory turbo-run runs in: its install directory (<dir>/bin/turbo-run.mjs → <dir>), never the project, where
// a node version manager (Volta, asdf, mise) would follow the project's pin. A network share keeps its //server/share
// prefix and an extended-length path (\\?\C:\…, \\?\UNC\server\share\…) is read as the plain one, as ancestorDirs
// does. null for a bare file name or a server without a share.
export function turboDir(bin) {
  const p = String(bin).replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  const unc = /^\/\/[^/]/.test(p);
  const parts = (unc ? p.slice(2) : p).split(/\/+/);
  if (parts.length <= 2) return null;
  const dir = parts.slice(0, -2);
  if (unc) return dir.length >= 2 ? `//${dir.join('/')}` : null;
  return dir.join('/') || '/';
}

// A Windows path: a drive (C:\, c:/) or a network share (\\server\share).
export const isWindowsPath = (p) => /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]/.test(String(p ?? ''));

// Where node may be, in PATH order: node.exe (Windows) or node in each absolute PATH directory. A bare `node` is
// looked up in the child's working directory (the project) first on Windows, and an empty or relative PATH entry
// names the working directory too, so neither is ever used: a node placed in a project never runs.
export function nodeCandidates({ pathVar, windows }) {
  const out = [];
  for (const entry of String(pathVar ?? '').split(windows ? ';' : ':')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!(windows ? isWindowsPath(dir) : dir.startsWith('/'))) continue;
    const file = joinPath(dir, windows ? 'node.exe' : 'node');
    if (!out.includes(file)) out.push(file);
  }
  return out;
}

// The "Other…" field: { inputFor (the question whose field is open), draft (what is typed), draftFor (its question) }.
export const NO_FIELD = Object.freeze({ inputFor: null, draft: '', draftFor: null });

// Opens the field of question id, with the text typed for it before (kept after a changed question), else empty.
export const openField = (field, id) => ({ inputFor: id, draft: field.draftFor === id ? field.draft : '', draftFor: id });

// After `turbo-run answer` exits (S1's codes): 0 answered and 3 already answered close the field and drop its
// draft; 4 (the question changed since it was drawn) closes it and keeps the draft; 1 refused and 2 usage leave
// both, so the owner can rephrase.
export function afterAnswer(field, id, code) {
  const settled = code === 0 || code === 3;
  const drop = settled && field.draftFor === id;
  return {
    inputFor: field.inputFor === id && (settled || code === 4) ? null : field.inputFor,
    draft: drop ? '' : field.draft,
    draftFor: drop ? null : field.draftFor,
  };
}

// A draft lives as long as its question is open in the view.
export function keepDraft(field, view) {
  if (field.draftFor === null || list(view?.questions).some((q) => String(q.id) === field.draftFor)) return field;
  return { inputFor: field.inputFor === field.draftFor ? null : field.inputFor, draft: '', draftFor: null };
}

// Joins with "/", which Windows accepts too; a trailing separator of dir is dropped (C:\ → C:/x, / → /x).
export const joinPath = (dir, ...parts) => [String(dir).replace(/[\\/]+$/, ''), ...parts].join('/');

// dir and every directory above it, nearest first, with "/" separators (C:/a/b → C:/a/b, C:/a, C:/). A network
// directory stops at its share (//server/share/a → //server/share/a, //server/share): its root is never the current
// drive's. Extended-length prefixes (\\?\C:\…, \\?\UNC\server\share\…) are read as the plain path.
export function ancestorDirs(dir) {
  const p = String(dir).replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '');
  if (p.startsWith('//')) {
    const share = /^\/\/[^/]+\/[^/]+/.exec(p)?.[0];
    if (!share) return [];
    const rest = p.slice(share.length).split('/').filter(Boolean);
    return rest.map((_, i) => [share, ...rest.slice(0, rest.length - i)].join('/')).concat(share);
  }
  const parts = p.split('/');
  const out = [];
  for (let i = parts.length; i > 0; i--) {
    const d = parts.slice(0, i).join('/');
    const full = d === '' ? '/' : /^[A-Za-z]:$/.test(d) ? `${d}/` : d;
    if (!out.includes(full)) out.push(full);
  }
  return out;
}

// turbo-run.mjs as install.mjs places it: ${CLAUDE_CONFIG_DIR:-<home>/.claude}/turbo/bin/turbo-run.mjs. bin
// (TURBO_VIEW_BIN) overrides it for development and the visual check; null when no directory is known.
export function turboRunPath({ bin = null, configDir = null, home = null }) {
  if (bin) return bin;
  const base = configDir || (home ? joinPath(home, '.claude') : null);
  return base ? joinPath(base, 'turbo', 'bin', 'turbo-run.mjs') : null;
}
