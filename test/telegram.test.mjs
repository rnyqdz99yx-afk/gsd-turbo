import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { PhaseLocked, readAnswers, writeQuestions } from '../lib/questions.mjs';
import { answerQuestion } from '../lib/answers.mjs';
import { ownerTick } from '../lib/owner-tick.mjs';
import {
  MAX_BUTTONS, callbackData, createBot, parseCallback, readTelegramState, shortId, telegramSettings, telegramTick, writeTelegramState,
} from '../lib/telegram.mjs';

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
  // a pending request holds the event loop the way a real socket does: AbortSignal.timeout's own timer is unref'd, so a
  // fake that waits on nothing else lets the loop drain before the abort (the Node 22 test runner cancels the file)
  const slow = createBot({ token: TOKEN, timeoutMs: 1, fetchImpl: (url, init) => new Promise((resolve, reject) => {
    const socket = setTimeout(resolve, 60000);
    init.signal.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
  }) });
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

const NOW = new Date('2026-01-01T10:00:00.000Z');
const OPT = (label, more = {}) => ({ label, description: '', recommended: false, signal: label.toLowerCase(), defer: false, ...more });
// an open decision of phase 3 in S1a's question shape
const Q = (id, over = {}) => ({
  id, phase: '3', plan: '03-01', task: '2', kind: 'decision', gate: 'blocking', header: '03-01 T2', question: 'Pick the store', context: 'Small data.',
  options: [OPT('Files', { recommended: true, description: '+ simple' }), OPT('SQLite')], allowOther: true, condition: null,
  class: 'decision', topic: null, classified: false, agentId: null, stopped: false, state: 'open', answer: null, delivery: null, rev: 1, source: 'plan', ...over,
});

// A fake Bot API: message ids from 101, getUpdates hands out the queued updates (onPoll runs first, failPoll throws,
// failEdit makes every edit throw).
function fakeBot() {
  const bot = { calls: [], updates: [], onPoll: null, failPoll: null, failEdit: null };
  let id = 100;
  bot.call = async (method, body, opts) => {
    bot.calls.push({ method, body, opts });
    if (method === 'sendMessage') return { message_id: ++id };
    if (method === 'editMessageText' && bot.failEdit) throw bot.failEdit;
    if (method === 'getUpdates') {
      if (bot.failPoll) throw bot.failPoll;
      bot.onPoll?.();
      return bot.updates.splice(0);
    }
    return true;
  };
  bot.sent = () => bot.calls.filter((c) => c.method === 'sendMessage');
  return bot;
}
function project() {
  const root = tmpDir('tgq');
  fs.mkdirSync(path.join(root, '.planning'));
  const bot = fakeBot();
  const logs = [];
  let n = 0;
  const ctx = { root, config: ON(), deps: { env: ENV, telegram: bot.call, nonce: () => `0000000${++n}`.slice(-8), log: (l) => logs.push(l), notify: async () => {} } };
  return { root, ctx, bot, logs };
}

test('each open question goes out once, with a button per option (recommended first) and Other where own words count', async () => {
  const { root, ctx, bot } = project();
  writeQuestions(root, '3', [Q('03-01-t2'), Q('03-01-t4', { task: '4', kind: 'human-action', question: 'Action: verify the mail', context: '', options: [OPT('I will do it when the lane asks', { signal: null, defer: true })], allowOther: false })]);
  await telegramTick(ctx, NOW);
  const sent = bot.sent();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.chat_id, '4242');
  assert.equal(sent[0].body.text, 'Phase 3 · 03-01 task 2\nPick the store\n\n1. Files — + simple\n2. SQLite\n\nSmall data.');
  assert.equal(sent[0].body.parse_mode, undefined, 'plain text: nothing in a question is read as markup');
  const short = shortId('3', '03-01-t2');
  assert.deepEqual(sent[0].body.reply_markup.inline_keyboard, [
    [{ text: 'Files', callback_data: `t3:${short}:1:00000001` }],
    [{ text: 'SQLite', callback_data: `t3:${short}:2:00000002` }],
    [{ text: 'Other…', callback_data: `t3:${short}:o:00000003` }],
  ]);
  assert.deepEqual(sent[1].body.reply_markup.inline_keyboard.map((r) => r[0].text), ['I will do it when the lane asks']);
  const state = readTelegramState(root);
  assert.deepEqual(state.sent['3:03-01-t2'], { rev: 1, messageId: 101, title: 'Phase 3 · 03-01 task 2', nonces: ['00000001', '00000002', '00000003'] });
  assert.deepEqual(state.nonces['00000002'], { phase: '3', id: '03-01-t2', plan: '03-01', task: '2', rev: 1, k: 2, label: 'SQLite' });
  await telegramTick(ctx, NOW);
  assert.equal(bot.sent().length, 2, 'sent once');
});

