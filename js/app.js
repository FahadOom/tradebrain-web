/* TradeBrain · UI controller. Logic lives in indicators/scanner/council/gates; this file only wires screens. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const { scanner, council, store, gates } = TB;

  const state = store.load(localStorage);
  state.settings.autoOn = false; state.settings.autoLive = false;   // never restored across sessions
  const S = () => state.settings;
  const persist = () => { if (!store.save(localStorage, state)) toast('Could not save: browser storage is full or blocked.'); };

  let results = [], selected = null, loop = null, loopBusy = false, scans = 0, labSel = null, discovered = [];

  // ---------- helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v); }
    kids.flat().forEach(c => el.append(c instanceof Node ? c : document.createTextNode(c ?? '')));
    return el;
  }
  const money = v => '$' + (Number(v) || 0).toFixed(2);
  const fmt = v => !Number.isFinite(v) ? '—' : v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v >= 1 ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : v.toLocaleString(undefined, { maximumFractionDigits: 7 });
  const when = v => { try { return new Date(v).toLocaleString(); } catch (e) { return ''; } };
  const sig = s => h('span', { class: 'sig ' + String(s).toLowerCase() }, s);
  const empty = t => h('div', { class: 'empty' }, t);
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }
  const effOpts = () => ({ ...S(), minEff: S().minEffPct / 100 });
  const tfMs = () => scanner.TF_MS[S().tf] || 9e5;
  const review = r => council.review(r, effOpts(), scanner.TF_MS[r.tf] || 9e5);

  // ---------- navigation ----------
  function go(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    window.scrollTo({ top: 0 });
    if (view === 'broker') TB.exec.refresh();
  }

  // ---------- scanner ----------
  function setStatus(msg, kind) { const el = $('scan-status'); el.textContent = msg; el.className = 'status ' + (kind || ''); }
  function setNet(text, cls) { $('net-text').textContent = text; $('net-pill').className = 'pill ' + cls; }

  async function runScan() {
    const btn = $('scan-btn'); btn.disabled = true; btn.textContent = 'Scanning…';
    setStatus('Reading public Binance candles…');
    try {
      const out = await scanner.scanAll(S().watch, S().tf, effOpts(), (d, n) => setStatus(`Scanning ${d}/${n}…`));
      results = out.results;
      renderScan();
      if (results.length) {
        logSignals(); persist();
        setNet('Data live', 'ok');
        setStatus(`Scanned ${results.length} markets on ${S().tf}.` + (out.errors.length ? ` ${out.errors.length} failed: ${out.errors[0]}` : ''), out.errors.length ? 'warn' : 'ok');
      } else {
        setNet('No data', 'bad');
        setStatus('Could not load market data. ' + (out.errors[0] || 'Check your connection.'), 'warn');
      }
      scans++; renderQueue();
      return results;
    } finally { btn.disabled = false; btn.textContent = 'Scan'; }
  }

  function logSignals() {
    for (const r of results) {
      if (r.signal === 'WAIT') continue;
      const key = `${r.symbol}|${r.tf}|${r.signal}|${r.time}`;
      if (!state.history.some(x => x.key === key)) state.history.unshift({ id: store.uid(), key, symbol: r.symbol, tf: r.tf, signal: r.signal, price: r.price, score: r.score, why: r.why, at: new Date().toISOString() });
    }
    state.history = state.history.slice(0, 150); renderHistory();
  }

  function renderScan() {
    const body = $('scan-rows'); body.replaceChildren();
    if (!results.length) body.append(h('tr', {}, h('td', { colspan: 7, class: 'empty' }, 'No market data.')));
    results.forEach(r => {
      const tr = h('tr', { class: selected === r.symbol ? 'sel' : '', onclick: () => { selected = r.symbol; renderScan(); showDetail(r); } },
        h('td', {}, h('b', {}, r.symbol), h('small', {}, r.tf)), h('td', { class: 'num' }, fmt(r.price)),
        h('td', {}, h('span', { class: 'trend ' + r.trend.toLowerCase() }, r.trend)), h('td', { class: 'num' }, r.rsi == null ? '—' : r.rsi.toFixed(1)),
        h('td', {}, r.eff == null ? '—' : h('span', { class: 'trend ' + (r.eff >= S().minEffPct / 100 ? 'bullish' : 'flat') }, `${r.eff >= S().minEffPct / 100 ? 'Pass' : 'Chop'} ${Math.round(r.eff * 100)}%`)),
        h('td', {}, sig(r.signal)), h('td', {}, h('div', { class: 'meter' }, h('span', { style: `width:${r.score}%` })), h('small', {}, r.score + '/100')));
      body.append(tr);
    });
    $('st-checked').textContent = results.length;
    $('st-buy').textContent = results.filter(r => r.signal === 'BUY').length;
    $('st-sell').textContent = results.filter(r => r.signal === 'SELL').length;
    $('st-wait').textContent = results.filter(r => r.signal === 'WAIT').length;
  }

  function showDetail(r) {
    $('detail-title').textContent = r.symbol;
    const p = $('detail-pill'); p.textContent = r.signal; p.className = 'sig ' + r.signal.toLowerCase();
    const kv = (k, v) => h('div', {}, h('small', {}, k), h('b', {}, v));
    const box = $('detail-body'); box.className = 'kv'; box.replaceChildren(
      kv('Price', fmt(r.price)), kv('EMA 9 / 21', `${fmt(r.ema9)} / ${fmt(r.ema21)}`), kv('RSI 14', r.rsi == null ? '—' : r.rsi.toFixed(2)),
      kv('ATR 14', fmt(r.atr)), kv('Stop distance (1.5 ATR)', fmt(r.stopDist)), kv(`Target (${S().minRR}R)`, fmt(r.targetDist)),
      h('div', { class: 'wide' }, h('small', {}, 'Decision'), h('b', {}, r.why), h('p', { class: 'muted small' }, r.reasons.join(' · ')), h('small', {}, 'Candle: ' + when(r.time))));
  }

  // ---------- council ----------
  function runCouncil() {
    const cand = results.find(r => r.symbol === selected) || results.slice().sort((a, b) => (b.signal !== 'WAIT') - (a.signal !== 'WAIT') || b.score - a.score)[0];
    if (!cand) return toast('Run a scan first.');
    const r = review(cand);
    $('co-market').textContent = cand.symbol; $('co-agree').textContent = `${r.agree}/4`;
    $('co-gates').textContent = r.gatesOk ? 'PASS' : 'BLOCK'; $('co-verdict').textContent = r.verdict;
    $('co-verdict').className = r.verdict === 'BUY' ? 'up' : r.verdict === 'SELL' ? 'down' : '';
    const card = (m, voter) => h('article', { class: 'card member' }, h('div', { class: 'card-title' }, h('div', {}, h('h3', {}, m.name), h('small', {}, m.role)), sig(voter ? m.verdict : m.verdict === 'PASS' ? 'BUY' : 'SELL')), h('p', { class: 'muted small' }, m.why));
    const nodes = [...r.voters.map(v => card(v, true)), ...r.gates.map(g => { const c = card(g, false); const s = c.querySelector('.sig'); s.textContent = g.verdict; s.className = 'sig ' + (g.verdict === 'PASS' ? 'buy' : 'sell'); return c; })];
    $('co-members').replaceChildren(...nodes);
    $('grok-out').dataset.symbol = cand.symbol;
    toast(`${cand.symbol}: Council says ${r.verdict}`);
  }

  async function askGrok() {
    const sym = $('grok-out').dataset.symbol || selected, cand = results.find(r => r.symbol === sym);
    if (!cand) return toast('Run the Council review first.');
    $('grok-out').textContent = 'Asking…';
    try {
      if (TB.live.hasAI()) { $('grok-out').textContent = await TB.live.ask(`Signal ${cand.signal} on ${cand.symbol} ${cand.tf}, score ${cand.score}, mode ${S().mode}. Evidence: ${(cand.reasons || []).join('; ')}`); return; }
      const d = await TB.exec.api('/api/grok/coordinate', { method: 'POST', body: JSON.stringify({ symbol: cand.symbol, timeframe: cand.tf, signal: cand.signal, score: cand.score, evidence: cand.reasons, conflicts: [], mode: S().mode }) });
      const a = d.assessment || {}; $('grok-out').textContent = `${a.model || 'model'} · ${a.key_slot || ''}\n\n${a.text || 'No text returned.'}`;
    } catch (e) { $('grok-out').textContent = 'Grok unavailable: ' + e.message; }
  }

  // ---------- auto loop ----------
  function renderQueue() {
    const rows = results.filter(r => r.score >= S().floor && r.signal !== 'WAIT').sort((a, b) => b.score - a.score).slice(0, 10);
    $('lp-cands').textContent = rows.length;
    const q = $('queue'); q.replaceChildren();
    if (!rows.length) return q.append(empty('No candidates meet the score floor. That is normal; do not force trades.'));
    rows.forEach(r => { const c = review(r); q.append(h('div', { class: 'item row between' }, h('div', {}, h('b', {}, `${r.symbol} · ${r.signal}`), h('p', { class: 'muted small' }, `${r.trend} · ${r.tf} · council ${c.verdict} (${c.agree}/4) · ${r.why}`)), h('span', { class: 'tag' }, r.score + '/100'))); });
  }

  function autoLog(line) {
    const el = $('auto-log'), prev = el.textContent === 'Nothing yet.' ? [] : el.textContent.split('\n');
    prev.unshift(new Date().toLocaleTimeString() + '  ' + line); el.textContent = prev.slice(0, 40).join('\n');
  }

  async function tick() {
    if (loopBusy) return; loopBusy = true;
    try {
      await runScan();
      $('lp-count').textContent = scans; $('lp-last').textContent = new Date().toLocaleTimeString();
      const kill = gates.killSwitch(S());
      if (kill) { autoLog('PAUSED ' + kill); stopLoop(); return; }
      await TB.exec.onScan(results);
      try { TB.live.onScan(results); } catch (e) { autoLog('LIVE ' + e.message); }
    } finally { loopBusy = false; }
  }
  function startLoop() {
    if (loop) return;
    S().interval = Math.min(300, Math.max(15, Number($('a-interval').value) || 30)); S().floor = Number($('a-floor').value) || 60;
    S().mode = $('a-mode').value; S().reentry = $('a-reentry').value; S().councilMin = Number($('a-cmin').value) || 2;
    Object.assign(state.settings, store.clean(state.settings), { autoOn: S().autoOn, autoLive: S().autoLive }); persist();
    const kill = gates.killSwitch(S()); if (kill) return toast(kill);
    loop = setInterval(tick, S().interval * 1000); tick();
    $('loop-start').disabled = true; $('loop-stop').disabled = false; $('loop-tag').textContent = 'SCANNING'; $('loop-tag').className = 'tag ok';
    $('loop-msg').textContent = `Scanning every ${S().interval}s in ${S().mode.toUpperCase()} mode. Orders only if Auto trade is on in Broker.`;
  }
  function stopLoop() {
    clearInterval(loop); loop = null;
    $('loop-start').disabled = false; $('loop-stop').disabled = true; $('loop-tag').textContent = 'PAUSED'; $('loop-tag').className = 'tag warn'; $('loop-msg').textContent = 'Paused.';
  }

  // ---------- history ----------
  function renderHistory() {
    const l = $('hist-list'); l.replaceChildren();
    if (!state.history.length) return l.append(empty('No signals recorded yet.'));
    state.history.forEach(s => l.append(h('article', { class: 'card item' }, h('div', { class: 'row between' }, h('div', {}, h('b', {}, `${s.symbol} · ${s.tf}`), h('small', {}, when(s.at))), sig(s.signal)),
      h('div', { class: 'chips' }, h('span', {}, 'Price ', h('b', {}, fmt(s.price))), h('span', {}, 'Score ', h('b', {}, s.score + '/100'))), h('p', { class: 'muted small' }, s.why || ''))));
  }

  // ---------- strategy lab ----------
  const cur = () => state.strategies.find(s => s.id === labSel);
  function renderLab() {
    const list = $('lab-list'); list.replaceChildren();
    state.strategies.forEach(s => list.append(h('button', { class: 'card item pick' + (s.id === labSel ? ' on' : ''), onclick: () => { labSel = s.id; renderLab(); } }, h('b', {}, s.name), h('small', {}, s.source || 'Personal method'), h('p', { class: 'muted small' }, (s.description || '').slice(0, 110)))));
    const d = $('lab-detail'), s = cur(); d.replaceChildren();
    if (!s) return d.append(empty('Select a strategy.'));
    const kind = h('select', {}, h('option', { value: 'lesson' }, 'Lesson'), h('option', { value: 'journal' }, 'Journal'));
    const title = h('input', { placeholder: 'Title or symbol', maxlength: 150 }), body = h('textarea', { rows: 3, placeholder: 'What happened or what you learned' });
    d.append(h('div', { class: 'card-title' }, h('div', {}, h('h3', {}, s.name), h('small', {}, s.source || 'Personal method')), h('button', { class: 'btn danger', onclick: () => { if (confirm('Delete this strategy?')) { state.strategies = state.strategies.filter(x => x.id !== s.id); labSel = state.strategies[0]?.id; persist(); renderLab(); } } }, 'Delete')),
      h('p', { class: 'muted' }, s.description || 'No description.'),
      h('div', { class: 'form' }, h('div', { class: 'fields' }, h('label', {}, 'Type', kind), h('label', {}, 'Title', title)), h('label', {}, 'Notes', body),
        h('button', { class: 'btn primary', onclick: () => { if (!body.value.trim()) return toast('Write a note first.'); s.notes.unshift({ id: store.uid(), kind: kind.value, title: title.value.trim(), body: body.value.trim(), createdAt: new Date().toISOString() }); persist(); renderLab(); toast('Saved'); } }, 'Add note')),
      h('div', { class: 'list' }, s.notes.length ? s.notes.map(n => h('div', { class: 'item' }, h('div', { class: 'row between' }, h('b', {}, n.title || (n.kind === 'journal' ? 'Journal' : 'Lesson')), h('span', { class: 'tag' }, n.kind)), h('p', { class: 'muted small' }, n.body), h('small', {}, when(n.createdAt) + ' '),
        h('button', { class: 'link', onclick: () => { s.notes = s.notes.filter(x => x.id !== n.id); persist(); renderLab(); } }, 'delete'))) : [empty('No notes yet.')]));
  }
  function newStrategy() {
    const dlg = $('dlg'); $('dlg-form').reset(); dlg.showModal();
    dlg.addEventListener('close', function once() {
      dlg.removeEventListener('close', once);
      if (dlg.returnValue !== 'ok' || !$('dlg-name').value.trim()) return;
      const s = { id: store.uid(), name: $('dlg-name').value.trim(), source: $('dlg-src').value.trim(), description: $('dlg-desc').value.trim(), createdAt: new Date().toISOString(), notes: [] };
      state.strategies.unshift(s); labSel = s.id; persist(); renderLab(); toast('Strategy created');
    });
  }

  // ---------- risk / mission ----------
  function fillRisk() {
    const s = S();
    $('r-start').value = s.start; $('r-now').value = s.now; $('r-goal').value = s.goal; $('r-deadline').value = s.deadline; $('r-risk').value = s.riskPct; $('r-loss').value = s.lossPct;
    $('r-rr').value = s.minRR; $('r-eff').value = s.minEffPct; $('r-jit').checked = s.jitterOn; $('r-vol').checked = s.volumeOn; $('r-closed').checked = s.closedOnly; $('r-action').value = s.action;
  }
  function renderMission() {
    const s = S(), span = Math.max(0.01, s.goal - s.start), pct = Math.max(0, Math.min(100, (s.now - s.start) / span * 100));
    $('m-text').textContent = `${money(s.now)} of ${money(s.goal)}`; $('m-bar').style.width = pct + '%';
    const late = s.deadline && new Date(s.deadline) < new Date();
    $('m-note').textContent = `${pct.toFixed(0)}% of the way from ${money(s.start)}. ` + (s.deadline ? (late ? 'Deadline has passed.' : 'Deadline ' + when(s.deadline) + '.') : '') + ` A ${((s.goal / s.start - 1) * 100).toFixed(0)}% gain is a very aggressive goal.`;
    $('k-risk').textContent = money(s.now * s.riskPct / 100); $('k-stop').textContent = money(s.start * s.lossPct / 100); $('k-floor').textContent = money(s.start * (1 - s.lossPct / 100));
    const kill = gates.killSwitch(s); $('k-kill').textContent = kill ? 'TRIPPED' : 'OK'; $('k-kill').className = kill ? 'down' : 'up'; $('m-state').textContent = kill ? 'STOPPED' : 'TRACKING';
  }
  function calcSize() {
    const eq = +$('z-eq').value, rp = +$('z-risk').value, e = +$('z-entry').value, st = +$('z-stop').value, cash = eq * rp / 100, dist = Math.abs(e - st);
    $('z-cash').textContent = money(cash);
    if (!(dist > 0 && e > 0)) { $('z-units').textContent = '—'; $('z-notional').textContent = '—'; $('z-check').textContent = 'Check inputs'; return; }
    const u = cash / dist; $('z-units').textContent = u.toLocaleString(undefined, { maximumFractionDigits: 6 }); $('z-notional').textContent = money(u * e);
    $('z-check').textContent = u * e > eq * 5 ? 'OVER 5× equity' : 'Within 5×'; $('z-check').className = u * e > eq * 5 ? 'down' : 'up';
  }

  // ---------- markets ----------
  function renderMarkets() {
    const q = $('mk-search').value.trim().toUpperCase(), list = $('mk-list'); list.replaceChildren();
    $('mk-count').value = `${S().watch.length} / 20`;
    const rows = (discovered.length ? discovered : S().watch.map(s => ({ symbol: s, base: s.replace('USDT', '') }))).filter(m => m.symbol.includes(q)).slice(0, 200);
    if (!rows.length) return list.append(empty('No matching symbols.'));
    rows.forEach(m => {
      const on = S().watch.includes(m.symbol);
      list.append(h('label', { class: 'item row between' }, h('div', {}, h('b', {}, m.symbol), h('small', {}, m.base + ' / USDT · Spot')), h('input', { type: 'checkbox', checked: on ? 'checked' : false, onchange: e => {
        if (e.target.checked) { if (S().watch.length >= 20) { e.target.checked = false; return toast('Maximum 20 markets.'); } S().watch.push(m.symbol); } else S().watch = S().watch.filter(x => x !== m.symbol);
        persist(); $('mk-count').value = `${S().watch.length} / 20`; } })));
    });
  }
  async function loadMarkets() {
    $('mk-status').textContent = 'Loading Binance Spot…';
    try {
      const res = await fetch('https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      discovered = d.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT').map(s => ({ symbol: s.symbol, base: s.baseAsset })).sort((a, b) => a.symbol.localeCompare(b.symbol));
      $('mk-status').textContent = `${discovered.length} USDT pairs trading. Public data only; no account connected.`; renderMarkets();
    } catch (e) { $('mk-status').textContent = 'Could not load markets: ' + e.message; $('mk-status').className = 'status warn'; }
  }

  // ---------- broker tab ----------
  async function testBackend() {
    S().backendUrl = store.clean({ ...S(), backendUrl: $('be-url').value }).backendUrl; $('be-url').value = S().backendUrl; persist();
    $('be-tag').textContent = 'Checking…';
    try { const d = await TB.exec.api('/api/health'); $('be-tag').textContent = `Online · Grok ${d.grok_primary_configured ? 'set' : 'missing'}${d.grok_secondary_configured ? ' + backup' : ''}`; $('be-tag').className = 'tag ok'; }
    catch (e) { $('be-tag').textContent = 'Offline'; $('be-tag').className = 'tag bad'; toast(e.message); }
  }
  function syncAuto() {
    S().autoOn = $('au-on').checked; S().autoLive = $('au-live').checked;
    S().autoScore = Number($('au-score').value) || 75; S().autoMax = Number($('au-max').value) || 3; persist();
    $('au-tag').textContent = S().autoOn ? 'ON' : 'OFF'; $('au-tag').className = 'tag ' + (S().autoOn ? 'bad' : '');
    if (S().autoOn) toast('Auto trade is ON for this session only.');
  }

  // ---------- backup ----------
  function exportBackup() {
    const a = h('a', { href: URL.createObjectURL(new Blob([store.exportJson(state)], { type: 'application/json' })), download: `tradebrain-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); toast('Backup exported');
  }
  function importBackup(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try { const b = store.parseBackup(rd.result); if (!confirm('Replace settings, strategies and history with this backup?')) return;
        Object.assign(state, b); state.settings.autoOn = false; state.settings.autoLive = false; persist(); boot(); toast('Backup imported'); }
      catch (e) { alert(e.message); }
      $('bk-import').value = '';
    };
    rd.readAsText(file);
  }

  // ---------- boot ----------
  function boot() {
    const s = S();
    $('tf').value = s.tf; $('a-interval').value = s.interval; $('a-floor').value = s.floor; $('a-mode').value = s.mode; $('a-reentry').value = s.reentry; $('a-cmin').value = s.councilMin;
    $('au-score').value = s.autoScore; $('au-max').value = s.autoMax; $('au-on').checked = false; $('au-live').checked = false; $('be-url').value = s.backendUrl;
    labSel = labSel && cur() ? labSel : state.strategies[0]?.id;
    fillRisk(); renderMission(); calcSize(); renderHistory(); renderLab(); renderMarkets(); renderScan(); renderQueue();
  }

  function init() {
    document.querySelectorAll('#tabbar button').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
    $('scan-btn').addEventListener('click', runScan);
    $('tf').addEventListener('change', () => { S().tf = $('tf').value; persist(); if (results.length) runScan(); });
    $('council-run').addEventListener('click', runCouncil); $('grok-btn').addEventListener('click', askGrok);
    $('loop-start').addEventListener('click', startLoop); $('loop-stop').addEventListener('click', stopLoop);
    $('hist-clear').addEventListener('click', () => { if (confirm('Clear signal history?')) { state.history = []; persist(); renderHistory(); } });
    $('lab-new').addEventListener('click', newStrategy);
    $('risk-form').addEventListener('submit', e => {
      e.preventDefault(); const f = { ...S(), start: +$('r-start').value, now: +$('r-now').value, goal: +$('r-goal').value, deadline: $('r-deadline').value, riskPct: +$('r-risk').value, lossPct: +$('r-loss').value, minRR: +$('r-rr').value, minEffPct: +$('r-eff').value, jitterOn: $('r-jit').checked, volumeOn: $('r-vol').checked, closedOnly: $('r-closed').checked, action: $('r-action').value };
      if (f.goal <= f.start) return toast('Target must be above the starting balance.');
      Object.assign(state.settings, store.clean(f)); persist(); fillRisk(); renderMission(); toast('Saved');
    });
    ['z-eq', 'z-risk', 'z-entry', 'z-stop'].forEach(id => $(id).addEventListener('input', calcSize));
    $('mk-load').addEventListener('click', loadMarkets); $('mk-search').addEventListener('input', renderMarkets);
    $('be-test').addEventListener('click', testBackend);
    ['au-on', 'au-live', 'au-score', 'au-max'].forEach(id => $(id).addEventListener('change', syncAuto));
    $('bk-export').addEventListener('click', exportBackup); $('bk-import').addEventListener('change', e => e.target.files[0] && importBackup(e.target.files[0]));
    window.addEventListener('beforeunload', stopLoop);
    window.addEventListener('online', () => setNet('Online', 'idle')); window.addEventListener('offline', () => setNet('Offline', 'bad'));
    let deferred = null; window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('install-btn').hidden = false; });
    $('install-btn').addEventListener('click', async () => { if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; $('install-btn').hidden = true; } });
    TB.exec.init({ S, toast, council: review, autoLog, onOrder: n => { $('lp-orders').textContent = n; } });
    try { TB.live.init({ S, toast, council: review, hist: t => toast(t) }); } catch (e) { console.error('live init', e); }
    boot();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  document.addEventListener('DOMContentLoaded', init);
})();
