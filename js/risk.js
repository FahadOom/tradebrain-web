/* TradeBrain · independent risk engine. Pure, deterministic, no AI input is trusted: it recomputes loss, exposure and cost itself.
   check() has the FINAL say on every entry. It never raises a size to make a trade fit; it rejects and says why. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else { root.TB = root.TB || {}; root.TB.risk = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const floorTo = (v, step) => (step > 0 ? Math.floor(v / step + 1e-9) * step : v);
  const decimals = step => { const s = String(step); return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length; };

  /** Position sizing. mode: 'hybrid' (default) | 'ai' | 'manual'. Quantities are base-asset units, always rounded DOWN. */
  function size(x) {
    const { mode = 'hybrid', equity, riskPct, stopDist, price } = x, step = x.step || 1e-6, minNotional = x.minNotional || 0;
    const maxPosPct = x.maxPosPct || 100, maxRiskPct = x.maxRiskPct || riskPct;
    if (!(equity > 0)) return { ok: false, why: 'Account equity is unknown or zero.' };
    if (!(stopDist > 0) || !(price > 0)) return { ok: false, why: 'No valid stop distance.' };
    const riskCash = equity * riskPct / 100, capQty = equity * maxPosPct / 100 / price, cashQty = (x.cash != null ? x.cash : equity) / price;
    let qty, note = '';
    if (mode === 'manual') {
      if (!(x.manualNotional > 0)) return { ok: false, why: 'Manual size is not set.' };
      qty = x.manualNotional / price;
      const loss = qty * stopDist;
      if (loss > equity * maxRiskPct / 100 + 1e-9) return { ok: false, why: `Manual size risks $${loss.toFixed(2)} at the stop, above the hard limit $${(equity * maxRiskPct / 100).toFixed(2)}. Not changed silently.` };
      if (qty > capQty + 1e-12) return { ok: false, why: `Manual size is above the ${maxPosPct}% per-position cap. Not changed silently.` };
    } else {
      qty = riskCash / stopDist;
      if (mode === 'ai' && x.aiScale > 0) qty *= Math.min(1, x.aiScale);          // AI may only scale DOWN
      if (mode === 'hybrid' && x.manualNotional > 0) qty = Math.min(qty, x.manualNotional / price);   // your cap
      qty = Math.min(qty, capQty);
    }
    if (qty > cashQty + 1e-12) { if (mode === 'manual') return { ok: false, why: 'Not enough free balance for the manual size.' }; qty = cashQty; note = 'limited by free balance'; }
    qty = floorTo(qty, step); qty = +qty.toFixed(Math.min(12, decimals(step) + 2));
    if (!(qty > 0)) return { ok: false, why: 'Risk budget is too small for one tradable unit. Not raised silently.' };
    const notional = qty * price;
    if (notional < minNotional) return { ok: false, why: `Order value $${notional.toFixed(2)} is below the broker minimum $${minNotional}. Not raised silently.` };
    const lossAtStop = qty * stopDist, feePct = x.feePct != null ? x.feePct : 0.1, slipPct = x.slipPct != null ? x.slipPct : 0.05;
    return { ok: true, qty, notional, riskCash, lossAtStop, estCost: notional * (feePct + slipPct) * 2 / 100, mode, note };
  }

  /** Pearson correlation of log returns over the last n closes. */
  function corr(a, b, n = 60) {
    const m = Math.min(n, a.length - 1, b.length - 1); if (m < 20) return 0;
    const r = arr => { const o = []; for (let i = arr.length - m; i < arr.length; i++) o.push(Math.log(arr[i] / arr[i - 1])); return o; };
    const x = r(a), y = r(b), mx = x.reduce((s, v) => s + v, 0) / m, my = y.reduce((s, v) => s + v, 0) / m;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < m; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  }

  /**
   * x = { cand:{symbol,side,price,plan,tf,key,ageMs,tfMs,regime,quality,spreadPct}, size, account:{equity,start,cash,dayPnl,known}, positions[], recent[{t,symbol}],
   *       corrOpen:[{symbol,corr}], S, now, halted, brokerOk, longOnly, seen:Set }
   */
  function check(x) {
    const { cand, size: sz, account, positions = [], recent = [], S, now = Date.now() } = x, checks = [];
    const add = (name, ok, note) => checks.push({ name, ok: !!ok, note });
    const p = cand.plan, equity = account.equity;
    add('Trading not halted', !x.halted, x.halted ? x.halted : 'running');
    add('Broker / account state known', x.brokerOk !== false && account.known !== false && equity > 0, equity > 0 ? 'confirmed' : 'equity unknown');
    add('Market data fresh', cand.ageMs != null ? cand.ageMs <= (cand.tfMs || 9e5) * 3 : false, cand.ageMs != null ? `newest candle closed ${Math.round(cand.ageMs / 1000)}s ago` : 'unknown age');
    add('Data has no duplicates', !cand.quality || cand.quality.dupes === 0, cand.quality ? `${cand.quality.dupes} duplicate candle(s)` : 'not checked');
    add('Market not abnormal', cand.regime !== 'Abnormal', cand.regime || 'unknown');
    const sideOk = p && (cand.side === 'BUY' ? p.stop < p.entry && p.target > p.entry : p.stop > p.entry && p.target < p.entry);
    add('Stop and target on correct sides', sideOk, sideOk ? `stop ${p.stop.toPrecision(6)}, target ${p.target.toPrecision(6)}` : 'invalid plan');
    const rr = sideOk ? Math.abs(p.target - p.entry) / Math.abs(p.entry - p.stop) : 0;
    add('Reward:risk', rr >= (S.minRR || 1.5) - 1e-9, `${rr.toFixed(2)}R (needs ${S.minRR || 1.5})`);
    const costFrac = ((S.feePct != null ? S.feePct : 0.1) + (S.slipPct != null ? S.slipPct : 0.05)) * 2 / 100 * cand.price;
    add('Costs vs target', sideOk && costFrac <= Math.abs(p.target - p.entry) * 0.5, sideOk ? `round-trip cost ${(costFrac / Math.abs(p.target - p.entry) * 100).toFixed(0)}% of the target distance (max 50%)` : 'n/a');
    if (cand.spreadPct != null) add('Spread', cand.spreadPct <= (S.maxSpreadPct || 0.15), `${cand.spreadPct.toFixed(3)}%`);
    add('Broker allows this direction', !(x.longOnly && cand.side === 'SELL'), x.longOnly && cand.side === 'SELL' ? 'spot cannot open a short' : 'ok');
    add('Size is valid', !!(sz && sz.ok), sz && sz.ok ? `${sz.qty} units, $${sz.notional.toFixed(2)}` : (sz && sz.why) || 'no size');
    if (sz && sz.ok) {
      const maxRiskPct = sz.mode === 'manual' ? (S.maxRiskPct || S.riskPct * 2) : S.riskPct;
      add('Risk per trade', sz.lossAtStop <= equity * maxRiskPct / 100 + 1e-9, `$${sz.lossAtStop.toFixed(2)} at the stop (limit $${(equity * maxRiskPct / 100).toFixed(2)})`);
      if (S.maxCashRisk > 0) add('Max cash risk', sz.lossAtStop <= S.maxCashRisk + 1e-9, `$${sz.lossAtStop.toFixed(2)} (limit $${S.maxCashRisk})`);
      const openRisk = positions.reduce((t, q) => t + (q.plannedRisk || 0), 0), aggCap = equity * (S.maxAggLossPct || 3) / 100;
      add('Aggregate planned loss', openRisk + sz.lossAtStop <= aggCap + 1e-9, `$${(openRisk + sz.lossAtStop).toFixed(2)} with this trade (limit $${aggCap.toFixed(2)})`);
      const openNot = positions.reduce((t, q) => t + q.qty * (q.mark || q.entry), 0), expCap = equity * (S.maxExposurePct || 100) / 100;
      add('Total exposure', openNot + sz.notional <= expCap + 1e-9, `$${(openNot + sz.notional).toFixed(2)} with this trade (limit $${expCap.toFixed(2)})`);
      add('Free balance', account.cash == null || sz.notional <= account.cash + 1e-9, account.cash == null ? 'not reported' : `$${account.cash.toFixed(2)} free`);
    }
    const start = account.start || equity, dayLimit = -start * (S.lossPct || 10) / 100;
    add('Daily loss limit', (account.dayPnl || 0) > dayLimit, `today ${(account.dayPnl || 0) >= 0 ? '+' : '−'}$${Math.abs(account.dayPnl || 0).toFixed(2)} (lockout at −$${Math.abs(dayLimit).toFixed(2)})`);
    add('Open positions', positions.length < (S.maxPos || 3), `${positions.length}/${S.maxPos || 3}`);
    const sameSym = positions.filter(q => q.symbol === cand.symbol).length;
    add('Positions on this instrument', sameSym < (S.maxPerSymbol || 1), `${sameSym}/${S.maxPerSymbol || 1}`);
    const win = now - 3600e3, perHour = recent.filter(r => r.t >= win).length;
    add('Entries per hour', perHour < (S.maxEntriesHour || 4), `${perHour}/${S.maxEntriesHour || 4}`);
    const last = recent.filter(r => r.symbol === cand.symbol).sort((a, b) => b.t - a.t)[0], cd = (S.cooldownMin != null ? S.cooldownMin : 5) * 60e3;
    add('Re-entry cooldown', !last || now - last.t >= cd, last && now - last.t < cd ? `${Math.ceil((cd - (now - last.t)) / 1000)}s left` : 'clear');
    add('Not a duplicate signal', !x.seen || !x.seen.has(cand.key), x.seen && x.seen.has(cand.key) ? 'this candle was already traded' : 'new');
    const hot = (x.corrOpen || []).filter(c => c.corr >= 0.8);
    add('Correlated exposure', hot.length < (S.maxCorrelated || 2), hot.length ? `${hot.length} correlated open: ${hot.map(h => h.symbol).join(', ')}` : 'none');
    const bad = checks.filter(c => !c.ok);
    return { ok: bad.length === 0, reasons: bad.map(c => `${c.name}: ${c.note}`), checks };
  }

  /** Trade statistics from closed trades [{pnl, r, closedAt, strategy, family, regime, ...}] in time order. */
  function stats(trades) {
    const n = trades.length, wins = trades.filter(t => t.pnl > 0), loss = trades.filter(t => t.pnl < 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0), gl = -loss.reduce((s, t) => s + t.pnl, 0);
    let eq = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0;
    trades.forEach(t => { eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); if (t.pnl < 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; });
    const rs = trades.filter(t => Number.isFinite(t.r));
    return { n, wins: wins.length, losses: loss.length, winRate: n ? wins.length / n : 0, net: gp - gl, grossProfit: gp, grossLoss: gl, pf: gl ? gp / gl : (gp ? Infinity : 0),
      avgWin: wins.length ? gp / wins.length : 0, avgLoss: loss.length ? gl / loss.length : 0, expectancyR: rs.length ? rs.reduce((s, t) => s + t.r, 0) / rs.length : 0, expectancy: n ? (gp - gl) / n : 0,
      maxDD: dd, maxConsecLoss: maxStreak, avgHoldMin: n ? trades.reduce((s, t) => s + (t.heldMs || 0), 0) / n / 60000 : 0 };
  }

  return { size, check, corr, stats };
});
