import crypto from 'node:crypto';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';
import { openQuestions } from './view.mjs';
import { readQuestions } from './questions.mjs';
import { describeAnswer } from './answers.mjs';

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
  for (const n of state.sent[key]?.nonces || []) delete state.nonces[n];
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
    const rows = options.slice(0, MAX_BUTTONS).map((o, i) => [{ text: fit(o.label, BUTTON_MAX), callback_data: callbackData(short, i + 1, add(i + 1, o.label)) }]);
    if (q.allowOther) rows.push([{ text: L.other, callback_data: callbackData(short, 'o', add('o', null)) }]);
    const title = fill(L.title, { phase: q.phase, plan: q.plan, task: q.task });
    const msg = await call('sendMessage', { chat_id: chat, text: questionText(q, options, title, L), ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}) });
    // recorded only once sent: a failed send leaves no button behind and is tried again next tick
    Object.assign(state.nonces, nonces);
    state.sent[keyOf(q)] = { rev, messageId: msg?.message_id ?? null, title, nonces: Object.keys(nonces) };
  }
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
  } finally {
    save();
  }
}
