/* TradeBrain · in-app connections (v7). Paste keys, see balance (demo or real), sign orders/contracts with one tap.
   v7: keys stay visible after pasting, Binance diagnose + clear error hints, AI model picker fixed, Gemini + Groq team mode.
   v6: two AI key slots with automatic failover, Deriv works with new PATs AND old tokens, step-by-step Diagnose, status chips.
   Keys stay on this phone (localStorage) only if "Remember" is ticked. They are sent only to the provider you pick. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), KEY = 'tb_conn';
  let ctx = null, ld = {}, sig = null; const rt = { seen: new Set(), last: {}, orders: 0 };
  try { ld = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { ld = {}; }
  if (ld.remember === undefined) ld.remember = true;      // keys used to vanish on every restart unless this box was ticked
  const save = () => { try { if (ld.remember) localStorage.setItem(KEY, JSON.stringify(ld)); else localStorage.removeItem(KEY); } catch (e) {} };
  const mask = k => k ? k.slice(0, 4) + '••••' + k.slice(-3) : '';
  const say = (id, t) => { const e = $(id); if (e) e.textContent = t; };
  const hhmm = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const chip = (id, cls, text) => { const e = $('cs-' + id); if (!e) return; e.className = 'chip ' + cls; const v = e.querySelector('em'); if (v) v.textContent = text; };
  const tfetch = async (url, o = {}, ms = 20000) => {
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
    try { return await fetch(url, { ...o, signal: c.signal }); }
    catch (e) { throw new Error(e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'network error'); }
    finally { clearTimeout(t); }
  };
  const errMsg = j => (j && j.error && (j.error.message || (typeof j.error === 'string' ? j.error : JSON.stringify(j.error)))) || (j && j.message) || '';
  const PROV = [[/^xai-/, 'Grok (xAI)', 'https://api.x.ai/v1'], [/^gsk_/, 'Groq', 'https://api.groq.com/openai/v1'], [/^(AIza|AQ\.)/, 'Gemini', 'https://generativelanguage.googleapis.com/v1beta'], [/^sk-/, 'OpenAI', 'https://api.openai.com/v1']];
  const detect = k => { const p = PROV.find(x => x[0].test(k.trim())); return p ? { name: p[1], url: p[2] } : null; };
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  const clean = v => String(v || '').replace(/[\s\u200b-\u200f\u2060\ufeff"'`“”‘’]/g, '');   // pasted keys often carry spaces, quotes or invisible characters
  const enc = t => new TextEncoder().encode(t);
  const sha256 = (() => {
    const K = [], H0 = []; let c = 0;
    for (let n = 2; c < 64; n++) { let pr = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { pr = false; break; } if (pr) { if (c < 8) H0[c] = Math.floor((Math.sqrt(n) % 1) * 4294967296); K[c] = Math.floor((Math.cbrt(n) % 1) * 4294967296); c++; } }
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    return bytes => {
      const l = bytes.length, nb = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(nb); m.set(bytes); m[l] = 0x80;
      const dv = new DataView(m.buffer); dv.setUint32(nb - 8, Math.floor(l / 536870912)); dv.setUint32(nb - 4, (l << 3) >>> 0);
      const h = H0.slice(), w = new Array(64);
      for (let o = 0; o < nb; o += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
        for (let i = 16; i < 64; i++) { const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
        let [a, b, c2, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) { const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25), ch = (e & f) ^ (~e & g), t1 = (hh + S1 + ch + K[i] + w[i]) | 0, S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22), mj = (a & b) ^ (a & c2) ^ (b & c2), t2 = (S0 + mj) | 0; hh = g; g = f; f = e; e = (d + t1) | 0; d = c2; c2 = b; b = a; a = (t1 + t2) | 0; }
        [a, b, c2, d, e, f, g, hh].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
      }
      const out = new Uint8Array(32), ov = new DataView(out.buffer); h.forEach((v, i) => ov.setUint32(i * 4, v >>> 0)); return out;
    };
  })();
  function hmacRaw(key, msg) {
    let k = key.length > 64 ? sha256(key) : key; const ip = new Uint8Array(64 + msg.length), op = new Uint8Array(96);
    for (let i = 0; i < 64; i++) { const b = k[i] || 0; ip[i] = b ^ 0x36; op[i] = b ^ 0x5c; } ip.set(msg, 64); op.set(sha256(ip), 64); return sha256(op);
  }
  /* Signing works even when the page is opened over plain http (where the browser hides crypto.subtle), e.g. http://192.168.x.x from Termux. */
  async function hmacHex(secret, text) {
    if (window.crypto && crypto.subtle) { try { const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return hex(await crypto.subtle.sign('HMAC', key, enc(text))); } catch (e) { /* fall through to the built-in signer */ } }
    return hex(hmacRaw(enc(secret), enc(text)));
  }

  /* ---------- AI keys: two slots, automatic failover ---------- */
  const AIS = { 1: { p: 'ai', box: 'c-ai', model: 'c-ai-model', out: 'c-ai-out', label: 'Primary' }, 2: { p: 'ai2', box: 'c-ai2', model: 'c-ai2-model', out: 'c-ai2-out', label: 'Backup' } };
  const slot = n => { const p = AIS[n].p; return { n, key: ld[p] || '', url: ld[p + 'Url'] || '', model: ld[p + 'Model'] || '', name: ld[p + 'Name'] || '', alts: ld[p + 'Alts'] || [], label: AIS[n].label }; };
  const cool = {};                       // runtime only: n -> { until, why }
  const today = () => new Date().toISOString().slice(0, 10);
  const useOf = n => { if ((ld.aiUse || {}).day !== today()) ld.aiUse = { day: today(), 1: 0, 2: 0 }; return ld.aiUse[n] || 0; };
  const bump = n => { useOf(n); ld.aiUse[n]++; save(); };
  const nextMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return +d; };
  const hasAI = () => !!(ld.ai || ld.ai2);
  const keyCount = () => [1, 2].filter(n => slot(n).key).length;
  const baseOf = (name, url) => name === 'Gemini' ? String(url).replace(/\/openai\/?$/, '') : url;      // Gemini now uses Google's native API (new AQ. keys need it)
  const hdrs = (name, key) => name === 'Gemini' ? { 'x-goog-api-key': key } : { Authorization: 'Bearer ' + key };
  const listUrl = (name, url) => baseOf(name, url) + '/models' + (name === 'Gemini' ? '?pageSize=200' : '');
  const modelIds = j => (j.data || j.models || []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map(m => String(m.id || m.name).replace(/^models\//, '')).sort();
  const NOT_CHAT = /image|imagine|imagen|embed|vision|tts|whisper|audio|guard|moderat|video|veo|rerank|live|transcribe|aqa|robotics|learnlm|safeguard|computer-use/i;
  /* Picks chat models per provider. Old versions sorted names alphabetically, which chose a tiny-quota reasoning model on Groq and a Gemma model on Gemini. */
  function rankModels(ids, prov) {
    const ok = ids.filter(i => !NOT_CHAT.test(i)), pool = ok.length ? ok : ids, out = [];
    const num = t => { const m = t.match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[1]) : 0; };
    const add = (...res) => res.forEach(re => pool.filter(i => re.test(i) && !out.includes(i)).sort((a, b) => num(b) - num(a) || b.localeCompare(a)).forEach(i => out.push(i)));
    if (prov === 'Gemini') add(/^gemini-[\d.]+-flash$/, /^gemini-flash-latest$/, /^gemini-[\d.]+-flash-lite$/, /^gemini-[\d.]+-pro$/);
    else if (prov === 'Groq') add(/^llama-3\.3-70b-versatile$/, /^llama-3\.1-8b-instant$/, /gpt-oss-20b/, /gpt-oss-120b/, /llama/);
    else if (prov === 'OpenAI') add(/^gpt-[\d.]+-mini$/, /^gpt-4o-mini$/, /^gpt-[\d.]+$/);
    else add(/^grok-\d/);
    add(/^(?!.*(preview|exp|qwen|r1|reason|thinking)).*/);
    add(/./);
    return out;
  }
  function coolKey(n, status, msg, retry) {
    const daily = status === 402 || /day|daily|credit|billing|quota|exhaust/i.test(msg);
    const until = (status === 401 || status === 403) ? Date.now() + 3600e3 : daily ? nextMidnight() : Date.now() + Math.max(15, Math.min(retry || 60, 3600)) * 1000;
    cool[n] = { until, why: (status === 401 || status === 403) ? 'rejected' : daily ? 'daily limit' : 'rate limit' };
  }
  const limited = e => [401, 402, 403, 429].includes(e.status) || /quota|limit|credit/i.test(e.message || '');
  function aiOrder() {
    const have = [1, 2].filter(n => slot(n).key), now = Date.now();
    const ready = have.filter(n => !(cool[n] && cool[n].until > now)), waiting = have.filter(n => !ready.includes(n));
    if (ld.aiMode === 'balance') ready.sort((a, b) => useOf(a) - useOf(b) || a - b);
    return [...ready, ...waiting];       // keys that are cooling down are still tried last, so nothing is ever skipped
  }
  function aiShow() {
    [1, 2].forEach(n => {
      const s = slot(n); if (!s.key) return say(AIS[n].out, 'Not connected.');
      const c = cool[n] && cool[n].until > Date.now() ? cool[n] : null;
      say(AIS[n].out, `✔ ${s.name} ${mask(s.key)} · ${s.model}\n${useOf(n)} calls today · ${c ? `paused (${c.why}) until ${hhmm(c.until)}, tried last` : 'ready'}`);
    });
  }
  function aiStrip() {
    const have = [1, 2].filter(n => slot(n).key); if (!have.length) return chip('ai', 'off', 'No key');
    const ready = have.filter(n => !(cool[n] && cool[n].until > Date.now()));
    chip('ai', ready.length ? 'ok' : 'warn', ready.length ? `${ready.length}/${have.length} key${have.length > 1 ? 's' : ''} ready` : 'limit reached');
  }
  function syncSel(n, ids) { const sel = $(AIS[n].model), m = slot(n).model; if (!sel) return; if (ids && ids.length) sel.innerHTML = ids.map(i => `<option>${i}</option>`).join(''); else if (m) sel.innerHTML = `<option>${m}</option>`; if (m) sel.value = m; }
  /* Re-reads the model list for a saved key: builds the fallback models and replaces a model that cannot work (old saves picked bad ones). */
  async function refreshModels(n) {
    const s = slot(n), p = AIS[n].p;
    const r = await tfetch(listUrl(s.name, s.url), { headers: hdrs(s.name, s.key) }, 15000), j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(errMsg(j) || 'HTTP ' + r.status);
    const ids = modelIds(j), rk = rankModels(ids, s.name); ld[p + 'Alts'] = rk.slice(0, 5);
    if (rk.length && (!s.model || !ids.includes(s.model) || /qwen|deepseek-r1/i.test(s.model))) ld[p + 'Model'] = rk[0];
    save(); syncSel(n, ids); return ids;
  }
  const mkErr = (msg, status, retry) => { const e = new Error(msg); e.status = status || 0; e.retry = retry || 0; return e; };
  const tokBase = name => name === 'Gemini' ? 1500 : name === 'Groq' ? 450 : 700;
  /* One AI call on one key. Always sends max_tokens (Groq refused requests that asked for too many output tokens), halves it when told it is too large,
     doubles it when a thinking model used it all, and tries the key's other models because limits are usually per model. */
  async function callSlot(n, prompt, system) {
    let s = slot(n);
    if (!s.alts.length) { try { await refreshModels(n); s = slot(n); } catch (e) { /* the call below reports the real problem */ } }
    const models = [s.model, ...s.alts.filter(m => m !== s.model)].filter(Boolean).slice(0, 4);
    if (!models.length) throw mkErr('No model chosen yet. Tap Test on this key.', 0);
    let last = mkErr('no answer', 0), prev = 0;
    for (const model of models) {
      let toks = tokBase(s.name);
      for (let at = 0; at < 3; at++) {
        let r, j;
        const gem = s.name === 'Gemini';
        try {
          r = gem
            ? await tfetch(`${baseOf(s.name, s.url)}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.key }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system || SYS }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: toks } }) }, 60000)
            : await tfetch(s.url + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.key }, body: JSON.stringify({ model, temperature: 0.2, max_tokens: toks, messages: [{ role: 'system', content: system || SYS }, { role: 'user', content: prompt }] }) }, 60000);
          j = await r.json().catch(() => ({}));
        } catch (e) { throw mkErr(e.message, 0); }
        const ch = gem ? (j.candidates && j.candidates[0]) : (j.choices && j.choices[0]);
        const txt = gem ? (ch && ch.content && (ch.content.parts || []).map(x => x.text || '').join('')) : (ch && ch.message && ch.message.content);
        const cut = gem ? !!(ch && ch.finishReason === 'MAX_TOKENS') : !!(ch && ch.finish_reason === 'length');
        if (r.ok && txt && String(txt).trim()) { if (model !== s.model && [400, 404].includes(prev)) { ld[AIS[n].p + 'Model'] = model; save(); syncSel(n); } return { text: String(txt).trim(), model }; }
        const msg = errMsg(j) || (r.ok ? 'empty reply' : 'HTTP ' + r.status); let ra = 0; try { ra = +(r.headers && r.headers.get && r.headers.get('retry-after')) || 0; } catch (e) {}
        last = mkErr(msg, r.status, ra); prev = r.status;
        if (r.ok && cut && toks < 4000) { toks *= 2; continue; }
        if ((r.status === 413 || /too large|reduce max_tokens|expected output/i.test(msg)) && at === 0 && toks > 150) { toks = Math.max(150, Math.floor(toks / 2)); continue; }
        break;
      }
      if ([401, 402, 403].includes(last.status)) throw last;
    }
    throw last;
  }
  async function aiTest(n) {
    const a = AIS[n], cur = slot(n), box = $(a.box), k = clean(box.value) || cur.key, p = k && detect(k);
    if (!k) return say(a.out, 'Paste a key first.');
    if (!p) return say(a.out, 'Key not recognised (expects xai-, gsk_, AIza, AQ. or sk-).');
    say(a.out, `Detected ${p.name}. Testing…`);
    try {
      const r = await tfetch(listUrl(p.name, p.url), { headers: hdrs(p.name, k) }), j = await r.json().catch(() => ({}));
      if (!r.ok) return say(a.out, `${p.name}: ${r.status} ${errMsg(j) || 'key rejected'}${p.name === 'Gemini' && /AQ\./.test(k.slice(0, 3)) && r.status === 401 ? '\nGoogle rejected this AQ. key. In Google Cloud Console > APIs & Services > Credentials, create an API key in a project with the Generative Language API enabled, and try that one.' : ''}`);
      const ids = modelIds(j), rk = rankModels(ids, p.name), sel = $(a.model);
      sel.innerHTML = ids.map(i => `<option>${i}</option>`).join('');
      const keep = cur.name === p.name && cur.model && ids.includes(cur.model) && !/qwen|deepseek-r1/i.test(cur.model), want = keep ? cur.model : (rk[0] || ''); sel.value = want;
      ld[a.p] = k; ld[a.p + 'Url'] = p.url; ld[a.p + 'Model'] = want; ld[a.p + 'Name'] = p.name; ld[a.p + 'Alts'] = rk.slice(0, 5); box.value = k; delete cool[n]; save(); aiShow(); aiStrip();
      const base = $(a.out).textContent + `\n${ids.length} models available.`; say(a.out, base + '\nSending a tiny chat test…');
      try { const t = await callSlot(n, 'Reply with the single word OK.', 'You are a connection test.'); say(a.out, base + `\n✔ Chat works (${t.model}).`); }
      catch (e) { say(a.out, base + `\n✖ Key is valid but chat failed: ${e.message}`); }
    } catch (e) { say(a.out, `Could not reach ${p.name}: ${e.message}. If this is the web page, the browser may block it; the APK does not.`); }
  }
  const SYS = 'You are a cautious trading analyst. Give a short assessment: agree/disagree with the signal, main risk, what would invalidate it. No guarantees.';
  /* Failover: first ready key answers; if it is limited the next key is tried. */
  async function askFailover(prompt, system) {
    const order = aiOrder(); if (!order.length) throw new Error('Add an AI key (Gemini, Groq, Grok…) in Connect first.');
    const errs = [];
    for (const n of order) {
      const s = slot(n);
      try { const r = await callSlot(n, prompt, system || SYS); delete cool[n]; bump(n); aiShow(); aiStrip(); return `${r.model} · ${s.name} (${s.label} key)\n\n${r.text}`; }
      catch (e) { errs.push(`${s.label} ${s.name}: ${e.message}`); if (limited(e)) coolKey(n, e.status, e.message, e.retry); }
    }
    aiShow(); aiStrip();
    throw new Error('All AI keys failed. ' + errs.join(' | '));
  }
  /* Team: both AIs get the same market facts at the same time and each gives BUY / SELL / WAIT. They only "agree" when they say the same thing; anything else is WAIT. */
  const TEAM_SYS = SYS + ' Answer in exactly this format. Line 1: "VERDICT: BUY" or "VERDICT: SELL" or "VERDICT: WAIT". Line 2: "CONFIDENCE: " and a number from 0 to 100. Then at most three short lines: reason, main risk, what would invalidate it.';
  const verdictOf = t => { const m = /VERDICT\W*(BUY|SELL|WAIT)/i.exec(t || ''); return m ? m[1].toUpperCase() : ''; };
  const confOf = t => { const m = /CONFIDENCE\W*(\d{1,3})/i.exec(t || ''); return m ? Math.min(100, +m[1]) : null; };
  const teamMemo = new Map();
  function teamRun(prompt, memoKey) {
    const hit = memoKey && teamMemo.get(memoKey); if (hit && Date.now() - hit.t < 600000) return hit.p;
    const p = (async () => {
      const have = [1, 2].filter(n => slot(n).key); if (!have.length) throw new Error('Add an AI key in Connect first.');
      const out = await Promise.all(have.map(async n => {
        const s = slot(n);
        try { const r = await callSlot(n, prompt, TEAM_SYS); delete cool[n]; bump(n); return { s, ok: true, text: r.text, model: r.model, v: verdictOf(r.text), c: confOf(r.text) }; }
        catch (e) { if (limited(e)) coolKey(n, e.status, e.message, e.retry); return { s, ok: false, err: e.message }; }
      }));
      aiShow(); aiStrip();
      const good = out.filter(x => x.ok);
      if (!good.length) throw new Error('All AI keys failed. ' + out.map(x => `${x.s.label} ${x.s.name}: ${x.err}`).join(' | '));
      const vs = good.map(x => x.v), same = vs.every(v => v && v === vs[0]), agree = same && good.length >= Math.min(2, have.length), verdict = agree ? vs[0] : 'WAIT';
      const conf = good.map(x => x.c).filter(x => x != null);
      const head = agree ? (good.length > 1 ? `✔ AIs agree: ${verdict}` : `One AI: ${verdict}`) + (conf.length ? ` · average confidence ${Math.round(conf.reduce((a, b) => a + b, 0) / conf.length)}` : '')
        : good.length < have.length ? `⚠ Only ${good.length} of ${have.length} AIs answered, so there is no team verdict. Treat as WAIT.` : `⚠ AIs disagree (${good.map(x => `${x.s.name} ${x.v || '?'}`).join(' · ')}). Treat as WAIT.`;
      const text = `AI TEAM · ${out.map(x => x.s.name).join(' + ')}\n${head}\n\n` + out.map(x => x.ok ? `— ${x.s.name} · ${x.model}\n${x.text}` : `— ${x.s.name}: unavailable (${x.err})`).join('\n\n');
      return { verdict, agree, text };
    })();
    if (memoKey) { teamMemo.set(memoKey, { t: Date.now(), p }); p.catch(() => teamMemo.delete(memoKey)); }
    return p;
  }
  async function ask(prompt, system) {
    if (ld.aiMode === 'team' && keyCount() >= 2) return (await teamRun(prompt)).text;
    return askFailover(prompt, system);
  }

  /* ---------- Deriv: new PAT flow (REST -> one-time URL -> WebSocket) and old-token flow ---------- */
  let dws = null, dp = {}, dn = 0, dAuth = null, dPing = null;
  const dKind = t => /^pat_/i.test(t || '') ? 'pat' : 'legacy';
  const dRest = async (method, path) => {
    let r; try { r = await tfetch('https://api.derivws.com' + path, { method, headers: { Authorization: 'Bearer ' + ld.dTok, 'Deriv-App-ID': ld.dApp } }, 15000); }
    catch (e) { throw new Error(`Network: cannot reach api.derivws.com (${e.message}). Check internet or VPN. In a normal browser this is usually CORS; the APK avoids it.`); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(((j.errors && j.errors[0] && j.errors[0].message) || errMsg(j) || 'Deriv error') + ` (HTTP ${r.status}${r.status === 401 || r.status === 403 ? ': token or App ID rejected' : ''})`); return j;
  };
  function rawSend(w, msg, ms = 15000) {
    const id = ++dn;
    return new Promise((res, rej) => { dp[id] = { res, rej }; setTimeout(() => { if (dp[id]) { delete dp[id]; rej(new Error('Deriv did not answer')); } }, ms); try { w.send(JSON.stringify({ ...msg, req_id: id })); } catch (e) { delete dp[id]; rej(new Error('Deriv socket is closed')); } });
  }
  async function dOpen(url, legacyAuth) {
    return new Promise((res, rej) => {
      let w; try { w = new WebSocket(url); } catch (e) { return rej(new Error('Cannot open the Deriv socket: ' + e.message)); }
      const t = setTimeout(() => { try { w.close(); } catch (e) {} rej(new Error('Deriv socket timed out (no connection in 15 s)')); }, 15000);
      w.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } const f = dp[m.req_id]; if (f) { delete dp[m.req_id]; m.error ? f.rej(new Error(m.error.message || m.error.code)) : f.res(m); } };
      w.onerror = () => { clearTimeout(t); rej(new Error('Cannot open the Deriv socket (blocked or offline)')); };
      w.onclose = () => { clearInterval(dPing); if (dws === w) dws = null; Object.keys(dp).forEach(k => { dp[k].rej(new Error('Deriv socket closed')); delete dp[k]; }); };
      w.onopen = async () => {
        clearTimeout(t);
        try { if (legacyAuth) { const a = await rawSend(w, { authorize: ld.dTok }); dAuth = a.authorize; } dws = w; clearInterval(dPing); dPing = setInterval(() => { if (dws && dws.readyState === 1) { try { dws.send('{"ping":1}'); } catch (e) {} } }, 30000); res(w); }
        catch (e) { try { w.close(); } catch (x) {} rej(e); }
      };
    });
  }
  async function dSock() {
    if (dws && dws.readyState === 1) return dws;
    if (dKind(ld.dTok) === 'legacy') return dOpen('wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(ld.dApp || '1089'), true);
    const o = await dRest('POST', `/trading/v1/options/accounts/${ld.dAcct.id}/otp`), url = o.data && o.data.url; if (!url) throw new Error('Deriv gave no socket address: ' + JSON.stringify(o).slice(0, 150));
    return dOpen(url, false);
  }
  async function dSend(msg) { return rawSend(await dSock(), msg); }
  async function dPick(id) {
    const a = (ld.dAccts || []).find(x => x.id === id) || { id, demo: /^VR|^DEM/i.test(id) };
    ld.dAcct = { id: a.id, demo: a.demo, bal: null, cur: a.cur || 'USD' }; if (dws) { try { dws.close(); } catch (e) {} } dws = null;
    const b = await dSend({ balance: 1 }); ld.dAcct.bal = b.balance.balance; ld.dAcct.cur = b.balance.currency || ld.dAcct.cur; save(); showD();
  }
  async function dConnect() {
    const tok = $('c-dtok').value.trim() || ld.dTok, kind = dKind(tok), app = $('c-dapp').value.trim() || ld.dApp || (kind === 'legacy' ? '1089' : '');
    if (!tok) return say('c-d-out', 'Paste your Deriv token first.');
    if (kind === 'pat' && !app) return say('c-d-out', 'New tokens (pat_…) need an App ID. Register an app at developers.deriv.com to get one.');
    ld.dTok = tok; ld.dApp = app; $('c-dtok').value = tok; $('c-dapp').value = app; if (dws) { try { dws.close(); } catch (e) {} } dws = null; say('c-d-out', 'Connecting…'); chip('deriv', 'warn', 'Connecting…');
    try {
      if (kind === 'pat') {
        const j = await dRest('GET', '/trading/v1/options/accounts'), list = Array.isArray(j.data) ? j.data : (j.data && (j.data.accounts || j.data.items)) || [];
        ld.dAccts = list.map(a => { const id = a.account_id || a.loginid || a.id || ''; return { id, demo: a.account_type === 'demo' || a.is_virtual === 1 || a.is_virtual === true || /^VR|^DEM/i.test(id), cur: a.currency }; }).filter(a => a.id);
        if (!ld.dAccts.length) { chip('deriv', 'bad', 'No account'); return say('c-d-out', 'Token accepted but no accounts found. Raw reply:\n' + JSON.stringify(j).slice(0, 300)); }
      } else {
        await dOpen('wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(app), true);
        const z = dAuth || {};
        ld.dAccts = [{ id: z.loginid, demo: !!z.is_virtual, cur: z.currency }].filter(a => a.id);
        if (!ld.dAccts.length) { chip('deriv', 'bad', 'No account'); return say('c-d-out', 'Deriv accepted the token but returned no account.'); }
      }
      ld.dAccts.sort((x, y) => (y.demo ? 1 : 0) - (x.demo ? 1 : 0));
      $('c-dacc').innerHTML = ld.dAccts.map(a => `<option value="${a.id}">${a.demo ? 'DEMO' : 'REAL'} ${a.id}</option>`).join('');
      await dPick(ld.dAccts[0].id);
    } catch (e) {
      chip('deriv', 'bad', 'Failed');
      const hint = kind === 'pat' ? (app === '1089' ? '\nYour App ID is 1089, the old shared test ID. A pat_ token normally needs an App ID you registered at developers.deriv.com.' : '\nCheck the App ID is registered at developers.deriv.com and the token was created with trade scope.') : '\nOld-style token: it must be created for the same App ID you entered (1089 works for tokens made under 1089).';
      say('c-d-out', '✖ ' + e.message + hint + '\nTap Diagnose for a step-by-step test.');
    }
  }
  async function dDiagnose() {
    const tok = $('c-dtok').value.trim() || ld.dTok, kind = dKind(tok), app = $('c-dapp').value.trim() || ld.dApp || (kind === 'legacy' ? '1089' : ''), L = [];
    const log = (ok, t) => { L.push((ok === null ? '…' : ok ? '✔' : '✖') + ' ' + t); say('c-d-out', L.join('\n')); };
    if (!tok) return say('c-d-out', 'Paste your token first, then tap Diagnose.');
    log(null, 'Checking your internet…');
    try { const r = await tfetch('https://api.binance.com/api/v3/ping', {}, 8000); L.pop(); log(r.ok, r.ok ? 'Internet works' : 'Internet check returned HTTP ' + r.status); } catch (e) { L.pop(); return log(false, 'No internet from this app (' + e.message + '). Fix this first.'); }
    log(true, `Token type: ${kind === 'pat' ? 'new PAT (pat_…) → REST + one-time socket' : 'old token → direct socket authorize'}`);
    if (kind === 'pat') {
      log(!!app && app !== '1089', app ? (app === '1089' ? 'App ID is 1089 (old shared ID). New tokens usually need your own registered App ID.' : 'App ID: ' + app) : 'No App ID entered.'); if (!app) return;
      ld.dTok = tok; ld.dApp = app;
      let accts; try { log(null, 'Asking api.derivws.com for your accounts…'); const j = await dRest('GET', '/trading/v1/options/accounts'); accts = Array.isArray(j.data) ? j.data : (j.data && (j.data.accounts || j.data.items)) || []; L.pop(); log(true, `Token accepted, ${accts.length} account(s) found`); } catch (e) { L.pop(); return log(false, e.message); }
      if (!accts.length) return log(false, 'No accounts returned.');
      const a = accts.find(x => x.account_type === 'demo') || accts[0], id = a.account_id || a.loginid || a.id;
      try { log(null, `Requesting socket address for ${id}…`); const o = await dRest('POST', `/trading/v1/options/accounts/${id}/otp`); L.pop(); log(!!(o.data && o.data.url), o.data && o.data.url ? 'Got one-time socket address' : 'No socket address in reply'); if (!(o.data && o.data.url)) return;
        log(null, 'Opening socket…'); const w = await dOpen(o.data.url, false); const b = await rawSend(w, { balance: 1 }); L.pop(); log(true, `Socket open · balance ${b.balance.balance} ${b.balance.currency}`); w.close(); log(true, 'All steps passed. Tap Connect.'); } catch (e) { L.pop(); log(false, e.message); }
    } else {
      try { log(null, 'Opening ws.derivws.com and authorizing…'); const w = await dOpen('wss://ws.derivws.com/websockets/v3?app_id=' + encodeURIComponent(app), true); L.pop(); log(true, `Authorized ${dAuth.loginid} (${dAuth.is_virtual ? 'DEMO' : 'REAL'})`); w.close(); log(true, 'All steps passed. Tap Connect.'); } catch (e) { L.pop(); log(false, e.message + ' (App ID ' + app + ')'); }
    }
  }
  function showD() { const a = ld.dAcct; if (!a) return; say('c-d-out', `✔ ${a.demo ? 'DEMO' : 'REAL'} account ${a.id}\nBalance: ${a.bal} ${a.cur}\nToken ${mask(ld.dTok)} · App ${ld.dApp} · ${dKind(ld.dTok) === 'pat' ? 'new API' : 'classic API'}`); $('c-d-tag').textContent = a.demo ? 'DEMO' : 'REAL'; $('c-d-tag').className = 'tag ' + (a.demo ? 'ok' : 'bad'); chip('deriv', a.demo ? 'ok' : 'live', `${a.demo ? 'Demo' : 'Real'} · ${a.bal} ${a.cur}`); }
  let prop = null;
  const dReq = () => { const r = { proposal: 1, amount: +$('c-dst').value, basis: 'stake', contract_type: $('c-dty').value, currency: (ld.dAcct || {}).cur || 'USD', duration: +$('c-ddu').value, duration_unit: $('c-dun').value }; r[dKind(ld.dTok) === 'legacy' ? 'symbol' : 'underlying_symbol'] = $('c-dsy').value.trim(); return r; };
  async function dQuote() {
    if (!ld.dAcct) return say('c-d-trade', 'Connect Deriv first.'); say('c-d-trade', 'Getting price…');
    try {
      let p; try { p = await dSend(dReq()); } catch (e) { if (!/underlying_symbol|symbol/i.test(e.message)) throw e; const r = dReq(); if (r.underlying_symbol) { r.symbol = r.underlying_symbol; delete r.underlying_symbol; } else { r.underlying_symbol = r.symbol; delete r.symbol; } p = await dSend(r); }
      prop = p.proposal; say('c-d-trade', `${$('c-dty').value} ${$('c-dsy').value}\n${prop.longcode}\nCost ${prop.ask_price} · payout ${prop.payout}\nTap Sign to buy.`); $('c-dsign').disabled = false;
    } catch (e) { prop = null; $('c-dsign').disabled = true; say('c-d-trade', '✖ ' + e.message); }
  }
  async function dSign() {
    if (!prop) return; const a = ld.dAcct;
    if (!a.demo && !confirm(`REAL account ${a.id}. Spend ${prop.ask_price} ${a.cur}?`)) return;
    $('c-dsign').disabled = true; say('c-d-trade', 'Signing… do not tap again.');
    try { const b = await dSend({ buy: prop.id, price: prop.ask_price }), z = b.buy; say('c-d-trade', `✔ Bought contract ${z.contract_id}\nCost ${z.buy_price} · payout ${z.payout}\nBalance now ${z.balance_after}`); a.bal = z.balance_after; save(); showD(); ctx.hist('Deriv ' + (a.demo ? 'DEMO' : 'REAL') + ' contract ' + z.contract_id); }
    catch (e) { say('c-d-trade', '✖ ' + e.message + '\nCheck Deriv before retrying.'); } prop = null;
  }

  /* ---------- Binance spot ---------- */
  const bBase = () => ld.bTest ? 'https://testnet.binance.vision' : 'https://api.binance.com';
  let off = 0;
  const bHint = (msg, status, code) => {
    const ip = (/request ip:\s*([0-9a-f:.]+)/i.exec(msg || '') || [])[1];
    if (code === -2015 || /invalid api-key|permissions for action/i.test(msg || '')) return `Binance rejected this key. Check in this order:\n1) Account box: Testnet keys only work on Testnet and real keys only on Live (now: ${ld.bTest ? 'Testnet' : 'Live'}).\n2) IP restriction: if the key is limited to trusted IPs, the phone's current address must be on the list${ip ? ' (Binance saw ' + ip + ')' : ''}. Phone addresses change all the time, so for a phone choose "Unrestricted" with trade-only permission, or run the app from a server with a fixed IP.\n3) "Enable Reading" must be ticked on the key.\n4) Paste the whole key with no spaces.`;
    if (code === -1022 || /signature/i.test(msg || '')) return 'The Secret does not match this API key, or it has stray characters. Copy the Secret again (it is shown only once when the key is created).';
    if (code === -1021 || /timestamp/i.test(msg || '')) return 'The phone clock is out of sync. Turn on automatic date and time.';
    if (code === -2014 || /api-key format/i.test(msg || '')) return 'The API key format is wrong. Paste only the key (normally 64 characters).';
    if (status === 451 || /restricted location|eligibility/i.test(msg || '')) return 'Binance blocks this country or network. Try with the VPN switched on or off, or use Testnet.';
    if ([403, 418, 429].includes(status)) return `Binance has temporarily blocked this network (HTTP ${status}). Wait a few minutes and switch off any VPN.`;
    if (/failed to fetch|network|timed out|load failed|secure/i.test(msg || '')) return 'The app cannot reach Binance. Check the internet and VPN.' + (ld.bTest ? ' The Testnet site is sometimes slow or down.' : '');
    return '';
  };
  async function bCall(method, path, params) {
    const q = new URLSearchParams({ ...params, recvWindow: 10000, timestamp: Date.now() + off }).toString(), sg = await hmacHex(ld.bSec, q);
    let r; try { r = await tfetch(`${bBase()}${path}?${q}&signature=${sg}`, { method, headers: { 'X-MBX-APIKEY': ld.bKey } }, 15000); } catch (e) { throw new Error(e.message); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.msg || 'Binance HTTP ' + r.status); e.status = r.status; e.code = j.code; throw e; }
    return j;
  }
  async function bConnect() {
    const k = clean($('c-bk').value) || ld.bKey, s = clean($('c-bs').value) || ld.bSec; if (!k || !s) return say('c-b-out', 'Paste both the key and the secret.');
    ld.bKey = k; ld.bSec = s; ld.bTest = $('c-bm').value === 'test'; $('c-bk').value = k; $('c-bs').value = s; say('c-b-out', 'Connecting…'); chip('binance', 'warn', 'Connecting…');
    try {
      const t = await (await tfetch(bBase() + '/api/v3/time', {}, 10000)).json(); off = t.serverTime - Date.now();
      const a = await bCall('GET', '/api/v3/account', {}), bal = a.balances.filter(x => +x.free > 0 || +x.locked > 0).slice(0, 8).map(x => `${x.asset} ${(+x.free).toFixed(6)}`);
      ld.bOk = true; save(); say('c-b-out', `✔ Binance ${ld.bTest ? 'TESTNET (demo)' : 'LIVE (real)'} · trading ${a.canTrade ? 'allowed' : 'NOT allowed'}\n${bal.join('\n') || 'No balances'}\nKey ${mask(k)}`);
      $('c-b-tag').textContent = ld.bTest ? 'DEMO' : 'REAL'; $('c-b-tag').className = 'tag ' + (ld.bTest ? 'ok' : 'bad'); chip('binance', ld.bTest ? 'ok' : 'live', ld.bTest ? 'Testnet' : 'Live');
    } catch (e) {
      ld.bOk = false; save(); chip('binance', 'bad', 'Failed'); const h = bHint(e.message, e.status, e.code);
      say('c-b-out', '✖ ' + e.message + (h ? '\n\n' + h : '') + '\n\nTap Diagnose for a step-by-step test.');
    }
  }
  async function bDiagnose() {
    const k = clean($('c-bk').value) || ld.bKey, s = clean($('c-bs').value) || ld.bSec, L = [];
    const log = (ok, t) => { L.push((ok === null ? '…' : ok ? '✔' : '✖') + ' ' + t); say('c-b-out', L.join('\n')); };
    ld.bTest = $('c-bm').value === 'test'; log(true, `Mode: ${ld.bTest ? 'Testnet (demo keys from testnet.binance.vision)' : 'Live (real keys from binance.com)'}`);
    log(null, 'Reaching Binance…');
    try { const r = await tfetch(bBase() + '/api/v3/time', {}, 10000), t = await r.json(); if (!r.ok) { const e = new Error(t.msg || 'HTTP ' + r.status); e.status = r.status; throw e; } off = t.serverTime - Date.now(); L.pop(); log(true, `Binance reachable · phone clock is ${Math.round(Math.abs(off) / 1000)} s off`); }
    catch (e) { L.pop(); log(false, `Cannot reach ${bBase()}: ${e.message}`); const h = bHint(e.message, e.status, 0); if (h) log(false, h); return; }
    if (!k || !s) return log(false, 'Paste the API key and the Secret first, then tap Diagnose.');
    log(k.length === 64 && s.length === 64, `Key length ${k.length}, Secret length ${s.length} (Binance normally gives 64 and 64)`);
    ld.bKey = k; ld.bSec = s; log(null, 'Sending a signed read-only request…');
    try { const a = await bCall('GET', '/api/v3/account', {}); L.pop(); log(true, `Key accepted · trading ${a.canTrade ? 'allowed' : 'NOT allowed'}`); log(true, 'All steps passed. Tap Connect.'); }
    catch (e) {
      L.pop(); log(false, e.message); const h = bHint(e.message, e.status, e.code); if (h) log(false, h);
      if (e.code === -2015) {   // is the key simply for the other account type?
        const keep = ld.bTest; ld.bTest = !keep;
        try { await bCall('GET', '/api/v3/account', {}); log(true, `This key WORKS on ${ld.bTest ? 'Testnet' : 'Live'}. Change the Account box to ${ld.bTest ? 'Testnet (demo)' : 'Live (real)'} and tap Connect.`); } catch (x) { log(false, `It is not valid on ${ld.bTest ? 'Testnet' : 'Live'} either, so the problem is the key itself or its IP restriction.`); }
        ld.bTest = keep;
      }
    }
  }
  async function bOrder(side, symbol, amount, isQuote) {
    if (!ld.bOk) throw new Error('Connect Binance first.');
    if (!ld.bTest && !confirm(`LIVE Binance: ${side} ${symbol} ${amount}${isQuote ? ' USDT' : ''}?`)) throw new Error('Cancelled.');
    const p = { symbol, side, type: 'MARKET', newClientOrderId: 'TB' + Date.now().toString(36) }; p[isQuote ? 'quoteOrderQty' : 'quantity'] = amount;
    const o = await bCall('POST', '/api/v3/order', p); ctx.hist(`Binance ${ld.bTest ? 'TEST' : 'LIVE'} ${side} ${symbol} ${o.status} ${o.orderId}`); return o;
  }
  async function bManual(side) {
    const sym = $('c-bsy').value.trim().toUpperCase(), amt = $('c-bam').value.trim(); say('c-b-trade', 'Signing… do not tap again.');
    try { const o = await bOrder(side, sym, amt, side === 'BUY'); say('c-b-trade', `✔ ${o.status} · ${o.side} ${o.symbol}\nFilled ${o.executedQty} for ${o.cummulativeQuoteQty}\nNo stop-loss is attached. Watch this trade.`); bConnect(); }
    catch (e) { say('c-b-trade', '✖ ' + e.message); }
  }

  /* ---------- signal sign queue (called after each auto scan) ---------- */
  const aiNotes = new Map();     // signal key -> AI review text (or pending marker)
  const sigPrompt = c => `Signal ${c.signal} on ${c.symbol} ${c.tf || ''}, score ${c.score}. Evidence: ${(c.reasons || []).join('; ')}`;
  function aiReview(s, el) {
    if (ld.aiAuto === false || !hasAI()) return;
    const k = s.key, c = s.cand, box = document.createElement('pre'); box.className = 'out'; el.appendChild(box);
    if (aiNotes.has(k)) { box.textContent = aiNotes.get(k) || 'AI is reviewing this signal…'; return; }
    aiNotes.set(k, ''); box.textContent = 'AI is reviewing this signal…';
    const run = ld.aiMode === 'team' && keyCount() >= 2 ? teamRun(sigPrompt(c), k).then(r => r.text) : ask(sigPrompt(c));
    run.then(t => { aiNotes.set(k, t); }).catch(e => { aiNotes.set(k, 'AI review unavailable: ' + e.message); })
      .finally(() => { if (box.isConnected) box.textContent = aiNotes.get(k); });
  }
  /* Optional AI gate: the sign button stays locked until the AI team (both keys) says BUY. If the AIs disagree or are unavailable, no order is offered. */
  function aiGate(s, btn, el) {
    const note = document.createElement('p'); note.className = 'muted small'; el.appendChild(note); btn.disabled = true;
    if (!hasAI()) { btn.textContent = 'Blocked by AI gate'; note.textContent = 'AI gate is on but no AI key is set, so no order is offered.'; return; }
    btn.textContent = 'Waiting for the AI team…';
    teamRun(sigPrompt(s.cand), s.key).then(v => {
      if (sig !== s || !btn.isConnected) return;
      if (v.agree && v.verdict === 'BUY') { btn.disabled = false; btn.textContent = 'Sign this order'; note.textContent = 'AI gate: passed.'; }
      else { btn.textContent = 'Blocked by AI gate'; note.textContent = 'AI gate: ' + (v.verdict === 'BUY' ? 'not enough AIs answered' : 'team verdict is ' + v.verdict) + '. No order offered.'; }
    }).catch(e => { if (sig === s && btn.isConnected) { btn.textContent = 'Blocked by AI gate'; note.textContent = 'AI gate: AI unavailable (' + String(e.message).slice(0, 140) + '). No order offered.'; } });
  }
  function onScan(results) {
    const S = ctx.S(); if (!S.autoOn) return; const el = $('c-sig'); sig = null;
    const watch = results.filter(r => (r.signal === 'BUY') && ld.bOk).sort((a, b) => b.score - a.score);
    for (const cand of watch) {
      const g = TB.gates.evaluate({ cand, council: ctx.council(cand), S, symbol: cand.symbol, broker: 'binance', accountMode: 'demo', armed: true, runtime: rt });
      if (!g.ok) continue; sig = { cand, key: g.key }; break;
    }
    if (!sig) { el.innerHTML = '<div class="empty">No signal passes the gates right now.</div>'; return; }
    const c = sig.cand, h = TB.sizing.hybrid({ equity: S.now, riskPct: S.riskPct, stopDist: c.stopDist, price: c.price, manualCap: (+$('c-bam').value || 10) / c.price });
    if (!h.ok) { el.innerHTML = `<div class="empty">${c.symbol}: ${h.why}</div>`; sig = null; return; }
    sig.usdt = Math.floor(h.qty * c.price * 100) / 100;
    el.innerHTML = `<b>BUY ${c.symbol}</b> · score ${c.score}<p class="muted small">Spend ${sig.usdt} USDT · risk $${h.lossAtStop.toFixed(2)} at the stop (${c.stopDist.toFixed(4)}). ${ld.bTest ? 'TESTNET' : 'LIVE'}</p><button id="c-sigb" class="btn primary">Sign this order</button>`;
    aiReview(sig, el);
    if (ld.aiGate) aiGate(sig, $('c-sigb'), el);
    $('c-sigb').onclick = async () => { const s = sig; if (!s || $('c-sigb').disabled) return; rt.seen.add(s.key); rt.last[s.cand.symbol] = Date.now(); rt.orders++; $('c-sigb').disabled = true;
      try { const o = await bOrder('BUY', s.cand.symbol, s.usdt, true); el.textContent = `✔ ${o.status} ${o.symbol} ${o.executedQty}`; bConnect(); } catch (e) { el.textContent = '✖ ' + e.message; } };
  }

  /* ---------- UI ---------- */
  const F = (id, label, extra = '') => `<label>${label}<input id="${id}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" ${extra}></label>`;
  const KEYICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/></svg>';
  function build() {
    const sec = document.createElement('section'); sec.id = 'view-connect'; sec.className = 'view';
    sec.innerHTML = `<div class="page-head"><div><div class="eyebrow">In-app</div><h1>Connect</h1><p class="muted">Paste a key, tap Connect, see the balance. Demo and real are labelled. Orders need your tap to sign.</p></div></div>
<div class="card form"><div class="card-title"><div><div class="eyebrow">AI · up to two keys</div><h3>AI keys (Gemini, Groq, Grok…)</h3></div><span class="tag">Team or failover</span></div>
<p class="muted small">Use any mix: Gemini (AIza… or the new AQ.…), Groq (gsk_…), Grok (xai-…) or OpenAI (sk-…). Failover switches to the second key when the first is limited. Team mode makes both AIs answer together and only trusts a BUY or SELL when they agree. Pasted keys now stay in the boxes.</p>
<div class="fields">${F('c-ai', 'Primary key (auto-detected)', 'type="password"')}<label>Primary model<select id="c-ai-model"></select></label></div>
<div class="row"><button id="c-ai-go" class="btn primary">Test primary</button></div><pre id="c-ai-out" class="out">Not connected.</pre>
<div class="fields">${F('c-ai2', 'Second key (optional, e.g. Gemini AIza… or AQ.…)', 'type="password"')}<label>Backup model<select id="c-ai2-model"></select></label></div>
<div class="row"><button id="c-ai2-go" class="btn primary">Test backup</button></div><pre id="c-ai2-out" class="out">Not connected.</pre>
<div class="fields"><label>Key use<select id="c-ai-mode"><option value="failover">Primary first, backup when limited</option><option value="balance">Share the load across both keys</option><option value="team">Team: both AIs answer together</option></select></label>
<label class="check"><input id="c-ai-gate" type="checkbox"> AI gate: only offer a BUY to sign when the AI team agrees</label>
<label class="check"><input id="c-ai-auto" type="checkbox"> AI reviews every signal it finds</label></div>
<p class="muted small">The AIs advise and vote. They never place orders: the gates and your tap still decide every order.</p></div>
<div class="card form"><div class="card-title"><div><div class="eyebrow">Contracts</div><h3>Deriv</h3></div><span id="c-d-tag" class="tag">—</span></div><div class="fields">${F('c-dtok', 'Token (new pat_… or old token)', 'type="password"')}${F('c-dapp', 'App ID (new tokens: from developers.deriv.com)', 'inputmode="numeric"')}<label>Account<select id="c-dacc"></select></label></div>
<div class="row"><button id="c-d-go" class="btn primary">Connect</button><button id="c-d-diag" class="btn">Diagnose</button></div><pre id="c-d-out" class="out">Not connected.</pre>
<div class="fields">${F('c-dsy', 'Symbol', 'value="R_100"')}<label>Type<select id="c-dty"><option value="CALL">CALL (up)</option><option value="PUT">PUT (down)</option></select></label>${F('c-dst', 'Stake', 'type="number" value="1" min="0.35" step="0.01"')}${F('c-ddu', 'Duration', 'type="number" value="5" min="1"')}<label>Unit<select id="c-dun"><option value="t">ticks</option><option value="m">minutes</option></select></label></div>
<div class="row"><button id="c-dq" class="btn">Get price</button><button id="c-dsign" class="btn primary" disabled>Sign contract</button></div><pre id="c-d-trade" class="out"></pre></div>
<div class="card form"><div class="card-title"><div><div class="eyebrow">Spot</div><h3>Binance</h3></div><span id="c-b-tag" class="tag">—</span></div><div class="fields">${F('c-bk', 'API key', 'type="password"')}${F('c-bs', 'Secret', 'type="password"')}<label>Account<select id="c-bm"><option value="test">Testnet (demo)</option><option value="live">Live (real)</option></select></label></div>
<div class="row"><button id="c-b-go" class="btn primary">Connect</button><button id="c-b-diag" class="btn">Diagnose</button></div><pre id="c-b-out" class="out">Not connected.</pre>
<div class="fields">${F('c-bsy', 'Symbol', 'value="BTCUSDT"')}${F('c-bam', 'BUY: USDT to spend · SELL: coin quantity', 'type="number" value="10" step="any"')}</div>
<div class="row"><button id="c-bb" class="btn primary">Sign BUY</button><button id="c-bsl" class="btn danger">Sign SELL</button></div><pre id="c-b-trade" class="out"></pre>
<div class="card-title"><div><div class="eyebrow">From the Auto scanner</div><h3>Signal to sign</h3></div></div><div id="c-sig"><div class="empty">Start Auto (with Binance connected) to see signals.</div></div></div>
<div class="card form"><label class="check"><input id="c-show" type="checkbox"> Show keys while typing</label><label class="check"><input id="c-rem" type="checkbox"> Remember keys on this phone</label><p class="muted small">Stored unencrypted in this app's storage. Never uploaded. Untick to wipe. Use trade-only keys with NO withdrawal permission.</p><div class="row"><button id="c-wipe" class="btn danger">Forget all keys</button></div></div>`;
    document.querySelector('main').insertBefore(sec, document.querySelector('footer'));
    const b = document.createElement('button'); b.dataset.view = 'connect'; b.innerHTML = `<b>${KEYICON}</b>Connect`; const tb = document.getElementById('more-list') || document.getElementById('tabbar'); tb.appendChild(b);
    const open = () => { if (TB.nav) return TB.nav.go('connect'); document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-connect')); window.scrollTo({ top: 0 }); };
    b.onclick = open;
    const card = document.createElement('div'); card.className = 'card cta'; card.innerHTML = `<div><b>Keys &amp; balance</b><p class="muted small">Deriv, Binance and the AI keys connect here · build v7.1</p></div><button id="c-go" class="btn primary">Open Connect</button>`; document.getElementById('view-scan').prepend(card); $('c-go').onclick = open;
    document.querySelectorAll('#conn-strip .chip').forEach(c => { c.onclick = open; });
    $('c-rem').checked = !!ld.remember; $('c-bm').value = ld.bTest === false ? 'live' : 'test'; $('c-ai-mode').value = ld.aiMode || 'failover'; $('c-ai-auto').checked = ld.aiAuto !== false;
    $('c-ai-go').onclick = () => aiTest(1); $('c-ai2-go').onclick = () => aiTest(2); $('c-d-go').onclick = dConnect; $('c-d-diag').onclick = dDiagnose; $('c-dacc').onchange = e => dPick(e.target.value).catch(x => say('c-d-out', '✖ ' + x.message)); $('c-dq').onclick = dQuote; $('c-dsign').onclick = dSign;
    $('c-ai-model').onchange = e => { ld.aiModel = e.target.value; save(); }; $('c-ai2-model').onchange = e => { ld.ai2Model = e.target.value; save(); };
    $('c-ai-mode').onchange = e => { ld.aiMode = e.target.value; save(); }; $('c-ai-auto').onchange = e => { ld.aiAuto = e.target.checked; save(); };
    $('c-ai-gate').checked = !!ld.aiGate; $('c-ai-gate').onchange = e => { ld.aiGate = e.target.checked; save(); };
    [['c-ai', ld.ai], ['c-ai2', ld.ai2], ['c-dtok', ld.dTok], ['c-bk', ld.bKey], ['c-bs', ld.bSec]].forEach(([id, v]) => { if (v) $(id).value = v; });   // saved keys stay visible (as dots)
    $('c-show').onchange = e => ['c-ai', 'c-ai2', 'c-dtok', 'c-bk', 'c-bs'].forEach(id => { $(id).type = e.target.checked ? 'text' : 'password'; });
    $('c-b-go').onclick = bConnect; $('c-b-diag').onclick = bDiagnose; $('c-bb').onclick = () => bManual('BUY'); $('c-bsl').onclick = () => bManual('SELL');
    $('c-rem').onchange = e => { ld.remember = e.target.checked; save(); };
    $('c-wipe').onclick = () => { ld = {}; try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); };
    [1, 2].forEach(n => { const s = slot(n); if (s.model) $(AIS[n].model).innerHTML = `<option>${s.model}</option>`; });
    aiShow(); aiStrip();
    [1, 2].forEach(n => { const q = slot(n); if (q.key && !q.alts.length) refreshModels(n).then(() => aiShow()).catch(() => {}); });   // old saves: replace a bad model and add backups
    if (ld.dAcct) { $('c-dacc').innerHTML = (ld.dAccts || []).map(a => `<option value="${a.id}"${a.id === ld.dAcct.id ? ' selected' : ''}>${a.demo ? 'DEMO' : 'REAL'} ${a.id}</option>`).join(''); if (ld.dApp) $('c-dapp').value = ld.dApp; showD(); chip('deriv', 'warn', 'Saved · tap to refresh'); }
    if (ld.bOk) { say('c-b-out', 'Saved key ' + mask(ld.bKey) + '. Tap Connect to refresh the balance.'); chip('binance', 'warn', 'Saved · tap to refresh'); }
  }
  function init(c) { ctx = c; ctx.hist = c.hist || (() => {}); build(); }
  window.TB = window.TB || {}; window.TB.live = { init, onScan, ask, askJson: (p, sy) => askFailover(p, sy), hasAI, binance: { ready: () => !!ld.bOk, isTest: () => !!ld.bTest, base: () => bBase(), call: (m, p, q) => bCall(m, p, q), pub: async p => { const r = await tfetch(bBase() + p, {}, 15000), j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.msg || 'Binance HTTP ' + r.status); return j; } }, _t: { aiTest, setLd: v => { ld = v; }, rankModels, callSlot, teamRun, hmacHex, verdictOf, clean, bHint } };
})();
