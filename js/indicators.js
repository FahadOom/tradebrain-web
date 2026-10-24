/* TradeBrain · pure indicator maths (no DOM, testable in Node). Candle = {t,o,h,l,c,v}. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.ind = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

  /** Exponential moving average; entries before the first full window are null. */
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let prev = mean(values.slice(0, period));
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }

  /** Wilder RSI over the whole series. */
  function rsi(values, period = 14) {
    if (values.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d > 0) gain += d; else loss -= d; }
    gain /= period; loss /= period;
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    }
    return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }

  /** MACD 12/26/9 → {line, signal, hist} for the latest candle, or null. */
  function macd(values) {
    const fast = ema(values, 12), slow = ema(values, 26);
    const line = values.map((_, i) => (fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null));
    const valid = line.filter(v => v != null);
    const sig = ema(valid, 9).filter(v => v != null);
    if (!sig.length) return null;
    const l = valid[valid.length - 1], s = sig[sig.length - 1];
    return { line: l, signal: s, hist: l - s };
  }

  /** Average true range (simple mean of the last `period` true ranges). */
  function atr(candles, period = 14) {
    if (candles.length < period + 1) return null;
    const tr = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    }
    return mean(tr.slice(-period));
  }

  /** "Jitter" = directional efficiency: net move ÷ total path. 1 = straight line, 0 = pure chop. */
  function efficiency(candles, period = 12) {
    if (candles.length < period + 1) return null;
    const r = candles.slice(-period - 1);
    let path = 0;
    for (let i = 1; i < r.length; i++) path += Math.abs(r[i].c - r[i - 1].c);
    return path ? Math.abs(r[r.length - 1].c - r[0].c) / path : 0;
  }

  /** Highest high / lowest low of the `period` candles BEFORE the latest one. */
  function channel(candles, period = 20) {
    const w = candles.slice(-period - 1, -1);
    if (w.length < period) return null;
    return { high: Math.max(...w.map(c => c.h)), low: Math.min(...w.map(c => c.l)) };
  }

  /** Latest volume ÷ mean of the previous 20 candles. */
  function volumeRatio(candles) {
    const avg = mean(candles.slice(-21, -1).map(c => c.v));
    return avg ? candles[candles.length - 1].v / avg : null;
  }


  /** Full-length series helpers used by charts and strategies (null until enough data). */
  function rsiSeries(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length < period + 1) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; if (d > 0) gain += d; else loss -= d; }
    gain /= period; loss /= period; out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      gain = (gain * (period - 1) + Math.max(d, 0)) / period; loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }
  function macdSeries(values) {
    const fast = ema(values, 12), slow = ema(values, 26), n = values.length;
    const line = values.map((_, i) => (fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null));
    const first = line.findIndex(v => v != null), hist = new Array(n).fill(null);
    if (first < 0) return hist;
    const sig = ema(line.slice(first), 9);
    sig.forEach((s, j) => { if (s != null) hist[first + j] = line[first + j] - s; });
    return hist;
  }
  function atrSeries(candles, period = 14) {
    const out = new Array(candles.length).fill(null), tr = [null];
    for (let i = 1; i < candles.length; i++) { const c = candles[i], p = candles[i - 1]; tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c))); }
    for (let i = period; i < candles.length; i++) out[i] = mean(tr.slice(i - period + 1, i + 1));
    return out;
  }
  /** Bollinger bands series (population std-dev). */
  function bollinger(values, period = 20, k = 2) {
    const mid = [], up = [], lo = [];
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) { mid.push(null); up.push(null); lo.push(null); continue; }
      const w = values.slice(i - period + 1, i + 1), m = mean(w), sd = Math.sqrt(mean(w.map(x => (x - m) ** 2)));
      mid.push(m); up.push(m + k * sd); lo.push(m - k * sd);
    }
    return { mid, up, lo };
  }
  /** Wilder ADX (latest value) with +DI / -DI. */
  function adx(candles, period = 14) {
    if (candles.length < period * 2 + 1) return null;
    const tr = [], pdm = [], mdm = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1], up = c.h - p.h, dn = p.l - c.l;
      tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
      pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
    }
    const smooth = a => { let s = a.slice(0, period).reduce((x, y) => x + y, 0); const o = [s]; for (let i = period; i < a.length; i++) { s = s - s / period + a[i]; o.push(s); } return o; };
    const t = smooth(tr), p = smooth(pdm), m = smooth(mdm), dx = [];
    let pdi = 0, mdi = 0;
    for (let i = 0; i < t.length; i++) { pdi = t[i] ? 100 * p[i] / t[i] : 0; mdi = t[i] ? 100 * m[i] / t[i] : 0; dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0); }
    if (dx.length < period) return null;
    let a = mean(dx.slice(0, period)); for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]) / period;
    return { adx: a, pdi, mdi };
  }
  /** Confirmed swing highs/lows: a pivot needs `n` lower highs (higher lows) on both sides, so the last n candles never repaint. */
  function pivots(candles, n = 3) {
    const highs = [], lows = [];
    for (let i = n; i < candles.length - n; i++) {
      let hi = true, lo = true;
      for (let j = 1; j <= n; j++) {
        if (!(candles[i].h > candles[i - j].h && candles[i].h >= candles[i + j].h)) hi = false;
        if (!(candles[i].l < candles[i - j].l && candles[i].l <= candles[i + j].l)) lo = false;
      }
      if (hi) highs.push({ i, p: candles[i].h }); if (lo) lows.push({ i, p: candles[i].l });
    }
    return { highs, lows };
  }
  /** Percentile rank (0..1) of the last value inside the array of valid values. */
  function percentRank(arr) {
    const v = arr.filter(x => x != null); if (v.length < 5) return null;
    const last = v[v.length - 1]; return v.filter(x => x <= last).length / v.length;
  }
  /** Data-quality check: duplicates, gaps, age of newest candle. */
  function quality(candles, tfMs, now = Date.now()) {
    let gaps = 0, dupes = 0;
    for (let i = 1; i < candles.length; i++) { const d = candles[i].t - candles[i - 1].t; if (d === 0) dupes++; else if (d > tfMs * 1.5) gaps++; }
    const ageMs = candles.length ? now - candles[candles.length - 1].t - tfMs : Infinity;   // age since the newest candle CLOSED
    return { gaps, dupes, ageMs, stale: ageMs > tfMs * 3, ok: gaps === 0 && dupes === 0 && ageMs <= tfMs * 3 };
  }

  return { mean, ema, rsi, macd, atr, efficiency, channel, volumeRatio, rsiSeries, macdSeries, atrSeries, bollinger, adx, pivots, percentRank, quality };
});
