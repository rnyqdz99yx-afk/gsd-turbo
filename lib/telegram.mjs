import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { writeJsonAtomic } from './fsx.mjs';
import { clean, openQuestions } from './view.mjs';
import { PhaseLocked, readQuestions } from './questions.mjs';
import { AnswerRefused, QuestionChanged, TEXT_MAX, answerQuestion, secretRule } from './answers.mjs';

// Owner answers by Telegram (spec §5.3, S1b). The supervisor sends every open question to the owner's private chat
// with inline buttons and polls getUpdates while questions are open. Every answer goes through answerQuestion.
const API = 'https://api.telegram.org';
export const MAX_BUTTONS = 4;
const CALL_TIMEOUT_MS = 10000;
const CALLBACK_RE = /^t3:([0-9a-f]{8}):(\d{1,2}|o):([0-9a-f]{8})$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The channel is on with notify.telegram and answer.telegram, the bot token, and the owner's private chat id: a
// positive number (no leading zero), which is also the owner's user id, the only from.id accepted.
export function telegramSettings(config, env = process.env) {
  if (config?.answer?.telegram !== true || telegramOff(config, env)) return null;
  return { token: String(env.TURBO_TELEGRAM_TOKEN).trim(), chat: String(env.TURBO_TELEGRAM_CHAT).trim() };
}

// Why answer.telegram is on but the channel cannot work, without any value (the supervisor log, doctor); null while
// it works or is off by choice.
export function telegramOff(config, env = process.env) {
  if (config?.answer?.telegram !== true) return null;
  if (config?.notify?.telegram !== true) return 'answer.telegram needs notify.telegram';
  if (!String(env.TURBO_TELEGRAM_TOKEN || '').trim()) return 'TURBO_TELEGRAM_TOKEN is not set';
  const chat = String(env.TURBO_TELEGRAM_CHAT || '').trim();
  if (!chat) return 'TURBO_TELEGRAM_CHAT is not set';
  if (!/^[1-9]\d*$/.test(chat)) return 'TURBO_TELEGRAM_CHAT is not the id of a private chat (a positive number without a leading zero; a group or an @name cannot answer)';
  return null;
}

// One Bot API call: POST JSON, the result or an error. No error ever carries the token (it is in the URL). An error
// is transient when the network failed or timed out, or Telegram is overloaded (HTTP 5xx, 429): the same call may
// work next tick. Any other is Telegram refusing this very call; code is Telegram's error_code (or the HTTP status).
export function createBot({ token, fetchImpl = globalThis.fetch, timeoutMs = CALL_TIMEOUT_MS }) {
  const hide = (s) => String(s ?? '').split(token).join('[token]');
  const fail = (method, why, transient, code = 0) => Object.assign(new Error(`telegram ${method} failed: ${hide(why)}`), { transient, code });
  return async function call(method, body, { timeoutMs: limit = timeoutMs } = {}) {
    let res;
    try {
      res = await fetchImpl(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(limit),
      });
    } catch (err) {
      throw fail(method, err?.name === 'TimeoutError' ? 'timed out' : err?.message ?? err, true);
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      // the body hung past the time limit after the headers came; anything else is not JSON, reported by the status
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw fail(method, 'timed out', true);
    }
    if (data?.ok) return data.result;
    const code = Number(data?.error_code) || Number(res?.status) || 0;
    throw fail(method, data?.description || `HTTP ${res?.status}`, !data || code === 429 || code >= 500, code);
  };
}

// A refusal that no message to this chat gets past (a bad or malformed token: 401, 404; a bot the owner blocked or
// never started; a chat id that is no chat): it ends the Telegram part; any other refusal is about the one message.
const wholeChat = (err) => [401, 403, 404].includes(err?.code) || /chat not found/i.test(String(err?.message));

