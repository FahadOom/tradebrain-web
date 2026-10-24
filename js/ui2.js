/* TradeBrain · v8 screens: Home, Charts, Council (one chart per member), Auto controller, Positions, AI Brain.
   Everything shown comes from the engine / controller state; nothing is invented to look busy. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let app, ctl, brainI, paperEx, binEx, S, lastEval = {}, charts = [], mainChart = null, dlgChart = null, renderT = null, monT = null, sym = { chart: null, council: null };
  const KEY = 'tradebrain:ctrl:v1';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (v, sign) => (sign && v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(Number(v) || 0).toFixed(Math.abs(v) < 1 ? 3 : 2);
  const fmt = v => TB.chart.fmt(v);
  const sig = s => `<span class="sig ${String(s).toLowerCase()}">${esc(s)}</span>`;
  const tfMs = tf => TB.scanner.TF_MS[tf] || 9e5;
  const hhmm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const effS = () => ({ ...S(), minEff: S().minEffPct / 100 });
  const profileOf = () => TB.engine.profile(S(), S().mode);
  const activeView = () => (document.querySelector('.view.active') || {}).id || '';

  /* ---------------- setup ---------------- */
  function init() {
    app = TB.app; S = app.S;
    const prices = async symbols => { const d = await (await fetch('https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(symbols)), { cache: 'no-store' })).json(); const o = {}; d.forEach(x => { o[x.symbol] = +x.price; }); return o; };
    paperEx = TB.executors.paper({ balance: S().start, fees: () => ({ feePct: S().feePct, slipPct: S().slipPct }), prices });
    binEx = TB.executors.binance({ api: TB.live.binance });
    brainI = TB.brain.create({ ask: (p, sy) => TB.live.askJson(p, sy), available: () => TB.live.hasAI(), maxPerMin: 6 });
    ctl = TB.controller.create({ S, executor: paperEx, brain: brainI, tfMs, now: () => Date.now(), persist: savePersist, emit: () => schedule() });
    try { const snap = JSON.parse(localStorage.getItem(KEY) || 'null'); if (snap) ctl.restore(snap); } catch (e) { /* ignore corrupt snapshot */ }
    TB.ctl = ctl; TB.brainI = brainI;
    $('a-exec').value = 'paper'; $('a-ai').value = S().aiPolicy; $('a-size').value = S().sizeMode; $('a-manual').value = S().manualUsd; $('au-trade').checked = false;
    fillProfile();
    bind(); schedule();
    clearInterval(monT); monT = setInterval(() => { if (ctl.st.positions.length) ctl.monitor().then(schedule).catch(() => {}); }, Math.max(3, S().monitorSec) * 1000);
    setInterval(() => { if (/home|positions/.test(activeView())) schedule(); }, 15000);
  }
  function savePersist() { try { localStorage.setItem(KEY, JSON.stringify(ctl.snapshot())); } catch (e) { /* storage full */ } }
  function schedule() { clearTimeout(renderT); renderT = setTimeout(renderAll, 120); }

  function bind() {
    $('a-exec').addEventListener('change', e => {
      const want = e.target.value;
      if (want === 'binance' && !TB.live.binance.ready()) { e.target.value = 'paper'; return app.toast('Connect Binance in the Connect tab first.'); }
      const r = ctl.setExecutor(want === 'binance' ? binEx : paperEx); if (!r.ok) { e.target.value = ctl.executor.info.name; return app.toast(r.why); }
      S().executor = want; $('au-trade').checked = false; ctl.setEnabled(false); app.persist(); schedule();
    });
    ['a-ai', 'a-size', 'a-manual'].forEach(id => $(id).addEventListener('change', () => { S().aiPolicy = $('a-ai').value; S().sizeMode = $('a-size').value; S().manualUsd = Math.max(0, +$('a-manual').value || 0); app.persist(); schedule(); }));
    $('a-mode').addEventListener('change', () => { S().mode = $('a-mode').value; fillProfile(); app.persist(); schedule(); });
    $('p-save').addEventListener('click', saveProfile);
    $('au-trade').addEventListener('change', e => {
      if (e.target.checked) {
        const ex = ctl.executor.info;
        if (ex.live && !TB.live.binance.isTest()) { const t = prompt('LIVE Binance account. Real money. Type LIVE to allow automatic orders for this session only:'); if (t !== 'LIVE') { e.target.checked = false; return app.toast('Not enabled.'); } }
        if (ex.live && !confirm(`Automatic ${S().mode.toUpperCase()} orders on Binance ${TB.live.binance.isTest() ? 'TESTNET' : 'LIVE'}. Exits are watched by this app only (no exchange stop-loss). Keep the app open. Continue?`)) { e.target.checked = false; return; }
        if (!app.isLooping()) app.startLoop();
      }
      ctl.setEnabled(e.target.checked); schedule();
    });
    $('au-stop').addEventListener('click', () => { ctl.emergency(); $('au-trade').checked = false; app.toast('Emergency stop: no new entries.'); schedule(); });
    $('au-close').addEventListener('click', async () => { if (!ctl.st.positions.length) return app.toast('No open positions.'); if (!confirm('Close ALL positions at market?')) return; await ctl.closeAll(); schedule(); });
    $('au-resume').addEventListener('click', () => { const r = ctl.resume(); app.toast(r.ok ? 'Halt cleared.' : r.why); schedule(); });
    $('au-recheck').addEventListener('click', async () => { const r = await ctl.recheck(); app.toast(r.ok ? 'Reconciled.' : r.issues.join(' ').slice(0, 120)); schedule(); });
    $('loop-start').addEventListener('click', schedule); $('loop-stop').addEventListener('click', () => { ctl.setEnabled(false); $('au-trade').checked = false; schedule(); });
    $('j-export').addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), journal: ctl.st.journal }, null, 1)], { type: 'application/json' })); a.download = 'tradebrain-journal.json'; a.click(); });
    $('j-reset').addEventListener('click', () => { if (!confirm('Reset the PAPER account and delete simulated trades?')) return; const r = ctl.resetPaper(); app.toast(r.ok ? 'Paper account reset.' : r.why); schedule(); });
    // charts
    $('ch-sym').addEventListener('change', () => { sym.chart = $('ch-sym').value; loadChart(true); }); $('ch-tf').addEventListener('change', () => { S().tfView = $('ch-tf').value; app.persist(); loadChart(true); }); $('ch-pane').addEventListener('change', () => drawChart());
    $('ch-zin').addEventListener('click', () => mainChart && mainChart.zoom(0.8)); $('ch-zout').addEventListener('click', () => mainChart && mainChart.zoom(1.25)); $('ch-reset').addEventListener('click', () => mainChart && mainChart.reset());
    $('ch-refresh').addEventListener('click', () => loadChart(true));
    // council
    $('co-sym').addEventListener('change', () => { sym.council = $('co-sym').value; renderCouncil(sym.council); });
    $('brain-btn').addEventListener('click', structuredAI);
    $('cd-close').addEventListener('click', () => $('chart-dlg').close());
    $('br-wsave').addEventListener('click', () => { const w = {}; document.querySelectorAll('#br-weights input').forEach(i => { w[i.dataset.id] = Math.max(0, Math.min(3, +i.value)); }); S().weights = w; app.persist(); app.toast('Weights saved'); });
    $('ch-toggles').addEventListener('change', e => { if (e.target.dataset.g && mainChart) { mainChart.toggle(e.target.dataset.g, e.target.checked); const t = S().enabledOv || (S().enabledOv = {}); t[e.target.dataset.g] = e.target.checked; } });
  }

  function fillProfile() {
    const p = profileOf(); $('a-mode').value = S().mode;
    const set = (id, v) => { $(id).value = v; };
    set('p-score', p.minScore); set('p-fam', p.minFamilies); set('p-net', p.minNet); set('p-opp', p.maxOppose); set('p-pos', p.maxPos); set('p-sym', p.maxPerSymbol); set('p-hr', p.maxEntriesHour); set('p-cd', p.cooldownMin); set('p-hold', p.maxHoldMin);
    set('p-fee', S().feePct); set('p-slip', S().slipPct); set('p-ppct', S().maxPosPct); set('p-exp', S().maxExposurePct); set('p-agg', S().maxAggLossPct); set('p-be', S().beAtR); set('p-trail', S().trailAtR); $('p-inv').checked = S().invalidateExit !== false;
  }
  function saveProfile() {
    const n = (id, lo, hi) => Math.min(hi, Math.max(lo, +$(id).value || lo));
    S().profiles = S().profiles || {};
    S().profiles[S().mode] = { minScore: n('p-score', 20, 100), minFamilies: n('p-fam', 1, 5), minNet: n('p-net', 0.05, 1), maxOppose: n('p-opp', 0, 4), maxPos: n('p-pos', 1, 20), maxPerSymbol: n('p-sym', 1, 5), maxEntriesHour: n('p-hr', 1, 60), cooldownMin: n('p-cd', 0, 240), maxHoldMin: n('p-hold', 5, 2880), requireAplus: S().mode === 'aplus' };
    Object.assign(S(), { feePct: n('p-fee', 0, 2), slipPct: n('p-slip', 0, 2), maxPosPct: n('p-ppct', 1, 100), maxExposurePct: n('p-exp', 1, 500), maxAggLossPct: n('p-agg', 0.1, 20), beAtR: n('p-be', 0, 5), trailAtR: n('p-trail', 0.5, 10), invalidateExit: $('p-inv').checked });
    TB.store.clean(S()); app.persist(); app.toast(`Saved for ${S().mode.toUpperCase()} mode. Hard risk limits still apply.`); schedule();
  }

  /* ---------------- data for any market (works without a scan) ---------------- */
  async function evalSymbol(symbol, tf, force) {
    const key = symbol + '|' + tf, hit = lastEval[key];
    if (!force && hit && Date.now() - hit.t < 20000) return hit;
    const scanned = app.results().find(r => r.symbol === symbol && r.tf === tf);
    let candles = scanned && !force ? scanned.candles : await TB.scanner.fetchCandles(symbol, tf, S().closedOnly);
    const a = TB.scanner.analyse(symbol, tf, candles, effS()), r = { ...a, candles };
    const cand = TB.engine.evaluate(r, effS(), { tfMs: tfMs(tf), portfolio: { open: [], maxCorrelated: S().maxCorrelated } });
    return (lastEval[key] = { t: Date.now(), cand, candles, a });
  }
  const symbols = () => { const w = S().watch.slice(); app.results().forEach(r => { if (!w.includes(r.symbol)) w.push(r.symbol); }); return w; };
  function fillSelect(el, key) { const cur = sym[key] || el.value || symbols()[0], list = symbols(); if (el.options.length !== list.length || el.dataset.k !== list.join()) { el.innerHTML = list.map(s => `<option>${esc(s)}</option>`).join(''); el.dataset.k = list.join(); } el.value = list.includes(cur) ? cur : list[0]; sym[key] = el.value; }

  /* ---------------- charts ---------------- */
  const OV_DEFAULT = { trend: true, scalper: true, breakout: true, priceaction: true, retest: true, momentum: false, meanrev: false, jitter: false };
  function overlaysFor(run) {
    const out = [], seen = new Set();
    Object.values(run.strategies).forEach(s => (s.overlays || []).forEach(o => { out.push({ ...o, group: s.id }); }));
    return out;
  }
  async function loadChart(force) {
    fillSelect($('ch-sym'), 'chart'); $('ch-tf').value = S().tfView || '15m';
    const symbol = sym.chart, tf = $('ch-tf').value; if (!symbol) return;
    $('ch-sub').textContent = 'Loading candles…';
    try { const e = await evalSymbol(symbol, tf, force); e.view = true; drawChart(e); } catch (er) { $('ch-sub').textContent = 'Could not load candles: ' + er.message; }
  }
  function drawChart(e) {
    const symbol = sym.chart, tf = $('ch-tf').value; e = e || lastEval[symbol + '|' + tf]; if (!e) return;
    const { cand, candles } = e, run = cand.run;
    if (!mainChart) mainChart = TB.chart.create($('ch-canvas'), { visible: 90 });
    const paneSel = $('ch-pane').value, strats = run.strategies;
    let pane = null;
    if (paneSel === 'auto') pane = (strats.breakout.pane && cand.side !== 'WAIT' && cand.leadStrategy === 'breakout') ? strats.breakout.pane : strats.momentum.pane; else if (paneSel === 'volume') pane = strats.breakout.pane; else if (paneSel === 'rsi') pane = strats.momentum.pane; else if (paneSel === 'macd') pane = strats.scalper.pane;
    const pos = [];
    if (cand.side !== 'WAIT' && cand.plan) pos.push({ side: cand.side, i: candles.length - 1, entry: cand.plan.entry, stop: cand.plan.stop, target: cand.plan.target, label: 'Plan' });
    ctl.st.positions.filter(p => p.symbol === symbol).forEach(p => { const i = Math.max(0, candles.findIndex(c => c.t + tfMs(tf) > p.openedAt)); pos.push({ side: p.side, i: i < 0 ? candles.length - 1 : i, entry: p.entry, stop: p.stop, target: p.target, label: 'OPEN' }); });
    mainChart.set({ candles, overlays: overlaysFor(run), pane, positions: pos, title: `${symbol} · ${tf}`, tfMs: tfMs(tf), reset: !!e.view });
    e.view = false;
    const ids = Object.keys(strats).filter(k => k !== 'regime'), on = Object.assign({}, OV_DEFAULT, S().enabledOv || {});
    $('ch-toggles').innerHTML = ids.map(id => `<label class="chip2"><input type="checkbox" data-g="${id}" ${on[id] ? 'checked' : ''}> ${esc(strats[id].name)} <i class="dot ${strats[id].verdict.toLowerCase()}"></i></label>`).join('');
    ids.forEach(id => mainChart.toggle(id, !!on[id]));
    $('ch-title').textContent = `${symbol} ${fmt(cand.price)}`; const sg = $('ch-sig'); sg.textContent = cand.council.verdict; sg.className = 'sig ' + cand.council.verdict.toLowerCase();
    $('ch-sub').textContent = `${cand.regime} · score ${cand.score}/100 · data ${cand.quality.ok ? 'clean' : 'issues: ' + cand.quality.gaps + ' gaps, ' + cand.quality.dupes + ' dupes' + (cand.quality.stale ? ', stale' : '')} · newest closed candle ${hhmm(candles[candles.length - 1].t)}`;
    $('ch-read').innerHTML = `<p><b>Council:</b> ${esc(cand.council.verdict)} (conviction ${cand.council.net.toFixed(2)}, ${cand.council.agreeFamilies} family vote(s) for, ${cand.council.opposeFamilies} against). ${cand.plan ? `<b>Plan:</b> entry ${fmt(cand.plan.entry)}, stop ${fmt(cand.plan.stop)}, target ${fmt(cand.plan.target)} (${cand.plan.rr.toFixed(2)}R).` : ''}</p>` +
      `<p><b>Regime:</b> ${esc(run.regime.why)}</p>` + ids.map(id => `<p><b>${esc(strats[id].name)}</b> ${sig(strats[id].verdict)} ${esc(strats[id].why)}</p>`).join('') + (cand.council.conflicts.length ? `<p><b>Conflicts:</b> ${esc(cand.council.conflicts.join(' '))}</p>` : '');
  }

  /* ---------------- council ---------------- */
  async function renderCouncil(symbol) {
    fillSelect($('co-sym'), 'council'); if (symbol) { sym.council = symbol; $('co-sym').value = symbol; }
    const tf = S().tf; let e;
    try { e = await evalSymbol(sym.council, tf, false); } catch (er) { $('co-final').innerHTML = `<div class="empty">Could not load ${esc(sym.council)}: ${esc(er.message)}</div>`; return; }
    const { cand, candles } = e, c = cand.council;
    $('co-market').textContent = cand.symbol; $('co-agree').textContent = `${c.agreeFamilies}/${c.families.length}`; $('co-gates').textContent = c.gatesOk ? 'PASS' : 'BLOCK'; $('co-verdict').textContent = c.verdict; $('co-verdict').className = c.verdict === 'BUY' ? 'up' : c.verdict === 'SELL' ? 'down' : '';
    // dry-run of the risk engine so the screen shows its decision too
    let riskTxt = 'No directional plan.';
    if (cand.plan) {
      const acct = ctl.st.account.known ? ctl.st.account : { equity: S().now, cash: S().now, known: true, dayPnl: 0 };
      const sz = TB.risk.size({ mode: S().sizeMode, equity: acct.equity, cash: acct.cash, riskPct: S().riskPct, maxRiskPct: S().maxRiskPct, stopDist: cand.plan.risk, price: cand.price, manualNotional: S().manualUsd, maxPosPct: S().maxPosPct, minNotional: ctl.executor.info.minNotional, feePct: S().feePct, slipPct: S().slipPct });
      const rk = TB.risk.check({ cand: { symbol: cand.symbol, side: cand.side, price: cand.price, plan: cand.plan, key: cand.key, ageMs: cand.ageMs, tfMs: cand.tfMs, regime: cand.regime, quality: cand.quality }, size: sz, account: { equity: acct.equity, start: S().start, cash: acct.cash, dayPnl: acct.dayPnl || 0, known: acct.known }, positions: ctl.st.positions, recent: [], corrOpen: [], S: { ...S(), ...profileOf() }, longOnly: ctl.executor.info.longOnly, seen: new Set() });
      riskTxt = rk.ok ? `Would pass: ${sz.qty} units, $${sz.notional.toFixed(2)}, risk ${money(sz.lossAtStop)} at the stop.` : 'Would be rejected: ' + rk.reasons.join(' | ');
    }
    const ap = cand.aplus; const cached = [...brainI.cache.entries()].find(([k]) => k.startsWith(cand.symbol + '|' + cand.tf + '|' + cand.time));
    $('co-final').innerHTML = `<div class="card-title"><div><div class="eyebrow">Final recommendation</div><h3>${sig(c.verdict)} ${esc(cand.symbol)} <small style="display:inline">· ${esc(cand.regime)} · score ${cand.score}/100</small></h3></div></div>` +
      `<p class="small">${c.families.map(f => `<span class="tag ${f.verdict === 'BUY' ? 'ok' : f.verdict === 'SELL' ? 'bad' : ''}">${esc(f.family)} ${esc(f.verdict)}</span>`).join(' ')}</p>` +
      (c.conflicts.length ? `<p class="small"><b>Conflicts:</b> ${esc(c.conflicts.join(' '))}</p>` : '') + (c.missing.length ? `<p class="small muted"><b>Missing confirmation:</b> ${esc(c.missing.join('; '))}.</p>` : '') +
      `<p class="small"><b>Risk engine (dry run):</b> ${esc(riskTxt)}</p>` + (ap ? `<details><summary class="small"><b>A+ checklist:</b> ${ap.pass ? 'PASS' : 'not met'}</summary><div class="small">${ap.checks.map(k => `<div>${k.ok ? '✓' : '✗'} ${esc(k.name)} <span class="muted">${esc(k.note)}</span></div>`).join('')}</div></details>` : '') +
      `<p class="small"><b>AI Brain:</b> ${cached && cached[1].v.ok ? esc(cached[1].v.decision.decision + ' · confidence ' + cached[1].v.decision.confidence + ' (a judgement, not a probability)') : 'No structured review for this candle yet.'}</p>`;
    charts.forEach(ch => ch.destroy()); charts = [];
    const card = (m, i) => `<article class="card member"><div class="card-title"><div><h3>${esc(m.name)} ${m.original ? '<span class="tag">original</span>' : ''}</h3><small>${esc(m.role)}</small></div>${sig(m.verdict)}</div><canvas class="minichart" data-m="${i}"></canvas><p class="muted small">${esc(m.why)}</p><p class="small muted">family ${esc(m.family)} · weight ${m.weight.toFixed(2)} × regime fit ${m.fit.toFixed(2)} · score ${m.score}</p></article>`;
    $('co-x').innerHTML = c.members.map(card).join('');
    $('co-gx').innerHTML = c.gates.map(g => `<article class="card member"><div class="card-title"><div><h3>${esc(g.name)} gate ${g.original ? '<span class="tag">original</span>' : ''}</h3><small>${esc(g.role)}</small></div>${sig(g.verdict === 'PASS' ? 'BUY' : 'SELL').replace(/>(BUY|SELL)</, '>' + g.verdict + '<')}</div><p class="muted small">${esc(g.why)}</p></article>`).join('');
    document.querySelectorAll('#co-x canvas').forEach(cv => {
      const m = c.members[+cv.dataset.m], ov = m.overlays.map(o => ({ ...o, group: m.id })), pos = m.verdict !== 'WAIT' && m.plan ? [{ side: m.verdict, i: candles.length - 1, entry: m.plan.entry, stop: m.plan.stop, target: m.plan.target }] : [];
      const ch = TB.chart.create(cv, { mini: true, visible: 60 }); ch.set({ candles, overlays: ov, pane: m.pane, positions: pos, title: `${cand.symbol} ${m.verdict}`, tfMs: tfMs(cand.tf) }); charts.push(ch);
      cv.addEventListener('dblclick', () => { }); cv.addEventListener('click', () => openBig(m, cand, candles, ov, pos));
    });
    // classic summary cards keep working through app.js
  }
  function openBig(m, cand, candles, ov, pos) {
    $('cd-title').textContent = `${m.name} · ${cand.symbol}`; $('cd-sub').textContent = m.role; $('cd-why').textContent = m.why; $('chart-dlg').showModal();
    if (dlgChart) dlgChart.destroy(); dlgChart = TB.chart.create($('cd-canvas'), { visible: 90 });
    requestAnimationFrame(() => dlgChart.set({ candles, overlays: ov, pane: m.pane, positions: pos, title: `${cand.symbol} ${cand.tf} · ${m.name} ${m.verdict}`, tfMs: tfMs(cand.tf), reset: true }));
  }
  const aiInput = (cand, plan) => ({ symbol: cand.symbol, tf: cand.tf, time: cand.time, side: cand.side, mode: S().mode, price: cand.price, regime: cand.regime, atr: cand.atr, ema21: cand.ema21, rsi: cand.rsi, eff: cand.eff, vol: cand.vol, plan: plan || cand.plan, score: cand.score, council: cand.council, aplus: cand.aplus, equity: ctl.st.account.equity || S().now, openPositions: ctl.st.positions.length, openSymbols: ctl.st.positions.map(p => p.symbol), dayPnl: ctl.st.account.dayPnl || 0, riskPct: S().riskPct, minRR: S().minRR, longOnly: ctl.executor.info.longOnly, executor: ctl.executor.info.name });
  async function structuredAI() {
    const out = $('brain-out'); const e = lastEval[sym.council + '|' + S().tf]; if (!e) return app.toast('Pick a market first.');
    if (e.cand.side === 'WAIT') { out.textContent = 'The Council sees no direction to review (WAIT).'; return; }
    out.textContent = 'Asking the AI Brain…'; const rv = await brainI.review(aiInput(e.cand));
    out.innerHTML = rv.ok ? `<b>${esc(rv.decision.decision)}</b> · confidence ${rv.decision.confidence} (judgement, not a probability)${rv.cached ? ' · cached' : ''}<br>Support: ${esc(rv.decision.support.join('; '))}<br>Conflicts: ${esc(rv.decision.conflicts.join('; ') || 'none')}<br>Rejects: ${esc(rv.decision.rejects.join('; ') || 'none')}<br>Invalidated if: ${esc(rv.decision.invalidation.join('; '))}` : `Not usable (${esc(rv.status)}): ${esc(rv.errors.join(' '))}`;
    schedule();
  }

  /* ---------------- home / auto / positions / brain ---------------- */
  function perfNums() { const st = ctl.stats(), ps = ctl.st.positions; const expo = ps.reduce((t, p) => t + p.qty * (p.mark || p.entry), 0); return { st, expo, today: ctl.st.journal.filter(t => t.closedAt >= new Date().setHours(0, 0, 0, 0) && t.simulated === !ctl.executor.info.live).reduce((s, t) => s + t.pnl, 0), unreal: ps.reduce((t, p) => t + (p.upnl || 0), 0) }; }
  function renderHome() {
    const a = ctl.st.account, ex = ctl.executor.info, P = perfNums(), eq = a.known ? a.equity : S().now, lim = S().start * S().lossPct / 100, left = Math.max(0, lim + Math.min(0, a.dayPnl || 0));
    const status = ctl.missionStatus(); $('h-mission').textContent = status; $('h-mission').className = 'tag ' + (/Active|Scanning/.test(status) ? 'ok' : /Halt|Disconnected|Deadline/.test(status) ? 'bad' : 'warn');
    $('h-sub').textContent = ctl.st.enabled ? `Auto trading is ON (${S().mode.toUpperCase()}, ${ex.label}). Runs only while this app stays open.` : 'Auto trading is OFF. Scanning and charts work without placing orders.';
    const chip = (cls, b, t) => `<span class="chip ${cls}"><i></i><b>${esc(b)}</b><em>${esc(t)}</em></span>`;
    $('h-chips').innerHTML = chip(app.isLooping() ? 'ok' : 'off', 'Scanner', app.isLooping() ? `every ${S().interval}s` : 'paused') + chip(ctl.st.enabled ? (ex.live ? 'live' : 'ok') : 'off', 'Execution', ctl.st.enabled ? ex.label : 'orders off') + chip(a.known ? (ex.live ? (TB.live.binance.isTest() ? 'ok' : 'live') : 'ok') : 'bad', 'Account', a.known ? (ex.live ? (TB.live.binance.isTest() ? 'Testnet' : 'LIVE') : 'Paper / simulated') : 'unknown') + chip(TB.live.hasAI() ? 'ok' : 'warn', 'AI Brain', TB.live.hasAI() ? S().aiPolicy : 'no key');
    const card = (l, v, c) => `<div class="stat"><span>${l}</span><b class="${c || ''}">${v}</b></div>`;
    $('h-stats').innerHTML = card('Balance', money(ex.live ? a.cash : paperEx.balance)) + card('Equity', money(eq)) + card('Today realised', money(P.today, true), P.today > 0 ? 'up' : P.today < 0 ? 'down' : '') + card('Unrealised', money(P.unreal, true), P.unreal > 0 ? 'up' : P.unreal < 0 ? 'down' : '') +
      card('Open positions', ctl.st.positions.length) + card('Win rate', P.st.n ? Math.round(P.st.winRate * 100) + '%' : '—') + card('Profit factor', P.st.n ? (P.st.pf === Infinity ? '∞' : P.st.pf.toFixed(2)) : '—') + card('Max drawdown', money(P.st.maxDD)) + card('Exposure', money(P.expo)) + card('Daily risk left', money(left));
    const span = Math.max(0.01, S().goal - S().start), pct = Math.max(0, Math.min(100, (eq - S().start) / span * 100));
    $('m2-text').textContent = `${money(eq)} of ${money(S().goal)} target (start ${money(S().start)})`; $('m2-bar').style.width = pct + '%'; $('m2-pct').textContent = pct.toFixed(0) + '%';
    $('m2-note').textContent = `Status: ${status}. ${S().deadline ? 'Deadline ' + new Date(S().deadline).toLocaleString() + '. ' : ''}The target is a goal, never a promise and never a reason to force trades. Realised and unrealised P/L are shown separately above.`;
    $('h-pos').innerHTML = ctl.st.positions.length ? ctl.st.positions.map(posRow).join('') : '<div class="empty">No open positions.</div>';
    $('h-feed').innerHTML = ctl.st.feed.length ? ctl.st.feed.slice(0, 25).map(f => `<div class="item feeditem ${f.level}"><small>${hhmm(f.t)} · ${esc(f.type)}</small><div class="small">${esc(f.text)}</div></div>`).join('') : '<div class="empty">No activity yet. Events appear here only when something really happens.</div>'; $('h-feedn').textContent = ctl.st.feed.length;
  }
  const posRow = p => `<div class="item"><div class="row between"><div><b>${esc(p.symbol)}</b> ${sig(p.side)} <small style="display:inline">${esc(p.mode.toUpperCase())} · ${esc(p.strategy || '')}</small></div><b class="${p.upnl >= 0 ? 'up' : 'down'}">${money(p.upnl, true)}</b></div><div class="chips"><span>Entry <b>${fmt(p.entry)}</b></span><span>Now <b>${fmt(p.mark)}</b></span><span>Stop <b>${fmt(p.stop)}</b>${p.trailing ? ' (trailing)' : p.beDone ? ' (break-even)' : ''}</span><span>Target <b>${fmt(p.target)}</b></span><span>Qty <b>${p.qty}</b></span><span>Status <b>${esc(p.status)}</b></span></div></div>`;

  function renderQueue() {
    const q = $('queue'); if (!q) return; const rows = ctl.st.cands.filter(c => c.side !== 'WAIT' && c.score >= S().floor).slice(0, 10); $('lp-cands').textContent = rows.length;
    q.innerHTML = rows.length ? rows.map(c => { const k = TB.engine.qualifies(c, S(), S().mode); return `<div class="item row between"><div><b>${esc(c.symbol)} · ${sig(c.side)}</b><p class="muted small">${esc(c.regime)} · ${c.council.agreeFamilies} families agree · ${esc(k.ok ? 'qualifies for ' + S().mode.toUpperCase() : k.why)}</p></div><span class="tag ${k.ok ? 'ok' : ''}">${c.score}/100</span></div>`; }).join('') : '<div class="empty">No candidates meet the score floor. That is normal; do not force trades.</div>';
  }
  function renderAuto() {
    const ex = ctl.executor.info, halt = ctl.haltReason(), live = ex.live && !TB.live.binance.isTest();
    $('au-banner').className = 'card warnbox ' + (live ? 'live' : ex.live ? 'test' : 'sim');
    $('au-banner').innerHTML = `<b>${live ? 'LIVE MONEY' : ex.live ? 'Binance TESTNET' : 'PAPER: simulation'}</b> · ${esc(ex.label)}. ${ex.live ? 'Orders are real market orders. This app watches stop-loss and take-profit itself (Binance Spot has no automatic stop here), so it must stay open and online. Spot cannot short.' : 'Orders are simulated with realistic fees and slippage on live public prices. No broker is touched.'}${halt ? `<br><b>Entries blocked:</b> ${esc(halt)}` : ''}`;
    $('loop-tag').textContent = app.isLooping() ? (ctl.st.enabled ? 'TRADING' : 'SCANNING') : 'PAUSED'; $('loop-tag').className = 'tag ' + (app.isLooping() ? (ctl.st.enabled ? 'bad' : 'ok') : 'warn'); $('lp-orders').textContent = ctl.st.orders;
    const p = ctl.st.pipeline || {}; const stage = (l, v) => `<div class="stage"><b>${v == null ? '—' : v}</b><span>${l}</span></div>`;
    $('pipe').innerHTML = p.at ? stage('Markets scanned', p.scanned) + stage('Directional', p.directional) + stage('Qualified', p.qualified) + stage('Risk OK', p.riskOk) + stage('AI reviewed', p.aiReviewed) + stage('AI approved', p.aiApproved) + stage('Executed', p.executed) + `<small class="wide">${hhmm(p.at)}${ctl.st.enabled ? '' : ' · orders are OFF, so stages after Directional stay at 0'}</small>` : '<div class="empty">No scan yet.</div>';
    renderQueue();
    $('decisions').innerHTML = ctl.st.decisions.length ? ctl.st.decisions.slice(0, 30).map(d => `<div class="item feeditem ${d.level}"><small>${hhmm(d.t)} · ${esc(d.symbol)} ${esc(d.side)} · ${esc(d.stage)}</small><div class="small">${esc(d.text)}</div></div>`).join('') : '<div class="empty">No decisions yet.</div>';
    if (app.isLooping()) { $('loop-start').disabled = true; $('loop-stop').disabled = false; }
  }
  function renderPositions() {
    const P = perfNums(), s = P.st; $('pos-sub').textContent = `${ctl.executor.info.label} · ${ctl.st.journal.filter(t => t.simulated === !ctl.executor.info.live).length} closed trades in this account type`;
    const card = (l, v) => `<div class="stat"><span>${l}</span><b>${v}</b></div>`;
    $('pf-stats').innerHTML = card('Trades', s.n) + card('Net P/L', money(s.net, true)) + card('Expectancy', s.n ? s.expectancyR.toFixed(2) + 'R' : '—') + card('Avg win / loss', s.n ? money(s.avgWin) + ' / ' + money(s.avgLoss) : '—') + card('Max losing streak', s.maxConsecLoss) + card('Avg hold', s.n ? Math.round(s.avgHoldMin) + ' min' : '—') + card('Win rate', s.n ? Math.round(s.winRate * 100) + '%' : '—') + card('Profit factor', s.n ? (s.pf === Infinity ? '∞' : s.pf.toFixed(2)) : '—');
    $('pos-list').innerHTML = ctl.st.positions.length ? ctl.st.positions.map(p => posRow(p).replace(/<\/div>$/, `<div class="row"><button class="btn danger" data-close="${esc(p.id)}">Close now</button>${p.status === 'recon' ? `<button class="btn" data-drop="${esc(p.id)}">Stop tracking</button>` : ''}</div></div>`)).join('') : '<div class="empty">No open positions.</div>';
    document.querySelectorAll('[data-close]').forEach(b => { b.onclick = async () => { b.disabled = true; await ctl.closeOne(b.dataset.close); schedule(); }; });
    document.querySelectorAll('[data-drop]').forEach(b => { b.onclick = () => { if (confirm('Stop tracking this position? It will NOT be closed on the broker.')) { ctl.dropPosition(b.dataset.drop); schedule(); } }; });
    const trades = ctl.st.journal.filter(t => t.simulated === !ctl.executor.info.live);
    $('trade-list').innerHTML = trades.length ? trades.slice().reverse().slice(0, 40).map(t => `<details class="item"><summary class="row between"><span><b>${esc(t.symbol)}</b> ${sig(t.side)} <small style="display:inline">${esc(t.exitReason)} · ${new Date(t.closedAt).toLocaleString()}</small></span><b class="${t.pnl >= 0 ? 'up' : 'down'}">${money(t.pnl, true)} ${t.r != null ? '(' + t.r.toFixed(2) + 'R)' : ''}</b></summary><div class="small muted"><p>${t.simulated ? 'SIMULATED' : 'REAL'} · ${esc(t.mode.toUpperCase())} · ${esc(t.strategy || '')} · regime ${esc(t.regime)} · strategy engine v${esc(t.version)}<br>Entry ${fmt(t.entry)} → exit ${fmt(t.exit)} · qty ${t.qty} · gross ${money(t.gross, true)} · costs ${money(t.fees)} · held ${Math.round(t.heldMs / 60000)} min · orders ${esc(t.orderIds.entry)} / ${esc(t.orderIds.exit)}</p><p><b>Why entered:</b> ${esc((t.rationale.why || []).join(' | '))}</p><p><b>Council:</b> ${esc(t.council.verdict)} · ${esc(t.council.families.join(', '))}</p><p><b>AI:</b> ${esc(t.ai ? t.ai.decision + (t.ai.confidence ? ' ' + t.ai.confidence : '') + ' (' + t.ai.policy + ')' : 'not used')}</p><p><b>Risk engine:</b> ${esc((t.riskChecks || []).join(' · '))}</p><p><b>Review:</b> ${esc(t.review.notes.join(' '))}</p></div></details>`).join('') : '<div class="empty">No closed trades yet.</div>';
    drawEquity(trades);
  }
  function drawEquity(trades) {
    const cv = $('eq-canvas'), r = cv.getBoundingClientRect(); if (!r.width) return; const d = Math.min(3, devicePixelRatio || 1); cv.width = r.width * d; cv.height = r.height * d; const c = cv.getContext('2d'); c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, r.width, r.height);
    if (trades.length < 2) { c.fillStyle = '#9aabc2'; c.font = '12px system-ui'; c.fillText('Needs 2+ closed trades', 10, 24); return; }
    let eq = 0; const pts = [0, ...trades.map(t => (eq += t.pnl))], mn = Math.min(...pts), mx = Math.max(...pts) || 1, X = i => 8 + i / (pts.length - 1) * (r.width - 16), Y = v => r.height - 10 - (v - mn) / ((mx - mn) || 1) * (r.height - 20);
    c.strokeStyle = 'rgba(154,171,194,.25)'; c.beginPath(); c.moveTo(0, Y(0)); c.lineTo(r.width, Y(0)); c.stroke(); c.strokeStyle = eq >= 0 ? '#56d6b0' : '#ff7e8c'; c.lineWidth = 2; c.beginPath(); pts.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)))); c.stroke();
  }
  function renderBrain() {
    const b = brainI.stats, ai = TB.live.hasAI(); $('br-tag').textContent = ai ? 'AI connected' : 'No AI key'; $('br-tag').className = 'tag ' + (ai ? 'ok' : 'warn');
    const card = (l, v) => `<div class="stat"><span>${l}</span><b>${v}</b></div>`;
    $('br-stats').innerHTML = card('Requests', b.requests) + card('Valid answers', b.valid) + card('Rejected output', b.invalid) + card('Errors', b.errors) + card('Cached reuse', b.cached) + card('Approve / reject', b.approve + ' / ' + b.reject) + card('Last OK', b.lastOkAt ? hhmm(b.lastOkAt) : '—') + card('Per-minute cap', brainI.calls() + '/6');
    $('br-policy').textContent = { required: 'Required: the AI must approve every entry', advisory: 'Advisory: AI is logged but does not block', off: 'Off: deterministic rules only' }[S().aiPolicy];
    $('br-note').textContent = (ai ? 'AI keys are managed in Connect (two slots with failover). ' : 'No AI key is connected. Under the Required policy no entries are taken until one is. ') + 'The AI never places orders and the risk engine can still reject anything it approves. ' + (b.lastError ? 'Last error: ' + b.lastError : '');
    const rows = [...brainI.cache.entries()].reverse().slice(0, 12).map(([k, v]) => `<div class="item"><div class="row between"><b>${esc(k.split('|')[0])} ${sig(k.split('|')[3])}</b><span class="tag ${v.v.decision.decision === 'APPROVE' ? 'ok' : 'bad'}">${esc(v.v.decision.decision)} · ${v.v.decision.confidence}</span></div><p class="small muted">+ ${esc(v.v.decision.support.join('; '))}<br>− ${esc(v.v.decision.conflicts.join('; ') || 'no conflicts listed')}<br>✗ ${esc(v.v.decision.rejects.join('; ') || '—')}<br>Invalid if: ${esc(v.v.decision.invalidation.join('; '))}</p></div>`);
    $('br-list').innerHTML = rows.length ? rows.join('') : '<div class="empty">No AI decisions yet. They appear when a candidate passes the Council and risk checks.</div>';
    const wrap = $('br-weights'); if (!wrap.children.length) wrap.innerHTML = TB.councilX.ROSTER.map(r => `<label>${esc(r.name)} <small>${esc(r.family)}</small><input type="number" min="0" max="3" step="0.1" data-id="${r.id}" value="${(S().weights || {})[r.id] != null ? S().weights[r.id] : r.w}"></label>`).join('');
  }

  function renderAll() {
    if (!ctl) return;
    const v = activeView();
    if (v === 'view-home') renderHome(); if (v === 'view-auto') renderAuto(); if (v === 'view-positions') renderPositions(); if (v === 'view-brain') renderBrain();
    if (v !== 'view-home') { /* keep clock-free views cheap */ }
    const a = ctl.st.account; if (a.known && a.equity > 0 && Math.abs(a.equity - S().now) > 0.004 && !ctl.executor.info.live) { S().now = +a.equity.toFixed(2); app.persist(); }
  }
  async function onResults(results) {
    await ctl.onScan(results);
    $('lp-count').textContent = (+$('lp-count').textContent || 0) + 0; renderAll();
    if (activeView() === 'view-council') renderCouncil(sym.council);
    if (activeView() === 'view-charts') loadChart(false);
    if (ctl.st.needRescan && app.isLooping()) setTimeout(() => app.runScan().catch(() => {}), 1500);
  }
  function onView(view) {
    if (view === 'charts') loadChart(false); if (view === 'council') renderCouncil(sym.council); renderAll(); if (view === 'home') renderHome();
  }

  window.TB = window.TB || {};
  TB.ui2 = { init, onResults, onView, renderCouncil, renderQueue };
})();
