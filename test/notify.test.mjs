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
  assert.deepEqual(msg('en', 'supervisorFailing', { error: 'launch phase 2 failed' }), { title: 'The supervisor cannot go on', body: 'Error: launch phase 2 failed. Check: /turbo-autonomous status' });
  assert.deepEqual(msg('ru', 'supervisorFailing', { error: 'launch phase 2 failed' }), { title: 'Супервизор не может продолжить', body: 'Ошибка: launch phase 2 failed. Проверьте: /turbo-autonomous status' });
});

test('msg renders rangeDone in en and ru', () => {
  assert.deepEqual(msg('en', 'rangeDone', { range: '4–5' }), { title: 'Phases 4–5 done', body: 'Every phase of this run is done; the supervisor finished.' });
  assert.deepEqual(msg('ru', 'rangeDone', { range: '4–5' }), { title: 'Фазы 4–5 готовы', body: 'Все фазы этого прогона готовы; супервизор закончил работу.' });
});

test('msg renders rangeBlocked in en and ru: the range, the waiting phase, the unfinished dep outside it', () => {
  const vars = { range: '4–6', phase: '4', dep: '3' };
  assert.equal(msg('en', 'rangeBlocked', vars).title, 'Phases 4–6 are waiting');
  assert.equal(msg('ru', 'rangeBlocked', vars).title, 'Фазы 4–6 ждут');
  assert.match(msg('ru', 'rangeBlocked', vars).body, /^Фаза 4 зависит от фазы 3, которая не входит в этот прогон и не завершена/);
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
  assert.match(msg('en', 'ciRed', { phase: '3', sha: 'abc1234', runs: 'CI (failure)', rounds: 2 }).body, /abc1234: CI \(failure\)\. The phase fixes it itself \(at most 2 rounds\)/);
  assert.deepEqual(['en', 'ru'].map((lang) => msg(lang, 'ciRed', { phase: '3', sha: 'a', runs: 'r', rounds: 2 }).title), ['CI red: phase 3', 'CI красный: фаза 3'], "the pane's words");
  assert.match(msg('ru', 'ciTimeout', { phase: '3', sha: 'a', commit: 'a', repo: '', minutes: 30, error: '; last gh error: gh: timeout' }).body, /не завершился за 30 мин; последняя ошибка gh: gh: timeout\. /);
  // the suggested command names the full commit and the repository: gh run list --commit needs the full sha
  const full = 'f'.repeat(40);
  for (const lang of ['en', 'ru']) {
    assert.match(msg(lang, 'ciTimeout', { phase: '3', sha: 'fffffff', commit: full, repo: ' -R acme/app', minutes: 30, error: '' }).body, new RegExp(`gh run list -R acme/app --commit ${full}$`), lang);
  }
});

