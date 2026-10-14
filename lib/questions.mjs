import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDir, stateRoot } from './paths.mjs';
import { ensureDir, readJson, renameWithRetry, writeJsonAtomic } from './fsx.mjs';
import { maskSecrets } from './secrets.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { parseCheckpoints, quotedSignal } from './checkpoints.mjs';
import { noteStep } from './phase-progress.mjs';
import { writeLaneStatus } from './run-status.mjs';

// Owner questions (spec §5.1–§5.4, S1). One question per checkpoint task of a plan without a SUMMARY yet.

export const QUESTION_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEADER_MAX = 12;
// the turbo-view mod (S3) draws a question and its option labels in full up to these limits
const QUESTION_MAX = 300;
const CONTEXT_MAX = 600;
const LABEL_MAX = 80;
const DESCRIPTION_MAX = 200;

// turbo's own options and conditions, in the owner's language (config.lang). [label, description].
const LABELS = {
  en: {
    accept: ['Accept if the checks pass', 'The phase accepts it once all the automatic checks of the plan pass, and keeps the proof.'],
    show: ['Stop and show me', 'The phase stops at this step and asks you then.'],
    approved: ['Approved', 'You checked it the way the plan describes.'],
    later: ['I will do it when the phase asks', 'The phase stops at this step and asks you then.'],
    done: ['Done', 'You did it; the phase checks the result and goes on.'],
    doLater: ['I will do it later', 'The phase goes on with what it can do without it and asks again when it cannot go on without it.'],
    need: 'You are needed: ',
    verify: 'Verify: ',
    action: 'Action: ',
    decisionCondition: 'the checkpoint offers the options the plan lists',
    verifyCondition: 'every automated check in how-to-verify passed, and the evidence is attached',
  },
  ru: {
    accept: ['Принять, если проверки прошли', 'Фаза примет сама, когда пройдут все автоматические проверки из плана, и сохранит доказательства.'],
    show: ['Остановиться и показать мне', 'Фаза остановится на этом шаге и спросит вас тогда.'],
    approved: ['Принято', 'Вы проверили так, как описано в плане.'],
    later: ['Сделаю, когда фаза попросит', 'Фаза остановится на этом шаге и спросит вас тогда.'],
    done: ['Сделано', 'Вы это сделали; фаза проверит результат и продолжит.'],
    doLater: ['Сделаю позже', 'Фаза пока сделает то, что можно без этого, и спросит снова, когда без этого не обойтись.'],
    need: 'Нужно от вас: ',
    verify: 'Проверка: ',
    action: 'Действие: ',
    decisionCondition: 'на чекпоинте те же варианты, что в плане',
    verifyCondition: 'все автоматические проверки из плана прошли, и доказательства приложены',
  },
};

// v0.4.0 (auto-answer): the condition a verification answered for the owner holds only under, in their language
export const verifyCondition = (lang) => (Object.hasOwn(LABELS, lang) ? LABELS[lang] : LABELS.en).verifyCondition;

// The card's last resort when no owner text of the plan passes the plain-words check: plan number within the phase
// and task number only.
const PENDING = {
  en: (plan, task) => `Plan ${plan}, task ${task} is waiting for your decision: see the plan for details`,
  ru: (plan, task) => `План ${plan}, задача ${task} ждёт вашего решения: подробности в плане`,
};

// by code points, so a surrogate pair is never split; masked first, so a cut never hides a secret from the rules
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const show = (s, n) => cut(maskSecrets(String(s ?? '')), n);

// The owner's text cut to n code points (masked first), at a word where one is near the end, with an ellipsis.
function fit(s, n) {
  const m = maskSecrets(String(s ?? ''));
  if ([...m].length <= n) return m;
  const head = cut(m, n - 1);
  const space = head.lastIndexOf(' ');
  return `${space > head.length * 0.8 ? head.slice(0, space) : head}…`;
}

export const questionId = (plan, task) => `${plan}-t${task}`;

