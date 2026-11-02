'use strict';
// Wiring cc into the places that launch Claude Code, and taking it out again.
// Every file is backed up to ~/.cc/backups before it is changed.
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const S = require('./store');

const BIN = path.join(P.HOME, '.local', 'bin');
const STARTUP = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'cc-relay.vbs');
const VSCODE = path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json');
const CLAUDE_SETTINGS = path.join(P.CLAUDE_DIR, 'settings.json');
const ENV_NAMES = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CC_RELAY'];

function backup(file) {
  if (!fs.existsSync(file)) return;
  S.ensureDirs();
  const dest = path.join(P.BACKUPS, `${path.basename(path.dirname(file))}-${path.basename(file)}.${Date.now()}`);
  fs.copyFileSync(file, dest);
}

function editJson(file, fn) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
  let data;
  try { data = JSON.parse(text || '{}'); } catch {
    throw new Error(`${file} has comments or trailing commas, so cc will not rewrite it automatically`);
  }
  const before = JSON.stringify(data);
  fn(data);
  if (JSON.stringify(data) === before) return false;
  backup(file);
  S.writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
  return true;
}

function statusCommand() {
  return `node "${P.CLI.replace(/\\/g, '/')}" statusline`;
}

function vbsText() {
  return `' Starts the cc relay hidden at sign-in.\r\nCreateObject("WScript.Shell").Run "node ""${P.CLI}"" serve", 0, False\r\n`;
}

function relayEnv(cfg) {
  return [
    { name: 'ANTHROPIC_BASE_URL', value: `http://127.0.0.1:${cfg.port}` },
    { name: 'ANTHROPIC_AUTH_TOKEN', value: cfg.secret },
    { name: 'CC_RELAY', value: '1' },
  ];
}

const parts = {
  shim: {
    label: 'cc command (terminal)',
    check: () => fs.existsSync(path.join(BIN, 'cc.cmd')),
    add() {
      fs.mkdirSync(BIN, { recursive: true });
      fs.writeFileSync(path.join(BIN, 'cc.cmd'), `@node "${P.CLI}" %*\r\n`);
      fs.writeFileSync(path.join(BIN, 'cc'), `#!/bin/sh\nexec node "${P.CLI.replace(/\\/g, '/')}" "$@"\n`);
    },
    remove() {
      for (const f of ['cc.cmd', 'cc']) try { fs.unlinkSync(path.join(BIN, f)); } catch {}
    },
  },
  startup: {
    label: 'relay starts at Windows sign-in',
    check: () => fs.existsSync(STARTUP),
    add() { fs.writeFileSync(STARTUP, vbsText()); },
    remove() { try { fs.unlinkSync(STARTUP); } catch {} },
  },
  statusline: {
    label: 'status line in Claude Code (terminal sessions)',
    check() {
      const s = S.readJson(CLAUDE_SETTINGS, {});
      return !!(s.statusLine && s.statusLine.command === statusCommand());
    },
    add() {
      editJson(CLAUDE_SETTINGS, s => {
        if (s.statusLine && s.statusLine.command !== statusCommand()) {
          throw new Error('Claude Code already has a different status line; leaving it alone');
        }
        s.statusLine = { type: 'command', command: statusCommand(), padding: 0 };
      });
    },
    remove() {
      editJson(CLAUDE_SETTINGS, s => {
        if (s.statusLine && s.statusLine.command === statusCommand()) delete s.statusLine;
      });
    },
  },
  vscode: {
    label: 'VS Code Claude extension goes through cc',
    check() {
      const s = S.readJson(VSCODE, {});
      const env = s['claudeCode.environmentVariables'] || [];
      return env.some(e => e.name === 'CC_RELAY');
    },
    add(cfg) {
      if (!fs.existsSync(VSCODE)) throw new Error('VS Code user settings not found');
      editJson(VSCODE, s => {
        const env = (s['claudeCode.environmentVariables'] || []).filter(e => !ENV_NAMES.includes(e.name));
        s['claudeCode.environmentVariables'] = [...env, ...relayEnv(cfg)];
      });
    },
    remove() {
      if (!fs.existsSync(VSCODE)) return;
      editJson(VSCODE, s => {
        const env = s['claudeCode.environmentVariables'];
        if (Array.isArray(env)) s['claudeCode.environmentVariables'] = env.filter(e => !ENV_NAMES.includes(e.name));
      });
    },
  },
};

module.exports = { parts, STARTUP, VSCODE, CLAUDE_SETTINGS, BIN };
