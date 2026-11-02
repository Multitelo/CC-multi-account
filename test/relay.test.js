'use strict';
// End-to-end test of the relay against a fake Anthropic server.
// Uses a throwaway data folder; never touches ~/.cc or real accounts.
//   node test/relay.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
const FAKE_PORT = 47990, RELAY_PORT = 47991;
const CLAUDE_DIR = path.join(ROOT, 'claude');
const env = {
  ...process.env,
  CC_HOME: path.join(ROOT, 'data'),
  CC_CLAUDE_DIR: CLAUDE_DIR,
  CC_UPSTREAM: `http://127.0.0.1:${FAKE_PORT}`,
  CC_TOKEN_URL: `http://127.0.0.1:${FAKE_PORT}/token`,
  CC_NO_TOAST: '1',
  CC_STATUS_URL: `http://127.0.0.1:${FAKE_PORT}/status`,
};
Object.assign(process.env, env);
const S = require('../lib/store');
const CLI = path.join(__dirname, '..', 'cc.js');

// ---- fake Anthropic --------------------------------------------------------
const fake = {
  refreshes: [],
  seen: [],                    // { account, path, beta }
  limited: new Set(),          // accounts that answer 429 rejected
  util: { main: 0.25, backup: 0.10 },
  deadRefresh: new Set(),      // refresh tokens that answer invalid_grant
};
const tokens = { 'tok-main-old': 'main', 'tok-backup': 'backup' };
let n = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: { indicator: 'minor', description: 'Minor Service Outage' },
        components: [{ name: 'Claude Code', status: 'degraded_performance' }],
        incidents: [{ name: 'Elevated errors', status: 'investigating', impact: 'minor', updated_at: new Date().toISOString(), incident_updates: [{ body: 'Looking into it' }] }] }));
    }
    if (req.url === '/token') {
      const b = JSON.parse(body);
      fake.refreshes.push(b);
      if (fake.deadRefresh.has(b.refresh_token)) { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
      const acct = b.refresh_token.includes('main') ? 'main' : 'backup';
      const t = `tok-${acct}-${++n}`;
      tokens[t] = acct;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: t, refresh_token: `ref-${acct}-${n}`, expires_in: 28800 }));
    }
    const acct = tokens[(req.headers.authorization || '').replace('Bearer ', '')];
    if (!acct) { res.writeHead(401); return res.end('{"type":"error"}'); }
    if (req.url === '/api/oauth/usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const idle = acct === 'backup' && !fake.backupStarted; // no 5-hour window running yet
      return res.end(JSON.stringify({ five_hour: { utilization: idle ? 0 : fake.util[acct] * 100, resets_at: idle ? null : new Date(Date.now() + 3600e3).toISOString() }, seven_day: { utilization: 40, resets_at: new Date(Date.now() + 86400e3).toISOString() } }));
    }
    if (acct === 'backup') fake.backupStarted = true;
    fake.seen.push({ account: acct, path: req.url, beta: req.headers['anthropic-beta'], session: req.headers['x-claude-code-session-id'] });
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    if (fake.limited.has(acct)) {
      res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': reset, 'anthropic-ratelimit-unified-5h-utilization': '1.0' });
      return res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': String(fake.util[acct]),
      'anthropic-ratelimit-unified-5h-reset': reset,
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
    });
    res.write(`event: message_start\ndata: {"account":"${acct}"}\n\n`);
    setTimeout(() => { res.write('event: message_stop\ndata: {}\n\n'); res.end(); }, 50);
  });
});

