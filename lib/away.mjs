import { readJson } from './fsx.mjs';
import { questionsFile, refreshQuestions } from './questions.mjs';
import { clean, openQuestions, plansOf, recentCommits } from './view.mjs';
import { isFinished, inRange } from './scheduler.mjs';
import { supervisorLanes } from './lanes-state.mjs';
import { readLaneStatus } from './run-status.mjs';
import { findPhaseDir } from './phase-files.mjs';
import { autoAnswers, readAway, writeAway } from './away-state.mjs';

// v0.4.0 sleep mode (/turbo-autonomous away, turbo-run away | away --set | back): the owner answers ahead what can be
// answered, leaves, and gets a morning summary on return. Auto answers keep their limit (owner.auto_answer_minutes).

// The run's range while it is not finished (null: every phase), as start keeps it.
const rangeOf = (sup) => (sup && !sup.finished && sup.range ? sup.range : null);

// Every open question the owner can answer now, after the questions of every unfinished phase of the range that no
// lane runs and that has no questions file yet were built from its plans (asked ahead, spec §5.1). A running lane's
// plans live in its slot and its questions file is its own; an existing file is the lane's too: neither is rebuilt.
export function gatherAhead({ root, phases = [], sup = null, lang = 'en', now = new Date(), warn = () => {} }) {
  const range = rangeOf(sup);
  const running = new Set(supervisorLanes(sup, root).filter((l) => l.job === 'phase').map((l) => String(l.phase)));
  for (const p of phases) {
    const n = String(p.number);
    if (isFinished(p) || !inRange(n, range) || running.has(n) || !findPhaseDir(root, n)) continue;
    if (readJson(questionsFile(root, n), null) !== null) continue;
    refreshQuestions(root, n, { lang, warn, now });
  }
  return openQuestions(root);
}

// turbo-run away --set: the owner leaves now; the snapshot is each phase's progress, for the morning summary.
export function setAway(root, { phases = [], now = new Date() } = {}) {
  const prev = readAway(root);
  const snapshot = { phases: Object.fromEntries(phases.map((p) => [String(p.number), { done: isFinished(p), plans: plansOf(root, p.number)?.done ?? 0 }])) };
  const rec = { since: now.toISOString(), ackAt: prev.ackAt, snapshot };
  writeAway(root, rec);
  return rec;
}

// turbo-run back: what happened while the owner was away (the auto answers: every one since they last came back, the
// ones the pane listed), and the mode off (ackAt now: the pane stops listing the
// auto answers they saw here). Phases are GSD's (loadPhases), sup the supervisor's record, commits the reader of the
// last commits (view's recentCommits).
export function backSummary({ root, phases = [], sup = null, now = new Date(), commits = recentCommits }) {
  const away = readAway(root);
  const since = away.since;
  const from = since ? Date.parse(since) : away.ackAt ? Date.parse(away.ackAt) : -Infinity;
  const snap = away.snapshot?.phases ?? {};
  const progressed = [];
  if (since) {
    for (const p of phases) {
      const n = String(p.number);
      const before = snap[n];
      if (!before || before.done) continue;
      const plans = plansOf(root, n);
      const finished = isFinished(p);
      const done = plans?.done ?? 0;
      if (finished || done > (before.plans ?? 0)) progressed.push({ phase: n, finished, before: before.plans ?? 0, done, total: plans?.total ?? 0 });
    }
  }
  const changes = since ? commits(root, 50).filter((c) => Date.parse(c.at) >= from) : [];
  const failures = supervisorLanes(sup, root).map((l) => {
    const key = l.job === 'annotate' ? 'annotate' : String(l.phase);
    const rec = readLaneStatus(root, key);
    return rec && ['failed', 'needs-owner'].includes(rec.status) ? { phase: key, status: rec.status, reason: clean(String(rec.reason ?? '')) } : null;
  }).filter(Boolean);
  if (sup?.halted) failures.push({ phase: null, status: 'halted', reason: '' });
  const summary = { wasAway: Boolean(since), since, progressed, commits: changes, autoAnswered: autoAnswers(root, { after: away.ackAt }), waiting: openQuestions(root), failures };
  writeAway(root, { since: null, ackAt: now.toISOString(), snapshot: null });
  return summary;
}

