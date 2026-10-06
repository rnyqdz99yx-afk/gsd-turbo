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

export function desktopCommand(platform, title, body) {
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', WIN_ENCODED],
      env: { TURBO_NOTIFY_TITLE: String(title), TURBO_NOTIFY_BODY: String(body) },
    };
  }
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', String(title), String(body)],
      env: {},
    };
  }
  if (platform === 'linux') return { cmd: 'notify-send', args: ['--', String(title), String(body)], env: {} };
  return null;
}

export async function notify(config, { title, body }, { platform = process.platform, exec = execFileAsync, fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 10000 } = {}) {
  const res = { desktop: false, telegram: false };
  if (config?.notify?.desktop) {
    const c = desktopCommand(platform, cut(title, 120), cut(body, 1000));
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
