import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Constant script: notification text arrives only through the environment and is inserted
// as XML text nodes, so no title/body character is ever parsed as PowerShell source.
const WIN_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
  '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$x.LoadXml(\'<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>\')',
  "$t = $x.GetElementsByTagName('text')",
  '$t.Item(0).AppendChild($x.CreateTextNode([string]$env:TURBO_NOTIFY_TITLE)) > $null',
  '$t.Item(1).AppendChild($x.CreateTextNode([string]$env:TURBO_NOTIFY_BODY)) > $null',
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
].join('\n');
const WIN_ENCODED = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');

// Truncate by code points so a surrogate pair is never split.
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');

// Parser-independent argv hardening: drop C0 controls except \t \n \r, and make sure no text
// field can start with "-" (a leading U+200B), so no CLI parser can take it for an option.
// Idempotent: sanitized text no longer starts with "-".
const safeText = (s) => {
  const t = String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return t.startsWith('-') ? `\u200B${t}` : t;
};

export function desktopCommand(platform, title, body) {
  const t = safeText(title);
  const b = safeText(body);
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', WIN_ENCODED],
      env: { TURBO_NOTIFY_TITLE: t, TURBO_NOTIFY_BODY: b },
    };
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', t, b],
      env: {},
    };
  }
  if (platform === 'linux') return { cmd: 'notify-send', args: ['--', t, b], env: {} };
  return null;
}

export async function notify(config, { title, body }, { platform = process.platform, exec = execFileAsync, fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 10000 } = {}) {
  const res = { desktop: false, telegram: false };
  if (config?.notify?.desktop) {
    // sanitize before cutting so the U+200B guard still fits the 120/1000 caps
    const c = desktopCommand(platform, cut(safeText(title), 120), cut(safeText(body), 1000));
    if (c) {
      try {
        await exec(c.cmd, c.args, { windowsHide: true, timeout: timeoutMs, env: { ...process.env, ...c.env } });
        res.desktop = true;
      } catch {
        // desktop notifier missing or timed out: telegram may still deliver
      }
    }
  }
  if (config?.notify?.telegram && env.TURBO_TELEGRAM_TOKEN && env.TURBO_TELEGRAM_CHAT && fetchImpl) {
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${env.TURBO_TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TURBO_TELEGRAM_CHAT, text: cut(`${title}\n${body}`, 4000) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      res.telegram = !!r?.ok;
    } catch {
      // network down or timed out: notification is best-effort
    }
  }
  return res;
}
