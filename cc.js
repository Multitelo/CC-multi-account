#!/usr/bin/env node
'use strict';
// cc: run Claude Code through a local relay that spreads work across your
// Claude accounts and switches between them when one runs low.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const P = require('./lib/paths');
const S = require('./lib/store');
const A = require('./lib/anthropic');
const H = require('./lib/history');
const { pinFor, norm } = require('./lib/sessions');
const OS = require('./lib/platform');

{
  // Messages are written as `cc ...`; show them as `ccm ...`.
  for (const k of ['log', 'warn', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => orig(...a.map(OS.say));
  }
}

const COMMANDS = new Set([
  'login', 'remove', 'status', 'list', 'use', 'auto', 'pin', 'unpin', 'pins', 'threshold',
  'order', 'notify', 'log', 'doctor', 'install', 'uninstall', 'serve', 'stop', 'restart',
  'statusline', 'run', 'start', 'dashboard', 'help', '--help', '-h', 'version', '--version',
]);

// ---- small helpers ---------------------------------------------------------

class CcError extends Error {}
// Throws so callers (like the dashboard) can show the message; the entry
// point prints it and exits.
function die(msg) { throw new CcError(msg); }

function pct(v) { return v === null || v === undefined ? '  -' : `${Math.round(v)}%`.padStart(4); }

function until(ms) {
  if (!ms) return '';
  let s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  return d ? `${d}d${h}h` : h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

function ago(ms) { return ms ? `${until(Date.now() + (Date.now() - ms))} ago` : 'never'; }

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CC_RELAY', 'CLAUDECODE']) delete env[k];
  // Set when cc runs inside another Claude Code session; they would make the
  // child wait on that host's login instead of using cc.
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_(ENTRYPOINT|SDK_|OAUTH_|ACCOUNT_|ORGANIZATION_|USER_EMAIL|SESSION_ID|HOST_|MESSAGING_|CHILD_SESSION)/.test(k)) delete env[k];
  }
  return env;
}

const findClaude = OS.findClaude;

