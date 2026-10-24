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

  return { mean, ema, rsi, macd, atr, efficiency, channel, volumeRatio };
});
