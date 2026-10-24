/* TradeBrain · scanner rules. analyse() is pure; fetchCandles() is the only network call. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./indicators.js') : root.TB.ind);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.scanner = api; }
})(typeof self !== 'undefined' ? self : this, function (ind) {
  'use strict';
  const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5 };

  /**
   * Rules (same ideas as the original AI Brain scanner):
   *  directional: EMA9 vs EMA21 · RSI zone · MACD histogram  → all three must agree
   *  confirmation: volume ≥ 1.05× average (counts as the 4th point)
   *  filter: directional efficiency ("jitter") below the floor multiplies the score by 0.45
   * Score = 25 × aligned points (max 100) × penalty.
   */
  function analyse(symbol, tf, candles, s) {
    const closes = candles.map(c => c.c), last = candles[candles.length - 1];
    const e9 = ind.ema(closes, 9).at(-1), e21 = ind.ema(closes, 21).at(-1), e50 = ind.ema(closes, 50).at(-1);
    const rsi = ind.rsi(closes), m = ind.macd(closes), atr = ind.atr(candles);
    const eff = ind.efficiency(candles), vol = ind.volumeRatio(candles), ch = ind.channel(candles, 20);
    let bull = 0, bear = 0; const reasons = [];
    if (e9 > e21) { bull++; reasons.push('EMA 9 above EMA 21'); } else if (e9 < e21) { bear++; reasons.push('EMA 9 below EMA 21'); }
    if (rsi != null) {
      if (rsi >= 52 && rsi <= 72) { bull++; reasons.push(`RSI bullish (${rsi.toFixed(1)})`); }
      else if (rsi <= 48 && rsi >= 28) { bear++; reasons.push(`RSI bearish (${rsi.toFixed(1)})`); }
      else reasons.push(`RSI neutral or stretched (${rsi.toFixed(1)})`);
    }
    if (m) { if (m.hist > 0) { bull++; reasons.push('MACD histogram positive'); } else if (m.hist < 0) { bear++; reasons.push('MACD histogram negative'); } }
    const directional = Math.max(bull, bear), side = bull > bear ? 'BUY' : bear > bull ? 'SELL' : 'WAIT';
    const volOk = vol == null || vol >= 1.05, effOk = eff == null || !s.jitterOn || eff >= s.minEff;
    if (vol != null) reasons.push(`Volume ${vol.toFixed(2)}× average`);
    if (eff != null) reasons.push(`Directional efficiency ${(eff * 100).toFixed(0)}%`);
    const aligned = directional + (volOk && directional ? 1 : 0);
    let signal = 'WAIT', why = 'Not enough aligned confirmations';
    if (!effOk) why = 'Filtered: choppy price action';
    else if (s.volumeOn && !volOk) why = 'Filtered: volume below confirmation level';
    else if (directional === 3 && side !== 'WAIT') { signal = side; why = side === 'BUY' ? 'Bullish rules aligned' : 'Bearish rules aligned'; }
    const score = Math.round(25 * aligned * (effOk ? 1 : 0.45));
    const stop = atr ? atr * 1.5 : null;
    return {
      symbol, tf, price: last.c, time: last.t, signal, why, score, reasons,
      trend: e9 > e21 ? 'Bullish' : e9 < e21 ? 'Bearish' : 'Flat',
      ema9: e9, ema21: e21, ema50: e50, rsi, macd: m ? m.hist : null, atr, eff, vol, channel: ch,
      stopDist: stop, targetDist: stop ? stop * s.minRR : null, bull, bear,
    };
  }

  async function fetchCandles(symbol, tf, closedOnly = true, timeout = 10000) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(tf)}&limit=200`;
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
      if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
      const raw = await res.json();
      let rows = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], closeT: k[6] }));
      if (closedOnly && rows.length && rows[rows.length - 1].closeT > Date.now()) rows = rows.slice(0, -1);
      if (rows.length < 60) throw new Error(`${symbol}: not enough candles`);
      return rows;
    } catch (e) { throw new Error(e.name === 'AbortError' ? `${symbol}: timed out` : e.message); }
    finally { clearTimeout(timer); }
  }

  /** Scan a watchlist with limited concurrency. Returns {results, errors}. */
  async function scanAll(symbols, tf, s, onProgress) {
    const results = [], errors = []; let i = 0, done = 0;
    async function worker() {
      while (i < symbols.length) {
        const sym = symbols[i++];
        try { const c = await fetchCandles(sym, tf, s.closedOnly); results.push({ ...analyse(sym, tf, c, s), candles: c }); }
        catch (e) { errors.push(e.message); }
        onProgress && onProgress(++done, symbols.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, symbols.length) }, worker));
    results.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
    return { results, errors };
  }
  return { analyse, fetchCandles, scanAll, TF_MS };
});
