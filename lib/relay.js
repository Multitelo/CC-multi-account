'use strict';
// The relay: a local HTTP server that Claude Code talks to instead of
// api.anthropic.com. For every request it picks an account, puts that
// account's token on the request and forwards it. It is the ONLY thing that
// refreshes these accounts' tokens, so no other program can invalidate them.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');
const S = require('./store');
const A = require('./anthropic');
const H = require('./history');
const { notify } = require('./notify');
const { sessionCwd, pinFor } = require('./sessions');
const { say } = require('./platform');

const REFRESH_MARGIN = 5 * 60 * 1000;
const TICK_MS = 30 * 1000;
const SNAPSHOT_EVERY = 15 * 60 * 1000;
const BURN_WINDOW = 30 * 60 * 1000;
const WINDOW_MS = 5 * 3600 * 1000;
const STATUS_EVERY = 5 * 60 * 1000;
const STATUS_URL = process.env.CC_STATUS_URL || 'https://status.claude.com/api/v2/summary.json';
const DROP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'authorization', 'x-api-key', 'content-length',
  'transfer-encoding', 'proxy-authorization', 'proxy-connection', 'te', 'upgrade',
]);

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function apiError(message, type = 'api_error') {
  return { type: 'error', error: { type, message: say(message) } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

class Relay {
  constructor() {
    this.cfg = S.loadConfig();
    this.cfgMtime = mtime(P.CONFIG);
    this.active = S.loadState().active || null;
    this.acc = new Map();
    this.lastPoll = 0;
    this.lastSnapshot = 0;
    this.stateTimer = null;
  }

  // ---- accounts ---------------------------------------------------------

  async reload() {
    this.cfg = S.loadConfig();
    this.cfgMtime = mtime(P.CONFIG);
    const onDisk = new Set(S.listAccountFiles());
    const names = this.cfg.order.filter(n => onDisk.has(n));
    for (const n of names) {
      if (!this.acc.has(n)) this.acc.set(n, { name: n, creds: null, mtime: 0, usage: {}, broken: null, exhaustedUntil: 0, refreshing: null, lastUsed: 0 });
      const a = this.acc.get(n);
      const m = mtime(path.join(P.ACCOUNTS, `${n}.dat`));
      if (m === a.mtime) continue; // unchanged since we last read or wrote it
      try {
        a.creds = await S.loadCreds(n);
        a.mtime = m;
        a.broken = null;
        a.exhaustedUntil = 0;
      } catch (e) {
        a.broken = `cannot decrypt login: ${e.message}`;
      }
    }
    for (const n of [...this.acc.keys()]) if (!names.includes(n)) this.acc.delete(n);
    if (!this.active || !this.acc.has(this.active)) this.active = names[0] || null;
    this.writeState();
  }

  markBroken(a, msg) {
    if (a.broken) return;
    a.broken = msg;
    H.append({ type: 'login-broken', account: a.name, msg });
    H.log(`login broken for ${a.name}: ${msg}`);
    if (this.cfg.notify) notify('ccm: a login needs attention', `${a.name}: sign in again with "cc login ${a.name}".`);
    this.writeState();
  }

  async getToken(a, force = false) {
    if (!a.creds) throw new Error(a.broken || 'no login stored');
    if (a.broken && !force) throw new Error(a.broken);
    if (!force && a.creds.expiresAt - Date.now() > REFRESH_MARGIN) return a.creds.accessToken;
    if (!a.refreshing) {
      a.refreshing = (async () => {
        try {
          const next = await A.refresh(a.creds);
          a.creds = next; // keep the new chain in memory even if saving fails
          a.broken = null;
          try {
            await S.saveCreds(a.name, next);
            a.mtime = mtime(path.join(P.ACCOUNTS, `${a.name}.dat`));
          } catch (e) {
            H.log(`could not save refreshed login for ${a.name}: ${e.message}`);
            if (this.cfg.notify) notify('ccm: could not save a login', `${a.name}: ${e.message}`);
          }
          H.log(`refreshed token for ${a.name}`);
        } catch (e) {
          if (e.fatal) this.markBroken(a, e.message);
          throw e;
        } finally {
          a.refreshing = null;
        }
      })();
    }
    await a.refreshing;
    return a.creds.accessToken;
  }

  // ---- choosing an account ---------------------------------------------

  current(a) {
    const u = a.usage, now = Date.now();
    return {
      h5: u.h5Reset && u.h5Reset < now ? 0 : (u.h5 ?? 0),
      d7: u.d7Reset && u.d7Reset < now ? 0 : (u.d7 ?? 0),
    };
  }

  alive(a) {
    return !!a.creds && !a.broken && a.exhaustedUntil <= Date.now();
  }

  usable(a) {
    if (!this.alive(a)) return false;
    const { h5, d7 } = this.current(a);
    if (h5 >= this.cfg.threshold5h || d7 >= this.cfg.threshold7d) return false;
    return !this.burningOut(a);
  }

  // ---- burn rate ---------------------------------------------------------

  addSample(a) {
    const now = Date.now(), h5 = a.usage.h5;
    if (h5 === null || h5 === undefined) return;
    a.samples = (a.samples || []).filter(s => now - s.t < BURN_WINDOW);
    const last = a.samples[a.samples.length - 1];
    if (last && h5 < last.h5) a.samples = [];            // a new window started
    a.samples.push({ t: now, h5 });
  }

  // Minutes until the 5-hour limit at the pace of the last half hour, or null
  // when there is not enough data or usage is not rising.
  minutesLeft(a) {
    const s = (a.samples || []).filter(x => Date.now() - x.t < BURN_WINDOW);
    if (s.length < 2) return null;
    const first = s[0], last = s[s.length - 1];
    const mins = (last.t - first.t) / 60000;
    const rate = (last.h5 - first.h5) / mins;            // % per minute
    if (mins < 5 || rate <= 0) return null;
    return Math.max(0, (100 - this.current(a).h5) / rate);
  }

  burningOut(a) {
    if (!this.cfg.burnAware) return false;
    const left = this.minutesLeft(a);
    if (left === null || left >= this.cfg.burnMinutes) return false;
    const toReset = a.usage.h5Reset ? (a.usage.h5Reset - Date.now()) / 60000 : Infinity;
    return left < toReset;                                // would run out before it resets
  }

  headroom(a) {
    const { h5, d7 } = this.current(a);
    return Math.min((this.cfg.threshold5h - h5) / this.cfg.threshold5h, (this.cfg.threshold7d - d7) / this.cfg.threshold7d);
  }

  reasonFor(a) {
    if (!a) return 'starting up';
    if (a.broken) return 'its login stopped working';
    if (a.exhaustedUntil > Date.now()) return 'it hit its usage limit';
    const { h5, d7 } = this.current(a);
    if (h5 >= this.cfg.threshold5h) return `5-hour usage reached ${Math.round(h5)}%`;
    if (d7 >= this.cfg.threshold7d) return `weekly usage reached ${Math.round(d7)}%`;
    if (this.burningOut(a)) return `at the current pace it would hit the 5-hour limit in about ${Math.round(this.minutesLeft(a))} min`;
    return 'it has less room left';
  }

  chooseAuto(exclude) {
    const act = this.acc.get(this.active);
    const actOk = act && !exclude.has(act.name);
    if (!this.cfg.auto) return actOk ? act.name : null;
    if (actOk && this.usable(act)) return act.name;
    const rest = [...this.acc.values()].filter(a => !exclude.has(a.name));
    const byRoom = (x, y) => this.headroom(y) - this.headroom(x);
    let pick = rest.filter(a => this.usable(a)).sort(byRoom)[0];
    if (!pick) {
      // Everything is past its threshold: keep going on whatever still works
      // rather than refusing; Anthropic decides when the real limit is hit.
      if (actOk && this.alive(act)) return act.name;
      pick = rest.filter(a => this.alive(a)).sort(byRoom)[0];
      if (!pick) return exclude.size === 0 && act && act.creds ? act.name : null;
    }
    if (pick.name !== this.active) this.switchTo(pick.name, this.reasonFor(act));
    return pick.name;
  }

  switchTo(name, reason) {
    const from = this.active;
    if (from === name) return;
    this.active = name;
    H.append({ type: 'switch', from, to: name, reason });
    H.log(`switch ${from} -> ${name}: ${reason}`);
    if (this.cfg.notify && from) notify(`ccm: now using ${name}`, `Switched from ${from} because ${reason}.`);
    this.writeState();
  }

  // ---- forwarding -------------------------------------------------------

  send(req, rest, body, token) {
    return new Promise((resolve, reject) => {
      const u = new URL(rest, P.UPSTREAM);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!DROP_HEADERS.has(k)) headers[k] = v;
      headers.authorization = `Bearer ${token}`;
      const betas = String(headers['anthropic-beta'] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!betas.includes(A.OAUTH_BETA)) betas.push(A.OAUTH_BETA);
      headers['anthropic-beta'] = betas.join(',');
      if (body.length || !['GET', 'HEAD'].includes(req.method)) headers['content-length'] = String(body.length);
      const mod = u.protocol === 'http:' ? http : https;
      const up = mod.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: req.method, headers }, resolve);
      up.on('error', reject);
      up.end(body);
    });
  }

  noteHeaders(a, headers) {
    const info = A.fromHeaders(headers);
    if (!info) return;
    const u = a.usage;
    if (info.h5 !== null) { u.h5 = info.h5; if (info.h5Reset) u.h5Reset = info.h5Reset; }
    if (info.d7 !== null) { u.d7 = info.d7; if (info.d7Reset) u.d7Reset = info.d7Reset; }
    u.at = Date.now();
    u.source = 'live';
    this.addSample(a);
    this.writeState();
  }

  pipe(up, res) {
    const h = { ...up.headers };
    delete h.connection;
    delete h['keep-alive'];
    res.writeHead(up.statusCode, h);
    up.pipe(res);
    res.on('close', () => { if (!up.complete) up.destroy(); });
  }

  async forward(req, res, rest, body, pin) {
    const tried = new Set();
    let held = null; // a 429 kept in case no other account can take over
    for (;;) {
      const name = pin ? (tried.has(pin) ? null : pin) : this.chooseAuto(tried);
      if (!name) break;
      tried.add(name);
      const a = this.acc.get(name);
      let up;
      try {
        up = await this.send(req, rest, body, await this.getToken(a));
        if (up.statusCode === 401) {
          up.resume();
          up = await this.send(req, rest, body, await this.getToken(a, true));
        }
      } catch (e) {
        H.log(`request on ${name} failed: ${e.message}`);
        if (pin || !this.cfg.auto) {
          if (held) held.resume();
          return json(res, 502, apiError(`ccm: request on account "${name}" failed: ${e.message}`));
        }
        continue;
      }
      a.lastUsed = Date.now();
      if (process.env.CC_DEBUG) H.log(`${req.method} ${rest} -> ${name} ${up.statusCode}`);
      this.noteHeaders(a, up.headers);
      const limited = up.statusCode === 429 && up.headers['anthropic-ratelimit-unified-status'] === 'rejected';
      if (limited) {
        const info = A.fromHeaders(up.headers) || {};
        a.exhaustedUntil = info.reset || Date.now() + 15 * 60 * 1000;
        H.append({ type: 'limit', account: name, until: new Date(a.exhaustedUntil).toISOString() });
        H.log(`${name} hit its limit until ${new Date(a.exhaustedUntil).toISOString()}`);
        this.writeState();
        if (!pin && this.cfg.auto) {
          if (held) held.resume();
          held = up;
          continue;
        }
      }
      if (held) held.resume();
      return this.pipe(up, res);
    }
    if (held) return this.pipe(held, res);
    return json(res, 503, apiError('ccm: no account is available. Run "cc status" or "cc doctor".', 'overloaded_error'));
  }

  authorized(req) {
    const auth = req.headers.authorization || '';
    const key = req.headers['x-api-key'] || '';
    return sameSecret(auth, `Bearer ${this.cfg.secret}`) || sameSecret(key, this.cfg.secret);
  }

  async handle(req, res) {
    try {
      const url = req.url || '/';
      if (url === '/health') return json(res, 200, { ok: true, app: 'cc', version: P.VERSION, pid: process.pid });
      if (!this.authorized(req)) return json(res, 401, apiError('ccm relay: missing or wrong local key', 'authentication_error'));
      if (url.startsWith('/_cc/')) return await this.control(req, res, url);
      let pin = null, rest = url;
      const m = /^\/a\/([^/?]+)(\/.*)?$/.exec(url);
      if (m) { pin = decodeURIComponent(m[1]); rest = m[2] || '/'; }
      if (!pin) pin = pinFor(sessionCwd(req.headers['x-claude-code-session-id']), this.cfg.pins);
      if (pin && !this.acc.has(pin)) return json(res, 400, apiError(`ccm: there is no account named "${pin}"`, 'invalid_request_error'));
      const body = await readBody(req);
      await this.forward(req, res, rest, body, pin);
    } catch (e) {
      H.log(`error: ${e.stack || e.message}`);
      if (!res.headersSent) json(res, 502, apiError(`ccm relay: ${e.message}`));
      else res.destroy();
    }
  }

  async control(req, res, url) {
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const data = body.length ? JSON.parse(body.toString('utf8')) : {};
    switch (url) {
      case '/_cc/status': return json(res, 200, this.snapshot());
      case '/_cc/reload': await this.reload(); return json(res, 200, this.snapshot());
      case '/_cc/poll': await this.poll(); return json(res, 200, this.snapshot());
      case '/_cc/use': {
        const a = this.acc.get(data.name);
        if (!a) return json(res, 400, { error: `no account named "${data.name}"` });
        a.exhaustedUntil = 0;
        this.switchTo(a.name, 'you chose it');
        return json(res, 200, this.snapshot());
      }
      case '/_cc/stop':
        json(res, 200, { ok: true });
        H.log('stop requested');
        return setTimeout(() => process.exit(0), 100);
      default: return json(res, 404, { error: 'unknown control path' });
    }
  }

  // ---- state, polling ---------------------------------------------------

  snapshot() {
    return {
      app: 'cc', version: P.VERSION, pid: process.pid, port: this.cfg.port,
      active: this.active, auto: this.cfg.auto,
      threshold5h: this.cfg.threshold5h, threshold7d: this.cfg.threshold7d,
      updatedAt: new Date().toISOString(),
      accounts: [...this.acc.values()].map(a => {
        const cur = this.current(a);
        return {
          name: a.name,
          email: (this.cfg.accounts[a.name] || {}).email || null,
          plan: (a.creds && a.creds.subscriptionType) || (this.cfg.accounts[a.name] || {}).plan || null,
          h5: a.usage.h5 === undefined ? null : cur.h5,
          d7: a.usage.d7 === undefined ? null : cur.d7,
          h5Reset: a.usage.h5Reset || null,
          d7Reset: a.usage.d7Reset || null,
          usageAt: a.usage.at || null,
          usageSource: a.usage.source || null,
          pollError: a.pollError || null,
          broken: a.broken,
          exhaustedUntil: a.exhaustedUntil > Date.now() ? a.exhaustedUntil : null,
          lastUsed: a.lastUsed || null,
          tokenExpiresAt: a.creds ? a.creds.expiresAt : null,
          minutesLeft: this.minutesLeft(a),
          burningOut: this.burningOut(a),
          nextWindowAt: a.creds && !a.broken ? this.nextWindowAt(a) : null,
        };
      }),
      anthropic: this.anthropic || null,
    };
  }

  writeState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      try { S.saveState(this.snapshot()); } catch (e) { H.log(`state write failed: ${e.message}`); }
    }, 300);
  }

  async poll() {
    this.lastPoll = Date.now();
    for (const a of this.acc.values()) {
      if (!a.creds || a.broken) continue;
      try {
        let u;
        try {
          u = await A.usage(await this.getToken(a));
        } catch (e) {
          if (e.status !== 401) throw e;
          u = await A.usage(await this.getToken(a, true));
        }
        if (u.h5) { a.usage.h5 = u.h5.pct; a.usage.h5Reset = u.h5.resetsAt; }
        if (u.d7) { a.usage.d7 = u.d7.pct; a.usage.d7Reset = u.d7.resetsAt; }
        a.usage.at = Date.now();
        a.usage.source = 'poll';
        a.pollError = null;
        this.addSample(a);
      } catch (e) {
        a.pollError = e.message;
        H.log(`usage check for ${a.name} failed: ${e.message}`);
      }
    }
    if (Date.now() - this.lastSnapshot >= SNAPSHOT_EVERY) {
      this.lastSnapshot = Date.now();
      const accounts = {};
      for (const a of this.acc.values()) accounts[a.name] = { h5: a.usage.h5 ?? null, d7: a.usage.d7 ?? null };
      H.append({ type: 'usage', active: this.active, accounts });
    }
    if (this.cfg.auto && this.acc.size) this.chooseAuto(new Set());
    this.writeState();
  }

  async tick() {
    if (mtime(P.CONFIG) !== this.cfgMtime) await this.reload();
    else {
      // pick up a re-login done by "cc login" while we were running
      for (const a of this.acc.values()) {
        if (mtime(path.join(P.ACCOUNTS, `${a.name}.dat`)) !== a.mtime) { await this.reload(); break; }
      }
    }
    if (Date.now() - this.lastPoll >= this.cfg.pollSeconds * 1000) await this.poll();
    await this.startWindows();
    if (!this.statusAt || Date.now() - this.statusAt >= STATUS_EVERY) await this.fetchStatus();
  }

  // Anthropic's public status page (no account involved).
  async fetchStatus() {
    this.statusAt = Date.now();
    try {
      const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      this.anthropic = {
        at: Date.now(),
        indicator: j.status && j.status.indicator || 'unknown',
        description: j.status && j.status.description || '',
        components: (j.components || []).filter(c => !c.group).map(c => ({ name: c.name, status: c.status })),
        incidents: (j.incidents || []).map(i => {
          const u = (i.incident_updates || [])[0] || {};
          return { name: i.name, status: i.status, impact: i.impact, updatedAt: i.updated_at, latest: u.body || '' };
        }),
      };
    } catch (e) {
      this.anthropic = { ...(this.anthropic || {}), error: e.message, at: Date.now() };
    }
    this.writeState();
  }

  // The 5-hour window only starts counting at an account's first message.
  // When an account has no window running, send it a 1-token message so a
  // new window starts right away and resets sooner.
  //
  // Staggered: account N in the order waits until 5h / accounts after the
  // window of the account before it started, so resets are spread out and one
  // account is always close to a fresh window. The first account starts at once.
  windowRunning(a) {
    return !!(a.usage.h5Reset && a.usage.h5Reset > Date.now());
  }

  nextWindowAt(a) {
    if (!this.cfg.startWindow || this.windowRunning(a)) return null;
    if (!this.cfg.staggerWindows) return Date.now();
    const list = [...this.acc.values()].filter(x => x.creds && !x.broken);
    const i = list.indexOf(a);
    if (i <= 0) return Date.now();
    const prev = list[i - 1];
    if (!this.windowRunning(prev)) return Date.now();
    const prevStart = prev.usage.h5Reset - WINDOW_MS;
    return prevStart + WINDOW_MS / list.length;
  }

  async startWindows() {
    if (!this.cfg.startWindow) return;
    const now = Date.now();
    for (const a of this.acc.values()) {
      if (!a.creds || a.broken || !a.usage.at) continue;           // usage not known yet
      if (this.windowRunning(a)) continue;
      const at = this.nextWindowAt(a);
      if (at === null || at > now) continue;                       // staggered: not its turn yet
      if (a.windowTriedAt && now - a.windowTriedAt < 5 * 60 * 1000) continue;
      a.windowTriedAt = now;
      try {
        const r = await A.ping(await this.getToken(a));
        this.noteHeaders(a, r.headers);
        if (!a.usage.h5Reset || a.usage.h5Reset <= now) a.usage.h5Reset = now + 5 * 3600 * 1000;
        H.append({ type: 'window', account: a.name, until: new Date(a.usage.h5Reset).toISOString() });
        H.log(`started the 5-hour window for ${a.name}`);
        this.writeState();
      } catch (e) {
        H.log(`could not start the 5-hour window for ${a.name}: ${e.message}`);
      }
    }
  }

  async start() {
    await this.reload();
    const server = http.createServer((q, s) => { this.handle(q, s); });
    server.requestTimeout = 0;
    server.timeout = 0;
    server.keepAliveTimeout = 65000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.port, '127.0.0.1', resolve);
    });
    H.log(`relay ${P.VERSION} listening on 127.0.0.1:${this.cfg.port} (pid ${process.pid}, ${this.acc.size} accounts)`);
    this.poll().then(() => this.startWindows()).catch(e => H.log(`poll failed: ${e.message}`));
    this.fetchStatus();
    const loop = () => setTimeout(() => this.tick().catch(e => H.log(`tick failed: ${e.message}`)).finally(loop), TICK_MS);
    loop();
    return server;
  }
}

async function runRelay() {
  process.on('unhandledRejection', e => H.log(`unhandled rejection: ${e && e.stack || e}`));
  process.on('uncaughtException', e => { H.log(`crash: ${e && e.stack || e}`); process.exit(1); });
  const relay = new Relay();
  try {
    await relay.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      H.log(`port ${relay.cfg.port} is already in use`);
      process.exit(3);
    }
    throw e;
  }
}

module.exports = { Relay, runRelay };
