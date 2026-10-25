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
  /* ------------------------------------------------------------------ Deriv multipliers ------------------------------------------------------------------
     A multiplier contract behaves like a leveraged CFD: stake S, multiplier m, exposure S*m, profit = exposure * price change. Deriv holds the stop-loss and take-profit
     (limit_order) on its servers, so they work even if this app is closed. Closing early = `sell`. Contracts that Deriv closed by itself are found by poll().
     api = { ready(), acct(), send(msg), kind(), refresh() }.   Not every market offers multipliers; those are refused with a clear reason.            */
  function deriv(cfg) {
    const api = cfg.api, cinfo = new Map(), r2 = v => Math.round(v * 100) / 100;
    const E = { info: { name: 'deriv', label: 'Deriv multipliers', live: true, longOnly: false, minNotional: 1 }, async: true };
    const acct = () => api.acct() || {};
    Object.defineProperty(E.info, 'label', { get: () => `Deriv ${acct().demo === false ? 'REAL' : 'DEMO'} multipliers`, enumerable: true });
    E.step = () => 1e-6;
    const symKey = () => (api.kind() === 'legacy' ? 'symbol' : 'underlying_symbol');
    async function withSym(msg, symbol) {
      try { return await api.send({ ...msg, [symKey()]: symbol }); }
      catch (e) { if (!/underlying_symbol|symbol|not.*valid|unrecognised|unknown/i.test(e.message)) throw e; const alt = symKey() === 'symbol' ? 'underlying_symbol' : 'symbol'; return api.send({ ...msg, [alt]: symbol }); }
    }
    /** Multipliers Deriv offers on this market for this account, and whether both directions exist. */
    E.prepare = async symbol => {
      if (cinfo.has(symbol)) return cinfo.get(symbol);
      let r; try { r = await api.send({ contracts_for: symbol, currency: acct().cur || 'USD', product_type: 'basic' }); } catch (e) { throw new Error(`Deriv could not list contracts for ${symbol}: ${e.message}`); }
      const av = (r.contracts_for && r.contracts_for.available) || [], up = av.find(c => c.contract_type === 'MULTUP'), dn = av.find(c => c.contract_type === 'MULTDOWN');
      if (!up && !dn) throw new Error(`${symbol} has no multiplier contracts on this Deriv account.`);
      const range = c => (c && (c.multiplier_range || []).map(Number).filter(n => n > 0)) || [];
      const i = { up: range(up).sort((a, b) => a - b), dn: range(dn).sort((a, b) => a - b), minNotional: 1 }; cinfo.set(symbol, i); return i;
    };
    E.equity = async positions => {
      if (!api.ready()) return { equity: 0, cash: 0, known: false };
      try {
        const a = await api.refresh(), bal = +a.bal, held = positions.reduce((t, p) => t + ((p.ex && p.ex.stake) || 0) + (p.upnl || 0), 0);
        return { equity: bal + held, cash: bal, known: Number.isFinite(bal), canTrade: true };
      } catch (e) { return { equity: 0, cash: 0, known: false, error: e.message }; }
    };
    E.open = async o => {
      if (!api.ready()) throw new Error('Connect Deriv first.');
      const i = await E.prepare(o.symbol), allowed = o.side === 'BUY' ? i.up : i.dn;
      if (!allowed.length) throw new Error(`${o.symbol} does not offer ${o.side === 'BUY' ? 'MULTUP (buy)' : 'MULTDOWN (sell)'} contracts.`);
      const stopDist = Math.abs(o.price - o.stop), tpDist = Math.abs(o.target - o.price), maxM = 0.8 * o.price / stopDist;
      const m = allowed.filter(x => x <= maxM).pop();
      if (!m) throw new Error(`Stop is too tight/wide for Deriv multipliers on ${o.symbol}: the smallest allowed multiplier x${allowed[0]} would let Deriv stop the contract out before the planned stop.`);
      const exposure = o.qty * o.price, stake = Math.floor(exposure / m * 100) / 100;
      if (stake < 1) throw new Error(`Stake $${stake.toFixed(2)} is below Deriv's minimum of about $1 for ${o.symbol} (exposure $${exposure.toFixed(2)} at x${m}). Raise the risk budget or use a manual size.`);
      const qty = stake * m / o.price, sl = r2(qty * stopDist), tp = r2(qty * tpDist);
      if (!(sl > 0) || !(tp > 0)) throw new Error('Stop-loss or take-profit amount rounds to zero.');
      const req = { proposal: 1, amount: stake, basis: 'stake', contract_type: o.side === 'BUY' ? 'MULTUP' : 'MULTDOWN', currency: acct().cur || 'USD', multiplier: m, limit_order: { stop_loss: sl, take_profit: tp } };
      let prop; try { prop = (await withSym(req, o.symbol)).proposal; } catch (e) { throw new Error('Deriv refused the proposal: ' + e.message); }
      if (!prop || !prop.id) throw new Error('Deriv returned no proposal.');
      let b;
      try { b = (await api.send({ buy: prop.id, price: +prop.ask_price || stake })).buy; }
      catch (e) { const err = new Error(e.message); err.uncertain = /did not answer|socket (is )?closed|timed out/i.test(e.message); throw err; }
      let entry = o.price; try { const c = (await api.send({ proposal_open_contract: 1, contract_id: b.contract_id })).proposal_open_contract; const es = +(c.entry_spot || c.entry_tick || c.current_spot); if (es > 0) entry = es; } catch (e) { /* keep the planned entry */ }
      const q = stake * m / entry, fee = +(prop.commission || 0);
      return { ok: true, price: entry, qty: q, fee, id: String(b.contract_id), extra: { contractId: b.contract_id, stake, multiplier: m, sl, tp } };
    };
    const profitToPrice = (pos, profit) => { const d = pos.side === 'BUY' ? 1 : -1; return pos.entry + d * profit / pos.qty; };
    E.close = async (pos, price, reason) => {
      const cid = pos.ex && pos.ex.contractId; if (!cid) throw Object.assign(new Error('No Deriv contract id on this position.'), { recon: true });
      let r;
      try { r = (await api.send({ sell: cid, price: 0 })).sell; }
      catch (e) {
        if (/already|sold|expired|not.*found|cannot be sold/i.test(e.message)) { const c = await E.poll([pos]); if (c.length) return { ok: true, price: c[0].price, qty: pos.qty, fee: 0, id: String(cid), external: true }; }
        const err = new Error(e.message); err.uncertain = /did not answer|socket (is )?closed|timed out/i.test(e.message); throw err;
      }
      const profit = +r.sold_for - ((pos.ex && pos.ex.stake) || 0);
      return { ok: true, price: profitToPrice(pos, profit), qty: pos.qty, fee: 0, id: String(r.transaction_id || cid) };
    };
    /** Contracts that Deriv already closed (its stop-loss / take-profit / expiry). Also refreshes marks. Returns [{id, price, reason, profit}]. */
    E.poll = async positions => {
      const done = [];
      for (const p of positions) {
        const cid = p.ex && p.ex.contractId; if (!cid) continue;
        try {
          const c = (await api.send({ proposal_open_contract: 1, contract_id: cid })).proposal_open_contract; if (!c) continue;
          if (+c.current_spot > 0) p.mark = +c.current_spot;
          if (c.is_sold || c.status === 'sold' || c.is_expired) { const profit = +c.profit; done.push({ id: p.id, profit, price: profitToPrice(p, profit), reason: profit >= 0 ? 'take-profit (Deriv)' : 'stop-loss (Deriv)' }); }
        } catch (e) { /* try again next time */ }
      }
      return done;
    };
    E.price = async symbols => (cfg.prices ? cfg.prices(symbols) : {});
    E.lookup = async (clientId, symbol) => {      // Deriv has no client order id: a very recent multiplier contract on this market is treated as the unconfirmed order
      try {
        const r = await api.send({ portfolio: 1, contract_type: ['MULTUP', 'MULTDOWN'] }), list = (r.portfolio && r.portfolio.contracts) || [], c = list.filter(x => (x.underlying_symbol || x.symbol) === symbol).sort((a, b) => b.purchase_time - a.purchase_time)[0];
        if (!c || Date.now() / 1000 - c.purchase_time > 180) return null;
        const d = (await api.send({ proposal_open_contract: 1, contract_id: c.contract_id })).proposal_open_contract, entry = +(d.entry_spot || d.entry_tick), stake = +d.buy_price, m = +(d.multiplier || (d.limit_order && d.multiplier));
        if (!(entry > 0) || !(stake > 0) || !(m > 0)) return null;
        return { ok: true, price: entry, qty: stake * m / entry, fee: 0, id: String(c.contract_id), extra: { contractId: c.contract_id, stake, multiplier: m } };
      } catch (e) { return null; }
    };
    E.reconcile = async positions => {
      const issues = [];
      try { const r = await api.send({ portfolio: 1, contract_type: ['MULTUP', 'MULTDOWN'] }), ids = new Set(((r.portfolio && r.portfolio.contracts) || []).map(c => String(c.contract_id))); positions.forEach(p => { if (p.ex && !ids.has(String(p.ex.contractId))) issues.push(`${p.symbol}: contract ${p.ex.contractId} is not open on Deriv any more.`); }); }
      catch (e) { issues.push('Could not read the Deriv portfolio: ' + e.message); }
      return { ok: !issues.length, issues };
    };
    return E;
  }
  return { paper, binance, deriv };
});
