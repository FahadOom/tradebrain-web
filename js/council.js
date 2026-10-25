/* TradeBrain · Traders Council. Four voters + two gates, all computed from candle data.
   This is a transparent rule-based reconstruction, not a copy of any named trader. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.council = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const pick = (up, dn) => (up ? 'BUY' : dn ? 'SELL' : 'WAIT');

  function review(a, s, tfMs) {
    const px = a.price, ch = a.channel, volOk = a.noVolFeed ? true : a.vol != null && a.vol >= 1.05;   // brokers without volume (Deriv): the volume test cannot veto
    const voters = [
      { name: 'Trend', role: 'EMA 9/21 order and price vs EMA 50',
        verdict: pick(a.ema9 > a.ema21 && px > a.ema50, a.ema9 < a.ema21 && px < a.ema50),
        why: `EMA9 ${a.ema9 > a.ema21 ? '>' : '<'} EMA21; price ${px > a.ema50 ? 'above' : 'below'} EMA50.` },
      { name: 'Momentum', role: 'RSI zone with MACD histogram',
        verdict: pick(a.rsi >= 50 && a.rsi <= 72 && a.macd > 0, a.rsi <= 50 && a.rsi >= 28 && a.macd < 0),
        why: `RSI ${a.rsi == null ? 'n/a' : a.rsi.toFixed(1)}; MACD histogram ${a.macd == null ? 'n/a' : (a.macd > 0 ? 'positive' : 'negative')}.` },
      { name: 'Breakout', role: '20-candle channel break with volume',
        verdict: ch ? pick(px > ch.high && volOk, px < ch.low && volOk) : 'WAIT',
        why: ch ? `Range ${ch.low.toPrecision(5)}–${ch.high.toPrecision(5)}; ${px > ch.high ? 'closed above' : px < ch.low ? 'closed below' : 'still inside'}; volume ${a.noVolFeed ? 'not offered by this broker (ignored)' : volOk ? 'confirms' : 'not confirming'}.` : 'Not enough candles.' },
      { name: 'Noise', role: 'Directional efficiency (jitter) must be clean',
        verdict: a.eff != null && a.eff >= s.minEff ? (a.signal !== 'WAIT' ? a.signal : a.trend === 'Bullish' ? 'BUY' : a.trend === 'Bearish' ? 'SELL' : 'WAIT') : 'WAIT',
        why: `Efficiency ${a.eff == null ? 'n/a' : Math.round(a.eff * 100) + '%'} (needs ${Math.round(s.minEff * 100)}%).` },
    ];
    const stopPct = a.stopDist ? (a.stopDist / px) * 100 : null;
    const fresh = Date.now() - a.time < tfMs * 3;
    const gates = [
      { name: 'Risk', role: 'Stop size and reward:risk',
        verdict: stopPct != null && stopPct >= 0.05 && stopPct <= 5 ? 'PASS' : 'BLOCK',
        why: stopPct == null ? 'ATR unavailable.' : `Stop ≈ ${stopPct.toFixed(2)}% of price, target ${s.minRR}R. Allowed range 0.05–5%.` },
      { name: 'Execution', role: 'Liquidity and data freshness',
        verdict: (a.noVolFeed || (a.vol != null && a.vol >= 0.3)) && fresh ? 'PASS' : 'BLOCK',
        why: `Volume ${a.noVolFeed ? 'not offered by this broker (freshness only)' : a.vol == null ? 'n/a' : a.vol.toFixed(2) + '×'} average; data ${fresh ? 'fresh' : 'stale'}. Spread and fills cannot be seen from public candles.` },
    ];
    const buy = voters.filter(v => v.verdict === 'BUY').length, sell = voters.filter(v => v.verdict === 'SELL').length;
    const gatesOk = gates.every(g => g.verdict === 'PASS');
    const verdict = gatesOk && buy >= s.councilMin && buy > sell ? 'BUY' : gatesOk && sell >= s.councilMin && sell > buy ? 'SELL' : 'WAIT';
    return { voters, gates, buy, sell, gatesOk, verdict, agree: Math.max(buy, sell) };
  }
  return { review };
});