test('a decision with 5 options: 4 buttons and Other, the fifth named in the text; the text is cut at 4000 characters (Review Focus 5)', async () => {
  const { root, ctx, bot } = project();
  writeQuestions(root, '3', [Q('03-01-t2', { options: ['A', 'B', 'C', 'D', 'E'].map((x) => OPT(x)), context: 'z'.repeat(5000) })]);
  await telegramTick(ctx, NOW);
  const [m] = bot.sent();
  assert.deepEqual(m.body.reply_markup.inline_keyboard.map((r) => r[0].text), ['A', 'B', 'C', 'D', 'Other…']);
  assert.match(m.body.text, /\n4\. D\n\(\+1 more: answer with Other… and name it\)\n/);
  assert.equal([...m.body.text].length, 4000);
});

test('an option whose label is empty gets its number as the button text, which Telegram would refuse empty', async () => {
  const { root, ctx, bot } = project();
  writeQuestions(root, '3', [Q('03-01-t2', { options: [OPT('Files'), OPT(' ')], allowOther: false })]);
  await telegramTick(ctx, NOW);
  assert.deepEqual(bot.sent()[0].body.reply_markup.inline_keyboard.map((r) => r[0].text), ['Files', '2']);
});

test('a question answered on another channel: its message loses its buttons and shows the answer; a changed question gets a new message', async () => {
  const { root, ctx, bot } = project();
  writeQuestions(root, '3', [Q('03-01-t2'), Q('03-01-t5', { task: '5', header: '03-01 T5' })]);
  await telegramTick(ctx, NOW);
  writeQuestions(root, '3', [
    Q('03-01-t2', { state: 'answered', answer: { option: 1, label: 'Files', answer: 'files', by: 'session', at: NOW.toISOString(), conditional: false } }),
    Q('03-01-t5', { task: '5', header: '03-01 T5', rev: 2, stopped: true, options: [OPT('Approved')] }),
  ]);
  await telegramTick(ctx, NOW);
  const edits = bot.calls.filter((c) => c.method === 'editMessageText');
  assert.deepEqual(edits.map((e) => [e.body.message_id, e.body.text]), [
    [101, `Phase 3 · 03-01 task 2\n✓ Files, session, ${NOW.toISOString()}`],
    [102, 'Phase 3 · 03-01 task 5\n↻ changed: see the new message'],
  ]);
  assert.equal(edits[0].body.reply_markup, undefined, 'no buttons left');
  const state = readTelegramState(root);
  assert.equal(state.sent['3:03-01-t2'], undefined);
  assert.deepEqual([state.sent['3:03-01-t5'].rev, state.sent['3:03-01-t5'].messageId], [2, 103]);
  assert.equal(Object.values(state.nonces).filter((r) => r.id === '03-01-t2' || r.rev === 1).length, 0, 'the old buttons work no more');
});

test('an edit the network loses keeps the message and its buttons for the next tick; one Telegram refuses is logged and let go (Review Focus 3)', async () => {
  const { root, ctx, bot, logs } = project();
  writeQuestions(root, '3', [Q('03-01-t2'), Q('03-01-t5', { task: '5', header: '03-01 T5' })]);
  await telegramTick(ctx, NOW);
  writeQuestions(root, '3', [Q('03-01-t5', { task: '5', header: '03-01 T5', rev: 2, options: [OPT('Approved')] })]);
  bot.failEdit = Object.assign(new Error('telegram editMessageText failed: timed out'), { transient: true });
  await assert.rejects(telegramTick(ctx, NOW), /timed out/);
  let state = readTelegramState(root);
  assert.deepEqual(Object.keys(state.sent).sort(), ['3:03-01-t2', '3:03-01-t5'], 'nothing forgotten, nothing new sent');
  assert.equal(Object.keys(state.nonces).length, 6);
  assert.equal(bot.sent().length, 2);
  bot.failEdit = new Error('telegram editMessageText failed: Bad Request: message to edit not found');
  await telegramTick(ctx, NOW);
  state = readTelegramState(root);
  assert.deepEqual(Object.keys(state.sent), ['3:03-01-t5']);
  assert.equal(state.sent['3:03-01-t5'].rev, 2);
  assert.ok(logs.includes('telegram: telegram editMessageText failed: Bad Request: message to edit not found'), logs.join('\n'));
});

