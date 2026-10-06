import { execFileSync } from 'node:child_process';

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function desktopCommand(platform, title, body) {
  if (platform === 'win32') {
    const ps = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>')`,
      "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
    ].join('\n');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')] };
  }
  if (platform === 'darwin') {
    const q = (s) => JSON.stringify(String(s));
    return { cmd: 'osascript', args: ['-e', `display notification ${q(body)} with title ${q(title)}`] };
  }
  if (platform === 'linux') return { cmd: 'notify-send', args: [String(title), String(body)] };
  return null;
}

export async function notify(config, { title, body }, { platform = process.platform, exec = execFileSync, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const res = { desktop: false, telegram: false };
  if (config?.notify?.desktop) {
    const c = desktopCommand(platform, title, body);
    if (c) {
      try {
        exec(c.cmd, c.args, { stdio: 'ignore', windowsHide: true, timeout: 30000 });
        res.desktop = true;
      } catch {
        // desktop notifier missing: telegram may still deliver
      }
    }
  }
  if (config?.notify?.telegram && env.TURBO_TELEGRAM_TOKEN && env.TURBO_TELEGRAM_CHAT && fetchImpl) {
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${env.TURBO_TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TURBO_TELEGRAM_CHAT, text: `${title}\n${body}` }),
      });
      res.telegram = !!r?.ok;
    } catch {
      // network down: notification is best-effort
    }
  }
  return res;
}
