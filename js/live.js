/* TradeBrain · in-app connections. Paste keys, see balance (demo or real), sign orders/contracts with one tap.
   Keys stay on this phone (localStorage) only if "Remember" is ticked. They are sent only to the provider you pick. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), KEY = 'tb_conn';
  let ctx = null, ld = {}, sig = null; const rt = { seen: new Set(), last: {}, orders: 0 };
  try { ld = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { ld = {}; }
  const save = () => { try { if (ld.remember) localStorage.setItem(KEY, JSON.stringify(ld)); else localStorage.removeItem(KEY); } catch (e) {} };
  const mask = k => k ? k.slice(0, 4) + '••••' + k.slice(-3) : '';
  const say = (id, t) => { $(id).textContent = t; };
  const PROV = [[/^xai-/, 'Grok (xAI)', 'https://api.x.ai/v1'], [/^gsk_/, 'Groq', 'https://api.groq.com/openai/v1'], [/^AIza/, 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'], [/^sk-/, 'OpenAI', 'https://api.openai.com/v1']];
  const detect = k => { const p = PROV.find(x => x[0].test(k.trim())); return p ? { name: p[1], url: p[2] } : null; };
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

  /* ---------- AI key ---------- */
  async function aiTest() {
    const k = $('c-ai').value.trim() || ld.ai || '', p = detect(k);
    if (!k) return say('c-ai-out', 'Paste a key first.');
    if (!p) return say('c-ai-out', 'Key not recognised (expects xai-, gsk_, AIza or sk-).');
    say('c-ai-out', `Detected ${p.name}. Testing…`);
    try {
      const r = await fetch(p.url + '/models', { headers: { Authorization: 'Bearer ' + k } }), j = await r.json().catch(() => ({}));
      if (!r.ok) return say('c-ai-out', `${p.name}: ${r.status} ${(j.error && (j.error.message || j.error)) || 'key rejected'}`);
      const ids = (j.data || j.models || []).map(m => String(m.id || m.name).replace(/^models\//, '')).sort();
      $('c-ai-model').innerHTML = ids.map(i => `<option>${i}</option>`).join('');
      if (ld.aiModel && ids.includes(ld.aiModel)) $('c-ai-model').value = ld.aiModel;
      ld.ai = k; ld.aiUrl = p.url; ld.aiModel = $('c-ai-model').value; ld.aiName = p.name; $('c-ai').value = ''; save();
      say('c-ai-out', `✔ Connected to ${p.name} (${mask(k)}). ${ids.length} models available.`);
    } catch (e) { say('c-ai-out', `Could not reach ${p.name}: ${e.message}. If this is the web page, the browser may block it; the APK does not.`); }
  }
  async function ask(prompt) {
    const r = await fetch(ld.aiUrl + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ld.ai }, body: JSON.stringify({ model: ld.aiModel, temperature: 0.2, messages: [{ role: 'system', content: 'You are a cautious trading analyst. Give a short assessment: agree/disagree with the signal, main risk, what would invalidate it. No guarantees.' }, { role: 'user', content: prompt }] }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || 'AI error ' + r.status);
    return `${ld.aiModel}\n\n${j.choices[0].message.content}`;
  }

  /* ---------- Deriv ---------- */
  function deriv(msgs) { // opens a socket, authorizes, sends msgs in order, resolves with all replies
    return new Promise((res, rej) => {
      const out = [], ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=' + (ld.dApp || '1089')), t = setTimeout(() => { ws.close(); rej(new Error('Deriv timed out')); }, 20000);
      const queue = [{ authorize: ld.dTok }, ...msgs]; let i = 0;
      ws.onopen = () => ws.send(JSON.stringify(queue[i]));
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.error) { clearTimeout(t); ws.close(); return rej(new Error(m.error.message)); } out.push(m); if (++i < queue.length) ws.send(JSON.stringify(queue[i])); else { clearTimeout(t); ws.close(); res(out); } };
      ws.onerror = () => { clearTimeout(t); rej(new Error('Cannot reach Deriv')); };
    });
  }
  async function dConnect() {
    const tok = $('c-dtok').value.trim() || ld.dTok; if (!tok) return say('c-d-out', 'Paste your Deriv API token first.');
    ld.dTok = tok; ld.dApp = $('c-dapp').value.trim() || '1089'; $('c-dtok').value = '';
    say('c-d-out', 'Connecting…');
    try { const [a] = await deriv([]); const z = a.authorize; ld.dAcct = { id: z.loginid, demo: !!z.is_virtual, bal: z.balance, cur: z.currency }; save(); showD(); }
    catch (e) { say('c-d-out', '✖ ' + e.message); }
  }
  function showD() { const a = ld.dAcct; if (!a) return; say('c-d-out', `✔ ${a.demo ? 'DEMO' : 'REAL'} account ${a.id}\nBalance: ${a.bal} ${a.cur}\nToken ${mask(ld.dTok)}`); $('c-d-tag').textContent = a.demo ? 'DEMO' : 'REAL'; $('c-d-tag').className = 'tag ' + (a.demo ? 'ok' : 'bad'); }
  let prop = null;
  const dReq = () => ({ proposal: 1, amount: +$('c-dst').value, basis: 'stake', contract_type: $('c-dty').value, currency: (ld.dAcct || {}).cur || 'USD', duration: +$('c-ddu').value, duration_unit: $('c-dun').value, symbol: $('c-dsy').value.trim() });
  async function dQuote() {
    if (!ld.dTok) return say('c-d-trade', 'Connect Deriv first.'); say('c-d-trade', 'Getting price…');
    try { const [, p] = await deriv([dReq()]); prop = p.proposal; say('c-d-trade', `${p.echo_req.contract_type} ${p.echo_req.symbol}\n${prop.longcode}\nCost ${prop.ask_price} · payout ${prop.payout}\nTap Sign to buy.`); $('c-dsign').disabled = false; }
    catch (e) { prop = null; $('c-dsign').disabled = true; say('c-d-trade', '✖ ' + e.message); }
  }
  async function dSign() {
    if (!prop) return; const a = ld.dAcct || {};
    if (!a.demo && !confirm(`REAL account ${a.id}. Spend ${prop.ask_price} ${a.cur}?`)) return;
    $('c-dsign').disabled = true; say('c-d-trade', 'Signing… do not tap again.');
    try { const [, b] = await deriv([{ buy: prop.id, price: prop.ask_price }]); const z = b.buy; say('c-d-trade', `✔ Bought contract ${z.contract_id}\nCost ${z.buy_price} · payout ${z.payout}\nBalance now ${z.balance_after}`); ld.dAcct.bal = z.balance_after; save(); showD(); ctx.hist('Deriv ' + (a.demo ? 'DEMO' : 'REAL') + ' contract ' + z.contract_id); }
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
    ld.bKey = k; ld.bSec = s; ld.bTest = $('c-bm').value === 'test'; $('c-bk').value = ''; $('c-bs').value = ''; say('c-b-out', 'Connecting…');
    try {
      const t = await (await fetch(bBase() + '/api/v3/time')).json(); off = t.serverTime - Date.now();
      const a = await bCall('GET', '/api/v3/account', {}), bal = a.balances.filter(x => +x.free > 0 || +x.locked > 0).slice(0, 8).map(x => `${x.asset} ${(+x.free).toFixed(6)}`);
      ld.bOk = true; save(); say('c-b-out', `✔ Binance ${ld.bTest ? 'TESTNET (demo)' : 'LIVE (real)'} · trading ${a.canTrade ? 'allowed' : 'NOT allowed'}\n${bal.join('\n') || 'No balances'}\nKey ${mask(k)}`);
      $('c-b-tag').textContent = ld.bTest ? 'DEMO' : 'REAL'; $('c-b-tag').className = 'tag ' + (ld.bTest ? 'ok' : 'bad');
    } catch (e) { say('c-b-out', '✖ ' + e.message); }
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
    $('c-sigb').onclick = async () => { const s = sig; if (!s) return; rt.seen.add(s.key); rt.last[s.cand.symbol] = Date.now(); rt.orders++; $('c-sigb').disabled = true;
      try { const o = await bOrder('BUY', s.cand.symbol, s.usdt, true); el.textContent = `✔ ${o.status} ${o.symbol} ${o.executedQty}`; bConnect(); } catch (e) { el.textContent = '✖ ' + e.message; } };
  }

  /* ---------- UI ---------- */
  const F = (id, label, extra = '') => `<label>${label}<input id="${id}" autocomplete="off" ${extra}></label>`;
  function build() {
    const sec = document.createElement('section'); sec.id = 'view-connect'; sec.className = 'view';
    sec.innerHTML = `<div class="page-head"><div><div class="eyebrow">In-app</div><h1>Connect</h1><p class="muted">Paste a key, tap Connect, see the balance. Demo and real are labelled. Orders need your tap to sign.</p></div></div>
<div class="card form"><div class="card-title"><div><div class="eyebrow">AI</div><h3>Grok / AI key</h3></div></div><div class="fields">${F('c-ai', 'API key (auto-detected)', 'type="password"')}<label>Model<select id="c-ai-model"></select></label></div>
<div class="row"><button id="c-ai-go" class="btn primary">Test key</button></div><pre id="c-ai-out" class="out">${ld.ai ? 'Saved: ' + ld.aiName + ' ' + mask(ld.ai) : 'Not connected.'}</pre></div>
<div class="card form"><div class="card-title"><div><div class="eyebrow">Contracts</div><h3>Deriv</h3></div><span id="c-d-tag" class="tag">—</span></div><div class="fields">${F('c-dtok', 'API token (trade scope)', 'type="password"')}${F('c-dapp', 'App ID', 'value="1089"')}</div>
<div class="row"><button id="c-d-go" class="btn primary">Connect</button></div><pre id="c-d-out" class="out">Not connected.</pre>
<div class="fields">${F('c-dsy', 'Symbol', 'value="R_100"')}<label>Type<select id="c-dty"><option value="CALL">CALL (up)</option><option value="PUT">PUT (down)</option></select></label>${F('c-dst', 'Stake', 'type="number" value="1" min="0.35" step="0.01"')}${F('c-ddu', 'Duration', 'type="number" value="5" min="1"')}<label>Unit<select id="c-dun"><option value="t">ticks</option><option value="m">minutes</option></select></label></div>
<div class="row"><button id="c-dq" class="btn">Get price</button><button id="c-dsign" class="btn primary" disabled>Sign contract</button></div><pre id="c-d-trade" class="out"></pre></div>
<div class="card form"><div class="card-title"><div><div class="eyebrow">Spot</div><h3>Binance</h3></div><span id="c-b-tag" class="tag">—</span></div><div class="fields">${F('c-bk', 'API key', 'type="password"')}${F('c-bs', 'Secret', 'type="password"')}<label>Account<select id="c-bm"><option value="test">Testnet (demo)</option><option value="live">Live (real)</option></select></label></div>
<div class="row"><button id="c-b-go" class="btn primary">Connect</button></div><pre id="c-b-out" class="out">Not connected.</pre>
<div class="fields">${F('c-bsy', 'Symbol', 'value="BTCUSDT"')}${F('c-bam', 'BUY: USDT to spend · SELL: coin quantity', 'type="number" value="10" step="any"')}</div>
<div class="row"><button id="c-bb" class="btn primary">Sign BUY</button><button id="c-bsl" class="btn danger">Sign SELL</button></div><pre id="c-b-trade" class="out"></pre>
<div class="card-title"><div><div class="eyebrow">From the Auto scanner</div><h3>Signal to sign</h3></div></div><div id="c-sig"><div class="empty">Start Auto (with Binance connected) to see signals.</div></div></div>
<div class="card form"><label class="check"><input id="c-rem" type="checkbox"> Remember keys on this phone</label><p class="muted small">Stored unencrypted in this app's storage. Never uploaded. Untick to wipe. Use trade-only keys with NO withdrawal permission.</p><div class="row"><button id="c-wipe" class="btn danger">Forget all keys</button></div></div>`;
    document.querySelector('main').insertBefore(sec, document.querySelector('footer'));
    const b = document.createElement('button'); b.dataset.view = 'connect'; b.innerHTML = '<b>🔑</b>Connect'; const tb = document.getElementById('tabbar'); tb.insertBefore(b, tb.children[1] || null);
    b.onclick = () => { document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-connect')); document.querySelectorAll('#tabbar button').forEach(x => x.classList.toggle('active', x === b)); window.scrollTo({ top: 0 }); };
    $('c-rem').checked = !!ld.remember; $('c-bm').value = ld.bTest === false ? 'live' : 'test';
    $('c-ai-go').onclick = aiTest; $('c-d-go').onclick = dConnect; $('c-dq').onclick = dQuote; $('c-dsign').onclick = dSign;
    $('c-b-go').onclick = bConnect; $('c-bb').onclick = () => bManual('BUY'); $('c-bsl').onclick = () => bManual('SELL');
    $('c-rem').onchange = e => { ld.remember = e.target.checked; save(); };
    $('c-wipe').onclick = () => { ld = {}; try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); };
    if (ld.dAcct) showD(); if (ld.bOk) say('c-b-out', 'Saved key ' + mask(ld.bKey) + '. Tap Connect to refresh the balance.');
  }
  function init(c) { ctx = c; ctx.hist = c.hist || (() => {}); build(); }
  window.TB = window.TB || {}; window.TB.live = { init, onScan, ask, hasAI: () => !!ld.ai };
})();
