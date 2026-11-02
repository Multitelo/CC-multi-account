'use strict';
// Config, runtime state and encrypted account logins (see vault.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const vault = require('./vault');

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
  for (const d of [P.DATA, P.ACCOUNTS, P.BACKUPS]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
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
  writeAtomic(accountFile(name), await vault.protect(Buffer.from(JSON.stringify(creds))));
}

function saveCredsSync(name, creds) {
  ensureDirs();
  writeAtomic(accountFile(name), vault.protectSync(Buffer.from(JSON.stringify(creds))));
}

async function loadCreds(name) {
  const enc = fs.readFileSync(accountFile(name), 'utf8').trim();
  return JSON.parse((await vault.unprotect(enc)).toString('utf8'));
}

function loadCredsSync(name) {
  const enc = fs.readFileSync(accountFile(name), 'utf8').trim();
  return JSON.parse(vault.unprotectSync(enc).toString('utf8'));
}

function deleteCreds(name) {
  try { fs.unlinkSync(accountFile(name)); } catch {}
}

module.exports = {
  DEFAULTS, NAME_RE, ensureDirs, writeAtomic, readJson,
  loadConfig, saveConfig, loadState, saveState,
  saveCreds, saveCredsSync, loadCreds, loadCredsSync, deleteCreds, listAccountFiles,
};
