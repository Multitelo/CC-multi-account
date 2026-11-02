'use strict';
// The few Anthropic calls cc makes itself: token refresh, usage, profile.
const P = require('./paths');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's OAuth client
const OAUTH_BETA = 'oauth-2025-04-20';

async function refresh(creds) {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: CLIENT_ID,
  };
  if (creds.scopes && creds.scopes.length) body.scope = creds.scopes.join(' ');
  const r = await fetch(P.TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`token refresh failed (${r.status}): ${text.slice(0, 200)}`);
    // invalid_grant means the refresh token is dead: only a new login fixes it.
    err.fatal = r.status === 400 || r.status === 401 || /invalid_grant/.test(text);
    throw err;
  }
  const d = JSON.parse(text);
  return {
    ...creds,
    accessToken: d.access_token,
    refreshToken: d.refresh_token || creds.refreshToken,
    expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000,
    scopes: d.scope ? d.scope.split(' ') : creds.scopes,
  };
}

async function apiGet(pathname, token) {
  const r = await fetch(P.UPSTREAM + pathname, {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`${pathname} returned ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return JSON.parse(text);
}

function window(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.utilization);
  return {
    pct: Number.isFinite(pct) ? pct : null,
    resetsAt: w.resets_at ? Date.parse(w.resets_at) || null : null,
  };
}

async function usage(token) {
  const d = await apiGet('/api/oauth/usage', token);
  return { h5: window(d.five_hour), d7: window(d.seven_day) };
}

async function profile(token) {
  const d = await apiGet('/api/oauth/profile', token);
  return {
    uuid: d.account && d.account.uuid || null,
    email: d.account && (d.account.email_address || d.account.email) || null,
    org: d.organization && (d.organization.name || d.organization.uuid) || null,
    plan: d.account && d.account.has_claude_max ? 'max' : d.account && d.account.has_claude_pro ? 'pro'
      : d.organization && d.organization.organization_type ? String(d.organization.organization_type).replace(/^claude_/, '') : null,
  };
}

// Smallest possible message: 1 output token. Used to start a 5-hour window.
async function ping(token) {
  const models = ['claude-haiku-5-5', 'claude-haiku-4-5'];
  let last;
  for (const model of models) {
    const r = await fetch(P.UPSTREAM + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': `${OAUTH_BETA},claude-code-20250219`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model, max_tokens: 1,
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    if (r.ok) return { headers: Object.fromEntries(r.headers.entries()) };
    last = new Error(`message returned ${r.status}: ${text.slice(0, 200)}`);
    if (r.status !== 404 && r.status !== 400) break;
  }
  throw last;
}

// Rate-limit headers on /v1 responses. Utilization arrives as a 0..1 fraction.
function fromHeaders(h) {
  const num = k => { const v = Number(h[k]); return Number.isFinite(v) ? v : null; };
  const pct = v => v === null ? null : (v <= 1 ? v * 100 : v);
  const at = v => v === null ? null : v * 1000;
  const out = {
    status: h['anthropic-ratelimit-unified-status'] || null,
    h5: pct(num('anthropic-ratelimit-unified-5h-utilization')),
    h5Reset: at(num('anthropic-ratelimit-unified-5h-reset')),
    d7: pct(num('anthropic-ratelimit-unified-7d-utilization')),
    d7Reset: at(num('anthropic-ratelimit-unified-7d-reset')),
    reset: at(num('anthropic-ratelimit-unified-reset')),
  };
  return out.status || out.h5 !== null || out.d7 !== null ? out : null;
}

module.exports = { CLIENT_ID, OAUTH_BETA, refresh, usage, profile, ping, fromHeaders };