test('another bot token or chat starts afresh: the open questions go to the new chat, the old offset is dropped', async () => {
  const { root, ctx, bot } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  await telegramTick(ctx, NOW);
  const before = readTelegramState(root);
  assert.match(before.bot, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(before).includes(TOKEN.split(':')[1]), 'no part of the token is kept');
  writeTelegramState(root, { ...before, offset: 900 });
  ctx.deps.env = { ...ENV, TURBO_TELEGRAM_TOKEN: `${'987654321'}:${'B'.repeat(35)}` };
  await telegramTick(ctx, NOW);
  assert.equal(bot.sent().length, 2, 'sent again by the new bot');
  const after = readTelegramState(root);
  assert.notEqual(after.bot, before.bot);
  assert.equal(after.offset, 0);
  assert.equal(bot.calls.filter((c) => c.method === 'editMessageText').length, 0, 'the old bot\'s message is not touched');
});

test('ownerTick sends the Telegram questions after its notification; a Telegram failure is logged and changes nothing else', async () => {
  const { root, ctx, bot, logs } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  const notes = [];
  ctx.deps.notify = async (key) => { notes.push(key); };
  await ownerTick(ctx, NOW, { lane: null });
  assert.deepEqual(notes, ['questionsReady']);
  assert.equal(bot.sent().length, 1);
  ctx.deps.telegram = async () => { throw new Error('telegram sendMessage failed: Bad Gateway'); };
  writeQuestions(root, '3', [Q('03-01-t2'), Q('03-01-t6', { task: '6', header: '03-01 T6' })]);
  await ownerTick(ctx, NOW, { lane: null });
  assert.deepEqual(notes, ['questionsReady', 'questionsReady']);
  assert.ok(logs.includes('telegram: telegram sendMessage failed: Bad Gateway'), logs.join('\n'));
});

// updates as Telegram sends them
const press = (data, update_id, from = 4242, id = `cb${update_id}`) => ({ update_id, callback_query: { id, from: { id: from }, data, message: { message_id: 101, chat: { id: from } } } });
const reply = (text, update_id, to, from = 4242, chat = from) => ({ update_id, message: { message_id: 500 + update_id, from: { id: from }, chat: { id: chat }, text, reply_to_message: { message_id: to } } });
const pressReplies = (bot) => bot.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => [c.body.callback_query_id, c.body.text]);
const polls = (bot) => bot.calls.filter((c) => c.method === 'getUpdates');

test('the owner\'s press records the option by telegram, answers the press and turns the message into the answer; the offset moves on', async () => {
  const { root, ctx, bot } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  let onDisk = null;
  bot.onPoll = () => { onDisk = readTelegramState(root).sent['3:03-01-t2']?.messageId; };
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.equal(onDisk, 101, 'what was sent is on disk before the long poll: a daemon stopped while it waits sends nothing twice');
  bot.updates.push(press(`t3:${shortId('3', '03-01-t2')}:2:00000002`, 41));
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(readAnswers(root, '3').map((r) => [r.id, r.option, r.label, r.by]), [['03-01-t2', 2, 'SQLite', 'telegram']]);
  assert.deepEqual(pressReplies(bot), [['cb41', '✓ SQLite']]);
  const edit = bot.calls.find((c) => c.method === 'editMessageText');
  assert.deepEqual([edit.body.message_id, edit.body.text], [101, 'Phase 3 · 03-01 task 2\n✓ SQLite']);
  assert.equal(readTelegramState(root).offset, 42);
  const poll = polls(bot)[0];
  assert.deepEqual([poll.body.offset, poll.body.timeout, poll.body.allowed_updates, poll.opts.timeoutMs], [0, 20, ['callback_query', 'message'], 30000]);
  assert.equal(polls(bot)[1].body.offset, 0);
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.equal(polls(bot).length, 2, 'no question open: no poll');
});

