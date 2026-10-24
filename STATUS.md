# AI BRAIN ULTIMATE (v8.0) · status, tests and limits

## What you have
A static PWA/Android app (no server needed) that scans Binance candles, runs 8 strategies, convenes an extended Traders Council, asks your AI key(s) for a schema-validated decision, passes everything through an independent risk engine, and can trade automatically (Paper by default, Binance Spot Testnet/Live when connected).

## Honest findings about the files you sent
* `TradeBrain__19_.apk` and the `.sh` contain the SAME web build (identical JS). **Neither contains any chart code**, so the charts were built from scratch here (candles, EMA lines, channels, Bollinger, S/R, order blocks, FVG, trendlines, long/short boxes, RSI/MACD/volume pane). If an older build had charts, it was not in these files.
* The original AI Brain source / "original Council" was not supplied. The Council in these files is a rule-based reconstruction (Trend, Momentum, Breakout, Noise voters; Risk, Execution gates). It is kept **unchanged** (`js/council.js`, shown under "Original Council") and extended, not replaced.

## Feature status
| Feature | Status |
|---|---|
| Candle charts, overlays, per-member Council charts (9 voters + 4 gates, each with own chart) | Implemented, rendered in headless Chrome at phone size |
| 8 strategies + regime + A+ checklist | Implemented, unit tested on synthetic data only |
| Extended Council (family voting, weights, regime fit, portfolio gate) | Implemented, tested |
| AI Brain (structured packet, JSON schema validation, cache, rate limit, policy Required/Advisory/Off) | Implemented, tested with a **mock** AI. Not tested with a real Grok/Gemini key |
| Independent risk engine (22 checks), Hybrid/AI/Manual sizing | Implemented, tested |
| Continuous controller (scan > decide > order > manage > exit > journal > rescan), MADBOT/NORMAL/A+ | Implemented, tested end-to-end on **paper** |
| Paper execution (live prices, fees, slippage) | Implemented, tested |
| Binance Spot execution (exchange filters, step rounding, fees, reconcile, uncertain-order handling) | Implemented, tested against a **mock API only**. Not tested on Testnet or Live. Test on Testnet first |
| Mission Control statuses, target/deadline/daily-loss halts | Implemented, tested |
| Journal with rationale, council, AI, risk checks, post-trade review; JSON export | Implemented |
| Deriv, Exness/MT5 auto-execution | **Not wired** to the controller. Manual consoles from v7 still work. MT5 needs the Windows backend |
| Binance Futures, partial exits, WebSockets, backtesting module, Telegram, spread data | Not implemented |
| Two-key Grok routing | Uses the existing two-slot failover from Connect; no quota evasion |

## Limits you must know
* **It only trades while the app is open and online.** No server: closing the app or sleeping the phone stops scanning and exit-watching. Binance Spot exits (stop/target) are watched by the app, not placed on the exchange, so an open position is unprotected while the app is closed. Reliable 24/7 needs a host (e.g. the Python backend on a always-on machine); that part is not built.
* Binance Spot cannot short: SELL signals are ignored there. Paper mode can short (simulation).
* With about $10, Binance minimum order (~$5) and 0.1% fees per side, many 15m scalps fail the cost check (fees must be under half the target distance). That is the engine refusing trades whose fees would eat the edge, not a bug.
* Keys saved by Connect live in browser storage (v7 behaviour, your choice for no-VPS use). Use trade-only keys, never withdrawal rights.
* Your earlier 1h backtest showed no edge (about -0.12R). Nothing here has been shown to be profitable. Run Paper for weeks, read the journal, then Testnet, before any live money.
* Auto switches are never saved: every session starts with orders OFF, paper mode.

## Tests run
`npm test` : core, gates, sizing (original, still passing) + `tests/engine.test.js` (270 assertions: indicators, strategies, council, risk, AI validation, controller scenarios, mocked Binance). Scenarios covered: no opportunity, several opportunities, duplicate signal, win/loss exits, stop-vs-target same bar, gap fill, break-even/trail, time exit, target reached, deadline, daily loss, emergency stop, uncertain order (not repeated), restart mid-close, AI reject/approve/down, long-only broker.
Browser: loaded at 390px width with mocked Binance data, no console errors, no horizontal overflow, paper auto-trade opened positions. Not tested: real Binance, real AI, a physical Android device, Deriv/MT5.
