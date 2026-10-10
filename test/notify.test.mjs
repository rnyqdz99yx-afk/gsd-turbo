import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msg } from '../lib/messages.mjs';
import { desktopCommand, notify } from '../lib/notify.mjs';

const INJECT = '’) ; Get-Process ; (’';
const decode = (c) => Buffer.from(c.args[c.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

test('msg renders en and ru with variables; unknown lang falls back to en', () => {
  const en = msg('en', 'laneNeedsOwner', { phase: '3', reason: 'sign-off' });
  assert.match(en.title, /3/);
  assert.match(en.body, /sign-off/);
  assert.match(msg('ru', 'laneNeedsOwner', { phase: '3', reason: 'подпись' }).title, /Фаза 3/);
  assert.deepEqual(msg('xx', 'milestoneDone', {}), msg('en', 'milestoneDone', {}));
});

test('msg renders supervisorFailing in en and ru', () => {
  assert.deepEqual(msg('en', 'supervisorFailing', { error: 'launch phase 2 failed' }), { title: 'gsd-turbo cannot make progress', body: 'launch phase 2 failed. Check: /turbo-autonomous status' });
  assert.deepEqual(msg('ru', 'supervisorFailing', { error: 'launch phase 2 failed' }), { title: 'gsd-turbo не может продолжить', body: 'launch phase 2 failed. Проверь: /turbo-autonomous status' });
});

test('msg renders rangeDone in en and ru', () => {
  assert.deepEqual(msg('en', 'rangeDone', { range: '4–5' }), { title: 'Phases 4–5 done', body: 'The range is complete; the supervisor stopped.' });
  assert.deepEqual(msg('ru', 'rangeDone', { range: '4–5' }), { title: 'Фазы 4–5 готовы', body: 'Диапазон выполнен; супервизор остановлен.' });
});

test('msg renders rangeBlocked in en and ru: the range, the waiting phase, the unfinished dep outside it', () => {
  const vars = { range: '4–6', phase: '4', dep: '3' };
  assert.equal(msg('en', 'rangeBlocked', vars).title, 'Phases 4–6 are waiting');
  assert.equal(msg('ru', 'rangeBlocked', vars).title, 'Фазы 4–6 ждут');
  assert.match(msg('ru', 'rangeBlocked', vars).body, /^Фаза 4 зависит от фазы 3 вне диапазона, она не завершена/);
  for (const lang of ['en', 'ru']) {
    const m = msg(lang, 'rangeBlocked', vars);
    assert.ok(m.body.includes('/turbo-autonomous --only 3') && m.body.includes('--all'), lang);
  }
});

test('msg renders launchHalted in en and ru, ending with the resume command', () => {
  const vars = { phase: '2', error: 'launch phase 2 failed: claude --bg failed: exit status 1' };
  for (const lang of ['en', 'ru']) {
    const m = msg(lang, 'launchHalted', vars);
    assert.notEqual(m.title, 'launchHalted', lang);
    assert.match(m.title, /2/, lang);
    assert.ok(m.body.includes(vars.error), lang);
    assert.ok(m.body.endsWith('/turbo-autonomous resume 2'), lang);
  }
});

test('laneHalted, laneFailed and phaseMissing end with the resume command in en and ru', () => {
  const vars = { phase: '2', restarts: 3, log: 'x.log', id: 's1' };
  for (const lang of ['en', 'ru']) {
    for (const key of ['laneHalted', 'laneFailed', 'phaseMissing']) {
      assert.ok(msg(lang, key, vars).body.endsWith('/turbo-autonomous resume 2'), `${lang} ${key}`);
    }
  }
  assert.match(msg('en', 'laneFailed', vars).body, /claude attach s1/);
  assert.match(msg('ru', 'laneHalted', vars).body, /x\.log/);
});

test('every message exists in en and ru with the same placeholders', () => {
  const keys = ['laneNeedsOwner', 'laneBlocked', 'laneHalted', 'laneFailed', 'launchHalted', 'phaseMissing', 'noReadyPhase', 'phaseDone', 'milestoneDone', 'rangeDone', 'supervisorFailing'];
  const keep = new Proxy({}, { get: (_, k) => `{${String(k)}}` }); // renders each {name} as itself
  const holes = (m) => [...`${m.title}\n${m.body}`.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
  for (const key of keys) {
    const en = msg('en', key, keep);
    const ru = msg('ru', key, keep);
    assert.notEqual(en.title, key, key);
    assert.notEqual(ru.title, en.title, `${key} has a ru text`);
    assert.deepEqual(holes(ru), holes(en), key);
  }
});

test('msg with a key unknown in every language returns the key as title instead of throwing', () => {
  assert.deepEqual(msg('ru', 'noSuchKey', {}), { title: 'noSuchKey', body: '' });
  assert.deepEqual(msg('xx', 'noSuchKey'), { title: 'noSuchKey', body: '' });
});

test('msg ignores inherited Object properties as keys or languages', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(msg('en', key, {}), { title: key, body: '' });
    assert.deepEqual(msg('ru', key, {}), { title: key, body: '' });
  }
  assert.deepEqual(msg('constructor', 'milestoneDone', {}), msg('en', 'milestoneDone', {}));
  assert.deepEqual(msg('__proto__', 'milestoneDone', {}), msg('en', 'milestoneDone', {}));
});

test('desktopCommand win32: constant script, text only in env (no PowerShell injection)', () => {
  const w = desktopCommand('win32', 'a<b ‘t’', `c&d ${INJECT} ‚‛`);
  assert.equal(w.cmd, 'powershell.exe');
  const script = decode(w);
  assert.ok(!script.includes('a<b'), 'title must not be in the script');
  assert.ok(!script.includes('c&d'), 'body must not be in the script');
  assert.ok(!script.includes('Get-Process'), 'injected command must not be in the script');
  assert.doesNotMatch(script, /[‘-‛]/);
  assert.match(script, /\$env:TURBO_NOTIFY_TITLE/);
  assert.match(script, /\$env:TURBO_NOTIFY_BODY/);
  assert.equal(w.env.TURBO_NOTIFY_TITLE, 'a<b ‘t’');
  assert.equal(w.env.TURBO_NOTIFY_BODY, `c&d ${INJECT} ‚‛`);
  assert.equal(decode(desktopCommand('win32', 'other', 'text')), script, 'script text is constant');
});

test('desktopCommand darwin and linux pass text via argv; unknown platform is null', () => {
  const d = desktopCommand('darwin', 't"x', `b ${INJECT}`);
  assert.equal(d.cmd, 'osascript');
  assert.deepEqual(d.args, ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', 't"x', `b ${INJECT}`]);
  const l = desktopCommand('linux', '-t', 'b');
  assert.equal(l.cmd, 'notify-send');
  assert.deepEqual(l.args, ['--', '\u200B-t', 'b']);
  assert.equal(desktopCommand('aix', 't', 'b'), null);
});

test('desktopCommand: a text field starting with "-" is guarded with U+200B on every platform', () => {
  const evil = '-eproperty p : (do shell script "x")';
  const d = desktopCommand('darwin', '-title', evil);
  assert.equal(d.args.slice(0, 6).filter((a) => a === '-e').length, 3);
  const tail = d.args.slice(6);
  assert.deepEqual(tail, ['\u200B-title', `\u200B${evil}`]);
  for (const a of tail) assert.ok(!a.startsWith('-'), `argv element must not start with "-": ${a}`);
  assert.deepEqual(desktopCommand('linux', '-title', evil).args, ['--', '\u200B-title', `\u200B${evil}`]);
  const w = desktopCommand('win32', '-title', evil);
  assert.equal(w.env.TURBO_NOTIFY_TITLE, '\u200B-title');
  assert.equal(w.env.TURBO_NOTIFY_BODY, `\u200B${evil}`);
  assert.deepEqual(desktopCommand('linux', 'a-b', 'x -y').args, ['--', 'a-b', 'x -y'], 'inner dashes untouched');
});

test('desktopCommand strips C0 control chars except tab, newline and carriage return', () => {
  const raw = 'a\u0000b\u0001c\nd\te\rf\u001Bg\u001F';
  const clean = 'abc\nd\te\rfg';
  assert.deepEqual(desktopCommand('linux', raw, raw).args, ['--', clean, clean]);
  assert.deepEqual(desktopCommand('darwin', raw, raw).args.slice(6), [clean, clean]);
  assert.deepEqual(desktopCommand('win32', raw, raw).env, { TURBO_NOTIFY_TITLE: clean, TURBO_NOTIFY_BODY: clean });
  assert.deepEqual(desktopCommand('linux', '\u0001-x', 'b').args, ['--', '\u200B-x', 'b'], 'guard applies after stripping');
});

test('notify sends telegram only when enabled and env is present; never throws', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
  const exec = () => { throw new Error('no notifier'); };
  const cfg = { notify: { desktop: true, telegram: true } };
  const env = { TURBO_TELEGRAM_TOKEN: 'T', TURBO_TELEGRAM_CHAT: '42' };
  const r = await notify(cfg, { title: 'x', body: 'y' }, { platform: 'linux', exec, fetchImpl, env });
  assert.deepEqual(r, { desktop: false, telegram: true });
  assert.equal(sent[0].body.chat_id, '42');
  assert.match(sent[0].url, /botT\/sendMessage$/);
  const r2 = await notify({ notify: { desktop: false, telegram: true } }, { title: 'x', body: 'y' }, { platform: 'linux', exec, fetchImpl, env: {} });
  assert.deepEqual(r2, { desktop: false, telegram: false });
});

test('notify desktop success path passes cmd/args/env to exec and truncates text', async () => {
  const calls = [];
  const exec = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); };
  const r = await notify({ notify: { desktop: true } }, { title: 'T'.repeat(500), body: `${INJECT}${'B'.repeat(5000)}` }, { platform: 'win32', exec, env: {} });
  assert.deepEqual(r, { desktop: true, telegram: false });
  assert.equal(calls.length, 1);
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'powershell.exe');
  assert.deepEqual(args, desktopCommand('win32', 'x', 'y').args);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.timeout, 10000);
  assert.equal(opts.env.TURBO_NOTIFY_TITLE, 'T'.repeat(120));
  assert.equal([...opts.env.TURBO_NOTIFY_BODY].length, 1000);
  assert.ok(opts.env.TURBO_NOTIFY_BODY.startsWith(INJECT));
  const someKey = Object.keys(process.env)[0];
  assert.equal(opts.env[someKey], process.env[someKey], 'child env inherits process.env');
  calls.length = 0;
  await notify({ notify: { desktop: true } }, { title: '-'.repeat(500), body: 'b' }, { platform: 'linux', exec, env: {} });
  const guarded = [...calls[0].args[1]];
  assert.equal(guarded[0], '\u200B');
  assert.equal(guarded.length, 120, 'the U+200B guard counts toward the 120 cap');
});

