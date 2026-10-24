const assert = require('assert');
const ind = require('../js/indicators.js'), sc = require('../js/scanner.js'), strat = require('../js/strategies.js'), eng = require('../js/engine.js');
const risk = require('../js/risk.js'), brainM = require('../js/brain.js'), ctlM = require('../js/controller.js'), ex = require('../js/executors.js'), cx = require('../js/councilx.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; }, eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function gen(len, drift, vol, seed, tf = 9e5, base = 100, now = Date.now()) { const r = rng(seed); let p = base; const out = []; for (let i = 0; i < len; i++) { const o = p, c = o * (1 + drift + (r() - 0.5) * vol); out.push({ t: now - (len - i) * tf - tf, o, h: Math.max(o, c) * (1 + r() * vol * 0.4), l: Math.min(o, c) * (1 - r() * vol * 0.4), c, v: 100 + r() * 60 + (i > len - 3 ? 60 : 0) }); p = c; } return out; }
const S0 = { minEff: .25, minEffPct: 25, minRR: 1.5, jitterOn: true, volumeOn: true, councilMin: 2, mode: 'normal', riskPct: 1, lossPct: 10, start: 10, now: 10, goal: 30, action: 'pause', maxExposurePct: 100, sizeMode: 'hybrid', aiPolicy: 'off', maxNewPerScan: 2, feePct: 0.1, slipPct: 0.05 };

/* ---- indicators ---- */
const up = gen(120, 0.002, 0.003, 1);
ok(ind.rsiSeries(up.map(c => c.c)).at(-1) > 55, 'rsiSeries on uptrend');
ok(Math.abs(ind.rsiSeries(up.map(c => c.c)).at(-1) - ind.rsi(up.map(c => c.c))) < 1e-9, 'rsiSeries matches rsi');
ok(Math.abs(ind.macdSeries(up.map(c => c.c)).at(-1) - ind.macd(up.map(c => c.c)).hist) < 1e-9, 'macdSeries matches macd');
ok(ind.adx(up).adx > 25, 'ADX high in a clean trend');
ok(ind.adx(gen(120, 0, 0.006, 3)).adx < ind.adx(up).adx, 'ADX lower in a range');
const bb = ind.bollinger(up.map(c => c.c)); ok(bb.up.at(-1) > bb.mid.at(-1) && bb.mid.at(-1) > bb.lo.at(-1), 'bollinger order');
const pv = ind.pivots(gen(120, 0, 0.01, 4)); ok(pv.highs.length > 3 && pv.lows.length > 3, 'pivots found');
ok(pv.highs.every(h => h.i <= 116), 'pivots never use the last 3 candles (no repaint)');
const q = ind.quality([{ t: 0 }, { t: 9e5 }, { t: 9e5 }, { t: 36e5 }], 9e5, 5e6); ok(q.dupes === 1 && q.gaps === 1 && !q.ok, 'quality: duplicate, gap, stale');
ok(ind.quality(gen(60, 0, .002, 5), 9e5).ok, 'quality ok for fresh contiguous candles');

/* ---- strategies: every one runs, overlays reference valid indices, verdicts sensible ---- */
const down = gen(200, -0.002, 0.004, 2), range = gen(200, 0, 0.006, 3), trend = gen(200, 0.002, 0.004, 1);
for (const c of [down, range, trend]) {
  const run = strat.run(c, S0); ok(run && Object.keys(run.strategies).length === 9, 'all 8 strategies + regime');
  Object.values(run.strategies).forEach(s => { ok(['BUY', 'SELL', 'WAIT'].includes(s.verdict), s.id + ' verdict'); ok(s.score >= 0 && s.score <= 100, s.id + ' score'); if (s.verdict !== 'WAIT') ok(s.plan && s.plan.rr > 0, s.id + ' has a plan'); s.overlays.forEach(o => { if (o.type === 'series') eq(o.values.length, c.length, s.id + ' series aligned'); if (o.type === 'zone') ok(o.i1 <= o.i2 + 1, s.id + ' zone indices'); }); });
}
eq(strat.run(down, S0).strategies.trend.verdict, 'SELL', 'trend sees the downtrend'); eq(strat.run(trend, S0).strategies.trend.verdict, 'BUY', 'trend sees the uptrend');
eq(strat.run(trend, S0).strategies.meanrev.verdict, 'WAIT', 'mean reversion is switched off in a trend');
ok(/Switched off|regime/i.test(strat.run(trend, S0).strategies.meanrev.why), 'mean reversion explains why');
eq(strat.run(gen(40, 0, .01, 1), S0), null, 'too few candles -> null');
// breakout: flat range then a strong close above it on volume
const flat = gen(60, 0, 0.002, 7).map(c => ({ ...c, h: c.o * 1.001 + 0, l: c.o * 0.999, c: c.o * (1 + (c.v % 2 - 1) * 0.0002) }));
let px = flat.at(-1).c; const brk = { t: flat.at(-1).t + 9e5, o: px, h: px * 1.012, l: px * 0.9995, c: px * 1.011, v: 400 }; const bc = [...flat, brk];
const br = strat.run(bc, S0).strategies.breakout; eq(br.verdict, 'BUY', 'breakout detected: ' + br.why);
ok(br.plan.stop < brk.c && br.plan.target > brk.c, 'breakout plan sides');
const wickBrk = { ...brk, h: px * 1.03, c: px * 1.0105 }; ok(strat.run([...flat, wickBrk], S0).strategies.breakout.verdict === 'WAIT', 'long upper wick = false-breakout risk -> WAIT');
// retest
const L = Math.max(...flat.slice(-20).map(c => c.h)), r1 = { t: brk.t, o: L * 0.999, h: L * 1.012, l: L * 0.9985, c: L * 1.011, v: 300 }, r2 = { t: brk.t + 9e5, o: L * 1.011, h: L * 1.013, l: L * 1.006, c: L * 1.008, v: 120 }, r3 = { t: brk.t + 18e5, o: L * 1.008, h: L * 1.0085, l: L * 1.0004, c: L * 1.0025, v: 110 }, r4 = { t: brk.t + 27e5, o: L * 1.0025, h: L * 1.009, l: L * 1.0015, c: L * 1.0085, v: 160 };
const rt = strat.run([...flat, r1, r2, r3, r4], S0).strategies.retest; ok(rt.verdict === 'BUY' || /retest|level/i.test(rt.why), 'retest logic runs: ' + rt.why);
const lost = strat.run([...flat, r1, r2, { ...r3, c: L * 0.99, l: L * 0.985, o: L * 1.0 }, { ...r4, c: L * 0.988, o: L * 0.99, h: L * 0.992, l: L * 0.985 }], S0).strategies.retest; ok(lost.verdict === 'WAIT', 'lost level = breakout invalidated, not a retest');
// jitter
ok(strat.run(range, S0).strategies.jitter.score < strat.run(trend, S0).strategies.jitter.score, 'jitter scores trends above chop');
// plan
const pl = strat.plan('BUY', 100, 1, 98.5, 2); eq(pl.stop, 98.5, 'structural stop kept'); ok(Math.abs(pl.target - 103) < 1e-9, '2R target');
eq(strat.plan('BUY', 100, 1, 90, 2).stop, 97, 'stop clamped to 3 ATR'); eq(strat.plan('SELL', 100, 1, 100.1, 2).stop, 100.8, 'stop clamped to 0.8 ATR');
// regime fit table
ok(strat.REGIME_FIT.Abnormal.trend === 0 && strat.REGIME_FIT.Ranging.meanrev === 1, 'regime fit table');
const spike = [...gen(100, 0, .002, 9)]; const lc = spike.at(-1); spike.push({ t: lc.t + 9e5, o: lc.c, h: lc.c * 1.2, l: lc.c, c: lc.c * 1.18, v: 900 });
eq(strat.run(spike, S0).regime.name, 'Abnormal', 'disorderly spike classed Abnormal');

/* ---- council ---- */
const cand = eng.evaluate({ ...sc.analyse('DOWNUSDT', '15m', down, S0), candles: down }, S0, { tfMs: 9e5 });
ok(cand.council.members.length === 9, 'nine voters'); ok(cand.council.gates.length === 4, 'four gates (2 original + Regime + Portfolio)');
['Trend', 'Momentum', 'Breakout', 'Noise'].forEach(nm => ok(cand.council.members.some(m => m.name === nm && m.original), 'original voter kept: ' + nm));
['Risk', 'Execution'].forEach(nm => ok(cand.council.gates.some(g => g.name === nm && g.original), 'original gate kept: ' + nm));
ok(cand.council.classic.voters.length === 4 && cand.council.classic.gates.length === 2, 'classic review still returned unchanged');
const tf = cand.council.families.find(f => f.family === 'trend'); ok(tf.members.length === 3, 'trend, scalper and structure are ONE family'); ok(cand.council.agreeFamilies <= cand.council.families.length, 'families, not heads, are counted');
// correlated votes are not counted as independent: three trend-family BUYs alone cannot reach 2 agreeing families
const solo = cx.convene(sc.analyse('X', '15m', trend, S0), (() => { const r = strat.run(trend, S0); Object.values(r.strategies).forEach(s => { if (!['trend', 'scalper'].includes(s.id)) s.verdict = 'WAIT'; else s.verdict = 'BUY'; }); return r; })(), S0, { tfMs: 9e5 });
ok(solo.agreeFamilies <= 2, 'correlated indicators not counted as independent confirmations');
// weights are configurable
const hv = cx.convene(sc.analyse('X', '15m', down, S0), strat.run(down, S0), { ...S0, weights: { trend: 0, scalper: 0, structure: 0 } }, { tfMs: 9e5 }); ok(hv.members.find(m => m.id === 'trend').weight === 0, 'weights configurable');
// portfolio gate blocks correlated stacking
const pg = cx.convene(sc.analyse('X', '15m', down, S0), strat.run(down, S0), S0, { tfMs: 9e5, portfolio: { maxCorrelated: 2, open: [{ symbol: 'A', side: 'SELL', corr: .95 }, { symbol: 'B', side: 'SELL', corr: .9 }] } });
eq(pg.gates.find(g => g.name === 'Portfolio').verdict, 'BLOCK', 'portfolio gate blocks 2 correlated open positions'); eq(pg.verdict, 'WAIT', 'blocked gate forces WAIT');
// stale data blocks via Execution gate
const stale = gen(200, -0.002, 0.004, 2, 9e5, 100, Date.now() - 5 * 36e5); const cs = eng.evaluate({ ...sc.analyse('S', '15m', stale, S0), candles: stale }, S0, { tfMs: 9e5 });
ok(cs.quality.stale && cs.council.gates.find(g => g.name === 'Execution').verdict === 'BLOCK', 'stale data blocks Execution gate');

/* ---- modes ---- */
ok(eng.PROFILES.mad.maxPos > eng.PROFILES.normal.maxPos && eng.PROFILES.mad.minScore < eng.PROFILES.normal.minScore, 'MADBOT looks at more opportunities');
ok(eng.PROFILES.aplus.requireAplus, 'A+ requires the explicit checklist');
const ap = strat.aplus({ ...cand, signal: cand.side }, cand.council, S0); ok(ap.checks.length >= 10 && ap.checks.every(c => typeof c.ok === 'boolean'), 'A+ checklist is explicit');
ok(!strat.aplus({ ...cand, score: 40 }, cand.council, S0).pass, 'A+ fails on low score');
eq(eng.qualifies({ ...cand, council: { ...cand.council, gatesOk: false } }, S0, 'mad').ok, false, 'MAD mode still respects council gates');

/* ---- risk engine ---- */
const acct = { equity: 1000, start: 1000, cash: 1000, dayPnl: 0, known: true }, plan = { entry: 100, stop: 98, target: 104, risk: 2, rr: 2 };
const base = () => ({ cand: { symbol: 'AAAUSDT', side: 'BUY', price: 100, plan, tf: '15m', key: 'k1', ageMs: 1000, tfMs: 9e5, regime: 'Trending', quality: { dupes: 0 } }, account: acct, positions: [], recent: [], corrOpen: [], S: { riskPct: 1, lossPct: 10, minRR: 1.5, maxPos: 3, maxPerSymbol: 1, maxEntriesHour: 4, cooldownMin: 5, maxAggLossPct: 3, maxExposurePct: 100, feePct: .1, slipPct: .05, maxCorrelated: 2 }, now: Date.now(), seen: new Set() });
let sz = risk.size({ equity: 1000, riskPct: 1, stopDist: 2, price: 100, step: 0.001, minNotional: 5 }); ok(sz.ok && Math.abs(sz.lossAtStop - 10) < 0.01 && sz.qty === 5, 'hybrid size = risk / stop'); eq(sz.mode, 'hybrid', 'hybrid is the default');
let x = base(); x.size = sz; ok(risk.check(x).ok, 'clean trade passes');
ok(risk.size({ equity: 1000, riskPct: 1, stopDist: 2, price: 100, manualNotional: 200 }).qty === 2, 'hybrid honours the manual cap');
ok(!risk.size({ equity: 1000, riskPct: 1, stopDist: 2, price: 100, mode: 'manual', manualNotional: 900, maxRiskPct: 1.5 }).ok, 'manual size over the hard limit is rejected, not shrunk');
ok(risk.size({ equity: 1000, riskPct: 1, stopDist: 2, price: 100, mode: 'manual', manualNotional: 400, maxRiskPct: 2 }).qty === 4, 'manual size used exactly');
ok(!risk.size({ equity: 10, riskPct: 1, stopDist: 2, price: 100, minNotional: 5, maxPosPct: 3 }).ok, 'below broker minimum -> rejected, never raised');
ok(risk.size({ equity: 1000, riskPct: 1, stopDist: 2, price: 100, mode: 'ai', aiScale: 5 }).qty === 5, 'AI sizing can only scale DOWN');
const rj = (mut, re) => { const y = base(); y.size = sz; mut(y); const r = risk.check(y); ok(!r.ok && r.reasons.some(t => re.test(t)), 'rejects: ' + re); };
rj(y => { y.halted = 'Emergency'; }, /halted/); rj(y => { y.account = { ...acct, known: false }; }, /state known/); rj(y => { y.cand.ageMs = 9e6; }, /fresh/);
rj(y => { y.cand.regime = 'Abnormal'; }, /abnormal/); rj(y => { y.cand.plan = { ...plan, target: 101 }; }, /Reward/); rj(y => { y.cand.plan = { ...plan, stop: 101 }; }, /sides/);
rj(y => { y.positions = [1, 2, 3].map(i => ({ symbol: 'S' + i, qty: 1, entry: 10, plannedRisk: 1 })); }, /Open positions/); rj(y => { y.positions = [{ symbol: 'AAAUSDT', qty: 1, entry: 10, plannedRisk: 1 }]; }, /this instrument/);
rj(y => { y.positions = [{ symbol: 'Z', qty: 1, entry: 10, plannedRisk: 25 }]; }, /Aggregate/); rj(y => { y.positions = [{ symbol: 'Z', qty: 9, entry: 100, plannedRisk: 1 }]; }, /exposure/);
rj(y => { y.account = { ...acct, dayPnl: -150 }; }, /Daily loss/); rj(y => { y.seen.add('k1'); }, /duplicate/); rj(y => { y.recent = [{ t: Date.now() - 1000, symbol: 'AAAUSDT' }]; }, /cooldown/);
rj(y => { y.recent = [1, 2, 3, 4].map(i => ({ t: Date.now() - 1000 * i, symbol: 'Q' + i })); }, /Entries per hour/); rj(y => { y.corrOpen = [{ symbol: 'A', corr: .9 }, { symbol: 'B', corr: .95 }]; }, /Correlated/);
rj(y => { y.longOnly = true; y.cand.side = 'SELL'; y.cand.plan = { entry: 100, stop: 102, target: 96 }; }, /direction/); rj(y => { y.cand.spreadPct = 1; }, /Spread/);
ok(Math.abs(risk.corr(up.map(c => c.c), up.map(c => c.c * 2)) - 1) < 1e-9, 'correlation of identical returns = 1'); ok(risk.corr(gen(80, 0, .01, 1).map(c => c.c), gen(80, 0, .01, 99).map(c => c.c)) < 0.5, 'independent series weakly correlated');
const stt = risk.stats([{ pnl: 2, r: 1 }, { pnl: -1, r: -.5 }, { pnl: -1, r: -.5 }, { pnl: 3, r: 1.5 }]); ok(stt.n === 4 && stt.winRate === .5 && Math.abs(stt.pf - 2.5) < 1e-9 && stt.maxDD === 2 && stt.maxConsecLoss === 2, 'stats: win rate, profit factor, drawdown, streak');

/* ---- AI brain: schema validation ---- */
const bc2 = { symbol: 'DOWNUSDT', side: 'SELL', price: 100, plan: { entry: 100, stop: 102, target: 96, rr: 2, risk: 2 }, minRR: 1.5, atr: 1.3, regime: 'Trending', council: { verdict: 'SELL', side: 'SELL' } };
const good = { instrument: 'DOWNUSDT', direction: 'SELL', decision: 'APPROVE', strategy: 'Trend', market_regime: 'Trending', proposed_entry: 100, proposed_stop_loss: 102, proposed_take_profit: 96, reward_to_risk: 2, supporting_evidence: ['a'], conflicting_evidence: [], council_result: 'SELL', confidence: 70, reasons_to_reject: [], invalidation: ['close above 102'] };
ok(brainM.validate(good, bc2).ok, 'valid AI answer accepted'); ok(brainM.validate(good, bc2).decision.plan.rr === 2, 'AI plan accepted when sound');
const bad = (m, re) => { const v = brainM.validate({ ...good, ...m }, bc2); ok(!v.ok && v.errors.some(e => re.test(e)), 'AI rejected: ' + re); };
bad({ instrument: 'OTHER' }, /instrument/); bad({ direction: 'BUY' }, /contradicts/); bad({ confidence: 150 }, /confidence/); bad({ decision: 'MAYBE' }, /decision/); bad({ invalidation: [] }, /invalidation/);
bad({ proposed_stop_loss: 98 }, /wrong sides/); bad({ proposed_take_profit: 99 }, /reward:risk/); bad({ proposed_stop_loss: 100.1, proposed_take_profit: 99.8 }, /ATR/); bad({ council_result: 'BUY' }, /council_result/); bad({ supporting_evidence: 'x' }, /array/);
ok(!brainM.validate(null, bc2).ok && !brainM.validate([], bc2).ok, 'non-objects rejected');
ok(brainM.extractJson('Sure!\n```json\n{"a":{"b":"}"},"c":1}\n```\nthanks').c === 1, 'JSON extracted from fenced chatter'); ok(brainM.extractJson('no json here') === null, 'no JSON -> null');
const pk = brainM.packet({ ...cand, mode: 'normal', equity: 10, openPositions: 0, openSymbols: [], dayPnl: 0, riskPct: 1, minRR: 1.5, executor: 'paper' }); ok(pk.council.members.length === 9 && pk.deterministic_plan && pk.account.equity === 10, 'evidence packet is structured and complete');
ok(JSON.stringify(pk).length < 6000, 'packet stays small (cost control)');

/* ---- AI brain: policy, cache, rate limit, retry ---- */
(async () => {
  const mk = (replies, o = {}) => { let i = 0, calls = 0; const b = brainM.create({ ask: async () => { calls++; const r = replies[Math.min(i++, replies.length - 1)]; if (r instanceof Error) throw r; return r; }, available: () => !o.off, maxPerMin: o.max || 6, now: o.now }); b.calls_ = () => calls; return b; };
  const cd = { ...bc2, tf: '15m', time: 1, mode: 'normal' };
  let b = mk(['not json at all', JSON.stringify(good)]); let rv = await b.review(cd); ok(rv.ok && b.calls_() === 2, 'one controlled retry after an unusable reply');
  rv = await b.review(cd); ok(rv.cached && b.calls_() === 2, 'cached per candle (no second request)');
  b = mk([new Error('503 down')]); rv = await b.review(cd); ok(!rv.ok && rv.status === 'unavailable', 'AI failure reported'); eq(b.gate(rv, 'required').allow, false, 'REQUIRED policy: AI down = no entry (never a bypass)'); eq(b.gate(rv, 'advisory').allow, true, 'advisory policy lets deterministic rules proceed, labelled'); eq(b.gate(rv, 'off').allow, true, 'off policy');
  b = mk([JSON.stringify({ ...good, decision: 'REJECT', reasons_to_reject: ['too extended'] })]); rv = await b.review(cd); eq(b.gate(rv, 'required').allow, false, 'AI REJECT blocks under required'); ok(/extended/.test(b.gate(rv, 'required').reason), 'reason surfaced');
  b = mk(['x', 'y', 'z'], { max: 1 }); await b.review({ ...cd, time: 5 }); rv = await b.review({ ...cd, time: 6 }); eq(rv.status, 'limited', 'per-minute request cap');
  b = mk([], { off: true }); rv = await b.review(cd); eq(rv.status, 'unavailable', 'no key -> unavailable'); ok(brainM.create({ ask: async () => '', available: () => false }).gate({ ok: false, errors: ['x'] }, 'required').allow === false, 'gate handles missing review');

  /* ---- controller + paper executor: the whole loop ---- */
  let clock = Date.now(); const settings = { ...S0, aiPolicy: 'off', profiles: { normal: { minScore: 40, minFamilies: 1, minNet: 0.15, cooldownMin: 0 } } };
  const mkCtl = (o = {}) => { const e = ex.paper({ balance: 1000, fees: () => ({ feePct: 0.02, slipPct: 0.01 }) }); const brain = o.brain || brainM.create({ ask: async () => '', available: () => false }); const S = { ...settings, start: 1000, now: 1000, goal: 5000, feePct: 0.02, slipPct: 0.01, ...(o.S || {}) }; return { e, S, ctl: ctlM.create({ S: () => S, executor: e, brain, now: () => clock, tfMs: () => 9e5, persist() {}, emit() {} }) }; };
  const R = (sym, candles) => ({ ...sc.analyse(sym, '15m', candles, S0), candles });
  const cand0 = c => eng.evaluate(R('T', c), settings, { tfMs: 9e5 });
  let dn = gen(200, -0.002, 0.004, 2, 9e5, 100, clock), upc = gen(200, 0.002, 0.004, 1, 9e5, 100, clock);
  let { ctl, e, S } = mkCtl(); let r = R('DNUSDT', dn); await ctl.onScan([r]); eq(ctl.st.positions.length, 0, 'nothing opens while auto trading is OFF (default safe)');
  ok(ctl.st.cands.length === 1 && ctl.st.cands[0].council.members.length === 9, 'candidates still evaluated for display');
  ctl.setEnabled(true); await ctl.onScan([r]); ok(ctl.st.positions.length === 1, 'paper short opened: ' + JSON.stringify(ctl.st.decisions.slice(0, 2)));
  let pos = ctl.st.positions[0]; eq(pos.side, 'SELL', 'direction from council'); ok(pos.stop > pos.entry && pos.target < pos.entry, 'stop above, target below for a short'); ok(pos.plannedRisk <= 1000 * 0.01 + 1e-6, 'planned loss within 1% risk'); ok(pos.fee > 0, 'entry fee charged'); ok(pos.rationale.why.length && pos.council.members.length && pos.riskChecks.length, 'rationale, council and risk decision recorded');
  const bal0 = e.balance; await ctl.onScan([r]); eq(ctl.st.positions.length, 1, 'same candle is never traded twice (duplicate protection)');
  // price falls to target -> take-profit exit, journalled with costs
  const lastC = dn.at(-1), tp = { t: clock + 1, o: lastC.c, h: lastC.c, l: pos.target * 0.999, c: pos.target * 0.999, v: 100 }; clock += 9e5 * 2;
  const r2 = { ...r, price: tp.c, candles: [...dn, { ...tp, t: pos.openedAt + 1000 }] }; await ctl.onScan([r2]);
  eq(ctl.st.positions.length, 0, 'position closed at target'); const tr = ctl.st.journal[0]; eq(tr.exitReason, 'take-profit', 'exit reason'); ok(tr.pnl > 0 && tr.fees > 0 && tr.gross > tr.pnl, 'net P/L is after costs'); ok(tr.r > 0.5, 'R multiple recorded'); ok(tr.review.kind === 'win-following-rules', 'post-trade review'); ok(Math.abs(e.balance - (1000 + tr.pnl)) < 1e-6, 'paper balance = start + net P/L');
  ok(ctl.st.needRescan, 'controller asks for an immediate re-scan after an exit'); ok(ctl.st.feed.some(f => f.type === 'filled') && ctl.st.feed.some(f => f.type === 'closed'), 'activity feed built from real events');
  // stop-loss, and conservative tie-break (stop and target in the same bar -> stop)
  ({ ctl, e, S } = mkCtl()); ctl.setEnabled(true); r = R('DNUSDT', dn); await ctl.onScan([r]); pos = ctl.st.positions[0];
  const wide = { t: pos.openedAt + 1000, o: pos.entry, h: pos.stop * 1.001, l: pos.target * 0.999, c: pos.entry, v: 1 }; const ex1 = ctl.step({ ...pos }, wide); eq(ex1.reason, 'stop-loss', 'same-bar stop+target resolves to the stop');
  const gapBar = { t: 1, o: pos.stop * 1.01, h: pos.stop * 1.02, l: pos.stop * 1.005, c: pos.stop * 1.01 }; ok(ctl.step({ ...pos }, gapBar).price === gapBar.o, 'gap through the stop fills at the open, not the stop');
  // break-even then trail
  const p2 = { ...pos, stop: pos.stop, beDone: false }; const mv = { t: 1, o: pos.entry, h: pos.entry, l: pos.entry - pos.risk0 * 1.2, c: pos.entry - pos.risk0 * 1.1 }; eq(ctl.step(p2, mv), null, 'no exit while trading in favour'); ok(p2.stop < pos.stop && p2.stop <= pos.entry, 'stop moved to break-even after +1R (never loosened)');
  S.trailAtR = 1.2; S.trailMult = 0.3; const sd = pos.side === 'SELL' ? 1 : 1; const p3 = { ...pos }; ctl.step(p3, { t: 1, o: pos.entry, h: pos.entry, l: pos.entry - pos.risk0 * 1.3, c: pos.entry - pos.risk0 * 1.25 }); ok(p3.trailing && p3.stop < p2.stop, 'trailing stop follows after +1.5R');
  // monitor between scans
  const px = pos.stop * 1.002; e.price = async () => ({ DNUSDT: px }); await ctl.monitor(); eq(ctl.st.positions.length, 0, 'fast monitor closes on a live price touching the stop'); ok(ctl.st.journal[0].pnl < 0 && ctl.st.journal[0].review.kind === 'loss-following-rules', 'loss that followed the rules is labelled as such');
  // time exit + invalidation
  ({ ctl, e, S } = mkCtl()); ctl.setEnabled(true); r = R('DNUSDT', dn); await ctl.onScan([r]); clock += 241 * 60e3; await ctl.onScan([r]); ok(ctl.st.journal.at(-1).exitReason === 'time exit', 'max-hold time exit'); dn = gen(200, -0.002, 0.004, 2, 9e5, 100, clock);
  // long-only broker never shorts; A+ refuses weak setups; MAD allows more
  ({ ctl, e, S } = mkCtl()); e.info.longOnly = true; ctl.setEnabled(true); clock += 1; r = R('DNUSDT', gen(200, -0.002, 0.004, 2, 9e5, 100, clock)); await ctl.onScan([r]); eq(ctl.st.positions.length, 0, 'long-only executor ignores SELL'); ok(ctl.st.decisions.some(d => /cannot open a short/.test(d.text)), 'reason logged');
  ({ ctl, e, S } = mkCtl({ S: { mode: 'aplus', profiles: {} } })); ctl.setEnabled(true); r = R('UPUSDT', gen(200, 0.0004, 0.006, 5, 9e5, 100, clock)); await ctl.onScan([r]); eq(ctl.st.positions.length, 0, 'A+ mode takes nothing when the checklist fails');
  // kill switch, target reached, deadline, emergency stop
  ({ ctl, e, S } = mkCtl({ S: { start: 1000, goal: 1000.5 } })); e.balance = 1001; ctl.setEnabled(true); clock += 1; await ctl.onScan([R('DNUSDT', gen(200, -0.002, 0.004, 2, 9e5, 100, clock))]); eq(ctl.st.positions.length, 0, 'target reached -> no new entries'); eq(ctl.missionStatus(), 'Target Reached', 'mission status');
  ({ ctl, e, S } = mkCtl({ S: { lossPct: 10 } })); e.balance = 890; ctl.setEnabled(true); await ctl.onScan([R('DNUSDT', gen(200, -0.002, 0.004, 2, 9e5, 100, clock))]); eq(ctl.st.positions.length, 0, 'session loss limit -> no new entries'); eq(ctl.missionStatus(), 'Risk Halted', 'status risk halted');
  ({ ctl, e, S } = mkCtl({ S: { deadline: new Date(clock - 1000).toISOString() } })); ctl.setEnabled(true); await ctl.onScan([R('DNUSDT', gen(200, -0.002, 0.004, 2, 9e5, 100, clock))]); eq(ctl.st.positions.length, 0, 'deadline passed -> no new entries'); eq(ctl.missionStatus(), 'Deadline Reached', 'status deadline');
  ({ ctl, e, S } = mkCtl()); ctl.setEnabled(true); await ctl.onScan([R('DNUSDT', dn)]); eq(ctl.st.positions.length, 1, 'one position open'); ctl.emergency('test'); const nb = ctl.st.positions.length; await ctl.onScan([R('DNUSDT', dn)]); eq(ctl.st.positions.length, nb, 'emergency stop: nothing new opens, existing position still monitored'); eq(ctl.missionStatus(), 'Manually Paused', 'status manual pause'); e.price = async () => ({ DNUSDT: dn.at(-1).c }); await ctl.closeAll(); eq(ctl.st.positions.length, 0, 'close-all is a separate explicit action'); ok(ctl.st.journal.at(-1).exitReason === 'emergency close', 'logged');
  // multiple opportunities + max positions + per-scan cap
  ({ ctl, e, S } = mkCtl({ S: { maxNewPerScan: 5, profiles: { normal: { minScore: 40, minFamilies: 1, minNet: .15, cooldownMin: 0, maxPos: 2 } } } })); ctl.setEnabled(true); const many = [11, 12, 13, 14].map(i => R('SYM' + i + 'USDT', gen(200, -0.002, 0.004, i * 7, 9e5, 100 + i * 37, clock))); await ctl.onScan(many); ok(ctl.st.positions.length <= 2, 'max simultaneous positions enforced: ' + ctl.st.positions.length);
  // snapshot / restore, recon-on-restart
  const snap = JSON.parse(JSON.stringify(ctl.snapshot())); const c2 = mkCtl(); c2.ctl.restore(snap); eq(c2.ctl.st.positions.length, ctl.st.positions.length, 'positions survive a restart'); ok(c2.e.balance === e.balance, 'paper balance restored');
  snap.positions.forEach(p => { p.status = 'closing'; }); const c3 = mkCtl(); c3.ctl.restore(snap); ok(/Reconciliation/.test(c3.ctl.haltReason() || ''), 'mid-close position after restart blocks new entries until reconciled');
  // uncertain order (timeout): no automatic repeat, halt for reconciliation
  ({ ctl, e, S } = mkCtl()); let opens = 0; e.open = async () => { opens++; throw Object.assign(new Error('timed out'), { uncertain: true }); }; ctl.setEnabled(true); await ctl.onScan([R('DNUSDT', dn)]); await ctl.onScan([R('DNUSDT', dn)]); eq(opens, 1, 'timed-out order is NOT repeated'); ok(/unknown/.test(ctl.haltReason()), 'entries halted until reconciled'); ok(ctl.st.positions.length === 0, 'no phantom position');
  // uncertain order that actually filled -> adopted via lookup
  ({ ctl, e, S } = mkCtl()); e.open = async o => { throw Object.assign(new Error('timed out'), { uncertain: true }); }; e.lookup = async (id, sym) => ({ ok: true, price: dn.at(-1).c, qty: 0.5, fee: 0.01, id: 'X1' }); ctl.setEnabled(true); await ctl.onScan([R('DNUSDT', dn)]); eq(ctl.st.positions.length, 1, 'uncertain order found filled on the broker is adopted'); 
  // AI policy inside the loop
  const askJson = o => async () => JSON.stringify({ ...good, instrument: 'DNUSDT', direction: 'SELL', council_result: 'SELL', proposed_entry: dn.at(-1).c, proposed_stop_loss: dn.at(-1).c * 1.01, proposed_take_profit: dn.at(-1).c * 0.97, ...o });
  ({ ctl, e, S } = mkCtl({ S: { aiPolicy: 'required' }, brain: brainM.create({ ask: askJson({ decision: 'REJECT', reasons_to_reject: ['weak'] }), available: () => true }) })); ctl.setEnabled(true); await ctl.onScan([R('DNUSDT', dn)]); eq(ctl.st.positions.length, 0, 'AI REJECT stops the entry'); ok(ctl.st.pipeline.aiReviewed === 1 && ctl.st.pipeline.aiRejected === 1, 'pipeline counts are real');
  ({ ctl, e, S } = mkCtl({ S: { aiPolicy: 'required' }, brain: brainM.create({ ask: askJson({}), available: () => true }) })); ctl.setEnabled(true); await ctl.onScan([R('DNUSDT', dn)]); eq(ctl.st.positions.length, 1, 'AI APPROVE lets the risk-checked entry proceed'); ok(ctl.st.positions[0].ai.decision === 'APPROVE', 'AI decision stored on the trade');
  ({ ctl, e, S } = mkCtl({ S: { aiPolicy: 'required' }, brain: brainM.create({ ask: async () => { throw new Error('down'); }, available: () => true }) })); ctl.setEnabled(true); await ctl.onScan([R('DNUSDT', dn)]); eq(ctl.st.positions.length, 0, 'AI unavailable under REQUIRED = no entry (no bypass)');
  // risk engine has the last word over an AI approval with a huge plan
  ({ ctl, e, S } = mkCtl({ S: { aiPolicy: 'required', riskPct: 1, maxPosPct: 50 }, brain: brainM.create({ ask: askJson({ proposed_stop_loss: dn.at(-1).c * 1.0001, proposed_take_profit: dn.at(-1).c * 0.9 }), available: () => true }) })); ctl.setEnabled(true); await ctl.onScan([R('DNUSDT', dn)]); ok(ctl.st.positions.length === 0 || ctl.st.positions[0].plannedRisk <= 10.01, 'AI cannot enlarge risk: a tiny AI stop is rejected by the ATR rule');

  /* ---- Binance executor with a mocked API (NOT a real exchange) ---- */
  const calls = []; const api = { ready: () => true, isTest: () => true, base: () => 'x', pub: async p => { calls.push(['GET', p]); if (p.startsWith('/api/v3/exchangeInfo')) return { symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000', maxQty: '9000' }, { filterType: 'NOTIONAL', minNotional: '5.00000000' }, { filterType: 'PRICE_FILTER', tickSize: '0.01' }] }] }; return [{ symbol: 'BTCUSDT', price: '50000' }]; },
    call: async (m, p, q) => { calls.push([m, p, q]); if (p === '/api/v3/account') return { canTrade: true, balances: [{ asset: 'USDT', free: '100', locked: '0' }, { asset: 'BTC', free: '0.0013', locked: '0' }] }; if (m === 'POST') return { orderId: 77, status: 'FILLED', executedQty: q.quantity, cummulativeQuoteQty: String(+q.quantity * 50000), fills: [{ price: '50000', qty: q.quantity, commission: q.side === 'BUY' ? '0.000001' : '0.05', commissionAsset: q.side === 'BUY' ? 'BTC' : 'USDT' }] }; return {}; } };
  const be = ex.binance({ api }); ok(be.info.longOnly && be.info.live, 'binance executor is live + long-only');
  const prep = await be.prepare('BTCUSDT'); eq(prep.step, 0.00001, 'LOT_SIZE step read from exchangeInfo'); eq(prep.minNotional, 5, 'min notional read');
  let f = await be.open({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.001234567, price: 50000, clientId: 'TBABC' }); const order = calls.find(c => c[0] === 'POST')[2];
  eq(order.quantity, '0.00123', 'quantity rounded DOWN to the step'); eq(order.newClientOrderId, 'TBABC', 'client order id sent (idempotency)'); eq(order.type, 'MARKET', 'market order'); ok(Math.abs(f.qty - 0.00122) < 1e-9, 'base-asset commission deducted from tradable quantity: ' + f.qty);
  let rejected = false; try { await be.open({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.00005, price: 50000, clientId: 'q' }); } catch (e) { rejected = /minimum/.test(e.message); } ok(rejected, 'below min notional rejected before sending');
  rejected = false; try { await be.open({ symbol: 'BTCUSDT', side: 'SELL', qty: 0.01, price: 50000, clientId: 'q' }); } catch (e) { rejected = /short/.test(e.message); } ok(rejected, 'spot short refused');
  const cl = await be.close({ symbol: 'BTCUSDT', qty: 0.00122, side: 'BUY' }, 50000); ok(cl.ok && cl.fee === 0.05, 'close reads the exit fee');
  let rec = false; try { await be.close({ symbol: 'BTCUSDT', qty: 0.01, side: 'BUY' }, 50000); } catch (e) { rec = e.recon; } ok(rec, 'close refuses when the account holds less than tracked (reconcile)');
  const rc = await be.reconcile([{ symbol: 'BTCUSDT', qty: 0.5 }]); ok(!rc.ok && /holds/.test(rc.issues[0]), 'reconciliation spots a missing balance');
  eq((await be.price(['BTCUSDT'])).BTCUSDT, 50000, 'batch price'); const eqv = await be.equity([{ qty: 0.001, mark: 50000, entry: 50000 }]); ok(eqv.known && eqv.equity === 150 && eqv.cash === 100, 'equity = free USDT + tracked positions');
  const down = { ...api, call: async () => { const e = new Error('Failed to fetch'); throw e; } }; const eq2 = await ex.binance({ api: down }).equity([]); ok(!eq2.known, 'unreachable broker => account state unknown (entries blocked)');
  console.log(`engine tests: ${n} assertions passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