// The owner's text of a checkpoint (owner cards). A plan written for the owner keeps the executor's instructions next
// to the owner's words, often in another language; the card shows the owner's words only. The heuristic:
// - <action> is the executor's. It is a human-action's question only as GSD's own template writes it: one plain
//   sentence with no executor line ("<action>Complete the email verification</action>"), and only after the
//   owner block's short verdict and the task name.
// - A line that introduces the owner's text (OWNER_INTRO: it ends with a colon and says "for the owner", "to the
//   owner", «для владельца» or «владельцу») ends the executor's part of a field: only the lines after it are read.
// - A line addressed to the executor (EXECUTOR_LINE) is left out with the lines indented under it: it names the
//   executor, says "before presenting", tells to present something to the owner (or as is, as prepared, exactly,
//   first), starts with "run verify", or starts with a command in backticks.
// - Tags, bold and heading marks and list bullets are taken out; a paragraph, a list item or a bold label
//   ("**Коротко:**") is a unit, its sentences checked like turbo-run ask's texts: a sentence with an id (jargonIn) is
//   left out, and so is, for a Russian owner, one with English words and no Russian one.
// The question: a decision's <decision>, then the first sentence of a «Коротко» / "In short" / "Summary" / "Verdict"
// unit, then the task <name> (human-action: then the plain <action>); a human-verify's what-built first sentence after
// its verdict. A Russian owner's question holds a Russian word. Nothing plain: PENDING, in the card's language.
const EXECUTOR_LINE = [
  /\bexecutor\b/i,
  /(?:^|[^а-яё])исполнител/i,
  /\bbefore presenting\b|перед показом/i,
  /\bpresent\b.*\b(?:to the owner|as is|as prepared|exactly|first)\b/i,
  /^(?:[-*+]\s*|\d+[.)]\s*|\([a-z0-9]\)\s*)?run verify\b/i,
];
// a command in backticks first: the executor's in an <action> or a <context>; in the owner's own fields (what-built,
// how-to-verify, instructions, verification) a command the owner runs
const COMMAND_LINE = /^(?:[-*+]\s*|\d+[.)]\s*|\([a-z0-9]\)\s*)?`[^`]+`/;
const OWNER_INTRO = /(?:\b(?:for|to) the owner\b|для владельца|владельцу)[^:]*:$/i;
const SHORT_LABEL = /^(?:коротко|кратко|вкратце|итог|вердикт|in short|short|summary|verdict|tl;?dr)$/i;
const TAG = /<\/?[a-z][a-z0-9_-]*(?:\s+[a-z_][\w-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g;
const ENTITY = { lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", amp: '&' };
const decodeText = (s) => String(s ?? '').replace(/&(lt|gt|quot|apos|#39|amp);/g, (_, e) => ENTITY[e]);
const squashText = (s) => decodeText(s).replace(/\s+/g, ' ').trim();
const BOLD_LABEL = /^(?:\*\*|__)([^*_\n]+?):?(?:\*\*|__):?\s*/;
const LIST_ITEM = /^(?:[-*+•]\s+|\d+[.)]\s)/;
// a line without its tags, heading or quote mark (entities read first, so an encoded tag goes too)
const bareLine = (s) => decodeText(s).replace(TAG, '').replace(/^#+\s+|^>\s?/, '').trim();
// a one-line text (a decision, a task name, an action) as the owner reads it: no tag, bullet or bold mark
const cleanText = (s) => String(s ?? '').split('\n').map((l) => bareLine(l).replace(/^[-*+•]\s+/, '').replace(/\*\*|__/g, ''))
  .join(' ').replace(/\s+/g, ' ').trim();
// a sentence ends at . ! ? or … and a space; "1." of a numbered step is no sentence of its own
const sentencesOf = (s) => s.replace(/\s+/g, ' ').trim().split(/(?<=[^\d\s][.!?…]|[!?…])\s+/).filter(Boolean);
const indentOf = (l) => l.length - l.trimStart().length;

// The lines of a field the owner reads, secrets masked: after the line that introduces the owner's text (when what
// precedes it is the executor's), without the executor's lines and the lines indented under them. commands: a line
// that starts with a command in backticks is the executor's too.
function ownerLines(text, { plain = () => true, commands = true } = {}) {
  let lines = String(text ?? '').split('\n').map((l) => maskSecrets(l));
  const executor = (t) => EXECUTOR_LINE.some((re) => re.test(t)) || (commands && COMMAND_LINE.test(t));
  const intro = lines.findIndex((l) => OWNER_INTRO.test(l.trim()));
  if (intro >= 0) {
    const before = lines.slice(0, intro).map((l) => l.trim()).filter(Boolean);
    if (before.some(executor) || !before.some(plain)) lines = lines.slice(intro + 1);
  }
  // a first line written on the tag's line has no indent of its own: it takes the smallest of the others
  const others = lines.slice(1).filter((l) => l.trim()).map(indentOf);
  const out = [];
  let drop = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    const indent = i === 0 && indentOf(line) === 0 && others.length ? Math.min(...others) : indentOf(line);
    if (drop !== null && t && indent > drop) return;
    drop = null;
    if (executor(t)) {
      drop = indent;
      return;
    }
    out.push(t);
  });
  return out;
}

// The owner's units of a field: { label, sentences }, the sentences that pass plain().
function ownerUnits(text, plain, commands) {
  const units = [];
  let cur = null;
  for (const raw of ownerLines(text, { plain, commands })) {
    const line = bareLine(raw);
    if (!line) {
      cur = null;
      continue;
    }
    const label = BOLD_LABEL.exec(line);
    if (label || LIST_ITEM.test(line) || !cur) {
      cur = { label: label && plain(label[1]) ? label[1].trim() : '', text: [] };
      units.push(cur);
    }
    const rest = (label ? line.slice(label[0].length) : line).replace(/^[-*+•]\s+/, '').replace(/\*\*|__/g, '').trim();
    if (rest) cur.text.push(rest);
  }
  return units.map((u) => ({ label: u.label, sentences: sentencesOf(u.text.join(' ')).filter(plain) }))
    .filter((u) => u.label || u.sentences.length);
}

// The units as one line; skip: the [unit, sentence] the question took (a unit it empties goes, label and all).
function renderUnits(units, skip = null) {
  return units.map((u, i) => {
    const s = u.sentences.filter((_, k) => !(skip && skip[0] === i && skip[1] === k));
    if (skip && skip[0] === i && !s.length) return '';
    return [u.label && `${u.label}:`, ...s].filter(Boolean).join(' ');
  }).filter(Boolean).join(' ');
}

// The question and context of a checkpoint in the owner's words (see the heuristic above).
function ownerCard(cp, { phase, plan, lang, planIds }) {
  const plain = (s) => {
    const t = String(s ?? '').trim();
    return Boolean(t) && !jargonIn(t, planIds) && !(lang === 'ru' && ENGLISH_WORD.test(t) && !CYRILLIC.test(t));
  };
  const asked = (s) => plain(s) && (lang !== 'ru' || CYRILLIC.test(s));
  // a field's lines when they are the field's text (a caller may have set the field alone)
  const text = (k) => (cp.raw && squashText(cp.raw[k]) === String(cp[k] ?? '') ? cp.raw[k] : cp[k]) ?? '';
  const units = (k) => ownerUnits(text(k), plain, k === 'context');
  const at = (us, pick) => {
    const u = us.findIndex(pick);
    return u >= 0 ? { s: us[u].sentences[0], skip: [u, 0] } : null;
  };
  const short = (us) => at(us, (x) => SHORT_LABEL.test(x.label) && x.sentences.length);
  const first = (us) => at(us, (x) => x.sentences.length);
  const line = (s) => (s ? { s, skip: null } : null);
  const name = line(cleanText(text('name')).replace(/^(?:task|задача)\s*\d+\s*[:.)—–-]\s*/i, ''));
  const pick = (list) => list.find((c) => c && asked(c.s)) ?? null;
  let q;
  let context;
  if (cp.kind === 'decision') {
    const ctx = units('context');
    q = pick([line(cleanText(text('decision'))), short(ctx), name]);
    context = renderUnits(ctx, q?.skip);
  } else if (cp.kind === 'human-verify') {
    const built = units('whatBuilt');
    q = pick([short(built), first(built), name]);
    context = [renderUnits(built, q?.skip), renderUnits(units('howToVerify'))].filter(Boolean).join(' ');
  } else {
    const ins = units('instructions');
    const action = text('action');
    const lines = action.split('\n').filter((l) => l.trim());
    const own = ownerLines(action).filter(Boolean);
    const sentences = sentencesOf(own.join(' '));
    const clean = own.length === lines.length && sentences.length === 1 ? line(cleanText(action)) : null;
    q = pick([short(ins), name, clean, first(ins)]);
    context = [renderUnits(ins, q?.skip), renderUnits(units('verification'))].filter(Boolean).join(' ');
  }
  // the plan's number within its phase (32-09 -> 9, 02.1-03 -> 3), never its id
  const number = (/-([^-]+)$/.exec(String(plan))?.[1] ?? String(plan)).replace(/^0+(?=\d)/, '');
  const pending = (Object.hasOwn(PENDING, lang) ? PENDING[lang] : PENDING.en)(number, cp.task);
  return { question: q ? q.s : pending, context };
}

// The question for one checkpoint (spec §5.1). stopped: the lane stands at it now, so the options are the
// answers the waiting agent takes: no condition, no "ask me then".
// planIds: the phase's plans, whose ids no owner text holds (jargonIn).
// own: the question in the lane's own words (dynamicQuestion), shown as given, with no context.
export function buildQuestion(cp, { phase, plan, lang = 'en', stopped = false, planIds = [], own = null }) {
  const L = Object.hasOwn(LABELS, lang) ? LABELS[lang] : LABELS.en;
  const owner = own === null ? ownerCard(cp, { phase, plan, lang, planIds }) : { question: String(own).trim(), context: '' };
  const option = ([label, description], signal, more = {}) => ({
    label: show(label, LABEL_MAX),
    description: show(description, DESCRIPTION_MAX),
    recommended: false,
    signal: signal === null ? null : show(signal, LABEL_MAX),
    defer: false,
    ...more,
  });
  let question = owner.question;
  const context = owner.context;
  let options;
  let condition = null;
  let allowOther = true;
  if (cp.kind === 'decision') {
    // recommended only where the plan itself marked it (auto_select), listed first
    const list = cp.options.map((o) => option(
      [o.name || o.id, [o.pros && `+ ${o.pros}`, o.cons && `− ${o.cons}`].filter(Boolean).join(' ')],
      o.id || o.name,
      { recommended: Boolean(cp.autoSelect) && o.id === cp.autoSelect },
    ));
    options = [...list.filter((o) => o.recommended), ...list.filter((o) => !o.recommended)];
    if (!stopped) condition = L.decisionCondition;
  } else if (cp.kind === 'human-verify') {
    question = `${L.verify}${question}`;
    const signal = quotedSignal(cp.resumeSignal, 'approved');
    options = stopped ? [option(L.approved, signal)] : [option(L.accept, signal), option(L.show, null, { defer: true })];
    if (!stopped) condition = L.verifyCondition;
  } else {
    question = `${L.action}${question}`;
    // ahead only "I will do it when the lane asks": a human action always stays a stop (spec §5.1)
    options = stopped ? [option(L.done, quotedSignal(cp.resumeSignal, 'done'))] : [option(L.later, null, { defer: true })];
    allowOther = stopped;
  }
  return {
    id: questionId(plan, cp.task),
    phase: String(phase),
    plan: String(plan),
    task: String(cp.task),
    kind: cp.kind,
    gate: cp.gate || 'blocking',
    header: cut(`${plan} T${cp.task}`, HEADER_MAX),
    question: fit(question, QUESTION_MAX),
    context: fit(context, CONTEXT_MAX),
    options,
    allowOther,
    condition,
    class: cp.kind === 'human-action' ? 'owner-only' : 'decision',
    topic: null,
    classified: false,
    agentId: null,
    stopped,
    state: 'open',
    answer: null,
    delivery: null,
    rev: 1,
    source: 'plan',
  };
}

// A checkpoint that is no task of the plan (an authentication gate, an unmet precondition), named by the lane at
// the stop with an id <plan>-t<task>.
export function dynamicQuestion({ phase, id, kind, question, lang = 'en' }) {
  const m = /^(.+)-t(\d+)$/.exec(String(id));
  if (!m) throw new Error(`question id ${id} is not <plan>-t<task>`);
  const cp = { task: Number(m[2]), kind, gate: 'blocking-human', decision: '', context: '', options: [], resumeSignal: '', whatBuilt: question, howToVerify: '', action: question, instructions: '', verification: '' };
  return { ...buildQuestion(cp, { phase, plan: m[1], lang, stopped: true, own: question }), source: 'stop' };
}

// v0.3.3 (D2): what owner text must never hold — turbo's and GSD's own ids. [what it is, pattern], first match named.
// Narrow on purpose (review 1): ranges, times, versions, standards (SHA-256, RFC-7231) and product names (Node.js)
// pass. Finding codes are GSD's review (CR, BL, WR, IN) and gap (G) codes; a hash has 3 digits or more and a letter
// a-f; a file name has a code extension after an all-lowercase or all-uppercase stem; a path has a slash.
const JARGON = [
  ['finding code', /\b(?:[A-Z0-9]+-)*(?:CR|BL|WR|IN)-\d+\b|\bG-\d+(?:-\d+)?\b/],
  ['question id', /\bask-\d+\b|(?<![\w.-])\d+(?:\.\d+)?(?:-\d+)+-t\d+\b/i],
  ['commit hash', /\b(?=(?:[a-f]*\d){3})(?=[0-9]*[a-f])[0-9a-f]{7,40}\b/],
  ['file name', /(?<![\w.-])(?:[a-z0-9][a-z0-9_-]*|[A-Z0-9][A-Z0-9_-]*)(?:\.[a-z0-9_-]+)*\.(?:md|json|mjs|cjs|js|ts|tsx|py|ya?ml)\b/],
  // a path: ./ or ../ first, three segments or more, or two with a code-like one (my_util, a.b, x-y); «and/or», «on/off»
  // and dates are no path, and a URL is left out before any check
  ['path', /(?<![\w/.])\.{1,2}\/[\w./-]*|(?<![\w/.])(?=[\w./-]*[a-z])[\w.-]+(?:\/[\w.-]+){2,}|(?<![\w/.])(?=[\w./-]*[a-z])(?=[\w./-]*[A-Za-z0-9][._-][A-Za-z0-9])[\w.-]+\/[\w.-]+/],
];
const CYRILLIC = /[А-Яа-яЁё]/;
// a Latin word of 3 letters or more with a lowercase one: "Fix first", not "CI" or "OK"
const ENGLISH_WORD = /\b(?=[A-Za-z]*[a-z])[A-Za-z]{3,}\b/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Why an owner text is not plain, or null: the first id it holds, named with its kind. planIds: the phase's plans,
// whose ids alone count as plan ids (a range such as 10-20 is no plan).
export function jargonIn(text, planIds = []) {
  // a URL (scheme://…) is the owner's to open, never jargon
  const t = String(text ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  for (const id of planIds) {
    const m = new RegExp(`(?<![\\w.-])${escapeRe(String(id))}(?![\\w-])`).exec(t);
    if (m) return `plan id ${m[0]}`;
  }
  for (const [kind, re] of JARGON) {
    const m = re.exec(t);
    if (m) return `${kind} ${m[0]}`;
  }
  return null;
}

export const LANE_OPTIONS_MIN = 2;
export const LANE_OPTIONS_MAX = 4;
export const ASK_ID = /^ask-(\d+)$/;

// v0.3.3 (D1, D2): the question a lane asks at a stop that is no checkpoint, with its own options (a decision) or
// turbo's done / later (owner-only work, action). Written in the owner's language with no ids: every text is checked
// (jargonIn), a Russian owner's question must hold a Russian word. Capped and masked like buildQuestion; the
// recommended option goes first, marked. Throws with the reason, so nothing is written.
// autoOk (v0.4.0): turbo may take the recommended option itself after owner.auto_answer_minutes (lib/auto-answer.mjs).
export function laneQuestion({ phase, id, question = '', context = '', options = [], recommended = null, action = null, lang = 'en', planIds = [], autoOk = false }) {
  const L = Object.hasOwn(LABELS, lang) ? LABELS[lang] : LABELS.en;
  const option = ([label, description], rec = false) => {
    const l = show(String(label ?? '').trim(), LABEL_MAX);
    if (!l) throw new Error('every --option needs a label before its |: "<label>|<description>"');
    const d = show(String(description ?? '').trim(), DESCRIPTION_MAX);
    return { label: l, description: d, recommended: rec, signal: l, defer: false };
  };
  let kind;
  let text;
  let list;
  if (action !== null && action !== undefined) {
    if (options.length || recommended !== null) throw new Error('--action takes no --option and no --recommended: its options are turbo\'s (done, later)');
    if (!String(action).trim()) throw new Error('--action needs the one thing the owner must do, in plain words');
    kind = 'human-action';
    text = `${L.need}${String(action).trim()}`;
    list = [option(L.done), option(L.doLater)];
  } else {
    if (!String(question).trim()) throw new Error('--question needs the question in plain words: what was done, what is asked, why it matters');
    if (options.length < LANE_OPTIONS_MIN || options.length > LANE_OPTIONS_MAX) throw new Error(`a question needs ${LANE_OPTIONS_MIN} to ${LANE_OPTIONS_MAX} options (--option "<label>|<description>")`);
    if (!Number.isInteger(recommended) || recommended < 1 || recommended > options.length) throw new Error(`--recommended needs the number of the recommended option, 1 to ${options.length}`);
    kind = 'decision';
    text = String(question).trim();
    const built = options.map((o, i) => option([o.label, o.description], i + 1 === recommended));
    list = [...built.filter((o) => o.recommended), ...built.filter((o) => !o.recommended)];
  }
  // the lane's own words: the action without turbo's prefix, the options a decision has (turbo's are plain already)
  const own = kind === 'human-action' ? String(action).trim() : text;
  const texts = [['the question', own], ['the context', context], ...(kind === 'decision' ? list.flatMap((o, i) => [[`option ${i + 1}`, o.label], [`option ${i + 1}`, o.description]]) : [])];
  for (const [where, t] of texts) {
    const bad = jargonIn(t, planIds);
    if (bad) throw new Error(`${where} holds the ${bad}: the owner reads plain words, so say what it is instead (no ids, plan numbers, finding codes, hashes, file names or paths)`);
    // review 1: every text of a Russian owner, the action and the options included; an acronym (CI, OK) alone is no English
    if (lang === 'ru' && ENGLISH_WORD.test(t) && !CYRILLIC.test(t)) throw new Error(`${where} has no Russian word: config.lang is ru, so write it in Russian, in plain words`);
  }
  if (lang === 'ru' && !CYRILLIC.test(own)) throw new Error('the question has no Russian word: config.lang is ru, so write it in Russian, in plain words');
  return {
    id, phase: String(phase), plan: null, task: null, kind, gate: 'blocking', header: '',
    question: show(text, QUESTION_MAX), context: show(String(context ?? '').trim(), CONTEXT_MAX),
    options: list, allowOther: true, condition: null,
    class: kind === 'human-action' ? 'owner-only' : 'decision', topic: null, classified: true,
    agentId: null, stopped: true, state: 'open', answer: null, delivery: null, rev: 1, source: 'lane', autoOk: autoOk === true,
  };
}

// turbo-run ask N (D2): the lane's question goes in as ask-<k> (k after every ask id of the questions and the answers
// file: an answer in git outlives the run directory), an older open lane question of the phase is superseded, and the
// lane's needs-owner record names it. Returns { question, superseded }.
export function askOwner(root, phase, input, { lang = 'en', now = new Date() } = {}) {
  const r = withPhaseLock(root, phase, () => {
    const list = readQuestions(root, phase);
    const used = [...list, ...readAnswers(root, phase)].map((x) => ASK_ID.exec(x.id)).filter(Boolean).map((m) => Number(m[1]));
    const id = `ask-${Math.max(0, ...used) + 1}`;
    const dir = findPhaseDir(root, phase);
    const planIds = dir ? phaseArtifacts(dir).plans.map((p) => p.id) : [];
    const question = { ...laneQuestion({ ...input, phase, id, lang, planIds }), askedAt: now.toISOString() };
    const superseded = list.filter((q) => q.source === 'lane' && q.state === 'open').map((q) => q.id);
    writeQuestions(root, phase, [...list.filter((q) => !superseded.includes(q.id)), question]);
    return { question, superseded };
  });
  writeLaneStatus(root, phase, 'needs-owner', { reason: `owner question ${r.question.id}`, at: now.toISOString() });
  return r;
}

// spec §5.1: the lane's classes. consent:deploy is a deploy consent (class consent, topic deploy), the only one the
// standing deploy rule answers.
export const CLASSES = Object.freeze(['owner-only', 'consent', 'consent:deploy', 'decision', 'verify']);

// run/p<N>-questions.json (git-ignored) holds the questions; .planning/turbo/answers/p<N>.json (in git) the answers,
// newest last. Both change only inside withPhaseLock, so the first answer wins whichever channel sent it.
export const questionsFile = (root, phase) => path.join(runDir(root), `p${phase}-questions.json`);
export const answersRel = (phase) => `.planning/turbo/answers/p${phase}.json`;
// spec §4.2: the owner's answers live in the control root, also when a lane in a slot reads or writes them
const answersFile = (root, phase) => path.join(stateRoot(root), ...answersRel(phase).split('/'));
export const lockFile = (root, phase) => path.join(runDir(root), `p${phase}-questions.lock`);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const listOf = (file) => {
  const v = readJson(file, []);
  return Array.isArray(v) ? v.filter((x) => isObj(x) && typeof x.id === 'string') : [];
};
export const readQuestions = (root, phase) => listOf(questionsFile(root, phase));
export const readAnswers = (root, phase) => listOf(answersFile(root, phase));
export const writeQuestions = (root, phase, list) => writeJsonAtomic(questionsFile(root, phase), list);
// The answers directory holds only p<N>.json in git: its own .gitignore keeps out everything else, the temporary
// files of writeJsonAtomic (p<N>.json.tmp-<pid>, also one a crash left) included, so a commit of the whole directory
// (the lane's, the skill's Commit the answers) never takes one in. Checked before every write by its content (a crash
// may have left it empty or cut; line endings aside) and written atomically: its temporary file lies in the
// git-ignored run directory, never in answers/, and its rename is tried again while Windows refuses it. A rule that
// still cannot be written never costs the answer: writeAnswers writes the answer and warns.
export const ANSWERS_IGNORE_REL = '.planning/turbo/answers/.gitignore';
const ANSWERS_IGNORE = '*\n!p*.json\n!.gitignore\n';
function ensureAnswersIgnore(root) {
  const file = path.join(root, ...ANSWERS_IGNORE_REL.split('/'));
  let now = null;
  try {
    now = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  } catch { /* absent */ }
  if (now === ANSWERS_IGNORE) return;
  ensureDir(path.dirname(file));
  ensureDir(runDir(root));
  const tmp = path.join(runDir(root), `answers-gitignore.tmp-${process.pid}-${randomUUID()}`);
  try {
    fs.writeFileSync(tmp, ANSWERS_IGNORE);
    renameWithRetry(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
const stderrLine = (line) => process.stderr.write(`${line}\n`);
export function writeAnswers(root, phase, list, { warn = stderrLine } = {}) {
  let why = null;
  try {
    ensureAnswersIgnore(stateRoot(root));
  } catch (err) {
    why = String(err?.message ?? err).split(/\r?\n/)[0];
  }
  writeJsonAtomic(answersFile(root, phase), list);
  if (why) warn(`warn: ${ANSWERS_IGNORE_REL} not written (${why}); the answer is written all the same`);
}

// The answer that stands for a question: its newest record that no stop superseded.
export function liveAnswer(records, id) {
  for (let i = records.length - 1; i >= 0; i--) if (records[i].id === id && !records[i].superseded) return records[i];
  return null;
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Windows reports a lock file that another process is deleting (delete pending) as EPERM or EACCES, on open and on
// stat: there that is a busy lock, not an error.
const busy = (err, platform) => err?.code === 'EEXIST' || (platform === 'win32' && (err?.code === 'EPERM' || err?.code === 'EACCES'));

// The lock file's time and owner token, or null while it is gone or being deleted.
function lockState(file) {
  try {
    const { mtimeMs } = fs.statSync(file);
    return { mtimeMs, token: fs.readFileSync(file, 'utf8') };
  } catch {
    return null;
  }
}

// Takes over a lock a crash left: it is moved aside under a name only this process uses, so of two processes that
// judged the same lock stale only one moves it. When what was moved is not the lock judged stale (another process
// took the lock meanwhile), it is put back, never over a lock taken since: a hard link, or without hard links an
// exclusive copy. Returns true when the stale lock is gone. A window stays: a third process may take the free lock
// between the move and the putting back; then the one whose lock was moved has lost it (its release then leaves the
// third one's lock alone), and two writers may overlap once. It needs two stealers and a fresh lock within
// microseconds of each other, after a crash.
function takeOver(file, seen, token) {
  const aside = `${file}.stale-${token}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    return false; // gone, moved by another process, or not movable here: waited on like a live lock
  }
  const moved = lockState(aside);
  const stale = !moved || (moved.token === seen.token && moved.mtimeMs === seen.mtimeMs);
  if (!stale) {
    try {
      fs.linkSync(aside, file);
    } catch (err) {
      if (err.code !== 'EEXIST') try { fs.copyFileSync(aside, file, fs.constants.COPYFILE_EXCL); } catch { /* taken again meanwhile */ }
    }
  }
  fs.rmSync(aside, { force: true });
  return stale;
}