function request(cfg, method, pathname, body, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: cfg.port, path: pathname, method, timeout,
      headers: {
        authorization: `Bearer ${cfg.secret}`,
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

async function health(cfg) {
  try {
    const r = await request(cfg, 'GET', '/health', null, 1500);
    return r.status === 200 && r.body && r.body.app === 'cc' ? r.body : null;
  } catch { return null; }
}

async function ensureRelay(cfg, quiet) {
  if (await health(cfg)) return true;
  if (!quiet) process.stderr.write('ccm: starting the relay...\n');
  const child = spawn(process.execPath, [P.CLI, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await health(cfg)) return true;
  }
  return false;
}

async function relayStatus(cfg) {
  try {
    const r = await request(cfg, 'GET', '/_cc/status');
    if (r.status === 200) return { live: true, ...r.body };
  } catch {}
  return { live: false, ...S.loadState() };
}

async function tellRelay(cfg, pathname, body) {
  if (!(await health(cfg))) return null;
  try { return await request(cfg, 'POST', pathname, body, 20000); } catch { return null; }
}

// ---- launching Claude Code -------------------------------------------------

async function launch(args) {
  const cfg = S.loadConfig();
  let account = null;
  const i = args.findIndex(a => a === '--account' || a === '--as');
  if (i !== -1) {
    account = args[i + 1];
    if (!account) die('--account needs a name');
    args = [...args.slice(0, i), ...args.slice(i + 2)];
  }
  if (!account) account = pinFor(process.cwd(), cfg.pins);
  if (account && !cfg.order.includes(account)) die(`there is no account named "${account}". See "cc status".`);

  const exe = findClaude();
  if (!exe) die('could not find Claude Code (claude.exe) on PATH');

  let env = cleanEnv();
  if (!cfg.order.length) {
    process.stderr.write('ccm: no accounts yet ("ccm login <name>"), so starting Claude Code with its normal login.\n');
  } else if (await ensureRelay(cfg)) {
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${cfg.port}${account ? `/a/${encodeURIComponent(account)}` : ''}`;
    env.ANTHROPIC_AUTH_TOKEN = cfg.secret;
    env.CC_RELAY = '1';
  } else {
    process.stderr.write('ccm: the relay did not start, so this session uses Claude Code\'s normal login. Run "ccm doctor".\n');
  }

  process.on('SIGINT', () => {}); // Claude Code handles Ctrl+C itself
  const child = spawn(exe, args, { stdio: 'inherit', env });
  child.on('error', e => { console.error(`ccm: could not start Claude Code: ${e.message}`); process.exit(1); });
  child.on('exit', code => process.exit(code ?? 1));
}

// ---- commands --------------------------------------------------------------

async function cmdLogin(args) {
  const name = args.find(a => !a.startsWith('--'));
  if (!name) die('usage: cc login <name> [--email you@example.com] [--replace] [--manual]');
  if (!S.NAME_RE.test(name)) die('account names use letters, digits, - and _ (max 32)');
  const emailIdx = args.indexOf('--email');
  const email = emailIdx !== -1 ? args[emailIdx + 1] : null;
  const cfg = S.loadConfig();
  const exe = findClaude();
  
  const tmp = path.join(P.DATA, `login-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    console.log(`Signing in "${name}". A browser window will open.`);
    console.log('Make sure the browser shows the account you want for this name before you approve.\n');
    let creds;
    if (OS.IS_WIN && !args.includes('--direct') && !args.includes('--manual')) {
      const exe = findClaude();
      if (!exe) die('could not find Claude Code (claude.exe) on PATH');
      const r = spawnSync(exe, ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])], {
        stdio: 'inherit', env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: tmp },
      });
      const credFile = path.join(tmp, '.credentials.json');
      if (r.status !== 0 || !fs.existsSync(credFile)) die('sign-in did not finish, nothing was saved');
      creds = JSON.parse(fs.readFileSync(credFile, 'utf8')).claudeAiOauth;
    } else {
      // macOS keeps Claude Code's login in the Keychain, so cc signs in itself.
      creds = await require('./lib/signin').signIn({ email, manual: args.includes('--manual') });
    }
    if (!creds || !creds.refreshToken) die('sign-in finished but no subscription login was found');

    let who = { uuid: null, email: null, plan: null };
    try { who = await A.profile(creds.accessToken); } catch (e) { console.warn(`ccm: could not read the account profile (${e.message})`); }

    for (const [other, meta] of Object.entries(cfg.accounts)) {
      if (other !== name && who.uuid && meta.uuid === who.uuid) {
        die(`that is the same Claude account as "${other}" (${meta.email || who.uuid}). Nothing was saved.`);
      }
    }
    const prev = cfg.accounts[name];
    if (prev && prev.uuid && who.uuid && prev.uuid !== who.uuid && !args.includes('--replace')) {
      die(`"${name}" was ${prev.email || prev.uuid}, but you signed in as ${who.email || who.uuid}. Re-run with --replace if that is intended.`);
    }

    S.saveCredsSync(name, {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      scopes: creds.scopes,
      subscriptionType: creds.subscriptionType || who.plan || null,
    });
    const fresh = S.loadConfig();
    fresh.accounts[name] = { email: who.email, uuid: who.uuid, plan: creds.subscriptionType || who.plan || null, addedAt: new Date().toISOString() };
    if (!fresh.order.includes(name)) fresh.order.push(name);
    S.saveConfig(fresh);
    H.append({ type: 'login', account: name, email: who.email });
    console.log(`\nSaved "${name}"${who.email ? ` (${who.email})` : ''}, plan: ${creds.subscriptionType || who.plan || 'unknown'}.`);
    if (await tellRelay(fresh, '/_cc/reload')) console.log('The running relay picked it up.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true }); // holds a plain-text copy of the login
  }
}

async function cmdRemove(args) {
  const name = args.find(a => !a.startsWith('--'));
  if (!name) die('usage: cc remove <name> --yes');
  const cfg = S.loadConfig();
  if (!cfg.order.includes(name) && !cfg.accounts[name]) die(`there is no account named "${name}"`);
  if (!args.includes('--yes')) die(`this deletes cc's saved login for "${name}". Re-run with --yes to confirm.`);
  await removeAccount(name);
  console.log(`Removed "${name}".`);
}

async function removeAccount(name) {
  const cfg = S.loadConfig();
  S.deleteCreds(name);
  delete cfg.accounts[name];
  cfg.order = cfg.order.filter(n => n !== name);
  for (const [k, v] of Object.entries(cfg.pins)) if (v === name) delete cfg.pins[k];
  S.saveConfig(cfg);
  H.append({ type: 'remove', account: name });
  await tellRelay(cfg, '/_cc/reload');
}

