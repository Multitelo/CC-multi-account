'use strict';
// Full-screen dashboard shown by `cc` with no arguments. Plain ANSI, no
// dependencies. All actions go through the `api` object cc.js passes in.
const readline = require('readline');
const path = require('path');
const H = require('./history');
const P = require('./paths');
const { norm, pinFor } = require('./sessions');

const ESC = '\x1b[';
const C = {
  r: ESC + '0m', b: ESC + '1m', ul: ESC + '4m',
  accent: ESC + '38;5;209m', green: ESC + '38;5;114m', yellow: ESC + '38;5;221m',
  red: ESC + '38;5;203m', blue: ESC + '38;5;75m', gray: ESC + '38;5;244m',
  text: ESC + '38;5;252m', empty: ESC + '38;5;238m', line: ESC + '38;5;240m',
};
const TABS = ['overview', 'history', 'pins', 'settings', 'status'];
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const vlen = s => s.replace(ANSI, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - vlen(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - vlen(s))) + s;

function clip(s, n) {
  let out = '', v = 0, m;
  const re = /(\x1b\[[0-9;?]*[A-Za-z])|([\s\S])/g;
  while ((m = re.exec(s))) {
    if (m[1]) { out += m[1]; continue; }
    if (v >= n) break;
    out += m[2];
    v++;
  }
  return out + C.r;
}

function dur(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}
const until = ms => ms ? dur((ms - Date.now()) / 1000) : '';
const age = ms => ms ? dur((Date.now() - ms) / 1000) : '-';

function bar(p, w, limit) {
  if (p === null || p === undefined) return C.empty + ' ' + '·'.repeat(w) + ' ' + C.r;
  const f = Math.max(0, Math.min(w, Math.round(p / 100 * w)));
  const col = p >= limit ? C.red : p >= limit * 0.75 ? C.yellow : C.green;
  return C.line + '[' + col + '█'.repeat(f) + C.empty + '░'.repeat(w - f) + C.line + ']' + C.r;
}

function pctText(p, limit) {
  if (p === null || p === undefined) return C.gray + '  -' + C.r;
  const col = p >= limit ? C.red : p >= limit * 0.75 ? C.yellow : C.text;
  return col + padL(`${Math.round(p)}%`, 4) + C.r;
}

function box(title, body, w, h) {
  const t = ` ${title} `;
  const lines = [C.line + '╭─' + C.accent + C.b + t + C.r + C.line + '─'.repeat(Math.max(0, w - 3 - t.length)) + '╮' + C.r];
  for (let i = 0; i < h - 2; i++) {
    lines.push(C.line + '│' + C.r + ' ' + pad(clip(body[i] || '', w - 4), w - 4) + ' ' + C.line + '│' + C.r);
  }
  lines.push(C.line + '╰' + '─'.repeat(w - 2) + '╯' + C.r);
  return lines;
}

function run(api) {
  const out = process.stdout;
  const ui = {
    tab: 0, sel: 0, pinSel: 0, setSel: 0,
    cfg: api.loadConfig(), st: { live: false, accounts: [] },
    msg: '', msgErr: false, msgAt: 0,
    input: null, confirm: null, busy: false, timer: null, closed: false,
  };

  const accounts = () => ui.st.accounts || [];
  const selected = () => accounts()[Math.min(ui.sel, accounts().length - 1)];
  const flash = (msg, err = false) => { ui.msg = msg; ui.msgErr = err; ui.msgAt = Date.now(); };

  async function refresh(force) {
    if (ui.busy && !force) return;
    ui.busy = true;
    try {
      ui.cfg = api.loadConfig();
      const st = await api.status(ui.cfg);
      // keep the configured order
      st.accounts = (st.accounts || []).slice().sort((a, b) => ui.cfg.order.indexOf(a.name) - ui.cfg.order.indexOf(b.name));
      ui.st = st;
    } catch {}
    ui.busy = false;
    render();
  }

  async function act(fn, okMsg) {
    try {
      await fn();
      if (okMsg) flash(okMsg);
    } catch (e) { flash(e.message, true); }
    await refresh(true);
  }

  // ---- screen ------------------------------------------------------------

  function enter() {
    out.write('\x1b[?1049h\x1b[?25l');
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('keypress', onKey);
    process.stdin.resume();
    out.on('resize', render);
    ui.timer = setInterval(() => refresh(), 2000);
  }

  function leave() {
    clearInterval(ui.timer);
    process.stdin.off('keypress', onKey);
    out.off('resize', render);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    out.write('\x1b[?25h\x1b[?1049l');
  }

  function quit() {
    ui.closed = true;
    leave();
    process.exit(0);
  }

  // Leave the dashboard to run something interactive (a browser sign-in).
  async function suspend(fn) {
    leave();
    try { await fn(); } catch (e) { console.error(`\ncc: ${e.message}`); }
    await new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: out });
      rl.question('\nPress Enter to go back to the dashboard. ', () => { rl.close(); resolve(); });
    });
    enter();
    await refresh(true);
  }

  // ---- drawing -----------------------------------------------------------

  function header(W) {
    const st = ui.st, cfg = ui.cfg;
    const relay = st.live ? `${C.green}●${C.r} ${C.text}relay running${C.r}`
      : ui.cfg.order.length ? `${C.red}●${C.r} ${C.red}relay off${C.r}` : `${C.gray}● relay idle (no accounts)${C.r}`;
    const an = st.anthropic;
    const anCol = !an || !an.indicator || an.error ? C.gray : an.indicator === 'none' ? C.green : an.indicator === 'minor' ? C.yellow : C.red;
    const anText = !an ? 'status unknown' : an.error && !an.description ? 'status unavailable' : an.description;
    const right1 = `${anCol}●${C.r} ${C.gray}${anText}  v${P.VERSION}${C.r}`;
    const left1 = ` ${C.accent}${C.b}▞▚ ccm${C.r}  ${relay}`;
    const auto = cfg.auto
      ? `${C.green}auto-switch on${C.r}${C.gray} · at 5h ${cfg.threshold5h}% / week ${cfg.threshold7d}%${C.r}`
      : `${C.yellow}auto-switch off${C.r}`;
    const left2 = ` ${C.gray}${accounts().length} account${accounts().length === 1 ? '' : 's'}${C.r}  ${auto}`;
    const right2 = st.active ? `${C.gray}using${C.r} ${C.accent}${C.b}${st.active}${C.r}` : '';
    const tabs = ' ' + TABS.map((t, i) => i === ui.tab ? `${C.blue}${C.b}${C.ul}${t}${C.r}` : `${C.text}${t}${C.r}`).join('   ');
    return [
      pad(left1, W - vlen(right1) - 1) + right1,
      pad(left2, W - vlen(right2) - 1) + right2,
      tabs,
    ];
  }

  function overview(W, h) {
    const cfg = ui.cfg, list = accounts();
    const nameW = Math.max(8, ...list.map(a => a.name.length)) + 1;
    const showEmail = W >= 118;
    const emailW = showEmail ? Math.min(26, Math.max(6, ...list.map(a => (a.email || '').length)) + 1) : 0;
    const bw = W >= 100 ? 12 : 8;
    const rows = [];
    rows.push(C.gray + '  ' + pad('account', nameW) + (showEmail ? pad('email', emailW) : '') + pad('plan', 6)
      + pad('5-hour', bw + 3 + 5 + 9) + pad('week', bw + 3 + 5 + 9) + pad('updated', 9) + 'state' + C.r);
    if (!list.length) {
      rows.push('', `  ${C.text}No accounts yet.${C.r} Press ${C.blue}n${C.r} to sign one in (a browser window opens).`);
    }
    list.forEach((a, i) => {
      const sel = i === ui.sel;
      const active = a.name === ui.st.active;
      const mark = sel ? `${C.accent}❯${C.r}` : ' ';
      const dot = active ? `${C.accent}●${C.r}` : ' ';
      const name = active ? `${C.accent}${C.b}${a.name}${C.r}` : sel ? `${C.b}${a.name}${C.r}` : `${C.text}${a.name}${C.r}`;
      let state;
      if (a.broken) state = `${C.red}login broken${C.r}`;
      else if (a.exhaustedUntil) state = `${C.red}limit, back in ${until(a.exhaustedUntil)}${C.r}`;
      else if (a.burningOut) state = `${C.yellow}out in ~${Math.round(a.minutesLeft)}m at this pace${C.r}`;
      else if (active) state = `${C.accent}active${C.r}`;
      else state = `${C.gray}ready${C.r}`;
      if (!a.broken && a.minutesLeft !== null && a.minutesLeft !== undefined && !a.burningOut && a.minutesLeft < 180) {
        state += `${C.gray} · ~${dur(a.minutesLeft * 60)} left${C.r}`;
      }
      if (a.nextWindowAt && a.nextWindowAt > Date.now()) {
        state += `${C.gray} · window starts ${new Date(a.nextWindowAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${C.r}`;
      }
      const pinned = Object.values(cfg.pins).filter(n => n === a.name).length;
      if (pinned) state += `${C.gray} · ${pinned} pin${pinned > 1 ? 's' : ''}${C.r}`;
      rows.push(mark + dot + pad(name, nameW)
        + (showEmail ? pad(`${C.gray}${(a.email || '-').length > emailW - 1 ? (a.email || '').slice(0, emailW - 2) + '…' : a.email || '-'}${C.r}`, emailW) : '')
        + pad(`${C.text}${a.plan || '-'}${C.r}`, 6)
        + bar(a.h5, bw, cfg.threshold5h) + ' ' + pctText(a.h5, cfg.threshold5h) + ' ' + pad(`${C.gray}${until(a.h5Reset)}${C.r}`, 9)
        + bar(a.d7, bw, cfg.threshold7d) + ' ' + pctText(a.d7, cfg.threshold7d) + ' ' + pad(`${C.gray}${until(a.d7Reset)}${C.r}`, 9)
        + pad(`${C.gray}${age(a.usageAt)}${C.r}`, 9) + state);
    });
    const s = selected();
    if (s && s.broken) rows.push('', `  ${C.red}${s.name}: ${s.broken}${C.r}`, `  Press ${C.blue}l${C.r} to sign it in again.`);

    const chain = [];
    ui.cfg.order.forEach((n, i) => {
      const a = list.find(x => x.name === n) || {};
      chain.push(`${C.gray}${i + 1}${C.r} ${pad(n === ui.st.active ? `${C.accent}${n}${C.r}` : `${C.text}${n}${C.r}`, nameW)}`
        + bar(a.h5, 10, cfg.threshold5h) + `  ${C.text}${a.h5 === null || a.h5 === undefined ? '-' : Math.round(a.h5)}${C.r}${C.gray} / ${cfg.threshold5h}%${C.r}`
        + `   ${C.gray}week${C.r} ${C.text}${a.d7 === null || a.d7 === undefined ? '-' : Math.round(a.d7)}${C.r}${C.gray} / ${cfg.threshold7d}%${C.r}`);
    });
    chain.push(cfg.auto
      ? `${C.gray}when the active account reaches a limit, cc moves to the one with the most room left${C.r}`
      : `${C.yellow}auto-switch is off: cc stays on ${ui.st.active || 'the active account'} (press a to turn it on)${C.r}`);
    const chainH = Math.min(chain.length + 2, Math.max(4, h - 6));
    return [...box('ACCOUNTS', rows, W, h - chainH), ...box('SWITCHING', chain, W, chainH)];
  }

  function history(W, h) {
    const events = H.read();
    const recent = events.filter(e => e.type !== 'usage').slice(-Math.max(1, h - 12)).reverse()
      .map(e => `${C.gray}${new Date(e.t).toLocaleString()}${C.r}  ${e.type === 'switch' ? C.accent : e.type === 'login-broken' || e.type === 'limit' ? C.red : C.text}${H.describe(e)}${C.r}`);
    if (!recent.length) recent.push(`${C.gray}Nothing yet. Switches, limits and sign-ins show up here.${C.r}`);
    const days = new Map();
    for (const e of events) {
      if (e.type !== 'usage') continue;
      const day = new Date(e.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const d = days.get(day) || {};
      for (const [n, u] of Object.entries(e.accounts || {})) {
        const cur = d[n] || { h5: 0, d7: 0 };
        d[n] = { h5: Math.max(cur.h5, u.h5 || 0), d7: Math.max(cur.d7, u.d7 || 0) };
      }
      days.set(day, d);
    }
    const names = ui.cfg.order;
    const peaks = [C.gray + pad('day', 14) + names.map(n => pad(n, 26)).join('') + C.r];
    for (const [day, d] of [...days.entries()].slice(-7)) {
      peaks.push(pad(`${C.text}${day}${C.r}`, 14) + names.map(n => {
        const u = d[n];
        return pad(u ? `${bar(u.h5, 8, ui.cfg.threshold5h)} ${C.text}${Math.round(u.h5)}%${C.r} ${C.gray}wk ${Math.round(u.d7)}%${C.r}` : `${C.gray}-${C.r}`, 26);
      }).join(''));
    }
    if (peaks.length === 1) peaks.push(`${C.gray}Recorded every 15 minutes while the relay runs.${C.r}`);
    const peaksH = Math.min(peaks.length + 2, 10);
    return [...box('RECENT EVENTS', recent, W, h - peaksH), ...box('HIGHEST USAGE PER DAY (5-hour, weekly)', peaks, W, peaksH)];
  }

  function pins(W, h) {
    const list = Object.entries(ui.cfg.pins);
    const here = norm(process.cwd());
    const rows = [C.gray + '  ' + pad('account', 14) + 'folder' + C.r];
    if (!list.length) rows.push('', `  ${C.gray}No pins. A pinned folder always uses one account and never switches.${C.r}`,
      `  Press ${C.blue}p${C.r} to pin a folder.`);
    list.forEach(([folder, name], i) => {
      const sel = i === ui.pinSel;
      const isHere = norm(folder) === here;
      rows.push(`${sel ? C.accent + '❯' + C.r : ' '} ${pad(`${C.accent}${name}${C.r}`, 14)}${sel ? C.b : C.text}${folder}${C.r}${isHere ? `${C.gray}  (this folder)${C.r}` : ''}`);
    });
    const cur = pinFor(process.cwd(), ui.cfg.pins);
    rows.push('', `${C.gray}  This folder: ${process.cwd()} → ${cur ? `${C.r}${C.accent}${cur}${C.r}${C.gray} (pinned)` : 'not pinned, uses auto-switch'}${C.r}`);
    return box('PINNED FOLDERS', rows, W, h);
  }

  const SETTINGS = [
    { label: 'Automatic switching', get: c => c.auto ? 'on' : 'off', toggle: c => { c.auto = !c.auto; } },
    { label: 'Switch at 5-hour usage', get: c => `${c.threshold5h}%`, step: (c, d) => { c.threshold5h = Math.max(1, Math.min(100, c.threshold5h + d)); } },
    { label: 'Switch at weekly usage', get: c => `${c.threshold7d}%`, step: (c, d) => { c.threshold7d = Math.max(1, Math.min(100, c.threshold7d + d)); } },
    { label: 'Start 5-hour window early', get: c => c.startWindow ? 'on' : 'off', toggle: c => { c.startWindow = !c.startWindow; } },
    { label: '  ...staggered across accounts', get: c => c.staggerWindows ? 'on' : 'off', toggle: c => { c.staggerWindows = !c.staggerWindows; } },
    { label: 'Switch early on fast usage', get: c => c.burnAware ? 'on' : 'off', toggle: c => { c.burnAware = !c.burnAware; } },
    { label: '  ...when the limit is this close', get: c => `${c.burnMinutes} min`, step: (c, d) => { c.burnMinutes = Math.max(5, Math.min(120, c.burnMinutes + d * 5)); } },
    { label: 'Windows notifications', get: c => c.notify ? 'on' : 'off', toggle: c => { c.notify = !c.notify; } },
    { label: 'Check usage every', get: c => `${c.pollSeconds}s`, step: (c, d) => { c.pollSeconds = Math.max(60, Math.min(1800, c.pollSeconds + d * 30)); } },
  ];

  function settings(W, h) {
    const rows = [];
    SETTINGS.forEach((s, i) => {
      const sel = i === ui.setSel;
      const val = s.get(ui.cfg);
      const valCol = val === 'off' ? C.yellow : val === 'on' ? C.green : C.text;
      rows.push(`${sel ? C.accent + '❯' + C.r : ' '} ${pad(sel ? C.b + s.label + C.r : C.text + s.label + C.r, 38)}${s.step ? `${C.gray}‹${C.r} ${valCol}${val}${C.r} ${C.gray}›${C.r}` : `${valCol}${val}${C.r}`}`);
    });
    rows.push('',
      `${C.gray}  Relay        127.0.0.1:${ui.cfg.port}  ${ui.st.live ? `pid ${ui.st.pid}` : 'not running'}${C.r}`,
      `${C.gray}  Data folder  ${P.DATA}${C.r}`,
      `${C.gray}  Log          ${P.LOG}${C.r}`);
    return box('SETTINGS', rows, W, h);
  }

  function statusTab(W, h) {
    const an = ui.st.anthropic;
    const col = s => s === 'operational' || s === 'resolved' ? C.green : s === 'degraded_performance' || s === 'monitoring' ? C.yellow : C.red;
    const rows = [];
    if (!an) rows.push(`${C.gray}Waiting for the relay to read status.claude.com…${C.r}`);
    else {
      rows.push(`${an.indicator === 'none' ? C.green : an.indicator === 'minor' ? C.yellow : C.red}${C.b}${an.description || 'unknown'}${C.r}${C.gray}   checked ${dur((Date.now() - an.at) / 1000)} ago · status.claude.com${C.r}`, '');
      for (const c of an.components || []) rows.push(`  ${col(c.status)}●${C.r} ${pad(`${C.text}${c.name}${C.r}`, 44)}${col(c.status)}${c.status.replace(/_/g, ' ')}${C.r}`);
      if (an.error) rows.push('', `${C.red}Last check failed: ${an.error}${C.r}`);
    }
    const inc = [];
    for (const i of (an && an.incidents) || []) {
      inc.push(`${col(i.status)}●${C.r} ${C.b}${i.name}${C.r}${C.gray}  ${i.status} · ${i.impact} impact · ${new Date(i.updatedAt).toLocaleString()}${C.r}`);
      if (i.latest) inc.push(`  ${C.text}${i.latest.replace(/\s+/g, ' ').slice(0, Math.max(20, (W - 8) * 2))}${C.r}`);
      inc.push('');
    }
    if (!inc.length) inc.push(`${C.gray}No open incidents.${C.r}`);
    const topH = Math.min(rows.length + 2, Math.max(6, h - 6));
    return [...box('ANTHROPIC STATUS', rows, W, topH), ...box('OPEN INCIDENTS', inc, W, h - topH)];
  }

  const FOOTERS = {
    overview: 'enter use  n add account  l re-login  x remove  ⇧↑↓ reorder  p pin here',
    history: '',
    pins: '↑↓ select  p pin a folder  d unpin',
    settings: '↑↓ select  enter toggle  -/+ change',
  };

  function render() {
    if (ui.closed) return;
    const W = Math.max(60, out.columns || 100);
    const Ht = Math.max(18, out.rows || 30);
    const lines = header(W);
    const bodyH = Ht - lines.length - 2;
    const tab = TABS[ui.tab];
    const body = tab === 'overview' ? overview(W, bodyH) : tab === 'history' ? history(W, bodyH) : tab === 'pins' ? pins(W, bodyH)
      : tab === 'settings' ? settings(W, bodyH) : statusTab(W, bodyH);
    lines.push(...body);
    let status = '';
    if (ui.input) status = `${C.blue}${ui.input.label}${C.r} ${C.text}${ui.input.value}${C.r}${C.accent}█${C.r}  ${C.gray}enter ok · esc cancel${C.r}`;
    else if (ui.confirm) status = `${C.yellow}${ui.confirm.label}${C.r} ${C.gray}(y / n)${C.r}`;
    else if (ui.msg && Date.now() - ui.msgAt < 6000) status = `${ui.msgErr ? C.red : C.green}${ui.msg}${C.r}`;
    lines.push(' ' + status);
    const items = ['←→ tabs', ...(FOOTERS[tab] ? FOOTERS[tab].split('  ') : []), 'c start claude', 'a auto', 'r refresh', 'q quit'];
    const optional = ['r refresh', 'a auto', '←→ tabs'];
    while (items.join('  ').length > W - 2 && optional.length) items.splice(items.indexOf(optional.shift()), 1);
    lines.push(' ' + items.map(k => { const i = k.indexOf(' '); return `${C.blue}${k.slice(0, i)}${C.r}${C.gray}${k.slice(i)}${C.r}`; }).join('  '));
    out.write(ESC + 'H' + lines.slice(0, Ht).map(l => clip(l, W) + ESC + 'K').join('\r\n') + ESC + 'J');
  }

  // ---- input -------------------------------------------------------------

  function ask(label, value, done) { ui.input = { label, value, done }; render(); }
  function confirm(label, onYes) { ui.confirm = { label, onYes }; render(); }
  const saveCfg = (mutate, msg) => act(() => api.setConfig(mutate), msg);

  function onKey(str, key = {}) {
    if (key.ctrl && key.name === 'c') return quit();

    if (ui.input) {
      const inp = ui.input;
      if (key.name === 'return') { ui.input = null; inp.done(inp.value.trim()); }
      else if (key.name === 'escape') { ui.input = null; flash('cancelled'); }
      else if (key.name === 'backspace') inp.value = inp.value.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str >= ' ') inp.value += str;
      return render();
    }
    if (ui.confirm) {
      const c = ui.confirm;
      ui.confirm = null;
      if (str === 'y' || str === 'Y') c.onYes(); else flash('cancelled');
      return render();
    }

    const tab = TABS[ui.tab];
    if (str === 'q' || key.name === 'escape') return quit();
    if (key.name === 'left' && !key.shift) { ui.tab = (ui.tab + TABS.length - 1) % TABS.length; return render(); }
    if (key.name === 'right' && !key.shift || key.name === 'tab') { ui.tab = (ui.tab + 1) % TABS.length; return render(); }
    if (str >= '1' && str <= '5') { ui.tab = Number(str) - 1; return render(); }
    if (str === 'a') return saveCfg(c => { c.auto = !c.auto; }, `auto-switch ${ui.cfg.auto ? 'off' : 'on'}`);
    if (str === 'r' || str === 'R') { flash('checking usage…'); render(); return act(() => api.poll(ui.cfg), 'usage updated'); }
    if (str === 'c') { ui.closed = true; leave(); return api.launch(); }

    if (tab === 'overview') {
      const list = accounts(), s = selected();
      if (key.name === 'up' || key.name === 'down') {
        const d = key.name === 'up' ? -1 : 1;
        if (key.shift && s) {
          const order = ui.cfg.order.slice(), i = order.indexOf(s.name), j = i + d;
          if (i < 0 || j < 0 || j >= order.length) return;
          [order[i], order[j]] = [order[j], order[i]];
          ui.sel = j;
          return saveCfg(c => { c.order = order; }, `order: ${order.join(' > ')}`);
        }
        ui.sel = Math.max(0, Math.min(list.length - 1, ui.sel + d));
        return render();
      }
      if ((key.name === 'return' || str === 'u') && s) return act(() => api.use(ui.cfg, s.name), `now using ${s.name}`);
      if (str === 'n') return ask('Name for the new account (e.g. main, backup):', '', name => {
        if (!name) return flash('cancelled');
        suspend(() => api.login(name));
      });
      if (str === 'l' && s) return confirm(`Sign "${s.name}" in again? A browser window opens.`, () => suspend(() => api.login(s.name)));
      if (str === 'x' && s) return confirm(`Remove "${s.name}" from cc? Its saved login is deleted.`, () => act(() => api.remove(s.name), `removed ${s.name}`));
      if (str === 'p' && s) {
        const folder = process.cwd();
        return saveCfg(c => {
          for (const k of Object.keys(c.pins)) if (norm(k) === norm(folder)) delete c.pins[k];
          c.pins[folder] = s.name;
        }, `pinned ${folder} → ${s.name}`);
      }
    }

    if (tab === 'pins') {
      const list = Object.entries(ui.cfg.pins);
      if (key.name === 'up' || key.name === 'down') {
        ui.pinSel = Math.max(0, Math.min(list.length - 1, ui.pinSel + (key.name === 'up' ? -1 : 1)));
        return render();
      }
      if (str === 'd' && list[ui.pinSel]) {
        const [folder] = list[ui.pinSel];
        ui.pinSel = Math.max(0, ui.pinSel - 1);
        return saveCfg(c => { delete c.pins[folder]; }, `unpinned ${folder}`);
      }
      if (str === 'p') {
        if (!ui.cfg.order.length) return flash('add an account first', true);
        return ask('Folder to pin:', process.cwd(), folder => {
          if (!folder) return flash('cancelled');
          const def = (selected() || {}).name || ui.cfg.order[0];
          ask(`Account for this folder (${ui.cfg.order.join(', ')}):`, def, name => {
            if (!ui.cfg.order.includes(name)) return flash(`no account named "${name}"`, true);
            const full = path.resolve(folder);
            saveCfg(c => {
              for (const k of Object.keys(c.pins)) if (norm(k) === norm(full)) delete c.pins[k];
              c.pins[full] = name;
            }, `pinned ${full} → ${name}`);
          });
        });
      }
    }

    if (tab === 'settings') {
      const s = SETTINGS[ui.setSel];
      if (key.name === 'up' || key.name === 'down') {
        ui.setSel = Math.max(0, Math.min(SETTINGS.length - 1, ui.setSel + (key.name === 'up' ? -1 : 1)));
        return render();
      }
      if ((key.name === 'return' || str === ' ') && s.toggle) return saveCfg(s.toggle, 'saved');
      if ((str === '+' || str === '=' || (key.shift && key.name === 'right')) && s.step) return saveCfg(c => s.step(c, 1), 'saved');
      if ((str === '-' || str === '_' || (key.shift && key.name === 'left')) && s.step) return saveCfg(c => s.step(c, -1), 'saved');
    }
  }

  enter();
  render();
  (async () => {
    if (ui.cfg.order.length) await api.ensureRelay(ui.cfg, true);
    await refresh(true);
  })();
  return new Promise(() => {}); // runs until the user quits
}

module.exports = { run };