// callback_data (spec §5.3): t3:<short id>:<option number or o>:<one-time nonce>, at most 23 bytes.
export const shortId = (phase, id) => crypto.createHash('sha1').update(`${phase}:${id}`).digest('hex').slice(0, 8);
export const callbackData = (short, k, nonce) => `t3:${short}:${k}:${nonce}`;
export function parseCallback(data) {
  const m = CALLBACK_RE.exec(String(data ?? ''));
  return m ? { short: m[1], k: m[2] === 'o' ? 'o' : Number(m[2]), nonce: m[3] } : null;
}

// run/telegram.json, the supervisor's alone: which bot and chat it belongs to (a hash, never the token); the
// getUpdates offset and when it last moved; per question its message, rev and nonces; the nonces (button -> question
// and option); the force-reply prompts waiting for the owner's own words.
const stateFile = (root) => path.join(runDir(root), 'telegram.json');
const STATE_SHOWN = 'run/telegram.json';
const emptyState = (bot = null) => ({ v: 1, bot, offset: 0, offsetAt: null, sent: {}, nonces: {}, replies: {} });
function normalState(s) {
  const obj = (v) => (isObj(v) ? v : {});
  return {
    v: 1,
    bot: typeof s?.bot === 'string' ? s.bot : null,
    offset: Number.isInteger(s?.offset) && s.offset >= 0 ? s.offset : 0,
    offsetAt: typeof s?.offsetAt === 'string' ? s.offsetAt : null,
    sent: obj(s?.sent),
    nonces: obj(s?.nonces),
    replies: obj(s?.replies),
  };
}
// { state } (an absent file: the empty state), { state, broken } (a file that holds no state object), or { error }
// (a file there that cannot be read now: its messages and buttons must not be forgotten for that)
function loadState(root) {
  let text;
  try {
    text = fs.readFileSync(stateFile(root), 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { state: emptyState() } : { error: err };
  }
  let s;
  try {
    s = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    s = null;
  }
  return isObj(s) ? { state: normalState(s) } : { state: emptyState(), broken: true };
}
export const readTelegramState = (root) => loadState(root).state ?? emptyState();
export const writeTelegramState = (root, state) => writeJsonAtomic(stateFile(root), state);

// A failure that repeats every tick is logged once per spell: the last line per project and kind, until the kind
// works again. And per project, a state this daemon could not write, kept to be written before anything else.
const spells = new Map();
function logOnce(deps, root, kind, line) {
  const key = `${root}\n${kind}`;
  if (spells.get(key) === line) return;
  spells.set(key, line);
  deps.log(line);
}
const endSpell = (root, kind) => spells.delete(`${root}\n${kind}`);
const unsaved = new Map();
const codeOf = (err) => err?.code || errLine(err);

const MESSAGE_MAX = 4000;
const BUTTON_MAX = 60;
// an option's text on its button, before … (the text above lists it in full)
const BUTTON_WORDS = 40;
const NONCE_TRIES = 10;
// at most n UTF-16 units (what Telegram counts), never half a surrogate pair
function fit(s, n) {
  let out = '';
  for (const ch of String(s ?? '')) {
    if (out.length + ch.length > n) break;
    out += ch;
  }
  return out;
}
// at most n UTF-16 units, ending in … when cut
const clip = (s, n) => (String(s).length > n ? `${fit(s, n - 1)}…` : String(s));
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
const keyOf = (q) => `${q.phase}:${q.id}`;
// which bot and chat a state file belongs to: a hash, so the file never holds a part of the token
const botOf = ({ token, chat }) => crypto.createHash('sha256').update(`${token}\n${chat}`).digest('hex').slice(0, 16);
// where and when an answer was given, in brackets: ` (in the pane, 08:15)`
const given = (how, at) => (how || at ? ` (${[how, at].filter(Boolean).join(', ')})` : '');

// The owner's language (config.lang), in the turbo-view pane's words (mod/hooks/view-model.mjs): the phase, plan and
// task in words, an answer's channel in words with the local time; never a question id, a channel code or an ISO
// time. turbo's own words only: the questions themselves are as S1a built them.
export const TEXTS = {
  en: {
    title: (phase, plan, task) => [`Phase ${phase}`, plan && `plan ${plan}${task ? `, task ${task}` : ''}`].filter(Boolean).join(' · '),
    recommended: '★ recommended',
    other: 'Your own answer…',
    more: (n) => `(${n} more without a button: answer with “Your own answer…” and name it)`,
    closed: 'Question closed',
    moved: '↻ The question changed — answer the new message below',
    prompt: (max) => `Your own answer: write it as a reply to this message, up to ${max} characters.`,
    promptClosed: 'Closed: the question changed or was answered. If it still waits, answer in its newest message.',
    stale: 'Not recorded: that message takes no answer (any more). Answer with the buttons of the question\'s newest message; for your own words press “Your own answer…” there.',
    reply: 'Reply to the message I just sent.',
    expired: 'This button no longer works.',
    changed: 'The question changed — answer the new message.',
    recorded: (what) => `✓ Answer recorded: “${what}”`,
    answered: (what, how, at) => `✓ Answer recorded${given(how, at)}: “${what}”`,
    already: (what, how, at) => `Already answered${given(how, at)}${what ? `: “${what}”` : ''}`,
    channel: { session: 'in a session', pane: 'in the pane', telegram: 'in Telegram', 'standing-rule': 'by a standing rule' },
    refused: (why) => `Not recorded: ${why}.`,
    refusal: { tooLong: (n) => `the answer is longer than ${n} characters`, empty: 'the answer is empty', gone: 'the question is closed', noOption: 'no such option', optionsOnly: 'this question takes one of its options only' },
    secret: (rule) => `Not recorded: the answer looks like it contains a secret (${rule}). Delete your message from this chat and answer without it.`,
    rules: {},
    tooLong: (max) => `Not recorded: the answer is longer than ${max} characters. Reply again, shorter.`,
  },
  ru: {
    title: (phase, plan, task) => [`Фаза ${phase}`, plan && `план ${plan}${task ? `, задача ${task}` : ''}`].filter(Boolean).join(' · '),
    recommended: '★ рекомендуется',
    other: 'Свой ответ…',
    more: (n) => `(ещё ${n} без кнопки: ответьте через «Свой ответ…» и назовите)`,
    closed: 'Вопрос закрыт',
    moved: '↻ Вопрос изменился — ответьте на новое сообщение ниже',
    prompt: (max) => `Свой ответ: напишите его ответом на это сообщение, до ${max} символов.`,
    promptClosed: 'Закрыто: вопрос изменился или на него уже ответили. Если он ещё ждёт, отвечайте в его новом сообщении.',
    stale: 'Не принято: это сообщение (уже) не принимает ответ. Отвечайте кнопками нового сообщения с вопросом, а своими словами — через «Свой ответ…» там же.',
    reply: 'Ответьте на сообщение, которое я только что отправил.',
    expired: 'Эта кнопка больше не работает.',
    changed: 'Вопрос изменился — ответьте на новое сообщение.',
    recorded: (what) => `✓ Ответ принят: «${what}»`,
    answered: (what, how, at) => `✓ Ответ принят${given(how, at)}: «${what}»`,
    already: (what, how, at) => `Уже отвечено${given(how, at)}${what ? `: «${what}»` : ''}`,
    channel: { session: 'в сессии', pane: 'в панели', telegram: 'в Telegram', 'standing-rule': 'по постоянному правилу' },
    refused: (why) => `Не принято: ${why}.`,
    refusal: { tooLong: (n) => `ответ длиннее ${n} символов`, empty: 'пустой ответ', gone: 'вопрос уже закрыт', noOption: 'такого варианта нет', optionsOnly: 'этот вопрос принимает только варианты из списка' },
    secret: (rule) => `Не принято: похоже, в ответе секрет (${rule}). Удалите своё сообщение из этого чата и ответьте без него.`,
    // lib/secrets.mjs SECRET_RULES in words
    rules: { 'private key': 'закрытый ключ', 'aws access key': 'ключ доступа AWS', 'github token': 'токен GitHub', 'slack token': 'токен Slack', 'api key': 'API-ключ', jwt: 'JWT', 'bot token': 'токен бота', 'bearer token': 'токен доступа', 'credential assignment': 'пароль или ключ' },
    tooLong: (max) => `Не принято: ответ длиннее ${max} символов. Ответьте ещё раз, короче.`,
  },
};

// The title of a question's messages: its phase, plan and task in words, cleaned (they are the repository's text).
const titleOf = (L, { phase, plan, task } = {}) => L.title(clean(String(phase ?? '')), plan == null ? '' : clean(String(plan)), task == null ? '' : clean(String(task)));

const pad = (n) => String(n).padStart(2, '0');
// HH:MM of an ISO time on the owner's clock (the supervisor runs on the owner's machine); null for none
function clockText(iso) {
  const d = new Date(Date.parse(String(iso ?? '')));
  return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : null;
}

// An answer in words: its option's label (the option's number when the label is empty) or the owner's own words, cut.
function answerWhat(a) {
  const label = clean(String(a?.label ?? '')).trim();
  if (label) return label;
  if (a?.option != null) return String(a.option);
  return clip(clean(String(a?.answer ?? '')).trim(), WORDS_SHOWN);
}
const channelOf = (L, by) => (Object.hasOwn(L.channel, String(by)) ? L.channel[by] : null);
// The line that closes a question's message: the answer, where and when it was given; for none, that it is closed.
const answerLine = (L, a) => (a ? L.answered(answerWhat(a), channelOf(L, a.by), clockText(a.at)) : L.closed);

// S1a's refusals (lib/answers.mjs) in words, as the pane says them; one not known here stays as the arbiter said it.
function refusalWords(L, why) {
  const long = /longer than (\d+) characters/.exec(why);
  if (long) return L.refusal.tooLong(long[1]);
  if (/answer is empty/.test(why)) return L.refusal.empty;
  if (/^no question /.test(why)) return L.refusal.gone;
  if (/has no option/.test(why)) return L.refusal.noOption;
  if (/takes one of its options only/.test(why)) return L.refusal.optionsOnly;
  return clean(why);
}

// A nonce no live button has: one press never reaches another button's question or option.
function newNonce(deps, taken) {
  for (let i = 0; i < NONCE_TRIES; i++) {
    const n = deps.nonce ? deps.nonce() : crypto.randomBytes(4).toString('hex');
    if (!taken.has(n)) return n;
  }
  throw new Error('telegram: no free button nonce');
}

// The question as one message, plain text (no parse_mode: nothing in it is read as markup), as the pane draws it: the
// title, the question, its context, then the options numbered, the recommended one marked, each with its description.
// The context gets the room the rest leaves (cut with …), so the options always come through.
function questionText(q, options, title, L) {
  const list = options.slice(0, MAX_BUTTONS).map((o, i) => {
    const what = [`${i + 1}.`, clean(String(o?.label ?? '')).trim(), o?.recommended === true && L.recommended].filter(Boolean).join(' ');
    return o?.description ? `${what} — ${clean(String(o.description))}` : what;
  });
  if (options.length > MAX_BUTTONS) list.push(L.more(options.length - MAX_BUTTONS));
  const head = [title, clean(String(q.question ?? ''))];
  const tail = list.length ? ['', ...list] : [];
  const context = clean(String(q.context ?? '')).trim();
  const room = MESSAGE_MAX - [...head, ...tail].join('\n').length - 1;
  if (context && room > 1) head.push(clip(context, room));
  return fit([...head, ...tail].join('\n'), MESSAGE_MAX);
}

// An option's button: its number and its text cut with … to a readable length, ★ for the recommended one (the pane's
// buttons). An empty text makes Telegram refuse the whole message: the number alone then.
function buttonText(n, o) {
  const label = clean(String(o?.label ?? '')).replace(/\s+/g, ' ').trim();
  return label ? fit(`${n}. ${clip(label, BUTTON_WORDS)}${o?.recommended === true ? ' ★' : ''}`, BUTTON_MAX) : String(n);
}

function forget(state, key) {
  const nonces = state.sent[key]?.nonces;
  for (const n of Array.isArray(nonces) ? nonces : []) delete state.nonces[n];
  delete state.sent[key];
}

// A message's question is settled or changed: its buttons go (an edit without reply_markup) and the line says why.
// An edit the network lost keeps the message on record, buttons and all, for the next tick; one Telegram refused
// (the message is gone, say) is logged and let go.
async function close({ call, chat, state, key, line, deps }) {
  const sent = state.sent[key];
  if (!sent) return;
  try {
    // a message Telegram refused to take has nothing to edit
    if (sent.messageId != null) await call('editMessageText', { chat_id: chat, message_id: sent.messageId, text: fit(`${sent.title}\n${line}`, MESSAGE_MAX) });
  } catch (err) {
    if (err?.transient) throw err;
    deps.log(`telegram: ${errLine(err)}`);
  }
  forget(state, key);
}

// The chat in line with the open questions: answered, gone or changed ones closed, new ones sent once.
async function syncMessages({ call, chat, state, open, root, L, deps }) {
  const byKey = new Map(open.map((q) => [keyOf(q), q]));
  for (const [key, sent] of Object.entries(state.sent)) {
    const q = byKey.get(key);
    if (q && (q.rev || 1) === sent.rev) continue;
    const at = key.indexOf(':');
    const cur = q ? null : readQuestions(root, key.slice(0, at)).find((x) => x.id === key.slice(at + 1));
    const line = q ? L.moved : answerLine(L, cur?.answer);
    await close({ call, chat, state, key, line, deps });
  }
  // a prompt for own words whose question changed or is settled says so (it keeps no buttons to remove); the network
  // losing that edit keeps it for the next tick, Telegram refusing it lets it go
  for (const [m, r] of Object.entries(state.replies)) {
    const q = byKey.get(`${r?.phase}:${r?.id}`);
    if (q && (q.rev || 1) === r?.rev) continue;
    try {
      await call('editMessageText', { chat_id: chat, message_id: Number(m), text: fit(`${titleOf(L, r)}\n${L.promptClosed}`, MESSAGE_MAX) });
    } catch (err) {
      if (err?.transient) throw err;
      deps.log(`telegram: ${errLine(err)}`);
    }
    delete state.replies[m];
  }
  for (const q of open) {
    if (state.sent[keyOf(q)]) continue;
    // a daemon that lost its lease meanwhile sends no more: the new one sends them
    if (!leased(deps)) return;
    const rev = q.rev || 1;
    const sid = shortId(q.phase, q.id);
    const options = Array.isArray(q.options) ? q.options : [];
    const nonces = {};
    const taken = new Set(Object.keys(state.nonces));
    const add = (k, label) => {
      const n = newNonce(deps, taken);
      taken.add(n);
      nonces[n] = { phase: q.phase, id: q.id, plan: q.plan, task: q.task, rev, k, label };
      return n;
    };
    const rows = options.slice(0, MAX_BUTTONS).map((o, i) => [{ text: buttonText(i + 1, o), callback_data: callbackData(sid, i + 1, add(i + 1, o?.label ?? null)) }]);
    if (q.allowOther) rows.push([{ text: L.other, callback_data: callbackData(sid, 'o', add('o', null)) }]);
    const title = titleOf(L, q);
    let msg;
    try {
      msg = await call('sendMessage', { chat_id: chat, text: questionText(q, options, title, L), ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
    } catch (err) {
      if (err?.transient || wholeChat(err)) throw err;
      // Telegram refuses this one message: logged, and not tried again until the question changes; the others go on
      deps.log(`telegram: question ${q.id} of phase ${q.phase} not sent: ${errLine(err)}`);
      state.sent[keyOf(q)] = { rev, messageId: null, title, nonces: [] };
      continue;
    }
    // recorded only once sent: a failed send leaves no button behind and is tried again next tick
    Object.assign(state.nonces, nonces);
    state.sent[keyOf(q)] = { rev, messageId: msg?.message_id ?? null, title, nonces: Object.keys(nonces) };
  }
}

const POLL_MAX_SECONDS = 50;
const CALLBACK_REPLY_MAX = 190;
const WORDS_SHOWN = 100;
const clockOf = (deps) => deps.now || (() => new Date());
const leased = (deps) => !deps.leaseHeld || deps.leaseHeld();
// what a handler returns for an update from another user or chat
const FOREIGN = Symbol('foreign');
// Telegram keeps an update a day at most, and numbers the next one at random after a week without any
const OFFSET_KEEP_MS = 24 * 60 * 60 * 1000;

// One answer through the single arbiter, with the revision its message showed (S1a's --rev contract). A locked
// phase (PhaseLocked) and any other failure are thrown: nothing was recorded.
function record({ root, ref, option = null, text = null, laneRunning, L, deps }) {
  const answer = deps.answer || answerQuestion;
  try {
    // the time it is handled: up to the long poll's wait after the tick began
    const r = answer({ root, phase: ref.phase, id: ref.id, option, text, by: 'telegram', now: clockOf(deps)(), laneRunning, rev: ref.rev });
    // the reply says what was recorded (or, answered before, where and when); the question's message keeps that line
    const a = r.record;
    if (r.status === 'already') return { done: true, text: a ? L.already(answerWhat(a), channelOf(L, a.by), clockText(a.at)) : L.already('', null, null), line: answerLine(L, a) };
    return { done: true, text: L.recorded(answerWhat(a)), line: answerLine(L, a) };
  } catch (err) {
    if (err instanceof QuestionChanged) return { done: false, text: L.changed };
    if (err instanceof AnswerRefused) return { done: false, text: secretIn(text, L) ?? L.refused(refusalWords(L, err.message)) };
    throw err;
  }
}

// The refusal of own words that look like a secret, with the advice to delete them from the chat; null without one.
// Checked as the arbiter checks (the words cleaned), and before their length: a long answer can hold a secret too.
function secretIn(text, L) {
  const rule = text === null ? null : secretRule(clean(String(text)));
  return rule ? L.secret(Object.hasOwn(L.rules, rule) ? L.rules[rule] : rule) : null;
}

// A button press. Only the owner's count; a nonce works once: it is used up by the first press that reaches the
// arbiter (or opens the Other prompt), whatever the outcome. A press that could not (a locked phase, a failed send)
// leaves it working.
async function onButton({ call, chat, state, root, L, deps, now, laneRunning, cb }) {
  // dropped unanswered; the batch logs how many, never what
  if (String(cb?.from?.id ?? '') !== chat) return FOREIGN;
  // the toast over the pressed button; one Telegram refuses (the press is too old, say) is only logged
  const tell = async (text) => {
    try {
      await call('answerCallbackQuery', { callback_query_id: cb.id, text: fit(text, CALLBACK_REPLY_MAX) });
    } catch (err) {
      if (err?.transient) throw err;
      deps.log(`telegram: ${errLine(err)}`);
    }
  };
  const p = parseCallback(cb.data);
  const ref = p && Object.hasOwn(state.nonces, p.nonce) ? state.nonces[p.nonce] : null;
  if (!isObj(ref) || shortId(ref.phase, ref.id) !== p.short || String(ref.k) !== String(p.k)) {
    await tell(L.expired);
    return;
  }
  const key = `${ref.phase}:${ref.id}`;
  const useUp = () => {
    delete state.nonces[p.nonce];
    const sent = state.sent[key];
    if (Array.isArray(sent?.nonces)) sent.nonces = sent.nonces.filter((n) => n !== p.nonce);
  };
  if (ref.k === 'o') {
    const msg = await call('sendMessage', { chat_id: chat, text: fit(`${titleOf(L, ref)}\n${L.prompt(TEXT_MAX)}`, MESSAGE_MAX), reply_markup: { force_reply: true } });
    useUp();
    if (msg?.message_id != null) state.replies[String(msg.message_id)] = { phase: ref.phase, id: ref.id, plan: ref.plan, task: ref.task, rev: ref.rev };
    await tell(L.reply);
    return;
  }
  const r = record({ root, ref, option: ref.k, now, laneRunning, L, deps });
  useUp();
  await tell(r.text);
  if (r.done) await close({ call, chat, state, key, line: r.line, deps });
}

// A message. Only the owner's replies, in the owner's chat, to one of turbo's force-reply prompts count; the prompt
// stays until an answer is recorded.
async function onReply({ call, chat, state, root, L, deps, now, laneRunning, m }) {
  if (String(m?.from?.id ?? '') !== chat || String(m.chat?.id ?? '') !== chat) return FOREIGN;
  const to = String(m.reply_to_message?.message_id ?? '');
  const ref = to && Object.hasOwn(state.replies, to) ? state.replies[to] : null;
  const answerWith = (text) => call('sendMessage', { chat_id: chat, text: fit(text, MESSAGE_MAX), reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
  if (!isObj(ref)) {
    // a reply to a closed prompt, a question message or any other message of the bot: where to answer instead
    if (m.reply_to_message?.from?.is_bot === true) await answerWith(L.stale);
    return;
  }
  const text = typeof m.text === 'string' ? m.text : '';
  const secret = secretIn(text, L);
  const r = secret ? { done: false, text: secret }
    : [...text].length > TEXT_MAX ? { done: false, text: L.tooLong(TEXT_MAX) }
      : record({ root, ref, text, now, laneRunning, L, deps });
  if (r.done) {
    delete state.replies[to];
    await close({ call, chat, state, key: `${ref.phase}:${ref.id}`, line: r.line, deps });
  }
  // the owner may have deleted the message already (a secret): the reply goes out all the same
  await answerWith(r.text);
}

// One long poll (spec §5.3: no longer than poll_seconds, here at most 50 s). The offset moves past every update
// handled, also one whose handling failed (logged). A locked phase stops the batch before its update and a network
// failure after it: the updates not handled come again next tick. An offset that has not moved for a day is not sent.
async function pollUpdates({ call, chat, state, root, config, L, deps, now, laneRunning }) {
  const wait = Math.min(POLL_MAX_SECONDS, Math.max(1, Math.floor(Number(config.poll_seconds) || 20)));
  const age = now.getTime() - Date.parse(state.offsetAt ?? '');
  const offset = age >= 0 && age < OFFSET_KEEP_MS ? state.offset : 0;
  const updates = await call('getUpdates', { offset, timeout: wait, allowed_updates: ['callback_query', 'message'] }, { timeoutMs: (wait + 10) * 1000 });
  let next = offset;
  let locked = false;
  let foreign = 0;
  for (const u of Array.isArray(updates) ? updates : []) {
    // the rest is the new daemon's, should this one have lost its lease meanwhile
    if (!leased(deps)) break;
    if (!Number.isInteger(u?.update_id)) continue;
    let stop = false;
    try {
      let r;
      if (u.callback_query) r = await onButton({ call, chat, state, root, L, deps, now, laneRunning, cb: u.callback_query });
      else if (u.message) r = await onReply({ call, chat, state, root, L, deps, now, laneRunning, m: u.message });
      if (r === FOREIGN) foreign++;
    } catch (err) {
      if (err instanceof PhaseLocked) {
        // tried again each tick while the lock stays: logged once
        logOnce(deps, root, 'locked', `telegram: ${errLine(err)}`);
        locked = true;
        break;
      }
      deps.log(`telegram: ${errLine(err)}`);
      stop = Boolean(err?.transient);
    }
    next = Math.max(next, u.update_id + 1);
    if (stop) break;
  }
  // one line per batch however many strangers wrote or pressed: a count, never who or what
  if (foreign) deps.log(`telegram: ignored ${foreign} update${foreign === 1 ? '' : 's'} from another user or chat`);
  if (!locked) endSpell(root, 'locked');
  if (next !== offset) Object.assign(state, { offset: next, offsetAt: clockOf(deps)().toISOString() });
}

// The Telegram part of a supervisor tick (spec §5.3). Nothing without telegramSettings (with answer.telegram on, the
// reason is logged once). A Telegram error ends this part and is logged once per spell; it never throws.
export async function telegramTick(ctx, now, { laneRunning = false, open = null, answers = true } = {}) {
  const { root, config, deps } = ctx;
  // a daemon that lost its lease (stop, resume, another start) leaves Telegram to the new one, like pushTick
  if (!leased(deps)) return;
  const env = deps.env || process.env;
  const t = telegramSettings(config, env);
  if (!t) {
    const why = telegramOff(config, env);
    if (why) logOnce(deps, root, 'off', `telegram: answers are off: ${why}`);
    return;
  }
  endSpell(root, 'off');
  // a failure (the network, Telegram refusing the chat) is logged once per spell, never thrown: the state is saved
  // either way, so nothing is sent twice
  try {
    await telegramPart(ctx, now, t, { laneRunning, open, answers });
    endSpell(root, 'fail');
  } catch (err) {
    logOnce(deps, root, 'fail', `telegram: ${errLine(err)}`);
  }
}

async function telegramPart(ctx, now, t, { laneRunning, open, answers = true }) {
  const { root, config, deps } = ctx;
  const L = Object.hasOwn(TEXTS, config.lang) ? TEXTS[config.lang] : TEXTS.en;
  const call = deps.telegram || createBot({ token: t.token, fetchImpl: deps.fetch || globalThis.fetch });
  const list = open ?? openQuestions(root);
  const cantWrite = (err) => logOnce(deps, root, 'save', `telegram: ${STATE_SHOWN} cannot be written (${codeOf(err)}); nothing new is sent until it can`);
  let state = unsaved.get(root);
  if (state) {
    // what this daemon sent or took last could not be recorded: it is written before anything new is sent
    try {
      writeTelegramState(root, state);
    } catch (err) {
      cantWrite(err);
      return;
    }
    unsaved.delete(root);
    endSpell(root, 'save');
  } else {
    const loaded = loadState(root);
    if (loaded.error) {
      logOnce(deps, root, 'read', `telegram: ${STATE_SHOWN} cannot be read (${codeOf(loaded.error)}); Telegram waits until it can`);
      return;
    }
    endSpell(root, 'read');
    if (loaded.broken) deps.log(`telegram: ${STATE_SHOWN} held no turbo state; it starts afresh, and the open questions are sent again`);
    state = loaded.state;
  }
  let saved = JSON.stringify(state);
  // another bot or chat: the messages, buttons and update offset on record belong to the old one
  const bot = botOf(t);
  if (state.bot !== bot) state = emptyState(bot);
  // with no question open, a message or an Other prompt still on record is closed first
  if (!list.length && !Object.keys(state.sent).length && !Object.keys(state.replies).length) return;
  // false when the state could not be written: it is kept in memory and written first next tick; and once the lease
  // is lost, when the new daemon's state must not be overwritten
  const save = () => {
    if (!leased(deps)) return false;
    const text = JSON.stringify(state);
    if (text === saved) return true;
    try {
      writeTelegramState(root, state);
    } catch (err) {
      unsaved.set(root, state);
      cantWrite(err);
      return false;
    }
    endSpell(root, 'save');
    saved = text;
    return true;
  };
  try {
    await syncMessages({ call, chat: t.chat, state, open: list, root, L, deps });
    // on disk before the long poll: a daemon stopped while it waits has its messages and buttons on record; and no
    // update is taken that could not be recorded
    if (!list.length || !save()) return;
    // answers off (a phase attended in the owner's session): no update is taken; they wait in Telegram
    if (!answers) {
      logOnce(deps, root, 'held', "telegram: answers wait while a phase is attended in the owner's session; they are taken after turbo-run attend <phase> --done");
      return;
    }
    endSpell(root, 'held');
    await pollUpdates({ call, chat: t.chat, state, root, config, L, deps, now, laneRunning });
  } finally {
    save();
  }
}