// withPhaseLock waited waitMs in vain: nothing was changed, and the same call may work a moment later.
export class PhaseLocked extends Error {}

// One writer at a time on a lock file, an exclusive file holding its owner's token. A writer waits up to waitMs; a
// lock older than staleMs was left by a crash and is taken over (takeOver). The lock is released only while it still
// holds this writer's token. locked() makes the error thrown after waitMs in vain. alive(token), when given, says
// whether the lock's owner still runs: a live owner's lock is never taken over, however old.
export function withFileLock(file, fn, { waitMs, staleMs, platform = process.platform, locked, alive = null }) {
  ensureDir(path.dirname(file));
  const token = `${process.pid}-${randomUUID()}`;
  const until = Date.now() + waitMs;
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (err) {
      if (!busy(err, platform)) throw err;
    }
    if (fd !== null) {
      try {
        fs.writeSync(fd, token);
      } catch (err) {
        fs.closeSync(fd);
        fs.rmSync(file, { force: true });
        throw err;
      }
      fs.closeSync(fd);
      break;
    }
    const seen = lockState(file);
    // a stale lock moved aside: try at once; one that cannot be moved is waited on like a live lock
    if (seen && Date.now() - seen.mtimeMs > staleMs && !alive?.(seen.token) && takeOver(file, seen, token)) continue;
    if (Date.now() >= until) throw locked();
    sleepSync(seen ? 25 : 5);
  }
  try {
    return fn();
  } finally {
    if (lockState(file)?.token === token) fs.rmSync(file, { force: true });
  }
}