async function cmdStatus(args) {
  const cfg = S.loadConfig();
  if (args.includes('--refresh')) await tellRelay(cfg, '/_cc/poll');
  const st = await relayStatus(cfg);
  if (args.includes('--json')) return console.log(JSON.stringify(st, null, 2));
  console.log(`relay: ${st.live ? `running (pid ${st.pid})` : 'NOT running (showing last saved state)'}`
    + ` | auto-switch ${cfg.auto ? 'on' : 'off'} | switches at 5h >= ${cfg.threshold5h}% or week >= ${cfg.threshold7d}%`);
  const accounts = st.accounts || [];
  if (!accounts.length) return console.log('\nNo accounts yet. Add one with: cc login <name>');
  const rows = [['', 'ACCOUNT', 'EMAIL', 'PLAN', '5-HOUR', 'RESETS', 'WEEK', 'RESETS', 'STATE']];
  for (const a of accounts) {
    const state = a.broken ? 'LOGIN BROKEN' : a.exhaustedUntil ? `limit until ${new Date(a.exhaustedUntil).toLocaleTimeString()}` : a.name === st.active ? 'active' : 'ready';
    rows.push([a.name === st.active ? '>' : '', a.name, a.email || '-', a.plan || '-', pct(a.h5), until(a.h5Reset), pct(a.d7), until(a.d7Reset), state]);
  }
  const w = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
  console.log('');
  for (const r of rows) console.log(r.map((v, c) => String(v).padEnd(w[c])).join('  ').trimEnd());
  const fresh = accounts.map(a => a.usageAt).filter(Boolean);
  if (fresh.length) console.log(`\nusage updated ${ago(Math.min(...fresh))}`);
  const pins = Object.entries(cfg.pins);
  if (pins.length) console.log(`pins: ${pins.map(([f, n]) => `${f} -> ${n}`).join(', ')}`);
  for (const a of accounts) if (a.broken) console.log(`\n! ${a.name}: ${a.broken}\n  Fix: cc login ${a.name}`);
}

async function cmdUse(args) {
  const name = args[0];
  if (!name) die('usage: cc use <name>');
  const cfg = S.loadConfig();
  if (!cfg.order.includes(name)) die(`there is no account named "${name}"`);
  if (!(await ensureRelay(cfg, true))) die('the relay is not running; see "cc doctor"');
  const r = await request(cfg, 'POST', '/_cc/use', { name });
  if (r.status !== 200) die((r.body && r.body.error) || 'the relay refused');
  console.log(`Now using "${name}".${cfg.auto ? ' Auto-switch is still on and will move off it when it runs low ("cc auto off" to stay put).' : ''}`);
}

async function setConfig(mutate, msg) {
  const cfg = S.loadConfig();
  mutate(cfg);
  S.saveConfig(cfg);
  await tellRelay(cfg, '/_cc/reload');
  if (msg) console.log(typeof msg === 'function' ? msg(cfg) : msg);
}

async function cmdAuto(args) {
  const v = args[0];
  if (!['on', 'off'].includes(v)) die('usage: cc auto on|off');
  await setConfig(c => { c.auto = v === 'on'; }, `Auto-switch is ${v}.`);
}

async function cmdNotify(args) {
  const v = args[0];
  if (!['on', 'off'].includes(v)) die('usage: cc notify on|off');
  await setConfig(c => { c.notify = v === 'on'; }, `Notifications are ${v}.`);
}

async function cmdPin(args) {
  const cfg = S.loadConfig();
  const name = args[0] || S.loadState().active;
  if (!name || !cfg.order.includes(name)) die('usage: cc pin <account> [folder]   (folder defaults to the current one)');
  const folder = path.resolve(args[1] || process.cwd());
  await setConfig(c => {
    for (const k of Object.keys(c.pins)) if (norm(k) === norm(folder)) delete c.pins[k];
    c.pins[folder] = name;
  }, `Pinned ${folder} -> ${name}. Sessions in this folder always use "${name}" and never auto-switch.`);
}

async function cmdUnpin(args) {
  const folder = path.resolve(args[0] || process.cwd());
  let found = false;
  await setConfig(c => {
    for (const k of Object.keys(c.pins)) if (norm(k) === norm(folder)) { delete c.pins[k]; found = true; }
  });
  console.log(found ? `Unpinned ${folder}.` : `${folder} was not pinned.`);
}

