/* TradeBrain · market data layer. Markets, candles and prices come ONLY from a connected broker:
     Deriv connected            -> Deriv   (more markets: forex, indices, commodities, crypto, synthetics)
     only Binance connected     -> Binance
     both connected             -> Deriv   (unless you pick Binance on the Auto screen, or the Binance executor is active: Binance cannot trade Deriv symbols)
     nothing connected          -> no markets, no charts, no signals (same idea as a desktop terminal that is not logged in)
   Deriv candles have no volume (v = null). Closed or suspended Deriv markets are marked and skipped.                                              */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else { root.TB = root.TB || {}; root.TB.data = api.create({ lazy: true }); root.TB.dataFactory = api; if (root.TB.scanner && root.TB.scanner.setProvider) root.TB.scanner.setProvider((sym, tf, closed) => root.TB.data.candles(sym, tf, { closedOnly: closed })); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const R = typeof self !== 'undefined' ? self : globalThis;
  const GRAN = { '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '8h': 28800, '1d': 86400 };
  const TF_MS = Object.fromEntries(Object.entries(GRAN).map(([k, v]) => [k, v * 1000]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** Group a Deriv market name into a short label for the Markets screen. */
  const GROUPS = { forex: 'Forex', indices: 'Stock indices', commodities: 'Commodities', cryptocurrency: 'Crypto', synthetic_index: 'Synthetic indices', stocks: 'Stocks', basket_index: 'Baskets', volidx: 'Synthetic indices' };

  function create(opts = {}) {
    const env = () => (opts.env ? opts.env() : (opts.lazy ? { deriv: R.TB && R.TB.live && R.TB.live.deriv, binance: R.TB && R.TB.live && R.TB.live.binance, S: R.TB && R.TB.app && R.TB.app.S, execName: R.TB && R.TB.ui2 && R.TB.ui2.execName } : {}));
    const now = () => (opts.now ? opts.now() : Date.now());
    const cache = new Map(), inflight = new Map(); let mk = { id: null, t: 0, list: null, p: null };
    const queue = { active: 0, last: 0 };

    /** Run async work with at most `max` in flight and a minimum gap between starts, so a scan of dozens of markets cannot trip the broker's rate limit. */
    async function limited(fn, max = 3, gap = 90) {
      while (queue.active >= max) await sleep(25);
      queue.active++;
      try { const wait = queue.last + gap - Date.now(); if (wait > 0) await sleep(wait); queue.last = Date.now(); return await fn(); }
      finally { queue.active--; }
    }

    /* ---------------- which broker feeds the app ---------------- */
    function connected() { const e = env(); return { deriv: !!(e.deriv && e.deriv.ready()), binance: !!(e.binance && (e.binance.live ? e.binance.live() : e.binance.ready())) }; }
    function source() {
      const e = env(), c = connected(), pref = e.S && e.S() ? e.S().sourcePref : 'auto', ex = e.execName ? e.execName() : 'paper';
      let id = null;
      if (ex === 'binance' && c.binance) id = 'binance';                     // Binance cannot trade Deriv symbols, so data must match the executor
      else if (ex === 'deriv' && c.deriv) id = 'deriv';
      else if (pref === 'binance' && c.binance) id = 'binance';
      else if (pref === 'deriv' && c.deriv) id = 'deriv';
      else if (c.deriv) id = 'deriv';
      else if (c.binance) id = 'binance';
      if (!id) return null;
      const reason = ex === 'binance' && c.binance && c.deriv ? 'Binance executor is active' : c.deriv && c.binance ? (pref === 'binance' ? 'you chose Binance' : 'both connected: Deriv has more markets') : 'only broker connected';
      return { id, label: id === 'deriv' ? 'Deriv' : 'Binance', reason, both: c.deriv && c.binance };
    }
    const ready = () => !!source();
    const need = () => { const s = source(); if (!s) throw new Error('No broker connected. Connect Deriv or Binance first (Connect tab).'); return s; };
    const watchKey = () => { const s = source(); return s && s.id === 'deriv' ? 'watchD' : 'watch'; };
    const getWatch = S => (S[watchKey()] || []);

    /* ---------------- markets ---------------- */
    async function derivMarkets() {
      const d = env().deriv, r = await limited(() => d.send({ active_symbols: 'brief', product_type: 'basic' }), 1, 0), out = [];
      (r.active_symbols || []).forEach(x => {
        const symbol = x.underlying_symbol || x.symbol; if (!symbol) return;
        const open = x.exchange_is_open !== 0 && x.exchange_is_open !== false && !(x.is_trading_suspended === 1 || x.is_trading_suspended === true);
        out.push({ symbol, name: x.display_name || x.underlying_symbol_name || symbol, group: GROUPS[x.market] || x.market_display_name || x.market || 'Other', sub: x.submarket_display_name || x.submarket || '', open, base: symbol });
      });
      return out.sort((a, b) => (b.open - a.open) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
    }
    async function binanceMarkets() {
      const b = env().binance, info = await b.pub('/api/v3/exchangeInfo'); let vol = {};
      try { (await b.pub('/api/v3/ticker/24hr')).forEach(t => { vol[t.symbol] = +t.quoteVolume || 0; }); } catch (e) { vol = {}; }
      return info.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.isSpotTradingAllowed !== false && !/(UP|DOWN|BULL|BEAR)USDT$/.test(s.symbol))
        .map(s => ({ symbol: s.symbol, name: s.baseAsset + '/USDT', group: 'Crypto (spot)', sub: '', open: true, base: s.baseAsset, vol: vol[s.symbol] || 0 })).sort((a, b) => b.vol - a.vol);
    }
    /** Every market the connected broker offers. Cached for 10 minutes; refreshed when the source changes. */
    async function markets(force) {
      const s = need();
      if (!force && mk.id === s.id && mk.list && now() - mk.t < 600e3) return mk.list;
      if (mk.p && mk.id === s.id && !force) return mk.p;
      mk = { id: s.id, t: 0, list: null, p: null };
      const p = (s.id === 'deriv' ? derivMarkets() : binanceMarkets()).then(l => { mk.list = l; mk.t = now(); mk.p = null; return l; }, e => { mk.p = null; throw e; });
      mk.p = p; return p;
    }
    const known = symbol => (mk.list || []).find(m => m.symbol === symbol) || null;
    const isOpen = symbol => { const m = known(symbol); return !m || m.open !== false; };

    /** First-run watchlist for a broker: a handful of open, liquid markets so the screen is not empty. */
    function defaultWatch(list, id) {
      const open = list.filter(m => m.open);
      if (id === 'binance') return open.slice(0, 8).map(m => m.symbol);
      const pref = ['R_100', 'R_75', 'R_50', 'frxEURUSD', 'frxGBPUSD', 'frxUSDJPY', 'frxXAUUSD', 'cryBTCUSD', 'cryETHUSD', 'OTC_NDX', 'OTC_SPC'], out = pref.filter(p => open.some(m => m.symbol === p));
      open.forEach(m => { if (out.length < 8 && !out.includes(m.symbol)) out.push(m.symbol); });
      return out.slice(0, 10);
    }

    /* ---------------- candles ---------------- */
    const rowsDeriv = (raw, gran, closedOnly, t0) => {
      let rows = (raw || []).map(k => ({ t: k.epoch * 1000, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: null, closeT: k.epoch * 1000 + gran * 1000 - 1 }));
      if (closedOnly && rows.length && rows[rows.length - 1].closeT > t0) rows = rows.slice(0, -1);
      return rows;
    };
    const rowsBinance = (raw, closedOnly, t0) => {
      let rows = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closeT: k[6] }));
      if (closedOnly && rows.length && rows[rows.length - 1].closeT > t0) rows = rows.slice(0, -1);
      return rows;
    };
    async function candles(symbol, tf, o = {}) {
      const s = need(), closedOnly = o.closedOnly !== false, count = Math.min(o.count || 200, s.id === 'deriv' ? 5000 : 1000), gran = GRAN[tf];
      if (!gran) throw new Error(`${symbol}: timeframe ${tf} is not supported.`);
      const key = [s.id, symbol, tf, count, closedOnly].join('|'), hit = cache.get(key), ttl = o.ttl != null ? o.ttl : Math.min(30e3, gran * 1000 / 4);
      if (hit && now() - hit.t < ttl) return hit.rows;
      if (inflight.has(key)) return inflight.get(key);
      if (s.id === 'deriv' && mk.list && !isOpen(symbol)) throw new Error(`${symbol}: market is closed or suspended.`);
      const p = (async () => {
        let rows;
        const t0 = now();
        if (s.id === 'deriv') {
          const r = await limited(() => env().deriv.send({ ticks_history: symbol, style: 'candles', granularity: gran, count, end: 'latest', adjust_start_time: 1 }));
          rows = rowsDeriv(r.candles, gran, closedOnly, t0);
        } else {
          const raw = await limited(() => env().binance.pub(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&limit=${count}`), 4, 40);
          rows = rowsBinance(raw, closedOnly, t0);
        }
        if (rows.length < (o.min || 60)) throw new Error(`${symbol}: not enough candles (${rows.length}).`);
        cache.set(key, { t: now(), rows }); if (cache.size > 400) cache.delete(cache.keys().next().value);
        return rows;
      })().finally(() => inflight.delete(key));
      inflight.set(key, p); return p;
    }

    /* ---------------- live prices ---------------- */
    async function prices(symbols) {
      const s = source(); if (!s || !symbols.length) return {}; const out = {};
      if (s.id === 'binance') { const d = await env().binance.pub('/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(symbols))); d.forEach(x => { out[x.symbol] = +x.price; }); return out; }
      await Promise.all(symbols.map(async sym => {
        try { const r = await limited(() => env().deriv.send({ ticks_history: sym, style: 'ticks', count: 1, end: 'latest' }), 3, 60), p = r.history && r.history.prices && r.history.prices[r.history.prices.length - 1]; if (p > 0) out[sym] = +p; } catch (e) { /* leave missing: the controller skips it */ }
      }));
      return out;
    }

    return { source, ready, connected, markets, known, isOpen, candles, prices, defaultWatch, watchKey, getWatch, GRAN, TF_MS, _cache: cache, _reset() { cache.clear(); mk = { id: null, t: 0, list: null, p: null }; } };
  }
  return { create, GRAN, TF_MS };
});