// Every change to a phase's questions or answers runs inside this lock.
export function withPhaseLock(root, phase, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, platform = process.platform } = {}) {
  const file = lockFile(root, phase);
  return withFileLock(file, fn, { waitMs, staleMs, platform, locked: () => new PhaseLocked(`the questions of phase ${phase} are locked by another turbo-run (${path.basename(file)}); try again`) });
}

// Every checkpoint of the phase's plans, the plans still open (no SUMMARY), and the plan files whose name cannot make
// a question id (QUESTION_ID: a space, a quote or a percent sign would reach a wake prompt, and turbo-run answer
// refuses such an id): their checkpoints are no questions. ids: every plan of the phase (no owner text holds one).
export function planCheckpoints(root, phase) {
  const dir = findPhaseDir(root, phase);
  const items = [];
  const open = new Set();
  const skipped = [];
  const ids = [];
  if (!dir) return { items, open, skipped, ids };
  for (const p of phaseArtifacts(dir).plans) {
    ids.push(p.id);
    if (!p.hasSummary) open.add(p.id);
    let text;
    try {
      text = fs.readFileSync(path.join(dir, p.file), 'utf8');
    } catch {
      continue;
    }
    const list = parseCheckpoints(text);
    if (list.some((cp) => !QUESTION_ID.test(questionId(p.id, cp.task)))) {
      skipped.push({ plan: p.id, file: p.file });
      continue;
    }
    for (const cp of list) items.push({ plan: p.id, cp });
  }
  return { items, open, skipped, ids };
}

