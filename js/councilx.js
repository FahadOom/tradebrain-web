/* TradeBrain · Extended Traders Council.
   Keeps the ORIGINAL council exactly as it was (js/council.js: Trend, Momentum, Breakout, Noise voters; Risk and Execution gates)
   and adds analyst roles on top. Each member carries its own chart overlays so the UI can draw one chart per member per market.
   Voting is by independence FAMILY, not by head count: Trend + Scalper + Trend-structure are one family and cast one vote. */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./council.js') : root.TB.council, isNode ? require('./strategies.js') : root.TB.strat);
  if (isNode) module.exports = api; else { root.TB = root.TB || {}; root.TB.councilX = api; }
})(typeof self !== 'undefined' ? self : this, function (classic, strat) {
  'use strict';
  const C = strat.COLORS;
  const ser = (values, color, label, width) => ({ type: 'series', values, color, label, width: width || 1.4 });

  /* id, display name, role, family, default weight, source strategy id, original? */
  const ROSTER = [
    { id: 'trend', name: 'Trend', role: 'EMA 9/21 order and price vs EMA 50', family: 'trend', w: 0.9, from: 'trend', original: true },
    { id: 'momentum', name: 'Momentum', role: 'RSI zone with MACD histogram', family: 'momentum', w: 1, from: 'momentum', original: true },
    { id: 'breakout', name: 'Breakout', role: '20-candle channel break with volume', family: 'breakout', w: 1, from: 'breakout', original: true },
    { id: 'noise', name: 'Noise', role: 'Directional efficiency (jitter) must be clean', family: 'noise', w: 1, from: 'jitter', original: true },
    { id: 'scalper', name: 'Scalping Specialist', role: 'EMA 9/21 + RSI zone + MACD + volume (the AI Brain Scalper)', family: 'trend', w: 0.8, from: 'scalper' },
    { id: 'structure', name: 'Trend Structure Analyst', role: 'Swing structure, EMA stack, ADX, trendline', family: 'trend', w: 1, from: 'trend' },
    { id: 'retest', name: 'Retest Specialist', role: 'Breakout then pullback that holds the level', family: 'breakout', w: 1, from: 'retest' },
    { id: 'meanrev', name: 'Mean-Reversion Analyst', role: 'Bollinger extremes + RSI, only in ranging regimes', family: 'meanrev', w: 0.9, from: 'meanrev' },
    { id: 'priceaction', name: 'Price-Action Analyst', role: 'Support/resistance, order blocks, fair-value gaps', family: 'structure', w: 1, from: 'priceaction' },
  ];
  const GATES = ['Risk', 'Execution', 'Regime', 'Portfolio'];

  /** Overlays for the four ORIGINAL voters: they draw exactly what their original rules read. */
  function classicOverlays(id, x, st) {
    if (id === 'trend') { const t = st.trend && st.trend.overlays.filter(o => o.type === 'trend'); return { overlays: [ser(x.e9s, C.blue, 'EMA 9'), ser(x.e21s, C.amber, 'EMA 21'), ser(x.e50s, C.violet, 'EMA 50', 1.8), ...(t || [])], pane: null }; }
    if (id === 'momentum') return { overlays: st.momentum.overlays, pane: st.momentum.pane };
    if (id === 'breakout') return { overlays: st.breakout.overlays, pane: st.breakout.pane };
    return { overlays: st.jitter.overlays, pane: null };
  }

  /**
   * a      : scanner.analyse() result (feeds the original council)
   * run    : strategies.run(candles, s) result
   * s      : settings (+ weights{}, councilMin, councilNet, minRR)
   * opts   : { tfMs, portfolio:{ open:[{symbol,side,corr}], maxCorrelated }, quality }
   */
  function convene(a, run, s, opts = {}) {
    const st = run.strategies, x = run.x, tfMs = opts.tfMs || 9e5, W = s.weights || {};
    const cl = classic.review(a, { ...s, minEff: s.minEff != null ? s.minEff : (s.minEffPct || 25) / 100 }, tfMs);
    const fit = strat.REGIME_FIT[run.regime.name] || strat.REGIME_FIT.Transitional;
    const members = [];
    for (const r of ROSTER) {
      const src = st[r.from]; if (!src) continue;   // a disabled strategy simply has no member
      let verdict = src.verdict, why = src.why, overlays = src.overlays, pane = src.pane;
      if (r.original) {
        const c = cl.voters.find(v => v.name === r.name); verdict = c.verdict; why = c.why;
        const o = classicOverlays(r.id, x, st); overlays = o.overlays; pane = o.pane;
      }
      const weight = W[r.id] != null ? Math.max(0, Math.min(3, +W[r.id])) : r.w;
      const fitF = r.family === 'noise' ? 1 : (fit[r.family] ?? 1);
      members.push({ kind: 'voter', id: r.id, name: r.name, role: r.role, family: r.family, original: !!r.original, verdict, why, score: src.score, weight, fit: fitF, effWeight: weight * fitF, overlays, pane, plan: src.plan, strategy: src.id });
    }
    // ---- families: one vote each ----
    const fams = {};
    members.filter(m => m.family !== 'noise').forEach(m => { const f = fams[m.family] || (fams[m.family] = { family: m.family, buy: 0, sell: 0, tot: 0, members: [] }); f.tot += m.effWeight; f.members.push(m.name); if (m.verdict === 'BUY') f.buy += m.effWeight; else if (m.verdict === 'SELL') f.sell += m.effWeight; });
    Object.values(fams).forEach(f => { f.verdict = f.tot > 0 && f.buy > f.sell && f.buy >= f.tot * 0.5 ? 'BUY' : f.tot > 0 && f.sell > f.buy && f.sell >= f.tot * 0.5 ? 'SELL' : 'WAIT'; f.w = f.tot / Math.max(1, f.members.length); });
    const F = Object.values(fams).filter(f => f.tot > 0), totW = F.reduce((t, f) => t + f.w, 0) || 1;
    let net = F.reduce((t, f) => t + (f.verdict === 'BUY' ? f.w : f.verdict === 'SELL' ? -f.w : 0), 0) / totW;
    const noise = members.find(m => m.family === 'noise'), choppy = noise && noise.verdict === 'WAIT';
    if (choppy) net *= 0.7;
    const buyF = F.filter(f => f.verdict === 'BUY').length, sellF = F.filter(f => f.verdict === 'SELL').length;
    const side = net > 0 ? 'BUY' : net < 0 ? 'SELL' : 'WAIT', agree = side === 'BUY' ? buyF : side === 'SELL' ? sellF : 0, oppose = side === 'BUY' ? sellF : side === 'SELL' ? buyF : 0;
    // ---- gates: the originals plus Regime and Portfolio ----
    const gates = cl.gates.map(g => ({ kind: 'gate', ...g, original: true }));
    const best = members.filter(m => m.verdict === side && m.plan).sort((p, q) => q.score - p.score)[0];
    const plan = best ? best.plan : strat.plan(side === 'WAIT' ? 'BUY' : side, a.price, a.atr, null, s.minRR);
    const rrMin = s.minRR || 1.5;
    const rg = gates.find(g => g.name === 'Risk');
    if (rg && plan && plan.rr < rrMin - 1e-9) { rg.verdict = 'BLOCK'; rg.why += ` Plan reward:risk ${plan.rr.toFixed(2)} is below the ${rrMin} minimum.`; }
    const ex = gates.find(g => g.name === 'Execution');
    if (ex && opts.quality && !opts.quality.ok) { ex.verdict = 'BLOCK'; ex.why += ` Data quality: ${opts.quality.gaps} gap(s), ${opts.quality.dupes} duplicate(s)${opts.quality.stale ? ', stale' : ''}.`; }
    gates.push({ kind: 'gate', name: 'Regime', role: 'Market regime must be orderly', verdict: run.regime.name === 'Abnormal' ? 'BLOCK' : 'PASS', why: `${run.regime.name}. ${run.regime.why}`, overlays: [], pane: null });
    const pf = opts.portfolio || { open: [], maxCorrelated: 2 }, hot = (pf.open || []).filter(p => p.side === side && p.corr >= 0.8);
    gates.push({ kind: 'gate', name: 'Portfolio', role: 'Correlated exposure check', verdict: hot.length >= (pf.maxCorrelated || 2) ? 'BLOCK' : 'PASS', why: hot.length ? `${hot.length} open same-direction position(s) move together with this market (${hot.map(h => h.symbol + ' ρ' + h.corr.toFixed(2)).join(', ')}).` : 'No highly correlated open exposure.', overlays: [], pane: null });
    const gatesOk = gates.every(g => g.verdict === 'PASS');
    const needFam = s.councilMin || 2, needNet = s.councilNet != null ? s.councilNet : 0.35;
    let verdict = 'WAIT';
    if (gatesOk && side !== 'WAIT' && agree >= needFam && Math.abs(net) >= needNet && (s.allowOpposition || oppose === 0)) verdict = side;
    const conflicts = [];
    F.forEach(f => { if (f.verdict !== 'WAIT' && side !== 'WAIT' && f.verdict !== side) conflicts.push(`${f.family} family says ${f.verdict} against the ${side} majority (${f.members.join(', ')}).`); });
    const missing = F.filter(f => f.verdict === 'WAIT').map(f => `${f.family} family has not confirmed`);
    if (choppy) conflicts.push('Noise filter: price action is choppy, so conviction was cut by 30%.');
    const lead = F.filter(f => f.verdict === side).sort((p, q) => q.w - p.w)[0];
    return { members, gates, families: F, net, side, verdict, gatesOk, buyF, sellF, agreeFamilies: agree, opposeFamilies: oppose, leadFamily: lead ? lead.family : null, conflicts, missing, plan, classic: cl, regime: run.regime, choppy, disagreement: buyF > 0 && sellF > 0 };
  }

  return { convene, ROSTER, GATES };
});
