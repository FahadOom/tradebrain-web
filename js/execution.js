/* TradeBrain · broker console. Secrets go to the local backend and are cleared from the fields immediately. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let ctx = null, history = [];
  const runtime = { seen: new Set(), last: {}, orders: 0, busy: false };

  const say = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  const broker = () => $('x-broker').value;
  const base = () => ctx.S().backendUrl;
  const clientId = () => 'TB' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 7).toUpperCase();

  async function api(path, opts = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    let res;
    try { res = await fetch(base() + path, { cache: 'no-store', signal: ctl.signal, ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } }); }
    catch (e) { throw new Error(e.name === 'AbortError' ? 'Backend timed out. The order may or may not have been placed: check the broker before retrying.' : 'Backend not reachable. Start it on 127.0.0.1:8001 (see backend/README.md).'); }
    finally { clearTimeout(timer); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data));
    return data;
  }

  function showFields() {
    const b = broker(), show = (id, on) => { $(id).hidden = !on; };
    show('x-key-l', b !== 'mt5'); show('x-sec-l', b === 'binance'); show('x-app-l', b === 'deriv');
    show('o-type-l', b === 'binance'); show('o-price-l', b === 'binance');
    show('o-sl-l', b === 'mt5'); show('o-tp-l', b === 'mt5');
    ['o-dur-l', 'o-unit-l', 'o-cur-l', 'o-max-l'].forEach(id => show(id, b === 'deriv'));
    $('o-symbol').value = b === 'mt5' ? 'XAUUSD' : b === 'deriv' ? 'R_100' : 'BTCUSDT';
    $('o-qty').value = b === 'mt5' ? '0.01' : b === 'deriv' ? '1' : '0.0001';
    $('o-qty-t').textContent = b === 'mt5' ? 'Volume (lots)' : b === 'deriv' ? 'Stake' : 'Quantity (base asset)';
    $('o-side').innerHTML = b === 'deriv' ? '<option value="BUY">CALL (BUY)</option><option value="SELL">PUT (SELL)</option>' : '<option>BUY</option><option>SELL</option>';
    $('x-mode').disabled = b === 'mt5';
    $('x-connect').textContent = b === 'mt5' ? 'Check terminal' : 'Connect';
  }

  function renderHistory(rows) {
    const el = $('x-history');
    el.replaceChildren();
    if (!rows || !rows.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = 'None this session.'; el.append(d); return; }
    rows.slice(-20).reverse().forEach(r => {
      const item = document.createElement('div'); item.className = 'item';
      const t = document.createElement('b'); t.textContent = `${r.broker || ''} · ${r.symbol || ''} · ${r.side || ''} · ${r.status || r.retcode || 'response'}`;
      const p = document.createElement('p'); p.className = 'muted small'; p.textContent = JSON.stringify(r);
      item.append(t, p); el.append(item);
    });
  }

  async function refresh() {
    try {
      const d = await api('/api/execution/status');
      const lines = [`Engine: ${d.execution_engine}`, `MT5 module: ${d.mt5_module_available ? 'available' : 'not installed'}`, `Orders this run: ${d.orders_recorded}`];
      Object.entries(d.credentials || {}).forEach(([b, c]) => lines.push(`${b}: ${c.account_mode}, key ${c.api_key_masked || 'set'}`));
      Object.entries(d.armed || {}).forEach(([b, a]) => lines.push(`${b}: ${a ? 'ARMED' : 'disarmed'}`));
      say('x-status', lines.join('\n'));
      if (d.orders) renderHistory(d.orders);
      return d;
    } catch (e) { say('x-status', e.message); return null; }
  }

  async function connect() {
    const b = broker();
    if (b === 'mt5') return check();
    const body = { broker: b, account_mode: $('x-mode').value, api_key: $('x-key').value.trim(), api_secret: $('x-secret').value.trim(), app_id: $('x-app').value.trim() };
    if (!body.api_key) return say('x-status', 'Paste the API key or token first.');
    try {
      const d = await api('/api/execution/credentials', { method: 'POST', body: JSON.stringify(body) });
      ['x-key', 'x-secret', 'x-app'].forEach(id => { $(id).value = ''; });
      say('x-status', `${d.broker} accepted into backend memory only. Mode: ${d.account_mode}. Not armed.`);
      await refresh();
    } catch (e) { say('x-status', e.message); }
  }

  async function check() {
    say('x-account', 'Checking…');
    try { say('x-account', JSON.stringify(await api(`/api/execution/${broker()}/account`), null, 2)); }
    catch (e) { say('x-account', e.message); }
  }

  async function arm() {
    try {
      const d = await api('/api/execution/arm', { method: 'POST', body: JSON.stringify({ broker: broker(), confirmation: $('x-confirm').value.trim() }) });
      $('x-confirm').value = ''; say('x-status', `${d.broker} ${d.account_mode || ''} ARMED. ${d.warning || ''}`); ctx.toast('Armed'); await refresh();
    } catch (e) { say('x-status', e.message); }
  }
  async function disarm() {
    try { const d = await api('/api/execution/disarm', { method: 'POST', body: JSON.stringify({ broker: broker(), confirmation: 'DISARM' }) }); say('x-status', `${d.broker} disarmed. ${d.message}`); await refresh(); }
    catch (e) { say('x-status', e.message); }
  }

  function payloadFor(b, symbol, side, qty, extra = {}) {
    if (b === 'binance') return ['/api/execution/binance/order', { symbol: symbol.toUpperCase(), side, order_type: extra.type || 'MARKET', quantity: qty, price: extra.price, client_order_id: clientId() }];
    if (b === 'mt5') return ['/api/execution/mt5/order', { symbol, side, volume: qty, stop_loss: extra.sl, take_profit: extra.tp, deviation: 20, comment: 'TradeBrain' }];
    return ['/api/execution/deriv/order', { symbol, side, amount: qty, currency: ($('o-cur').value || 'USD').toUpperCase(), duration: Number($('o-dur').value) || 5, duration_unit: $('o-unit').value, max_price: Number($('o-max').value) || 1, client_order_id: clientId() }];
  }

  async function sendManual() {
    const b = broker(), symbol = $('o-symbol').value.trim(), qty = Number($('o-qty').value);
    if (!symbol || !(qty > 0)) return say('o-out', 'Enter a symbol and a positive size.');
    const extra = { type: $('o-type').value, price: $('o-price').value ? Number($('o-price').value) : undefined, sl: Number($('o-sl').value), tp: Number($('o-tp').value) };
    if (b === 'binance' && extra.type === 'LIMIT' && !(extra.price > 0)) return say('o-out', 'LIMIT orders need a price.');
    const [path, body] = payloadFor(b, symbol, $('o-side').value, qty, extra);
    $('o-send').disabled = true; say('o-out', 'Sending… do not tap again.');
    try { const d = await api(path, { method: 'POST', body: JSON.stringify(body) }); say('o-out', JSON.stringify(d, null, 2)); if (d.order) { history.push(d.order); renderHistory(history); } await refresh(); }
    catch (e) { say('o-out', e.message + '\nIf this was a timeout, check the broker history before retrying.'); }
    finally { $('o-send').disabled = false; }
  }

  /** Called after every scan while the loop runs. Evaluates the gates and sends at most one order. */
  async function onScan(results) {
    const S = ctx.S();
    if (!S.autoOn || runtime.busy) return;
    const b = broker(), symbol = $('o-symbol').value.trim().toUpperCase();
    const cand = results.find(r => r.symbol === symbol);
    runtime.busy = true;
    try {
      const st = await api('/api/execution/status');
      const council = cand ? ctx.council(cand) : null;
      const g = TB.gates.evaluate({ cand, council, S, symbol, broker: b, accountMode: st.credentials?.[b]?.account_mode, armed: !!st.armed?.[b], runtime });
      ctx.autoLog(g.ok ? 'SEND  ' + g.why : 'SKIP  ' + g.why);
      if (!g.ok) return;
      const manual = Number($('o-qty').value);
      if (!(manual > 0)) return ctx.autoLog('SKIP  size must be positive.');
      // Hybrid sizing: risk budget / stop distance, never above the size typed in the order box (the manual cap).
      let qty = manual;
      if (b === 'binance') {
        const h = TB.sizing.hybrid({ equity: S.now, riskPct: S.riskPct, stopDist: cand.stopDist, price: cand.price, manualCap: manual });
        if (!h.ok) return ctx.autoLog('SKIP  sizing: ' + h.why);
        qty = h.qty; ctx.autoLog(`SIZE  ${h.qty} (risk $${h.riskCash.toFixed(2)}, stop ${cand.stopDist.toFixed(4)}, cap ${manual})`);
      }
      let extra = {};
      if (b === 'mt5') {
        const sl = cand.signal === 'BUY' ? cand.price - cand.stopDist : cand.price + cand.stopDist;
        const tp = cand.signal === 'BUY' ? cand.price + cand.targetDist : cand.price - cand.targetDist;
        if (!(sl > 0 && tp > 0)) return ctx.autoLog('SKIP  invalid stop or target.');
        extra = { sl, tp };
      }
      runtime.seen.add(g.key); if (runtime.seen.size > 1000) runtime.seen.delete(runtime.seen.values().next().value);
      runtime.last[cand.symbol] = Date.now();
      const [path, body] = payloadFor(b, symbol, cand.signal, qty, extra);
      const d = await api(path, { method: 'POST', body: JSON.stringify(body) });
      runtime.orders++; ctx.onOrder(runtime.orders);
      if (d.order) { history.push(d.order); renderHistory(history); }
      ctx.autoLog(`SENT  response: ${JSON.stringify(d.order || d).slice(0, 200)}`);
      await refresh();
    } catch (e) { ctx.autoLog('ERROR ' + e.message + ' (check broker history before retrying)'); }
    finally { runtime.busy = false; }
  }

  function init(c) {
    ctx = c;
    $('x-broker').addEventListener('change', showFields);
    $('x-connect').addEventListener('click', connect); $('x-check').addEventListener('click', check); $('x-refresh').addEventListener('click', refresh);
    $('x-arm').addEventListener('click', arm); $('x-disarm').addEventListener('click', disarm); $('o-send').addEventListener('click', sendManual);
    showFields();
  }
  window.TB = window.TB || {};
  window.TB.exec = { init, onScan, refresh, api, runtime };
})();
