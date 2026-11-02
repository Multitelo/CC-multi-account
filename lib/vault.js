'use strict';
// Encrypts saved logins.
//   Windows: DPAPI (CurrentUser), via PowerShell. Only this Windows user can decrypt.
//   macOS:   AES-256-GCM with a random key kept in the login Keychain.
//   Linux:   AES-256-GCM with a random key in ~/.cc/master.key (mode 600).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const P = require('./paths');
const { IS_WIN, IS_MAC } = require('./platform');

const PREFIX = 'ccv1:';
const KEYCHAIN_SERVICE = 'cc-multi-account';
const KEYCHAIN_ACCOUNT = 'master-key';

// ---- Windows DPAPI ---------------------------------------------------------

function psArgs(op) {
  const script = `Add-Type -AssemblyName System.Security
$i=[Console]::In.ReadToEnd().Trim()
$b=[Convert]::FromBase64String($i)
$o=[Security.Cryptography.ProtectedData]::${op}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($o))`;
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
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

// ---- macOS / Linux master key ----------------------------------------------

let cachedKey = null;

function keychainKey() {
  const get = () => spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], { encoding: 'utf8' });
  let r = get();
  if (r.status === 0 && /^[0-9a-f]{64}$/.test(r.stdout.trim())) return Buffer.from(r.stdout.trim(), 'hex');
  const hex = crypto.randomBytes(32).toString('hex');
  const add = spawnSync('security', ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', hex, '-U'], { encoding: 'utf8' });
  if (add.status !== 0) throw new Error(`could not save the encryption key in the Keychain: ${(add.stderr || '').trim()}`);
  r = get();
  if (r.status !== 0) throw new Error('the Keychain did not return the encryption key');
  return Buffer.from(r.stdout.trim(), 'hex');
}

function fileKey() {
  const file = path.join(P.DATA, 'master.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch {}
  fs.mkdirSync(P.DATA, { recursive: true, mode: 0o700 });
  const hex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, hex + '\n', { mode: 0o600 });
  return Buffer.from(hex, 'hex');
}

function masterKey() {
  if (!cachedKey) cachedKey = IS_MAC ? keychainKey() : fileKey();
  return cachedKey;
}

function seal(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function open(text) {
  const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

// ---- public ----------------------------------------------------------------

function protectSync(buf) {
  return IS_WIN ? dpapiSync('Protect', buf.toString('base64')) : seal(buf);
}

function unprotectSync(text) {
  if (text.startsWith(PREFIX)) return open(text);
  return Buffer.from(dpapiSync('Unprotect', text), 'base64');
}

async function protect(buf) {
  return IS_WIN ? dpapi('Protect', buf.toString('base64')) : seal(buf);
}

async function unprotect(text) {
  if (text.startsWith(PREFIX)) return open(text);
  return Buffer.from(await dpapi('Unprotect', text), 'base64');
}

const NAME = IS_WIN ? 'Windows DPAPI' : IS_MAC ? 'AES-256-GCM, key in the macOS Keychain' : 'AES-256-GCM, key in ~/.cc/master.key (mode 600)';

module.exports = { protect, unprotect, protectSync, unprotectSync, NAME, seal, open };