// The question's state and answer summary from the answers file: open, answered, deferred (the owner wants to be
// asked at the stop), or delivered (kept once the lane delivered it).
function withAnswer(q, live, delivered) {
  if (!live) return { ...q, state: 'open', answer: null };
  const answer = { option: live.option, label: live.label, answer: live.answer, by: live.by, at: live.at, conditional: live.conditional };
  return { ...q, answer, state: live.defer ? 'deferred' : delivered ? 'delivered' : 'answered' };
}

const KEEP = ['class', 'topic', 'classified', 'agentId', 'stopped', 'delivery', 'askedAt'];

// What a rebuilt question keeps from its earlier version: the lane's class, the agent and the stop, the delivery, the
// time it was asked (v0.4.0, the auto-answer clock). rev counts changes of its options, so a channel that showed the
// old ones knows they are gone; new options are a new question: their clock starts again (now).
function carry(fresh, old, answers, now = null) {
  const q = { ...fresh };
  if (old) {
    for (const k of KEEP) if (old[k] !== undefined) q[k] = old[k];
    const same = JSON.stringify(old.options) === JSON.stringify(fresh.options) && old.allowOther === fresh.allowOther;
    q.rev = same ? old.rev || 1 : (old.rev || 1) + 1;
    if (!same) delete q.askedAt;
  }
  if (now && !q.askedAt) q.askedAt = now.toISOString();
  return withAnswer(q, liveAnswer(answers, q.id), old?.state === 'delivered');
}

