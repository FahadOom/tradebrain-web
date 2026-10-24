# Review of the AI Brain V4 zips and what changed

## Verdict
Good to publish as a **scanner + research + demo workspace**. **Not ready for unattended live auto-trading**: Binance entries carry no stop-loss, spot cannot short, positions are never monitored, and the backend tests could not be run in this review (no network to install FastAPI/pytest).

## Problems found in the originals
1. Several settings were saved but changed nothing: bot mode, re-entry policy, mission action/deadline, max positions, max session loss. Now wired (modes, cooldown, kill switch from the balance you keep in Risk).
2. Score could never exceed 75 (divided by 4 but only 3 points counted). Volume now counts as the 4th point; max 100.
3. Scanner analysed the still-forming candle (partial volume, signals flipping). Now closed candles by default.
4. "Council" was a placeholder: Risk and Execution were hard-coded, Breakout was the score. Now every member is computed from candles.
5. Auto trade could send Binance SELL (a spot sell of coins you may not hold) and live orders with one tick. Now blocked / needs a separate live opt-in; never persisted.
6. Backend CORS default excluded GitHub Pages, so a hosted page could not reach it. `.env.example` now lists the Pages origin.
7. Zip contained `__pycache__` and `.pytest_cache`; excluded via `.gitignore`.
8. Markets were fetched one by one with no timeout; now 4 at a time with a 10 s timeout.

## Not verified
- Backend order adapters (Binance, Deriv, MT5) were not run; no keys or network here.
- `XAI_MODEL=grok-4.7` could not be confirmed as a valid model name. Check xAI's model list.
- Browsers may restrict an https page calling `http://127.0.0.1`; test it on your phone.