test('notify with desktop:false never calls exec', async () => {
  let called = false;
  const exec = async () => { called = true; };
  const r = await notify({ notify: { desktop: false, telegram: false } }, { title: 'x', body: 'y' }, { platform: 'win32', exec, env: {} });
  assert.deepEqual(r, { desktop: false, telegram: false });
  assert.equal(called, false);
});

test('notify telegram: rejected fetch and non-ok response both give false; text capped at 4000', async () => {
  const env = { TURBO_TELEGRAM_TOKEN: 'T', TURBO_TELEGRAM_CHAT: '42' };
  const cfg = { notify: { desktop: false, telegram: true } };
  const rejecting = async () => { throw new Error('network down'); };
  assert.deepEqual(await notify(cfg, { title: 'x', body: 'y' }, { fetchImpl: rejecting, env }), { desktop: false, telegram: false });
  const sent = [];
  const notOk = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: false }; };
  assert.deepEqual(await notify(cfg, { title: 'x', body: 'y'.repeat(9000) }, { fetchImpl: notOk, env }), { desktop: false, telegram: false });
  assert.equal(sent[0].text.length, 4000);
});

test('notify telegram: a hanging fetch is aborted by the timeout and notify resolves', async () => {
  const env = { TURBO_TELEGRAM_TOKEN: 'T', TURBO_TELEGRAM_CHAT: '42' };
  let aborted = false;
  const hang = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => { aborted = true; reject(opts.signal.reason); });
  });
  const guard = setTimeout(() => {}, 5000); // keeps the loop alive; AbortSignal.timeout timers are unref'd
  const t0 = Date.now();
  const r = await notify({ notify: { telegram: true } }, { title: 'x', body: 'y' }, { fetchImpl: hang, env, timeoutMs: 50 });
  clearTimeout(guard);
  assert.deepEqual(r, { desktop: false, telegram: false });
  assert.equal(aborted, true, 'the fetch was aborted by the timeout signal');
  assert.ok(Date.now() - t0 < 2000, `resolved in ${Date.now() - t0} ms`);
});

test('push and CI messages exist in en and ru with the same placeholders (S2)', () => {
  const keep = new Proxy({}, { get: (_, k) => `{${String(k)}}` });
  const holes = (m) => [...`${m.title}\n${m.body}`.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
  for (const key of ['pushDiverged', 'pushRefused', 'pushFailed', 'ciRed', 'ciTimeout', 'ciUnavailable']) {
    const en = msg('en', key, keep);
    const ru = msg('ru', key, keep);
    assert.notEqual(en.title, key, key);
    assert.notEqual(ru.title, en.title, `${key} has a ru text`);
    assert.deepEqual(holes(ru), holes(en), key);
  }
  assert.equal(msg('en', 'pushRefused', { phase: '3', findings: 'logs/a.log (forbidden name *.log)', remote: 'origin', branch: 'main' }).title, 'Phase 3: push refused');
  assert.match(msg('en', 'ciRed', { phase: '3', sha: 'abc1234', runs: 'CI (failure)', rounds: 2 }).body, /abc1234: CI \(failure\)\. The lane fixes it itself \(at most 2 rounds\)/);
});
