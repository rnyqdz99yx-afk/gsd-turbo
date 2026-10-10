import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fsx.mjs';
import { maskSecrets } from './secrets.mjs';
import { findPhaseDir, phaseArtifacts } from './phase-files.mjs';
import { parseCheckpoints, quotedSignal } from './checkpoints.mjs';

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
    accept: ['Accept if the checks pass', 'The lane accepts when every automated check in how-to-verify passes, and attaches the evidence.'],
    show: ['Stop and show me', 'The lane stops at this checkpoint and asks you then.'],
    approved: ['Approved', 'You checked it the way how-to-verify says.'],
    later: ['I will do it when the lane asks', 'The lane stops at this checkpoint and asks you then.'],
    done: ['Done', 'You did it; the agent checks the result and goes on.'],
    verify: 'Verify: ',
    action: 'Action: ',
    decisionCondition: 'the checkpoint offers the options the plan lists',
    verifyCondition: 'every automated check in how-to-verify passed, and the evidence is attached',
  },
  ru: {
    accept: ['Принять при условии', 'Лейн принимает, если все автоматические проверки из how-to-verify прошли, и прикладывает доказательства.'],
    show: ['Остановиться и показать мне', 'Лейн встанет на этом чекпоинте и спросит тогда.'],
    approved: ['Принято', 'Ты проверил так, как написано в how-to-verify.'],
    later: ['Сделаю, когда лейн попросит', 'Лейн встанет на этом чекпоинте и спросит тогда.'],
    done: ['Сделано', 'Ты сделал это; агент проверит результат и продолжит.'],
    verify: 'Проверка: ',
    action: 'Действие: ',
    decisionCondition: 'на чекпоинте те же варианты, что в плане',
    verifyCondition: 'все автоматические проверки из how-to-verify прошли, и доказательства приложены',
  },
};

// by code points, so a surrogate pair is never split; masked first, so a cut never hides a secret from the rules
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const show = (s, n) => cut(maskSecrets(String(s ?? '')), n);

export const questionId = (plan, task) => `${plan}-t${task}`;

