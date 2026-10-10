import { SECRET_RULES } from './secrets.mjs';
import { commitPaths } from './gates.mjs';
import { answersRel, liveAnswer, readAnswers, readQuestions, withPhaseLock, writeAnswers, writeQuestions } from './questions.mjs';

// spec §5.3: every channel answers through answerQuestion; turbo-run answer is its command line.
export const CHANNELS = Object.freeze(['session', 'pane', 'telegram', 'standing-rule']);
// the owner's own words, on every channel (the Telegram limit of spec §5.3), in code points
export const TEXT_MAX = 2000;

export class AnswerRefused extends Error {}
// The channel showed another revision of the question (its options changed since): nothing is recorded.
export class QuestionChanged extends AnswerRefused {}
const refuse = (text) => { throw new AnswerRefused(text); };
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
// CRLF to LF and control characters out (tab and new line stay): the words go into files, prompts and chat messages
const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();

// The first secret rule the text matches, or null. spec §5.4: such an answer is refused and never stored.
export function secretRule(text) {
  for (const [rule, re] of SECRET_RULES) if (re.test(String(text))) return rule;
  return null;
}

// '<label or words>, <channel>, <time>': the reply to a repeated answer (spec §5.3).
export function describeAnswer(a) {
  if (!a) return 'unknown';
  return `${a.label ?? cut(a.answer, 100)}, ${a.by}, ${a.at}`;
}

// The single arbiter (spec §5.3, §5.4). The first answer wins: a question that is not open, or already has an
// answer that stands, returns that answer. A preference (an option with defer) is recorded and leaves the
// question deferred. rev, when given, is the revision the channel showed: another one records nothing. While a lane
// runs it commits the answers file itself; otherwise the answer is committed here.
export function answerQuestion({ root, phase, id, option = null, text = null, by, now = new Date(), laneRunning = false, condition = null, rev = null, commit = (paths, message) => commitPaths(root, paths, message) }) {
  if (!CHANNELS.includes(by)) refuse(`unknown channel ${by}`);
  if ((option === null) === (text === null)) refuse('give exactly one of an option number or your own words');
  const words = text === null ? null : clean(text);
  if (words !== null) {
    if (!words) refuse('the answer is empty');
    if ([...words].length > TEXT_MAX) refuse(`the answer is longer than ${TEXT_MAX} characters`);
    const rule = secretRule(words);
    if (rule) refuse(`the answer looks like it contains a secret (${rule}); nothing was recorded: rephrase it without the secret`);
  }
  const done = withPhaseLock(root, phase, () => {
    const list = readQuestions(root, phase);
    const q = list.find((x) => x.id === id) || refuse(`no question ${id} in phase ${phase}`);
    const answers = readAnswers(root, phase);
    const live = liveAnswer(answers, id);
    if (live || q.state !== 'open') return { status: 'already', record: live || q.answer };
    if (rev !== null && (q.rev || 1) !== rev) {
      throw new QuestionChanged(`question ${id} changed since it was shown (now rev ${q.rev || 1}, shown rev ${rev}); read it again and answer the new version`);
    }
    let opt = null;
    if (option !== null) {
      opt = Number.isInteger(option) ? q.options[option - 1] : undefined;
      if (!opt) refuse(`question ${id} has no option ${option}; its options are 1 to ${q.options.length}`);
    } else if (!q.allowOther) {
      refuse(`question ${id} takes one of its options only, no own words`);
    }
    const defer = Boolean(opt?.defer);
    const cond = defer ? null : [q.condition, condition].filter(Boolean).join('; and ') || null;
    const record = {
      id, plan: q.plan, task: q.task, option: opt ? option : null, label: opt ? opt.label : null,
      answer: opt ? opt.signal : words, by, at: now.toISOString(), conditional: Boolean(cond), condition: cond, defer,
    };
    answers.push(record);
    writeAnswers(root, phase, answers);
    Object.assign(q, { state: defer ? 'deferred' : 'answered', answer: { option: record.option, label: record.label, answer: record.answer, by, at: record.at, conditional: record.conditional } });
    writeQuestions(root, phase, list);
    return { status: 'recorded', record };
  });
  if (done.status !== 'recorded' || laneRunning) return { ...done, commit: null };
  let note;
  try {
    const c = commit([answersRel(phase)], `docs(turbo): owner answer ${id} (phase ${phase})`);
    note = c?.committed ? 'committed' : `not committed: ${c?.reason || 'unknown reason'}`;
  } catch (err) {
    note = `not committed: ${errLine(err)}`;
  }
  return { ...done, commit: note };
}
