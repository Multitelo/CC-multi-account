'use strict';
// Windows toast notification through PowerShell. Text goes in env vars, never
// into the script, so nothing in it can be run as code.
const { spawn } = require('child_process');

const SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x=$t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:CC_TOAST_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:CC_TOAST_BODY)) > $null
$n=[Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)
`;

function notify(title, body) {
  if (process.env.CC_NO_TOAST) return;
  try {
    const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
      env: { ...process.env, CC_TOAST_TITLE: title, CC_TOAST_BODY: body },
      windowsHide: true, detached: true, stdio: 'ignore',
    });
    ps.on('error', () => {});
    ps.unref();
  } catch {}
}

module.exports = { notify };
