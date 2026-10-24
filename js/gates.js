/* TradeBrain · auto-trade gates. Pure function: returns {ok, why, key}. Every refusal says why. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.gates = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const COOLDOWN_MS = 5 * 60 * 1000;

  /** Minimum score for an automatic order in each mode. */
  function threshold(S) {
    if (S.mode === 'aplus') return Math.max(S.autoScore, 80);
    if (S.mode === 'mad') return Math.max(40, S.autoScore - 10);
    return S.autoScore;
  }

  /** Balance-based kill switch. Uses the balance you keep updated in the Risk tab. */
  function killSwitch(S) {
    const floor = S.start * (1 - S.lossPct / 100);
    if (S.now <= floor) return `Session loss limit hit (balance $${S.now.toFixed(2)} ≤ $${floor.toFixed(2)}).`;
    if (S.now >= S.goal && S.action === 'pause') return `Target reached ($${S.now.toFixed(2)} ≥ $${S.goal.toFixed(2)}).`;
    return null;
  }

  /**
   * x = { cand, council, S, symbol, broker, accountMode, armed, runtime:{seen:Set,last:{},orders}, now }
   */
  function evaluate(x) {
    const { cand, council, S, symbol, broker, accountMode, armed, runtime } = x, now = x.now || Date.now();
    const no = why => ({ ok: false, why });
    if (!armed) return no(`${broker} is not armed.`);
    const kill = killSwitch(S); if (kill) return no('Kill switch: ' + kill);
    if (runtime.orders >= S.autoMax) return no(`Session cap reached (${runtime.orders}/${S.autoMax}).`);
    if (accountMode === 'live' && !S.autoLive) return no('Live account: tick "Allow auto orders on a LIVE account" first.');
    if (!cand || cand.symbol !== symbol) return no(`No candidate for ${symbol}.`);
    if (cand.signal !== 'BUY' && cand.signal !== 'SELL') return no(`${cand.symbol}: ${cand.why}.`);
    if (broker === 'binance' && cand.signal === 'SELL') return no('Binance Spot cannot open a short. SELL blocked.');
    const min = threshold(S);
    if (cand.score < min) return no(`${cand.symbol}: score ${cand.score} below ${min} for ${S.mode.toUpperCase()} mode.`);
    if (S.mode === 'normal') {
      if (!council.gatesOk) return no('Council gates blocked: ' + council.gates.filter(g => g.verdict !== 'PASS').map(g => g.name).join(', ') + '.');
      const opp = cand.signal === 'BUY' ? 'SELL' : 'BUY';
      if (council.verdict === opp) return no(`Council says ${council.verdict}, opposing the ${cand.signal}.`);
    } else if (S.mode === 'aplus') {
      if (council.verdict !== cand.signal) return no(`A+ needs the Council to say ${cand.signal}; it says ${council.verdict}.`);
      if (council.agree < 3) return no(`A+ needs 3 voters; only ${council.agree} agree.`);
    }
    const key = `${broker}|${cand.symbol}|${cand.tf}|${cand.signal}|${cand.time}`;
    if (runtime.seen.has(key)) return no('Already traded this candle.');
    if (S.reentry === 'cooldown') {
      const t = runtime.last[cand.symbol];
      if (t && now - t < COOLDOWN_MS) return no(`Cooling down ${Math.ceil((COOLDOWN_MS - (now - t)) / 1000)}s.`);
    }
    return { ok: true, why: `${cand.signal} ${cand.symbol} score ${cand.score}, council ${council.verdict} (${council.agree} agree).`, key };
  }
  return { evaluate, threshold, killSwitch, COOLDOWN_MS };
});
