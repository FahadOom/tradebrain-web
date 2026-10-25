/* TradeBrain · v9 screens: broker-gated lock bars, Overview balances + editable Goal, Signals (Watch / Buy / Sell / A+ / Ready), Tests (1h, 4h, 7-day A+),
   Auto-screen settings for sources, timeframes, AI supervision, MADBOT scout and background running. Everything shown comes from engine / controller / broker state. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (v, sign) => (sign && v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(Number(v) || 0).toFixed(2);
  const sig = s => `<span class="sig ${String(s).toLowerCase()}">${esc(s)}</span>`;
  const fmt = v => (TB.chart ? TB.chart.fmt(v) : String(v));
  let app, S, tab = 'watch', bal = { d: null, b: null, at: 0 }, tests = {}, running = false;
  const TKEY = 'tb_tests_v9';
  try { tests = JSON.parse(localStorage.getItem(TKEY) || '{}'); } catch (e) { tests = {}; }
  const ctl = () => TB.ui2.ctl();

  /* ---------------- lock bars: no broker, no markets ---------------- */
  const LOCKED = ['scan', 'charts', 'council', 'markets', 'signals', 'tests'];
  function lockBars() {
    const src = TB.data.source();
    LOCKED.forEach(v => {
      const sec = $('view-' + v); if (!sec) return; let bar = sec.querySelector(':scope > .lockbar');
      if (!bar) { bar = document.createElement('div'); bar.className = 'card lockbar'; const head = sec.querySelector('.page-head'); head ? head.after(bar) : sec.prepend(bar); }
      bar.className = 'card lockbar ' + (src ? 'on' : 'off');
      bar.innerHTML = src ? `<div class="row between"><span><b>Markets from ${esc(src.label)}</b> <small>${esc(src.reason)}</small></span><span class="tag ok">${esc(src.label)}</span></div>`
        : `<div class="row between"><span><b>No broker connected.</b> <small>Markets, charts and signals appear only after you connect Deriv or Binance.</small></span><button class="btn primary" data-go="connect">Connect a broker</button></div>`;
    });
  }

  /* ---------------- Overview: broker balances + Goal ---------------- */
  async function refreshBalances(force) {
    if (!force && Date.now() - bal.at < 25000) return; bal.at = Date.now();
    const tasks = [];
    if (TB.live.deriv.ready()) tasks.push(TB.live.deriv.refresh().then(a => { bal.d = { ...a, ok: true }; }).catch(e => { bal.d = { ok: false, err: e.message }; }));
    else bal.d = null;
    if (TB.live.binance.ready()) tasks.push(TB.live.binance.balance().then(a => { bal.b = { ...a, ok: true }; }).catch(e => { bal.b = { ok: false, err: e.message }; }));
    else bal.b = null;
    await Promise.all(tasks); seedPaper(); renderBrokers();
  }
  /** Practice money starts at the connected broker's balance (once), unless the user has already set a goal or traded on paper. */
  function seedPaper() {
    const c = ctl(); if (!c || S().paperSeeded || S().goalSet || c.st.positions.length || c.st.journal.length || c.executor.info.name !== 'paper') return;
    const v = bal.d && bal.d.ok && TB.live.deriv.acct() ? +TB.live.deriv.acct().bal : bal.b && bal.b.ok ? bal.b.total : 0; if (!(v > 0)) return;
    S().paperSeeded = true; S().start = S().now = +v.toFixed(2); const r = c.resetPaper(); app.persist(); if (r.ok) c.refreshAccount().then(renderAll);
  }
  function renderBrokers() {
    const el = $('h-brokers'); if (!el || !ctl()) return;
    const c = ctl(), st = c.stats(), ex = c.executor.info.name, paper = TB.ui2.paper(), src = TB.data.source();
    const card = (title, tag, big, lines, active) => `<article class="card broker ${active ? 'active' : ''}"><div class="card-title"><div><div class="eyebrow">${esc(title)}</div><h3>${big}</h3></div>${tag}</div>${lines.map(l => `<p class="muted small">${l}</p>`).join('')}</article>`;
    const cards = [];
    const d = bal.d; if (TB.live.deriv.ready() || d) { const a = TB.live.deriv.acct() || {}; cards.push(card('Deriv ' + (a.id || ''), `<span class="tag ${a.demo === false ? 'bad' : 'ok'}">${a.demo === false ? 'REAL' : 'DEMO'}</span>`, d && d.ok === false ? 'unavailable' : money(a.bal) + ' <small style="display:inline">' + esc(a.cur || 'USD') + '</small>', [d && d.ok === false ? esc(d.err) : 'Broker balance (open contracts excluded)', src && src.id === 'deriv' ? 'Feeding markets and signals' : ''].filter(Boolean), ex === 'deriv')); }
    const b = bal.b; if (TB.live.binance.ready() || b) cards.push(card('Binance · ' + esc(TB.live.binance.envName()), `<span class="tag ${TB.live.binance.isTest() ? 'ok' : 'bad'}">${TB.live.binance.isTest() ? 'DEMO' : 'REAL'}</span>`, b && b.ok ? money(b.total) + ' <small style="display:inline">USDT</small>' : 'unavailable', [b && b.ok ? `Free ${money(b.cash)} · trading ${b.canTrade ? 'allowed' : 'NOT allowed'}` : esc((b && b.err) || 'Tap the Binance chip to refresh'), src && src.id === 'binance' ? 'Feeding markets and signals' : ''].filter(Boolean), ex === 'binance'));
    cards.push(card('Paper account', '<span class="tag">SIMULATION</span>', money(paper.balance), [`Closed paper trades: ${c.st.journal.filter(t => t.simulated).length}`, 'Practice money on live prices. Not a broker balance.'], ex === 'paper'));
    const acc = c.st.account, eq = acc.known ? acc.equity : S().now, gain = eq - S().start, real = st.net;
    cards.push(`<article class="card broker"><div class="card-title"><div><div class="eyebrow">Accumulation · ${esc(c.executor.info.label)}</div><h3 class="${gain >= 0 ? 'up' : 'down'}">${money(gain, true)}</h3></div><span class="tag">${S().start > 0 ? ((gain / S().start) * 100).toFixed(1) + '%' : '—'}</span></div><p class="muted small">Since the starting balance ${money(S().start)} · realised ${money(real, true)} over ${st.n} closed trades</p></article>`);
    el.innerHTML = `<div class="grid2">${cards.join('')}</div>`;
  }
  function renderGoal() {
    const el = $('h-goal'); if (!el) return; if (el.dataset.built) { el.querySelector('#g-note').textContent = goalNote(); return; }
    el.dataset.built = '1';
    el.innerHTML = `<div class="card form"><div class="card-title"><div><div class="eyebrow">Your goal</div><h3>Goal</h3></div><span class="tag" id="g-tag">—</span></div>
      <div class="fields"><label>Starting balance<input id="g-start" type="number" min="0" step="any"></label><label>Target balance (0 = none)<input id="g-goal" type="number" min="0" step="any"></label><label>Deadline (optional)<input id="g-dead" type="datetime-local"></label></div>
      <div class="row"><button id="g-save" class="btn primary">Save goal</button><button id="g-cur" class="btn">Use current balance as start</button><button id="g-clear" class="btn ghost">Clear goal</button></div>
      <p id="g-note" class="muted small"></p>
      <details><summary class="small"><b>Paper account balance</b></summary><div class="fields" style="margin-top:8px"><label>Paper balance<input id="g-paper" type="number" min="1" step="any"></label></div><div class="row"><button id="g-paper-set" class="btn">Set paper balance</button><button id="g-paper-broker" class="btn">Match broker balance</button></div><p class="muted small">Resets the paper account and its simulated trades. Needs no open positions.</p></details></div>`;
    const fill = () => { $('g-start').value = S().start; $('g-goal').value = S().goal || ''; $('g-dead').value = S().deadline || ''; $('g-tag').textContent = S().goal > 0 ? 'SET' : 'NOT SET'; $('g-tag').className = 'tag ' + (S().goal > 0 ? 'ok' : 'warn'); };
    fill();
    $('g-save').onclick = () => {
      const st = +$('g-start').value, go = +$('g-goal').value || 0; if (!(st > 0)) return app.toast('Starting balance must be above 0.'); if (go > 0 && go <= st) return app.toast('Target must be above the starting balance (or 0 for none).');
      Object.assign(S(), { start: st, goal: go, goalSet: go > 0, deadline: $('g-dead').value || '' }); app.persist(); fill(); app.toast(go > 0 ? 'Goal saved.' : 'Goal cleared (no target).'); TB.ui2.ctl().refreshAccount().then(() => renderAll());
    };
    $('g-cur').onclick = async () => { const a = await ctl().refreshAccount(); if (!(a.known && a.equity > 0)) return app.toast('Account balance is not known yet.'); S().start = S().now = +a.equity.toFixed(2); if (S().goal <= S().start) { S().goal = 0; S().goalSet = false; } app.persist(); fill(); await ctl().refreshAccount(); app.toast('Start set to ' + money(S().start)); renderAll(); };
    $('g-clear').onclick = () => { S().goal = 0; S().goalSet = false; S().deadline = ''; app.persist(); fill(); renderAll(); };
    $('g-paper-set').onclick = () => { const v = +$('g-paper').value; if (!(v > 0)) return app.toast('Enter a paper balance above 0.'); if (!confirm('Reset the paper account to ' + money(v) + ' and delete simulated trades?')) return; if (ctl().executor.info.name !== 'paper') return app.toast('Switch Execution to Paper first (Auto tab).'); S().start = S().now = v; const r = ctl().resetPaper(); app.toast(r.ok ? 'Paper account set.' : r.why); fill(); ctl().refreshAccount().then(renderAll); };
    $('g-paper-broker').onclick = () => { const v = bal.d && bal.d.ok !== false && TB.live.deriv.acct() ? +TB.live.deriv.acct().bal : bal.b && bal.b.ok ? bal.b.total : 0; if (!(v > 0)) return app.toast('No broker balance known yet.'); $('g-paper').value = v.toFixed(2); app.toast('Tap "Set paper balance" to apply ' + money(v) + '.'); };
    $('g-paper').value = TB.ui2.paper().balance.toFixed(2); el.querySelector('#g-note').textContent = goalNote();
  }
  function goalNote() {
    const c = ctl(), a = c.st.account, eq = a.known ? a.equity : S().now;
    if (!(S().goal > 0)) return 'No target is set. Loss limits still work from the starting balance ' + money(S().start) + '. Set a target above to track progress.';
    const pct = Math.max(0, Math.min(100, (eq - S().start) / Math.max(0.01, S().goal - S().start) * 100));
    return `${money(eq)} of ${money(S().goal)} (${pct.toFixed(0)}%)${S().deadline ? ' · deadline ' + new Date(S().deadline).toLocaleString() : ''}. A target is a goal, never a promise.`;
  }
  function renderAll() { lockBars(); renderBrokers(); renderGoal(); if (TB.ui2) { /* ui2 renders Home */ } }

  /* ---------------- Signals ---------------- */
  function buildSignals() {
    const sec = document.createElement('section'); sec.id = 'view-signals'; sec.className = 'view';
    sec.innerHTML = `<div class="page-head"><div><div class="eyebrow">From the connected broker</div><h1>Signals</h1><p class="muted">Watch = the main strategy or the Council sees a direction. Ready = the scalp trigger is met (main strategy + enough Council traders). The AI and the risk engine still decide the order.</p></div><button id="sg-scan" class="btn primary">Scan now</button></div>
      <div class="chips2" id="sg-tabs"></div><p id="sg-sub" class="status"></p><div id="sg-list" class="list"></div>`;
    document.querySelector('main').insertBefore(sec, document.querySelector('footer'));
    $('sg-scan').onclick = () => app.runScan();
    $('sg-tabs').onclick = e => { const b = e.target.closest('[data-t]'); if (b) { tab = b.dataset.t; renderSignals(); } };
  }
  function renderSignals() {
    const list = $('sg-list'); if (!list) return; const src = TB.data.source(), c = ctl();
    const cands = c.st.cands, mode = S().mode, ready = x => TB.engine.qualifies(x, S(), mode).ok;
    const sets = {
      watch: cands.filter(x => x.side !== 'WAIT' || (x.main && x.main !== 'WAIT')),
      buy: cands.filter(x => x.side === 'BUY'), sell: cands.filter(x => x.side === 'SELL'),
      aplus: cands.filter(x => x.aplus && x.aplus.pass), ready: cands.filter(x => x.side !== 'WAIT' && ready(x)),
    };
    const names = { watch: 'Watch', ready: 'Ready', buy: 'Buys', sell: 'Sells', aplus: 'A+' };
    $('sg-tabs').innerHTML = Object.keys(names).map(k => `<button class="chip2 ${tab === k ? 'on' : ''}" data-t="${k}" style="${tab === k ? 'outline:2px solid var(--accent,#56d6b0)' : ''}">${names[k]} <b>${sets[k].length}</b></button>`).join('');
    if (!src) { $('sg-sub').textContent = ''; list.innerHTML = '<div class="empty">Connect Deriv or Binance first.</div>'; return; }
    const sc = app.scout(), last = c.st.lastScanAt;
    $('sg-sub').textContent = `${src.label} · ${cands.length} markets read${last ? ' · last scan ' + new Date(last).toLocaleTimeString() : ''} · mode ${mode.toUpperCase()} on ${app.tf()}` + (mode === 'mad' && sc ? ` · scout (${sc.by}) picked ${sc.picks.map(p => p.symbol).join(', ') || 'none'}` : '');
    const rows = sets[tab].slice().sort((a, b) => b.score - a.score);
    if (!rows.length) { list.innerHTML = `<div class="empty">${cands.length ? 'Nothing in this list right now. That is normal; do not force trades.' : 'No scan yet. Tap Scan now.'}</div>`; return; }
    list.innerHTML = rows.map(x => {
      const m = TB.data.known(x.symbol), vt = TB.engine.votersFor(x, x.side), ap = x.aplus, q = x.side !== 'WAIT' ? TB.engine.qualifies(x, S(), mode) : { ok: false, why: 'No direction.' };
      return `<article class="card item"><div class="row between"><div><b>${esc(m ? m.name : x.symbol)}</b> <small style="display:inline">${esc(x.symbol)} · ${esc(x.regime)}</small></div><div>${sig(x.side === 'WAIT' ? (x.main || 'WAIT') : x.side)} <span class="tag">${x.score}/100</span></div></div>
        <p class="muted small">Main strategy ${sig(x.main || 'WAIT')} · Council ${sig(x.council.verdict)} · ${vt.length} trader${vt.length === 1 ? '' : 's'} agree${vt.length ? ' (' + esc(vt.map(v => v.name).join(', ')) + ')' : ''}</p>
        <p class="small"><b>${x.trig && x.trig.ok ? 'READY' : 'Watching'}:</b> ${esc(x.trig ? x.trig.why : '')} ${q.ok ? '<span class="tag ok">qualifies in ' + mode.toUpperCase() + '</span>' : '<span class="muted">· ' + esc(q.why) + '</span>'}</p>
        ${x.plan ? `<p class="small">Plan: entry ${fmt(x.plan.entry)} · stop ${fmt(x.plan.stop)} · target ${fmt(x.plan.target)} (${x.plan.rr.toFixed(2)}R)</p>` : ''}
        ${ap ? `<p class="small">${ap.pass ? '<span class="tag ok">A+</span>' : '<span class="tag">not A+</span> ' + esc(ap.checks.filter(k => !k.ok).map(k => k.name).slice(0, 3).join(', '))}</p>` : ''}
        <div class="row"><button class="btn" data-sg-chart="${esc(x.symbol)}">Chart</button><button class="btn ghost" data-sg-co="${esc(x.symbol)}">Council</button></div></article>`;
    }).join('');
    list.querySelectorAll('[data-sg-chart]').forEach(b => { b.onclick = () => { TB.ui2.openChart(b.dataset.sgChart); }; });
    list.querySelectorAll('[data-sg-co]').forEach(b => { b.onclick = () => { TB.ui2.openCouncil(b.dataset.sgCo); }; });
  }

  /* ---------------- Tests ---------------- */
  const TESTS = [['A7', '7-day A+ test', 'Replays the last 7 days on the A+ timeframe and follows every A+ signal to its stop or target.'], ['S4', '4-hour strategy test', 'Replays the last 4 hours on 5m candles with your strategy rules (main strategy + council traders).'], ['S1', '1-hour strategy test', 'Replays the last hour on 1m candles with the same rules.']];
  function buildTests() {
    const sec = document.createElement('section'); sec.id = 'view-tests'; sec.className = 'view';
    sec.innerHTML = `<div class="page-head"><div><div class="eyebrow">How would the rules have done?</div><h1>Tests</h1><p class="muted">Replays recent candles of the connected broker through the same engine. It shows what the rules would have done, not what they will do. Few signals = no conclusion.</p></div></div>
      <div class="card form"><div class="fields"><label>Markets to test (from your watchlist)<input id="t-n" type="number" min="1" max="12" value="6"></label></div></div>
      <div id="t-cards"></div><div class="card"><div class="card-title"><div><div class="eyebrow">Live scorecard</div><h3>A+ trades taken by the app</h3></div></div><div id="t-live" class="list"></div></div>`;
    document.querySelector('main').insertBefore(sec, document.querySelector('footer'));
    $('t-cards').innerHTML = TESTS.map(([id, t, d]) => `<div class="card" id="tc-${id}"><div class="card-title"><div><div class="eyebrow">${esc(d)}</div><h3>${esc(t)}</h3></div><button class="btn primary" data-run="${id}">Run</button></div><p class="status" id="ts-${id}"></p><div id="tr-${id}"></div></div>`).join('');
    $('t-cards').onclick = e => { const b = e.target.closest('[data-run]'); if (b) runTest(b.dataset.run); };
    TESTS.forEach(([id]) => showTest(id));
  }
  async function runTest(id) {
    if (running) return app.toast('A test is already running.'); if (!TB.data.ready()) return app.toast('Connect a broker first.');
    const n = Math.max(1, Math.min(12, +$('t-n').value || 6)), syms = TB.data.getWatch(S()).slice(0, n); if (!syms.length) return app.toast('Your watchlist is empty (Markets tab).');
    running = true; const st = $('ts-' + id); st.textContent = 'Loading candles and replaying…'; document.querySelectorAll('[data-run]').forEach(b => { b.disabled = true; });
    try {
      const res = await TB.backtest.run({ engine: TB.engine, scanner: TB.scanner, S: { ...app.effOpts(), mode: S().mode }, symbols: syms, yieldFn: () => new Promise(r => setTimeout(r, 0)),
        candles: (sym, tf, count) => TB.data.candles(sym, tf, { count, closedOnly: true, min: 100, ttl: 60e3 }), onProgress: (d, t) => { st.textContent = `Replaying ${d}/${t} markets…`; } }, id);
      res.source = TB.data.source().label; tests[id] = res; try { localStorage.setItem(TKEY, JSON.stringify(tests)); } catch (e) { /* storage full */ }
      showTest(id);
    } catch (e) { st.textContent = 'Test failed: ' + e.message; } finally { running = false; document.querySelectorAll('[data-run]').forEach(b => { b.disabled = false; }); }
  }
  function showTest(id) {
    const r = tests[id], st = $('ts-' + id), box = $('tr-' + id); if (!st) return; if (!r) { st.textContent = 'Not run yet.'; box.innerHTML = ''; return; }
    const t = r.total, pct = v => (v == null ? '—' : Math.round(v * 100) + '%'), R = v => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'R');
    st.textContent = `${r.source || ''} · ${r.tf} candles · ${r.mode.toUpperCase()} rules · ${new Date(r.at).toLocaleString()}` + (r.errors.length ? ` · ${r.errors.length} market(s) skipped` : '');
    const verdict = t.closed < 10 ? 'Too few closed signals to say anything about the rules.' : t.netR > 0 ? 'Positive in this window. One window is not proof; check it over several days.' : 'Not profitable in this window.';
    box.innerHTML = `<div class="stats"><div class="stat"><span>Signals</span><b>${t.signals}</b></div><div class="stat"><span>Win rate</span><b>${pct(t.winRate)}</b></div><div class="stat"><span>Net</span><b class="${t.netR >= 0 ? 'up' : 'down'}">${R(t.netR)}</b></div><div class="stat"><span>Avg / trade</span><b>${R(t.avgR)}</b></div><div class="stat"><span>Still open</span><b>${t.open}</b></div></div>
      <p class="small">${esc(verdict)}</p><div class="table-wrap"><table><thead><tr><th>Market</th><th class="num">Signals</th><th class="num">Win/Loss</th><th class="num">Net</th></tr></thead><tbody>${r.markets.map(m => `<tr><td>${esc(m.symbol)}</td><td class="num">${m.signals}</td><td class="num">${m.wins}/${m.losses}</td><td class="num">${R(m.netR)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No data.</td></tr>'}</tbody></table></div>
      <p class="muted small">Fixed stop and target, round-trip fees and slippage deducted, one trade per market at a time, signals use only candles up to their time. ${r.errors.length ? esc(r.errors[0]) : ''}</p>`;
  }
  function renderLiveScore() {
    const el = $('t-live'); if (!el || !ctl()) return; const ts = ctl().st.journal.filter(t => t.mode === 'aplus');
    const s = TB.risk.stats(ts);
    el.innerHTML = ts.length ? `<div class="stats"><div class="stat"><span>A+ trades</span><b>${s.n}</b></div><div class="stat"><span>Win rate</span><b>${Math.round(s.winRate * 100)}%</b></div><div class="stat"><span>Net</span><b class="${s.net >= 0 ? 'up' : 'down'}">${money(s.net, true)}</b></div><div class="stat"><span>Expectancy</span><b>${s.expectancyR.toFixed(2)}R</b></div></div>` : '<div class="empty">No A+ trades closed yet.</div>';
  }

  /* ---------------- Auto-screen settings (v9) ---------------- */
  function buildAuto() {
    const sec = $('view-auto'); if (!sec || $('v9-card')) return; const anchor = $('au-banner');
    const card = document.createElement('div'); card.className = 'card form'; card.id = 'v9-card';
    const tfs = ['1m', '5m', '15m', '30m', '1h', '4h'].map(t => `<option>${t}</option>`).join('');
    card.innerHTML = `<div class="card-title"><div><div class="eyebrow">How the bot decides</div><h3>Markets, triggers and AI</h3></div><span id="v9-src" class="tag">—</span></div>
      <div class="fields">
        <label>Data source<select id="v9-pref"><option value="auto">Automatic (Deriv wins when both are connected)</option><option value="deriv">Deriv only</option><option value="binance">Binance only</option></select></label>
        <label>Traders that must agree (scalp trigger)<input id="v9-voters" type="number" min="1" max="4"></label>
        <label>A+ timeframe (long-term)<select id="v9-tfa">${tfs}</select></label>
        <label>MADBOT timeframe<select id="v9-tfm">${tfs}</select></label>
        <label>AI watches open trades<select id="v9-watch"><option value="aplus">A+ trades (exit early if the market changes)</option><option value="all">Every trade</option><option value="off">Off (rules only)</option></select></label>
        <label>First target (TP1) in R, A+ only<input id="v9-tp1" type="number" min="0.5" max="5" step="0.1"></label>
      </div>
      <p class="muted small">Normal scalp: the main strategy must see a buy or sell and at least this many Council traders must agree; then the AI must approve. A+ runs the strict checklist, then the AI keeps watching: after TP1 any sign of reversal closes the trade. The AI sizes each trade (it can only reduce your risk) and decides how many entries a market deserves; Position sizing below lets you fix the size yourself.</p>
      <details open><summary><b>MADBOT scout</b> <small>AI picks promising markets from everything the broker offers</small></summary>
        <div class="fields" style="margin-top:8px"><label class="check"><input id="v9-scout" type="checkbox"> Scout the whole broker (not only my watchlist)</label><label class="check"><input id="v9-backup" type="checkbox"> Backup analyst when every AI is down</label>
        <label>Markets to scalp (top N)<input id="v9-top" type="number" min="1" max="15"></label><label>Markets to sweep (max)<input id="v9-sweep" type="number" min="5" max="120"></label><label>Re-scout every (minutes)<input id="v9-every" type="number" min="1" max="60"></label></div>
        <div class="row"><button id="v9-runscout" class="btn">Run scout now</button></div><pre id="v9-scoutout" class="out">No scout run yet.</pre></details>
      <details open><summary><b>Keep running when I leave the app</b></summary>
        <div class="row"><label class="check"><input id="v9-bg" type="checkbox"> Background mode (foreground service on the APK)</label><button id="v9-batt" class="btn">Allow unrestricted battery</button></div><p id="v9-bgnote" class="muted small"></p></details>`;
    anchor.after(card);
    const set = () => { $('v9-pref').value = S().sourcePref; $('v9-voters').value = S().minVoters; $('v9-tfa').value = S().tfA; $('v9-tfm').value = S().tfMad; $('v9-watch').value = S().aiWatch; $('v9-tp1').value = S().tp1R; $('v9-scout').checked = S().madScout; $('v9-backup').checked = S().madBackup; $('v9-top').value = S().madTop; $('v9-sweep').value = S().sweepMax; $('v9-every').value = S().scoutMin; $('v9-bg').checked = TB.bg.isOn(); };
    set();
    const save = () => { Object.assign(S(), { sourcePref: $('v9-pref').value, minVoters: Math.max(1, Math.min(4, +$('v9-voters').value || 2)), tfA: $('v9-tfa').value, tfMad: $('v9-tfm').value, aiWatch: $('v9-watch').value, tp1R: Math.max(0.5, Math.min(5, +$('v9-tp1').value || 1)),
      madScout: $('v9-scout').checked, madBackup: $('v9-backup').checked, madTop: Math.max(1, Math.min(15, +$('v9-top').value || 6)), sweepMax: Math.max(5, Math.min(120, +$('v9-sweep').value || 40)), scoutMin: Math.max(1, Math.min(60, +$('v9-every').value || 5)) }); app.persist(); lockBars(); app.toast('Saved.'); };
    card.querySelectorAll('select,input').forEach(i => { if (i.id !== 'v9-bg') i.addEventListener('change', save); });
    $('v9-runscout').onclick = async () => { await app.runScout(); renderScout(); };
    $('v9-bg').onchange = async e => { if (e.target.checked) { const r = await TB.bg.enable(); if (!r.ok) { e.target.checked = false; return app.toast(r.why); } app.toast(r.apk ? 'Background mode on: a notification keeps the app alive.' : 'Browser: keeps the screen awake while visible. Install the APK for true background running.'); } else await TB.bg.disable(); bgNote(); };
    $('v9-batt').onclick = async () => { await TB.bg.unrestricted(); setTimeout(bgNote, 1500); };
    bgNote(); if (TB.bg.wasOn()) TB.bg.enable().then(bgNote);
  }
  async function bgNote() {
    const el = $('v9-bgnote'); if (!el) return; const un = await TB.bg.battery();
    el.textContent = TB.bg.isApk() ? (TB.bg.isOn() ? 'Running in the background with a notification.' : 'Off.') + (un === false ? ' Battery optimisation is still ON for this app: tap "Allow unrestricted battery" or Android may stop it.' : un ? ' Battery: unrestricted.' : '') : 'You are in a browser: it cannot trade once the phone suspends the tab. The APK can.';
  }
  function renderScout() {
    const el = $('v9-scoutout'); if (!el) return; const sc = app.scout();
    el.textContent = !sc ? 'No scout run yet. It runs automatically in MADBOT mode.' : `${new Date(sc.at).toLocaleTimeString()} · by ${sc.by === 'AI' ? 'AI' : sc.by === 'backup' ? 'BACKUP analyst' : 'rules'} · swept ${sc.swept}, read ${sc.read}\n${sc.picks.map(p => `${p.bias.padEnd(4)} ${p.symbol}  ${p.why}`).join('\n') || 'no picks'}\n${sc.note || ''}`;
    const t = $('v9-src'), src = TB.data.source(); if (t) { t.textContent = src ? src.label : 'No broker'; t.className = 'tag ' + (src ? 'ok' : 'bad'); }
  }

  function refresh() { if (!app) return; lockBars(); renderBrokers(); renderGoal(); renderSignals(); renderLiveScore(); renderScout(); }
  function init() {
    app = TB.app; S = app.S; buildSignals(); buildTests(); buildAuto(); lockBars(); renderSignals(); renderLiveScore();
    window.addEventListener('tb-conn', () => { bal.at = 0; refresh(); refreshBalances(true); });
    setInterval(() => { if (/home/.test((document.querySelector('.view.active') || {}).id || '')) refreshBalances(false); }, 15000);
    setTimeout(() => { refresh(); refreshBalances(true); }, 800);
  }
  function onView(v) { lockBars(); if (v === 'home') { refreshBalances(false); renderBrokers(); renderGoal(); } if (v === 'signals') renderSignals(); if (v === 'tests') renderLiveScore(); if (v === 'auto') { renderScout(); bgNote(); } }
  window.TB = window.TB || {}; TB.ui3 = { init, refresh, onView, home: () => { renderBrokers(); renderGoal(); } };
})();
