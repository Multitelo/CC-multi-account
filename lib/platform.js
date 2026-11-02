'use strict';
// Everything that differs between Windows, macOS and Linux.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const HOME = os.homedir();

// The command is `ccm` everywhere. Windows also gets `cc` as a shortcut
// (on macOS and Linux `cc` is the C compiler, so it is left alone there).
const CMD = 'ccm';

const SUBCOMMANDS = 'login|start|status|use|auto|install|uninstall|doctor|serve|restart|stop|pin|unpin|pins|threshold|order|log|remove|notify|run';
const CMD_RE = new RegExp(`\\bcc (?=(?:${SUBCOMMANDS})\\b|--)`, 'g');

// Messages are written with `cc ...`; show the right command name.
function say(text) {
  return typeof text !== 'string' ? text : text.replace(CMD_RE, `${CMD} `);
}

function vscodeSettings() {
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
  if (IS_MAC) return path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Code', 'User', 'settings.json');
}

function findClaude() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (IS_WIN) {
    for (const d of dirs) {
      const exe = path.join(d, 'claude.exe');
      if (fs.existsSync(exe)) return exe;
    }
    for (const d of dirs) {
      if (!fs.existsSync(path.join(d, 'claude.cmd'))) continue;
      const exe = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(exe)) return exe;
    }
    const local = path.join(HOME, '.local', 'bin', 'claude.exe');
    return fs.existsSync(local) ? local : null;
  }
  for (const d of [...dirs, path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local')]) {
    const exe = path.join(d, 'claude');
    try { fs.accessSync(exe, fs.constants.X_OK); return exe; } catch {}
  }
  return null;
}

function openBrowser(url) {
  try {
    const [cmd, args] = IS_WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : IS_MAC ? ['open', [url]] : ['xdg-open', [url]];
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

// ---- notifications ---------------------------------------------------------

const WIN_TOAST = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x=$t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:CC_TOAST_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:CC_TOAST_BODY)) > $null
$n=[Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)
`;

// Text is passed as arguments or env vars, never inside a script.
function notify(title, body) {
  if (process.env.CC_NO_TOAST) return;
  title = say(title);
  body = say(body);
  let cmd, args, env = process.env;
  if (IS_WIN) {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_TOAST, 'utf16le').toString('base64')];
    env = { ...process.env, CC_TOAST_TITLE: title, CC_TOAST_BODY: body };
  } else if (IS_MAC) {
    cmd = 'osascript';
    args = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body];
  } else {
    cmd = 'notify-send';
    args = ['--app-name=cc', title, body];
  }
  try {
    const p = spawn(cmd, args, { env, windowsHide: true, detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

// ---- start at sign-in ------------------------------------------------------

const LAUNCH_AGENT = path.join(HOME, 'Library', 'LaunchAgents', 'com.cc-multi-account.relay.plist');
const SYSTEMD_UNIT = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'systemd', 'user', 'cc-relay.service');
const XDG_AUTOSTART = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'autostart', 'cc-relay.desktop');
const WIN_STARTUP = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'cc-relay.vbs');

const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function hasSystemd() {
  const r = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  return r.status === 0;
}

const autostart = {
  path() {
    if (IS_WIN) return WIN_STARTUP;
    if (IS_MAC) return LAUNCH_AGENT;
    return fs.existsSync(SYSTEMD_UNIT) ? SYSTEMD_UNIT : XDG_AUTOSTART;
  },
  check() {
    if (IS_WIN) return fs.existsSync(WIN_STARTUP);
    if (IS_MAC) return fs.existsSync(LAUNCH_AGENT);
    return fs.existsSync(SYSTEMD_UNIT) || fs.existsSync(XDG_AUTOSTART);
  },
  add(cli) {
    const node = process.execPath;
    if (IS_WIN) {
      fs.writeFileSync(WIN_STARTUP, `' Starts the cc relay hidden at sign-in.\r\nCreateObject("WScript.Shell").Run "node ""${cli}"" serve", 0, False\r\n`);
    } else if (IS_MAC) {
      fs.mkdirSync(path.dirname(LAUNCH_AGENT), { recursive: true });
      fs.writeFileSync(LAUNCH_AGENT, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cc-multi-account.relay</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(cli)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
`);
      spawnSync('launchctl', ['unload', LAUNCH_AGENT], { stdio: 'ignore' });
      spawnSync('launchctl', ['load', LAUNCH_AGENT], { stdio: 'ignore' });
    } else if (hasSystemd()) {
      fs.mkdirSync(path.dirname(SYSTEMD_UNIT), { recursive: true });
      fs.writeFileSync(SYSTEMD_UNIT, `[Unit]
Description=cc relay (Claude Code across several accounts)

[Service]
ExecStart="${node}" "${cli}" serve --child
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`);
      spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      spawnSync('systemctl', ['--user', 'enable', 'cc-relay.service'], { stdio: 'ignore' });
    } else {
      fs.mkdirSync(path.dirname(XDG_AUTOSTART), { recursive: true });
      fs.writeFileSync(XDG_AUTOSTART, `[Desktop Entry]
Type=Application
Name=cc relay
Exec="${node}" "${cli}" serve
X-GNOME-Autostart-enabled=true
NoDisplay=true
`);
    }
  },
  remove() {
    if (IS_WIN) { try { fs.unlinkSync(WIN_STARTUP); } catch {} return; }
    if (IS_MAC) {
      spawnSync('launchctl', ['unload', LAUNCH_AGENT], { stdio: 'ignore' });
      try { fs.unlinkSync(LAUNCH_AGENT); } catch {}
      return;
    }
    if (fs.existsSync(SYSTEMD_UNIT)) {
      spawnSync('systemctl', ['--user', 'disable', 'cc-relay.service'], { stdio: 'ignore' });
      try { fs.unlinkSync(SYSTEMD_UNIT); } catch {}
      spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    }
    try { fs.unlinkSync(XDG_AUTOSTART); } catch {}
  },
};

module.exports = { IS_WIN, IS_MAC, CMD, say, vscodeSettings, findClaude, openBrowser, notify, autostart };
