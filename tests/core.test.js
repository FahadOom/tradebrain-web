const assert = require('assert');
const ind = require('../js/indicators.js');
const sc = require('../js/scanner.js');
const council = require('../js/council.js');
const S = { jitterOn: true, volumeOn: true, minEff: 0.25, minRR: 1.5, councilMin: 2 };

function series(n, f, vol = () => 100) {
  return Array.from({ length: n }, (_, i) => { const c = f(i); return { t: Date.now() - (n - i) * 9e5, o: c, h: c * 1.002, l: c * 0.998, c, v: vol(i) }; });
}

// indicators
assert.strictEqual(ind.rsi(Array.from({ length: 40 }, (_, i) => i + 1)), 100, 'pure uptrend RSI = 100');
assert.ok(ind.rsi(Array.from({ length: 40 }, (_, i) => 100 - i)) < 1, 'pure downtrend RSI ~ 0');
assert.ok(Math.abs(ind.ema([1, 2, 3, 4, 5], 3).at(-1) - 4) < 1e-9, 'EMA3 of 1..5 = 4');
const up = series(100, i => 100 + i * 0.4, i => 100 + i);
assert.ok(ind.efficiency(up) > 0.95, 'straight line efficiency ~1');
const chop = series(100, i => 100 + (i % 2 ? 0.5 : -0.5));
assert.ok(ind.efficiency(chop) < 0.2, 'zig-zag efficiency low');
assert.ok(ind.channel(up, 20).high < up.at(-1).h, 'breakout channel excludes latest candle');

// scanner
const a = sc.analyse('TESTUSDT', '15m', up, S);
assert.strictEqual(a.trend, 'Bullish');
assert.ok(a.score <= 100 && a.score >= 0);
assert.strictEqual(sc.analyse('CHOP', '15m', chop, S).signal, 'WAIT', 'chop must be filtered');

// a falling, high-volume series should be able to produce a SELL
const down = series(100, i => 200 - i * 0.6 + (i % 3) * 0.05, i => 100 + i);
const d = sc.analyse('DOWN', '15m', down, S);
assert.strictEqual(d.trend, 'Bearish');

// council
const r = council.review({ ...a, signal: a.signal, time: Date.now() }, S, 9e5);
assert.ok(['BUY', 'WAIT'].includes(r.verdict));
assert.strictEqual(r.voters.length, 4);
assert.strictEqual(r.gates.length, 2);
const blocked = council.review({ ...a, atr: null, stopDist: null, time: Date.now() }, S, 9e5);
assert.strictEqual(blocked.verdict, 'WAIT', 'risk gate blocks when ATR is missing');
const stale = council.review({ ...a, time: Date.now() - 9e5 * 10 }, S, 9e5);
assert.strictEqual(stale.verdict, 'WAIT', 'execution gate blocks stale data');

console.log('core tests passed');
