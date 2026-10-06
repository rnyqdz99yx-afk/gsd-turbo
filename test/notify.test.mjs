import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msg } from '../lib/messages.mjs';
import { desktopCommand, notify } from '../lib/notify.mjs';

test('msg renders en and ru with variables; unknown lang falls back to en', () => {
  const en = msg('en', 'laneNeedsOwner', { phase: '3', reason: 'sign-off' });
  assert.match(en.title, /3/);
  assert.match(en.body, /sign-off/);
  assert.match(msg('ru', 'laneNeedsOwner', { phase: '3', reason: 'подпись' }).title, /Фаза 3/);
  assert.deepEqual(msg('xx', 'milestoneDone', {}), msg('en', 'milestoneDone', {}));
});

test('desktopCommand per platform; win32 uses an encoded command with XML-escaped text', () => {
  const w = desktopCommand('win32', 'a<b', 'c&d');
  assert.equal(w.cmd, 'powershell.exe');
  const script = Buffer.from(w.args[w.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(script, /a&#60;b/);
  assert.match(script, /c&#38;d/);
  assert.equal(desktopCommand('darwin', 't', 'b').cmd, 'osascript');
  assert.equal(desktopCommand('linux', 't', 'b').cmd, 'notify-send');
  assert.equal(desktopCommand('aix', 't', 'b'), null);
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
