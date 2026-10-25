/* TradeBrain · AI Brain. Grok / Gemini / Groq coordinate; they never place orders and never override the risk engine.
   - builds ONE structured evidence packet per candidate (same shape every time)
   - demands a JSON answer and validates it against a schema; malformed, incomplete or contradictory answers are rejected
   - caches per candle, de-duplicates in-flight calls, rate-limits requests
   - policy: required (AI must approve; AI down = no entry) | advisory (logged, does not block) | off (deterministic only) */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else { root.TB = root.TB || {}; root.TB.brain = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SYSTEM = 'You are the coordinating analyst of a trading app. You receive structured evidence computed by deterministic strategies and a Traders Council. ' +
    'You do NOT place orders. A separate risk engine can still reject anything you approve. Judge only from the evidence given; if it is insufficient say so. ' +
    'Confidence is a qualitative 0-100 judgement, not a probability of winning. Reply with ONE JSON object and nothing else (no markdown fences).';

  const SCHEMA_DOC = '{"instrument":"<same symbol>","direction":"BUY|SELL|WAIT","decision":"APPROVE|REJECT|WAIT","strategy":"<lead strategy>","market_regime":"<string>",' +
    '"proposed_entry":number,"proposed_stop_loss":number,"proposed_take_profit":number,"reward_to_risk":number,"supporting_evidence":["..."],"conflicting_evidence":["..."],' +
    '"council_result":"BUY|SELL|WAIT","confidence":0-100,"reasons_to_reject":["..."],"invalidation":["conditions that void the setup"],"size_comment":"optional string","size_factor":0.25-1,"max_entries":1-3}';

  /** The packet is built the same way for every candidate. Numbers are rounded so identical evidence hashes identically. */
  function packet(c) {
    const r = v => (v == null || !Number.isFinite(v) ? null : +Number(v).toPrecision(7));
    return {
      instrument: c.symbol, timeframe: c.tf, candle_close_time: new Date(c.time).toISOString(), proposed_direction: c.side, mode: c.mode, price: r(c.price),
      regime: c.regime, atr: r(c.atr), ema21: r(c.ema21), rsi: r(c.rsi), efficiency: r(c.eff), volume_ratio: r(c.vol),
      deterministic_plan: c.plan ? { entry: r(c.plan.entry), stop: r(c.plan.stop), target: r(c.plan.target), reward_to_risk: r(c.plan.rr) } : null,
      score: c.score, council: { verdict: c.council.verdict, net: r(c.council.net), agreeing_families: c.council.agreeFamilies, opposing_families: c.council.opposeFamilies,
        members: (c.council.members || []).map(m => ({ name: m.name, family: m.family, verdict: m.verdict, weight: r(m.effWeight), why: String(m.why).slice(0, 160) })),
        gates: (c.council.gates || []).map(g => ({ name: g.name, verdict: g.verdict, why: String(g.why).slice(0, 140) })), conflicts: c.council.conflicts },
      a_plus: c.aplus ? { pass: c.aplus.pass, failed: c.aplus.checks.filter(k => !k.ok).map(k => k.name) } : null,
      account: { equity: r(c.equity), open_positions: c.openPositions, open_symbols: c.openSymbols, daily_pnl: r(c.dayPnl), risk_per_trade_pct: c.riskPct, min_reward_to_risk: c.minRR },
      broker_constraints: { long_only: !!c.longOnly, executor: c.executor },
    };
  }
  const prompt = c => `Evidence packet:\n${JSON.stringify(packet(c))}\n\nReturn exactly this JSON shape:\n${SCHEMA_DOC}\n` +
    'Rules: APPROVE only if the evidence supports the proposed direction and the plan is sound; otherwise REJECT with reasons. You may propose a different stop/target only if it keeps reward_to_risk >= the minimum. ' +
    'size_factor scales the position by the nature of the market (1 = full planned size for a clean, orderly setup; 0.25-0.6 for choppy, fast or uncertain markets); you can only reduce size, never increase it. ' +
    'max_entries is how many separate entries this market deserves right now (1 for a single shot, up to 3 for a clean trend where adding on strength is sensible).';

  /** Pull the first JSON object out of a model reply (handles ```json fences and chatter). */
  function extractJson(text) {
    if (!text) return null; let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{'); if (a < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = a; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { try { return JSON.parse(t.slice(a, i + 1)); } catch (e) { return null; } }
    }
    return null;
  }

  /** Strict validation. Returns { ok, errors[], decision } where decision is normalised. */
  function validate(obj, c) {
    const errors = [], dir = ['BUY', 'SELL', 'WAIT'], dec = ['APPROVE', 'REJECT', 'WAIT'];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['Reply is not a JSON object.'] };
    const num = k => (typeof obj[k] === 'number' && Number.isFinite(obj[k]) ? obj[k] : null), strArr = k => Array.isArray(obj[k]) && obj[k].every(x => typeof x === 'string');
    if (String(obj.instrument || '').toUpperCase() !== c.symbol) errors.push(`instrument is "${obj.instrument}", expected ${c.symbol}.`);
    if (!dir.includes(obj.direction)) errors.push('direction must be BUY, SELL or WAIT.');
    if (!dec.includes(obj.decision)) errors.push('decision must be APPROVE, REJECT or WAIT.');
    if (!(num('confidence') != null && obj.confidence >= 0 && obj.confidence <= 100)) errors.push('confidence must be a number from 0 to 100.');
    ['supporting_evidence', 'conflicting_evidence', 'reasons_to_reject', 'invalidation'].forEach(k => { if (!strArr(k)) errors.push(`${k} must be an array of strings.`); });
    if (typeof obj.strategy !== 'string' || !obj.strategy) errors.push('strategy is missing.');
    if (obj.decision === 'APPROVE') {
      if (obj.direction !== c.side) errors.push(`APPROVE with direction ${obj.direction} contradicts the proposed ${c.side}.`);
      if (obj.council_result && obj.council_result !== c.council.verdict && obj.council_result !== c.council.side) errors.push(`council_result ${obj.council_result} does not match the Council (${c.council.verdict}).`);
      if (strArr('invalidation') && !obj.invalidation.length) errors.push('APPROVE needs at least one invalidation condition.');
      if (strArr('supporting_evidence') && !obj.supporting_evidence.length) errors.push('APPROVE needs supporting evidence.');
    }
    if (obj.decision === 'REJECT' && strArr('reasons_to_reject') && !obj.reasons_to_reject.length) errors.push('REJECT needs reasons_to_reject.');
    let adj = null;
    const e = num('proposed_entry'), sl = num('proposed_stop_loss'), tp = num('proposed_take_profit');
    if (obj.decision === 'APPROVE' && e != null && sl != null && tp != null) {
      const okSide = c.side === 'BUY' ? sl < e && tp > e : sl > e && tp < e, rr = Math.abs(tp - e) / (Math.abs(e - sl) || 1e-12);
      const dev = Math.abs(e - c.price) / c.price;
      if (!okSide) errors.push('proposed stop/target are on the wrong sides of the entry.');
      else if (dev > 0.01) errors.push(`proposed entry ${e} is more than 1% from the current price.`);
      else if (c.plan && rr < (c.minRR || 1.5) - 1e-9) errors.push(`proposed reward:risk ${rr.toFixed(2)} is below the ${c.minRR || 1.5} minimum.`);
      else if (c.atr && (Math.abs(e - sl) < c.atr * 0.5 || Math.abs(e - sl) > c.atr * 4)) errors.push('proposed stop is outside 0.5-4 ATR; not accepted.');
      else adj = { entry: c.price, stop: sl, target: tp, rr, risk: Math.abs(c.price - sl) };
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, errors: [], decision: { decision: obj.decision, direction: obj.direction, confidence: Math.round(obj.confidence), strategy: obj.strategy, regime: obj.market_regime || c.regime,
      support: obj.supporting_evidence, conflicts: obj.conflicting_evidence, rejects: obj.reasons_to_reject, invalidation: obj.invalidation, plan: adj, sizeComment: obj.size_comment || '',
      sizeFactor: num('size_factor') != null ? Math.min(1, Math.max(0.25, obj.size_factor)) : null, entries: num('max_entries') != null ? Math.min(3, Math.max(1, Math.round(obj.max_entries))) : null } };
  }

  /* ---------- supervision of an OPEN position (A+ trades are long-term; the AI keeps watching) ---------- */
  const SUP_SYSTEM = 'You supervise an open trade for a trading app. You see the position and fresh, deterministic market evidence. You do NOT place orders; the app executes your advice only as an exit or a tighter stop. ' +
    'Exit early only when the evidence shows the market is changing against the trade (trend/momentum fading, structure broken, regime turning abnormal). Do not exit on noise. Reply with ONE JSON object only (no markdown).';
  const SUP_SCHEMA = '{"instrument":"<same symbol>","action":"HOLD|TIGHTEN|EXIT","confidence":0-100,"reasons":["..."],"market_changing":true|false}';
  function supPacket(x) {
    const r = v => (v == null || !Number.isFinite(v) ? null : +Number(v).toPrecision(7)), c = x.cand;
    return { instrument: x.pos.symbol, side: x.pos.side, entry: r(x.pos.entry), price: r(x.price), stop: r(x.pos.stop), tp1: r(x.pos.tp1), tp2: r(x.pos.target), tp1_reached: !!x.pos.tp1Hit, progress_r: r(x.progressR), minutes_open: Math.round(x.minutes),
      now: c ? { council_side: c.side, council_net: r(c.council.net), agreeing_families: c.council.agreeFamilies, opposing_families: c.council.opposeFamilies, regime: c.regime, rsi: r(c.rsi), efficiency: r(c.eff), atr: r(c.atr), main_strategy: c.main,
        members: (c.council.members || []).map(m => ({ name: m.name, verdict: m.verdict })) } : null, weakening_signs: x.signs || [] };
  }
  function validateSup(o, pos) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, errors: ['Reply is not a JSON object.'] };
    const errors = [];
    if (String(o.instrument || '').toUpperCase() !== String(pos.symbol).toUpperCase()) errors.push(`instrument is "${o.instrument}", expected ${pos.symbol}.`);
    if (!['HOLD', 'TIGHTEN', 'EXIT'].includes(o.action)) errors.push('action must be HOLD, TIGHTEN or EXIT.');
    if (!(typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 100)) errors.push('confidence must be 0-100.');
    if (!Array.isArray(o.reasons) || !o.reasons.every(x => typeof x === 'string')) errors.push('reasons must be an array of strings.');
    else if (o.action === 'EXIT' && !o.reasons.length) errors.push('EXIT needs at least one reason.');
    return errors.length ? { ok: false, errors } : { ok: true, errors: [], action: o.action, confidence: Math.round(o.confidence), reasons: o.reasons, changing: !!o.market_changing };
  }

  /* ---------- MADBOT scout: pick promising markets for aggressive scalping out of a broker-wide sweep ---------- */
  const SCOUT_SYSTEM = 'You are the market scout of a scalping app. You receive a compact table of markets from ONE broker, computed from recent candles. Pick the markets that look most promising for short-term scalping right now ' +
    '(clear direction or clean momentum, enough range to cover costs, not choppy). You do NOT place orders. Reply with ONE JSON object only (no markdown).';
  const SCOUT_SCHEMA = '{"picks":[{"symbol":"<exactly as listed>","bias":"BUY|SELL|WAIT","why":"short reason"}],"note":"one sentence"}';
  function validateScout(o, symbols, top) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.picks)) return { ok: false, errors: ['Reply has no picks array.'] };
    const set = new Set(symbols), seen = new Set(), picks = [];
    o.picks.forEach(p => { if (p && set.has(p.symbol) && !seen.has(p.symbol)) { seen.add(p.symbol); picks.push({ symbol: p.symbol, bias: ['BUY', 'SELL', 'WAIT'].includes(p.bias) ? p.bias : 'WAIT', why: String(p.why || '').slice(0, 160) }); } });
    return picks.length ? { ok: true, errors: [], picks: picks.slice(0, top), note: String(o.note || '').slice(0, 200) } : { ok: false, errors: ['None of the picked symbols are in the list.'] };
  }

  /** Create a brain bound to an `ask(prompt, system) -> Promise<text>` function. */
  function create(cfg) {
    const cache = new Map(), inflight = new Map(), calls = [], stats = { requests: 0, cached: 0, valid: 0, invalid: 0, errors: 0, approve: 0, reject: 0, wait: 0, lastOkAt: null, lastError: '' };
    const now = () => (cfg.now ? cfg.now() : Date.now());
    const cacheKey = c => `${c.symbol}|${c.tf}|${c.time}|${c.side}|${c.mode}`;

    async function review(c) {
      const k = cacheKey(c), hit = cache.get(k);
      if (hit && now() - hit.t < (cfg.ttlMs || 20 * 60e3)) { stats.cached++; return { ...hit.v, cached: true }; }
      if (inflight.has(k)) return inflight.get(k);
      const perMin = cfg.maxPerMin || 6; while (calls.length && now() - calls[0] > 60e3) calls.shift();
      if (calls.length >= perMin) return { status: 'limited', ok: false, errors: [`Rate limit: ${perMin} AI requests per minute.`] };
      if (!cfg.available()) return { status: 'unavailable', ok: false, errors: ['No AI key is connected.'] };
      calls.push(now()); stats.requests++;
      const p = (async () => {
        let text, lastErr = [];
        for (let attempt = 0; attempt < 2; attempt++) {                       // one controlled retry, only for unusable replies
          try { text = await cfg.ask(prompt(c) + (attempt ? '\nYour previous reply was not valid: ' + lastErr.join(' ') + ' Reply with the JSON object only.' : ''), SYSTEM); }
          catch (e) { stats.errors++; stats.lastError = e.message; return { status: 'unavailable', ok: false, errors: ['AI request failed: ' + e.message] }; }
          const v = validate(extractJson(text), c);
          if (v.ok) { stats.valid++; stats.lastOkAt = now(); stats[v.decision.decision.toLowerCase()]++; const out = { status: 'ok', ok: true, ...v }; cache.set(k, { t: now(), v: out }); if (cache.size > 300) cache.delete(cache.keys().next().value); return out; }
          lastErr = v.errors; stats.invalid++;
        }
        return { status: 'invalid', ok: false, errors: lastErr, raw: String(text || '').slice(0, 400) };
      })().finally(() => inflight.delete(k));
      inflight.set(k, p); return p;
    }

    const gateCall = () => { while (calls.length && now() - calls[0] > 60e3) calls.shift(); if (calls.length >= (cfg.maxPerMin || 6)) return 'Rate limit: ' + (cfg.maxPerMin || 6) + ' AI requests per minute.'; if (!cfg.available()) return 'No AI key is connected.'; calls.push(now()); stats.requests++; return null; };
    const sup = new Map();
    /** Ask the AI whether an open position should be held, tightened or closed. One answer per position per candle. */
    async function supervise(x) {
      const k = `${x.pos.id}|${x.cand ? x.cand.time : 0}`, hit = sup.get(k); if (hit) return { ...hit, cached: true };
      const lim = gateCall(); if (lim) return { ok: false, status: 'unavailable', errors: [lim] };
      let text, last = [];
      for (let a = 0; a < 2; a++) {
        try { text = await cfg.ask(`Open position and fresh evidence:\n${JSON.stringify(supPacket(x))}\n\nReturn exactly this JSON shape:\n${SUP_SCHEMA}\n` + (a ? 'Your previous reply was not valid: ' + last.join(' ') + ' Reply with the JSON object only.' : ''), SUP_SYSTEM); }
        catch (e) { stats.errors++; stats.lastError = e.message; return { ok: false, status: 'unavailable', errors: ['AI request failed: ' + e.message] }; }
        const v = validateSup(extractJson(text), x.pos); if (v.ok) { stats.lastOkAt = now(); const out = { status: 'ok', ...v }; sup.set(k, out); if (sup.size > 300) sup.delete(sup.keys().next().value); return out; }
        last = v.errors; stats.invalid++;
      }
      return { ok: false, status: 'invalid', errors: last };
    }
    /** table: [{symbol, group, price, signal, score, trend, rsi, eff, atrPct, ...}] */
    async function scout(table, top) {
      const lim = gateCall(); if (lim) return { ok: false, status: 'unavailable', errors: [lim] };
      const symbols = table.map(t => t.symbol); let text, last = [];
      for (let a = 0; a < 2; a++) {
        try { text = await cfg.ask(`Markets (one per row):\n${JSON.stringify(table)}\n\nPick the best ${top} for scalping now. Return exactly this JSON shape:\n${SCOUT_SCHEMA}\n` + (a ? 'Your previous reply was not valid: ' + last.join(' ') : ''), SCOUT_SYSTEM); }
        catch (e) { stats.errors++; stats.lastError = e.message; return { ok: false, status: 'unavailable', errors: ['AI request failed: ' + e.message] }; }
        const v = validateScout(extractJson(text), symbols, top); if (v.ok) { stats.lastOkAt = now(); return { status: 'ok', ...v }; }
        last = v.errors; stats.invalid++;
      }
      return { ok: false, status: 'invalid', errors: last };
    }

    /** Apply the execution policy to a review. Returns { allow, reason, plan }. */
    function gate(rv, policy) {
      if (policy === 'off') return { allow: true, reason: 'AI policy is Off: deterministic rules only.', plan: null };
      if (!rv || !rv.ok) {
        const why = rv ? rv.errors.join(' ') : 'No review.';
        return policy === 'advisory' ? { allow: true, reason: 'AI unavailable/invalid (advisory only): ' + why, plan: null } : { allow: false, reason: 'AI Brain did not return a valid decision: ' + why, plan: null };
      }
      const d = rv.decision;
      if (d.decision === 'APPROVE') return { allow: true, reason: `AI approved (confidence ${d.confidence}, a judgement not a probability).`, plan: d.plan };
      return policy === 'advisory' ? { allow: true, reason: `AI said ${d.decision} (advisory only): ${(d.rejects || []).join('; ')}`, plan: null } : { allow: false, reason: `AI ${d.decision}: ${(d.rejects || []).join('; ') || 'no reason given'}`, plan: null };
    }
    return { review, gate, supervise, scout, stats, cache, calls: () => calls.length };
  }

  return { create, packet, prompt, validate, validateSup, validateScout, extractJson, SYSTEM, SCHEMA_DOC };
});