// The question for one checkpoint (spec §5.1). stopped: the lane stands at it now, so the options are the
// answers the waiting agent takes: no condition, no "ask me then".
export function buildQuestion(cp, { phase, plan, lang = 'en', stopped = false }) {
  const L = Object.hasOwn(LABELS, lang) ? LABELS[lang] : LABELS.en;
  const option = ([label, description], signal, more = {}) => ({
    label: show(label, LABEL_MAX),
    description: show(description, DESCRIPTION_MAX),
    recommended: false,
    signal: signal === null ? null : show(signal, LABEL_MAX),
    defer: false,
    ...more,
  });
  let question;
  let context;
  let options;
  let condition = null;
  let allowOther = true;
  if (cp.kind === 'decision') {
    question = cp.decision || cp.context;
    context = cp.context;
    // recommended only where the plan itself marked it (auto_select), listed first
    const list = cp.options.map((o) => option(
      [o.name || o.id, [o.pros && `+ ${o.pros}`, o.cons && `− ${o.cons}`].filter(Boolean).join(' ')],
      o.id || o.name,
      { recommended: Boolean(cp.autoSelect) && o.id === cp.autoSelect },
    ));
    options = [...list.filter((o) => o.recommended), ...list.filter((o) => !o.recommended)];
    if (!stopped) condition = L.decisionCondition;
  } else if (cp.kind === 'human-verify') {
    question = `${L.verify}${cp.whatBuilt}`;
    context = cp.howToVerify;
    const signal = quotedSignal(cp.resumeSignal, 'approved');
    options = stopped ? [option(L.approved, signal)] : [option(L.accept, signal), option(L.show, null, { defer: true })];
    if (!stopped) condition = L.verifyCondition;
  } else {
    question = `${L.action}${cp.action}`;
    context = [cp.instructions, cp.verification].filter(Boolean).join(' ');
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
    question: show(question, QUESTION_MAX),
    context: show(context, CONTEXT_MAX),
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
  return { ...buildQuestion(cp, { phase, plan: m[1], lang, stopped: true }), source: 'stop' };
}

// spec §5.1: the lane's classes. consent:deploy is a deploy consent (class consent, topic deploy), the only one the
// standing deploy rule answers.
export const CLASSES = Object.freeze(['owner-only', 'consent', 'consent:deploy', 'decision', 'verify']);

// run/p<N>-questions.json (git-ignored) holds the questions; .planning/turbo/answers/p<N>.json (in git) the answers,
// newest last. Both change only inside withPhaseLock, so the first answer wins whichever channel sent it.
export const questionsFile = (root, phase) => path.join(runDir(root), `p${phase}-questions.json`);
export const answersRel = (phase) => `.planning/turbo/answers/p${phase}.json`;
const answersFile = (root, phase) => path.join(root, ...answersRel(phase).split('/'));
export const lockFile = (root, phase) => path.join(runDir(root), `p${phase}-questions.lock`);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const listOf = (file) => {
  const v = readJson(file, []);
  return Array.isArray(v) ? v.filter((x) => isObj(x) && typeof x.id === 'string') : [];
};
export const readQuestions = (root, phase) => listOf(questionsFile(root, phase));
export const readAnswers = (root, phase) => listOf(answersFile(root, phase));
export const writeQuestions = (root, phase, list) => writeJsonAtomic(questionsFile(root, phase), list);
export const writeAnswers = (root, phase, list) => writeJsonAtomic(answersFile(root, phase), list);

// The answer that stands for a question: its newest record that no stop superseded.
export function liveAnswer(records, id) {
  for (let i = records.length - 1; i >= 0; i--) if (records[i].id === id && !records[i].superseded) return records[i];
  return null;
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Every change to a phase's questions or answers runs inside this lock, an exclusive file. A writer waits up to
// waitMs; a lock older than staleMs was left by a crash and is taken over.
export function withPhaseLock(root, phase, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const file = lockFile(root, phase);
  ensureDir(path.dirname(file));
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let age;
    try {
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    if (age > staleMs) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() >= until) throw new Error(`the questions of phase ${phase} are locked by another turbo-run (${path.basename(file)}); try again`);
    sleepSync(25);
  }
  try {
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// Every checkpoint of the phase's plans, and the plans still open (no SUMMARY).
export function planCheckpoints(root, phase) {
  const dir = findPhaseDir(root, phase);
  const items = [];
  const open = new Set();
  if (!dir) return { items, open };
  for (const p of phaseArtifacts(dir).plans) {
    if (!p.hasSummary) open.add(p.id);
    let text;
    try {
      text = fs.readFileSync(path.join(dir, p.file), 'utf8');
    } catch {
      continue;
    }
    for (const cp of parseCheckpoints(text)) items.push({ plan: p.id, cp });
  }
  return { items, open };
}

// The question's state and answer summary from the answers file: open, answered, deferred (the owner wants to be
// asked at the stop), or delivered (kept once the lane delivered it).
function withAnswer(q, live, delivered) {
  if (!live) return { ...q, state: 'open', answer: null };
  const answer = { option: live.option, label: live.label, answer: live.answer, by: live.by, at: live.at, conditional: live.conditional };
  return { ...q, answer, state: live.defer ? 'deferred' : delivered ? 'delivered' : 'answered' };
}

const KEEP = ['class', 'topic', 'classified', 'agentId', 'stopped', 'delivery'];

// What a rebuilt question keeps from its earlier version: the lane's class, the agent and the stop, the delivery.
// rev counts changes of its options, so a channel that showed the old ones knows they are gone.
function carry(fresh, old, answers) {
  const q = { ...fresh };
  if (old) {
    for (const k of KEEP) if (old[k] !== undefined) q[k] = old[k];
    const same = JSON.stringify(old.options) === JSON.stringify(fresh.options) && old.allowOther === fresh.allowOther;
    q.rev = same ? old.rev || 1 : (old.rev || 1) + 1;
  }
  return withAnswer(q, liveAnswer(answers, q.id), old?.state === 'delivered');
}

// turbo-run questions N: the questions of the plans without a SUMMARY, rebuilt from the plans (spec §5.1).
export function refreshQuestions(root, phase, { lang = 'en' } = {}) {
  return withPhaseLock(root, phase, () => {
    const { items, open } = planCheckpoints(root, phase);
    const prev = new Map(readQuestions(root, phase).map((q) => [q.id, q]));
    const answers = readAnswers(root, phase);
    const next = [];
    for (const { plan, cp } of items) {
      if (!open.has(plan)) continue;
      const old = prev.get(questionId(plan, cp.task));
      next.push(carry(buildQuestion(cp, { phase, plan, lang, stopped: Boolean(old?.stopped) }), old, answers));
    }
    // a checkpoint the lane named at a stop stays while its plan is open
    for (const q of prev.values()) {
      if (q.source === 'stop' && open.has(q.plan) && !next.some((x) => x.id === q.id)) next.push(carry(q, q, answers));
    }
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
