import { maskSecrets } from './secrets.mjs';
import { quotedSignal } from './checkpoints.mjs';

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