// turbo-run questions N: the questions of the plans without a SUMMARY, rebuilt from the plans (spec §5.1). warn gets
// one line per open plan whose name cannot make a question id.
export function refreshQuestions(root, phase, { lang = 'en', warn = () => {}, now = new Date() } = {}) {
  return withPhaseLock(root, phase, () => {
    const { items, open, skipped, ids } = planCheckpoints(root, phase);
    for (const s of skipped) {
      if (open.has(s.plan)) warn(`plan ${s.file}: its name cannot make a question id (letters, digits, . _ - only, at most 64 characters with -t<task>), so its checkpoints are no owner questions; for the owner: rename the plan file; a lane never renames plan files`);
    }
    const prev = new Map(readQuestions(root, phase).map((q) => [q.id, q]));
    const answers = readAnswers(root, phase);
    const next = [];
    for (const { plan, cp } of items) {
      if (!open.has(plan)) continue;
      const old = prev.get(questionId(plan, cp.task));
      next.push(carry(buildQuestion(cp, { phase, plan, lang, stopped: Boolean(old?.stopped), planIds: ids }), old, answers, now));
    }
    // a checkpoint the lane named at a stop stays while its plan is open
    for (const q of prev.values()) {
      if (q.source === 'stop' && open.has(q.plan) && !next.some((x) => x.id === q.id)) next.push(carry(q, q, answers));
    }
    // a lane's own question (v0.3.3) stays until the lane took its answer
    for (const q of prev.values()) if (q.source === 'lane' && q.state !== 'delivered') next.push(carry(q, q, answers));
    writeQuestions(root, phase, next);
    return next;
  });
}