test('laneStalled exists in en and ru with the same placeholders (S1)', () => {
  const keep = new Proxy({}, { get: (_, k) => `{${String(k)}}` });
  const holes = (m) => [...`${m.title}\n${m.body}`.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
  const en = msg('en', 'laneStalled', keep);
  const ru = msg('ru', 'laneStalled', keep);
  assert.notEqual(en.title, 'laneStalled');
  assert.notEqual(ru.title, en.title);
  assert.deepEqual(holes(ru), holes(en));
  assert.equal(msg('en', 'laneStalled', { phase: '3', minutes: 16, wakes: 2, id: '1a2b3c4d' }).body, 'Its session has written nothing for 16 min; attempts to wake it: 2. To look inside: claude attach 1a2b3c4d. To restart the phase: /turbo-autonomous resume 3');
  assert.equal(msg('ru', 'laneStalled', { phase: '3', minutes: 16, wakes: 2, id: '1a2b3c4d' }).body, 'Её сессия ничего не пишет уже 16 мин; попыток разбудить: 2. Посмотреть: claude attach 1a2b3c4d. Перезапустить фазу: /turbo-autonomous resume 3');
});

test('questionsReady exists in en and ru with the same placeholders (S1)', () => {
  const keep = new Proxy({}, { get: (_, k) => `{${String(k)}}` });
  const holes = (m) => [...`${m.title}\n${m.body}`.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
  const en = msg('en', 'questionsReady', keep);
  const ru = msg('ru', 'questionsReady', keep);
  assert.notEqual(en.title, 'questionsReady');
  assert.notEqual(ru.title, en.title);
  assert.deepEqual(holes(ru), holes(en));
  // owner-tick lists `<header>: <question>` (header `<plan> T<task>`): the plan and task in words
  const list = '03-01 T2: Pick one; 03-01 T4: Pick another?';
  assert.deepEqual(msg('en', 'questionsReady', { phase: '3', n: 2, list }), { title: 'Phase 3: needs your answer (2)', body: 'plan 03-01, task 2: Pick one; plan 03-01, task 4: Pick another? To answer: /turbo-autonomous answer' });
  assert.deepEqual(msg('ru', 'questionsReady', { phase: '3', n: 2, list }), { title: 'Фаза 3: нужен ваш ответ (2)', body: 'план 03-01, задача 2: Pick one; план 03-01, задача 4: Pick another? Ответить: /turbo-autonomous answer' });
});

test("the notifications speak the turbo-view pane's words: a phase done, stopped for the owner, stopped by a failure", () => {
  const vars = { phase: '32', reason: '', id: 'abcd1234' };
  const titles = (lang) => ['phaseDone', 'laneNeedsOwner', 'laneFailed'].map((key) => msg(lang, key, vars).title);
  assert.deepEqual(titles('en'), ['Phase 32 done', 'Phase 32 stopped — needs your answer', 'Phase 32 stopped by a failure']);
  assert.deepEqual(titles('ru'), ['Фаза 32 готова', 'Фаза 32 остановилась — нужен ваш ответ', 'Фаза 32 остановилась из-за сбоя']);
  assert.deepEqual(msg('ru', 'phaseDone', vars), { title: 'Фаза 32 готова', body: 'Перехожу к следующей фазе.' });
});

test('a needs-owner reason in words: no `owner question <id>`, no question or session id, the supervisor\'s own reasons translated', () => {
  const says = (lang, reason) => msg(lang, 'laneNeedsOwner', { phase: '32', reason }).body;
  assert.equal(says('en', 'owner question 32-09-t3'), 'Details: /turbo-autonomous status', 'the title says a question waits');
  assert.equal(says('ru', 'owner question 32-09-t3'), 'Подробности: /turbo-autonomous status');
  assert.equal(says('ru', 'owner question 32-09-t3: app.exe locked by app.exe (PID 42): quit the app.'), 'Причина: app.exe locked by app.exe (PID 42): quit the app. Подробности: /turbo-autonomous status');
  assert.equal(says('en', 'Owner question 32-09-t3 the deploy needs a key'), 'Reason: the deploy needs a key. Details: /turbo-autonomous status');
  assert.equal(says('en', 'owner question about the deploy'), 'Reason: owner question about the deploy. Details: /turbo-autonomous status', 'no id: kept as written');
  assert.equal(says('en', 'human verification'), 'Reason: it needs your manual check. Details: /turbo-autonomous status');
  assert.equal(says('ru', 'human verification'), 'Причина: нужна ваша ручная проверка. Подробности: /turbo-autonomous status');
  const undelivered = 'the answers to 02-01-t2, 02-01-t4 did not reach session 1a2b3c4d (claude stop failed: timed out)';
  assert.equal(says('en', undelivered), "Reason: your answers did not reach the phase's session (claude stop failed: timed out). Details: /turbo-autonomous status");
  assert.equal(says('ru', undelivered), 'Причина: ваши ответы не дошли до сессии фазы (claude stop failed: timed out). Подробности: /turbo-autonomous status');
  assert.equal(says('en', 'a\u001b[2Jb‮c'), 'Reason: abc. Details: /turbo-autonomous status', 'a repository string is cleaned');
});

test('a session id shows only inside the command that needs it', () => {
  const vars = { phase: '2', id: 'abcd1234', minutes: 16, wakes: 2, restarts: 3, log: 'x.log' };
  for (const lang of ['en', 'ru']) {
    for (const key of ['laneStalled', 'laneBlocked', 'laneFailed', 'phaseMissing']) {
      const m = msg(lang, key, vars);
      const text = `${m.title}\n${m.body}`;
      assert.equal(text.split('abcd1234').length - 1, text.split('claude attach abcd1234').length - 1, `${lang} ${key}: ${text}`);
    }
  }
});

test('the Russian notifications hold no English but commands, paths, names and the variables', () => {
  const keep = new Proxy({}, { get: (_, k) => `{${String(k)}}` });
  const keys = ['laneNeedsOwner', 'laneStalled', 'questionsReady', 'laneDowngraded', 'ownerChecklist', 'laneBlocked', 'laneHalted', 'laneFailed', 'launchHalted', 'phaseMissing', 'workspaceUntrusted', 'noReadyPhase', 'phaseDone', 'milestoneDone', 'rangeDone', 'rangeBlocked', 'supervisorFailing', 'pushDiverged', 'pushRefused', 'pushFailed', 'ciRed', 'ciTimeout', 'ciUnavailable'];
  // commands the owner runs, as printed, and the names of tools and files
  const COMMANDS = [/\/turbo-autonomous [a-z]+(?: \{\w+\})?/g, /\/turbo-autonomous --only \{dep\}/g, /--(?:from|to|all)\b/g, /claude attach \{id\}/g, /\{turboRun\} doctor/g, /\{turboRun\} lane-status \{phase\} done/g, /turbo-phase restore, fanout, fix, final-gate и uat/g, /git push \{remote\} \{branch\}/g, /gh run list\{repo\} --commit \{commit\}/g, /\.planning\/turbo\/logs\/supervisor\.log/g, /ROADMAP\.md/g];
  const NAMES = new Set(['CI', 'GSD', 'Claude', 'Code', 'claude', 'turbo', 'turbo-phase', 'doctor', 'gh', 'Telegram']);
  for (const key of keys) {
    const m = msg('ru', key, keep);
    let text = `${m.title}\n${m.body}`;
    for (const re of COMMANDS) text = text.replace(re, ' ');
    text = text.replace(/\{\w+\}/g, ' ');
    const english = (text.match(/[A-Za-z][A-Za-z-]*/g) || []).filter((w) => !NAMES.has(w));
    assert.deepEqual(english, [], `${key}: ${m.title} / ${m.body}`);
  }
});
