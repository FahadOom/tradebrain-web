const assert = require('assert');
const g = require('../js/gates.js');
const store = require('../js/store.js');
const base = { mode: 'normal', autoScore: 75, autoMax: 3, autoLive: false, reentry: 'fresh', start: 10, now: 10, goal: 30, lossPct: 10, action: 'pause' };
const cand = { symbol: 'BTCUSDT', tf: '15m', signal: 'BUY', score: 100, time: 1, why: 'ok' };
const council = { verdict: 'BUY', agree: 3, gatesOk: true, gates: [] };
const mk = o => ({ cand, council, S: base, symbol: 'BTCUSDT', broker: 'binance', accountMode: 'demo', armed: true, runtime: { seen: new Set(), last: {}, orders: 0 }, ...o });

assert.ok(g.evaluate(mk({})).ok, 'happy path passes');
assert.ok(!g.evaluate(mk({ armed: false })).ok, 'must be armed');
assert.ok(!g.evaluate(mk({ accountMode: 'live' })).ok, 'live needs explicit opt-in');
assert.ok(g.evaluate(mk({ accountMode: 'live', S: { ...base, autoLive: true } })).ok);
assert.ok(!g.evaluate(mk({ cand: { ...cand, signal: 'SELL' } })).ok, 'binance spot cannot short');
assert.ok(!g.evaluate(mk({ cand: { ...cand, score: 60 } })).ok, 'score threshold');
assert.ok(!g.evaluate(mk({ council: { ...council, verdict: 'SELL' } })).ok, 'council opposing blocks');
assert.ok(!g.evaluate(mk({ council: { ...council, gatesOk: false, gates: [{ name: 'Risk', verdict: 'BLOCK' }] } })).ok, 'gates block in normal mode');
assert.ok(g.evaluate(mk({ S: { ...base, mode: 'mad' }, council: { ...council, gatesOk: false, verdict: 'SELL', gates: [] } })).ok, 'mad mode ignores council');
assert.ok(!g.evaluate(mk({ S: { ...base, mode: 'aplus' }, council: { ...council, agree: 2 } })).ok, 'A+ needs 3 voters');
assert.ok(!g.evaluate(mk({ S: { ...base, now: 9 } })).ok, 'kill switch at loss limit');
assert.ok(!g.evaluate(mk({ S: { ...base, now: 30 } })).ok, 'kill switch at target');
assert.ok(!g.evaluate(mk({ runtime: { seen: new Set(), last: {}, orders: 3 } })).ok, 'session cap');
const r1 = g.evaluate(mk({})); const seen = new Set([r1.key]);
assert.ok(!g.evaluate(mk({ runtime: { seen, last: {}, orders: 0 } })).ok, 'one order per candle');
assert.ok(!g.evaluate(mk({ S: { ...base, reentry: 'cooldown' }, runtime: { seen: new Set(), last: { BTCUSDT: Date.now() }, orders: 0 } })).ok, 'cooldown');

// store
const c = store.clean({ riskPct: 99, interval: 1, mode: 'x', watch: ['btcusdt', '<script>'], backendUrl: 'javascript:alert(1)' });
assert.strictEqual(c.riskPct, 5); assert.strictEqual(c.interval, 15); assert.strictEqual(c.mode, 'normal');
assert.deepStrictEqual(c.watch, ['BTCUSDT']); assert.strictEqual(c.backendUrl, 'http://127.0.0.1:8001');
const m = store.migrate({ settings: { balance: 12, riskPercent: 2 }, strategies: [{ name: 'A', lessons: [{ title: 'l', content: 'c' }], journal: [{ symbol: 'BTC', notes: 'n' }] }], signalHistory: [] }, { mode: 'madbot', enabledMarkets: ['ETHUSDT'] });
assert.strictEqual(m.settings.mode, 'mad'); assert.strictEqual(m.strategies[0].notes.length, 2);
const mem = (() => { const d = {}; return { getItem: k => d[k] ?? null, setItem: (k, v) => { d[k] = v; } }; })();
const st = store.load(mem); assert.ok(st.strategies.length >= 3);
st.settings.autoOn = true; store.save(mem, st); assert.ok(!mem.getItem('tradebrain:v1').includes('autoOn'), 'autoOn never persisted');
assert.throws(() => store.parseBackup('{"x":1}'), /not a TradeBrain/);
console.log('gates + store tests passed');
