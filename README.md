# TradeBrain (web)

Mobile-first market scanner with a Traders Council and a guarded broker console. Static front end (no build step) plus an optional local Python backend for broker orders and Grok.

## What it does
- **Scanner**: EMA 9/21, RSI, MACD, volume and a "jitter" (directional efficiency) filter on **closed** Binance candles.
- **Council**: four voters (Trend, Momentum, Breakout, Noise) and two gates (Risk, Execution), computed from candles.
- **Auto scanner**: repeats the scan; NORMAL / A+ / MAD modes; re-entry cooldown; balance-based kill switch.
- **Broker**: Binance Spot, Deriv, MT5 through the local backend. Auto trade is off every session until you switch it on.
- **Lab, History, Risk & mission, Markets**: notes, audit trail, limits, watchlist.

## Run locally
```
npm test            # logic tests, no dependencies
npm run serve       # then open http://localhost:8000
```
Backend (only needed for broker orders / Grok): see `backend/README.md`.

## Safety defaults
Auto trade and "allow on LIVE" are never saved. Live arming needs the exact phrase. Binance Spot SELL is blocked (spot cannot short). Binance entries have no automatic stop-loss. Keys live in the backend's memory only and are never written to browser storage.

## Build the Android app (GitHub Actions)
`bash push.sh` in Termux pushes this folder and starts two workflows: **Deploy TradeBrain web** (GitHub Pages) and **Build Android APK** (Capacitor, debug APK). The APK appears under the repo's **Releases** page in about 5-8 minutes. Install it from your phone; allow "install unknown apps" for your browser.

The app talks to the backend at `http://127.0.0.1:8001`, so run the backend in Termux (`backend/README.md`) while using the broker console. Auto orders on Binance use hybrid sizing: risk % of balance / stop distance, capped by the size in the order box.
