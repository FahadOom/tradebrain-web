# TradeBrain backend

This local FastAPI backend includes public Binance market discovery, server-side Grok coordination, and a guarded execution console for Binance Spot, Deriv contracts, and a locally installed MetaTrader 5 desktop terminal.

## Critical operating rules

- Run on your own computer bound to `127.0.0.1`; never expose this starter API directly to the internet. It has no user authentication and is not a production cloud service.
- Broker credentials submitted through the local console are held in process memory only and are cleared when the backend restarts. They are never written to localStorage or returned by the API. Use API keys with only the minimum permissions needed; do not enable withdrawals.
- Adding real credentials does **not** arm real trading. You must deliberately choose the account mode and use the separate live confirmation phrase `I UNDERSTAND LIVE TRADING`.
- Demo mode must use demo/test credentials. Binance mode chooses the Binance Spot Test Network (`testnet.binance.vision`) or live Spot API. Deriv's token account type is checked against the selected mode during authenticated requests. MT5 mode is read from the desktop terminal account.
- Binance order notional is capped by `MAX_BINANCE_ORDER_NOTIONAL` (default `10` in quote-asset units). The cap is not a loss guarantee. Binance Spot SELL sells existing assets; it does not open a short position. Binance Spot entry orders in this starter do not automatically attach a protective stop-loss/take-profit order.
- MT5 order submission requires a stop-loss and take-profit and validates volume step/min/max, current quote, account trading permission, and `order_check`. Install MetaTrader 5 desktop, log into the intended account, then install the Python module in a supported Windows Python environment: `pip install MetaTrader5`. Keep terminal and backend running while using it.
- Deriv order submission creates a fixed-duration CALL/PUT contract and checks a proposal price ceiling. CALL/PUT contracts are not equivalent to ordinary spot or forex positions. Contract expiry/settlement is managed by Deriv.
- An uncertain timeout is not proof that an order failed. Check broker order/transaction history before retrying.
- Disarming blocks new order submissions; it does not automatically close open positions or cancel pending orders.
- **Automatic signal-to-order routing is available from the browser while Continuous Scalping is running.** In Execution Engine, arm the selected account, enable Auto Trade, set a score threshold and session order cap, and ensure the scanner signal symbol exactly matches the execution symbol. Auto Trade is off by default and resets when the page is reloaded. The browser must remain open and awake. This version uses the Binance public-candle scanner as its signal source; it does not yet provide native Deriv or MT5 candle analysis, so do not map unrelated instruments (for example BTCUSDT signals to a synthetic index or XAUUSD). Binance Spot automatic orders are MARKET only; it does not short-sell and automatic protective exits are not implemented. MT5 automatic orders require matching symbol data and calculate initial SL/TP from scanner ATR distances; verify broker price units and stop-distance requirements in demo first. Deriv CALL/PUT contracts remain supported by the manual order console, but automatic execution is blocked in practice unless the signal source and contract symbol are genuinely equivalent.
- This project is not financial advice. Demo-test every adapter and edge case before considering live use.

## Run on Windows

1. Install Python 3.11 or newer.
2. Open Command Prompt in the `backend` folder.
3. Create and activate an environment:

   `python -m venv .venv`

   `.venv\\Scripts\\activate`

4. Install dependencies:

   `pip install -r requirements.txt`

5. Copy `.env.example` to `.env` and set Grok keys only in the private backend environment. Never commit `.env` to GitHub.
6. Start locally:

   `uvicorn app.main:app --host 127.0.0.1 --port 8001`

7. Serve the frontend separately on an origin listed in `CORS_ORIGINS`, or use the current localhost page setup. Do not bind the API to `0.0.0.0`.
8. Open the app's **Execution Engine** tab, choose a broker and account mode, connect, check the account, then arm demo mode before any demo order.

## Endpoints

- `GET /api/health`
- `GET /api/markets/binance`
- `POST /api/grok/coordinate`
- `GET /api/execution/status`
- `POST /api/execution/credentials`
- `POST /api/execution/arm`, `POST /api/execution/disarm`
- `GET /api/execution/binance/account`, `POST /api/execution/binance/order`
- `GET /api/execution/deriv/account`, `POST /api/execution/deriv/order`
- `GET /api/execution/mt5/account`, `POST /api/execution/mt5/order`

## Before live deployment

Add authentication/CSRF protections, a secret manager, audit logging, broker-side reconciliation, open-position monitoring, automatic protective exits for supported instruments, process-restart recovery, duplicate-order reconciliation, instrument-specific risk calculations, and automated demo test coverage. Keep CORS narrow. The current in-memory credentials and arm state intentionally reset when the backend restarts.
