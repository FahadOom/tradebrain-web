/* TradeBrain · settings, storage, migration from AI Brain, backup validation. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TB = root.TB || {}; root.TB.store = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEY = 'tradebrain:v1', LEGACY = ['ai-brain-v2', 'ai-brain-ultimate-v1'];

  const DEFAULTS = {
    tf: '15m', watch: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'],
    start: 10, now: 10, goal: 30, deadline: '', action: 'pause',
    riskPct: 1, lossPct: 10, minRR: 1.5, minEffPct: 25, jitterOn: true, volumeOn: true, closedOnly: true,
    interval: 30, floor: 60, mode: 'normal', reentry: 'fresh', councilMin: 2,
    autoScore: 75, autoMax: 3, backendUrl: 'http://127.0.0.1:8001',
  };
  // Never persisted: switching these on must be a deliberate act in every session.
  const SESSION_ONLY = ['autoOn', 'autoLive'];

  const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const oneOf = (v, list, d) => (list.includes(v) ? v : d);

  /** Clamp every field to a sane range; unknown keys are dropped. */
  function clean(x = {}) {
    const d = DEFAULTS;
    const watch = Array.isArray(x.watch) ? x.watch.map(s => String(s).toUpperCase()).filter(s => /^[A-Z0-9]{5,20}$/.test(s)).slice(0, 20) : d.watch;
    const url = String(x.backendUrl || d.backendUrl).trim().replace(/\/$/, '');
    return {
      tf: oneOf(x.tf, ['1m', '5m', '15m', '1h'], d.tf), watch: watch.length ? watch : d.watch,
      start: num(x.start, 0.01, 1e9, d.start), now: num(x.now, 0, 1e9, d.now), goal: num(x.goal, 0.02, 1e9, d.goal),
      deadline: typeof x.deadline === 'string' ? x.deadline : '', action: oneOf(x.action, ['pause', 'notify'], d.action),
      riskPct: num(x.riskPct, 0.1, 5, d.riskPct), lossPct: num(x.lossPct, 1, 50, d.lossPct), minRR: num(x.minRR, 1, 5, d.minRR),
      minEffPct: num(x.minEffPct, 5, 80, d.minEffPct), jitterOn: x.jitterOn !== false, volumeOn: x.volumeOn !== false, closedOnly: x.closedOnly !== false,
      interval: num(x.interval, 15, 300, d.interval), floor: num(x.floor, 40, 95, d.floor), mode: oneOf(x.mode, ['normal', 'aplus', 'mad'], d.mode),
      reentry: oneOf(x.reentry, ['fresh', 'cooldown'], d.reentry), councilMin: Math.round(num(x.councilMin, 1, 4, d.councilMin)),
      autoScore: num(x.autoScore, 40, 100, d.autoScore), autoMax: Math.round(num(x.autoMax, 1, 50, d.autoMax)),
      backendUrl: /^https?:\/\//.test(url) ? url : d.backendUrl,
    };
  }

  const uid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

  function seedStrategies() {
    const t = new Date().toISOString();
    return [
      { id: uid(), name: 'TradeBrain Scalper', source: 'Built-in rules', createdAt: t, notes: [],
        description: 'EMA 9/21 direction, RSI zone and MACD histogram must all agree; volume above 1.05× average confirms. Signals are research candidates, not guarantees.' },
      { id: uid(), name: 'Jitter / noise filter', source: 'Built-in filter', createdAt: t, notes: [],
        description: 'Directional efficiency over 12 candles. Low efficiency means chop; the score is cut to 45% and the signal is blocked.' },
      { id: uid(), name: 'Breakout confirmation', source: 'Research template', createdAt: t, notes: [],
        description: 'Close beyond the prior 20-candle range with volume, then check ATR stop distance and reward:risk before any entry.' },
    ];
  }

  /** Convert old AI Brain data (v2 + ultimate) into the new shape. */
  function migrate(old2, ult) {
    const out = { settings: {}, strategies: [], history: [] };
    if (old2 && typeof old2 === 'object') {
      const s = old2.settings || {};
      Object.assign(out.settings, { start: s.balance, now: s.balance, riskPct: s.riskPercent, lossPct: s.dailyLossPercent, minRR: s.minRR, jitterOn: s.jitterEnabled, volumeOn: s.volumeEnabled });
      out.strategies = (Array.isArray(old2.strategies) ? old2.strategies : []).map(x => ({
        id: x.id || uid(), name: String(x.name || 'Imported'), source: String(x.educator || ''), description: String(x.description || ''), createdAt: x.createdAt || new Date().toISOString(),
        notes: [].concat((x.lessons || []).map(l => ({ id: l.id || uid(), kind: 'lesson', title: String(l.title || ''), body: String(l.content || ''), createdAt: l.createdAt })),
          (x.journal || []).map(j => ({ id: j.id || uid(), kind: 'journal', title: `${j.symbol || ''} ${j.bias || ''}`.trim(), body: String(j.notes || ''), createdAt: j.createdAt }))),
      }));
      out.history = (Array.isArray(old2.signalHistory) ? old2.signalHistory : []).slice(0, 150).map(h => ({ id: h.id || uid(), key: h.key || uid(), symbol: h.symbol, tf: h.timeframe, signal: h.signal, price: h.price, score: h.score, why: h.why, at: h.createdAt }));
    }
    if (ult && typeof ult === 'object') {
      Object.assign(out.settings, { watch: ult.enabledMarkets, interval: ult.scanInterval, floor: ult.scoreFloor, mode: ult.mode === 'madbot' ? 'mad' : ult.mode, reentry: ult.reentry, goal: ult.missionGoal, start: ult.missionStart });
    }
    Object.keys(out.settings).forEach(k => out.settings[k] === undefined && delete out.settings[k]);
    return out;
  }

  function load(storage) {
    let raw = null;
    try { raw = JSON.parse(storage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    if (raw && raw.v === 1) {
      return { settings: clean(raw.settings), strategies: Array.isArray(raw.strategies) && raw.strategies.length ? raw.strategies : seedStrategies(), history: Array.isArray(raw.history) ? raw.history.slice(0, 150) : [] };
    }
    let a = null, b = null;
    try { a = JSON.parse(storage.getItem(LEGACY[0]) || 'null'); b = JSON.parse(storage.getItem(LEGACY[1]) || 'null'); } catch (e) { /* ignore */ }
    const m = migrate(a, b);
    return { settings: clean({ ...DEFAULTS, ...m.settings }), strategies: m.strategies.length ? m.strategies : seedStrategies(), history: m.history };
  }

  function save(storage, state) {
    const settings = { ...state.settings }; SESSION_ONLY.forEach(k => delete settings[k]);
    try { storage.setItem(KEY, JSON.stringify({ v: 1, settings, strategies: state.strategies, history: state.history.slice(0, 150) })); return true; }
    catch (e) { return false; }
  }

  function exportJson(state) {
    return JSON.stringify({ app: 'TradeBrain', version: 1, exportedAt: new Date().toISOString(), settings: state.settings, strategies: state.strategies, history: state.history }, null, 2);
  }

  /** Throws a readable Error when the file is not a usable backup. */
  function parseBackup(text) {
    let d; try { d = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
    if (!d || typeof d !== 'object' || !Array.isArray(d.strategies)) throw new Error('This is not a TradeBrain or AI Brain backup.');
    if (d.app === 'TradeBrain') {
      return { settings: clean(d.settings), strategies: d.strategies.map(s => ({ ...s, id: s.id || uid(), name: String(s.name || 'Imported'), notes: Array.isArray(s.notes) ? s.notes : [] })), history: Array.isArray(d.history) ? d.history.slice(0, 150) : [] };
    }
    const m = migrate({ strategies: d.strategies, signalHistory: d.signalHistory, settings: d.settings }, d.ultimate);
    return { settings: clean({ ...DEFAULTS, ...m.settings }), strategies: m.strategies, history: m.history };
  }

  return { DEFAULTS, clean, migrate, load, save, exportJson, parseBackup, seedStrategies, uid };
});
