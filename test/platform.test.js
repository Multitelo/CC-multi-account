'use strict';
// macOS / Linux code paths, exercised on any OS by pretending to be that OS.
// Everything happens in a throwaway home folder.
//   node test/platform.test.js linux|darwin
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const target = process.argv[2] || 'linux';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `cc-${target}-`));
Object.defineProperty(process, 'platform', { value: target });
process.env.HOME = process.env.USERPROFILE = ROOT;
process.env.XDG_CONFIG_HOME = path.join(ROOT, '.config');
process.env.CC_HOME = path.join(ROOT, '.cc');
process.env.CC_CLAUDE_DIR = path.join(ROOT, '.claude');
process.env.CC_NO_TOAST = '1';
process.env.PATH = '';              // no systemctl / launchctl / security on the way
const FAKE_PORT = 47995;
process.env.CC_TOKEN_URL = `http://127.0.0.1:${FAKE_PORT}/token`;
process.env.CC_UPSTREAM = `http://127.0.0.1:${FAKE_PORT}`;

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(`PASS  [${target}] ${name}`); } catch (e) { results.push(`FAIL  [${target}] ${name}: ${e.message}`); }
}

(async () => {
  const OS = require('../lib/platform');

  await test('command is ccm and messages say ccm', async () => {
    assert.strictEqual(OS.CMD, 'ccm');
    assert.strictEqual(OS.say('run "cc login main" or cc --resume'), 'run "ccm login main" or ccm --resume');
    assert.strictEqual(OS.say('cc relay: missing key'), 'cc relay: missing key', 'product name untouched');
  });

  await test('VS Code settings path', async () => {
    const want = target === 'darwin'
      ? path.join(ROOT, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
      : path.join(ROOT, '.config', 'Code', 'User', 'settings.json');
    assert.strictEqual(OS.vscodeSettings(), want);
  });

  if (target === 'linux') {
    await test('logins are AES-encrypted with a key file, and round-trip', async () => {
      const S = require('../lib/store');
      S.saveCredsSync('main', { accessToken: 'a', refreshToken: 'secret-refresh', expiresAt: 1 });
      const raw = fs.readFileSync(path.join(ROOT, '.cc', 'accounts', 'main.dat'), 'utf8');
      assert.ok(raw.startsWith('ccv1:') && !raw.includes('secret-refresh'));
      assert.strictEqual(S.loadCredsSync('main').refreshToken, 'secret-refresh');
      assert.strictEqual((await S.loadCreds('main')).refreshToken, 'secret-refresh');
      assert.ok(fs.existsSync(path.join(ROOT, '.cc', 'master.key')));
    });
  } else {
    await test('macOS keeps the key in the Keychain (fails clearly without `security`)', async () => {
      const S = require('../lib/store');
      assert.throws(() => S.saveCredsSync('main', { refreshToken: 'x' }), /Keychain/);
    });
  }

  await test('install: shim, start at login, status line, VS Code', async () => {
    const S = require('../lib/store');
    const cfg = S.loadConfig();
    fs.mkdirSync(path.dirname(OS.vscodeSettings()), { recursive: true });
    fs.writeFileSync(OS.vscodeSettings(), '{"editor.fontSize": 14}');
    const { parts } = require('../lib/install');
    for (const p of Object.values(parts)) p.add(cfg);
    for (const [k, p] of Object.entries(parts)) assert.ok(p.check(), `${k} installed`);
    const shim = fs.readFileSync(path.join(ROOT, '.local', 'bin', 'ccm'), 'utf8');
    assert.ok(shim.startsWith('#!/bin/sh') && shim.includes(process.execPath));
    if (target === 'darwin') {
      const plist = fs.readFileSync(path.join(ROOT, 'Library', 'LaunchAgents', 'com.cc-multi-account.relay.plist'), 'utf8');
      assert.ok(plist.includes('<string>serve</string>') && plist.includes('RunAtLoad'));
    } else {
      const desk = fs.readFileSync(path.join(ROOT, '.config', 'autostart', 'cc-relay.desktop'), 'utf8');
      assert.ok(desk.includes('serve'), 'no systemd here, so XDG autostart');
    }
    const vs = JSON.parse(fs.readFileSync(OS.vscodeSettings(), 'utf8'));
    assert.strictEqual(vs['editor.fontSize'], 14, 'other settings kept');
    assert.ok(vs['claudeCode.environmentVariables'].some(e => e.name === 'ANTHROPIC_BASE_URL'));
    const cs = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
    assert.ok(cs.statusLine.command.includes(process.execPath));
    for (const p of Object.values(parts)) p.remove();
    for (const [k, p] of Object.entries(parts)) assert.ok(!p.check(), `${k} removed`);
  });

  await test('browser sign-in: callback, state check, code exchange', async () => {
    let tokenBody;
    const fake = http.createServer((req, res) => {
      let b = '';
      req.on('data', c => { b += c; });
      req.on('end', () => {
        tokenBody = JSON.parse(b);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600, scope: 'user:inference user:profile' }));
      });
    });
    await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
    // Play the browser: follow the authorize URL's redirect back with a code.
    OS.openBrowser = async url => {
      const u = new URL(url);
      const back = new URL(u.searchParams.get('redirect_uri'));
      const wrong = await fetch(`http://127.0.0.1:${back.port}/callback?code=evil&state=wrong`);
      assert.strictEqual(wrong.status, 400, 'wrong state rejected');
      const ok = await fetch(`http://127.0.0.1:${back.port}/callback?code=good-code&state=${u.searchParams.get('state')}`);
      assert.strictEqual(ok.status, 200);
    };
    delete require.cache[require.resolve('../lib/signin')];
    const log = console.log; console.log = () => {};
    let creds;
    try { creds = await require('../lib/signin').signIn({}); } finally { console.log = log; fake.close(); }
    assert.strictEqual(creds.refreshToken, 'ref');
    assert.deepStrictEqual(creds.scopes, ['user:inference', 'user:profile']);
    assert.strictEqual(tokenBody.grant_type, 'authorization_code');
    assert.strictEqual(tokenBody.code, 'good-code');
    assert.ok(tokenBody.code_verifier && tokenBody.redirect_uri.startsWith('http://localhost:'));
  });

  console.log(results.join('\n'));
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exitCode = results.some(r => r.startsWith('FAIL')) ? 1 : 0;
})();
