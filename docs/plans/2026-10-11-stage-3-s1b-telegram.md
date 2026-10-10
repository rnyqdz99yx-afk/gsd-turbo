# gsd-turbo Stage 3 S1b — owner answers by Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `notify.telegram` and `answer.telegram` on, the supervisor sends every open owner question to the owner's private Telegram chat with inline buttons, takes button presses and "Other" replies only from the owner, and records them through S1a's single arbiter (`answerQuestion`, `by: 'telegram'`).

**Architecture:** One new module, `lib/telegram.mjs`, runs inside the supervisor's tick through S1a's `ownerTick` (`lib/owner-tick.mjs`). It keeps its own state in the git-ignored `.planning/turbo/run/telegram.json` (the `getUpdates` offset, the sent messages, one-time button nonces, the "Other" prompts). Each tick it first brings the chat in line with the open questions (sends new ones, closes answered or changed ones), then, while questions are open, long-polls `getUpdates` for at most `poll_seconds` (≤ 50 s) and handles presses and replies. All HTTP goes through one injected `fetch`; errors never carry the bot token.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, `node:test`, global `fetch`, zero npm dependencies), Telegram Bot API (`sendMessage`, `editMessageText`, `answerCallbackQuery`, `getUpdates`).

**Spec:** `docs/specs/2026-10-10-stage-3-design.md` — §5.3 "Ответ в Telegram" and the single arbiter, `answer.telegram` of §10, the Telegram tests of §11 (a foreign `from.id`, a reused nonce, `force_reply`), spike 5 of §9 (not run: no bot; tests use a fake `fetch`, the live check waits for the owner's bot).

**Base:** `main` after S0, S2 and S1a (`docs/plans/2026-10-11-stage-3-s1-owner-channel.md`) are merged. Existing code is referenced by function name and anchor text, never by line number.

What this plan consumes from S1a, by exact name:
- `answerQuestion({ root, phase, id, option, text, by: 'telegram', now, laneRunning, rev })` → `{ status: 'recorded' | 'already', record }`; `AnswerRefused`, `QuestionChanged` (a subclass), `TEXT_MAX = 2000`, `describeAnswer` (`lib/answers.mjs`);
- `readQuestions(root, phase)`, `writeQuestions(root, phase, list)` (tests), `readAnswers(root, phase)` (tests) (`lib/questions.mjs`);
- the question contract (`id`, `phase`, `plan`, `task`, `question`, `context`, `options[{ label, description, recommended, signal, defer }]` recommended first, `allowOther`, `state`, `rev`, `answer`);
- `ownerTick(ctx, now, state)` in `lib/owner-tick.mjs`, run at the start of every supervisor tick; S0's `openQuestions(root)`.

## Decisions this plan makes where the spec is open

- **D1 Who may press:** `TURBO_TELEGRAM_CHAT` must be a positive number (a private chat's id is the owner's user id); a group id or `@name` turns the answer channel off. Only updates whose `from.id` equals it count; the rest are dropped with one fixed log line, never their content.
- **D2 Buttons:** the first 4 options (recommended first) as one button each, plus `Other…` where `allowOther`; options beyond 4 are named in the text and answered through `Other…`. `callback_data` = `t3:<8-hex short id>:<k|o>:<8-hex nonce>`, at most 23 bytes; the short id is the first 8 hex digits of `sha1("<phase>:<id>")`.
- **D3 One-time nonces:** a nonce is consumed at its first press, whatever the outcome; all nonces of a message are forgotten when its question is answered (any channel), changes (`rev`) or goes away.
- **D4 Revisions:** a press carries the `rev` its message showed into `answerQuestion` (S1a's `--rev` contract): a question that changed records nothing and the press is told so. A message whose question changed is edited ("changed: see the new message") and a new one is sent.
- **D5 Closing:** a question answered on any channel turns its message into `✓ <answer>, <channel>, <time>` without buttons (`editMessageText` without `reply_markup`); the pressing owner sees `✓ <label>` (spec: "правка сообщения на «✓ <вариант>»").
- **D6 Polling:** only while questions are open, `getUpdates` with `timeout` = `min(poll_seconds, 50)` seconds and `allowed_updates: ['callback_query', 'message']`, once per tick; the offset (`update_id + 1`) is saved even when handling an update fails (that update is logged and skipped).
- **D7 "Other":** `force_reply`; only a reply to that prompt counts, at most 2000 characters; a refused reply (too long, a secret) keeps the prompt so the owner can reply again, and a secret also gets the advice to delete the message.
- **D8 Failures:** a Telegram or network error ends the Telegram part of the tick (logged by `ownerTick`, token-free); what was sent before it is saved (no double send). The notifications of `ownerTick` and the lane's tick are never affected.

## Global Constraints

- Node ≥ 20, ESM `.mjs` only, **zero runtime npm dependencies**; tests use `node:test` and `node:assert/strict`.
- Windows and Linux (CI: Linux / Node 22).
- Public repository: no personal names, hosts, chat ids, tokens or paths in code, tests or commits. The token in tests is built at run time (`` `${'123456789'}:${'A'.repeat(35)}` ``); chat ids are made up.
- Spec values, verbatim: `notify.telegram` + `answer.telegram: true`, `TURBO_TELEGRAM_TOKEN`, `TURBO_TELEGRAM_CHAT`; up to 4 options + «Другое»; `callback_data` = `t3:<короткий id>:<номер варианта>:<nonce>` (≤ 64 bytes), the nonce one-time and kept in `run/telegram.json` with the `offset`; `getUpdates` long poll no longer than `poll_seconds`, only while questions are open; only `from.id` equal to `TURBO_TELEGRAM_CHAT`, the rest dropped and logged without content; `answerCallbackQuery` and the message edited to «✓ <вариант>»; «Другое» → `force_reply`, the reply (≤ 2000 characters) is the free answer; the token is never logged; config `"answer": { "telegram": false }`.
- Every answer goes through `answerQuestion` (`by: 'telegram'`), never around it.
- Tests never touch the network: `ctx.deps.telegram` (a fake `call(method, body, opts)`) or an injected `fetchImpl`. State is written with `writeJsonAtomic`.
- TDD; run only the test files a task names, never the full suite; one commit per task; never push, merge, tag or install.

## Review Focus

1. **The owner presses a button twice, or a button of an old message after the question was re-planned or reopened at a stop.** Expected: nothing is recorded twice or for the wrong options; the press is told "no longer works" or "changed". Pinned in Task 3.
2. **Someone else writes to the bot or presses its buttons** (a forwarded message, a group). Expected: dropped, one log line without content, no reply to them. Pinned in Tasks 1 (`TURBO_TELEGRAM_CHAT` must be a private chat id) and 3.
3. **Telegram or the network fails or times out in the middle of a tick.** Expected: a log line without the token; what was sent stays recorded (no duplicate message); the offset and the nonces survive; the lane's tick is unaffected. Pinned in Tasks 1 and 3.
4. **The owner pastes a secret as a reply.** Expected: refused, the owner is told to delete the message; nothing is recorded or logged. Pinned in Task 3.
5. **A decision with more than four options, or very long texts.** Expected: four buttons plus `Other…`, the rest named in the text; the message stays within Telegram's 4096 characters (cut at 4000); `callback_data` stays ≤ 64 bytes. Pinned in Tasks 1 and 2.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/telegram.mjs` | create | `telegramSettings`, `createBot`, `shortId`, `callbackData`, `parseCallback`, `readTelegramState`, `writeTelegramState`, `telegramTick` |
| `lib/config.mjs` | modify | `DEFAULTS.answer = { telegram: false }` |
| `lib/owner-tick.mjs` | modify | `ownerTick` runs `telegramTick` after its notifications |
| `README.md` | modify | Config row `answer.telegram`; the Telegram section |
| `test/telegram.test.mjs` | create | tests |

---

### Task 1: Settings, the bot client, callback data and the state file

**Files:**
- Modify: `lib/config.mjs` (`DEFAULTS`)
- Create: `lib/telegram.mjs`
- Test: `test/telegram.test.mjs`

**Interfaces:**
- Consumes: `runDir` (`lib/paths.mjs`); `readJson`, `writeJsonAtomic` (`lib/fsx.mjs`).
- Produces:
  - `DEFAULTS.answer = { telegram: false }`;
  - `telegramSettings(config, env = process.env) → { token, chat } | null`;
  - `createBot({ token, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) → call(method, body, { timeoutMs } = {}) → Promise<result>`; throws `telegram <method> failed: <why>` with every occurrence of the token replaced by `[token]`;
  - `MAX_BUTTONS = 4`; `shortId(phase, id) → 8 hex`; `callbackData(short, k, nonce) → 't3:<short>:<k>:<nonce>'`; `parseCallback(data) → { short, k: number | 'o', nonce } | null`;
  - `readTelegramState(root) → { v: 1, offset, sent, nonces, replies }`; `writeTelegramState(root, state)`.

- [ ] **Step 1: Write the failing tests**

Create `test/telegram.test.mjs`:

```js
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
  const denied = createBot({ token: TOKEN, fetchImpl: async () => ({ status: 400, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) }) });
  await assert.rejects(denied('sendMessage', {}), /^Error: telegram sendMessage failed: Bad Request: chat not found$/);
  const down = createBot({ token: TOKEN, fetchImpl: async (url) => { throw new TypeError(`fetch failed for ${url}`); } });
  await assert.rejects(down('getUpdates', {}), (e) => !e.message.includes(TOKEN) && e.message === 'telegram getUpdates failed: fetch failed for https://api.telegram.org/bot[token]/getUpdates');
  const garbled = createBot({ token: TOKEN, fetchImpl: async () => ({ status: 502, json: async () => { throw new Error('not json'); } }) });
  await assert.rejects(garbled('getUpdates', {}), /telegram getUpdates failed: HTTP 502/);
});

test('run/telegram.json keeps the offset, the sent messages, the nonces and the reply prompts; anything broken reads as empty', () => {
  const root = tmpDir('tg');
  assert.deepEqual(readTelegramState(root), { v: 1, offset: 0, sent: {}, nonces: {}, replies: {} });
  writeTelegramState(root, { v: 1, offset: 12, sent: { '3:a': { rev: 1 } }, nonces: {}, replies: [] });
  assert.deepEqual(readTelegramState(root), { v: 1, offset: 12, sent: { '3:a': { rev: 1 } }, nonces: {}, replies: {} });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/telegram.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/telegram.mjs`.

- [ ] **Step 3: Implement**

`lib/config.mjs` — in `DEFAULTS`, right after the `notify:` entry, add:

```js
  // spec §5.3, §10 (S1b): answer owner questions in Telegram too; needs notify.telegram
  answer: { telegram: false },
```

Create `lib/telegram.mjs`:

```js
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
// positive number, which is also the owner's user id, the only from.id accepted.
export function telegramSettings(config, env = process.env) {
  if (config?.notify?.telegram !== true || config?.answer?.telegram !== true) return null;
  const token = String(env.TURBO_TELEGRAM_TOKEN || '').trim();
  const chat = String(env.TURBO_TELEGRAM_CHAT || '').trim();
  return token && /^\d+$/.test(chat) ? { token, chat } : null;
}

// One Bot API call: POST JSON, the result or an error. No error ever carries the token (it is in the URL).
export function createBot({ token, fetchImpl = globalThis.fetch, timeoutMs = CALL_TIMEOUT_MS }) {
  const hide = (s) => String(s ?? '').split(token).join('[token]');
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
      throw new Error(`telegram ${method} failed: ${hide(err?.name === 'TimeoutError' ? 'timed out' : err?.message ?? err)}`);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // not JSON: reported by the HTTP status below
    }
    if (!data?.ok) throw new Error(`telegram ${method} failed: ${hide(data?.description || `HTTP ${res?.status}`)}`);
    return data.result;
  };
}

// callback_data (spec §5.3): t3:<short id>:<option number or o>:<one-time nonce>, at most 23 bytes.
export const shortId = (phase, id) => crypto.createHash('sha1').update(`${phase}:${id}`).digest('hex').slice(0, 8);
export const callbackData = (short, k, nonce) => `t3:${short}:${k}:${nonce}`;
export function parseCallback(data) {
  const m = CALLBACK_RE.exec(String(data ?? ''));
  return m ? { short: m[1], k: m[2] === 'o' ? 'o' : Number(m[2]), nonce: m[3] } : null;
}

// run/telegram.json, the supervisor's alone: the getUpdates offset; per question its message, rev and nonces; the
// nonces (button -> question and option); the force-reply prompts waiting for the owner's own words.
const stateFile = (root) => path.join(runDir(root), 'telegram.json');
export function readTelegramState(root) {
  const s = readJson(stateFile(root), null);
  const obj = (v) => (isObj(v) ? v : {});
  return { v: 1, offset: Number.isInteger(s?.offset) && s.offset >= 0 ? s.offset : 0, sent: obj(s?.sent), nonces: obj(s?.nonces), replies: obj(s?.replies) };
}
export const writeTelegramState = (root, state) => writeJsonAtomic(stateFile(root), state);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/telegram.test.mjs test/config.test.mjs`
Expected: PASS (4 new tests; `test/config.test.mjs` compares `loadConfig` without a file with `DEFAULTS`, which now holds `answer`).

- [ ] **Step 5: Commit**

```bash
git add lib/config.mjs lib/telegram.mjs test/telegram.test.mjs
git commit -q -m "feat: Telegram answer settings, a token-free bot client, one-time callback data and its state file"
```

---

### Task 2: Send the open questions with buttons; close answered and changed ones

**Files:**
- Modify: `lib/telegram.mjs` (imports, then append)
- Modify: `lib/owner-tick.mjs` (`ownerTick`)
- Test: `test/telegram.test.mjs` (imports, then append)

**Interfaces:**
- Consumes: Task 1; S0's `openQuestions`; S1a's `readQuestions`, `describeAnswer`.
- Produces: `telegramTick(ctx, now, { laneRunning = false, open = null } = {}) → Promise<void>` with `ctx = { root, config, deps: { env?, telegram?, fetch?, nonce?, log } }` (`deps.telegram` replaces the bot client, `deps.nonce` the nonce source, both for tests). This task: sends each open question once (`state.sent['<phase>:<id>'] = { rev, messageId, title, nonces }`), edits the messages of questions answered or gone (`✓ <answer>, <channel>, <time>`) or changed (`↻ changed: see the new message`, then a new message). `ownerTick` calls it after its notifications, its failure logged as `telegram: <first line>`.

- [ ] **Step 1: Write the failing tests**

In `test/telegram.test.mjs`, replace the import block at the top with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { readAnswers, writeQuestions } from '../lib/questions.mjs';
import { ownerTick } from '../lib/owner-tick.mjs';
import {
  MAX_BUTTONS, callbackData, createBot, parseCallback, readTelegramState, shortId, telegramSettings, telegramTick, writeTelegramState,
} from '../lib/telegram.mjs';
```

Append:

```js
const NOW = new Date('2026-01-01T10:00:00.000Z');
const OPT = (label, more = {}) => ({ label, description: '', recommended: false, signal: label.toLowerCase(), defer: false, ...more });
// an open decision of phase 3 in S1a's question shape
const Q = (id, over = {}) => ({
  id, phase: '3', plan: '03-01', task: '2', kind: 'decision', gate: 'blocking', header: '03-01 T2', question: 'Pick the store', context: 'Small data.',
  options: [OPT('Files', { recommended: true, description: '+ simple' }), OPT('SQLite')], allowOther: true, condition: null,
  class: 'decision', topic: null, classified: false, agentId: null, stopped: false, state: 'open', answer: null, delivery: null, rev: 1, source: 'plan', ...over,
});

// A fake Bot API: message ids from 101, getUpdates hands out the queued updates (onPoll runs first, failPoll throws).
function fakeBot() {
  const bot = { calls: [], updates: [], onPoll: null, failPoll: null };
  let id = 100;
  bot.call = async (method, body, opts) => {
    bot.calls.push({ method, body, opts });
    if (method === 'sendMessage') return { message_id: ++id };
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/telegram.test.mjs`
Expected: FAIL with `does not provide an export named 'telegramTick'`.

- [ ] **Step 3: Implement**

In `lib/telegram.mjs`, add to the imports:

```js
import { openQuestions } from './view.mjs';
import { readQuestions } from './questions.mjs';
import { describeAnswer } from './answers.mjs';
```

Append to `lib/telegram.mjs`:

```js
const MESSAGE_MAX = 4000;
const BUTTON_MAX = 60;
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const errLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0];
const keyOf = (q) => `${q.phase}:${q.id}`;

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

const newNonce = (deps) => (deps.nonce ? deps.nonce() : crypto.randomBytes(4).toString('hex'));

// The question as one message: title, question, the options with their descriptions, then the context (cut last).
function questionText(q, title, L) {
  const lines = [title, q.question];
  const shown = q.options.slice(0, MAX_BUTTONS);
  if (shown.length) lines.push('', ...shown.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`));
  if (q.options.length > MAX_BUTTONS) lines.push(fill(L.more, { n: q.options.length - MAX_BUTTONS, other: L.other }));
  if (q.context) lines.push('', q.context);
  return cut(lines.join('\n'), MESSAGE_MAX);
}

// A message's question is settled or changed: its buttons go (an edit without reply_markup) and the line says why.
async function close({ call, chat, state, key, line, deps }) {
  const sent = state.sent[key];
  if (!sent) return;
  for (const n of sent.nonces || []) delete state.nonces[n];
  delete state.sent[key];
  try {
    await call('editMessageText', { chat_id: chat, message_id: sent.messageId, text: cut(`${sent.title}\n${line}`, MESSAGE_MAX) });
  } catch (err) {
    deps.log(`telegram: ${errLine(err)}`);
  }
}

// The chat in line with the open questions: answered, gone or changed ones closed, new ones sent once.
async function syncMessages({ call, chat, state, open, root, L, deps }) {
  const byKey = new Map(open.map((q) => [keyOf(q), q]));
  for (const [key, sent] of Object.entries(state.sent)) {
    const q = byKey.get(key);
    if (q && (q.rev || 1) === sent.rev) continue;
    const at = key.indexOf(':');
    const now = q ? null : readQuestions(root, key.slice(0, at)).find((x) => x.id === key.slice(at + 1));
    const line = q ? `↻ ${L.moved}` : now?.answer ? `✓ ${describeAnswer(now.answer)}` : `✓ ${L.closed}`;
    await close({ call, chat, state, key, line, deps });
  }
  for (const [m, r] of Object.entries(state.replies)) {
    const q = byKey.get(`${r.phase}:${r.id}`);
    if (!q || (q.rev || 1) !== r.rev) delete state.replies[m];
  }
  for (const q of open) {
    if (state.sent[keyOf(q)]) continue;
    const rev = q.rev || 1;
    const short = shortId(q.phase, q.id);
    const nonces = {};
    const add = (k, label) => {
      const n = newNonce(deps);
      nonces[n] = { phase: q.phase, id: q.id, plan: q.plan, task: q.task, rev, k, label };
      return n;
    };
    const rows = q.options.slice(0, MAX_BUTTONS).map((o, i) => [{ text: cut(o.label, BUTTON_MAX), callback_data: callbackData(short, i + 1, add(i + 1, o.label)) }]);
    if (q.allowOther) rows.push([{ text: L.other, callback_data: callbackData(short, 'o', add('o', null)) }]);
    const title = fill(L.title, { phase: q.phase, plan: q.plan, task: q.task });
    const msg = await call('sendMessage', { chat_id: chat, text: questionText(q, title, L), reply_markup: { inline_keyboard: rows } });
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
  const state = readTelegramState(root);
  if (!list.length && !Object.keys(state.sent).length) return;
  try {
    await syncMessages({ call, chat: t.chat, state, open: list, root, L, deps });
  } finally {
    writeTelegramState(root, state);
  }
}
```

`lib/owner-tick.mjs` — replace the whole function `ownerTick` with these two functions, and add `import { telegramTick } from './telegram.mjs';` to the imports:

```js
export async function ownerTick(ctx, now, state = {}) {
  const open = openQuestions(ctx.root);
  await notifyNew(ctx, open);
  // spec §5.3 (S1b): answers by Telegram; a failure there is logged and leaves everything above done
  try {
    await telegramTick(ctx, now, { laneRunning: Boolean(state?.lane), open });
  } catch (err) {
    ctx.deps.log(`telegram: ${String(err?.message ?? err).split(/\r?\n/)[0]}`);
  }
}

async function notifyNew({ root, deps }, open) {
  const file = path.join(runDir(root), NOTIFIED);
  const before = readJson(file, null);
  if (!open.length && !before) return;
  const seen = new Set(Array.isArray(before?.keys) ? before.keys : []);
  const keys = new Set(open.map(keyOf).filter((k) => seen.has(k)));
  const fresh = new Map();
  for (const q of open) if (!seen.has(keyOf(q))) fresh.set(q.phase, [...(fresh.get(q.phase) || []), q]);
  for (const [phase, list] of fresh) {
    await deps.notify('questionsReady', { phase, n: list.length, list: list.slice(0, LIST_MAX).map((q) => `${q.header}: ${cut(q.question, 80)}`).join('; ') });
    for (const q of list) keys.add(keyOf(q));
  }
  const next = [...keys].sort();
  if (JSON.stringify(next) !== JSON.stringify(before?.keys ?? [])) writeJsonAtomic(file, { keys: next });
}
```

(The body of `notifyNew` is S1a's `ownerTick` body from `const file = …` on, unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/telegram.test.mjs test/owner-tick.test.mjs`
Expected: PASS (8 tests in `test/telegram.test.mjs`; S1a's `test/owner-tick.test.mjs` unchanged: Telegram is off in its config).

- [ ] **Step 5: Commit**

```bash
git add lib/telegram.mjs lib/owner-tick.mjs test/telegram.test.mjs
git commit -q -m "feat: the supervisor sends open owner questions to Telegram with buttons and closes answered or changed ones"
```

---

### Task 3: Button presses, "Other" replies and the owner-only rule; README

**Files:**
- Modify: `lib/telegram.mjs` (imports; `telegramTick`; new `pollUpdates`, `onButton`, `onReply`, `record`)
- Modify: `README.md` (Config; `## Telegram (optional)`)
- Test: `test/telegram.test.mjs` (the import of `../lib/telegram.mjs` stays; append)

**Interfaces:**
- Consumes: Tasks 1–2; S1a's `answerQuestion`, `AnswerRefused`, `QuestionChanged`, `TEXT_MAX`.
- Produces: while questions are open, each `telegramTick` long-polls `getUpdates` once (`offset`, `timeout = min(poll_seconds, 50)`, `allowed_updates: ['callback_query', 'message']`, fetch timeout `(timeout + 10) s`) and handles: the owner's button press (one-time nonce; option → `answerQuestion({ …, option: k, by: 'telegram', rev })`, `answerCallbackQuery` with `✓ <label>`, the message edited to `✓ <label>`; `o` → a `force_reply` prompt recorded in `state.replies`); the owner's reply to such a prompt (own words → `answerQuestion({ …, text, rev })`, ≤ 2000 characters); everything from another `from.id` dropped with `telegram: a button press from another user was ignored` / `telegram: a message from another user was ignored`. `state.offset` = the last `update_id + 1`.

- [ ] **Step 1: Write the failing tests**

Append to `test/telegram.test.mjs`:

```js
// updates as Telegram sends them
const press = (data, update_id, from = 4242, id = `cb${update_id}`) => ({ update_id, callback_query: { id, from: { id: from }, data, message: { message_id: 101, chat: { id: from } } } });
const reply = (text, update_id, to, from = 4242) => ({ update_id, message: { message_id: 500 + update_id, from: { id: from }, chat: { id: from }, text, reply_to_message: { message_id: to } } });
const pressReplies = (bot) => bot.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => [c.body.callback_query_id, c.body.text]);

test('the owner\'s press records the option by telegram, answers the press and turns the message into the answer; the offset moves on', async () => {
  const { root, ctx, bot } = project();
  writeQuestions(root, '3', [Q('03-01-t2')]);
  await telegramTick(ctx, NOW, { laneRunning: true });
  bot.updates.push(press(`t3:${shortId('3', '03-01-t2')}:2:00000002`, 41));
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(readAnswers(root, '3').map((r) => [r.id, r.option, r.label, r.by]), [['03-01-t2', 2, 'SQLite', 'telegram']]);
  assert.deepEqual(pressReplies(bot), [['cb41', '✓ SQLite']]);
  const edit = bot.calls.find((c) => c.method === 'editMessageText');
  assert.deepEqual([edit.body.message_id, edit.body.text], [101, 'Phase 3 · 03-01 task 2\n✓ SQLite']);
  assert.equal(readTelegramState(root).offset, 42);
  const poll = bot.calls.find((c) => c.method === 'getUpdates');
  assert.deepEqual([poll.body.offset, poll.body.timeout, poll.body.allowed_updates, poll.opts.timeoutMs], [0, 20, ['callback_query', 'message'], 30000]);
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
  bot.updates.push(reply('x'.repeat(2001), 2, 102), reply(`use ${token}`, 3, 102), reply('Use files', 4, 102, 999), reply('unrelated chat', 5, 77));
  await telegramTick(ctx, NOW, { laneRunning: true });
  assert.deepEqual(readAnswers(root, '3'), []);
  const [tooLong, secret] = bot.sent().slice(-2).map((m) => m.body.text);
  assert.equal(tooLong, 'Not recorded: longer than 2000 characters. Reply again, shorter.');
  assert.match(secret, /^Not recorded: the answer looks like it contains a secret \(github token\).* Delete your message from this chat\.$/);
  assert.ok(logs.includes('telegram: a message from another user was ignored'));
  assert.ok(!logs.join('\n').includes(token) && !JSON.stringify(bot.calls.filter((c) => c.method !== 'getUpdates')).includes(token));
  bot.updates.push(reply('Files, but keep a backup', 6, 102));
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/telegram.test.mjs`
Expected: FAIL — no `getUpdates` call, so nothing is recorded and no press is answered.

- [ ] **Step 3: Implement**

In `lib/telegram.mjs`, replace the import from `./answers.mjs` with:

```js
import { AnswerRefused, QuestionChanged, TEXT_MAX, answerQuestion, describeAnswer } from './answers.mjs';
```

Add before `export async function telegramTick`:

```js
const POLL_MAX_SECONDS = 50;
const CALLBACK_REPLY_MAX = 190;

// One answer through the single arbiter, with the revision its message showed (S1a's --rev contract).
function record({ root, ref, option = null, text = null, now, laneRunning, L }) {
  try {
    const r = answerQuestion({ root, phase: ref.phase, id: ref.id, option, text, by: 'telegram', now, laneRunning, rev: ref.rev });
    if (r.status === 'already') {
      const what = describeAnswer(r.record);
      return { done: true, text: fill(L.already, { what }), shown: what };
    }
    const what = r.record.label ?? cut(r.record.answer, 100);
    return { done: true, text: fill(L.recorded, { what }), shown: what };
  } catch (err) {
    if (err instanceof QuestionChanged) return { done: false, text: L.changed };
    if (err instanceof AnswerRefused) return { done: false, text: fill(L.refused, { why: err.message }) + (/secret/.test(err.message) ? L.secret : '') };
    throw err;
  }
}

// A button press. Only the owner's count; a nonce works once.
async function onButton({ call, chat, state, root, L, deps, now, laneRunning, cb }) {
  if (String(cb?.from?.id ?? '') !== chat) {
    deps.log('telegram: a button press from another user was ignored');
    return;
  }
  const answerPress = (text) => call('answerCallbackQuery', { callback_query_id: cb.id, text: cut(text, CALLBACK_REPLY_MAX) });
  const p = parseCallback(cb.data);
  const ref = p && state.nonces[p.nonce];
  if (!ref || shortId(ref.phase, ref.id) !== p.short || String(ref.k) !== String(p.k)) {
    await answerPress(L.expired);
    return;
  }
  delete state.nonces[p.nonce];
  const key = `${ref.phase}:${ref.id}`;
  if (state.sent[key]) state.sent[key].nonces = state.sent[key].nonces.filter((n) => n !== p.nonce);
  if (ref.k === 'o') {
    const msg = await call('sendMessage', { chat_id: chat, text: fill(L.prompt, { plan: ref.plan, task: ref.task, max: TEXT_MAX }), reply_markup: { force_reply: true } });
    state.replies[String(msg?.message_id)] = { phase: ref.phase, id: ref.id, plan: ref.plan, task: ref.task, rev: ref.rev };
    await answerPress(L.reply);
    return;
  }
  const r = record({ root, ref, option: ref.k, now, laneRunning, L });
  await answerPress(r.text);
  if (r.done) await close({ call, chat, state, key, line: `✓ ${r.shown}`, deps });
}

// A message. Only the owner's replies to one of turbo's force-reply prompts count; the prompt stays until an answer
// is recorded.
async function onReply({ call, chat, state, root, L, deps, now, laneRunning, m }) {
  if (String(m?.from?.id ?? '') !== chat) {
    deps.log('telegram: a message from another user was ignored');
    return;
  }
  const to = m.reply_to_message?.message_id;
  const ref = to === undefined ? null : state.replies[String(to)];
  if (!ref) return;
  const text = typeof m.text === 'string' ? m.text : '';
  const r = [...text].length > TEXT_MAX ? { done: false, text: fill(L.tooLong, { max: TEXT_MAX }) } : record({ root, ref, text, now, laneRunning, L });
  if (r.done) {
    delete state.replies[String(to)];
    await close({ call, chat, state, key: `${ref.phase}:${ref.id}`, line: `✓ ${r.shown}`, deps });
  }
  await call('sendMessage', { chat_id: chat, text: r.text, reply_to_message_id: m.message_id });
}

// One long poll (spec §5.3: no longer than poll_seconds, here at most 50 s). The offset moves past every update,
// also one whose handling failed (logged).
async function pollUpdates({ call, chat, state, root, config, L, deps, now, laneRunning }) {
  const wait = Math.min(POLL_MAX_SECONDS, Math.max(1, Math.floor(Number(config.poll_seconds) || 20)));
  const updates = await call('getUpdates', { offset: state.offset, timeout: wait, allowed_updates: ['callback_query', 'message'] }, { timeoutMs: (wait + 10) * 1000 });
  for (const u of Array.isArray(updates) ? updates : []) {
    if (Number.isInteger(u?.update_id)) state.offset = Math.max(state.offset, u.update_id + 1);
    try {
      if (u?.callback_query) await onButton({ call, chat, state, root, L, deps, now, laneRunning, cb: u.callback_query });
      else if (u?.message) await onReply({ call, chat, state, root, L, deps, now, laneRunning, m: u.message });
    } catch (err) {
      deps.log(`telegram: ${errLine(err)}`);
    }
  }
}
```

In `telegramTick`, replace the `try { … }` block with:

```js
  try {
    await syncMessages({ call, chat: t.chat, state, open: list, root, L, deps });
    if (list.length) await pollUpdates({ call, chat: t.chat, state, root, config, L, deps, now, laneRunning });
  } finally {
    writeTelegramState(root, state);
  }
```

`README.md`:

1. In `## Config`, after the `notify.telegram` row, add:

```markdown
| `answer.telegram` | `false` | Answer the owner questions in Telegram too, with buttons; needs `notify.telegram`. See [Telegram](#telegram-optional). |
```

2. At the end of `## Telegram (optional)` (after `The messages are the same short texts as the desktop notifications: …`), add:

```markdown
To answer the owner questions in Telegram too (see [Owner questions](#owner-questions)), also set `"answer": { "telegram": true }`. `TURBO_TELEGRAM_CHAT` must then be your private chat with the bot, whose id is your user id: turbo takes button presses and replies only from you and drops everything else (it logs that, never the content).

- Each open question comes as one message: the question, its options and a button for each of the first four (the one the plan recommends first), plus "Other…" where your own words count. A button works once.
- "Other…" asks for your answer as a reply to its message, up to 2000 characters. An answer that looks like a secret is refused; delete it from the chat.
- A question answered anywhere loses its buttons and shows the answer that stands. When a question changes (re-planned, or reopened when the lane stopped at it), its old message says so and a new one comes.
- While questions are open, the supervisor asks Telegram for presses and replies at each check, waiting up to `poll_seconds` (at most 50 seconds). Its state (the update offset and the one-time buttons) is in `.planning/turbo/run/telegram.json`. The bot token never appears in a log.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/telegram.test.mjs`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/telegram.mjs README.md test/telegram.test.mjs
git commit -q -m "feat: owner answers by Telegram: one-time buttons and Other replies from the owner only, through the single arbiter"
```

---

## After the last task

The controller runs the full suite once (`npm test`) before merging. Nothing here pushes, merges, tags or installs.

Live check outside CI (spec §9 spike 5 and §11), with the evidence in the stage-3 journal once the owner has a bot: a checkpoint answered with a Telegram button reaches the same agent; `getUpdates` long-polls while the same bot sends notifications; `force_reply` works in the private chat.

## Spec coverage

| Spec | Task |
|---|---|
| §5.3 `notify.telegram` + `answer.telegram: true`, `TURBO_TELEGRAM_TOKEN`, `TURBO_TELEGRAM_CHAT` | 1 |
| §5.3 up to 4 options + Other as inline buttons | 2 |
| §5.3 `callback_data` `t3:<id>:<k>:<nonce>` ≤ 64 bytes, one-time nonce in `run/telegram.json` | 1, 2, 3 |
| §5.3 `getUpdates` long poll ≤ `poll_seconds` only while questions are open, `offset` in the same file | 3 |
| §5.3 only `from.id` = `TURBO_TELEGRAM_CHAT`, the rest dropped and logged without content | 1, 3 |
| §5.3 `answerCallbackQuery`, the message edited to "✓ <option>" | 3 |
| §5.3 Other → `force_reply`, a reply ≤ 2000 characters as the own answer | 3 |
| §5.3 the token never logged | 1, 3 |
| §5.3 single arbiter `by telegram`, first answer wins | 3 |
| §10 `"answer": { "telegram": false }` | 1 |
| §11 fake `fetch`: a foreign `from.id`, a reused nonce, `force_reply` | 1, 3 |
