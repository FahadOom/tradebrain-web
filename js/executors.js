/* TradeBrain · order executors. The controller talks to ONE interface, so strategy code never contains broker logic.
     equity(positions) -> {equity, cash, known}      open(order) -> {ok, price, qty, fee, id}      close(pos, price, reason, kind) -> {ok, price, qty, fee, id}
     price(symbols) -> {SYMBOL: price}                lookup(clientId, symbol) -> fill | null       info: {name, label, live, longOnly, minNotional}
   Paper = simulation with realistic costs (fee + adverse slippage). Binance = real Spot orders through the signed in-app API (Testnet or Live). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else { root.TB = root.TB || {}; root.TB.executors = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const floorTo = (v, step) => (step > 0 ? Math.floor(v / step + 1e-9) * step : v);
  const dec = step => { const s = String(step); return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length; };
  const toFixed = (v, step) => (+v).toFixed(Math.min(12, dec(step)));
  const dirOf = side => (side === 'BUY' ? 1 : -1);

  /* ------------------------------------------------------------------ Paper ------------------------------------------------------------------ */
  function paper(cfg) {
    const E = { info: { name: 'paper', label: 'Paper (simulation, live prices)', live: false, longOnly: false, minNotional: 1 }, balance: cfg.balance || 10, n: 0 };
    const fees = () => (cfg.fees ? cfg.fees() : { feePct: 0.1, slipPct: 0.05 });
    E.state = () => ({ balance: E.balance }); E.restore = s => { if (s && Number.isFinite(s.balance)) E.balance = s.balance; }; E.reset = b => { E.balance = b; };
    E.step = () => 1e-6;
    E.equity = async positions => {
      const unreal = positions.reduce((t, p) => t + (p.upnl || 0), 0), used = positions.reduce((t, p) => t + p.qty * p.entry, 0);
      return { equity: E.balance + unreal, cash: E.balance - used, known: true };
    };
    E.open = async o => {
      const { feePct, slipPct } = fees(), fill = o.price * (1 + dirOf(o.side) * slipPct / 100), fee = fill * o.qty * feePct / 100;
      E.balance -= fee; return { ok: true, price: fill, qty: o.qty, fee, id: 'P' + Date.now().toString(36) + (++E.n), simulated: true };
    };
    E.close = async (pos, price, reason, kind) => {
      const { feePct, slipPct } = fees(), limit = kind === 'limit', fill = limit ? price : price * (1 - dirOf(pos.side) * slipPct / 100), fee = fill * pos.qty * feePct / 100;
      E.balance += (fill - pos.entry) * pos.qty * dirOf(pos.side) - fee; return { ok: true, price: fill, qty: pos.qty, fee, id: 'P' + Date.now().toString(36) + (++E.n), simulated: true };
    };
    E.price = async symbols => (cfg.prices ? cfg.prices(symbols) : {});
    E.lookup = async () => null;
    E.reconcile = async () => ({ ok: true, issues: [] });
    return E;
  }

  /* ------------------------------------------------------------------ Binance Spot ------------------------------------------------------------------
     api = { ready(), isTest(), base(), call(method, path, params)  (signed), pub(path)  (unsigned GET) }                                                        */
  function binance(cfg) {
    const api = cfg.api, filters = new Map();
    const E = { info: { name: 'binance', label: 'Binance Spot', live: true, longOnly: true, minNotional: 5 } };
    E.step = sym => (filters.get(sym) || {}).step || 1e-6;
    async function load(symbol) {
      if (filters.has(symbol)) return filters.get(symbol);
      const d = await api.pub('/api/v3/exchangeInfo?symbol=' + encodeURIComponent(symbol)), s = d.symbols && d.symbols[0];
      if (!s || s.status !== 'TRADING') throw new Error(`${symbol} is not trading on this Binance environment.`);
      const lot = s.filters.find(f => f.filterType === 'LOT_SIZE') || {}, mn = s.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') || {}, pf = s.filters.find(f => f.filterType === 'PRICE_FILTER') || {};
      const f = { step: +lot.stepSize || 1e-6, minQty: +lot.minQty || 0, maxQty: +lot.maxQty || Infinity, minNotional: +(mn.minNotional || 5), tick: +pf.tickSize || 0, base: s.baseAsset, quote: s.quoteAsset };
      filters.set(symbol, f); return f;
    }
    E.prepare = async symbol => { const f = await load(symbol); return { step: f.step, minNotional: f.minNotional, minQty: f.minQty }; };
    E.equity = async positions => {
      if (!api.ready()) return { equity: 0, cash: 0, known: false };
      try {
        const a = await api.call('GET', '/api/v3/account', {}), u = a.balances.find(b => b.asset === 'USDT') || { free: 0, locked: 0 }, free = +u.free;
        const held = positions.reduce((t, p) => t + p.qty * (p.mark || p.entry), 0);
        return { equity: free + +u.locked + held, cash: free, known: true, canTrade: !!a.canTrade };
      } catch (e) { return { equity: 0, cash: 0, known: false, error: e.message }; }
    };
    const fillOf = (o, f, price) => {
      const fills = o.fills || [], q = fills.reduce((t, x) => t + +x.qty, 0) || +o.executedQty, quote = fills.reduce((t, x) => t + +x.qty * +x.price, 0) || +o.cummulativeQuoteQty;
      const avg = q ? quote / q : price; let fee = 0, baseFee = 0;
      fills.forEach(x => { const c = +x.commission; if (x.commissionAsset === f.quote) fee += c; else if (x.commissionAsset === f.base) { fee += c * avg; baseFee += c; } else fee += quote * 0.00075 / Math.max(1, fills.length); });
      return { price: avg, qty: +o.executedQty || q, fee, baseFee, id: String(o.orderId), status: o.status };
    };
    E.open = async o => {
      if (o.side !== 'BUY') throw new Error('Binance Spot cannot open a short.');
      if (!api.ready()) throw new Error('Connect Binance first.');
      const f = await load(o.symbol), qty = floorTo(o.qty, f.step);
      if (qty < f.minQty) throw new Error(`Quantity ${qty} is below the minimum ${f.minQty}.`);
      if (qty * o.price < f.minNotional) throw new Error(`Order value $${(qty * o.price).toFixed(2)} is below the Binance minimum $${f.minNotional}.`);
      let r;
      try { r = await api.call('POST', '/api/v3/order', { symbol: o.symbol, side: 'BUY', type: 'MARKET', quantity: toFixed(qty, f.step), newClientOrderId: o.clientId, newOrderRespType: 'FULL' }); }
      catch (e) { const err = new Error(e.message); err.uncertain = !e.status || e.status >= 500 || /timed out|network|failed to fetch/i.test(e.message); err.code = e.code; throw err; }
      const fl = fillOf(r, f, o.price); if (!(fl.qty > 0)) throw Object.assign(new Error(`Order ${r.status}: nothing was filled.`), { uncertain: false });
      const net = floorTo(fl.qty - fl.baseFee, f.step);
      return { ok: true, price: fl.price, qty: net, grossQty: fl.qty, fee: fl.fee, id: fl.id, status: fl.status };
    };
    E.close = async (pos, price) => {
      const f = await load(pos.symbol); let qty = floorTo(pos.qty, f.step);
      const a = await api.call('GET', '/api/v3/account', {}), bal = a.balances.find(b => b.asset === f.base), free = bal ? +bal.free : 0;
      if (free + 1e-12 < qty) { if (free < qty * 0.98) throw Object.assign(new Error(`Only ${free} ${f.base} free but the position needs ${qty}. Reconcile on Binance.`), { recon: true }); qty = floorTo(free, f.step); }
      if (qty < f.minQty || qty * price < f.minNotional) throw Object.assign(new Error(`Remaining ${qty} ${f.base} is below Binance's minimum order; close it manually.`), { recon: true });
      let r; try { r = await api.call('POST', '/api/v3/order', { symbol: pos.symbol, side: 'SELL', type: 'MARKET', quantity: toFixed(qty, f.step), newClientOrderId: 'TBX' + Date.now().toString(36), newOrderRespType: 'FULL' }); }
      catch (e) { const err = new Error(e.message); err.uncertain = !e.status || e.status >= 500; throw err; }
      const fl = fillOf(r, f, price); return { ok: true, price: fl.price, qty: fl.qty, fee: fl.fee, id: fl.id, status: fl.status };
    };
    E.price = async symbols => {
      if (!symbols.length) return {}; const d = await api.pub('/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(symbols))), out = {};
      d.forEach(x => { out[x.symbol] = +x.price; }); return out;
    };
    E.lookup = async (clientId, symbol) => {
      try { const o = await api.call('GET', '/api/v3/order', { symbol, origClientOrderId: clientId }), f = await load(symbol); if (o.status === 'FILLED' || +o.executedQty > 0) { const fl = fillOf({ ...o, fills: [] }, f, +o.price); return { ok: true, price: fl.price, qty: floorTo(+o.executedQty, f.step), fee: 0, id: String(o.orderId), status: o.status }; } return null; }
      catch (e) { if (e.code === -2013) return null; throw e; }
    };
    E.reconcile = async positions => {
      const issues = [];
      try { const a = await api.call('GET', '/api/v3/account', {}); for (const p of positions) { const f = await load(p.symbol), b = a.balances.find(x => x.asset === f.base), have = b ? +b.free + +b.locked : 0; if (have < p.qty * 0.98) issues.push(`${p.symbol}: tracked ${p.qty} but the account holds ${have} ${f.base}.`); } }
      catch (e) { issues.push('Could not read the account: ' + e.message); }
      return { ok: !issues.length, issues };
    };
    return E;
  }
  return { paper, binance };
});
