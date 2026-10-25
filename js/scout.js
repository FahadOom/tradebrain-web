/* TradeBrain · MADBOT scout. Sweeps the markets of the connected broker (not only the watchlist), asks the AI which ones look promising for scalping,
   and falls back in two steps when the AI is down: (1) the second AI key (handled by TB.live failover), (2) a rule-based backup analyst.
   The result is a short list of markets the controller then scalps aggressively. Pure orchestration: data and AI are injected, so it is testable. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else { root.TB = root.TB || {}; root.TB.scout = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Order the universe so every asset group is represented before the cap cuts the list. */
  function universe(markets, watch, cap) {
    const open = markets.filter(m => m.open !== false), byGroup = new Map();
    open.forEach(m => { if (!byGroup.has(m.group)) byGroup.set(m.group, []); byGroup.get(m.group).push(m); });
    const out = [], seen = new Set(), add = m => { if (m && !seen.has(m.symbol) && out.length < cap) { seen.add(m.symbol); out.push(m); } };
    watch.forEach(w => add(open.find(m => m.symbol === w)));
    for (let i = 0; out.length < cap; i++) { let any = false; for (const g of byGroup.values()) { if (g[i]) { any = true; add(g[i]); } } if (!any) break; }
    return out;
  }

  /** One compact row per market, from the cheap scanner read. */
  function row(m, r) {
    const atrPct = r.atr && r.price ? +(r.atr / r.price * 100).toFixed(3) : null;
    return { symbol: m.symbol, group: m.group, price: +Number(r.price).toPrecision(6), main_signal: r.signal, score: r.score, trend: r.trend, rsi: r.rsi == null ? null : +r.rsi.toFixed(1), efficiency: r.eff == null ? null : +r.eff.toFixed(2), atr_pct: atrPct };
  }

  /** The rule-based backup analyst: rewards a directional, efficient, adequately volatile market; ignores chop and dead markets. */
  function backupRank(table, top) {
    const sc = t => {
      if (t.efficiency == null || t.atr_pct == null) return -1;
      let s = (t.efficiency || 0) * 50 + Math.min(t.score || 0, 100) * 0.3;
      if (t.main_signal !== 'WAIT') s += 15;
      if (t.atr_pct < 0.03) s -= 25;           // too quiet to cover costs
      if (t.atr_pct > 3) s -= 15;              // too wild
      if (t.rsi != null && (t.rsi > 78 || t.rsi < 22)) s -= 10;
      return s;
    };
    return table.map(t => ({ t, s: sc(t) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, top)
      .map(x => ({ symbol: x.t.symbol, bias: x.t.main_signal !== 'WAIT' ? x.t.main_signal : x.t.trend === 'Bullish' ? 'BUY' : x.t.trend === 'Bearish' ? 'SELL' : 'WAIT', why: `efficiency ${x.t.efficiency}, ATR ${x.t.atr_pct}%, score ${x.t.score}` }));
  }

  /**
   * env: { markets():Promise<[]>, watch:[], cap, top, tf, scan(symbols, tf, onProgress) -> {results, errors}, brain:{scout(table, top)}, backup:boolean, aiAvailable():boolean, now() }
   * Returns { at, by: 'AI'|'backup'|'rules', picks:[{symbol,bias,why}], swept, table, note, aiErrors }
   */
  async function run(env) {
    const markets = await env.markets(), uni = universe(markets, env.watch || [], env.cap || 40), byS = new Map(uni.map(m => [m.symbol, m]));
    const out = await env.scan(uni.map(m => m.symbol), env.tf, env.onProgress), table = out.results.map(r => row(byS.get(r.symbol) || { symbol: r.symbol, group: '' }, r));
    const res = { at: env.now ? env.now() : Date.now(), swept: uni.length, read: table.length, table, picks: [], by: 'rules', note: '', aiErrors: [] };
    if (!table.length) { res.note = 'No candles could be read: ' + (out.errors[0] || 'no data'); return res; }
    if (env.aiAvailable && env.aiAvailable() && env.brain) {
      const rv = await env.brain.scout(table, env.top || 6);
      if (rv.ok) { res.picks = rv.picks; res.by = 'AI'; res.note = rv.note; return res; }
      res.aiErrors = rv.errors || [];
    } else res.aiErrors = ['No AI key is connected.'];
    if (env.backup !== false) { res.picks = backupRank(table, env.top || 6); res.by = 'backup'; res.note = 'AI unavailable (' + res.aiErrors.join(' ').slice(0, 120) + '): the backup analyst ranked the markets by rules.'; }
    else res.note = 'AI unavailable and the backup analyst is off: no markets picked.';
    return res;
  }
  return { run, universe, backupRank, row };
});