function cmdPins() {
  const pins = Object.entries(S.loadConfig().pins);
  if (!pins.length) return console.log('No pinned folders.');
  for (const [f, n] of pins) console.log(`${n.padEnd(12)} ${f}`);
}

async function cmdThreshold(args) {
  const h5 = Number(args[0]), d7 = args[1] === undefined ? null : Number(args[1]);
  const ok = v => Number.isFinite(v) && v > 0 && v <= 100;
  if (!ok(h5) || (d7 !== null && !ok(d7))) die('usage: cc threshold <5-hour %> [weekly %]   e.g. cc threshold 95 98');
  await setConfig(c => { c.threshold5h = h5; if (d7 !== null) c.threshold7d = d7; },
    c => `Switches when 5-hour usage >= ${c.threshold5h}% or weekly >= ${c.threshold7d}%.`);
}

async function cmdOrder(args) {
  const cfg = S.loadConfig();
  if (!args.length) return console.log(cfg.order.join(' > ') || 'no accounts');
  const missing = args.filter(n => !cfg.order.includes(n));
  if (missing.length) die(`unknown account(s): ${missing.join(', ')}`);
  await setConfig(c => { c.order = [...args, ...c.order.filter(n => !args.includes(n))]; }, c => `Order: ${c.order.join(' > ')}`);
}

function cmdLog(args) {
  const events = H.read();
  if (args.includes('--usage')) {
    const days = new Map();
    for (const e of events) {
      if (e.type !== 'usage') continue;
      const day = new Date(e.t).toLocaleDateString();
      if (!days.has(day)) days.set(day, {});
      const d = days.get(day);
      for (const [n, u] of Object.entries(e.accounts || {})) {
        const cur = d[n] || { h5: 0, d7: 0 };
        d[n] = { h5: Math.max(cur.h5, u.h5 || 0), d7: Math.max(cur.d7, u.d7 || 0) };
      }
    }
    const list = [...days.entries()].slice(-14);
    if (!list.length) return console.log('No usage history yet (it is recorded every 15 minutes while the relay runs).');
    console.log('Highest usage seen per day (5-hour / weekly):');
    for (const [day, d] of list) console.log(`${day.padEnd(12)} ${Object.entries(d).map(([n, u]) => `${n} ${Math.round(u.h5)}%/${Math.round(u.d7)}%`).join('   ')}`);
    return;
  }
  const n = Number(args[args.indexOf('-n') + 1]) || 25;
  const shown = events.filter(e => e.type !== 'usage').slice(-n);
  if (!shown.length) return console.log('Nothing logged yet.');
  for (const e of shown) console.log(`${new Date(e.t).toLocaleString()}  ${H.describe(e)}`);
}

