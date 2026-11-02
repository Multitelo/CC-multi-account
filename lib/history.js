'use strict';
// Append-only event log: switches, broken logins, usage snapshots.
const fs = require('fs');
const P = require('./paths');

const MAX_BYTES = 5 * 1024 * 1024;

function rotate(file, max) {
  try {
    if (fs.statSync(file).size > max) fs.renameSync(file, file + '.1');
  } catch {}
}

function append(event) {
  try {
    fs.mkdirSync(P.DATA, { recursive: true });
    rotate(P.HISTORY, MAX_BYTES);
    fs.appendFileSync(P.HISTORY, JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n');
  } catch {}
}

function read() {
  const lines = [];
  for (const f of [P.HISTORY + '.1', P.HISTORY]) {
    try { lines.push(...fs.readFileSync(f, 'utf8').split('\n')); } catch {}
  }
  return lines.filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function log(msg) {
  try {
    fs.mkdirSync(P.DATA, { recursive: true });
    rotate(P.LOG, 2 * 1024 * 1024);
    fs.appendFileSync(P.LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function describe(e) {
  switch (e.type) {
    case 'switch': return `switched ${e.from || '-'} -> ${e.to}: ${e.reason}`;
    case 'limit': return `${e.account} hit its limit (until ${new Date(e.until).toLocaleString()})`;
    case 'login-broken': return `${e.account} login stopped working: ${e.msg}`;
    case 'login': return `signed in ${e.account}${e.email ? ` (${e.email})` : ''}`;
    case 'remove': return `removed ${e.account}`;
    case 'window': return `started ${e.account}'s 5-hour window (resets ${new Date(e.until).toLocaleTimeString()})`;
    default: return e.type;
  }
}

module.exports = { append, read, log, describe };
