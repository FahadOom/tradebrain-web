/* v9: data source rules, Deriv candles, scalp trigger, supervision, AI sizing, Deriv executor (mock), scout, replay tests. */
const assert = require('assert');
const eng = require('../js/engine.js'), brainM = require('../js/brain.js'), ctlM = require('../js/controller.js'), ex = require('../js/executors.js'), sc = require('../js/scanner.js');
const dsF = require('../js/datasource.js'), scoutM = require('../js/scout.js'), bt = require('../js/backtest.js'), risk = require('../js/risk.js'), store = require('../js/store.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; }, eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
function gen(len, drift, vol, seed, tf = 9e5, base = 100, now = Date.now(), noVol) { const r = rng(seed); let p = base; const out = []; for (let i = 0; i < len; i++) { const o = p, c = o * (1 + drift + (r() - 0.5) * vol), t = now - (len - i) * tf; out.push({ t, o, h: Math.max(o, c) * (1 + r() * 0.001), l: Math.min(o, c) * (1 - r() * 0.001), c, v: noVol ? null : 100 + r() * 50, closeT: t + tf - 1 }); p = c; } return out; }

(async () => {
  /* ---- data source rule: Deriv wins, Binance next, nothing = locked ---- */
  const mk = (d, b, S = {}, execName = 'paper', extra = {}) => dsF.create({ env: () => ({ deriv: d && { ready: () => d.ready, send: d.send || (async () => ({})) }, binance: b && { ready: () => b.ready, live: () => b.ready, pub: b.pub || (async () => []) }, S: () => ({ sourcePref: 'auto', ...S }), execName: () => execName }), now: () => Date.now() });
  eq(mk(null, null).source(), null, 'no broker -> no source'); eq(mk(null, null).ready(), false, 'locked');
  eq(mk({ ready: false }, { ready: true }).source().id, 'binance', 'only Binance');
  eq(mk({ ready: true }, { ready: false }).source().id, 'deriv', 'only Deriv');
  eq(mk({ ready: true }, { ready: true }).source().id, 'deriv', 'both -> Deriv (more markets)');
  eq(mk({ ready: true }, { ready: true }, { sourcePref: 'binance' }).source().id, 'binance', 'user preference');
  eq(mk({ ready: true }, { ready: true }, {}, 'binance').source().id, 'binance', 'Binance executor forces Binance data');
  eq(mk({ ready: true }, { ready: true }, { sourcePref: 'binance' }, 'deriv').source().id, 'deriv', 'Deriv executor forces Deriv data');
  let threw = false; try { await mk(null, null).candles('R_100', '15m'); } catch (e) { threw = /No broker/.test(e.message); } ok(threw, 'no candles without a broker');

  /* ---- Deriv candles: epoch seconds, no volume, forming candle dropped; markets open/closed ---- */
  const nowS = Math.floor(Date.now() / 1000), gran = 900, raw = Array.from({ length: 100 }, (_, i) => { const e = (Math.floor(nowS / gran) - 99 + i) * gran; return { epoch: e, open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100.5 + i * 0.1 }; });
  const sent = [];
  const D = mk({ ready: true, send: async m => { sent.push(m); if (m.active_symbols) return { active_symbols: [{ underlying_symbol: 'R_100', display_name: 'Vol 100', market: 'synthetic_index', exchange_is_open: 1 }, { symbol: 'frxEURUSD', display_name: 'EUR/USD', market: 'forex', exchange_is_open: 0 }, { symbol: 'frxGBPUSD', display_name: 'GBP/USD', market: 'forex', exchange_is_open: 1, is_trading_suspended: 1 }] }; if (m.ticks_history) return m.style === 'ticks' ? { history: { prices: [123.4] } } : { candles: raw }; return {}; } }, null);
  const list = await D.markets(); eq(list.length, 3, 'three Deriv markets'); eq(list.filter(m => m.open).length, 1, 'closed + suspended flagged'); eq(list[0].symbol, 'R_100', 'open first');
  const cs = await D.candles('R_100', '15m'); ok(cs.length === 99, 'forming candle dropped: ' + cs.length); ok(cs.every(c => c.v === null), 'Deriv candles carry no volume'); ok(cs[0].t === raw[0].epoch * 1000 && cs[0].closeT === raw[0].epoch * 1000 + 899999, 'epoch -> ms');
  eq(sent.find(m => m.ticks_history).granularity, 900, 'granularity in seconds'); await D.candles('R_100', '15m'); eq(sent.filter(m => m.ticks_history).length, 1, 'candles are cached (rate limit)');
  let closed = false; try { await D.candles('frxEURUSD', '15m'); } catch (e) { closed = /closed or suspended/.test(e.message); } ok(closed, 'closed market refused');
  eq((await D.prices(['R_100'])).R_100, 123.4, 'Deriv price via ticks_history');
  ok(D.defaultWatch(list, 'deriv').includes('R_100') && !D.defaultWatch(list, 'deriv').includes('frxEURUSD'), 'default watchlist has open markets only');

  /* ---- volume-less data does not block the original council ---- */
  const nv = gen(200, 0.002, 0.004, 1, 9e5, 100, Date.now(), true), an = sc.analyse('R_100', '15m', nv, { jitterOn: true, volumeOn: true, minEff: .25, minRR: 1.5 });
  eq(an.noVolFeed, true, 'noVolFeed flagged'); const cand = eng.evaluate({ ...an, candles: nv }, { minEff: .25, minEffPct: 25, minRR: 1.5, jitterOn: true, volumeOn: true, mode: 'normal', councilMin: 2 }, { tfMs: 9e5 });
  const execGate = cand.council.gates.find(g => g.name === 'Execution'); ok(execGate && execGate.verdict === 'PASS', 'Execution gate passes without volume: ' + (execGate && execGate.why));

  /* ---- scalp trigger ---- */
  const S = { minEff: .25, minEffPct: 25, minRR: 1.5, jitterOn: true, volumeOn: true, councilMin: 2, mode: 'normal', minVoters: 2 };
  const fake = (side, main, voters) => ({ side, main, council: { members: Array.from({ length: voters }, (_, i) => ({ name: 'T' + i, verdict: side })) } });
  ok(eng.trigger(fake('BUY', 'BUY', 2), S, 'normal').ok, 'normal: main + 2 traders -> ready');
  ok(!eng.trigger(fake('BUY', 'WAIT', 3), S, 'normal').ok, 'normal: council alone is only a watch');
  eq(eng.trigger(fake('BUY', 'WAIT', 3), S, 'normal').stage, 'watch', 'stage watch');
  ok(!eng.trigger(fake('BUY', 'BUY', 1), S, 'normal').ok, 'normal: one trader is not enough');
  ok(eng.trigger(fake('SELL', 'WAIT', 2), S, 'mad').ok && eng.trigger(fake('SELL', 'SELL', 1), S, 'mad').ok && !eng.trigger(fake('SELL', 'WAIT', 1), S, 'mad').ok, 'mad: either route');
  ok(!eng.trigger(fake('BUY', 'BUY', 2), S, 'aplus').ok && eng.trigger(fake('BUY', 'BUY', 3), S, 'aplus').ok, 'aplus needs 3 traders');
  ok(eng.profile({ ...S }, 'aplus').longTerm && eng.profile(S, 'aplus').maxHoldMin >= 2880, 'A+ is long-term');
  ok(eng.profile(S, 'mad').maxPos > eng.profile(S, 'normal').maxPos && eng.profile(S, 'mad').maxAggLossPct > 3, 'MADBOT limits are looser than NORMAL but finite');

  /* ---- store: goal is not fixed ---- */
  const cl = store.clean({}); eq(cl.goal, 0, 'no default target'); eq(cl.goalSet, false, 'goal not set by default'); ok(store.clean({ watchD: ['R_100', 'frxEURUSD', 'bad symbol!'] }).watchD.length === 2, 'Deriv watchlist validated'); eq(store.clean({ executor: 'deriv' }).executor, 'deriv', 'deriv executor allowed');

  /* ---- brain: sizing fields, supervise, scout ---- */
  const asked = []; const bm = reply => brainM.create({ ask: async p => { asked.push(p); return typeof reply === 'function' ? reply(p) : reply; }, available: () => true, maxPerMin: 50 });
  let b = bm(JSON.stringify({ instrument: 'R_100', action: 'EXIT', confidence: 70, reasons: ['momentum fading'], market_changing: true }));
  let rv = await b.supervise({ pos: { id: 'p1', symbol: 'R_100', side: 'BUY', entry: 100, stop: 98, target: 106, tp1: 102 }, cand: { time: 1, side: 'WAIT', main: 'WAIT', council: { net: 0.1, agreeFamilies: 0, opposeFamilies: 0, members: [] }, regime: 'Ranging' }, price: 103, progressR: 1.5, minutes: 300, signs: ['Council lost its direction'] });
  ok(rv.ok && rv.action === 'EXIT', 'supervise EXIT parsed'); ok(/weakening_signs/.test(asked[0]), 'signs sent to the AI');
  rv = await bm('nonsense').supervise({ pos: { id: 'p2', symbol: 'R_100', side: 'BUY', entry: 1, stop: 1, target: 1 }, cand: null, price: 1, progressR: 0, minutes: 1, signs: [] }); ok(!rv.ok, 'invalid supervise reply rejected');
  const tbl = [{ symbol: 'R_100' }, { symbol: 'R_50' }]; rv = await bm(JSON.stringify({ picks: [{ symbol: 'R_50', bias: 'BUY', why: 'clean' }, { symbol: 'FAKE', bias: 'SELL', why: 'x' }], note: 'n' })).scout(tbl, 5); ok(rv.ok && rv.picks.length === 1 && rv.picks[0].symbol === 'R_50', 'scout keeps only listed symbols');
  const good = { instrument: 'BTCUSDT', direction: 'BUY', decision: 'APPROVE', strategy: 'trend', market_regime: 'Trending', confidence: 70, supporting_evidence: ['a'], conflicting_evidence: [], reasons_to_reject: [], invalidation: ['b'], size_factor: 0.5, max_entries: 2 };
  const vv = brainM.validate(good, { symbol: 'BTCUSDT', side: 'BUY', council: { verdict: 'BUY' }, price: 100, plan: null, regime: 'Trending' }); ok(vv.ok && vv.decision.sizeFactor === 0.5 && vv.decision.entries === 2, 'size_factor and max_entries parsed');
  eq(brainM.validate({ ...good, size_factor: 5, max_entries: 9 }, { symbol: 'BTCUSDT', side: 'BUY', council: { verdict: 'BUY' }, price: 100, regime: 'x' }).decision.sizeFactor, 1, 'AI can never raise size above the plan');

  /* ---- scout: sweep + backup analyst ---- */
  const mkts = [...Array(12)].map((_, i) => ({ symbol: 'M' + i, group: i % 3 ? 'forex' : 'synthetic_index', open: i !== 4 }));
  const u = scoutM.universe(mkts, ['M7'], 6); ok(u[0].symbol === 'M7' && u.length === 6 && !u.some(m => m.symbol === 'M4'), 'universe: watchlist first, closed markets out, groups mixed');
  const scanFake = async syms => ({ results: syms.map((s, i) => ({ symbol: s, price: 100, signal: i % 2 ? 'BUY' : 'WAIT', score: 60 + i, trend: 'Bullish', rsi: 55, eff: 0.4 + i * 0.01, atr: 0.5 })), errors: [] });
  let sr = await scoutM.run({ markets: async () => mkts, watch: [], cap: 8, top: 3, tf: '5m', scan: scanFake, brain: null, backup: true, aiAvailable: () => false }); eq(sr.by, 'backup', 'AI down -> backup analyst'); ok(sr.picks.length === 3, 'backup picks N');
  sr = await scoutM.run({ markets: async () => mkts, watch: [], cap: 8, top: 3, tf: '5m', scan: scanFake, backup: true, aiAvailable: () => true, brain: { scout: async t => ({ ok: true, picks: [{ symbol: t[0].symbol, bias: 'BUY', why: 'x' }], note: '' }) } }); eq(sr.by, 'AI', 'AI picks used when available');
  sr = await scoutM.run({ markets: async () => mkts, watch: [], cap: 8, top: 3, tf: '5m', scan: scanFake, backup: true, aiAvailable: () => true, brain: { scout: async () => ({ ok: false, errors: ['limited'] }) } }); eq(sr.by, 'backup', 'AI error -> backup');
  sr = await scoutM.run({ markets: async () => mkts, watch: [], cap: 8, top: 3, tf: '5m', scan: scanFake, backup: false, aiAvailable: () => false }); eq(sr.picks.length, 0, 'backup off -> no picks');

  /* ---- Deriv executor (mock API) ---- */
  const calls = []; let sold = false;
  const api = { ready: () => true, acct: () => ({ id: 'VRTC1', demo: true, bal: 10000, cur: 'USD' }), kind: () => 'pat', refresh: async () => ({ bal: 10000 }), send: async m => { calls.push(m);
    if (m.contracts_for) return { contracts_for: { available: [{ contract_type: 'MULTUP', multiplier_range: [10, 20, 50, 100, 200] }, { contract_type: 'MULTDOWN', multiplier_range: [10, 20, 50, 100, 200] }] } };
    if (m.proposal) return { proposal: { id: 'pr1', ask_price: m.amount, commission: 0.05 } }; if (m.buy) return { buy: { contract_id: 777, buy_price: 50 } };
    if (m.proposal_open_contract) return sold ? { proposal_open_contract: { is_sold: 1, profit: -4.2, current_spot: 98 } } : { proposal_open_contract: { entry_spot: 100.1, current_spot: 100.4, is_sold: 0 } };
    if (m.sell) return { sell: { sold_for: 55, transaction_id: 888 } }; return {}; } };
  const dx = ex.deriv({ api }); const prep = await dx.prepare('R_100'); ok(prep.up.length === 5, 'multipliers read');
  const fill = await dx.open({ symbol: 'R_100', side: 'BUY', qty: 5, price: 100, stop: 98, target: 104, clientId: 'x' });
  const prop = calls.find(m => m.proposal); ok(prop.contract_type === 'MULTUP' && prop.multiplier <= 0.8 * 100 / 2 && prop.limit_order.stop_loss < prop.amount, 'multiplier chosen so Deriv cannot stop out before the planned stop: x' + prop.multiplier + ' stake ' + prop.amount + ' sl ' + prop.limit_order.stop_loss);
  ok(Math.abs(prop.limit_order.stop_loss - fill.qty * 2) < 0.02 * Math.max(1, fill.qty), 'stop-loss amount equals planned risk'); eq(fill.id, '777', 'contract id'); ok(fill.price === 100.1 && fill.extra.stake === prop.amount, 'entry spot and stake returned');
  const pos = { id: 'p', symbol: 'R_100', side: 'BUY', entry: fill.price, qty: fill.qty, ex: fill.extra };
  const cl1 = await dx.close(pos, 100.4, 'x'); ok(Math.abs((cl1.price - pos.entry) * pos.qty - (55 - fill.extra.stake)) < 1e-6, 'close price reproduces the real profit');
  eq((await dx.poll([pos])).length, 0, 'open contract not reported closed'); sold = true; const pl = await dx.poll([pos]); ok(pl.length === 1 && /stop-loss/.test(pl[0].reason) && Math.abs((pl[0].price - pos.entry) * pos.qty + 4.2) < 1e-6, 'Deriv-side stop-loss detected and valued');
  let e1 = ''; try { await dx.open({ symbol: 'R_100', side: 'BUY', qty: 0.001, price: 100, stop: 98, target: 104 }); } catch (e) { e1 = e.message; } ok(/minimum/.test(e1), 'tiny stake refused, not raised: ' + e1);
  e1 = ''; try { await dx.open({ symbol: 'R_100', side: 'BUY', qty: 5, price: 100, stop: 99.9999, target: 104 }); } catch (e) { e1 = e.message; } ok(/multiplier|rounds to zero/i.test(e1), 'too-tight stop refused: ' + e1);

  /* ---- controller: A+ TP1 + AI exit, AI sizing, backup analyst ---- */
  let clock = Date.now();
  const SS = { ...{ minEff: .25, minEffPct: 25, minRR: 1.5, jitterOn: true, volumeOn: true, councilMin: 2, mode: 'aplus', riskPct: 1, lossPct: 60, start: 1000, now: 1000, goal: 0, goalSet: true, action: 'pause', maxExposurePct: 100, sizeMode: 'hybrid', aiPolicy: 'required', maxNewPerScan: 2, feePct: 0.02, slipPct: 0.01, aiWatch: 'aplus', tp1R: 1, profiles: { aplus: { requireAplus: false, minScore: 30, minFamilies: 1, minNet: 0.1, trigger: 'either', minVoters: 1, cooldownMin: 0, maxEntriesHour: 20 } } } };
  const e = ex.paper({ balance: 1000, fees: () => ({ feePct: 0.02, slipPct: 0.01 }) });
  let supReply = { instrument: 'XUSDT', action: 'HOLD', confidence: 60, reasons: ['fine'], market_changing: false }, approve = (c) => ({ instrument: c.instrument || 'XUSDT', direction: 'BUY', decision: 'APPROVE', strategy: 'trend', market_regime: 'Trending', confidence: 75, supporting_evidence: ['t'], conflicting_evidence: [], reasons_to_reject: [], invalidation: ['x'], size_factor: 0.5, max_entries: 1 });
  const brain = brainM.create({ ask: async p => { if (/Open position and fresh evidence/.test(p)) return JSON.stringify(supReply); const m = /"instrument":"([A-Z]+)"/.exec(p); const pr = JSON.parse(p.split('\n')[1]); const o = { ...approve({ instrument: m[1] }), direction: pr.proposed_direction }; return JSON.stringify(o); }, available: () => true, maxPerMin: 100 });
  const ctl = ctlM.create({ S: () => SS, executor: e, brain, now: () => clock, tfMs: () => 9e5, persist() {}, emit() {} });
  const R = (sym, candles) => ({ ...sc.analyse(sym, '15m', candles, { ...SS, minEff: .25 }), candles });
  const trendUp = gen(200, 0.002, 0.004, 1, 9e5, 100, clock); ctl.setEnabled(true); await ctl.onScan([R('XUSDT', trendUp)]);
  ok(ctl.st.positions.length === 1, 'A+ test entry opened: ' + JSON.stringify(ctl.st.decisions.slice(0, 2)));
  const p0 = ctl.st.positions[0]; ok(p0.longTerm && p0.tp1 > p0.entry && p0.tp1 < p0.target, 'A+ position has TP1 below TP2');
  const risk$ = p0.qty * p0.risk0; ok(risk$ <= 1000 * 0.01 * 0.5 + 1e-6, 'AI size_factor 0.5 halved the risk: $' + risk$.toFixed(2) + ' vs $10');
  ok(p0.ai && p0.ai.sizeFactor === 0.5, 'sizing decision recorded');
  // price reaches TP1 -> break-even + log; then the market turns -> exit after TP1 even though TP2 is far
  const tpBar = { t: clock + 9e5, o: p0.entry, h: p0.tp1 + 0.01, l: p0.entry, c: p0.tp1 }; eq(ctl.step(p0, tpBar), null, 'TP1 touch is not an exit'); ok(p0.tp1Hit && p0.stop >= p0.entry, 'TP1 hit moves the stop to break-even');
  const turn = gen(200, -0.002, 0.004, 2, 9e5, p0.entry, clock + 9e5); p0.mark = p0.tp1; clock += 9e5;
  await ctl.onScan([R('XUSDT', turn.map((c, i) => ({ ...c, c: i > 150 ? c.c * 0.995 : c.c })))]);
  ok(ctl.st.journal.length >= 1 && /AI exit|weakness after TP1|invalidation|stop/.test(ctl.st.journal.at(-1).exitReason), 'market turned after TP1 -> trade closed early: ' + (ctl.st.journal.at(-1) || {}).exitReason);
  // AI EXIT before TP1
  supReply = { instrument: 'XUSDT', action: 'EXIT', confidence: 80, reasons: ['structure broken'], market_changing: true };
  clock += 9e5; const up2 = gen(200, 0.002, 0.004, 1, 9e5, 100, clock); SS.profiles.aplus.cooldownMin = 0; await ctl.onScan([R('XUSDT', up2)]);
  if (ctl.st.positions.length) { clock += 9e5; await ctl.onScan([R('XUSDT', gen(200, 0.002, 0.004, 1, 9e5, 100, clock))]); }

  /* ---- MADBOT backup analyst keeps trading when AI is down ---- */
  let madData = null; for (let sd = 1; sd < 60 && !madData; sd++) { const d = gen(200, 0.0008, 0.01, sd, 9e5, 100, clock), a = R('YUSDT', d); if (a.rsi > 52 && a.rsi < 68 && eng.evaluate(a, { ...SS, mode: 'mad', minEff: .25 }, { tfMs: 9e5 }).side === 'BUY') madData = d; } ok(madData, 'found mild uptrend sample');
  const e2 = ex.paper({ balance: 1000, fees: () => ({ feePct: 0.02, slipPct: 0.01 }) }), dead = brainM.create({ ask: async () => { throw new Error('quota'); }, available: () => true });
  const S2 = { ...SS, mode: 'mad', madBackup: true, profiles: { mad: { minScore: 30, minFamilies: 1, minNet: 0.1, cooldownMin: 0 } } };
  const c2 = ctlM.create({ S: () => S2, executor: e2, brain: dead, now: () => clock, tfMs: () => 9e5, persist() {}, emit() {} }); c2.setEnabled(true); await c2.onScan([R('YUSDT', madData)]);
  ok(c2.st.positions.length === 1 && c2.st.positions[0].ai && c2.st.positions[0].ai.backup, 'MADBOT trades with the backup analyst when the AI is down: ' + JSON.stringify(c2.st.decisions.slice(0, 2)));
  S2.madBackup = false; const c3 = ctlM.create({ S: () => S2, executor: ex.paper({ balance: 1000 }), brain: dead, now: () => clock, tfMs: () => 9e5, persist() {}, emit() {} }); c3.setEnabled(true); await c3.onScan([R('YUSDT', madData)]); eq(c3.st.positions.length, 0, 'backup off + AI down = no entry (policy required)');

  /* ---- goal: start follows the account until a goal is set; mismatch halts ---- */
  const e4 = ex.paper({ balance: 10000 }), S4 = { ...SS, start: 10, now: 10, goal: 30, goalSet: false }, c4 = ctlM.create({ S: () => S4, executor: e4, brain, now: () => clock, tfMs: () => 9e5, persist() {}, emit() {} });
  await c4.refreshAccount(); eq(S4.start, 10000, 'start follows the account when no goal is set'); eq(S4.goal, 0, 'the old fixed 30 target is dropped');
  const S5 = { ...SS, start: 10, goal: 30, goalSet: true }, c5 = ctlM.create({ S: () => S5, executor: ex.paper({ balance: 10000 }), brain, now: () => clock, tfMs: () => 9e5, persist() {}, emit() {} }); await c5.refreshAccount(); ok(/does not match/.test(c5.haltReason() || ''), 'a user goal that does not match the account blocks entries with a clear message');

  /* ---- replay tests ---- */
  const f = bt.follow([{ h: 101, l: 99.5, c: 100 }, { h: 103, l: 100, c: 102 }, { h: 106, l: 102, c: 105 }], 0, 'BUY', { entry: 100, stop: 98, target: 104 }, 0.0003, null);
  ok(f.kind === 'target' && f.r > 1.9 && f.r < 2, 'follow: target hit in R after costs ' + f.r.toFixed(3)); eq(bt.follow([{ h: 100.5, l: 97, c: 98 }], 0, 'BUY', { entry: 100, stop: 98, target: 104 }, 0, null).r, -1, 'follow: stop = -1R');
  eq(bt.follow([{ h: 105, l: 97, c: 98 }], 0, 'BUY', { entry: 100, stop: 98, target: 104 }, 0, null).kind, 'stop', 'stop wins a tie inside one candle');
  const data = gen(700, 0.0015, 0.006, 11, 3e5, 100, Date.now()); const res = await bt.run({ engine: eng, scanner: sc, S: { ...SS, mode: 'normal', profiles: {} }, symbols: ['AAA'], candles: async (s, tf, c) => data.slice(-c) }, 'S4');
  ok(res.markets.length === 1 && res.total.signals >= 0 && res.tf === '5m' && res.bars === 48, 'S4 replay runs on 5m for 48 bars'); ok(res.total.signals === res.total.closed + res.total.open, 'signals = closed + open');
  eq(bt.WINDOWS.A7.span, 7 * 864e5, '7-day window'); eq(bt.WINDOWS.S1.tf, '1m', '1-hour test uses 1m');

  console.log(`v9 tests: ${n} assertions passed`);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