test('a stranger\'s press, an unknown nonce, a button of an older revision and a used button record nothing (Review Focus 1, 2)', async () => {
  const { root, ctx, bot, logs } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  await telegramTick(ctx, NOW, { laneRunning: true });
  const short = shortId('3', '03-01-t2');
  bot.updates.push(press(`t3:${short}:1:00000001`, 1, 999), press(`t3:${short}:1:0badc0de`, 2));
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.ok(logs.includes('telegram: a button press from another user was ignored'));
  assert.ok(!logs.join('\n').includes('999') && !logs.join('\n').includes(short), 'nothing of a stranger\'s update is logged');
  // the lane reopens the question at a stop (rev 2) between the last sync and the owner's press of an old button
  bot.onPoll = () => writeQuestions(root, '3', [Q('03-01-t2', { rev: 2, stopped: true })]);
  bot.updates.push(press(`t3:${short}:1:00000001`, 3));
  await telegramTick(ctx, NOW, { laneRunning: true });
  bot.onPoll = null;
  bot.updates.push(press(`t3:${short}:1:00000001`, 4));
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(pressReplies(bot), [['cb2', 'This button no longer works.'], ['cb3', 'This question changed: answer the new message.'], ['cb4', 'This button no longer works.']]);
  assert.deepEqual(readAnswers(root, '3'), []);
});

test('a double press records once: the second finds its button gone (Review Focus 1)', async () => {
  const { root, ctx, bot } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  await telegramTick(ctx, NOW, { laneRunning: true });
  const short = shortId('3', '03-01-t2');
  bot.updates.push(press(`t3:${short}:1:00000001`, 5), press(`t3:${short}:1:00000001`, 6), press(`t3:${short}:2:00000002`, 7));
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(readAnswers(root, '3').map((r) => r.option), [1]);
  assert.deepEqual(pressReplies(bot), [['cb5', '✓ Files'], ['cb6', 'This button no longer works.'], ['cb7', 'This button no longer works.']]);
});

test('Other asks for own words with force_reply; the reply is recorded; too long or a secret is refused and the prompt stays (Review Focus 4)', async () => {
  const { root, ctx, bot, logs } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  await telegramTick(ctx, NOW, { laneRunning: true });
  bot.updates.push(press(`t3:${shortId('3', '03-01-t2')}:o:00000003`, 1));
  await telegramTick(ctx, NOW, { laneRunning: true });
  const prompt = bot.sent().at(-1);
  assert.deepEqual(prompt.body.reply_markup, { force_reply: true });
  assert.equal(prompt.body.text, 'Your answer to 03-01 task 2 in your own words (up to 2000 characters), as a reply to this message:');
  assert.deepEqual(pressReplies(bot), [['cb1', 'Reply to the message I just sent.']]);
  const token = `ghp_${'a1B2'.repeat(9)}`;
  bot.updates.push(reply('x'.repeat(2001), 2, 102), reply(`use ${token}`, 3, 102), reply('Use files', 4, 102, 999), reply('unrelated chat', 5, 77), reply('Use files', 6, 102, 4242, -100123));
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(readAnswers(root, '3'), []);
  const [tooLong, secret] = bot.sent().slice(-2).map((m) => m.body);
  assert.equal(tooLong.text, 'Not recorded: longer than 2000 characters. Reply again, shorter.');
  assert.deepEqual(tooLong.reply_parameters, { message_id: 502, allow_sending_without_reply: true });
  assert.match(secret.text, /^Not recorded: the answer looks like it contains a secret \(github token\).* Delete your message from this chat\.$/);
  assert.ok(logs.includes('telegram: a message from another user was ignored'));
  assert.ok(logs.includes('telegram: a message from another chat was ignored'), 'the owner in a group is no answer either');
  assert.ok(!logs.join('\n').includes(token) && !JSON.stringify(bot.calls.filter((c) => c.method !== 'getUpdates')).includes(token));
  bot.updates.push(reply('Files, but keep a backup', 7, 102));
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(readAnswers(root, '3').map((r) => [r.answer, r.by, r.option]), [['Files, but keep a backup', 'telegram', null]]);
  assert.equal(bot.sent().at(-1).body.text, '✓ Files, but keep a backup');
  assert.equal(readTelegramState(root).replies['102'], undefined);
});

test('no open question: no polling; off: nothing at all; a failing getUpdates keeps what was sent and the next tick goes on (Review Focus 3)', async () => {
  const { root, ctx, bot } = project();
  await telegramTick(ctx, NOW);
  assert.deepEqual(bot.calls, []);
  ctx.config = ON({ answer: { telegram: false } });
  writeQuestions(root, '3', [Q('03-01-t2')]);
  await telegramTick(ctx, NOW);
  assert.deepEqual(bot.calls, []);
  ctx.config = ON();
  bot.failPoll = new Error('telegram getUpdates failed: timed out');
  await assert.rejects(telegramTick(ctx, NOW, { laneRunning: true }), /timed out/);
  assert.equal(readTelegramState(root).sent['3:03-01-t2'].messageId, 101);
  bot.failPoll = null;
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.equal(bot.sent().length, 1, 'not sent twice');
});