// ---- helpers ---------------------------------------------------------------
let SECRET;
function call(pathname, { method = 'POST', auth = true, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: pathname, method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${SECRET}` } : {}), 'anthropic-beta': 'foo-1', ...headers } }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{"model":"x","messages":[]}' : undefined);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const status = async () => JSON.parse((await call('/_cc/status', { method: 'GET' })).text);
const history = () => fs.readFileSync(path.join(ROOT, 'data', 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

async function main() {
  await new Promise(r => server.listen(FAKE_PORT, '127.0.0.1', r));
  const cfg = S.loadConfig();
  cfg.port = RELAY_PORT;
  cfg.order = ['main', 'backup'];
  cfg.accounts = { main: { email: 'main@test' }, backup: { email: 'backup@test' } };
  S.saveConfig(cfg);
  SECRET = cfg.secret;
  S.saveCredsSync('main', { accessToken: 'tok-main-old', refreshToken: 'ref-main-0', expiresAt: Date.now() + 60e3, scopes: ['user:inference'] });
  S.saveCredsSync('backup', { accessToken: 'tok-backup', refreshToken: 'ref-backup-0', expiresAt: Date.now() + 8 * 3600e3, scopes: ['user:inference'] });
  assert.ok(!fs.readFileSync(path.join(ROOT, 'data', 'accounts', 'main.dat'), 'utf8').includes('ref-main'), 'login file is encrypted');

  const relay = spawn(process.execPath, [CLI, 'serve', '--child'], { env, stdio: 'inherit' });
  for (let i = 0; i < 40; i++) { await wait(250); try { if ((await call('/health', { method: 'GET', auth: false })).status === 200) break; } catch {} }

  const results = [];
  const test = async (name, fn) => {
    try { await fn(); results.push(`PASS  ${name}`); } catch (e) { results.push(`FAIL  ${name}: ${e.message}`); }
  };

  await test('starts the 5-hour window of an idle account right away', async () => {
    const hist = () => { try { return history(); } catch { return []; } };
    for (let i = 0; i < 50 && !hist().some(e => e.type === 'window'); i++) await wait(100);
    const w = hist().find(e => e.type === 'window');
    assert.ok(w && w.account === 'backup', 'window event for backup');
    assert.ok(fake.seen.some(e => e.account === 'backup' && e.path === '/v1/messages'));
    assert.ok(!history().some(e => e.type === 'window' && e.account === 'main'), 'main already had a window');
  });
  await test('rejects requests without the local key', async () => {
    assert.strictEqual((await call('/v1/messages', { auth: false })).status, 401);
  });
  await test('refreshes an expiring token and saves the new one encrypted', async () => {
    const r = await call('/v1/messages');
    assert.strictEqual(r.status, 200);
    assert.ok(fake.refreshes.some(b => b.refresh_token === 'ref-main-0' && b.scope === 'user:inference'));
    await wait(200);
    assert.strictEqual(S.loadCredsSync('main').refreshToken.startsWith('ref-main-'), true);
    assert.notStrictEqual(S.loadCredsSync('main').refreshToken, 'ref-main-0');
  });
  await test('streams the response and adds the OAuth beta header', async () => {
    const r = await call('/v1/messages');
    assert.ok(r.text.includes('message_start') && r.text.includes('message_stop'));
    const last = fake.seen[fake.seen.length - 1];
    assert.strictEqual(last.account, 'main');
    assert.ok(last.beta.includes('foo-1') && last.beta.includes('oauth-2025-04-20'));
  });
  await test('records usage from response headers', async () => {
    const st = await status();
    assert.strictEqual(Math.round(st.accounts.find(a => a.name === 'main').h5), 25);
  });
  await test('mid-session: a 429 limit retries on the other account and switches', async () => {
    fake.limited.add('main');
    const r = await call('/v1/messages');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('"account":"backup"'));
    const st = await status();
    assert.strictEqual(st.active, 'backup');
    assert.ok(st.accounts.find(a => a.name === 'main').exhaustedUntil);
    assert.ok(history().some(e => e.type === 'switch' && e.from === 'main' && e.to === 'backup'));
  });
  await test('a pinned route never switches (gets the 429 through)', async () => {
    const r = await call('/a/main/v1/messages');
    assert.strictEqual(r.status, 429);
  });
  await test('folder pin via the session id header', async () => {
    const proj = path.join(CLAUDE_DIR, 'projects', 'C--work-pinned');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'aaaabbbb-1111-2222-3333-444455556666.jsonl'), JSON.stringify({ type: 'user', cwd: 'C:\\work\\pinned\\sub' }) + '\n');
    const c = S.loadConfig(); c.pins = { 'C:\\Work\\Pinned': 'main' }; S.saveConfig(c);
    await call('/_cc/reload');
    const r = await call('/v1/messages', { headers: { 'x-claude-code-session-id': 'aaaabbbb-1111-2222-3333-444455556666' } });
    assert.strictEqual(r.status, 429, 'pinned to main, which is limited');
    const r2 = await call('/v1/messages', { headers: { 'x-claude-code-session-id': 'ffffffff-1111-2222-3333-444455556666' } });
    assert.strictEqual(r2.status, 200, 'unpinned session still goes to backup');
  });
  await test('threshold: switches before the limit when usage headers pass it', async () => {
    fake.limited.clear();
    fake.util.main = 0.2;
    await call('/_cc/poll');                         // main recovers (usage back to 20%)
    // make main healthy again and active, then push it over the threshold
    await new Promise(res => { const q = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: '/_cc/use', method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, s => { s.resume(); s.on('end', res); }); q.end('{"name":"main"}'); });
    fake.util.main = 0.97;
    let r = await call('/v1/messages');              // served by main, reports 97%
    assert.ok(r.text.includes('"account":"main"'));
    r = await call('/v1/messages');                  // next one should move to backup
    assert.ok(r.text.includes('"account":"backup"'), 'switched to backup before hitting the limit');
  });
  await test('a dead login is marked broken and work moves to the other account', async () => {
    const creds = S.loadCredsSync('backup');
    fake.deadRefresh.add(creds.refreshToken);
    delete tokens[creds.accessToken];                // access token now rejected -> forced refresh -> invalid_grant
    fake.util.main = 0.2;
    const r = await call('/v1/messages');
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.includes('"account":"main"'));
    const st = await status();
    assert.ok(st.accounts.find(a => a.name === 'backup').broken);
    assert.ok(history().some(e => e.type === 'login-broken' && e.account === 'backup'));
  });
  await test('status line shows the active account for cc sessions only', async () => {
    await wait(500);
    const on = spawnSync(process.execPath, [CLI, 'statusline'], { env: { ...env, CC_RELAY: '1' }, input: '{"cwd":"C:\\\\elsewhere"}', encoding: 'utf8' });
    assert.ok(/^ccm main \| 5h 20% \| wk 40%/.test(on.stdout), on.stdout);
    const off = spawnSync(process.execPath, [CLI, 'statusline'], { env, input: '{}', encoding: 'utf8' });
    assert.strictEqual(off.stdout, '');
  });

  await test('status page is read into the relay state', async () => {
    const an = (await status()).anthropic;
    assert.strictEqual(an.indicator, 'minor');
    assert.strictEqual(an.components[0].status, 'degraded_performance');
    assert.strictEqual(an.incidents[0].latest, 'Looking into it');
  });

  // ---- unit checks on the switching logic (no server) ----
  const { Relay } = require('../lib/relay');
  const r = new Relay();
  r.cfg = { ...r.cfg, threshold5h: 95, threshold7d: 98, burnAware: true, burnMinutes: 15, startWindow: true, staggerWindows: true, auto: true };
  const mk = (name, extra) => ({ name, creds: { expiresAt: Date.now() + 3600e3 }, usage: {}, broken: null, exhaustedUntil: 0, samples: [], ...extra });
  const now = Date.now();
  await test('burn rate: fast usage counts as running out before the threshold', async () => {
    const a = mk('main', { usage: { h5: 80, h5Reset: now + 3 * 3600e3 }, samples: [{ t: now - 20 * 60e3, h5: 40 }, { t: now, h5: 80 }] });
    // 40% in 20 min = 2%/min -> 20% left = 10 min < 15
    assert.ok(Math.abs(r.minutesLeft(a) - 10) < 0.5, String(r.minutesLeft(a)));
    assert.strictEqual(r.burningOut(a), true);
    assert.strictEqual(r.usable(a), false);
    assert.ok(/current pace/.test(r.reasonFor(a)));
  });
  await test('burn rate: slow usage or a reset coming first does not switch', async () => {
    const slow = mk('main', { usage: { h5: 80, h5Reset: now + 3 * 3600e3 }, samples: [{ t: now - 20 * 60e3, h5: 78 }, { t: now, h5: 80 }] });
    assert.strictEqual(r.burningOut(slow), false);
    const resetsSoon = mk('main', { usage: { h5: 80, h5Reset: now + 5 * 60e3 }, samples: [{ t: now - 20 * 60e3, h5: 40 }, { t: now, h5: 80 }] });
    assert.strictEqual(r.burningOut(resetsSoon), false);
    const tooFew = mk('main', { usage: { h5: 80 }, samples: [{ t: now - 60e3, h5: 70 }, { t: now, h5: 80 }] });
    assert.strictEqual(r.minutesLeft(tooFew), null);
  });
  await test('staggered windows: second account starts 5h / 2 after the first', async () => {
    const main = mk('main', { usage: { h5Reset: now + 4 * 3600e3, at: now } });   // started 1h ago
    const backup = mk('backup', { usage: { h5Reset: null, at: now } });
    r.acc = new Map([['main', main], ['backup', backup]]);
    const at = r.nextWindowAt(backup);
    assert.ok(Math.abs(at - (now + 1.5 * 3600e3)) < 5000, new Date(at).toISOString());
    r.cfg.staggerWindows = false;
    assert.ok(r.nextWindowAt(backup) <= Date.now());
    assert.strictEqual(r.nextWindowAt(main), null, 'main has a running window');
  });

  relay.kill();
  server.close();
  console.log('\n' + results.join('\n'));
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
