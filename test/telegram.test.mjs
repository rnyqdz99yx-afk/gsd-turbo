import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir } from './helpers/tmp.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { MAX_BUTTONS, callbackData, createBot, parseCallback, readTelegramState, shortId, telegramSettings, writeTelegramState } from '../lib/telegram.mjs';

// a bot token's shape, built at run time; the chat id is made up
const TOKEN = `${'123456789'}:${'A'.repeat(35)}`;
const ENV = { TURBO_TELEGRAM_TOKEN: TOKEN, TURBO_TELEGRAM_CHAT: '4242' };
const ON = (more = {}) => ({ ...structuredClone(DEFAULTS), notify: { desktop: false, telegram: true }, answer: { telegram: true }, ...more });

test('Telegram answers need notify.telegram, answer.telegram, the token and a private chat id; answer.telegram is off by default (Review Focus 2)', () => {
  assert.deepEqual(DEFAULTS.answer, { telegram: false });
  assert.deepEqual(telegramSettings(ON(), ENV), { token: TOKEN, chat: '4242' });
  assert.equal(telegramSettings(ON({ answer: { telegram: false } }), ENV), null);
  assert.equal(telegramSettings(ON({ notify: { desktop: true, telegram: false } }), ENV), null);
  assert.equal(telegramSettings(ON(), { ...ENV, TURBO_TELEGRAM_TOKEN: '' }), null);
  assert.equal(telegramSettings(ON(), { ...ENV, TURBO_TELEGRAM_CHAT: '-100123' }), null, 'a group is no private chat');
  assert.equal(telegramSettings(ON(), { ...ENV, TURBO_TELEGRAM_CHAT: '@owner' }), null);
  assert.equal(telegramSettings(ON(), { ...ENV, TURBO_TELEGRAM_CHAT: '04242' }), null, 'never equal to a from.id as text');
});

test('callback data t3:<short id>:<option>:<nonce> stays within 64 bytes for the longest ids and parses back exactly (Review Focus 5)', () => {
  const short = shortId('123.45A', 'ABC-123.45-67-t99');
  assert.match(short, /^[0-9a-f]{8}$/);
  assert.equal(shortId('123.45A', 'ABC-123.45-67-t99'), short, 'stable');
  assert.notEqual(shortId('3', 'a'), shortId('4', 'a'));
  for (const k of [1, MAX_BUTTONS, 'o']) {
    const data = callbackData(short, k, 'deadbeef');
    assert.ok(Buffer.byteLength(data) <= 64, data);
    assert.deepEqual(parseCallback(data), { short, k, nonce: 'deadbeef' });
  }
  for (const bad of ['', 't3:x', `t3:${short}:1:DEADBEEF`, `t2:${short}:1:deadbeef`, `t3:${short}:100:deadbeef`, null]) assert.equal(parseCallback(bad), null, String(bad));
});

test('the bot posts JSON to the method URL; a Telegram error or a network failure never carries the token (Review Focus 3)', async () => {
  const calls = [];
  const ok = createBot({ token: TOKEN, fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) }; } });
  assert.deepEqual(await ok('sendMessage', { chat_id: '4242', text: 'x' }), { message_id: 7 });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: '4242', text: 'x' });
  const denied = createBot({ token: TOKEN, fetchImpl: async () => ({ status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) }) });
  await assert.rejects(denied('sendMessage', {}), (e) => e.message === 'telegram sendMessage failed: Bad Request: chat not found' && !e.transient);
  const down = createBot({ token: TOKEN, fetchImpl: async (url) => { throw new TypeError(`fetch failed for ${url}`); } });
  await assert.rejects(down('getUpdates', {}), (e) => !e.message.includes(TOKEN) && e.message === 'telegram getUpdates failed: fetch failed for https://api.telegram.org/bot[token]/getUpdates' && e.transient === true);
  const garbled = createBot({ token: TOKEN, fetchImpl: async () => ({ status: 502, json: async () => { throw new Error('not json'); } }) });
  await assert.rejects(garbled('getUpdates', {}), (e) => /telegram getUpdates failed: HTTP 502/.test(e.message) && e.transient === true);
  const busy = createBot({ token: TOKEN, fetchImpl: async () => ({ status: 429, json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' }) }) });
  await assert.rejects(busy('sendMessage', {}), (e) => e.transient === true);
  const slow = createBot({ token: TOKEN, timeoutMs: 1, fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
  await assert.rejects(slow('getUpdates', {}), (e) => e.message === 'telegram getUpdates failed: timed out' && e.transient === true);
});

test('run/telegram.json keeps the bot, the offset with its time, the sent messages, the nonces and the reply prompts; anything broken reads as empty', () => {
  const root = tmpDir('tg');
  assert.deepEqual(readTelegramState(root), { v: 1, bot: null, offset: 0, offsetAt: null, sent: {}, nonces: {}, replies: {} });
  writeTelegramState(root, { v: 1, bot: 'b1', offset: 12, offsetAt: '2026-01-01T10:00:00.000Z', sent: { '3:a': { rev: 1 } }, nonces: {}, replies: [] });
  assert.deepEqual(readTelegramState(root), { v: 1, bot: 'b1', offset: 12, offsetAt: '2026-01-01T10:00:00.000Z', sent: { '3:a': { rev: 1 } }, nonces: {}, replies: {} });
  writeTelegramState(root, { offset: -3, bot: 7, offsetAt: 5, sent: 'x' });
  assert.deepEqual(readTelegramState(root), { v: 1, bot: null, offset: 0, offsetAt: null, sent: {}, nonces: {}, replies: {} });
});
