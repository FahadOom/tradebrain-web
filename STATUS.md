# AI BRAIN ULTIMATE (v9.0) · status, tests and limits

## What changed in v9
* **Broker-gated markets.** No broker connected = no markets, charts, signals or auto trading (like a terminal that is not logged in). Deriv connected → Deriv; only Binance → Binance; both → Deriv (unless you pick Binance on the Auto screen, or the Binance executor is active, because Binance cannot trade Deriv symbols). Closed/suspended Deriv markets are marked and skipped. Deriv candles have no volume; the volume tests are ignored for them instead of blocking everything.
* **Binance Demo Trading** (demo.binance.com keys → `demo-api.binance.com`) is a separate option from Spot Testnet and Live. Diagnose tells you which environment a key belongs to. Saved keys reconnect at start-up.
* **Scalp trigger.** NORMAL: the main strategy must see the trade AND ≥2 Council traders agree, then the AI must approve, then the risk engine. MADBOT: main strategy + 1 trader, or 2 traders alone.
* **A+ = long-term.** Own timeframe (default 1h), TP1 + TP2, stop to break-even at TP1, hold up to 3 days. The AI re-checks every open A+ trade each candle: it can exit before TP1, tighten the stop, and after TP1 any sign of reversal closes the trade.
* **AI controls size and entries.** The AI proposes a size factor (can only reduce risk) and how many entries a market deserves; the risk engine and your manual cap still have the last word. Manual size mode ignores the AI.
* **MADBOT scout.** Sweeps the broker's open markets, the AI picks the most promising for scalping; if the AI is down the backup analyst (rule-based) keeps scalping, with looser (but still hard) portfolio limits.
* **Overview** shows each broker's balance, paper account and an editable Goal (start / target / deadline). No hidden 10 → 30 any more; the start follows the traded account until you set a goal.
* **Signals tab** (Watch / Ready / Buys / Sells / A+), **Tests tab** (1h, 4h, 7-day A+ replays), Council without charts, Charts drawn by the main strategy with its lines.
* **Deriv execution** through multiplier contracts (stop-loss/take-profit held by Deriv).
* **Background running** (APK): foreground service + wake lock; timers come from a Web Worker.

## What is verified and what is not
| Item | Status |
|---|---|
| Engine, risk, controller, AI supervision, scout, backtest, data layer | Unit tested (`npm test`, ~350 assertions) with mocks |
| Whole app in headless Chrome against a **simulated** Deriv socket | Passed: markets, scan, signals, charts, council, tests, Overview |
| Deriv multiplier orders | Written against Deriv's documented messages, tested on a **mock** only. Never placed on the real Deriv. Try the DEMO account with small stakes first. Markets without multipliers are refused with a reason |
| Binance Demo Trading | Endpoint added; not tested with your keys from here |
| AI replies | Tested with mock AI only |
| Android foreground service | Written but **not compiled here**. The workflow builds with it and falls back to a plain APK if it fails to compile |
| Profitability | Nothing shows an edge. Replays describe the past only. Run on demo for weeks |

## Limits
* Android may still stop apps aggressively: allow "Unrestricted" battery for the app. iPhones/browsers cannot trade in the background.
* Deriv stop moves (break-even/trailing) are enforced by the app while it runs; the server-side stop stays at the original level as a backstop.
* No partial closes, no Futures, no WebSockets for Binance.