const T = {
  en: {
    off: 'Away mode was not on (turbo-run away --set turns it on).',
    head: (t) => `Welcome back. You were away since ${t}.`,
    phases: 'Phases:', none: 'No phase moved on.',
    finished: (p) => `  Phase ${p}: done`, plans: (p, d, n, b) => `  Phase ${p}: ${d} of ${n} plans done (was ${b})`,
    commits: (n) => `Commits: ${n}`,
    auto: (n) => `Accepted automatically (${n}):`, undo: 'undo',
    waiting: (n) => `Waiting for your answer (${n}) — /turbo-autonomous answer:`,
    failures: 'Failures:', phase: (p) => `phase ${p}`, halted: 'the supervisor stopped',
  },
  ru: {
    off: 'Режим «ушёл» не был включён (включить: turbo-run away --set).',
    head: (t) => `С возвращением! Вас не было с ${t}.`,
    phases: 'Фазы:', none: 'Ни одна фаза не продвинулась.',
    finished: (p) => `  Фаза ${p}: готова`, plans: (p, d, n, b) => `  Фаза ${p}: планов готово ${d} из ${n} (было ${b})`,
    commits: (n) => `Коммитов: ${n}`,
    auto: (n) => `Принято автоматически (${n}):`, undo: 'отменить',
    waiting: (n) => `Ждут вашего ответа (${n}) — /turbo-autonomous answer:`,
    failures: 'Сбои:', phase: (p) => `фаза ${p}`, halted: 'супервизор остановился',
  },
};
const pad = (n) => String(n).padStart(2, '0');
const clock = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const one = (s, n = 200) => {
  const t = clean(String(s ?? '')).replace(/\s+/g, ' ').trim();
  return [...t].length > n ? `${[...t].slice(0, n - 1).join('')}…` : t;
};

// The morning summary in the owner's language: plain lines, commands as written.
export function formatBack(s, lang = 'en') {
  const t = Object.hasOwn(T, lang) ? T[lang] : T.en;
  const lines = [];
  if (!s.wasAway) lines.push(t.off);
  else {
    lines.push(t.head(clock(s.since)));
    if (s.progressed.length) {
      lines.push(t.phases);
      for (const p of s.progressed) lines.push(p.finished ? t.finished(p.phase) : t.plans(p.phase, p.done, p.total, p.before));
    } else lines.push(t.none);
    lines.push(t.commits(s.commits.length));
    for (const c of s.commits.slice(0, 3)) lines.push(`  ${one(c.subject, 120)}`);
  }
  if (s.autoAnswered.length) {
    lines.push(t.auto(s.autoAnswered.length));
    for (const a of s.autoAnswered) {
      lines.push(`  ${one(a.question, 300)} → ${one(a.option, 80)}`);
      lines.push(`    ${t.undo}: ${a.undo}`);
    }
  }
  if (s.waiting.length) {
    lines.push(t.waiting(s.waiting.length));
    for (const q of s.waiting) lines.push(`  ${t.phase(q.phase)}: ${one(q.question || q.header, 200)}`);
  }
  if (s.failures.length) lines.push(`${t.failures} ${s.failures.map((f) => (f.status === 'halted' ? t.halted : `${t.phase(f.phase)} — ${one(f.reason || f.status, 160)}`)).join('; ')}`);
  return lines.join('\n');
}

// turbo-run away [--json] | away --set | back [--json] (the owner's commands). deps: loadPhases() -> GSD's phases
// (none when gsd-core is missing: only the questions already built are listed), sup (supervisor.json or null),
// config, now(), commits.
export function runAwayCommand(cmd, args, { root, out, deps }) {
  const json = args.includes('--json');
  const now = deps.now ? deps.now() : new Date();
  const lang = deps.config?.lang === 'ru' ? 'ru' : 'en';
  if (cmd === 'back') {
    const s = backSummary({ root, phases: deps.loadPhases(), sup: deps.sup, now, ...(deps.commits ? { commits: deps.commits } : {}) });
    out(json ? JSON.stringify(s) : formatBack(s, lang));
    return 0;
  }
  if (args.includes('--set')) {
    const rec = setAway(root, { phases: deps.loadPhases(), now });
    const minutes = deps.config?.owner?.auto_answer_minutes;
    const auto = Number.isInteger(minutes) && minutes > 0;
    const say = lang === 'ru'
      ? [`ушли с ${rec.since}`, auto ? `безопасные вопросы turbo решит сам через ${minutes} мин` : 'автоответы выключены (owner.auto_answer_minutes = 0): вопросы будут ждать вас', 'когда вернётесь: turbo-run back']
      : [`away since ${rec.since}`, auto ? `turbo takes the safe questions itself after ${minutes} min` : 'automatic answers are off (owner.auto_answer_minutes is 0): questions wait for you', 'when you are back: turbo-run back'];
    out(json ? JSON.stringify({ ...rec, autoAnswerMinutes: auto ? minutes : 0 }) : say.join('; '));
    return 0;
  }
  const list = gatherAhead({ root, phases: deps.loadPhases(), sup: deps.sup, lang, now, warn: (l) => out(`warn: ${l}`) });
  if (json) out(JSON.stringify(list));
  else if (!list.length) out('no open questions');
  else for (const q of list) out(`p${q.phase} ${q.id} · ${q.kind}${q.stopped ? ' (stopped)' : ''} · ${one(q.question || q.header, 200)}`);
  return 0;
}