export function parseClasses(spec) {
  const pairs = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const at = s.indexOf('=');
    return at > 0 ? [s.slice(0, at).trim(), s.slice(at + 1).trim()] : [s, ''];
  });
  if (!pairs.length) throw new Error('--class needs <id>=<class>[,<id>=<class>…]');
  for (const [id, c] of pairs) if (!CLASSES.includes(c)) throw new Error(`unknown class ${c || '(none)'} for ${id}: use one of ${CLASSES.join(', ')}`);
  return pairs;
}

// turbo-run questions N --class <id>=<class>,…: the lane's classification (spec §5.1). Only class and topic change.
export function classifyQuestions(root, phase, spec) {
  const pairs = parseClasses(spec);
  return withPhaseLock(root, phase, () => {
    const list = readQuestions(root, phase);
    const missing = pairs.map(([id]) => id).filter((id) => !list.some((q) => q.id === id));
    if (missing.length) throw new Error(`no question ${missing.join(', ')} in phase ${phase}`);
    for (const [id, c] of pairs) {
      const [cls, topic] = c.split(':');
      Object.assign(list.find((q) => q.id === id), { class: cls, topic: topic || null, classified: true });
    }
    writeQuestions(root, phase, list);
    return list;
  });
}

export const DELIVERY_PATHS = Object.freeze(['same-agent', 'continuation', 'lane']);

