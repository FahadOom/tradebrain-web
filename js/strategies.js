/* TradeBrain · strategy engines. Pure functions (no DOM, no network, testable in Node).
   Every strategy reads the SAME closed-candle snapshot and returns:
   { id, name, family, verdict BUY|SELL|WAIT, score 0-100, why, plan{entry,stop,target}|null, overlays[], pane|null }
   `family` groups strategies that measure nearly the same thing so the Council never counts them as independent confirmations.
   Overlays use candle INDEXES of the array that was analysed, so a chart can draw them without any translation. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./indicators.js') : root.TB.ind);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.strat = api; }
})(typeof self !== 'undefined' ? self : this, function (ind) {
  'use strict';
  const VERSION = '8.0.0';
  const C = { up: '#56d6b0', dn: '#ff7e8c', blue: '#5ec8ff', amber: '#ffc46b', violet: '#a98bff', grey: '#9aabc2', pink: '#ff8fd1' };
  const last = a => a[a.length - 1];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* Which strategies belong to which independence family. */
  const FAMILY = { scalper: 'trend', trend: 'trend', momentum: 'momentum', breakout: 'breakout', retest: 'breakout', meanrev: 'meanrev', priceaction: 'structure', jitter: 'noise' };
  /* How well each family suits each regime (0 = switched off). Weights are multiplied, not replaced. */
  const REGIME_FIT = {
    Trending:     { trend: 1, momentum: 1, breakout: 0.9, meanrev: 0, structure: 0.8, noise: 1 },
    Ranging:      { trend: 0.4, momentum: 0.4, breakout: 0.5, meanrev: 1, structure: 1, noise: 1 },
    Breakout:     { trend: 0.9, momentum: 1, breakout: 1, meanrev: 0, structure: 0.7, noise: 1 },
    'High volatility': { trend: 0.7, momentum: 0.7, breakout: 0.7, meanrev: 0.3, structure: 0.7, noise: 1 },
    'Low volatility':  { trend: 0.6, momentum: 0.6, breakout: 0.8, meanrev: 0.8, structure: 0.9, noise: 1 },
    Transitional: { trend: 0.7, momentum: 0.7, breakout: 0.7, meanrev: 0.5, structure: 0.8, noise: 1 },
    Abnormal:     { trend: 0, momentum: 0, breakout: 0, meanrev: 0, structure: 0, noise: 0 },
  };

  /** Stop/target around an entry. Stop distance is clamped to 0.8–3 ATR so a structural level can never create a silly stop. */
  function plan(side, price, atr, structStop, minRR) {
    if (!(atr > 0) || !(price > 0)) return null;
    let dist = atr * 1.5;
    if (structStop != null) { const d = side === 'BUY' ? price - structStop : structStop - price; if (d > 0) dist = clamp(d, atr * 0.8, atr * 3); }
    const rr = Math.max(1, minRR || 1.5);
    return side === 'BUY' ? { entry: price, stop: price - dist, target: price + dist * rr, risk: dist, rr } : { entry: price, stop: price + dist, target: price - dist * rr, risk: dist, rr };
  }

  function regimeOf(x) {
    const { adx, atrRank, bbwRank, atr, candles, vol, ch, price } = x, lc = last(candles);
    const range = lc.h - lc.l;
    if (atr && (range > atr * 4.5 || Math.abs(lc.c - candles[candles.length - 2].c) > atr * 4)) return { name: 'Abnormal', why: `Last candle range ${(range / atr).toFixed(1)}× ATR: disorderly move.` };
    if (ch && vol != null && vol >= 1.3 && (price > ch.high || price < ch.low) && bbwRank != null && bbwRank <= 0.6) return { name: 'Breakout', why: 'Price closed outside the 20-candle range on expanding volume.' };
    if (atrRank != null && atrRank >= 0.9) return { name: 'High volatility', why: `ATR is in the top ${Math.round((1 - atrRank) * 100) + 1}% of its recent range.` };
    if (adx && adx.adx >= 25) return { name: 'Trending', why: `ADX ${adx.adx.toFixed(0)} (≥25): directional market.` };
    if (adx && adx.adx < 18 && atrRank != null && atrRank <= 0.25) return { name: 'Low volatility', why: `ADX ${adx.adx.toFixed(0)} and ATR near its lows: quiet market.` };
    if (adx && adx.adx < 20) return { name: 'Ranging', why: `ADX ${adx.adx.toFixed(0)} (<20): no persistent direction.` };
    return { name: 'Transitional', why: adx ? `ADX ${adx.adx.toFixed(0)}: between range and trend.` : 'Not enough data.' };
  }

  /** Cluster swing points into support / resistance levels (touch count = strength). */
  function levels(candles, piv, atr) {
    const tol = Math.max(atr * 0.5, last(candles).c * 0.002), out = [];
    [...piv.highs.map(p => ({ ...p, k: 'R' })), ...piv.lows.map(p => ({ ...p, k: 'S' }))].forEach(p => {
      const m = out.find(l => Math.abs(l.p - p.p) <= tol);
      if (m) { m.p = (m.p * m.n + p.p) / (m.n + 1); m.n++; m.i = Math.max(m.i, p.i); } else out.push({ p: p.p, n: 1, i: p.i });
    });
    return out.sort((a, b) => a.p - b.p);
  }
  const nearestAbove = (lv, px) => lv.filter(l => l.p > px).sort((a, b) => a.p - b.p)[0] || null;
  const nearestBelow = (lv, px) => lv.filter(l => l.p < px).sort((a, b) => b.p - a.p)[0] || null;

  /** Order blocks (last opposite candle before a displacement) and fair-value gaps, still unmitigated. */
  function zones(candles, atr) {
    const n = candles.length, obs = [], fvgs = [], from = Math.max(2, n - 80);
    for (let i = from; i < n - 1; i++) {
      const c = candles[i];
      const end = Math.min(n - 1, i + 3), move = candles[end].c - c.c, bullBody = c.c < c.o, bearBody = c.c > c.o;
      if (bullBody && move >= atr * 1.6 && end > i) obs.push({ side: 'BUY', i, lo: c.l, hi: c.h });
      if (bearBody && -move >= atr * 1.6 && end > i) obs.push({ side: 'SELL', i, lo: c.l, hi: c.h });
      if (i >= 2) {
        const a = candles[i - 2], b = candles[i];
        if (a.h < b.l && b.l - a.h >= atr * 0.3) fvgs.push({ side: 'BUY', i: i - 1, lo: a.h, hi: b.l });
        if (a.l > b.h && a.l - b.h >= atr * 0.3) fvgs.push({ side: 'SELL', i: i - 1, lo: b.h, hi: a.l });
      }
    }
    const alive = z => { for (let j = z.i + (z.hi - z.lo > 0 ? 2 : 1); j < n; j++) { if (z.side === 'BUY' && candles[j].c < z.lo) return false; if (z.side === 'SELL' && candles[j].c > z.hi) return false; } return true; };
    return { obs: obs.filter(alive).slice(-4), fvgs: fvgs.filter(alive).slice(-4) };
  }

  /** Build the shared snapshot every strategy reads. */
  function context(candles, s) {
    const closes = candles.map(c => c.c), n = candles.length, price = last(closes);
    const e9s = ind.ema(closes, 9), e21s = ind.ema(closes, 21), e50s = ind.ema(closes, 50), e20s = ind.ema(closes, 20);
    const rsiS = ind.rsiSeries(closes), macdH = ind.macdSeries(closes), atrS = ind.atrSeries(candles), bb = ind.bollinger(closes, 20, 2);
    const atr = last(atrS), adx = ind.adx(candles), piv = ind.pivots(candles, 3), ch = ind.channel(candles, 20);
    const bbw = bb.mid.map((m, i) => (m ? (bb.up[i] - bb.lo[i]) / m : null));
    const x = { candles, closes, n, price, e9s, e21s, e50s, e20s, rsiS, macdH, atrS, atr, adx, piv, ch, bb,
      e9: last(e9s), e21: last(e21s), e50: last(e50s), rsi: last(rsiS), hist: last(macdH), eff: ind.efficiency(candles), vol: ind.volumeRatio(candles),
      atrRank: ind.percentRank(atrS.slice(-100)), bbwRank: ind.percentRank(bbw.slice(-100)), s };
    x.regime = regimeOf(x);
    x.levels = atr ? levels(candles, piv, atr) : [];
    x.zones = atr ? zones(candles, atr) : { obs: [], fvgs: [] };
    return x;
  }

  const res = (id, name, verdict, score, why, p, overlays, pane) => ({ id, name, family: FAMILY[id], verdict, score: Math.round(clamp(score, 0, 100)), why, plan: verdict === 'WAIT' ? null : p, overlays: overlays || [], pane: pane || null });
  const ser = (values, color, label, width, dash) => ({ type: 'series', values, color, label, width: width || 1.4, dash });
  const volPane = x => ({ kind: 'bars', label: 'Volume', values: x.candles.map(c => c.v), colors: x.candles.map(c => (c.c >= c.o ? 'rgba(86,214,176,.55)' : 'rgba(255,126,140,.55)')) });
  const rsiPane = x => ({ kind: 'line', label: 'RSI 14', values: x.rsiS, levels: [30, 50, 70], min: 0, max: 100, color: C.violet });
  const macdPane = x => ({ kind: 'hist', label: 'MACD histogram', values: x.macdH, levels: [0] });
  const minEffFor = (x, id) => { const b = x.s.minEff || 0.25; return ({ trend: b * 1.2, momentum: b, scalper: b, breakout: b * 0.6, retest: b * 0.6, priceaction: b * 0.5 })[id] ?? b; };

  /* ---------------- A. Scalper (EMA 9/21 + RSI zone + MACD histogram + volume; the original AI Brain rules) ---------------- */
  function scalper(x) {
    const { e9, e21, rsi, hist, vol, s } = x; let bull = 0, bear = 0; const why = [];
    if (e9 > e21) { bull++; why.push('EMA9>EMA21'); } else if (e9 < e21) { bear++; why.push('EMA9<EMA21'); }
    if (rsi != null) { if (rsi >= 52 && rsi <= 72) { bull++; why.push(`RSI ${rsi.toFixed(0)} bullish zone`); } else if (rsi <= 48 && rsi >= 28) { bear++; why.push(`RSI ${rsi.toFixed(0)} bearish zone`); } else why.push(`RSI ${rsi.toFixed(0)} neutral/stretched`); }
    if (hist != null) { if (hist > 0) { bull++; why.push('MACD hist +'); } else if (hist < 0) { bear++; why.push('MACD hist −'); } }
    const dir = Math.max(bull, bear), side = bull > bear ? 'BUY' : bear > bull ? 'SELL' : 'WAIT', need = s.scalpMin || 3;
    const volOk = vol == null || vol >= 1.05, volReq = s.volumeOn !== false;
    const ov = [ser(x.e9s, C.blue, 'EMA 9', 1.3), ser(x.e21s, C.amber, 'EMA 21', 1.3)];
    let verdict = 'WAIT', note = why.join(' · ');
    if (dir >= need && side !== 'WAIT') { if (volReq && !volOk) note += ' · volume below 1.05× (blocked)'; else verdict = side; }
    const sc = 25 * (dir + (volOk && dir ? 1 : 0));
    return res('scalper', 'Scalper', verdict, sc, note || 'No data', plan(side, x.price, x.atr, null, s.minRR), ov, macdPane(x));
  }

  /* ---------------- B. Jitter / market-noise filter ---------------- */
  function jitter(x) {
    const need = x.s.minEff || 0.25, eff = x.eff, n = x.n, w0 = Math.max(0, n - 13), win = x.candles.slice(w0);
    const pass = eff != null && eff >= need, net = x.closes[n - 1] - x.closes[w0];
    const lo = Math.min(...win.map(c => c.l)), hi = Math.max(...win.map(c => c.h));
    const ov = [{ type: 'zone', i1: w0, i2: n - 1, y1: lo, y2: hi, color: pass ? 'rgba(86,214,176,.07)' : 'rgba(255,196,107,.10)', label: `Jitter ${eff == null ? '—' : Math.round(eff * 100)}% ${pass ? 'clean' : 'choppy'}` }];
    const verdict = pass ? (net > 0 ? 'BUY' : net < 0 ? 'SELL' : 'WAIT') : 'WAIT';
    return res('jitter', 'Jitter filter', verdict, eff == null ? 0 : clamp(eff / 0.6, 0, 1) * 100, `Directional efficiency ${eff == null ? 'n/a' : Math.round(eff * 100) + '%'} over 12 candles (needs ${Math.round(need * 100)}% in the base setting; each strategy applies its own multiple).`, plan(verdict, x.price, x.atr, null, x.s.minRR), ov, null);
  }

  /* ---------------- C. Trend following (structure + EMA stack + ADX, not a bare crossover) ---------------- */
  function trend(x) {
    const { e21, e50, price, piv, adx, s } = x, n = x.n; let up = 0, dn = 0; const why = [];
    if (e21 > e50) { up++; why.push('EMA21>EMA50'); } else if (e21 < e50) { dn++; why.push('EMA21<EMA50'); }
    const slope = x.e50s[n - 1] - x.e50s[n - 6];
    if (price > e50 && slope > 0) { up++; why.push('price above rising EMA50'); } else if (price < e50 && slope < 0) { dn++; why.push('price below falling EMA50'); }
    const h = piv.highs.slice(-2), l = piv.lows.slice(-2);
    if (h.length === 2 && l.length === 2) {
      if (h[1].p > h[0].p && l[1].p > l[0].p) { up++; why.push('higher highs and higher lows'); } else if (h[1].p < h[0].p && l[1].p < l[0].p) { dn++; why.push('lower highs and lower lows'); } else why.push('swing structure mixed');
    }
    const adxMin = s.adxMin || 20, adxOk = adx && adx.adx >= adxMin;
    if (adxOk) { if (up >= dn) up++; else dn++; why.push(`ADX ${adx.adx.toFixed(0)}`); } else why.push(`ADX ${adx ? adx.adx.toFixed(0) : 'n/a'} < ${adxMin}: weak trend`);
    const side = up > dn ? 'BUY' : dn > up ? 'SELL' : 'WAIT', pts = Math.max(up, dn);
    const ov = [ser(x.e50s, C.amber, 'EMA 50', 1.6), ser(x.e21s, C.blue, 'EMA 21', 1.2)];
    let struct = null;
    if (side === 'BUY' && l.length === 2) { ov.push({ type: 'trend', i1: l[0].i, y1: l[0].p, i2: l[1].i, y2: l[1].p, color: C.up, label: 'Trendline' }); struct = l[1].p - x.atr * 0.25; }
    if (side === 'SELL' && h.length === 2) { ov.push({ type: 'trend', i1: h[0].i, y1: h[0].p, i2: h[1].i, y2: h[1].p, color: C.dn, label: 'Trendline' }); struct = h[1].p + x.atr * 0.25; }
    const verdict = pts >= 3 && adxOk && side !== 'WAIT' ? side : 'WAIT';
    return res('trend', 'Trend following', verdict, 25 * pts, why.join(' · '), plan(side, price, x.atr, struct, s.minRR), ov, null);
  }

  /* ---------------- D. Momentum (strengthening / weakening / exhausted) ---------------- */
  function momentum(x) {
    const { rsiS, macdH, n, price, atrS, s } = x, rsi = x.rsi, h0 = macdH[n - 1], h1 = macdH[n - 2], h2 = macdH[n - 3];
    if (rsi == null || h0 == null || h1 == null || h2 == null) return res('momentum', 'Momentum', 'WAIT', 0, 'Not enough data.', null, [], rsiPane(x));
    const roc = (price - x.closes[n - 11]) / x.closes[n - 11] * 100, rsiSlope = rsi - rsiS[n - 4], atrExp = atrS[n - 1] >= atrS[n - 6] * 0.95;
    const why = []; let up = 0, dn = 0;
    if (rsi >= 50 && rsiSlope > 0) { up++; why.push(`RSI ${rsi.toFixed(0)} rising`); } else if (rsi <= 50 && rsiSlope < 0) { dn++; why.push(`RSI ${rsi.toFixed(0)} falling`); }
    if (h0 > 0 && h0 > h1 && h1 >= h2) { up++; why.push('MACD histogram expanding up'); } else if (h0 < 0 && h0 < h1 && h1 <= h2) { dn++; why.push('MACD histogram expanding down'); }
    if (roc > 0.15) { up++; why.push(`10-candle ROC +${roc.toFixed(2)}%`); } else if (roc < -0.15) { dn++; why.push(`10-candle ROC ${roc.toFixed(2)}%`); }
    if (atrExp) { if (up > dn) up++; else if (dn > up) dn++; why.push('ATR not contracting'); }
    const exhausted = rsi > 75 || rsi < 25, weakening = (h0 > 0 && h0 < h1) || (h0 < 0 && h0 > h1);
    const side = up > dn ? 'BUY' : dn > up ? 'SELL' : 'WAIT', pts = Math.max(up, dn);
    let verdict = pts >= 3 && side !== 'WAIT' ? side : 'WAIT', note = why.join(' · ');
    if (exhausted) { verdict = 'WAIT'; note += ' · EXHAUSTED: RSI beyond 75/25'; } else if (weakening && verdict !== 'WAIT') { verdict = 'WAIT'; note += ' · momentum weakening'; }
    const k = ind.ema(x.closes, 20), upL = k.map((m, i) => (m != null && x.atrS[i] != null ? m + 1.5 * x.atrS[i] : null)), loL = k.map((m, i) => (m != null && x.atrS[i] != null ? m - 1.5 * x.atrS[i] : null));
    const ov = [ser(upL, 'rgba(169,139,255,.7)', 'Keltner +1.5 ATR', 1, [4, 3]), ser(loL, 'rgba(169,139,255,.7)', 'Keltner −1.5 ATR', 1, [4, 3])];
    return res('momentum', 'Momentum', verdict, 25 * pts - (exhausted ? 20 : 0), note, plan(side, price, x.atr, null, s.minRR), ov, rsiPane(x));
  }

  /* ---------------- E. Breakout confirmation ---------------- */
  function breakout(x) {
    const { ch, price, atr, vol, s, n } = x, lc = last(x.candles);
    if (!ch || !atr) return res('breakout', 'Breakout', 'WAIT', 0, 'Not enough candles for a 20-candle range.', null, [], volPane(x));
    const ov = [{ type: 'zone', i1: n - 21, i2: n - 1, y1: ch.low, y2: ch.high, color: 'rgba(94,200,255,.06)', label: '20-candle range' }, { type: 'hline', y: ch.high, color: C.blue, label: 'Range high', dash: [5, 4] }, { type: 'hline', y: ch.low, color: C.blue, label: 'Range low', dash: [5, 4] }];
    const range = lc.h - lc.l || 1e-12, body = Math.abs(lc.c - lc.o);
    const dirUp = price > ch.high, dirDn = price < ch.low, side = dirUp ? 'BUY' : dirDn ? 'SELL' : 'WAIT';
    if (side === 'WAIT') return res('breakout', 'Breakout', 'WAIT', 20, `Close ${price > (ch.high + ch.low) / 2 ? 'in the upper' : 'in the lower'} half of the range; no close beyond it.`, null, ov, volPane(x));
    const dist = side === 'BUY' ? price - ch.high : ch.low - price, volOk = vol == null || vol >= 1.2;
    const wick = side === 'BUY' ? (lc.h - lc.c) / range : (lc.c - lc.l) / range;
    const strong = wick <= 0.4 && body / range >= 0.4, notExtended = dist <= atr * 1.5;
    const lv = side === 'BUY' ? nearestAbove(x.levels, price) : nearestBelow(x.levels, price), risk = atr * 1.5;
    const room = !lv || Math.abs(lv.p - price) >= risk, why = [`Closed ${side === 'BUY' ? 'above' : 'below'} the 20-candle range by ${(dist / atr).toFixed(2)} ATR`];
    let pts = 1; if (volOk) { pts++; why.push(`volume ${vol ? vol.toFixed(2) + '×' : 'n/a'}`); } else why.push('volume weak');
    if (strong) { pts++; why.push('strong close (small wick)'); } else why.push('long rejection wick: false-breakout risk');
    if (notExtended) { pts++; why.push('not over-extended'); } else why.push('already extended beyond 1.5 ATR');
    if (room) { pts++; why.push(lv ? `room to ${lv.p.toPrecision(5)}` : 'no opposing level nearby'); } else why.push(`opposing level ${lv.p.toPrecision(5)} too close`);
    ov.push({ type: 'marker', i: n - 1, y: side === 'BUY' ? lc.l : lc.h, shape: side === 'BUY' ? 'up' : 'down', color: side === 'BUY' ? C.up : C.dn, label: 'Breakout' });
    const need = x.s.volumeOn !== false ? volOk : true;
    const verdict = pts >= 4 && need && strong ? side : 'WAIT';
    return res('breakout', 'Breakout', verdict, pts * 20, why.join(' · '), plan(side, price, atr, side === 'BUY' ? ch.high - atr * 0.5 : ch.low + atr * 0.5, s.minRR), ov, volPane(x));
  }

  /* ---------------- F. Breakout and retest ---------------- */
  function retest(x) {
    const { candles, atr, n, price, s } = x;
    if (!atr || n < 40) return res('retest', 'Breakout + retest', 'WAIT', 0, 'Not enough data.', null, [], null);
    const lc = last(candles), pc = candles[n - 2];
    for (let k = n - 3; k >= Math.max(21, n - 13); k--) {
      const w = candles.slice(k - 20, k), hi = Math.max(...w.map(c => c.h)), lo = Math.min(...w.map(c => c.l)), c = candles[k];
      for (const side of ['BUY', 'SELL']) {
        const L = side === 'BUY' ? hi : lo; if (side === 'BUY' ? c.c <= L : c.c >= L) continue;
        const after = candles.slice(k + 1);
        const invalid = after.some(a => (side === 'BUY' ? a.c < L - atr * 0.25 : a.c > L + atr * 0.25));
        const touched = after.some(a => (side === 'BUY' ? a.l <= L + atr * 0.35 : a.h >= L - atr * 0.35));
        const resume = side === 'BUY' ? lc.c > L && lc.c > lc.o && lc.c > pc.c : lc.c < L && lc.c < lc.o && lc.c < pc.c;
        const near = Math.abs(price - L) <= atr * 1.5;
        const ov = [{ type: 'hline', y: L, color: C.pink, label: 'Breakout level', dash: [6, 3] }, { type: 'zone', i1: k, i2: n - 1, y1: L - atr * 0.35, y2: L + atr * 0.35, color: 'rgba(255,143,209,.12)', label: 'Retest zone' }, { type: 'marker', i: k, y: side === 'BUY' ? c.l : c.h, shape: side === 'BUY' ? 'up' : 'down', color: C.pink, label: 'Break' }];
        if (!invalid && touched && resume && near) return res('retest', 'Breakout + retest', side, 80, `Broke ${side === 'BUY' ? 'above' : 'below'} ${L.toPrecision(5)} ${n - 1 - k} candles ago, pulled back into the level, held, and resumed.`, plan(side, price, atr, side === 'BUY' ? L - atr * 0.5 : L + atr * 0.5, s.minRR), ov, null);
        if (invalid && !touched) continue;
        if (invalid) return res('retest', 'Breakout + retest', 'WAIT', 10, `Level ${L.toPrecision(5)} was lost after the break: breakout invalidated, not a retest.`, null, ov, null);
      }
    }
    return res('retest', 'Breakout + retest', 'WAIT', 15, 'No recent breakout waiting for a valid retest.', null, [], null);
  }

  /* ---------------- G. Mean reversion (only in suitable regimes) ---------------- */
  function meanrev(x) {
    const { bb, n, price, rsi, atr, regime, s } = x, m = bb.mid[n - 1], u = bb.up[n - 1], l = bb.lo[n - 1];
    const ov = [{ type: 'band', upper: bb.up, lower: bb.lo, color: 'rgba(169,139,255,.10)', line: 'rgba(169,139,255,.55)', label: 'Bollinger 20,2' }, ser(bb.mid, 'rgba(169,139,255,.8)', 'Mean', 1, [3, 3])];
    if (m == null || rsi == null || !atr) return res('meanrev', 'Mean reversion', 'WAIT', 0, 'Not enough data.', null, ov, rsiPane(x));
    const suited = ['Ranging', 'Low volatility', 'Transitional'].includes(regime.name) && (x.adx ? x.adx.adx < 25 : true);
    if (!suited) return res('meanrev', 'Mean reversion', 'WAIT', 5, `Switched off: regime is ${regime.name}. Fading a ${regime.name.toLowerCase()} market is how mean-reversion accounts blow up.`, null, ov, rsiPane(x));
    const lc = last(x.candles); let side = 'WAIT', why = `Price inside the bands; RSI ${rsi.toFixed(0)}.`;
    if (lc.l <= l && price > l && rsi < 35) { side = 'BUY'; why = `Pierced the lower band and closed back inside; RSI ${rsi.toFixed(0)} oversold.`; }
    else if (price < l && rsi < 30) { side = 'BUY'; why = `Closed below the lower band; RSI ${rsi.toFixed(0)} oversold.`; }
    else if (lc.h >= u && price < u && rsi > 65) { side = 'SELL'; why = `Pierced the upper band and closed back inside; RSI ${rsi.toFixed(0)} overbought.`; }
    else if (price > u && rsi > 70) { side = 'SELL'; why = `Closed above the upper band; RSI ${rsi.toFixed(0)} overbought.`; }
    const p = side === 'WAIT' ? null : plan(side, price, atr, side === 'BUY' ? Math.min(lc.l, l) - atr * 0.3 : Math.max(lc.h, u) + atr * 0.3, s.minRR);
    if (p) { const toMid = Math.abs(m - price); if (toMid > p.risk * 0.8) { p.target = m; p.rr = toMid / p.risk; } }
    if (p && p.rr < 1) return res('meanrev', 'Mean reversion', 'WAIT', 30, why + ' Mean is too close for the stop distance (reward < risk).', null, ov, rsiPane(x));
    return res('meanrev', 'Mean reversion', side, side === 'WAIT' ? 25 : 70 + Math.min(20, Math.abs(50 - rsi) - 15), why + ` Regime ${regime.name}.`, p, ov, rsiPane(x));
  }

  /* ---------------- H. Price action: support/resistance, order blocks, fair-value gaps ---------------- */
  function priceaction(x) {
    const { candles, n, price, atr, levels: lv, zones: z, s } = x, lc = last(candles), pc = candles[n - 2];
    const ov = [];
    lv.filter(l => Math.abs(l.p - price) <= atr * 8).forEach(l => ov.push({ type: 'hline', y: l.p, color: l.p > price ? 'rgba(255,126,140,.65)' : 'rgba(86,214,176,.65)', label: `${l.p > price ? 'R' : 'S'}×${l.n}`, dash: [2, 4] }));
    z.obs.forEach(o => ov.push({ type: 'zone', i1: o.i, i2: n - 1 + 4, y1: o.lo, y2: o.hi, color: o.side === 'BUY' ? 'rgba(86,214,176,.16)' : 'rgba(255,126,140,.16)', label: o.side === 'BUY' ? 'Bull OB' : 'Bear OB', border: o.side === 'BUY' ? C.up : C.dn }));
    z.fvgs.forEach(f => ov.push({ type: 'zone', i1: f.i, i2: n - 1 + 4, y1: f.lo, y2: f.hi, color: f.side === 'BUY' ? 'rgba(94,200,255,.14)' : 'rgba(255,143,209,.14)', label: f.side === 'BUY' ? 'Bull FVG' : 'Bear FVG', border: f.side === 'BUY' ? C.blue : C.pink }));
    if (!atr) return res('priceaction', 'Price action', 'WAIT', 0, 'Not enough data.', null, ov, null);
    const bullClose = lc.c > lc.o && lc.c > pc.c, bearClose = lc.c < lc.o && lc.c < pc.c;
    const hit = side => [...z.obs, ...z.fvgs].filter(q => q.side === side && lc.l <= q.hi + atr * 0.15 && lc.h >= q.lo - atr * 0.15);
    for (const side of ['BUY', 'SELL']) {
      const zs = hit(side); if (!zs.length || !(side === 'BUY' ? bullClose : bearClose)) continue;
      const opp = side === 'BUY' ? nearestAbove(lv, price) : nearestBelow(lv, price), risk = atr * 1.5;
      if (opp && Math.abs(opp.p - price) < risk) continue;
      const sup = side === 'BUY' ? nearestBelow(lv, price) : nearestAbove(lv, price), conf = sup && Math.abs(sup.p - price) <= atr * 1.2;
      const kinds = [...new Set(zs.map(q => (z.obs.includes(q) ? 'order block' : 'fair-value gap')))];
      const score = 55 + (conf ? 20 : 0) + (kinds.length > 1 ? 15 : 0) + (Math.abs(lc.c - lc.o) / (lc.h - lc.l || 1) > 0.5 ? 10 : 0);
      const edge = side === 'BUY' ? Math.min(...zs.map(q => q.lo)) - atr * 0.25 : Math.max(...zs.map(q => q.hi)) + atr * 0.25;
      ov.push({ type: 'marker', i: n - 1, y: side === 'BUY' ? lc.l : lc.h, shape: side === 'BUY' ? 'up' : 'down', color: side === 'BUY' ? C.up : C.dn, label: 'Reaction' });
      return res('priceaction', 'Price action', side, score, `${side === 'BUY' ? 'Bullish' : 'Bearish'} reaction inside a ${kinds.join(' + ')}${conf ? ' that also sits on a ' + (side === 'BUY' ? 'support' : 'resistance') + ' level' : ''}; closed in the trade direction.`, plan(side, price, atr, edge, s.minRR), ov, null);
    }
    return res('priceaction', 'Price action', 'WAIT', 20, `${z.obs.length} order block(s) and ${z.fvgs.length} fair-value gap(s) active; price is not reacting inside one.`, null, ov, null);
  }

  /* ---------------- I. Regime / volatility analyst (context, may block) ---------------- */
  function regimeStrategy(x) {
    const r = x.regime, fit = REGIME_FIT[r.name] || REGIME_FIT.Transitional;
    return { id: 'regime', name: 'Regime', family: 'regime', verdict: 'WAIT', score: r.name === 'Abnormal' ? 0 : 60, why: r.why, plan: null, overlays: [], pane: null, regime: r.name, fit, block: r.name === 'Abnormal' };
  }

  const ENGINES = { scalper, jitter, trend, momentum, breakout, retest, meanrev, priceaction };
  const LABELS = { scalper: 'Scalper', jitter: 'Jitter filter', trend: 'Trend following', momentum: 'Momentum', breakout: 'Breakout', retest: 'Breakout + retest', meanrev: 'Mean reversion', priceaction: 'Price action' };

  /** Run every enabled strategy on one candle snapshot. */
  function run(candles, s = {}) {
    if (!candles || candles.length < 60) return null;
    const x = context(candles, s), enabled = s.enabled || {}, out = {};
    Object.keys(ENGINES).forEach(id => { if (enabled[id] !== false) { try { out[id] = ENGINES[id](x); } catch (e) { out[id] = { id, name: LABELS[id], family: FAMILY[id], verdict: 'WAIT', score: 0, why: 'Engine error: ' + e.message, plan: null, overlays: [], pane: null }; } } });
    out.regime = regimeStrategy(x);
    return { x, strategies: out, regime: x.regime, levels: x.levels, zones: x.zones };
  }

  /** A+ detector: explicit, testable checks. `council` is the extended-council result; `perf(family,regime)` optionally returns {n, expectancy}. */
  function aplus(cand, council, s = {}, perf) {
    const cfg = { score: s.aplusScore || 80, families: s.aplusFamilies || 3, rr: Math.max(2, s.minRR || 1.5), costPct: s.costPct != null ? s.costPct : 0.3, maxCostShare: 0.25 };
    const side = cand.signal, p = cand.plan, checks = []; const add = (name, ok, note) => checks.push({ name, ok: !!ok, note });
    add('Score', cand.score >= cfg.score, `${cand.score} (needs ${cfg.score})`);
    add('Independent agreement', council.agreeFamilies >= cfg.families, `${council.agreeFamilies} families agree (needs ${cfg.families})`);
    add('No opposing family', council.opposeFamilies === 0, `${council.opposeFamilies} opposing`);
    const fit = (REGIME_FIT[cand.regime] || REGIME_FIT.Transitional)[council.leadFamily] ?? 0.5;
    add('Regime fit', fit >= 0.8, `${cand.regime}: ${council.leadFamily || 'n/a'} fit ${fit}`);
    add('Reward:risk', !!p && p.rr >= cfg.rr, p ? `${p.rr.toFixed(2)}R (needs ${cfg.rr})` : 'no plan');
    const ext = cand.atr ? Math.abs(cand.price - cand.ema21) / cand.atr : 99;
    add('Entry location', ext <= 1.5, `${ext.toFixed(2)} ATR from EMA21 (max 1.5)`);
    const opp = side === 'BUY' ? (cand.nextRes || null) : (cand.nextSup || null);
    add('Space to opposing level', !p || !opp || Math.abs(opp - cand.price) >= p.risk * 1.5, opp ? `level ${opp.toPrecision(5)}` : 'none within view');
    const cost = p ? (cfg.costPct / 100 * cand.price) / Math.abs(p.target - p.entry) : 1;
    add('Costs vs target', cost <= cfg.maxCostShare, `round-trip cost ≈ ${(cost * 100).toFixed(0)}% of the target distance (max ${cfg.maxCostShare * 100}%)`);
    add('Data quality', cand.quality ? cand.quality.ok : true, cand.quality ? (cand.quality.ok ? 'fresh, no gaps' : `gaps ${cand.quality.gaps}, dupes ${cand.quality.dupes}${cand.quality.stale ? ', stale' : ''}`) : 'not checked');
    const pf = perf ? perf(council.leadFamily, cand.regime) : null;
    add('Comparable history', !pf || pf.n < 10 || pf.expectancy > 0, !pf || pf.n < 10 ? `only ${pf ? pf.n : 0} comparable trades: not enough to judge` : `${pf.n} trades, expectancy ${pf.expectancy.toFixed(2)}R`);
    add('Spread / liquidity', true, 'not visible from public candles; volume ratio used as a proxy');
    return { pass: checks.every(c => c.ok), checks };
  }

  return { run, context, plan, aplus, regimeOf, levels, zones, FAMILY, REGIME_FIT, LABELS, VERSION, COLORS: C };
});