test('a press that finds the phase locked records nothing and keeps its button; it and the updates after it come again next tick', async () => {
  const { root, ctx, bot, logs } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  await telegramTick(ctx, NOW, { laneRunning: true });
  const short = shortId('3', '03-01-t2');
  const line = 'the questions of phase 3 are locked by another turbo-run (p3-questions.lock); try again';
  let locked = 1;
  ctx.deps.answer = (args) => {
    if (locked-- > 0) throw new PhaseLocked(line);
    return answerQuestion(args);
  };
  const batch = () => [press(`t3:${short}:1:00000001`, 7), press(`t3:${short}:2:00000002`, 8)];
  bot.updates.push(...batch());
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(readAnswers(root, '3'), []);
  assert.deepEqual(pressReplies(bot), []);
  assert.ok(logs.includes(`telegram: ${line}`), logs.join('\n'));
  const state = readTelegramState(root);
  assert.equal(state.offset, 0, 'nothing confirmed');
  assert.ok(state.nonces['00000001'], 'the button still works');
  // Telegram hands out the unconfirmed updates again
  bot.updates.push(...batch());
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(readAnswers(root, '3').map((r) => r.option), [1]);
  assert.deepEqual(pressReplies(bot), [['cb7', '✓ Files'], ['cb8', 'This button no longer works.']]);
  assert.equal(readTelegramState(root).offset, 9);
});

test('a network failure while handling an update stops the batch there; the updates after it come again next tick (Review Focus 3)', async () => {
  const { root, ctx, bot, logs } = project();
  writeQuestions(root, '3', [Q('03-01-t2'), Q('03-01-t5', { task: '5', header: '03-01 T5' })]);
  await telegramTick(ctx, NOW, { laneRunning: true });
  let down = true;
  ctx.deps.telegram = async (method, body, opts) => {
    if (method === 'answerCallbackQuery' && down) {
      down = false;
      throw Object.assign(new Error('telegram answerCallbackQuery failed: timed out'), { transient: true });
    }
    return bot.call(method, body, opts);
  };
  const t5 = press(`t3:${shortId('3', '03-01-t5')}:1:00000004`, 21);
  bot.updates.push(press(`t3:${shortId('3', '03-01-t2')}:1:00000001`, 20), t5);
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.ok(logs.includes('telegram: telegram answerCallbackQuery failed: timed out'), logs.join('\n'));
  assert.deepEqual(readAnswers(root, '3').map((r) => r.id), ['03-01-t2'], 'recorded before the press could be answered');
  assert.equal(readTelegramState(root).offset, 21, 'the update after it was not handled');
  bot.updates.push(t5);
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(readAnswers(root, '3').map((r) => r.id), ['03-01-t2', '03-01-t5']);
  const edits = bot.calls.filter((c) => c.method === 'editMessageText').map((c) => [c.body.message_id, c.body.text.split('\n')[1]]);
  assert.deepEqual(edits, [[101, `✓ Files, telegram, ${NOW.toISOString()}`], [102, '✓ Files']], 'the first message is closed at the next sync');
});

test('an offset that has not moved for a day is not sent: Telegram may number new updates below it', async () => {
  const { root, ctx, bot } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  await telegramTick(ctx, NOW, { laneRunning: true });
  writeTelegramState(root, { ...readTelegramState(root), offset: 5000, offsetAt: new Date(NOW.getTime() - 25 * 3600 * 1000).toISOString() });
  bot.updates.push(press(`t3:${shortId('3', '03-01-t2')}:1:00000001`, 12));
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.equal(polls(bot).at(-1).body.offset, 0);
  assert.deepEqual(readAnswers(root, '3').map((r) => r.option), [1]);
  const state = readTelegramState(root);
  assert.deepEqual([state.offset, state.offsetAt], [13, NOW.toISOString()]);
  writeQuestions(root, '3', [Q('03-01-t2', { rev: 2, stopped: true })]);
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.equal(polls(bot).at(-1).body.offset, 13, 'a fresh offset is sent');
});
