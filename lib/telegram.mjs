import crypto from 'node:crypto';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { openQuestions } from './view.mjs';
import { PhaseLocked, readQuestions } from './questions.mjs';
import { AnswerRefused, QuestionChanged, TEXT_MAX, answerQuestion, describeAnswer } from './answers.mjs';

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
  if (config?.notify?.telegram !== true || config?.answer?.telegram !== true) return null;
  const token = String(env.TURBO_TELEGRAM_TOKEN || '').trim();
  const chat = String(env.TURBO_TELEGRAM_CHAT || '').trim();
  return token && /^[1-9]\d*$/.test(chat) ? { token, chat } : null;
}

// One Bot API call: POST JSON, the result or an error. No error ever carries the token (it is in the URL). An error
// is transient when the network failed or timed out, or Telegram is overloaded (HTTP 5xx, 429): the same call may
// work next tick. Any other is Telegram refusing this very call.
export function createBot({ token, fetchImpl = globalThis.fetch, timeoutMs = CALL_TIMEOUT_MS }) {
  const hide = (s) => String(s ?? '').split(token).join('[token]');
  const fail = (method, why, transient) => Object.assign(new Error(`telegram ${method} failed: ${hide(why)}`), { transient });
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
    } catch {
      // not JSON: reported by the HTTP status below
    }
    if (data?.ok) return data.result;
    const code = Number(data?.error_code) || Number(res?.status) || 0;
    throw fail(method, data?.description || `HTTP ${res?.status}`, !data || code === 429 || code >= 500);
  };
}

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
const emptyState = (bot = null) => ({ v: 1, bot, offset: 0, offsetAt: null, sent: {}, nonces: {}, replies: {} });
export function readTelegramState(root) {
  const s = readJson(stateFile(root), null);
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
export const writeTelegramState = (root, state) => writeJsonAtomic(stateFile(root), state);

const MESSAGE_MAX = 4000;
const BUTTON_MAX = 60;
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
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
const keyOf = (q) => `${q.phase}:${q.id}`;
// which bot and chat a state file belongs to: a hash, so the file never holds a part of the token
const botOf = ({ token, chat }) => crypto.createHash('sha256').update(`${token}\n${chat}`).digest('hex').slice(0, 16);

// The owner's language (config.lang). turbo's own words only: the questions themselves are as S1a built them.
export const TEXTS = {
  en: {
    title: 'Phase {phase} · {plan} task {task}',
    other: 'Other…',
    more: '(+{n} more: answer with {other} and name it)',
    closed: 'closed',
    moved: 'changed: see the new message',
    prompt: 'Your answer to {plan} task {task} in your own words (up to {max} characters), as a reply to this message:',
    reply: 'Reply to the message I just sent.',
    expired: 'This button no longer works.',
    changed: 'This question changed: answer the new message.',
    recorded: '✓ {what}',
    already: 'Already answered: {what}',
    refused: 'Not recorded: {why}',
    secret: ' Delete your message from this chat.',
    tooLong: 'Not recorded: longer than {max} characters. Reply again, shorter.',
  },
  ru: {
    title: 'Фаза {phase} · {plan}, задача {task}',
    other: 'Другое…',
    more: '(ещё {n}: ответь через «{other}» и назови)',
    closed: 'закрыт',
    moved: 'изменился: смотри новое сообщение',
    prompt: 'Твой ответ на {plan}, задача {task}, своими словами (до {max} символов), ответом на это сообщение:',
    reply: 'Ответь на сообщение, которое я только что отправил.',
    expired: 'Эта кнопка больше не работает.',
    changed: 'Вопрос изменился: ответь на новое сообщение.',
    recorded: '✓ {what}',
    already: 'Уже отвечено: {what}',
    refused: 'Не записано: {why}',
    secret: ' Удали своё сообщение из этого чата.',
    tooLong: 'Не записано: длиннее {max} символов. Ответь ещё раз, короче.',
  },
};

// A nonce no live button has: one press never reaches another button's question or option.
function newNonce(deps, taken) {
  for (let i = 0; i < NONCE_TRIES; i++) {
    const n = deps.nonce ? deps.nonce() : crypto.randomBytes(4).toString('hex');
    if (!taken.has(n)) return n;
  }
  throw new Error('telegram: no free button nonce');
}

// The question as one message, plain text (no parse_mode: nothing in it is read as markup): title, question, the
// options with their descriptions, then the context (cut last).
function questionText(q, options, title, L) {
  const lines = [title, q.question];
  const shown = options.slice(0, MAX_BUTTONS);
  if (shown.length) lines.push('', ...shown.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`));
  if (options.length > MAX_BUTTONS) lines.push(fill(L.more, { n: options.length - MAX_BUTTONS, other: L.other }));
  if (q.context) lines.push('', q.context);
  return fit(lines.join('\n'), MESSAGE_MAX);
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
    await call('editMessageText', { chat_id: chat, message_id: sent.messageId, text: fit(`${sent.title}\n${line}`, MESSAGE_MAX) });
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
    const line = q ? `↻ ${L.moved}` : cur?.answer ? `✓ ${describeAnswer(cur.answer)}` : `✓ ${L.closed}`;
    await close({ call, chat, state, key, line, deps });
  }
  for (const [m, r] of Object.entries(state.replies)) {
    const q = byKey.get(`${r?.phase}:${r?.id}`);
    if (!q || (q.rev || 1) !== r.rev) delete state.replies[m];
  }
  for (const q of open) {
    if (state.sent[keyOf(q)]) continue;
    const rev = q.rev || 1;
    const short = shortId(q.phase, q.id);
    const options = Array.isArray(q.options) ? q.options : [];
    const nonces = {};
    const taken = new Set(Object.keys(state.nonces));
    const add = (k, label) => {
      const n = newNonce(deps, taken);
      taken.add(n);
      nonces[n] = { phase: q.phase, id: q.id, plan: q.plan, task: q.task, rev, k, label };
      return n;
    };
    // an empty button text makes Telegram refuse the whole message: the option's number instead
    const rows = options.slice(0, MAX_BUTTONS).map((o, i) => [{ text: fit(String(o?.label ?? '').trim(), BUTTON_MAX) || String(i + 1), callback_data: callbackData(short, i + 1, add(i + 1, o?.label ?? null)) }]);
    if (q.allowOther) rows.push([{ text: L.other, callback_data: callbackData(short, 'o', add('o', null)) }]);
    const title = fill(L.title, { phase: q.phase, plan: q.plan, task: q.task });
    const msg = await call('sendMessage', { chat_id: chat, text: questionText(q, options, title, L), ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
    // recorded only once sent: a failed send leaves no button behind and is tried again next tick
    Object.assign(state.nonces, nonces);
    state.sent[keyOf(q)] = { rev, messageId: msg?.message_id ?? null, title, nonces: Object.keys(nonces) };
  }
}

const POLL_MAX_SECONDS = 50;
const CALLBACK_REPLY_MAX = 190;
const WORDS_SHOWN = 100;
// Telegram keeps an update a day at most, and numbers the next one at random after a week without any
const OFFSET_KEEP_MS = 24 * 60 * 60 * 1000;

// One answer through the single arbiter, with the revision its message showed (S1a's --rev contract). A locked
// phase (PhaseLocked) and any other failure are thrown: nothing was recorded.
function record({ root, ref, option = null, text = null, now, laneRunning, L, deps }) {
  const answer = deps.answer || answerQuestion;
  try {
    const r = answer({ root, phase: ref.phase, id: ref.id, option, text, by: 'telegram', now, laneRunning, rev: ref.rev });
    if (r.status === 'already') {
      const what = describeAnswer(r.record);
      return { done: true, text: fill(L.already, { what }), shown: what };
    }
    const what = r.record.label ?? fit(r.record.answer, WORDS_SHOWN);
    return { done: true, text: fill(L.recorded, { what }), shown: what };
  } catch (err) {
    if (err instanceof QuestionChanged) return { done: false, text: L.changed };
    if (err instanceof AnswerRefused) return { done: false, text: fill(L.refused, { why: err.message }) + (/contains a secret/.test(err.message) ? L.secret : '') };
    throw err;
  }
}

// A button press. Only the owner's count; a nonce works once: it is used up by the first press that reaches the
// arbiter (or opens the Other prompt), whatever the outcome. A press that could not (a locked phase, a failed send)
// leaves it working.
async function onButton({ call, chat, state, root, L, deps, now, laneRunning, cb }) {
  if (String(cb?.from?.id ?? '') !== chat) {
    deps.log('telegram: a button press from another user was ignored');
    return;
  }
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
    const msg = await call('sendMessage', { chat_id: chat, text: fill(L.prompt, { plan: ref.plan, task: ref.task, max: TEXT_MAX }), reply_markup: { force_reply: true } });
    useUp();
    if (msg?.message_id != null) state.replies[String(msg.message_id)] = { phase: ref.phase, id: ref.id, plan: ref.plan, task: ref.task, rev: ref.rev };
    await tell(L.reply);
    return;
  }
  const r = record({ root, ref, option: ref.k, now, laneRunning, L, deps });
  useUp();
  await tell(r.text);
  if (r.done) await close({ call, chat, state, key, line: `✓ ${r.shown}`, deps });
}

// A message. Only the owner's replies, in the owner's chat, to one of turbo's force-reply prompts count; the prompt
// stays until an answer is recorded.
async function onReply({ call, chat, state, root, L, deps, now, laneRunning, m }) {
  if (String(m?.from?.id ?? '') !== chat) {
    deps.log('telegram: a message from another user was ignored');
    return;
  }
  if (String(m.chat?.id ?? '') !== chat) {
    deps.log('telegram: a message from another chat was ignored');
    return;
  }
  const to = String(m.reply_to_message?.message_id ?? '');
  const ref = to && Object.hasOwn(state.replies, to) ? state.replies[to] : null;
  if (!isObj(ref)) return;
  const text = typeof m.text === 'string' ? m.text : '';
  const r = [...text].length > TEXT_MAX ? { done: false, text: fill(L.tooLong, { max: TEXT_MAX }) } : record({ root, ref, text, now, laneRunning, L, deps });
  if (r.done) {
    delete state.replies[to];
    await close({ call, chat, state, key: `${ref.phase}:${ref.id}`, line: `✓ ${r.shown}`, deps });
  }
  // the owner may have deleted the message already (a secret): the reply goes out all the same
  await call('sendMessage', { chat_id: chat, text: fit(r.text, MESSAGE_MAX), reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } });
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
  for (const u of Array.isArray(updates) ? updates : []) {
    if (!Number.isInteger(u?.update_id)) continue;
    let stop = false;
    try {
      if (u.callback_query) await onButton({ call, chat, state, root, L, deps, now, laneRunning, cb: u.callback_query });
      else if (u.message) await onReply({ call, chat, state, root, L, deps, now, laneRunning, m: u.message });
    } catch (err) {
      deps.log(`telegram: ${errLine(err)}`);
      if (err instanceof PhaseLocked) break;
      stop = Boolean(err?.transient);
    }
    next = Math.max(next, u.update_id + 1);
    if (stop) break;
  }
  if (next !== offset) Object.assign(state, { offset: next, offsetAt: now.toISOString() });
}

// The Telegram part of a supervisor tick (spec §5.3). Nothing without telegramSettings. A Telegram error ends this
// part (ownerTick logs it); the state is saved either way, so nothing is sent twice.
export async function telegramTick(ctx, now, { laneRunning = false, open = null } = {}) {
  const { root, config, deps } = ctx;
  const t = telegramSettings(config, deps.env || process.env);
  if (!t) return;
  const L = Object.hasOwn(TEXTS, config.lang) ? TEXTS[config.lang] : TEXTS.en;
  const call = deps.telegram || createBot({ token: t.token, fetchImpl: deps.fetch || globalThis.fetch });
  const list = open ?? openQuestions(root);
  let state = readTelegramState(root);
  let saved = JSON.stringify(state);
  // another bot or chat: the messages, buttons and update offset on record belong to the old one
  const bot = botOf(t);
  if (state.bot !== bot) state = emptyState(bot);
  if (!list.length && !Object.keys(state.sent).length) return;
  const save = () => {
    const text = JSON.stringify(state);
    if (text === saved) return;
    writeTelegramState(root, state);
    saved = text;
  };
  try {
    await syncMessages({ call, chat: t.chat, state, open: list, root, L, deps });
    if (!list.length) return;
    // on disk before the long poll: a daemon stopped while it waits has its messages and buttons on record
    save();
    await pollUpdates({ call, chat: t.chat, state, root, config, L, deps, now, laneRunning });
  } finally {
    save();
  }
}
