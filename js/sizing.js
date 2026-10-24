/* TradeBrain · position sizing. Risk budget / stop distance, capped by the manual size. Never rounds UP past the budget. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.sizing = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function hybrid(x) {
    const { equity, riskPct, stopDist, price, manualCap } = x;
    if (!(equity > 0) || !(riskPct > 0)) return { ok: false, why: 'equity and risk % must be positive.' };
    if (!(stopDist > 0) || !(price > 0)) return { ok: false, why: 'no valid stop distance.' };
    const riskCash = equity * riskPct / 100;
    let qty = Math.min(riskCash / stopDist, manualCap > 0 ? manualCap : Infinity, equity / price);
    qty = Math.floor(qty * 1e6) / 1e6;
    if (!(qty > 0)) return { ok: false, why: 'risk budget too small for one unit; not raised silently.' };
    return { ok: true, qty, riskCash, lossAtStop: qty * stopDist };
  }
  return { hybrid };
});
