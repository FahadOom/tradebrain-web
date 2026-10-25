/* TradeBrain · replay tests ("Track record"). Walks forward through recent candles of the connected broker, asks the SAME engine what it would have done at each closed
   candle (using only candles up to that point, so there is no look-ahead), and follows each signal to its stop or target. Fixed stop/target, round-trip costs deducted.
     7-day test : A+ signals on the A+ timeframe        4-hour test : strategy signals on 5m        1-hour test : strategy signals on 1m
   It reports what the rules would have done, not what they will do. Small samples (a handful of signals) prove nothing. */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory();
  if (isNode) module.exports = api; else { root.TB = root.TB || {}; root.TB.backtest = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5 };
  const WINDOWS = {
    A7: { id: 'A7', title: '7-day A+ test', mode: 'aplus', span: 7 * 864e5, tfKey: 'tfA' },
    S4: { id: 'S4', title: '4-hour strategy test', mode: 'normal', span: 4 * 36e5, tf: '5m' },
    S1: { id: 'S1', title: '1-hour strategy test', mode: 'normal', span: 36e5, tf: '1m' },
  };

  /** Follow one signal through later candles. Stop wins a tie inside one candle. Returns { r, kind, bars } (r in R after costs) or { open:true, r } marked to the last close. */
  function follow(candles, from, side, plan, costFrac, tp1) {
    const d = side === 'BUY' ? 1 : -1, risk = Math.abs(plan.entry - plan.stop), cost = plan.entry * costFrac / risk; let stop = plan.stop, hit1 = false;
    for (let j = from; j < candles.length; j++) {
      const b = candles[j];
      if (d > 0 ? b.l <= stop : b.h >= stop) return { r: (stop - plan.entry) * d / risk - cost, kind: hit1 ? 'break-even stop' : 'stop', bars: j - from + 1 };
      if (d > 0 ? b.h >= plan.target : b.l <= plan.target) return { r: Math.abs(plan.target - plan.entry) / risk - cost, kind: 'target', bars: j - from + 1 };
      if (tp1 && !hit1 && (d > 0 ? b.h >= tp1 : b.l <= tp1)) { hit1 = true; const ns = plan.entry + d * cost * risk; if (d > 0 ? ns > stop : ns < stop) stop = ns; }
    }
    const last = candles[candles.length - 1].c; return { open: true, r: (last - plan.entry) * d / risk - cost, kind: 'still open', bars: candles.length - from };
  }

  /** Replay one market. env: { engine, scanner, S, mode, tf, tfMs }. candles: oldest -> newest. `bars` = how many of the newest candles are the test window. */
  async function replay(env, symbol, candles, bars, yieldFn) {
    const { engine, scanner, S, mode, tf } = env, tfMs = TF_MS[tf] || 9e5, out = [], costFrac = ((S.feePct != null ? S.feePct : 0.1) + (S.slipPct != null ? S.slipPct : 0.05)) * 2 / 100;
    const warm = 120, start = Math.max(warm, candles.length - bars - 1), Sx = { ...S, mode, minEff: (S.minEffPct || 25) / 100 }; let busyUntil = -1, steps = 0;
    for (let i = start; i < candles.length - 1; i++) {
      if (i <= busyUntil) continue;
      const slice = candles.slice(Math.max(0, i - 219), i + 1), a = scanner.analyse(symbol, tf, slice, Sx);
      let cand; try { cand = engine.evaluate({ ...a, candles: slice }, Sx, { tfMs, now: slice[slice.length - 1].closeT + 1, portfolio: { open: [], maxCorrelated: S.maxCorrelated || 2 } }); } catch (e) { cand = null; }
      if (++steps % 8 === 0 && yieldFn) await yieldFn();
      if (!cand || !cand.plan || !engine.qualifies(cand, Sx, mode).ok) continue;
      const risk = Math.abs(cand.plan.entry - cand.plan.stop), prof = engine.profile(Sx, mode);
      const tp1 = prof.longTerm ? cand.plan.entry + (cand.side === 'BUY' ? 1 : -1) * Math.min(risk * (S.tp1R || 1), Math.abs(cand.plan.target - cand.plan.entry) * 0.6) : null;
      const o = follow(candles, i + 1, cand.side, cand.plan, costFrac, tp1);
      out.push({ symbol, t: slice[slice.length - 1].t, side: cand.side, score: cand.score, ...o }); busyUntil = i + (o.open ? candles.length : o.bars);   // one trade at a time per market
    }
    return out;
  }

  function summarise(trades) {
    const done = trades.filter(t => !t.open), wins = done.filter(t => t.r > 0), loss = done.filter(t => t.r <= 0), gp = wins.reduce((s, t) => s + t.r, 0), gl = -loss.reduce((s, t) => s + t.r, 0);
    return { signals: trades.length, closed: done.length, open: trades.length - done.length, wins: wins.length, losses: loss.length, winRate: done.length ? wins.length / done.length : null, netR: done.reduce((s, t) => s + t.r, 0),
      avgR: done.length ? done.reduce((s, t) => s + t.r, 0) / done.length : null, pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : null), openR: trades.filter(t => t.open).reduce((s, t) => s + t.r, 0) };
  }

  /** env: { engine, scanner, S, symbols, candles(symbol, tf, count) -> Promise<[]>, yieldFn, onProgress }. id: 'A7' | 'S4' | 'S1' */
  async function run(env, id) {
    const w = WINDOWS[id], tf = w.tf || env.S[w.tfKey] || '1h', tfMs = TF_MS[tf] || 9e5, bars = Math.max(10, Math.round(w.span / tfMs)), mode = id === 'A7' ? 'aplus' : (env.S.mode === 'mad' ? 'mad' : 'normal');
    const markets = [], errors = [], all = []; let n = 0;
    for (const sym of env.symbols) {
      try {
        const c = await env.candles(sym, tf, bars + 260), t = await replay({ ...env, mode, tf }, sym, c, bars, env.yieldFn);
        markets.push({ symbol: sym, ...summarise(t) }); all.push(...t);
      } catch (e) { errors.push(`${sym}: ${e.message}`); }
      env.onProgress && env.onProgress(++n, env.symbols.length);
    }
    return { id, title: w.title, tf, mode, bars, at: Date.now(), markets, total: summarise(all), trades: all.slice(-60), errors };
  }
  return { run, replay, follow, summarise, WINDOWS };
});
