'use strict';
// Browser sign-in (OAuth with PKCE), the same flow Claude Code uses. On
// Windows cc normally lets Claude Code do the sign-in instead; this is used on
// macOS and Linux, where Claude Code keeps its login in the system keychain.
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const A = require('./anthropic');
const P = require('./paths');
const { openBrowser } = require('./platform');

const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const MANUAL_REDIRECT = 'https://platform.claude.com/oauth/code/callback';
const SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'];

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function authorizeUrl({ redirect, challenge, state, email }) {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.append('code', 'true');
  u.searchParams.append('client_id', A.CLIENT_ID);
  u.searchParams.append('response_type', 'code');
  u.searchParams.append('redirect_uri', redirect);
  u.searchParams.append('scope', SCOPES.join(' '));
  u.searchParams.append('code_challenge', challenge);
  u.searchParams.append('code_challenge_method', 'S256');
  u.searchParams.append('state', state);
  if (email) u.searchParams.append('login_hint', email);
  return u.toString();
}

async function exchange({ code, redirect, verifier, state }) {
  const r = await fetch(P.TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: A.CLIENT_ID, code_verifier: verifier, state }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`sign-in was not accepted (${r.status}): ${text.slice(0, 200)}`);
  const d = JSON.parse(text);
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000,
    scopes: d.scope ? d.scope.split(' ') : SCOPES,
  };
}

// Local server the browser comes back to: http://localhost:<port>/callback.
// Resolves once it is listening; `code` resolves when the browser returns.
function callbackServer(state) {
  return new Promise((ready, fail) => {
    const servers = [];
    let gotCode;
    const code = new Promise(resolve => { gotCode = resolve; });
    const close = () => servers.forEach(s => s.close());
    const handler = (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const c = u.searchParams.get('code');
      const ok = !!c && u.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>cc</title><body style="font:16px system-ui;padding:3em">${ok
        ? '<h2>Signed in to cc.</h2><p>You can close this tab and go back to the terminal.</p>'
        : '<h2>Sign-in failed.</h2><p>The response did not match. Try again from the terminal.</p>'}</body>`);
      if (ok) gotCode(c);
    };
    const v4 = http.createServer(handler);
    v4.once('error', fail);
    v4.listen(0, '127.0.0.1', () => {
      servers.push(v4);
      const port = v4.address().port;
      // Browsers may resolve "localhost" to ::1 first.
      const v6 = http.createServer(handler);
      v6.once('error', () => ready({ port, code, close }));
      v6.listen(port, '::1', () => { servers.push(v6); ready({ port, code, close }); });
    });
  });
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, a => { rl.close(); resolve(a.trim()); });
  });
}

async function signIn({ email, manual } = {}) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(32));

  if (manual) {
    const url = authorizeUrl({ redirect: MANUAL_REDIRECT, challenge, state, email });
    console.log(`Open this link in a browser (on any device), sign in, and approve:\n\n  ${url}\n`);
    const pasted = await ask('Paste the code shown after approving: ');
    const [code, st] = pasted.split('#');
    if (!code) throw new Error('no code was pasted');
    if (st && st !== state) throw new Error('that code belongs to a different sign-in attempt');
    return exchange({ code, redirect: MANUAL_REDIRECT, verifier, state });
  }

  const cb = await callbackServer(state);
  const redirect = `http://localhost:${cb.port}/callback`;
  const url = authorizeUrl({ redirect, challenge, state, email });
  console.log(`Opening your browser to sign in. If it doesn't open, visit:\n\n  ${url}\n`);
  console.log('(No browser on this machine? Cancel with Ctrl+C and use --manual.)\n');
  openBrowser(url);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('sign-in timed out after 5 minutes')), 5 * 60 * 1000); });
  try {
    const code = await Promise.race([cb.code, timeout]);
    return await exchange({ code, redirect, verifier, state });
  } finally {
    clearTimeout(timer);
    cb.close();
  }
}

module.exports = { signIn, authorizeUrl, SCOPES };
