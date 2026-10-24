const assert = require('assert'); const { hybrid } = require('../js/sizing.js');
let r = hybrid({ equity: 100, riskPct: 1, stopDist: 0.5, price: 10, manualCap: 5 });
assert(r.ok && r.qty === 2 && Math.abs(r.lossAtStop - 1) < 1e-9, 'risk-based size');
r = hybrid({ equity: 100, riskPct: 1, stopDist: 0.1, price: 10, manualCap: 5 }); assert(r.qty === 5, 'manual cap wins');
r = hybrid({ equity: 10, riskPct: 5, stopDist: 1, price: 100, manualCap: 5 }); assert(r.qty === 0.1, 'cannot exceed equity');
assert(!hybrid({ equity: 100, riskPct: 1, stopDist: 0, price: 10, manualCap: 5 }).ok, 'no stop rejected');
assert(!hybrid({ equity: 0, riskPct: 1, stopDist: 1, price: 10, manualCap: 5 }).ok, 'no equity rejected');
console.log('sizing tests passed');
