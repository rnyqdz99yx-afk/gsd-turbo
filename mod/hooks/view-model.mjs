// The turbo-view mod's view model (spec §7): what the pane, the band above the prompt and the toasts show for one
// `turbo-run view --json` object (S0's contract, v 1). Pure functions without imports or host APIs: the mod's hooks
// module imports this file, and node --test runs it in CI (test/view-model.test.mjs).

export const PANE_ID = 'turbo-view';
export const PANE_TITLE = 'turbo';
// How often a session nobody looks at (no surface attached) reads the view, and how often the mod looks for
// .planning/turbo/ again outside a turbo project.
export const BACKGROUND_MS = 15000;
export const DEFAULT_REFRESH_SECONDS = 3;
const FINISHED_SHOWN = 3;
const ACTIVE = new Set(['running', 'quiet']);
const STOPPED = new Set(['needs-owner', 'failed']);
const CI_MARK = { green: 'CI ✓', red: 'CI ✗', pending: 'CI …', timeout: 'CI ?' };

const ruPlural = (n, one, few, many) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

const TEXT = {
  en: {
    phases: 'phases',
    sup: { running: 'supervisor running', stopped: 'supervisor not running', finished: 'supervisor finished', halted: 'supervisor halted', never: 'supervisor never started' },
    lane: 'lane',
    allDone: 'all steps done',
    quiet: 'quiet',
    reason: 'reason',
    commits: 'commits',
    state: { completed: 'completed', stopped: 'stopped', failed: 'failed' },
    more: (n) => `+ ${n} more`,
    agents: (n) => `${n} ${n === 1 ? 'agent' : 'agents'}`,
    questions: (n) => `${n} ${n === 1 ? 'question' : 'questions'}`,
    other: 'Other…',
    answer: 'Answer',
    answerHint: 'your answer',
    send: 'send',
    newQuestion: (label) => `new question: ${label}`,
    newQuestions: (n) => `${n} new questions`,
    phaseDone: (p) => `phase ${p} done`,
    ciRed: (p, sha) => `CI red: phase ${p}${sha ? `, ${sha}` : ''}`,
    laneStopped: (p, what) => `phase ${p} stopped: ${what}`,
    halted: 'supervisor halted',
    loading: 'reading the run…',
    failed: 'turbo-run view failed',
    duration: (h, m, s) => (h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`),
  },
  ru: {
    phases: 'фазы',
    sup: { running: 'супервизор работает', stopped: 'супервизор не работает', finished: 'супервизор закончил', halted: 'супервизор остановлен', never: 'супервизор не запускался' },
    lane: 'лейн',
    allDone: 'все шаги готовы',
    quiet: 'тихо',
    reason: 'причина',
    commits: 'коммиты',
    state: { completed: 'готов', stopped: 'остановлен', failed: 'сбой' },
    more: (n) => `+ ещё ${n}`,
    agents: (n) => `${n} ${ruPlural(n, 'агент', 'агента', 'агентов')}`,
    questions: (n) => `${n} ${ruPlural(n, 'вопрос', 'вопроса', 'вопросов')}`,
    other: 'Другое…',
    answer: 'Ответ',
    answerHint: 'свой ответ',
    send: 'отправить',
    newQuestion: (label) => `новый вопрос: ${label}`,
    newQuestions: (n) => `новых вопросов: ${n}`,
    phaseDone: (p) => `фаза ${p} готова`,
    ciRed: (p, sha) => `CI красный: фаза ${p}${sha ? `, ${sha}` : ''}`,
    laneStopped: (p, what) => `фаза ${p} встала: ${what}`,
    halted: 'супервизор остановлен',
    loading: 'читаю прогон…',
    failed: 'turbo-run view не сработал',
    duration: (h, m, s) => (h ? `${h} ч ${m} мин` : m ? `${m} мин` : `${s} с`),
  },
};

const textOf = (view) => TEXT[view?.ui?.lang === 'ru' ? 'ru' : 'en'];
const list = (v) => (Array.isArray(v) ? v : []);

// One line of at most max characters (code points, so an emoji is never split), whitespace collapsed, … when cut.
export function cut(text, max) {
  const chars = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

// A column of width w: the text cut to w - 1 and padded, so the next column starts one space after it at least.
const col = (text, w) => {
  const c = cut(text, w - 1);
  return c + ' '.repeat(w - Array.from(c).length);
};

export const firstLine = (text) => String(text ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? '';

function fmtDuration(t, ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return t.duration(Math.floor(m / 60), m % 60, s);
}

const fmtTokens = (n) => (!Number.isFinite(n) ? '-' : n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);
const planLabel = (x) => (x?.plan ? `${x.plan}${x.task ? ` Task ${x.task}` : ''}` : '—');

function supWord(t, sup) {
  if (!sup) return t.sup.never;
  if (sup.running) return t.sup.running;
  if (sup.halted) return t.sup.halted;
  return sup.finished ? t.sup.finished : t.sup.stopped;
}

function agentRow(t, a, at) {
  const head = `    ${col(a.type || 'agent', 14)}${col(planLabel(a), 14)}`;
  if (a.state === 'quiet') {
    const since = fmtDuration(t, Date.parse(at) - Date.parse(a.lastAt));
    return `${head}${col(since === '-' ? t.quiet : `${t.quiet} ${since}`, 22)}⚠`;
  }
  const doing = a.state === 'running' ? (a.action ? `${a.action.tool} ${a.action.detail ?? ''}` : '—') : t.state[a.state] ?? String(a.state);
  return `${head}${col(doing, 22)}${fmtDuration(t, a.elapsedMs)} · ${fmtTokens(a.tokens)}`;
}

function questionRow(t, q) {
  const id = String(q.id);
  return {
    kind: 'question',
    id,
    phase: String(q.phase ?? ''),
    // the revision drawn (S1: every question starts at rev 1); turbo-run answer gets it as --rev
    rev: Number.isInteger(q.rev) && q.rev > 0 ? q.rev : 1,
    text: `    ${planLabel(q)} · ${cut(q.question || q.header || '', 160)}`,
    // option is the 1-based number turbo-run answer --option takes
    options: list(q.options).map((o, i) => ({ key: `q:${id}:${i + 1}`, label: cut(o?.label || String(i + 1), 40), option: i + 1 })),
    other: q.allowOther !== false,
    otherKey: `q:${id}:other`,
    inputKey: `q:${id}:text`,
    otherLabel: t.other,
    inputLabel: t.answer,
    inputHint: t.answerHint,
    submitLabel: t.send,
  };
}

// The pane: { rows }, each { kind: 'text', text, tone } (tone: title | normal | dim | warn | error) or a question
// row (see questionRow). error is why the last refresh failed; the last good view stays below it.
export function render(view, { error = null } = {}) {
  const t = textOf(view);
  const rows = [];
  const line = (text, tone = 'normal') => rows.push({ kind: 'text', text, tone });
  if (error) line(`⚠ ${t.failed}: ${cut(error, 200)}`, 'error');
  if (!view) {
    if (!error) line(t.loading, 'dim');
    return { rows };
  }
  const range = view.range ? `${t.phases} ${view.range.from ?? '…'}–${view.range.to ?? '…'}` : null;
  line(['turbo', range, supWord(t, view.supervisor)].filter(Boolean).join(' · '), 'title');
  for (const lane of list(view.lanes)) {
    line(`▸ p${lane.phase}  ${lane.step ?? t.allDone}  · ${fmtDuration(t, lane.elapsedMs)} · ${t.lane} ${lane.status}${lane.quiet ? ` · ${t.quiet}` : ''}`, STOPPED.has(lane.status) ? 'warn' : 'normal');
    if (lane.reason) line(`    ${t.reason}: ${cut(lane.reason, 200)}`, 'warn');
    const agents = list(lane.agents);
    const finished = agents.filter((a) => !ACTIVE.has(a.state));
    for (const a of agents.filter((x) => ACTIVE.has(x.state))) line(agentRow(t, a, view.at), a.state === 'quiet' ? 'warn' : 'normal');
    for (const a of finished.slice(0, FINISHED_SHOWN)) line(agentRow(t, a, view.at), 'dim');
    if (finished.length > FINISHED_SHOWN) line(`    ${t.more(finished.length - FINISHED_SHOWN)}`, 'dim');
  }
  const questions = list(view.questions);
  if (questions.length) {
    line(`? ${t.questions(questions.length)}`, 'warn');
    for (const q of questions) rows.push(questionRow(t, q));
  }
  const commits = list(view.commits);
  if (commits.length) {
    line(`${t.commits}:`, 'dim');
    for (const c of commits) line(`  ${c.sha} ${cut(c.subject, 100)}`, 'dim');
  }
  return { rows };
}

const ciMark = (push) => (!push ? null : push.outcome !== 'pushed' ? 'push ✗' : CI_MARK[push.ci] ?? null);

// The one line above the prompt (spec §7: `turbo p32 execute · 3 агента · ? 2 вопроса · CI ✓`), or null when the
// project has no turbo run and no open question.
export function bandLine(view, { error = null } = {}) {
  if (error) return `turbo · ⚠ ${cut(error, 100)}`;
  const questions = list(view?.questions);
  if (!view || (!view.supervisor && !questions.length)) return null;
  const t = textOf(view);
  const lanes = list(view.lanes);
  const parts = [lanes.length ? `turbo ${lanes.map((l) => `p${l.phase} ${l.step ?? t.allDone}${l.status === 'running' ? '' : ` (${l.status})`}`).join(', ')}` : 'turbo'];
  if (!view.supervisor?.running) parts.push(supWord(t, view.supervisor));
  const active = lanes.reduce((n, l) => n + list(l.agents).filter((a) => ACTIVE.has(a.state)).length, 0);
  if (active) parts.push(t.agents(active));
  if (questions.length) parts.push(`? ${t.questions(questions.length)}`);
  const ci = lanes.map((l) => ciMark(l.push)).find(Boolean);
  if (ci) parts.push(ci);
  return parts.join(' · ');
}

// Toasts for what changed between two views: a new question, a phase done, red CI, a lane that stopped (needs-owner,
// failed) or a halted supervisor. The first view of a session (prev null) shows none.
export function toastsFor(prev, next) {
  if (!prev || !next) return [];
  const t = textOf(next);
  const out = [];
  const seen = new Set(list(prev.questions).map((q) => q.id));
  const fresh = list(next.questions).filter((q) => !seen.has(q.id));
  if (fresh.length === 1) out.push(t.newQuestion(`${planLabel(fresh[0])} — ${cut(fresh[0].question || fresh[0].header || '', 80)}`));
  else if (fresh.length > 1) out.push(t.newQuestions(fresh.length));
  for (const p of list(prev.lanes)) {
    const n = list(next.lanes).find((l) => String(l.phase) === String(p.phase));
    if (!n) continue;
    if (n.status === 'done' && p.status !== 'done') out.push(t.phaseDone(n.phase));
    if (STOPPED.has(n.status) && n.status !== p.status) out.push(t.laneStopped(n.phase, n.reason ? `${n.status} — ${cut(n.reason, 80)}` : n.status));
    if (n.push?.ci === 'red' && !(p.push?.ci === 'red' && p.push?.sha === n.push.sha)) out.push(t.ciRed(n.phase, n.push.sha));
  }
  if (!prev.supervisor?.halted && next.supervisor?.halted) out.push(t.halted);
  return out;
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
// a question that changed since records nothing (exit 4).
export function answerArgv({ turboRun, question, option = null, text = null }) {
  const pick = text !== null ? ['--text', String(text)] : ['--option', String(option)];
  return ['node', turboRun, 'answer', String(question.phase), String(question.id), ...pick, '--by', 'pane', '--rev', String(question.rev)];
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

// dir and every directory above it, nearest first, with "/" separators (C:/a/b → C:/a/b, C:/a, C:/).
export function ancestorDirs(dir) {
  const parts = String(dir).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
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
