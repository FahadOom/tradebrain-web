/* TradeBrain · canvas chart. Candles + overlays (series, bands, h-lines, zones, trendlines, markers, long/short position boxes) + one sub-pane.
   Pure canvas, no libraries, works offline inside the APK. Drag to pan, pinch / wheel to zoom, touch or hover for the crosshair. */
(function (root) {
  'use strict';
  const UP = '#56d6b0', DN = '#ff7e8c', TXT = '#9aabc2', GRID = 'rgba(154,171,194,.10)';
  const fmt = v => !Number.isFinite(v) ? '—' : Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Math.abs(v) >= 1 ? v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : v.toPrecision(5);

  function create(canvas, o = {}) {
    const mini = !!o.mini, ctx = canvas.getContext('2d'), PAD = mini ? 3 : 6, AXW = mini ? 46 : 58, AXH = mini ? 14 : 20;
    const st = { candles: [], ov: [], pane: null, pos: [], vis: o.visible || (mini ? 60 : 90), off: 0, cross: null, w: 0, h: 0, dpr: 1, title: '', tfMs: 9e5, hidden: new Set() };
    canvas.style.touchAction = 'pan-y'; canvas.style.cursor = 'crosshair';

    function size() {
      const r = canvas.getBoundingClientRect(), dpr = Math.min(3, root.devicePixelRatio || 1);
      if (!r.width) return false;
      st.w = r.width; st.h = r.height; st.dpr = dpr;
      const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      return true;
    }

    function draw() {
      if (!size()) return;
      const { w, h, dpr, candles } = st, n = candles.length;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      if (n < 3) { ctx.fillStyle = TXT; ctx.font = '12px system-ui'; ctx.fillText('No candles yet', 12, 22); return; }
      const paneOn = !!st.pane, paneH = paneOn ? Math.round((h - AXH) * (mini ? 0.24 : 0.22)) : 0;
      const L = 0, T = mini ? 16 : 22, Wp = w - AXW, mainB = h - AXH - paneH - (paneOn ? 4 : 0), Hm = mainB - T;
      const vis = Math.max(12, Math.min(st.vis, n + PAD)), slot = Wp / vis, start = n - (vis - PAD) - st.off, end = start + vis - 1;
      st.geo = { L, Wp, slot, start, T, mainB };
      const xOf = i => L + (i - start + 0.5) * slot, i0 = Math.max(0, Math.floor(start)), i1 = Math.min(n - 1, Math.ceil(end));
      // ---- price range ----
      let lo = Infinity, hi = -Infinity;
      for (let i = i0; i <= i1; i++) { const c = candles[i]; if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
      st.ov.forEach(o2 => { if (st.hidden.has(o2.group)) return; if (o2.type === 'series') for (let i = i0; i <= i1; i++) { const v = o2.values[i]; if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } } });
      const span0 = hi - lo || 1, near = y => y > lo - span0 * 0.5 && y < hi + span0 * 0.5;
      st.pos.forEach(p => [p.entry, p.stop, p.target].forEach(y => { if (y != null) { if (y < lo) lo = y; if (y > hi) hi = y; } }));
      st.ov.forEach(o2 => { if (st.hidden.has(o2.group)) return; if (o2.type === 'hline' && near(o2.y)) { lo = Math.min(lo, o2.y); hi = Math.max(hi, o2.y); } if (o2.type === 'zone' && near((o2.y1 + o2.y2) / 2)) { lo = Math.min(lo, o2.y1, o2.y2); hi = Math.max(hi, o2.y1, o2.y2); } });
      const padY = (hi - lo || 1) * 0.06; lo -= padY; hi += padY;
      const yOf = v => T + (hi - v) / (hi - lo) * Hm;
      // ---- grid + axis ----
      ctx.font = (mini ? 9 : 10.5) + 'px system-ui'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
      const ticks = mini ? 3 : 6;
      for (let k = 0; k <= ticks; k++) {
        const v = lo + (hi - lo) * k / ticks, y = yOf(v);
        ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(L, y + .5); ctx.lineTo(Wp, y + .5); ctx.stroke();
        ctx.fillStyle = TXT; ctx.textAlign = 'left'; ctx.fillText(fmt(v), Wp + 4, y);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const every = Math.max(1, Math.round((mini ? 56 : 80) / slot));
      for (let i = Math.ceil(start); i <= i1; i += every) {
        const d = new Date(candles[i].t), lab = st.tfMs >= 864e5 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.getHours() === 0 && d.getMinutes() === 0 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const x = xOf(i); ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(x + .5, T); ctx.lineTo(x + .5, h - AXH - paneH - (paneOn ? 4 : 0)); ctx.stroke(); ctx.fillStyle = TXT; ctx.fillText(lab, Math.min(Math.max(x, 18), Wp - 18), h - AXH + 3);
      }
      ctx.save(); ctx.beginPath(); ctx.rect(L, T - 2, Wp, Hm + 4); ctx.clip();
      const vis2 = o2 => !st.hidden.has(o2.group);
      // ---- bands and zones (under candles) ----
      st.ov.filter(vis2).forEach(o2 => {
        if (o2.type === 'band') {
          ctx.beginPath(); let started = false;
          for (let i = i0; i <= i1; i++) { if (o2.upper[i] == null) continue; const x = xOf(i), y = yOf(o2.upper[i]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); }
          for (let i = i1; i >= i0; i--) { if (o2.lower[i] == null) continue; ctx.lineTo(xOf(i), yOf(o2.lower[i])); }
          ctx.closePath(); ctx.fillStyle = o2.color || 'rgba(169,139,255,.1)'; ctx.fill();
          [o2.upper, o2.lower].forEach(arr => { ctx.beginPath(); started = false; for (let i = i0; i <= i1; i++) { if (arr[i] == null) continue; const x = xOf(i), y = yOf(arr[i]); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); } ctx.strokeStyle = o2.line || o2.color; ctx.lineWidth = 1; ctx.stroke(); });
        }
        if (o2.type === 'zone') {
          const xa = xOf(o2.i1) - slot / 2, xb = xOf(o2.i2) + slot / 2, ya = yOf(Math.max(o2.y1, o2.y2)), yb = yOf(Math.min(o2.y1, o2.y2));
          ctx.fillStyle = o2.color || 'rgba(124,156,255,.1)'; ctx.fillRect(xa, ya, xb - xa, Math.max(1, yb - ya));
          if (o2.border) { ctx.strokeStyle = o2.border; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.strokeRect(xa + .5, ya + .5, xb - xa, Math.max(1, yb - ya)); }
          if (o2.label && !mini && xb > 0) { ctx.fillStyle = o2.border || TXT; ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(o2.label, Math.max(L + 3, xa + 3), ya + 2); }
        }
      });
      // ---- lines ----
      st.ov.filter(vis2).forEach(o2 => {
        if (o2.type === 'series') {
          ctx.beginPath(); let s2 = false;
          for (let i = i0; i <= i1; i++) { const v = o2.values[i]; if (v == null) { s2 = false; continue; } const x = xOf(i), y = yOf(v); if (!s2) { ctx.moveTo(x, y); s2 = true; } else ctx.lineTo(x, y); }
          ctx.strokeStyle = o2.color; ctx.lineWidth = mini ? Math.min(1.2, o2.width || 1.2) : o2.width || 1.4; ctx.setLineDash(o2.dash || []); ctx.stroke(); ctx.setLineDash([]);
        }
        if (o2.type === 'hline') {
          const y = yOf(o2.y); if (y < T - 2 || y > mainB + 2) return;
          ctx.strokeStyle = o2.color; ctx.lineWidth = 1; ctx.setLineDash(o2.dash || [6, 4]); ctx.beginPath(); ctx.moveTo(L, y + .5); ctx.lineTo(Wp, y + .5); ctx.stroke(); ctx.setLineDash([]);
          if (!mini && o2.label) { ctx.fillStyle = o2.color; ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`${o2.label} ${fmt(o2.y)}`, L + 4, y - 1); }
        }
        if (o2.type === 'trend') {
          const dx = o2.i2 - o2.i1; if (!dx) return; const m = (o2.y2 - o2.y1) / dx, ia = o2.i1, ib = Math.min(end, n - 1 + PAD - 1);
          ctx.strokeStyle = o2.color; ctx.lineWidth = 1.6; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(xOf(ia), yOf(o2.y1)); ctx.lineTo(xOf(ib), yOf(o2.y1 + m * (ib - ia))); ctx.stroke();
          [[o2.i1, o2.y1], [o2.i2, o2.y2]].forEach(([i, y]) => { ctx.fillStyle = o2.color; ctx.beginPath(); ctx.arc(xOf(i), yOf(y), 2.6, 0, 7); ctx.fill(); });
          if (!mini && o2.label) { ctx.fillStyle = o2.color; ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(o2.label, xOf(o2.i2) + 5, yOf(o2.y2) - 4); }
        }
      });
      // ---- candles ----
      const cw = Math.max(1, Math.min(14, slot * 0.68));
      for (let i = i0; i <= i1; i++) {
        const c = candles[i], x = xOf(i), up = c.c >= c.o, col = up ? UP : DN;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, yOf(c.h)); ctx.lineTo(Math.round(x) + .5, yOf(c.l)); ctx.stroke();
        const y1 = yOf(Math.max(c.o, c.c)), y2 = yOf(Math.min(c.o, c.c)); ctx.fillRect(x - cw / 2, y1, cw, Math.max(1, y2 - y1));
      }
      // ---- markers ----
      st.ov.filter(vis2).forEach(o2 => {
        if (o2.type !== 'marker' || o2.i < i0 - 1 || o2.i > i1 + 1) return;
        const x = xOf(o2.i), y = yOf(o2.y), up = o2.shape === 'up', d = mini ? 4 : 6, off = up ? d + 4 : -(d + 4);
        ctx.fillStyle = o2.color; ctx.beginPath(); if (up) { ctx.moveTo(x, y + off - d); ctx.lineTo(x - d, y + off + d); ctx.lineTo(x + d, y + off + d); } else { ctx.moveTo(x, y + off + d); ctx.lineTo(x - d, y + off - d); ctx.lineTo(x + d, y + off - d); } ctx.closePath(); ctx.fill();
        if (!mini && o2.label) { ctx.font = '10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = up ? 'top' : 'bottom'; ctx.fillText(o2.label, x, up ? y + off + d + 2 : y + off - d - 2); }
      });
      // ---- position boxes (TradingView long/short tool) ----
      st.pos.forEach(p => {
        const long = p.side === 'BUY', xa = xOf(p.i) , xb = xOf(Math.min(end, n - 1 + PAD - 1)) + slot / 2, ye = yOf(p.entry);
        if (p.target != null) { const yt = yOf(p.target); ctx.fillStyle = 'rgba(86,214,176,.16)'; ctx.fillRect(xa, Math.min(ye, yt), xb - xa, Math.abs(yt - ye)); ctx.strokeStyle = UP; ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeRect(xa + .5, Math.min(ye, yt) + .5, xb - xa, Math.abs(yt - ye)); }
        if (p.stop != null) { const ys = yOf(p.stop); ctx.fillStyle = 'rgba(255,126,140,.16)'; ctx.fillRect(xa, Math.min(ye, ys), xb - xa, Math.abs(ys - ye)); ctx.strokeStyle = DN; ctx.lineWidth = 1; ctx.strokeRect(xa + .5, Math.min(ye, ys) + .5, xb - xa, Math.abs(ys - ye)); }
        ctx.strokeStyle = '#edf3fc'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(xa, ye + .5); ctx.lineTo(xb, ye + .5); ctx.stroke();
        if (!mini) {
          ctx.font = '10.5px system-ui'; ctx.textAlign = 'left';
          const rr = p.target != null && p.stop != null ? Math.abs(p.target - p.entry) / Math.abs(p.entry - p.stop) : null;
          ctx.fillStyle = '#edf3fc'; ctx.textBaseline = 'bottom'; ctx.fillText(`${long ? 'LONG' : 'SHORT'}${p.label ? ' · ' + p.label : ''}${rr ? ` · ${rr.toFixed(2)}R` : ''}`, xa + 4, ye - 3);
          if (p.target != null) { ctx.fillStyle = UP; ctx.textBaseline = long ? 'bottom' : 'top'; ctx.fillText(`TP ${fmt(p.target)}`, xa + 4, yOf(p.target) + (long ? -2 : 2)); }
          if (p.stop != null) { ctx.fillStyle = DN; ctx.textBaseline = long ? 'top' : 'bottom'; ctx.fillText(`SL ${fmt(p.stop)}`, xa + 4, yOf(p.stop) + (long ? 2 : -2)); }
        }
      });
      ctx.restore();
      // ---- last price tag ----
      const lc = candles[n - 1], yl = yOf(lc.c), col = lc.c >= lc.o ? UP : DN;
      ctx.strokeStyle = col; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, yl + .5); ctx.lineTo(Wp, yl + .5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.fillRect(Wp, yl - 8, AXW - 1, 16); ctx.fillStyle = '#06121a'; ctx.font = 'bold ' + (mini ? 9 : 10.5) + 'px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(lc.c), Wp + 3, yl);
      // ---- sub pane ----
      if (paneOn) {
        const p = st.pane, pt = mainB + 4, ph = paneH, pb = pt + ph; let mn = p.min, mx = p.max;
        const vals = []; for (let i = i0; i <= i1; i++) if (p.values[i] != null) vals.push(p.values[i]);
        if (mn == null) mn = p.kind === 'hist' ? -Math.max(...vals.map(Math.abs), 1e-9) : 0; if (mx == null) mx = p.kind === 'hist' ? -mn : Math.max(...vals, 1e-9);
        const yp = v => pt + (mx - v) / ((mx - mn) || 1) * ph;
        ctx.fillStyle = 'rgba(154,171,194,.04)'; ctx.fillRect(L, pt, Wp, ph);
        (p.levels || []).forEach(lv => { const y = yp(lv); ctx.strokeStyle = GRID; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(L, y + .5); ctx.lineTo(Wp, y + .5); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = TXT; ctx.font = '9px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(String(lv), Wp + 4, y); });
        ctx.save(); ctx.beginPath(); ctx.rect(L, pt, Wp, ph); ctx.clip();
        if (p.kind === 'line') { ctx.beginPath(); let s2 = false; for (let i = i0; i <= i1; i++) { const v = p.values[i]; if (v == null) { s2 = false; continue; } const x = xOf(i), y = yp(v); if (!s2) { ctx.moveTo(x, y); s2 = true; } else ctx.lineTo(x, y); } ctx.strokeStyle = p.color || '#a98bff'; ctx.lineWidth = 1.4; ctx.stroke(); }
        else for (let i = i0; i <= i1; i++) { const v = p.values[i]; if (v == null) continue; const x = xOf(i), y0 = yp(p.kind === 'hist' ? 0 : mn), y1 = yp(v); ctx.fillStyle = p.colors ? p.colors[i] : v >= 0 ? 'rgba(86,214,176,.6)' : 'rgba(255,126,140,.6)'; ctx.fillRect(x - cw / 2, Math.min(y0, y1), cw, Math.max(1, Math.abs(y1 - y0))); }
        ctx.restore();
        ctx.fillStyle = TXT; ctx.font = '9.5px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(p.label || '', L + 4, pt + 2);
      }
      // ---- legend + header ----
      ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.font = (mini ? 9 : 10.5) + 'px system-ui';
      if (!mini) {
        let lx = 6; const seen = new Set();
        st.ov.filter(vis2).forEach(o2 => { if ((o2.type === 'series' || o2.type === 'trend') && o2.label && !seen.has(o2.label)) { seen.add(o2.label); ctx.fillStyle = o2.color; ctx.fillRect(lx, 9, 8, 3); ctx.fillStyle = TXT; ctx.fillText(o2.label, lx + 11, 4); lx += ctx.measureText(o2.label).width + 24; } });
      }
      if (st.title) { ctx.fillStyle = '#edf3fc'; ctx.font = 'bold ' + (mini ? 10 : 11.5) + 'px system-ui'; ctx.textAlign = 'right'; ctx.fillText(st.title, Wp - 4, 3); }
      // ---- crosshair ----
      if (st.cross && !mini) {
        const i = Math.max(0, Math.min(n - 1, Math.round(st.cross.x / slot - 0.5 + start))), c = candles[i], x = xOf(i);
        ctx.strokeStyle = 'rgba(237,243,252,.45)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x + .5, T); ctx.lineTo(x + .5, h - AXH); ctx.stroke(); ctx.beginPath(); ctx.moveTo(L, st.cross.y + .5); ctx.lineTo(Wp, st.cross.y + .5); ctx.stroke(); ctx.setLineDash([]);
        if (st.cross.y >= T && st.cross.y <= mainB) { const pv = hi - (st.cross.y - T) / Hm * (hi - lo); ctx.fillStyle = '#27364d'; ctx.fillRect(Wp, st.cross.y - 8, AXW - 1, 16); ctx.fillStyle = '#edf3fc'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '10.5px system-ui'; ctx.fillText(fmt(pv), Wp + 3, st.cross.y); }
        const txt = `${new Date(c.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}  O ${fmt(c.o)}  H ${fmt(c.h)}  L ${fmt(c.l)}  C ${fmt(c.c)}  V ${c.v >= 1000 ? (c.v / 1000).toFixed(1) + 'k' : c.v.toFixed(2)}`;
        ctx.font = '10.5px system-ui'; const tw = ctx.measureText(txt).width + 12; ctx.fillStyle = 'rgba(11,17,32,.92)'; ctx.fillRect(4, T + 2, tw, 18); ctx.fillStyle = '#edf3fc'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(txt, 10, T + 11);
      }
    }

    // ---- interaction ----
    const ptrs = new Map(); let pinch = null, lastX = null;
    const local = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const clampOff = () => { const n = st.candles.length; st.vis = Math.max(12, Math.min(st.vis, Math.max(12, n + PAD))); st.off = Math.max(-PAD + 1, Math.min(st.off, Math.max(0, n - 20))); };
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, local(e)); lastX = local(e).x; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), vis: st.vis }; } });
    canvas.addEventListener('pointermove', e => {
      const p = local(e);
      if (ptrs.has(e.pointerId)) {
        ptrs.set(e.pointerId, p);
        if (ptrs.size === 2 && pinch) { const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y); st.vis = pinch.vis * pinch.d / Math.max(10, d); clampOff(); draw(); return; }
        if (ptrs.size === 1 && st.geo) { const dx = p.x - lastX; if (Math.abs(dx) > 0) { st.off += dx / st.geo.slot; lastX = p.x; clampOff(); } }
      }
      if (e.pointerType === 'mouse' || ptrs.has(e.pointerId)) st.cross = p;
      draw();
    });
    const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; lastX = ptrs.size ? [...ptrs.values()][0].x : null; if (e.pointerType !== 'mouse') { st.cross = null; draw(); } };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => { if (!ptrs.size) { st.cross = null; draw(); } });
    canvas.addEventListener('wheel', e => { e.preventDefault(); st.vis *= e.deltaY > 0 ? 1.12 : 0.89; clampOff(); draw(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { st.vis = o.visible || (mini ? 60 : 90); st.off = 0; draw(); });
    let ro = null; if (root.ResizeObserver) { ro = new ResizeObserver(() => draw()); ro.observe(canvas); }

    return {
      set(d) {
        const n0 = st.candles.length;
        st.candles = d.candles || []; st.ov = d.overlays || []; st.pane = d.pane || null; st.pos = d.positions || []; st.title = d.title || ''; st.tfMs = d.tfMs || st.tfMs;
        if (st.candles.length !== n0 && d.reset) { st.off = 0; st.vis = o.visible || (mini ? 60 : 90); }
        clampOff(); draw();
      },
      toggle(group, on) { if (on) st.hidden.delete(group); else st.hidden.add(group); draw(); },
      reset() { st.off = 0; st.vis = o.visible || (mini ? 60 : 90); draw(); },
      zoom(f) { st.vis *= f; clampOff(); draw(); },
      draw, destroy() { if (ro) ro.disconnect(); },
      state: st,
    };
  }
  root.TB = root.TB || {}; root.TB.chart = { create, fmt };
})(typeof self !== 'undefined' ? self : this);
