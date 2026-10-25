/* TradeBrain · engine. One call turns a scan result into a fully evaluated candidate:
   strategies -> extended Traders Council -> opportunity score -> A+ checks. Pure; no network. */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./indicators.js') : root.TB.ind, isNode ? require('./strategies.js') : root.TB.strat, isNode ? require('./councilx.js') : root.TB.councilX, isNode ? require('./risk.js') : root.TB.risk);
  if (isNode) module.exports = api; else { root.TB = root.TB || {}; root.TB.engine = api; }
})(typeof self !== 'undefined' ? self : this, function (ind, strat, councilX, risk) {
  'use strict';

  /** Default per-mode limits. The user can override every field from the Auto screen (settings.profiles[mode]). */
  const PROFILES = {
    // trigger 'both'  : the main strategy must see the trade AND at least minVoters council traders must agree (normal scalp)
    // trigger 'either': minVoters traders agree with the main strategy, or two traders agree on their own (MADBOT, more opportunities)
    // trigger 'aplus' : the strict A+ checklist decides; the trade is held long-term and the AI supervises it
    normal: { minScore: 60, minFamilies: 2, minNet: 0.35, maxOppose: 0, maxPos: 3, maxPerSymbol: 1, maxEntriesHour: 4, cooldownMin: 10, maxHoldMin: 240, requireAplus: false, trigger: 'both', minVoters: 2 },
    aplus:  { minScore: 80, minFamilies: 3, minNet: 0.5, maxOppose: 0, maxPos: 2, maxPerSymbol: 1, maxEntriesHour: 2, cooldownMin: 20, maxHoldMin: 4320, requireAplus: true, trigger: 'aplus', minVoters: 3, longTerm: true },
    mad:    { minScore: 40, minFamilies: 2, minNet: 0.15, maxOppose: 1, maxPos: 8, maxPerSymbol: 3, maxEntriesHour: 24, cooldownMin: 1, maxHoldMin: 90, requireAplus: false, trigger: 'either', minVoters: 1,
              maxAggLossPct: 8, maxExposurePct: 300, maxCorrelated: 4, maxNewPerScan: 4 },
  };
  const profile = (S, mode) => {
    const m = mode || S.mode, p = { ...PROFILES[m] || PROFILES.normal, ...((S.profiles || {})[m] || {}) };
    if (m === 'normal' && S.minVoters > 0 && !((S.profiles || {}).normal || {}).minVoters) p.minVoters = S.minVoters;   // the Auto-screen setting; a per-mode override wins
    return p;
  };

  /** Council traders (voters + extended specialists, not gates) that back `side`. */
  const votersFor = (cand, side) => (cand.council.members || []).filter(m => m.verdict === side);

  /**
   * The scalp trigger. Stages: 'none' -> 'watch' (the main strategy or the Council sees a direction) -> 'ready' (trigger met; the AI and the risk engine still decide).
   * main = the app's main strategy (EMA 9/21 + RSI + MACD scalper rules) as computed by the scanner.
   */
  function trigger(cand, S, mode) {
    const p = profile(S, mode), side = cand ? cand.side : 'WAIT';
    if (!cand || side === 'WAIT') return { stage: cand && cand.main && cand.main !== 'WAIT' ? 'watch' : 'none', ok: false, voters: 0, main: cand ? cand.main : 'WAIT', why: 'No direction yet.' };
    const v = votersFor(cand, side), n = v.length, mainOk = cand.main === side, names = v.map(m => m.name).join(', ');
    let ok = false, why;
    if (p.trigger === 'aplus') { ok = n >= p.minVoters; why = ok ? `${n} traders agree (${names}).` : `${n} trader${n === 1 ? '' : 's'} agree; A+ needs ${p.minVoters}.`; }
    else if (p.trigger === 'either') { ok = mainOk ? n >= p.minVoters : n >= Math.max(2, p.minVoters); why = ok ? `${mainOk ? 'Main strategy' : 'Council'} sees ${side}; ${n} trader${n === 1 ? '' : 's'} agree (${names}).` : `Needs the main strategy plus ${p.minVoters}, or ${Math.max(2, p.minVoters)} traders; have ${n}.`; }
    else { ok = mainOk && n >= p.minVoters; why = !mainOk ? `Main strategy does not see ${side} (it says ${cand.main || 'WAIT'}).` : n < p.minVoters ? `Main strategy sees ${side} but only ${n} trader${n === 1 ? '' : 's'} agree (needs ${p.minVoters}).` : `Main strategy sees ${side} and ${n} traders agree (${names}).`; }
    return { stage: ok ? 'ready' : 'watch', ok, voters: n, main: cand.main, why };
  }

  /**
   * r: scan result { symbol, tf, candles, price, time, atr, ema21, rsi, eff, vol, ... } from scanner.analyse + candles
   * S: settings; ctx: { tfMs, portfolio, perf, now }
   */
  function evaluate(r, S, ctx = {}) {
    const tfMs = ctx.tfMs || 9e5, now = ctx.now || Date.now(), s = { ...S, minEff: S.minEff != null ? S.minEff : (S.minEffPct || 25) / 100 };
    const run = strat.run(r.candles, s); if (!run) return null;
    const q = ind.quality(r.candles, tfMs, now);
    const council = councilX.convene(r, run, s, { tfMs, portfolio: ctx.portfolio, quality: q });
    const side = council.side, agreeing = council.members.filter(m => m.verdict === side);
    const meanScore = agreeing.length ? agreeing.reduce((t, m) => t + m.score, 0) / agreeing.length : 0;
    let score = Math.round(Math.min(100, 60 * Math.abs(council.net) + 0.4 * meanScore) * (council.choppy ? 0.85 : 1));
    if (side === 'WAIT') score = Math.min(score, 30);
    const lvls = run.levels, above = lvls.filter(l => l.p > r.price).sort((a, b) => a.p - b.p)[0], below = lvls.filter(l => l.p < r.price).sort((a, b) => b.p - a.p)[0];
    const cand = { symbol: r.symbol, tf: r.tf, time: r.time, side, main: r.signal || 'WAIT', mainWhy: r.why || '', signal: council.verdict, price: r.price, plan: side === 'WAIT' ? null : council.plan, score, regime: run.regime.name, atr: r.atr, ema21: r.ema21, rsi: r.rsi, eff: r.eff, vol: r.vol,
      council, run, quality: q, ageMs: q.ageMs, tfMs, nextRes: above ? above.p : null, nextSup: below ? below.p : null, leadStrategy: (agreeing.sort((a, b) => b.score - a.score)[0] || {}).strategy || null };
    cand.aplus = side === 'WAIT' ? null : strat.aplus(cand, council, S, ctx.perf);
    cand.key = `${r.symbol}|${r.tf}|${side}|${r.time}`;
    cand.trig = trigger(cand, S, S.mode);
    return cand;
  }

  /** Does this candidate meet the active mode's opportunity rules? (The risk engine and AI policy are separate, later checks.) */
  function qualifies(cand, S, mode) {
    const p = profile(S, mode); const no = why => ({ ok: false, why });
    if (!cand || cand.side === 'WAIT') return no('No directional edge.');
    if (!cand.council.gatesOk) return no('Council gate blocked: ' + cand.council.gates.filter(g => g.verdict !== 'PASS').map(g => g.name + ' (' + g.why.split('.')[0] + ')').join('; '));
    if (cand.council.agreeFamilies < p.minFamilies) return no(`Only ${cand.council.agreeFamilies} independent famil${cand.council.agreeFamilies === 1 ? 'y agrees' : 'ies agree'} (needs ${p.minFamilies}).`);
    if (Math.abs(cand.council.net) < p.minNet) return no(`Council conviction ${Math.abs(cand.council.net).toFixed(2)} below ${p.minNet}.`);
    if (cand.council.opposeFamilies > p.maxOppose) return no(`${cand.council.opposeFamilies} opposing famil${cand.council.opposeFamilies === 1 ? 'y' : 'ies'} (max ${p.maxOppose}).`);
    if (cand.score < p.minScore) return no(`Score ${cand.score} below ${p.minScore}.`);
    const tg = trigger(cand, S, mode); if (!tg.ok) return no('Scalp trigger not met: ' + tg.why);
    if (p.requireAplus && !(cand.aplus && cand.aplus.pass)) return no('A+ checks failed: ' + (cand.aplus ? cand.aplus.checks.filter(c => !c.ok).map(c => c.name).join(', ') : 'n/a'));
    return { ok: true, why: `${cand.side} score ${cand.score}, ${cand.council.agreeFamilies} families agree.` };
  }

  /** Log-return correlation of `r` against every open position (each entry keeps its side so callers can filter). */
  function corrOpen(r, results, positions) {
    return positions.filter(p => p.symbol !== r.symbol).map(p => { const o = results.find(x => x.symbol === p.symbol); return o ? { symbol: p.symbol, side: p.side, corr: risk.corr(r.candles.map(c => c.c), o.candles.map(c => c.c)) } : null; }).filter(Boolean);
  }

  return { evaluate, qualifies, profile, trigger, votersFor, PROFILES, corrOpen };
});