// The lane stands at a checkpoint (spec §5.3): the executor agentId returned it. An answer that stands (not a
// preference to be asked, not one whose condition the executor reports unmet, not one already delivered to this
// checkpoint: an agent that returns the same checkpoint after its answer asks again) is delivered at once:
// "answered". Otherwise the question opens again as a stop, with the options the waiting agent takes: "stopped". A
// superseded answer stays in the answers file, marked with the time.
export function stopQuestion(root, phase, id, { agentId, unmet = false, kind = null, question = '', lang = 'en', now = new Date() } = {}) {
  // a checkpoint of a plan whose file name cannot make a question id (refreshQuestions skips it): the owner's
  if (!QUESTION_ID.test(String(id))) throw new Error(`not a question id: ${id}: its plan's file name cannot make an owner question; stop for the owner, and never rename the plan file`);
  if (!AGENT_ID.test(String(agentId ?? ''))) throw new Error('--agent needs the id of the agent that returned the checkpoint');
  return withPhaseLock(root, phase, () => {
    const list = readQuestions(root, phase);
    const at = list.findIndex((q) => q.id === id);
    const q = at >= 0 ? list[at] : null;
    const answers = readAnswers(root, phase);
    const live = liveAnswer(answers, id);
    if (q && live && !live.defer && !unmet && q.state !== 'delivered') {
      list[at] = { ...q, agentId, stopped: true };
      writeQuestions(root, phase, list);
      return { status: 'answered', question: list[at] };
    }
    if (live) {
      live.superseded = now.toISOString();
      writeAnswers(root, phase, answers);
    }
    const planned = q?.source === 'stop' ? null : planCheckpoints(root, phase);
    const found = planned?.items.find((x) => questionId(x.plan, x.cp.task) === id);
    let fresh;
    if (found) fresh = buildQuestion(found.cp, { phase, plan: found.plan, lang, stopped: true, planIds: planned.ids });
    else if (q) fresh = q;
    else if (['human-verify', 'human-action'].includes(kind) && String(question).trim()) fresh = dynamicQuestion({ phase, id, kind, question, lang });
    else throw new Error(`no question ${id} in phase ${phase}: for a checkpoint that is no task of the plan, add --kind human-verify|human-action and --question <one line>`);
    const next = {
      ...fresh,
      class: q?.class ?? fresh.class, topic: q?.topic ?? null, classified: Boolean(q?.classified),
      agentId, stopped: true, state: 'open', answer: null, delivery: null, rev: q ? (q.rev || 1) + 1 : 1,
      // v0.4.0: the auto-answer clock starts again at the stop
      askedAt: now.toISOString(),
    };
    if (at >= 0) list[at] = next;
    else list.push(next);
    writeQuestions(root, phase, list);
    return { status: 'stopped', question: next };
  });
}

// The lane question a needs-owner reason names (owner question ask-<k>), or null.
export const askNamed = (reason) => /^owner questions?\s+(ask-\d+)\b/i.exec(String(reason ?? ''))?.[1] ?? null;

// review 1: the phase starts or restarts a step (a fresh lane, the owner's resume, the hand-back of a sitting): its lane
// questions not yet delivered are dropped, so a stale one never blocks a wake or answers another step; the restarted
// step asks again. The answers file keeps what was answered. Returns the ids dropped.
export function dropLaneQuestions(root, phase) {
  return withPhaseLock(root, phase, () => {
    const list = readQuestions(root, phase);
    const ids = list.filter((q) => q.source === 'lane' && q.state !== 'delivered').map((q) => q.id);
    if (ids.length) writeQuestions(root, phase, list.filter((q) => !ids.includes(q.id)));
    return ids;
  });
}

// The stops of a phase (spec §5.5.1): waiting (still open) and ready (answered, not yet delivered, with an agent).
// Only questions with a usable id: their ids go into wake and resume prompts.
// ask (review 1): when given (an id or null), only the lane question the lane's current needs-owner record names counts;
// any other lane question is stale and neither waits nor is delivered.
export function deliveryState(root, phase, { ask } = {}) {
  const stops = readQuestions(root, phase).filter((q) => q.stopped && QUESTION_ID.test(q.id) && (ask === undefined || q.source !== 'lane' || q.id === ask));
  // a lane's own question has no agent: the lane session itself takes its answer (v0.3.3, D4)
  return { waiting: stops.filter((q) => q.state === 'open'), ready: stops.filter((q) => q.state === 'answered' && (q.agentId || q.source === 'lane')) };
}

// turbo-run questions N --delivered <id> --path <how> (spec §5.5.4): the path on the question and in the step's note.
export function markDelivered(root, phase, id, how, { now = new Date() } = {}) {
  if (!DELIVERY_PATHS.includes(how)) throw new Error(`--path must be ${DELIVERY_PATHS.join(' or ')}`);
  const q = withPhaseLock(root, phase, () => {
    const list = readQuestions(root, phase);
    const one = list.find((x) => x.id === id);
    if (!one) throw new Error(`no question ${id} in phase ${phase}`);
    if (one.source === 'lane' && how !== 'lane') throw new Error(`lane question ${id} is delivered on the lane path: --path lane`);
    if (one.source !== 'lane' && how === 'lane') throw new Error(`--path lane is only a lane question's (turbo-run ask); ${id} is a checkpoint's`);
    if (one.state !== 'answered') throw new Error(`question ${id} is ${one.state}, not answered`);
    Object.assign(one, { state: 'delivered', delivery: { path: how, at: now.toISOString() } });
    writeQuestions(root, phase, list);
    return one;
  });
  noteStep(root, phase, `owner answer ${id}: ${how}`, { now });
  return q;
}
