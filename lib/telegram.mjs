import crypto from 'node:crypto';
import path from 'node:path';
import { runDir } from './paths.mjs';
import { readJson, writeJsonAtomic } from './fsx.mjs';

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
