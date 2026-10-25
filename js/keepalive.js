/* TradeBrain · keep running when you leave the app.
   Android APK : a foreground service (notification + wake lock) keeps the process alive, and timers come from a Web Worker so they are not throttled.
   Browser/PWA : Web Worker timers + optional screen wake lock. A browser tab that the phone suspends cannot trade; install the APK for real background running. */
(function () {
  'use strict';
  const KEY = 'tb_keepalive'; let on = false, lock = null, worker = null; const cbs = new Map(); let seq = 0;
  const plugin = () => { try { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KeepAlive; } catch (e) { return null; } };
  const isApk = () => !!plugin();
  function ensureWorker() {
    if (worker || typeof Worker === 'undefined') return worker;
    try {
      const src = 'const t={};onmessage=e=>{const d=e.data;if(d.op==="start"){clearInterval(t[d.id]);t[d.id]=setInterval(()=>postMessage(d.id),d.ms);}else if(d.op==="stop"){clearInterval(t[d.id]);delete t[d.id];}};';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = e => { const f = cbs.get(e.data); if (f) { try { f(); } catch (x) { /* a failing tick must not stop the timer */ } } };
    } catch (e) { worker = null; }
    return worker;
  }
  /** setInterval that keeps ticking in the background. Returns { stop() }. */
  function every(fn, ms) {
    const w = ensureWorker(); if (!w) { const h = setInterval(fn, ms); return { stop: () => clearInterval(h) }; }
    const id = ++seq; cbs.set(id, fn); w.postMessage({ op: 'start', id, ms }); return { stop: () => { cbs.delete(id); w.postMessage({ op: 'stop', id }); } };
  }
  async function enable() {
    on = true; try { localStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ }
    const p = plugin(); if (p) { try { await p.start({ title: 'TradeBrain is running', text: 'Scanning markets and watching open trades' }); } catch (e) { return { ok: false, why: 'Could not start the background service: ' + e.message }; } }
    else if (navigator.wakeLock) { try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch (e) { /* denied */ } }
    return { ok: true, apk: !!p };
  }
  async function disable() {
    on = false; try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    const p = plugin(); if (p) { try { await p.stop(); } catch (e) { /* ignore */ } }
    if (lock) { try { await lock.release(); } catch (e) { /* ignore */ } lock = null; }
  }
  async function battery() { const p = plugin(); if (!p) return null; try { return (await p.batteryStatus()).unrestricted; } catch (e) { return null; } }
  async function unrestricted() { const p = plugin(); if (p) { try { await p.requestUnrestricted(); } catch (e) { /* ignore */ } } }
  document.addEventListener('visibilitychange', () => { if (on && !document.hidden && !isApk() && navigator.wakeLock && !lock) navigator.wakeLock.request('screen').then(l => { lock = l; }).catch(() => {}); });
  window.TB = window.TB || {};
  window.TB.bg = { every, enable, disable, battery, unrestricted, isOn: () => on, isApk, wasOn: () => { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } } };
})();
