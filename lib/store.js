'use strict';
// Config, runtime state and encrypted account logins.
// Logins are encrypted with Windows DPAPI (CurrentUser scope): only this
// Windows user on this machine can decrypt them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const P = require('./paths');

const DEFAULTS = {
  port: 47821,
  secret: null,          // local key that cc sessions present to the relay
  order: [],             // account priority
  accounts: {},          // name -> { email, uuid, plan, addedAt } (no secrets)
  auto: true,            // switch automatically when a limit is near
  threshold5h: 95,
  threshold7d: 98,
  pins: {},              // folder path -> account name
  notify: true,
  pollSeconds: 180,
  startWindow: true,     // start a new 5-hour window as soon as the last one ends
  staggerWindows: false, // space accounts' windows 5h / accounts apart instead
  burnAware: true,       // switch early when the current pace would hit the limit soon
  burnMinutes: 15,       // ...within this many minutes
};

function ensureDirs() {
  for (const d of [P.DATA, P.ACCOUNTS, P.BACKUPS]) fs.mkdirSync(d, { recursive: true });
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadConfig() {
  ensureDirs();
  const cfg = { ...DEFAULTS, ...readJson(P.CONFIG, {}) };
  if (!cfg.secret) {
    cfg.secret = 'cc-' + crypto.randomBytes(24).toString('hex');
    saveConfig(cfg);
  }
  return cfg;
}

function saveConfig(cfg) {
  ensureDirs();
  writeAtomic(P.CONFIG, JSON.stringify(cfg, null, 2));
}

function loadState() { return readJson(P.STATE, {}); }
function saveState(state) { ensureDirs(); writeAtomic(P.STATE, JSON.stringify(state, null, 2)); }

// ---- DPAPI via PowerShell ---------------------------------------------------

function psScript(op) {
  return `Add-Type -AssemblyName System.Security
$i=[Console]::In.ReadToEnd().Trim()
$b=[Convert]::FromBase64String($i)
$o=[Security.Cryptography.ProtectedData]::${op}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($o))`;
}

function psArgs(op) {
  const enc = Buffer.from(psScript(op), 'utf16le').toString('base64');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc];
}

function dpapiSync(op, b64) {
  const r = spawnSync('powershell.exe', psArgs(op), { input: b64, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`DPAPI ${op} failed: ${(r.stderr || '').trim().slice(0, 300)}`);
  return r.stdout.trim();
}

function dpapi(op, b64) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', psArgs(op), { windowsHide: true });
    let out = '', err = '';
    ps.stdout.on('data', d => { out += d; });
    ps.stderr.on('data', d => { err += d; });
    ps.on('error', reject);
    ps.on('close', code => code === 0 ? resolve(out.trim())
      : reject(new Error(`DPAPI ${op} failed: ${err.trim().slice(0, 300)}`)));
    ps.stdin.end(b64);
  });
}

// ---- accounts ---------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

function accountFile(name) {
  if (!NAME_RE.test(name)) throw new Error(`Invalid account name "${name}" (letters, digits, - and _ only)`);
  return path.join(P.ACCOUNTS, `${name}.dat`);
}

function listAccountFiles() {
  try {
    return fs.readdirSync(P.ACCOUNTS).filter(f => f.endsWith('.dat')).map(f => f.slice(0, -4));
  } catch { return []; }
}

async function saveCreds(name, creds) {
  ensureDirs();
  const b64 = Buffer.from(JSON.stringify(creds)).toString('base64');
  writeAtomic(accountFile(name), await dpapi('Protect', b64));
}

function saveCredsSync(name, creds) {
  ensureDirs();
  const b64 = Buffer.from(JSON.stringify(creds)).toString('base64');
  writeAtomic(accountFile(name), dpapiSync('Protect', b64));
}

async function loadCreds(name) {
  const enc = fs.readFileSync(accountFile(name), 'utf8');
  return JSON.parse(Buffer.from(await dpapi('Unprotect', enc), 'base64').toString('utf8'));
}

function loadCredsSync(name) {
  const enc = fs.readFileSync(accountFile(name), 'utf8');
  return JSON.parse(Buffer.from(dpapiSync('Unprotect', enc), 'base64').toString('utf8'));
}

function deleteCreds(name) {
  try { fs.unlinkSync(accountFile(name)); } catch {}
}

module.exports = {
  DEFAULTS, NAME_RE, ensureDirs, writeAtomic, readJson,
  loadConfig, saveConfig, loadState, saveState,
  saveCreds, saveCredsSync, loadCreds, loadCredsSync, deleteCreds, listAccountFiles,
};
