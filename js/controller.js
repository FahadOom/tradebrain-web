/* TradeBrain · Continuous Scalping Controller.
   scan -> evaluate (strategies + Council) -> qualify for the active mode -> size -> independent risk check -> AI Brain policy -> risk re-check
   -> submit -> confirm fill -> manage (break-even, trail, time, invalidation) -> exit -> journal -> re-scan.
   A signal is not an order, an order is not a fill, and an exit request is not a close: positions only change state on a confirmed executor result.
   Runs only while the app is open (no server). Exits are monitored by this app, not by an exchange-side stop, unless the executor says otherwise. */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./engine.js') : root.TB.engine, isNode ? require('./risk.js') : root.TB.risk, isNode ? require('./gates.js') : root.TB.gates, isNode ? require('./strategies.js') : root.TB.strat);
  if (isNode) module.exports = api; else { root.TB = root.TB || {}; root.TB.controller = api; }
})(typeof self !== 'undefined' ? self : this, function (engine, risk, gates, strat) {
  'use strict';
  const dirOf = side => (side === 'BUY' ? 1 : -1);

  function create(cfg) {
    const now = () => (cfg.now ? cfg.now() : Date.now()), S = () => cfg.S();
    const g = (k, d) => (S()[k] != null ? S()[k] : d);
    let executor = cfg.executor, busy = Promise.resolve();
    const st = { enabled: false, halted: null, positions: [], journal: [], recent: [], seen: new Set(), feed: [], decisions: [], cands: [], pipeline: {}, account: { equity: 0, cash: 0, known: false, start: 0, dayPnl: 0 }, needRescan: false, orders: 0, lastSkip: {}, lastScanAt: null, haltLogged: null };
    const lock = fn => { const run = busy.then(fn, fn); busy = run.catch(() => {}); return run; };
    const persist = () => { if (cfg.persist) cfg.persist(); };

    function log(type, text, level, symbol) {
      const e = { t: now(), type, text, level: level || 'info', symbol: symbol || null };
      st.feed.unshift(e); if (st.feed.length > 200) st.feed.length = 200; if (cfg.emit) cfg.emit(e); return e;
    }
    function decide(cand, stage, text, level) {
      const k = cand.symbol + '|' + stage;
      if (st.lastSkip[k] === text && stage !== 'executed') return;       // do not repeat the same refusal every scan
      st.lastSkip[k] = text; st.decisions.unshift({ t: now(), symbol: cand.symbol, side: cand.side, score: cand.score, stage, text, level: level || 'info' }); if (st.decisions.length > 80) st.decisions.length = 80;
    }
    const fees = () => ({ feePct: g('feePct', 0.1), slipPct: g('slipPct', 0.05) });
    const dayStart = () => new Date(now()).setHours(0, 0, 0, 0);
    const realisedToday = () => st.journal.filter(t => t.closedAt >= dayStart()).reduce((s, t) => s + t.pnl, 0);
    const unrealised = () => st.positions.reduce((s, p) => s + (p.upnl || 0), 0);
    const limits = () => {
      const p = engine.profile(S(), S().mode), x = { ...S(), maxPos: p.maxPos, maxPerSymbol: p.maxPerSymbol, maxEntriesHour: p.maxEntriesHour, cooldownMin: p.cooldownMin };
      ['maxAggLossPct', 'maxExposurePct', 'maxCorrelated'].forEach(k => { if (p[k] != null) x[k] = p[k]; });       // MADBOT's looser (but still hard) portfolio limits
      return x;
    };
    /** A rule-based second analyst, used only in MADBOT when every AI key is down: it can stand in for the AI approval, never for the risk engine. */
    function backupAnalyst(cand) {
      const d = dirOf(cand.side), no = why => ({ ok: false, why }), minEff = (S().minEffPct || 25) / 100;
      if (cand.council.net * d < 0.25) return no(`Council conviction ${(cand.council.net * d).toFixed(2)} below 0.25.`);
      if (cand.regime === 'Abnormal') return no('Market regime is abnormal.');
      if (cand.eff != null && cand.eff < minEff) return no('Price action too choppy.');
      if (cand.rsi != null && (cand.side === 'BUY' ? cand.rsi > 78 : cand.rsi < 22)) return no('RSI is stretched against the entry.');
      if (!cand.plan || cand.plan.rr < (S().minRR || 1.5)) return no('Reward:risk is below the minimum.');
      return { ok: true, why: `Backup analyst: council ${(cand.council.net * d).toFixed(2)}, regime ${cand.regime}, RR ${cand.plan.rr.toFixed(2)}.` };
    }

    /* ---------- state of the account ---------- */
    async function refreshAccount() {
      const a = await executor.equity(st.positions).catch(e => ({ equity: 0, cash: 0, known: false, error: e.message }));
      // Until the user sets a goal, the starting balance simply follows the account being traded (no hidden fixed $10 -> $30).
      const key = executor.info.name + ':' + (executor.accountId ? executor.accountId() : '');
      if (a.known && a.equity > 0 && st.syncKey !== key) { st.syncKey = key; if (!S().goalSet && !st.positions.length) { S().start = S().now = +a.equity.toFixed(2); if (S().goal <= S().start) S().goal = 0; persist(); } }
      st.account = { equity: a.equity, cash: a.cash, known: a.known, error: a.error || null, start: S().start, dayPnl: realisedToday() + unrealised(), canTrade: a.canTrade };
      return st.account;
    }
    function haltReason() {
      if (st.halted) return st.halted;
      if (!st.account.known) return 'Account state is unknown (broker disconnected or not confirmed).';
      if (S().start > 0 && st.account.equity > 0 && (st.account.equity / S().start > 8 || st.account.equity / S().start < 0.125)) return `Starting balance ${S().start} does not match this account (${st.account.equity.toFixed(2)}). Open Overview and tap "Use current balance as start" so loss limits are measured correctly.`;
      const k = gates.killSwitch({ start: S().start, now: st.account.equity, lossPct: S().lossPct, goal: S().goal, action: S().action });
      if (k) return k;
      if (S().deadline && new Date(S().deadline).getTime() < now()) return 'Mission deadline reached: no new entries.';
      if (st.account.dayPnl <= -S().start * S().lossPct / 100) return 'Daily loss limit reached: trading locked out for today.';
      return null;
    }
    function missionStatus() {
      if (!executor) return 'Ready';
      const h = haltReason();
      if (st.halted && /manual|emergency/i.test(st.halted)) return 'Manually Paused';
      if (h) { if (/target/i.test(h)) return 'Target Reached'; if (/deadline/i.test(h)) return 'Deadline Reached'; if (/unknown|disconnect/i.test(h)) return 'Broker Disconnected'; return 'Risk Halted'; }
      return st.enabled ? (st.positions.length ? 'Active' : 'Scanning') : 'Ready';
    }

    /* ---------- exits ---------- */
    /** Evaluate one price bar against a position. Stop is checked with the stop as it was at the start of the bar (conservative: stop wins a tie). Mutates trailing stop AFTER the checks. */
    function step(pos, bar) {
      const d = dirOf(pos.side), buy = d > 0;
      if (buy ? bar.l <= pos.stop : bar.h >= pos.stop) { const gap = buy ? bar.o < pos.stop : bar.o > pos.stop, px = gap ? bar.o : pos.stop; return { price: px, reason: (buy ? pos.stop >= pos.entry : pos.stop <= pos.entry) ? 'trailing/break-even stop' : 'stop-loss', kind: 'stop' }; }
      if (buy ? bar.h >= pos.target : bar.l <= pos.target) { const gap = buy ? bar.o > pos.target : bar.o < pos.target; return { price: gap ? bar.o : pos.target, reason: 'take-profit', kind: 'limit' }; }
      const ext = buy ? bar.h : bar.l, prog = (ext - pos.entry) * d / pos.risk0, costDist = pos.entry * (g('feePct', 0.1) + g('slipPct', 0.05)) * 2 / 100;
      if (pos.tp1 && !pos.tp1Hit && (buy ? bar.h >= pos.tp1 : bar.l <= pos.tp1)) { pos.tp1Hit = true; pos.justTp1 = true; const ns = pos.entry + d * costDist; if (buy ? ns > pos.stop : ns < pos.stop) { pos.stop = ns; pos.beDone = true; } }
      if (g('beAtR', 1) > 0 && prog >= g('beAtR', 1)) { const ns = pos.entry + d * costDist; if (buy ? ns > pos.stop : ns < pos.stop) { pos.stop = ns; pos.beDone = true; } }
      if (g('trailOn', true) && pos.atr && prog >= g('trailAtR', 1.5)) { const ns = ext - d * pos.atr * g('trailMult', 1); if ((buy ? ns > pos.stop : ns < pos.stop) && (buy ? ns < pos.target : ns > pos.target)) { pos.stop = ns; pos.trailing = true; } }
      return null;
    }
    const markTo = (pos, px) => { pos.mark = px; pos.upnl = (px - pos.entry) * pos.qty * dirOf(pos.side); };

    async function closePosition(pos, ex) {
      if (pos.status !== 'open') return;
      pos.status = 'closing'; log('closing', `Closing ${pos.symbol} (${ex.reason}) at about ${ex.price.toPrecision(6)}…`, 'info', pos.symbol);
      let res;
      try { res = await executor.close(pos, ex.price, ex.reason, ex.kind); }
      catch (e) {
        if (e.uncertain || e.recon) { pos.status = 'recon'; st.halted = `Reconciliation required: close of ${pos.symbol} is not confirmed. Check the broker, then use "Re-check" before resuming.`; log('recon', st.halted + ' ' + e.message, 'bad', pos.symbol); }
        else { pos.status = 'open'; log('error', `Close of ${pos.symbol} failed: ${e.message}. Will retry.`, 'bad', pos.symbol); }
        persist(); return;
      }
      await finalize(pos, res, ex);
    }
    /** Book a closed position into the journal (our own close, or a close the broker did by itself). */
    async function finalize(pos, res, ex) {
      const d = dirOf(pos.side), gross = (res.price - pos.entry) * pos.qty * d, fee = (pos.fee || 0) + (res.fee || 0), pnl = gross - fee;
      const t = { id: pos.id, symbol: pos.symbol, side: pos.side, qty: pos.qty, entry: pos.entry, exit: res.price, stop0: pos.stop0, target0: pos.target0, openedAt: pos.openedAt, closedAt: now(), heldMs: now() - pos.openedAt,
        gross, fees: fee, pnl, r: pos.plannedRisk0 > 0 ? pnl / pos.plannedRisk0 : null, exitReason: ex.reason, strategy: pos.strategy, family: pos.family, regime: pos.regime, mode: pos.mode, tf: pos.tf, executor: executor.info.name, simulated: !!res.simulated,
        rationale: pos.rationale, council: pos.council, ai: pos.ai, riskChecks: pos.riskChecks, orderIds: { entry: pos.orderId, exit: res.id }, clientId: pos.clientId, slippage: { entryVsPlan: pos.entry - pos.planEntry }, version: strat.VERSION, sizing: pos.sizing };
      t.review = review(t);
      st.journal.push(t); if (st.journal.length > 500) st.journal.shift();
      st.positions = st.positions.filter(p => p.id !== pos.id); st.recent.push({ t: now(), symbol: pos.symbol, kind: 'exit' });
      st.needRescan = true; await refreshAccount();
      log('closed', `${pos.symbol} ${pos.side} closed: ${ex.reason}. Net ${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)} (${t.r != null ? t.r.toFixed(2) + 'R' : 'n/a'}), costs $${fee.toFixed(3)}.`, pnl >= 0 ? 'good' : 'bad', pos.symbol);
      persist();
    }

    /** Structured post-trade review: separates "lost while following the rules" from "system problem". */
    function review(t) {
      const notes = [], rules = /take-profit|stop-loss|trailing|time exit|strategy invalidation|emergency close|AI exit|weakness after TP1/.test(t.exitReason);
      notes.push(rules ? 'Exit followed the configured rules.' : 'Exit was not a standard rule exit; check the log.');
      if (Math.abs(t.gross) > 0 && t.fees > Math.abs(t.gross) * 0.5) notes.push(`Costs ate ${(t.fees / Math.abs(t.gross) * 100).toFixed(0)}% of the gross result; costs materially changed the outcome.`);
      if (t.slippage.entryVsPlan * dirOf(t.side) > 0) notes.push(`Entry filled ${Math.abs(t.slippage.entryVsPlan).toPrecision(3)} worse than planned.`);
      const kind = !rules ? 'review-needed' : t.pnl >= 0 ? 'win-following-rules' : 'loss-following-rules';
      notes.push(kind === 'win-following-rules' ? 'A win does not prove the decision was good; judge the setup over many trades.' : kind === 'loss-following-rules' ? 'A loss that followed the rules is a normal outcome, not a system error.' : 'Possible system or execution issue.');
      return { kind, notes };
    }

    /** Does the AI keep watching this position? A+ trades are long-term, so by default yes; Settings can extend it to every mode or switch it off. */
    const watched = pos => { const m = g('aiWatch', 'aplus'); return m === 'all' || (m === 'aplus' && (pos.longTerm || pos.mode === 'aplus')); };

    /** Signs that the market is turning against an open position, computed from the fresh evaluation. Pure. */
    function weakSigns(pos, c) {
      const d = dirOf(pos.side), signs = []; if (!c) return signs;
      if (c.side !== 'WAIT' && c.side !== pos.side) signs.push(`Council now leans ${c.side}`);
      else if (c.side === 'WAIT') signs.push('Council lost its direction');
      else if (c.council.net * d < 0.2) signs.push(`Council conviction faded to ${(c.council.net * d).toFixed(2)}`);
      if (c.main && c.main !== 'WAIT' && c.main !== pos.side) signs.push(`Main strategy flipped to ${c.main}`);
      if (c.regime === 'Abnormal') signs.push('Market regime turned abnormal');
      if (c.rsi != null && (pos.side === 'BUY' ? c.rsi > 80 : c.rsi < 20)) signs.push(`RSI stretched (${c.rsi.toFixed(0)})`);
      if (c.eff != null && c.eff < 0.12) signs.push('Price action turned to noise');
      return signs;
    }
    /** Returns an exit order, a stop tightening (applied in place) or null. */
    async function supervise(pos) {
      if (!watched(pos)) return null;
      const c = st.cands.find(x => x.symbol === pos.symbol); if (!c) return null;
      const d = dirOf(pos.side), px = pos.mark || pos.entry, signs = weakSigns(pos, c), prog = (px - pos.entry) * d / pos.risk0;
      let ai = null;
      if (cfg.brain && g('aiPolicy', 'required') !== 'off') ai = await cfg.brain.supervise({ pos, cand: c, price: px, progressR: prog, minutes: (now() - pos.openedAt) / 60e3, signs });
      const aiOk = ai && ai.ok, by = aiOk ? 'AI' : 'rules';
      pos.watch = { at: now(), by, signs, action: aiOk ? ai.action : 'HOLD', reasons: aiOk ? ai.reasons : [], note: aiOk ? '' : (ai ? ai.errors.join(' ') : 'AI off') };
      if (aiOk && ai.action === 'EXIT') return { price: px, reason: `AI exit${pos.tp1Hit ? ' after TP1' : ''}: ${ai.reasons[0] || 'market is changing'}`, kind: 'market' };
      if (pos.tp1Hit && signs.length >= (aiOk ? 2 : 1)) return { price: px, reason: `weakness after TP1: ${signs.join('; ')}`, kind: 'market' };
      if (!pos.tp1Hit && !aiOk && signs.length >= 2) return { price: px, reason: `strategy invalidation: ${signs.join('; ')}`, kind: 'market' };
      if (aiOk && ai.action === 'TIGHTEN' && pos.atr) {
        const ns = px - d * pos.atr, floorOk = d > 0 ? ns > pos.stop && ns < px : ns < pos.stop && ns > px;
        if (floorOk) { pos.stop = ns; pos.trailing = true; log('ai-watch', `AI tightened the stop on ${pos.symbol} to ${ns.toPrecision(6)}: ${ai.reasons[0] || 'protecting profit'}.`, 'info', pos.symbol); }
      }
      return null;
    }

    async function manageAll(results) {
      for (const pos of st.positions.slice()) {
        if (pos.status !== 'open') continue;
        const r = results.find(x => x.symbol === pos.symbol); let ex = null;
        if (r) {
          for (const bar of r.candles.filter(c => c.t >= pos.openedAt && c.t > (pos.checkedT || 0))) { pos.checkedT = bar.t; ex = step(pos, bar); if (ex) break; }
          markTo(pos, r.price);
        }
        if (pos.justTp1) { pos.justTp1 = false; log('tp1', `${pos.symbol} reached TP1 (${pos.tp1.toPrecision(6)}). Stop moved to break-even; the AI now watches for any sign of reversal.`, 'good', pos.symbol); }
        if (!ex && now() - pos.openedAt >= engine.profile(S(), pos.mode).maxHoldMin * 60e3) ex = { price: pos.mark || pos.entry, reason: 'time exit', kind: 'market' };
        if (!ex && g('invalidateExit', true)) {
          const c = st.cands.find(x => x.symbol === pos.symbol);
          if (c && c.side !== 'WAIT' && c.side !== pos.side && c.council.agreeFamilies >= 2 && Math.abs(c.council.net) >= 0.35) ex = { price: pos.mark || pos.entry, reason: 'strategy invalidation', kind: 'market' };
        }
        if (!ex) { try { ex = await supervise(pos); } catch (e) { log('error', `Supervision of ${pos.symbol} failed: ${e.message}`, 'warn', pos.symbol); } }
        if (ex) await closePosition(pos, ex);
      }
    }
    /** Positions the broker closed by itself (Deriv holds the stop-loss and take-profit on its servers). */
    async function adoptExternal() {
      if (!executor.poll) return; const open = st.positions.filter(p => p.status === 'open'); if (!open.length) return;
      let done = []; try { done = await executor.poll(open); } catch (e) { return; }
      for (const c of done) { const pos = st.positions.find(p => p.id === c.id); if (pos && pos.status === 'open') await finalize(pos, { price: c.price, fee: 0, id: pos.orderId, external: true }, { reason: c.reason, kind: 'exchange' }); }
    }

    /** Fast loop between scans: reads live prices for open positions only. */
    async function monitor() {
      return lock(async () => {
        const open = st.positions.filter(p => p.status === 'open'); if (!open.length) return;
        await adoptExternal();
        let prices; try { prices = await executor.price([...new Set(open.map(p => p.symbol))]); } catch (e) { return; }
        for (const pos of open.filter(p => p.status === 'open' && st.positions.includes(p))) { const px = prices[pos.symbol]; if (!(px > 0)) continue; markTo(pos, px); const ex = step(pos, { t: now(), o: px, h: px, l: px, c: px }); if (ex) await closePosition(pos, ex); }
        await refreshAccount();
      });
    }

    /* ---------- entries ---------- */
    function evaluateAll(results) {
      const Sx = limits(), perf = (family, regime) => { const ts = st.journal.filter(t => t.family === family && t.regime === regime); return { n: ts.length, expectancy: risk.stats(ts).expectancyR }; };
      st.cands = results.map(r => engine.evaluate(r, Sx, { tfMs: cfg.tfMs ? cfg.tfMs(r.tf) : 9e5, now: now(), perf, portfolio: { open: engine.corrOpen(r, results, st.positions), maxCorrelated: g('maxCorrelated', 2) } })).filter(Boolean)
        .sort((a, b) => (b.side !== 'WAIT') - (a.side !== 'WAIT') || b.score - a.score);
    }

    async function tryEnter(cand, results, pl) {
      const Sx = limits(), acct = st.account, ex = executor.info, prof = engine.profile(S(), S().mode), q = engine.qualifies(cand, S(), S().mode);
      if (!q.ok) return decide(cand, 'qualify', q.why);
      pl.qualified++;
      // Adding to a market that is already open: only when the first entry is working (>= 0.5R) and points the same way.
      const same = st.positions.filter(p => p.symbol === cand.symbol);
      if (same.length && same.some(p => p.side !== cand.side || ((p.mark || p.entry) - p.entry) * dirOf(p.side) / p.risk0 < 0.5)) return decide(cand, 'scalein', 'Already in this market. A second entry is only allowed when the first is at least 0.5R in profit and in the same direction.');
      let aiScale = 0, entriesCap = 0;
      if (ex.longOnly && cand.side === 'SELL') return decide(cand, 'broker', `${ex.label} cannot open a short; SELL ignored.`);
      let prep = {}; try { if (executor.prepare) prep = await executor.prepare(cand.symbol); } catch (e) { return decide(cand, 'broker', 'Instrument not tradable here: ' + e.message, 'bad'); }
      const sizeFor = plan => risk.size({ mode: g('sizeMode', 'hybrid'), aiScale, equity: acct.equity, cash: acct.cash, riskPct: S().riskPct, maxRiskPct: g('maxRiskPct', S().riskPct * 2), stopDist: plan.risk, price: cand.price, manualNotional: g('manualUsd', 0), maxPosPct: g('maxPosPct', 50),
        step: (executor.step && executor.step(cand.symbol)) || 1e-6, minNotional: prep.minNotional || ex.minNotional, ...fees() });
      const corrOpen = engine.corrOpen({ symbol: cand.symbol, candles: results.find(r => r.symbol === cand.symbol).candles }, results, st.positions).filter(c => c.side === cand.side);
      const check = plan => { const sz = sizeFor(plan); return { sz, rk: risk.check({ cand: { symbol: cand.symbol, side: cand.side, price: cand.price, plan, tf: cand.tf, key: cand.key, ageMs: cand.ageMs, tfMs: cand.tfMs, regime: cand.regime, quality: cand.quality }, size: sz,
        account: { equity: acct.equity, start: S().start, cash: acct.cash, dayPnl: acct.dayPnl, known: acct.known }, positions: st.positions, recent: st.recent.filter(r => r.kind === 'entry' || r.kind === 'exit'), corrOpen, S: { ...Sx, ...fees() }, now: now(), halted: null, brokerOk: acct.known, longOnly: ex.longOnly, seen: st.seen }) }; };
      let plan = cand.plan, { sz, rk } = check(plan);
      if (!rk.ok) return decide(cand, 'risk', 'Risk engine: ' + rk.reasons.join(' | '), 'warn');
      pl.riskOk++;
      // ---- AI Brain ----
      const policy = g('aiPolicy', 'required'); let aiInfo = null;
      if (policy !== 'off') {
        pl.aiReviewed++;
        const rv = await cfg.brain.review({ symbol: cand.symbol, tf: cand.tf, time: cand.time, side: cand.side, mode: S().mode, price: cand.price, regime: cand.regime, atr: cand.atr, ema21: cand.ema21, rsi: cand.rsi, eff: cand.eff, vol: cand.vol, plan, score: cand.score,
          council: cand.council, aplus: cand.aplus, equity: acct.equity, openPositions: st.positions.length, openSymbols: st.positions.map(p => p.symbol), dayPnl: acct.dayPnl, riskPct: S().riskPct, minRR: S().minRR, longOnly: ex.longOnly, executor: ex.name });
        let gt = cfg.brain.gate(rv, policy), backup = null;
        if (!gt.allow && S().mode === 'mad' && g('madBackup', true) && (!rv || !rv.ok)) {       // every AI is down: the backup analyst keeps MADBOT scalping (risk engine unchanged)
          const b = backupAnalyst(cand); if (b.ok) { gt = { allow: true, reason: b.why, plan: null }; backup = b; } else gt = { ...gt, reason: gt.reason + ' Backup analyst also declined: ' + b.why };
        }
        aiInfo = rv && rv.ok ? { decision: rv.decision.decision, confidence: rv.decision.confidence, support: rv.decision.support, conflicts: rv.decision.conflicts, invalidation: rv.decision.invalidation, sizeFactor: rv.decision.sizeFactor, entries: rv.decision.entries, policy } : backup ? { decision: 'BACKUP', policy, backup: true, note: backup.why } : { decision: 'NONE', policy, errors: rv ? rv.errors : [] };
        if (!gt.allow) { if (rv && rv.ok && rv.decision.decision !== 'APPROVE') pl.aiRejected++; return decide(cand, 'ai', gt.reason, 'warn'); }
        pl.aiApproved++;
        if (gt.plan) plan = gt.plan;
        if (rv && rv.ok) { aiScale = rv.decision.sizeFactor || 0; entriesCap = rv.decision.entries || 0; }
        if (entriesCap && same.length >= entriesCap) return decide(cand, 'ai', `AI allows ${entriesCap} entr${entriesCap === 1 ? 'y' : 'ies'} in this market right now; ${same.length} already open.`, 'warn');
        if (gt.plan || aiScale) { ({ sz, rk } = check(plan)); if (!rk.ok) return decide(cand, 'risk', 'Risk engine (AI-adjusted plan/size): ' + rk.reasons.join(' | '), 'warn'); }
        decide(cand, 'ai', gt.reason + (gt.plan ? ' AI adjusted the stop/target; risk engine re-validated.' : '') + (aiScale && aiScale < 1 ? ` AI sized this trade at ${Math.round(aiScale * 100)}% of the planned risk.` : '') + (entriesCap ? ` AI entries allowed here: ${entriesCap}.` : ''));
      } else rk = check(plan).rk;
      // ---- submit ----
      st.seen.add(cand.key); if (st.seen.size > 400) st.seen.delete(st.seen.values().next().value);
      st.recent.push({ t: now(), symbol: cand.symbol, kind: 'entry' }); if (st.recent.length > 200) st.recent.shift();
      const clientId = 'TB' + now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
      log('submit', `Submitting ${cand.side} ${cand.symbol} qty ${sz.qty} (risk $${sz.lossAtStop.toFixed(2)}) via ${ex.label}.`, 'info', cand.symbol);
      let fill;
      try { fill = await executor.open({ symbol: cand.symbol, side: cand.side, qty: sz.qty, price: cand.price, stop: plan.stop, target: plan.target, clientId }); }
      catch (e) {
        if (e.uncertain) {
          let found = null; try { found = executor.lookup ? await executor.lookup(clientId, cand.symbol) : null; } catch (x) { found = undefined; }
          if (found) fill = found; else { st.halted = `Order status unknown for ${cand.symbol} (${e.message}). Check the broker before resuming; the order was NOT repeated.`; log('recon', st.halted, 'bad', cand.symbol); persist(); return; }
        } else { log('rejected', `Order for ${cand.symbol} rejected: ${e.message}`, 'bad', cand.symbol); return decide(cand, 'broker', 'Order rejected: ' + e.message, 'bad'); }
      }
      st.orders++;
      const d = dirOf(cand.side), risk0 = Math.abs(fill.price - plan.stop);
      const pos = { id: clientId, clientId, orderId: fill.id, symbol: cand.symbol, side: cand.side, qty: fill.qty, entry: fill.price, planEntry: plan.entry, stop: plan.stop, stop0: plan.stop, target: plan.target, target0: plan.target, risk0, plannedRisk0: fill.qty * risk0, plannedRisk: fill.qty * risk0,
        fee: fill.fee || 0, ex: fill.extra || null, tp1: prof.longTerm ? cand.price + dirOf(cand.side) * Math.min(risk0 * g('tp1R', 1), Math.abs(plan.target - cand.price) * 0.6) : null, tp1Hit: false, longTerm: !!prof.longTerm,
        openedAt: now(), checkedT: 0, tf: cand.tf, mode: S().mode, strategy: cand.leadStrategy, family: cand.council.leadFamily, regime: cand.regime, atr: cand.atr, status: 'open', mark: fill.price, upnl: 0, trailing: false, beDone: false,
        sizing: { mode: sz.mode, riskCash: sz.riskCash, lossAtStop: sz.lossAtStop, estCost: sz.estCost },
        rationale: { score: cand.score, why: cand.council.members.filter(m => m.verdict === cand.side).map(m => `${m.name}: ${m.why}`).slice(0, 6), conflicts: cand.council.conflicts, aplus: cand.aplus ? cand.aplus.pass : null },
        council: { verdict: cand.council.verdict, net: cand.council.net, families: cand.council.families.map(f => `${f.family}:${f.verdict}`), members: cand.council.members.map(m => `${m.name}:${m.verdict}`) }, ai: aiInfo, riskChecks: rk.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.note}`) };
      pos.upnl = 0; st.positions.push(pos); pl.executed++;
      decide(cand, 'executed', `Opened ${cand.side} ${cand.symbol} at ${fill.price.toPrecision(6)}, stop ${plan.stop.toPrecision(6)}, target ${plan.target.toPrecision(6)}.`, 'good');
      log('filled', `${ex.live ? '' : 'SIMULATED '}${cand.side} ${cand.symbol} filled at ${fill.price.toPrecision(6)} · qty ${fill.qty} · stop ${plan.stop.toPrecision(6)} · target ${plan.target.toPrecision(6)} · ${S().mode.toUpperCase()}.`, 'good', cand.symbol);
      await refreshAccount(); persist();
    }

    async function entries(results) {
      const pl = st.pipeline = { at: now(), scanned: results.length, directional: st.cands.filter(c => c.side !== 'WAIT').length, qualified: 0, riskOk: 0, aiReviewed: 0, aiApproved: 0, aiRejected: 0, executed: 0 };
      const h = haltReason();
      if (h) { if (st.haltLogged !== h) { log('halt', 'New entries blocked: ' + h, 'bad'); st.haltLogged = h; } return; } st.haltLogged = null;
      let opened = 0;
      for (const cand of st.cands) {
        if (cand.side === 'WAIT') break;
        if (opened >= (engine.profile(S(), S().mode).maxNewPerScan || g('maxNewPerScan', 2))) break;
        const before = st.positions.length;
        try { await tryEnter(cand, results, pl); } catch (e) { log('error', `${cand.symbol}: ${e.message}`, 'bad', cand.symbol); }
        if (st.positions.length > before) opened++;
        if (st.halted) break;
      }
    }

    /* ---------- public ---------- */
    async function onScan(results) {
      return lock(async () => {
        st.lastScanAt = now(); st.needRescan = false;
        const usable = results.filter(r => r.candles && r.candles.length >= 60);
        await refreshAccount();
        await adoptExternal();
        evaluateAll(usable);
        await manageAll(usable);
        if (st.enabled) await entries(usable); else st.pipeline = { at: now(), scanned: usable.length, directional: st.cands.filter(c => c.side !== 'WAIT').length, qualified: 0, riskOk: 0, aiReviewed: 0, aiApproved: 0, aiRejected: 0, executed: 0 };
        return st;
      });
    }
    const api = {
      st, onScan, monitor, log, missionStatus, haltReason, refreshAccount, step,
      setEnabled(v) { st.enabled = !!v; if (v) st.haltLogged = null; log(v ? 'start' : 'stop', v ? `Auto trading ENABLED (${S().mode.toUpperCase()}, ${executor.info.label}).` : 'Auto trading disabled. Open positions are still monitored.', v ? 'good' : 'warn'); persist(); },
      emergency(reason) { st.enabled = false; st.halted = 'Emergency stop: ' + (reason || 'user pressed STOP') + '. New entries are blocked; open positions are still monitored.'; log('halt', st.halted, 'bad'); persist(); },
      resume() { if (st.positions.some(p => p.status === 'recon')) return { ok: false, why: 'A position needs reconciliation first.' }; st.halted = null; st.haltLogged = null; log('resume', 'Halt cleared by the user.', 'warn'); persist(); return { ok: true }; },
      async closeAll(reason) { return lock(async () => { for (const p of st.positions.filter(x => x.status === 'open').slice()) { let px = p.mark || p.entry; try { const m = await executor.price([p.symbol]); if (m[p.symbol] > 0) px = m[p.symbol]; } catch (e) { /* use last mark */ } await closePosition(p, { price: px, reason: 'emergency close', kind: 'market' }); } }); },
      async recheck() { if (!executor.reconcile) return { ok: true, issues: [] }; const r = await executor.reconcile(st.positions); if (r.ok) { st.positions.filter(p => p.status === 'recon').forEach(p => { p.status = 'open'; }); log('recon', 'Reconciliation passed; positions resumed.', 'good'); } else log('recon', 'Reconciliation issues: ' + r.issues.join(' '), 'bad'); return r; },
      async closeOne(id) { return lock(async () => { const p = st.positions.find(x => x.id === id && x.status === 'open'); if (!p) return; let px = p.mark || p.entry; try { const m = await executor.price([p.symbol]); if (m[p.symbol] > 0) px = m[p.symbol]; } catch (e) { /* last mark */ } await closePosition(p, { price: px, reason: 'emergency close', kind: 'market' }); }); },
      dropPosition(id) { const p = st.positions.find(x => x.id === id); if (!p) return; st.positions = st.positions.filter(x => x.id !== id); log('recon', `${p.symbol} removed from tracking by the user (it was NOT closed by the app).`, 'warn', p.symbol); persist(); },
      setExecutor(e) { if (st.positions.length) return { ok: false, why: 'Close or reconcile all positions before switching executor.' }; executor = e; st.account = { ...st.account, known: false }; log('executor', `Executor set to ${e.info.label}.`, 'info'); return { ok: true }; },
      get executor() { return executor; },
      snapshot() { return { v: 1, positions: st.positions, journal: st.journal.slice(-500), recent: st.recent.slice(-200), seen: [...st.seen].slice(-300), orders: st.orders, paper: executor.state ? executor.state() : null }; },
      restore(s) { if (!s || s.v !== 1) return; st.positions = (s.positions || []).map(p => ({ ...p, status: p.status === 'closing' ? 'recon' : p.status })); st.journal = s.journal || []; st.recent = s.recent || []; st.seen = new Set(s.seen || []); st.orders = s.orders || 0; if (s.paper && executor.restore) executor.restore(s.paper); if (st.positions.some(p => p.status === 'recon')) st.halted = 'Reconciliation required after restart: a position was mid-close. Check the broker, then press Re-check.'; },
      resetPaper() { if (st.positions.length) return { ok: false, why: 'Close positions first.' }; st.journal = st.journal.filter(t => !t.simulated); st.recent = []; st.seen = new Set(); if (executor.reset) executor.reset(S().start); persist(); return { ok: true }; },
      stats() { return risk.stats(st.journal.filter(t => (executor.info.live ? !t.simulated : t.simulated))); },
    };
    return api;
  }
  return { create };
});
