/* TradeBrain · in-app connections (v6). Paste keys, see balance (demo or real), sign orders/contracts with one tap.
   v6: two AI key slots with automatic failover, Deriv works with new PATs AND old tokens, step-by-step Diagnose, status chips.
   Keys stay on this phone (localStorage) only if "Remember" is ticked. They are sent only to the provider you pick. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), KEY = 'tb_conn';
  let ctx = null, ld = {}, sig = null; const rt = { seen: new Set(), last: {}, orders: 0 };
  try { ld = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { ld = {}; }
  const save = () => { try { if (ld.remember) localStorage.setItem(KEY, JSON.stringify(ld)); else localStorage.removeItem(KEY); } catch (e) {} };
  const mask = k => k ? k.slice(0, 4) + '••••' + k.slice(-3) : '';
  const say = (id, t) => { const e = $(id); if (e) e.textContent = t; };
  const hhmm = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const chip = (id, cls, text) => { const e = $('cs-' + id); if (!e) return; e.className = 'chip ' + cls; const v = e.querySelector('em'); if (v) v.textContent = text; };
  const tfetch = async (url, o = {}, ms = 20000) => {
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
    try { return await fetch(url, { ...o, signal: c.signal }); }
    catch (e) { throw new Error(e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'network error'); }
    finally { clearTimeout(t); }
  };
  const errMsg = j => (j && j.error && (j.error.message || (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)))) || (j && j.message) || '';
  const PROV = [[/^xai-/, 'Grok (xAI)', 'https://api.x.ai/v1'], [/^gsk_/, 'Groq', 'https://api.groq.com/openai/v1'], [/^AIza/, 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'], [/^sk-/, 'OpenAI', 'https://api.openai.com/v1']];
  const detect = k => { const p = PROV.find(x => x[0].test(k.trim())); return p ? { name: p[1], url: p[2] } : null; };
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

  /* ---------- AI keys: two slots, automatic failover ---------- */
  const AIS = { 1: { p: 'ai', box: 'c-ai', model: 'c-ai-model', out: 'c-ai-out', label: 'Primary' }, 2: { p: 'ai2', box: 'c-ai2', model: 'c-ai2-model', out: 'c-ai2-out', label: 'Backup' } };
  const slot = n => { const p = AIS[n].p; return { n, key: ld[p] || '', url: ld[p + 'Url'] || '', model: ld[p + 'Model'] || '', name: ld[p + 'Name'] || '', label: AIS[n].label }; };
  const cool = {};                       // runtime only: n -> { until, why }
  const today = () => new Date().toISOString().slice(0, 10);
  const useOf = n => { if ((ld.aiUse || {}).day !== today()) ld.aiUse = { day: today(), 1: 0, 2: 0 }; return ld.aiUse[n] || 0; };
  const bump = n => { useOf(n); ld.aiUse[n]++; save(); };
  const nextMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return +d; };
  const hasAI = () => !!(ld.ai || ld.ai2);
  const pickModel = ids => {
    const ok = ids.filter(i => !/image|imagine|embed|vision|tts|whisper|audio|guard|moderat|video|rerank/i.test(i)), pool = ok.length ? ok : ids, grok = pool.filter(i => /^grok-\d/.test(i));
    return (grok.length ? grok : pool).slice().sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || '';
  };
  function coolKey(n, status, msg, retry) {
    const daily = status === 402 || /day|daily|credit|billing|quota|exhaust/i.test(msg);
    const until = (status === 401 || status === 403) ? Date.now() + 3600e3 : daily ? nextMidnight() : Date.now() + Math.max(15, Math.min(retry || 60, 3600)) * 1000;
    cool[n] = { until, why: (status === 401 || status === 403) ? 'rejected' : daily ? 'daily limit' : 'rate limit' };
  }
  function aiOrder() {
    const have = [1, 2].filter(n => slot(n).key), now = Date.now();
    const ready = have.filter(n => !(cool[n] && cool[n].until > now)), waiting = have.filter(n => !ready.includes(n));
    if (ld.aiMode === 'balance') ready.sort((a, b) => useOf(a) - useOf(b) || a - b);
    return [...ready, ...waiting];       // keys that are cooling down are still tried last, so nothing is ever skipped
  }
  function aiShow() {
    [1, 2].forEach(n => {
      const s = slot(n); if (!s.key) return say(AIS[n].out, 'Not connected.');
      const c = cool[n] && cool[n].until > Date.now() ? cool[n] : null;
      say(AIS[n].out, `✔ ${s.name} ${mask(s.key)} · ${s.model}\n${useOf(n)} calls today · ${c ? `paused (${c.why}) until ${hhmm(c.until)}, tried last` : 'ready'}`);
    });
  }
  function aiStrip() {
    const have = [1, 2].filter(n => slot(n).key); if (!have.length) return chip('ai', 'off', 'No key');
    const ready = have.filter(n => !(cool[n] && cool[n].until > Date.now()));
    chip('ai', ready.length ? 'ok' : 'warn', ready.length ? `${ready.length}/${have.length} key${have.length > 1 ? 's' : ''} ready` : 'limit reached');
  }
  async function aiTest(n) {
    const a = AIS[n], cur = slot(n), box = $(a.box), k = box.value.trim() || cur.key, p = k && detect(k);
    if (!k) return say(a.out, 'Paste a key first.');
    if (!p) return say(a.out, 'Key not recognised (expects xai-, gsk_, AIza or sk-).');
    say(a.out, `Detected ${p.name}. Testing…`);
    try {
      const r = await tfetch(p.url + '/models', { headers: { Authorization: 'Bearer ' + k } }), j = await r.json().catch(() => ({}));
      if (!r.ok) return say(a.out, `${p.name}: ${r.status} ${errMsg(j) || 'key rejected'}`);
      const ids = (j.data || j.models || []).map(m => String(m.id || m.name).replace(/^models\//, '')).sort(), sel = $(a.model);
      sel.innerHTML = ids.map(i => `<option>${i}</option>`).join('');
      const want = cur.model && ids.includes(cur.model) ? cur.model : pickModel(ids); sel.value = want;
      ld[a.p] = k; ld[a.p + 'Url'] = p.url; ld[a.p + 'Model'] = want; ld[a.p + 'Name'] = p.name; box.value = ''; delete cool[n]; save(); aiShow(); aiStrip();
      say(a.out, $(a.out).textContent + `\n${ids.length} models available.`);
    } catch (e) { say(a.out, `Could not reach ${p.name}: ${e.message}. If this is the web page, the browser may block it; the APK does not.`); }
  }
  const SYS = 'You are a cautious trading analyst. Give a short assessment: agree/disagree with the signal, main risk, what would invalidate it. No guarantees.';
  async function ask(prompt, system) {
    const order = aiOrder(); if (!order.length) throw new Error('Add a Grok / AI key in Connect first.');
    const errs = [];
    for (const n of order) {
      const s = slot(n);
      try {
        const r = await tfetch(s.url + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.key }, body: JSON.stringify({ model: s.model, temperature: 0.2, messages: [{ role: 'system', content: system || SYS }, { role: 'user', content: prompt }] }) }, 60000);
        const j = await r.json().catch(() => ({})), txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (r.ok && txt) { delete cool[n]; bump(n); aiShow(); aiStrip(); return `${s.model} · ${s.label} key\n\n${txt}`; }
        const msg = errMsg(j) || (r.ok ? 'empty reply' : 'HTTP ' + r.status); errs.push(`${s.label}: ${msg}`);
        let ra = 0; try { ra = +(r.headers && r.headers.get && r.headers.get('retry-after')) || 0; } catch (e) {}
        if ([401, 402, 403, 429].includes(r.status) || /quota|limit|credit/i.test(msg)) coolKey(n, r.status, msg, ra);
      } catch (e) { errs.push(`${s.label}: ${e.message}`); }
    }
    aiShow(); aiStrip();
    throw new Error('All AI keys failed. ' + errs.join(' | '));
  }

  /* ---------- Deriv: new PAT flow (REST -> one-time URL -> WebSocket) and old-token flow ---------- */
  let dws = null, dp = {}, dn = 0, dAuth = null, dPing = null;
  const dKind = t => /^pat_/i.test(t || '') ? 'pat' : 'legacy';
  const dRest = async (method, path) => {
    let r; try { r = await tfetch('https://api.derivws.com' + path, { method, headers: { Authorization: 'Bearer ' + ld.dTok, 'Deriv-App-ID': ld.dApp } }, 15000); }
    catch (e) { throw new Error(`Network: cannot reach api.derivws.com (${e.message}). Check internet or VPN. In a normal browser this is usually CORS; the APK avoids it.`); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(((j.errors && j.errors[0] && j.errors[0].message) || errMsg(j) || 'Deriv error') + ` (HTTP ${r.status}${r.status === 401 || r.status === 403 ? ': token or App ID rejected' : ''})`); return j;
  };
  function rawSend(w, msg, ms = 15000) {
    const id = ++dn;
    return new Promise((res, rej) => { dp[id] = { res, rej }; setTimeout(() => { if (dp[id]) { delete dp[id]; rej(new Error('Deriv did not answer')); } }, ms); try { w.send(JSON.stringify({ ...msg, req_id: id })); } catch (e) { delete dp[id]; rej(new Error('Deriv socket is closed')); } });
  }
  async function dOpen(url, legacyAuth) {
    return new Promise((res, rej) => {
      let w; try { w = new WebSocket(url); } catch (e) { return rej(new Error('Cannot open the Deriv socket: ' + e.message)); }
      const t = setTimeout(() => { try { w.close(); } catch (e) {} rej(new Error('Deriv socket timed out (no connection in 15 s)')); }, 15000);
      w.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } const f = dp[m.req_id]; if (f) { delete dp[m.req_id]; m.error ? f.rej(new Error(m.error.message || m.error.code)) : f.res(m); } };
      w.onerror = () => { clearTimeout(t); rej(new Error('Cannot open the Deriv socket (blocked or offline)')); };
      w.onclose = () => { clearInterval(dPing); if (dws === w) dws = null; Object.keys(dp).forEach(k => { dp[k].rej(new Error('Deriv socket closed')); delete dp[k]; }); };
      w.onopen = async () => {
        clearTimeout(t);
        try { if (legacyAuth) { const a = await rawSend(w, { authorize: ld.dTok }); dAuth = a.authorize; } dws = w; clearInterval(dPing); dPing = setInterval(() => { if (dws && dws.readyState === 1) { try { dws.send('{"ping":1}'); } catch (e) {} } }, 30000); res(w); }
        catch (e) { try { w.close(); } catch (x) {} rej(e); }
      };
    });
  }
  async function dSock() {
    if (dws && dws.readyState === 1) return dws;
    if (dKind(ld.dTok) === 'legacy') return dOpen('wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(ld.dApp || '1089'), true);
    const o = await dRest('POST', `/trading/v1/options/accounts/${ld.dAcct.id}/otp`), url = o.data && o.data.url; if (!url) throw new Error('Deriv gave no socket address: ' + JSON.stringify(o).slice(0, 150));
    return dOpen(url, false);
  }
  async function dSend(msg) { return rawSend(await dSock(), msg); }
  async function dPick(id) {
    const a = (ld.dAccts || []).find(x => x.id === id) || { id, demo: /^VR|^DEM/i.test(id) };
    ld.dAcct = { id: a.id, demo: a.demo, bal: null, cur: a.cur || 'USD' }; if (dws) { try { dws.close(); } catch (e) {} } dws = null;
    const b = await dSend({ balance: 1 }); ld.dAcct.bal = b.balance.balance; ld.dAcct.cur = b.balance.currency || ld.dAcct.cur; save(); showD();
  }
  async function dConnect() {
    const tok = $('c-dtok').value.trim() || ld.dTok, kind = dKind(tok), app = $('c-dapp').value.trim() || ld.dApp || (kind === 'legacy' ? '1089' : '');
    if (!tok) return say('c-d-out', 'Paste your Deriv token first.');
    if (kind === 'pat' && !app) return say('c-d-out', 'New tokens (pat_…) need an App ID. Register an app at developers.deriv.com to get one.');
    ld.dTok = tok; ld.dApp = app; $('c-dtok').value = ''; $('c-dapp').value = app; if (dws) { try { dws.close(); } catch (e) {} } dws = null; say('c-d-out', 'Connecting…'); chip('deriv', 'warn', 'Connecting…');
    try {
      if (kind === 'pat') {
        const j = await dRest('GET', '/trading/v1/options/accounts'), list = Array.isArray(j.data) ? j.data : (j.data && (j.data.accounts || j.data.items)) || [];
        ld.dAccts = list.map(a => { const id = a.account_id || a.loginid || a.id || ''; return { id, demo: a.account_type === 'demo' || a.is_virtual === 1 || a.is_virtual === true || /^VR|^DEM/i.test(id), cur: a.currency }; }).filter(a => a.id);
        if (!ld.dAccts.length) { chip('deriv', 'bad', 'No account'); return say('c-d-out', 'Token accepted but no accounts found. Raw reply:\n' + JSON.stringify(j).slice(0, 300)); }
      } else {
        await dOpen('wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(app), true);
        const z = dAuth || {};
        ld.dAccts = [{ id: z.loginid, demo: !!z.is_virtual, cur: z.currency }].filter(a => a.id);
        if (!ld.dAccts.length) { chip('deriv', 'bad', 'No account'); return say('c-d-out', 'Deriv accepted the token but returned no account.'); }
      }
      ld.dAccts.sort((x, y) => (y.demo ? 1 : 0) - (x.demo ? 1 : 0));
      $('c-dacc').innerHTML = ld.dAccts.map(a => `<option value="${a.id}">${a.demo ? 'DEMO' : 'REAL'} ${a.id}</option>`).join('');
      await dPick(ld.dAccts[0].id);
    } catch (e) {
      chip('deriv', 'bad', 'Failed');
      const hint = kind === 'pat' ? (app === '1089' ? '\nYour App ID is 1089, the old shared test ID. A pat_ token normally needs an App ID you registered at developers.deriv.com.' : '\nCheck the App ID is registered at developers.deriv.com and the token was created with trade scope.') : '\nOld-style token: it must be created for the same App ID you entered (1089 works for tokens made under 1089).';
      say('c-d-out', '✖ ' + e.message + hint + '\nTap Diagnose for a step-by-step test.');
    }
  }
  async function dDiagnose() {
    const tok = $('c-dtok').value.trim() || ld.dTok, kind = dKind(tok), app = $('c-dapp').value.trim() || ld.dApp || (kind === 'legacy' ? '1089' : ''), L = [];
    const log = (ok, t) => { L.push((ok === null ? '…' : ok ? '✔' : '✖') + ' ' + t); say('c-d-out', L.join('\n')); };
    if (!tok) return say('c-d-out', 'Paste your token first, then tap Diagnose.');
    log(null, 'Checking your internet…');
    try { const r = await tfetch('https://api.binance.com/api/v3/ping', {}, 8000); L.pop(); log(r.ok, r.ok ? 'Internet works' : 'Internet check returned HTTP ' + r.status); } catch (e) { L.pop(); return log(false, 'No internet from this app (' + e.message + '). Fix this first.'); }
    log(true, `Token type: ${kind === 'pat' ? 'new PAT (pat_…) → REST + one-time socket' : 'old token → direct socket authorize'}`);
    if (kind === 'pat') {
      log(!!app && app !== '1089', app ? (app === '1089' ? 'App ID is 1089 (old shared ID). New tokens usually need your own registered App ID.' : 'App ID: ' + app) : 'No App ID entered.'); if (!app) return;
      ld.dTok = tok; ld.dApp = app;
      let accts; try { log(null, 'Asking api.derivws.com for your accounts…'); const j = await dRest('GET', '/trading/v1/options/accounts'); accts = Array.isArray(j.data) ? j.data : (j.data && (j.data.accounts || j.data.items)) || []; L.pop(); log(true, `Token accepted, ${accts.length} account(s) found`); } catch (e) { L.pop(); return log(false, e.message); }
      if (!accts.length) return log(false, 'No accounts returned.');
      const a = accts.find(x => x.account_type === 'demo') || accts[0], id = a.account_id || a.loginid || a.id;
      try { log(null, `Requesting socket address for ${id}…`); const o = await dRest('POST', `/trading/v1/options/accounts/${id}/otp`); L.pop(); log(!!(o.data && o.data.url), o.data && o.data.url ? 'Got one-time socket address' : 'No socket address in reply'); if (!(o.data && o.data.url)) return;
        log(null, 'Opening socket…'); const w = await dOpen(o.data.url, false); const b = await rawSend(w, { balance: 1 }); L.pop(); log(true, `Socket open · balance ${b.balance.balance} ${b.balance.currency}`); w.close(); log(true, 'All steps passed. Tap Connect.'); } catch (e) { L.pop(); log(false, e.message); }
    } else {
      try { log(null, 'Opening ws.derivws.com and authorizing…'); const w = await dOpen('wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(app), true); L.pop(); log(true, `Authorized ${dAuth.loginid} (${dAuth.is_virtual ? 'DEMO' : 'REAL'})`); w.close(); log(true, 'All steps passed. Tap Connect.'); } catch (e) { L.pop(); log(false, e.message + ' (App ID ' + app + ')'); }
    }
  }
  function showD() { const a = ld.dAcct; if (!a) return; say('c-d-out', `✔ ${a.demo ? 'DEMO' : 'REAL'} account ${a.id}\nBalance: ${a.bal} ${a.cur}\nToken ${mask(ld.dTok)} · App ${ld.dApp} · ${dKind(ld.dTok) === 'pat' ? 'new API' : 'classic API'}`); $('c-d-tag').textContent = a.demo ? 'DEMO' : 'REAL'; $('c-d-tag').className = 'tag ' + (a.demo ? 'ok' : 'bad'); chip('deriv', a.demo ? 'ok' : 'live', `${a.demo ? 'Demo' : 'Real'} · ${a.bal} ${a.cur}`); }
  let prop = null;
  const dReq = () => { const r = { proposal: 1, amount: +$('c-dst').value, basis: 'stake', contract_type: $('c-dty').value, currency: (ld.dAcct || {}).cur || 'USD', duration: +$('c-ddu').value, duration_unit: $('c-dun').value }; r[dKind(ld.dTok) === 'legacy' ? 'symbol' : 'underlying_symbol'] = $('c-dsy').value.trim(); return r; };
  async function dQuote() {
    if (!ld.dAcct) return say('c-d-trade', 'Connect Deriv first.'); say('c-d-trade', 'Getting price…');
    try {
      let p; try { p = await dSend(dReq()); } catch (e) { if (!/underlying_symbol|symbol/i.test(e.message)) throw e; const r = dReq(); if (r.underlying_symbol) { r.symbol = r.underlying_symbol; delete r.underlying_symbol; } else { r.underlying_symbol = r.symbol; delete r.symbol; } p = await dSend(r); }
      prop = p.proposal; say('c-d-trade', `${$('c-dty').value} ${$('c-dsy').value}\n${prop.longcode}\nCost ${prop.ask_price} · payout ${prop.payout}\nTap Sign to buy.`); $('c-dsign').disabled = false;
    } catch (e) { prop = null; $('c-dsign').disabled = true; say('c-d-trade', '✖ ' + e.message); }
  }
  async function dSign() {
    if (!prop) return; const a = ld.dAcct;
    if (!a.demo && !confirm(`REAL account ${a.id}. Spend ${prop.ask_price} ${a.cur}?`)) return;
    $('c-dsign').disabled = true; say('c-d-trade', 'Signing… do not tap again.');
    try { const b = await dSend({ buy: prop.id, price: prop.ask_price }), z = b.buy; say('c-d-trade', `✔ Bought contract ${z.contract_id}\nCost ${z.buy_price} · payout ${z.payout}\nBalance now ${z.balance_after}`); a.bal = z.balance_after; save(); showD(); ctx.hist('Deriv ' + (a.demo ? 'DEMO' : 'REAL') + ' contract ' + z.contract_id); }
    catch (e) { say('c-d-trade', '✖ ' + e.message + '\nCheck Deriv before retrying.'); } prop = null;
  }

  /* ---------- Binance spot ---------- */
  const bBase = () => ld.bTest ? 'https://testnet.binance.vision' : 'https://api.binance.com';
  let off = 0;
  async function bCall(method, path, params) {
    const q = new URLSearchParams({ ...params, recvWindow: 10000, timestamp: Date.now() + off }).toString();
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(ld.bSec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sg = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(q)));
    const r = await fetch(`${bBase()}${path}?${q}&signature=${sg}`, { method, headers: { 'X-MBX-APIKEY': ld.bKey } }), j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.msg || 'Binance ' + r.status); return j;
  }
  async function bConnect() {
    const k = $('c-bk').value.trim() || ld.bKey, s = $('c-bs').value.trim() || ld.bSec; if (!k || !s) return say('c-b-out', 'Paste both the key and the secret.');
    ld.bKey = k; ld.bSec = s; ld.bTest = $('c-bm').value === 'test'; $('c-bk').value = ''; $('c-bs').value = ''; say('c-b-out', 'Connecting…'); chip('binance', 'warn', 'Connecting…');
    try {
      const t = await (await fetch(bBase() + '/api/v3/time')).json(); off = t.serverTime - Date.now();
      const a = await bCall('GET', '/api/v3/account', {}), bal = a.balances.filter(x => +x.free > 0 || +x.locked > 0).slice(0, 8).map(x => `${x.asset} ${(+x.free).toFixed(6)}`);
      ld.bOk = true; save(); say('c-b-out', `✔ Binance ${ld.bTest ? 'TESTNET (demo)' : 'LIVE (real)'} · trading ${a.canTrade ? 'allowed' : 'NOT allowed'}\n${bal.join('\n') || 'No balances'}\nKey ${mask(k)}`);
      $('c-b-tag').textContent = ld.bTest ? 'DEMO' : 'REAL'; $('c-b-tag').className = 'tag ' + (ld.bTest ? 'ok' : 'bad'); chip('binance', ld.bTest ? 'ok' : 'live', ld.bTest ? 'Testnet' : 'Live');
    } catch (e) { chip('binance', 'bad', 'Failed'); say('c-b-out', '✖ ' + e.message); }
  }
  async function bOrder(side, symbol, amount, isQuote) {
    if (!ld.bOk) throw new Error('Connect Binance first.');
    if (!ld.bTest && !confirm(`LIVE Binance: ${side} ${symbol} ${amount}${isQuote ? ' USDT' : ''}?`)) throw new Error('Cancelled.');
    const p = { symbol, side, type: 'MARKET', newClientOrderId: 'TB' + Date.now().toString(36) }; p[isQuote ? 'quoteOrderQty' : 'quantity'] = amount;
    const o = await bCall('POST', '/api/v3/order', p); ctx.hist(`Binance ${ld.bTest ? 'TEST' : 'LIVE'} ${side} ${symbol} ${o.status} ${o.orderId}`); return o;
  }
  async function bManual(side) {
    const sym = $('c-bsy').value.trim().toUpperCase(), amt = $('c-bam').value.trim(); say('c-b-trade', 'Signing… do not tap again.');
    try { const o = await bOrder(side, sym, amt, side === 'BUY'); say('c-b-trade', `✔ ${o.status} · ${o.side} ${o.symbol}\nFilled ${o.executedQty} for ${o.cummulativeQuoteQty}\nNo stop-loss is attached. Watch this trade.`); bConnect(); }
    catch (e) { say('c-b-trade', '✖ ' + e.message); }
  }

  /* ---------- signal sign queue (called after each auto scan) ---------- */
  const aiNotes = new Map();     // signal key -> AI review text (or pending marker)
  function aiReview(s, el) {
    if (ld.aiAuto === false || !hasAI()) return;
    const k = s.key, c = s.cand, box = document.createElement('pre'); box.className = 'out'; el.appendChild(box);
    if (aiNotes.has(k)) { box.textContent = aiNotes.get(k) || 'AI is reviewing this signal…'; return; }
    aiNotes.set(k, ''); box.textContent = 'AI is reviewing this signal…';
    ask(`Signal ${c.signal} on ${c.symbol} ${c.tf || ''}, score ${c.score}. Evidence: ${(c.reasons || []).join('; ')}`).then(t => { aiNotes.set(k, t); }).catch(e => { aiNotes.set(k, 'AI review unavailable: ' + e.message); })
      .finally(() => { if (box.isConnected) box.textContent = aiNotes.get(k); });
  }
  function onScan(results) {
    const S = ctx.S(); if (!S.autoOn) return; const el = $('c-sig'); sig = null;
    const watch = results.filter(r => (r.signal === 'BUY') && ld.bOk).sort((a, b) => b.score - a.score);
    for (const cand of watch) {
      const g = TB.gates.evaluate({ cand, council: ctx.council(cand), S, symbol: cand.symbol, broker: 'binance', accountMode: 'demo', armed: true, runtime: rt });
      if (!g.ok) continue; sig = { cand, key: g.key }; break;
    }
    if (!sig) { el.innerHTML = '<div class="empty">No signal passes the gates right now.</div>'; return; }
    const c = sig.cand, h = TB.sizing.hybrid({ equity: S.now, riskPct: S.riskPct, stopDist: c.stopDist, price: c.price, manualCap: (+$('c-bam').value || 10) / c.price });
    if (!h.ok) { el.innerHTML = `<div class="empty">${c.symbol}: ${h.why}</div>`; sig = null; return; }
    sig.usdt = Math.floor(h.qty * c.price * 100) / 100;
    el.innerHTML = `<b>BUY ${c.symbol}</b> · score ${c.score}<p class="muted small">Spend ${sig.usdt} USDT · risk $${h.lossAtStop.toFixed(2)} at the stop (${c.stopDist.toFixed(4)}). ${ld.bTest ? 'TESTNET' : 'LIVE'}</p><button id="c-sigb" class="btn primary">Sign this order</button>`;
    aiReview(sig, el);
    $('c-sigb').onclick = async () => { const s = sig; if (!s) return; rt.seen.add(s.key); rt.last[s.cand.symbol] = Date.now(); rt.orders++; $('c-sigb').disabled = true;
      try { const o = await bOrder('BUY', s.cand.symbol, s.usdt, true); el.textContent = `✔ ${o.status} ${o.symbol} ${o.executedQty}`; bConnect(); } catch (e) { el.textContent = '✖ ' + e.message; } };
  }

  /* ---------- UI ---------- */
  const F = (id, label, extra = '') => `<label>${label}<input id="${id}" autocomplete="off" ${extra}></label>`;
  const KEYICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/></svg>';
  function build() {
    const sec = document.createElement('section'); sec.id = 'view-connect'; sec.className = 'view';
    sec.innerHTML = `<div class="page-head"><div><div class="eyebrow">In-app</div><h1>Connect</h1><p class="muted">Paste a key, tap Connect, see the balance. Demo and real are labelled. Orders need your tap to sign.</p></div></div>
<div class="card form"><div class="card-title"><div><div class="eyebrow">AI · two keys</div><h3>Grok / AI keys</h3></div><span class="tag">Auto failover</span></div>
<p class="muted small">Add a second key and the app switches to it on its own when the first hits a daily or rate limit, then comes back to the first when it recovers. Keys from different xAI teams or accounts have separate limits; keys on the same team share one.</p>
<div class="fields">${F('c-ai', 'Primary key (auto-detected)', 'type="password"')}<label>Primary model<select id="c-ai-model"></select></label></div>
<div class="row"><button id="c-ai-go" class="btn primary">Test primary</button></div><pre id="c-ai-out" class="out">Not connected.</pre>
<div class="fields">${F('c-ai2', 'Backup key (optional)', 'type="password"')}<label>Backup model<select id="c-ai2-model"></select></label></div>
<div class="row"><button id="c-ai2-go" class="btn primary">Test backup</button></div><pre id="c-ai2-out" class="out">Not connected.</pre>
<div class="fields"><label>Key use<select id="c-ai-mode"><option value="failover">Primary first, backup when limited</option><option value="balance">Share the load across both keys</option></select></label>
<label class="check"><input id="c-ai-auto" type="checkbox"> AI reviews every signal it finds</label></div>
<p class="muted small">The AI gives a second opinion on each signal. The gates and your tap still decide every order.</p></div>
<div class="card form"><div class="card-title"><div><div class="eyebrow">Contracts</div><h3>Deriv</h3></div><span id="c-d-tag" class="tag">—</span></div><div class="fields">${F('c-dtok', 'Token (new pat_… or old token)', 'type="password"')}${F('c-dapp', 'App ID (new tokens: from developers.deriv.com)', 'inputmode="numeric"')}<label>Account<select id="c-dacc"></select></label></div>
<div class="row"><button id="c-d-go" class="btn primary">Connect</button><button id="c-d-diag" class="btn">Diagnose</button></div><pre id="c-d-out" class="out">Not connected.</pre>
<div class="fields">${F('c-dsy', 'Symbol', 'value="R_100"')}<label>Type<select id="c-dty"><option value="CALL">CALL (up)</option><option value="PUT">PUT (down)</option></select></label>${F('c-dst', 'Stake', 'type="number" value="1" min="0.35" step="0.01"')}${F('c-ddu', 'Duration', 'type="number" value="5" min="1"')}<label>Unit<select id="c-dun"><option value="t">ticks</option><option value="m">minutes</option></select></label></div>
<div class="row"><button id="c-dq" class="btn">Get price</button><button id="c-dsign" class="btn primary" disabled>Sign contract</button></div><pre id="c-d-trade" class="out"></pre></div>
<div class="card form"><div class="card-title"><div><div class="eyebrow">Spot</div><h3>Binance</h3></div><span id="c-b-tag" class="tag">—</span></div><div class="fields">${F('c-bk', 'API key', 'type="password"')}${F('c-bs', 'Secret', 'type="password"')}<label>Account<select id="c-bm"><option value="test">Testnet (demo)</option><option value="live">Live (real)</option></select></label></div>
<div class="row"><button id="c-b-go" class="btn primary">Connect</button></div><pre id="c-b-out" class="out">Not connected.</pre>
<div class="fields">${F('c-bsy', 'Symbol', 'value="BTCUSDT"')}${F('c-bam', 'BUY: USDT to spend · SELL: coin quantity', 'type="number" value="10" step="any"')}</div>
<div class="row"><button id="c-bb" class="btn primary">Sign BUY</button><button id="c-bsl" class="btn danger">Sign SELL</button></div><pre id="c-b-trade" class="out"></pre>
<div class="card-title"><div><div class="eyebrow">From the Auto scanner</div><h3>Signal to sign</h3></div></div><div id="c-sig"><div class="empty">Start Auto (with Binance connected) to see signals.</div></div></div>
<div class="card form"><label class="check"><input id="c-rem" type="checkbox"> Remember keys on this phone</label><p class="muted small">Stored unencrypted in this app's storage. Never uploaded. Untick to wipe. Use trade-only keys with NO withdrawal permission.</p><div class="row"><button id="c-wipe" class="btn danger">Forget all keys</button></div></div>`;
    document.querySelector('main').insertBefore(sec, document.querySelector('footer'));
    const b = document.createElement('button'); b.dataset.view = 'connect'; b.innerHTML = `<b>${KEYICON}</b>Connect`; const tb = document.getElementById('tabbar'); tb.insertBefore(b, tb.children[1] || null);
    const open = () => { document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-connect')); document.querySelectorAll('#tabbar button').forEach(x => x.classList.toggle('active', x === b)); window.scrollTo({ top: 0 }); };
    b.onclick = open;
    const card = document.createElement('div'); card.className = 'card cta'; card.innerHTML = `<div><b>Keys &amp; balance</b><p class="muted small">Deriv, Binance and Grok connect here · build v6</p></div><button id="c-go" class="btn primary">Open Connect</button>`; document.getElementById('view-scan').prepend(card); $('c-go').onclick = open;
    document.querySelectorAll('#conn-strip .chip').forEach(c => { c.onclick = open; });
    $('c-rem').checked = !!ld.remember; $('c-bm').value = ld.bTest === false ? 'live' : 'test'; $('c-ai-mode').value = ld.aiMode || 'failover'; $('c-ai-auto').checked = ld.aiAuto !== false;
    $('c-ai-go').onclick = () => aiTest(1); $('c-ai2-go').onclick = () => aiTest(2); $('c-d-go').onclick = dConnect; $('c-d-diag').onclick = dDiagnose; $('c-dacc').onchange = e => dPick(e.target.value).catch(x => say('c-d-out', '✖ ' + x.message)); $('c-dq').onclick = dQuote; $('c-dsign').onclick = dSign;
    $('c-ai-model').onchange = e => { ld.aiModel = e.target.value; save(); }; $('c-ai2-model').onchange = e => { ld.ai2Model = e.target.value; save(); };
    $('c-ai-mode').onchange = e => { ld.aiMode = e.target.value; save(); }; $('c-ai-auto').onchange = e => { ld.aiAuto = e.target.checked; save(); };
    $('c-b-go').onclick = bConnect; $('c-bb').onclick = () => bManual('BUY'); $('c-bsl').onclick = () => bManual('SELL');
    $('c-rem').onchange = e => { ld.remember = e.target.checked; save(); };
    $('c-wipe').onclick = () => { ld = {}; try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); };
    [1, 2].forEach(n => { const s = slot(n); if (s.model) $(AIS[n].model).innerHTML = `<option>${s.model}</option>`; });
    aiShow(); aiStrip();
    if (ld.dAcct) { $('c-dacc').innerHTML = (ld.dAccts || []).map(a => `<option value="${a.id}"${a.id === ld.dAcct.id ? ' selected' : ''}>${a.demo ? 'DEMO' : 'REAL'} ${a.id}</option>`).join(''); if (ld.dApp) $('c-dapp').value = ld.dApp; showD(); chip('deriv', 'warn', 'Saved · tap to refresh'); }
    if (ld.bOk) { say('c-b-out', 'Saved key ' + mask(ld.bKey) + '. Tap Connect to refresh the balance.'); chip('binance', 'warn', 'Saved · tap to refresh'); }
  }
  function init(c) { ctx = c; ctx.hist = c.hist || (() => {}); build(); }
  window.TB = window.TB || {}; window.TB.live = { init, onScan, ask, hasAI };
})();