async function cmdDoctor() {
  const cfg = S.loadConfig();
  const { parts } = require('./lib/install');
  let bad = 0;
  const line = (ok, label, hint) => {
    if (!ok) bad++;
    console.log(`${ok === true ? ' ok ' : ok === null ? ' -- ' : 'FAIL'}  ${label}${!ok && hint ? `\n        ${hint}` : ''}`);
  };
  line(Number(process.versions.node.split('.')[0]) >= 18, `Node.js ${process.version}`, 'Node 18 or newer is needed');
  const exe = findClaude();
  line(!!exe, `Claude Code: ${exe || 'not found'}`);
  line(cfg.order.length > 0, `${cfg.order.length} account(s): ${cfg.order.join(', ') || 'none'}`, 'add one: cc login <name>');
  for (const n of cfg.order) {
    try { S.loadCredsSync(n); line(true, `login for "${n}" decrypts`); }
    catch (e) { line(false, `login for "${n}" cannot be read`, `cc login ${n}   (${e.message})`); }
  }
  const h = await health(cfg);
  line(!!h, h ? `relay running on 127.0.0.1:${cfg.port} (pid ${h.pid})` : `relay not running on port ${cfg.port}`, 'start it: cc serve   (or cc restart)');
  if (h) {
    const st = await relayStatus(cfg);
    for (const a of st.accounts || []) {
      if (a.broken) line(false, `"${a.name}" login is broken`, `cc login ${a.name}`);
      else if (a.pollError) line(false, `"${a.name}" usage check failed: ${a.pollError}`);
      else line(a.usageAt && Date.now() - a.usageAt < 15 * 60 * 1000, `"${a.name}" usage updated ${ago(a.usageAt)}`);
    }
  }
  for (const [key, p] of Object.entries(parts)) line(p.check() ? true : null, `${p.label}${p.check() ? '' : ' (not installed; "cc install")'}`);
  if (process.env.ANTHROPIC_API_KEY) line(false, 'ANTHROPIC_API_KEY is set in this shell', 'Claude Code prefers it over subscriptions; remove it unless you want API billing');
  console.log(`  --  logins are protected with ${require('./lib/vault').NAME}`);
  const clauth = !OS.IS_WIN ? { stdout: '' } : spawnSync('tasklist', ['/FI', 'IMAGENAME eq clauth.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
  if (/clauth\.exe/i.test(clauth.stdout || '')) console.log(' note  clauth is still running. It does not share logins with cc, but remove it once cc is working.');
  console.log(bad ? `\n${bad} problem(s) found.` : '\nEverything looks fine.');
}

async function cmdInstall(args) {
  const cfg = S.loadConfig();
  const { parts } = require('./lib/install');
  const only = args.filter(a => !a.startsWith('--'));
  // The terminal shim is only for git-clone installs; npm installs provide `cc` themselves.
  const pick = only.length ? only : Object.keys(parts).filter(k => k !== 'shim');
  if (pick.includes('vscode') && !cfg.order.length && !args.includes('--force')) {
    die('add an account first ("cc login <name>"): VS Code would otherwise have no working login');
  }
  for (const key of pick) {
    const p = parts[key];
    if (!p) { console.log(`skip  unknown part "${key}" (parts: ${Object.keys(parts).join(', ')})`); continue; }
    try { p.add(cfg); console.log(` ok   ${p.label}`); }
    catch (e) { console.log(`FAIL  ${p.label}: ${e.message}`); }
  }
  if (pick.includes('startup') || pick.includes('vscode')) await ensureRelay(cfg, true);
  if (pick.includes('vscode')) console.log('\nReload VS Code (Developer: Reload Window) so new Claude sessions use cc.');
}

async function cmdUninstall(args) {
  const { parts } = require('./lib/install');
  const only = args.filter(a => !a.startsWith('--'));
  const pick = only.length ? only : Object.keys(parts);
  for (const key of pick) {
    const p = parts[key];
    if (!p) continue;
    try { p.remove(); console.log(` ok   removed: ${p.label}`); }
    catch (e) { console.log(`FAIL  ${p.label}: ${e.message}`); }
  }
  console.log('\nYour accounts and history in ~/.cc were kept. Stop the relay with "cc stop".');
}

async function cmdServe(args) {
  if (args.includes('--child')) return require('./lib/relay').runRelay();
  const cfg = S.loadConfig();
  if (await health(cfg)) { console.log('The relay is already running.'); return; }
  // Supervisor: keep the relay alive, restart it if it crashes.
  let delay = 2000;
  const run = () => {
    const started = Date.now();
    const child = spawn(process.execPath, [P.CLI, 'serve', '--child'], { stdio: 'inherit', windowsHide: true });
    child.on('exit', async code => {
      if (code === 0) process.exit(0);                         // asked to stop
      if (code === 3 && await health(cfg)) process.exit(0);    // another relay already serves
      delay = Date.now() - started > 60000 ? 2000 : Math.min(delay * 2, 60000);
      H.log(`relay exited with code ${code}; restarting in ${delay / 1000}s`);
      setTimeout(run, delay);
    });
  };
  run();
}

async function cmdStop() {
  const cfg = S.loadConfig();
  if (!(await health(cfg))) return console.log('The relay is not running.');
  await request(cfg, 'POST', '/_cc/stop');
  console.log('Relay stopped. VS Code Claude sessions will fail until it runs again ("cc serve").');
}

async function cmdRestart() {
  const cfg = S.loadConfig();
  if (await health(cfg)) {
    await request(cfg, 'POST', '/_cc/stop');
    for (let i = 0; i < 20 && await health(cfg); i++) await new Promise(r => setTimeout(r, 200));
  }
  console.log(await ensureRelay(cfg, true) ? 'Relay restarted.' : 'The relay did not come back; see ~/.cc/relay.log');
}

function cmdStatusline() {
  if (process.env.CC_RELAY !== '1') return; // not a cc session (e.g. the Desktop app)
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
  const cfg = S.loadConfig();
  const st = S.loadState();
  const base = process.env.ANTHROPIC_BASE_URL || '';
  const m = /\/a\/([^/]+)/.exec(base);
  const cwd = input.cwd || (input.workspace && input.workspace.current_dir) || process.cwd();
  const pinned = m ? decodeURIComponent(m[1]) : pinFor(cwd, cfg.pins);
  const name = pinned || st.active;
  const a = (st.accounts || []).find(x => x.name === name);
  if (!a) return process.stdout.write(`ccm: ${name || 'no account'}`);
  const flag = a.broken ? ' LOGIN BROKEN' : a.exhaustedUntil ? ' at limit' : '';
  process.stdout.write(`ccm ${pinned ? 'pinned ' : ''}${a.name} | 5h ${pct(a.h5).trim()} | wk ${pct(a.d7).trim()}${flag}`);
}

function help() {
  const text = `ccm ${P.VERSION} - Claude Code across several accounts, switching automatically

  ccm                         open the dashboard

Start Claude Code through ccm:
  ccm start [claude args]     start Claude Code (e.g. ccm start --resume)
  ccm --resume, ccm -p "..."  claude flags also work directly
  ccm start --account <name>  this session on one account only

Accounts:
  ccm login <name>            sign in an account (opens the browser)
  ccm remove <name> --yes     forget an account
  ccm status [--refresh]      usage and state of every account
  ccm use <name>              switch now
  ccm auto on|off             automatic switching
  ccm threshold <5h> [week]   when to switch, in percent (default 95 98)
  ccm order <a> <b> ...       priority order

Projects:
  ccm pin [account] [folder]  always use one account in a folder
  ccm unpin [folder]          remove a pin
  ccm pins                    list pins

Other:
  ccm log [-n 50] | --usage   switch history, or daily usage peaks
  ccm doctor                  check that everything works
  ccm install | uninstall     wire into the terminal, VS Code, status line, startup
  ccm serve | stop | restart  control the relay
  ccm notify on|off           notifications`;
  console.log(text + (OS.IS_WIN ? '\n\nOn Windows, `cc` works as a shortcut for `ccm`.' : ''));
}

function dashboard() {
  return require('./lib/tui').run({
    loadConfig: S.loadConfig,
    status: relayStatus,
    ensureRelay,
    poll: cfg => tellRelay(cfg, '/_cc/poll'),
    use: async (cfg, name) => {
      if (!(await ensureRelay(cfg, true))) die('the relay is not running');
      const r = await request(cfg, 'POST', '/_cc/use', { name });
      if (r.status !== 200) die((r.body && r.body.error) || 'the relay refused');
    },
    setConfig: async mutate => setConfig(mutate),
    login: name => cmdLogin([name]),
    remove: removeAccount,
    launch: () => launch([]),
  });
}

// ---- main ------------------------------------------------------------------

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === undefined) return process.stdout.isTTY ? dashboard() : help();
  if (!COMMANDS.has(cmd)) {
    if (cmd.startsWith('-')) return launch(process.argv.slice(2)); // e.g. cc --resume
    return help();
  }
  switch (cmd) {
    case 'start': case 'run': return launch(args);
    case 'dashboard': return dashboard();
    case 'login': return cmdLogin(args);
    case 'remove': return cmdRemove(args);
    case 'status': case 'list': return cmdStatus(args);
    case 'use': return cmdUse(args);
    case 'auto': return cmdAuto(args);
    case 'notify': return cmdNotify(args);
    case 'pin': return cmdPin(args);
    case 'unpin': return cmdUnpin(args);
    case 'pins': return cmdPins();
    case 'threshold': return cmdThreshold(args);
    case 'order': return cmdOrder(args);
    case 'log': return cmdLog(args);
    case 'doctor': return cmdDoctor();
    case 'install': return cmdInstall(args);
    case 'uninstall': return cmdUninstall(args);
    case 'serve': return cmdServe(args);
    case 'stop': return cmdStop();
    case 'restart': return cmdRestart();
    case 'statusline': return cmdStatusline();
    case 'version': case '--version': return console.log(P.VERSION);
    default: return help();
  }
})().catch(e => {
  console.error(`ccm: ${e instanceof CcError ? e.message : e.stack || e.message}`);
  process.exit(1);
});
