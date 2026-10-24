"""TradeBrain backend with broker adapters and guarded order execution."""
from __future__ import annotations
import os
from typing import Any
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="TradeBrain API", version="1.0.0")
origins = [x.strip() for x in os.getenv("CORS_ORIGINS", "http://localhost,http://localhost:8000,http://127.0.0.1:8000").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False, allow_methods=["GET", "POST"], allow_headers=["Content-Type", "Authorization"])

class CouncilRequest(BaseModel):
    symbol: str = Field(min_length=2, max_length=30)
    timeframe: str = Field(default="15m", max_length=8)
    signal: str = Field(default="WAIT", max_length=8)
    score: int = Field(default=0, ge=0, le=100)
    evidence: list[str] = Field(default_factory=list, max_length=30)
    conflicts: list[str] = Field(default_factory=list, max_length=30)
    mode: str = Field(default="normal", max_length=20)

@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "TradeBrain API",
        "live_execution": "available_after_explicit_arm_for_configured_adapters",
        "grok_primary_configured": bool(os.getenv("XAI_API_KEY_PRIMARY")),
        "grok_secondary_configured": bool(os.getenv("XAI_API_KEY_SECONDARY")),
        "binance_public_market_data": "available_via_endpoint",
        "deriv_account": "not_connected",
        "mt5_bridge": "not_connected",
    }

@app.get("/api/markets/binance")
async def binance_markets() -> dict[str, Any]:
    """Public instrument discovery; no private key or account access required."""
    url = "https://api.binance.com/api/v3/exchangeInfo"
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Binance public market discovery failed: {type(exc).__name__}") from exc
    symbols = []
    for item in data.get("symbols", []):
        if item.get("status") == "TRADING" and item.get("quoteAsset") == "USDT" and item.get("isSpotTradingAllowed", True):
            symbols.append({"symbol": item.get("symbol"), "baseAsset": item.get("baseAsset"), "quoteAsset": item.get("quoteAsset"), "status": item.get("status"), "filters": item.get("filters", [])})
    return {"source": "Binance public Spot exchangeInfo", "private_account_connected": False, "count": len(symbols), "symbols": symbols}

async def _grok_request(prompt: str) -> dict[str, Any]:
    """Try the configured keys in order (primary, then secondary) when one is limited, rejected or failing."""
    keys = [os.getenv("XAI_API_KEY_PRIMARY"), os.getenv("XAI_API_KEY_SECONDARY")]
    keys = [k for k in keys if k]
    if not keys:
        raise HTTPException(status_code=503, detail="Grok is not configured. Set XAI_API_KEY_PRIMARY in the backend environment.")
    last_status = None
    async with httpx.AsyncClient(timeout=25) as client:
        for index, key in enumerate(keys):
            try:
                resp = await client.post("https://api.x.ai/v1/responses", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json={"model": os.getenv("XAI_MODEL", "grok-4.7"), "input": prompt})
                if resp.status_code == 429:
                    # Daily/rate limit on this key: move on to the next configured key; only fail if every key is limited.
                    last_status = 429
                    if index == len(keys) - 1:
                        raise HTTPException(status_code=429, detail="Grok limit reached on all configured keys. Wait and retry according to xAI limits.")
                    continue
                if resp.status_code in (401, 402, 403):
                    last_status = resp.status_code
                    continue
                resp.raise_for_status()
                payload = resp.json()
                output_text = payload.get("output_text")
                if not output_text:
                    chunks = []
                    for item in payload.get("output", []):
                        for content in item.get("content", []):
                            if content.get("type") in ("output_text", "text") and content.get("text"):
                                chunks.append(content["text"])
                    output_text = "\n".join(chunks)
                return {"model": payload.get("model", os.getenv("XAI_MODEL", "grok-4.7")), "text": output_text or "No text returned by provider.", "key_slot": "primary" if index == 0 else "secondary"}
            except HTTPException:
                raise
            except httpx.HTTPError as exc:
                last_status = getattr(getattr(exc, "response", None), "status_code", None)
                continue
    raise HTTPException(status_code=502, detail=f"Grok request failed or configured keys were rejected (last status: {last_status}). Check key validity, permissions and billing.")

@app.post("/api/grok/coordinate")
async def grok_coordinate(request: CouncilRequest) -> dict[str, Any]:
    prompt = (
        "You are the coordinating analyst for TradeBrain. Provide a concise, evidence-based research assessment, "
        "not a promise or instruction to trade. Never claim guaranteed profits. The deterministic risk engine has final veto. "
        "Return: summary, supporting evidence, conflicts, missing data, invalidation conditions, and verdict BUY/SELL/WAIT. "
        "If evidence is inadequate, choose WAIT.\n\n"
        f"Candidate: {request.symbol}, timeframe={request.timeframe}, rule_signal={request.signal}, score={request.score}/100, mode={request.mode}.\n"
        f"Evidence: {request.evidence}\nConflicts: {request.conflicts}\n"
        "No broker account state or execution confirmation is provided. Do not claim to have placed or closed an order."
    )
    result = await _grok_request(prompt)
    return {"candidate": request.model_dump(), "assessment": result, "execution": "not_available_in_this_build"}

# -------------------- Execution Engine V4 --------------------
# Credentials are kept in process memory only. Run this API on localhost; do not expose it publicly.
import hashlib
import hmac
import time
from urllib.parse import urlencode
from threading import RLock

from pydantic import SecretStr

class BrokerCredentialInput(BaseModel):
    broker: str = Field(pattern="^(binance|deriv)$")
    account_mode: str = Field(pattern="^(demo|live)$")
    api_key: str = Field(min_length=1, max_length=500)
    api_secret: str = Field(default="", max_length=500)
    app_id: str = Field(default="", max_length=50)

class ArmRequest(BaseModel):
    broker: str = Field(pattern="^(binance|deriv|mt5)$")
    confirmation: str = Field(min_length=1, max_length=80)

class BinanceOrderRequest(BaseModel):
    symbol: str = Field(min_length=5, max_length=30, pattern="^[A-Z0-9]+$")
    side: str = Field(pattern="^(BUY|SELL)$")
    order_type: str = Field(default="MARKET", pattern="^(MARKET|LIMIT)$")
    quantity: float = Field(gt=0, le=100000000)
    price: float | None = Field(default=None, gt=0)
    stop_loss: float | None = Field(default=None, gt=0)
    take_profit: float | None = Field(default=None, gt=0)
    client_order_id: str = Field(min_length=8, max_length=36)

class MT5OrderRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=40)
    side: str = Field(pattern="^(BUY|SELL)$")
    volume: float = Field(gt=0, le=100)
    stop_loss: float = Field(gt=0)
    take_profit: float = Field(gt=0)
    deviation: int = Field(default=20, ge=0, le=100)
    magic: int = Field(default=6202410, ge=1)
    comment: str = Field(default="AIBrainV4", max_length=30)

_execution_lock = RLock()
_execution = {
    "credentials": {},
    "armed": {"binance": False, "deriv": False, "mt5": False},
    "orders": [],
    "seen_client_ids": set(),
}

@app.get("/api/execution/status")
async def execution_status() -> dict[str, Any]:
    """Return safe status only; never return keys or secrets."""
    with _execution_lock:
        creds = _execution["credentials"]
        return {
            "execution_engine": "v4-auto-ready",
            "auto_execution_driver": "browser continuous scanner; requires Auto Trade toggle and armed broker",
            "credentials": {k: {"configured": True, "account_mode": v["account_mode"], "api_key_masked": (v.get("api_key", "")[:3] + "••••••" + v.get("api_key", "")[-3:]) if v.get("api_key") else "", "app_id_configured": bool(v.get("app_id"))} for k, v in creds.items()},
            "armed": dict(_execution["armed"]),
            "mt5_module_available": _mt5_available(),
            "orders_recorded": len(_execution["orders"]),
            "orders": list(_execution["orders"][-50:]),
            "note": "Live mode requires a separate explicit arm action. Credentials are memory-only and disappear when backend restarts."
        }

def _mt5_available() -> bool:
    try:
        import MetaTrader5  # type: ignore
        return True
    except Exception:
        return False

@app.post("/api/execution/credentials")
async def set_execution_credentials(body: BrokerCredentialInput) -> dict[str, Any]:
    """Set credentials in RAM only; this endpoint must only be used over localhost."""
    if body.broker == "binance" and not body.api_secret:
        raise HTTPException(status_code=422, detail="Binance requires both API key and API secret.")
    if body.broker == "deriv" and not body.app_id:
        raise HTTPException(status_code=422, detail="Deriv requires an App ID as well as an API token.")
    with _execution_lock:
        _execution["credentials"][body.broker] = {"account_mode": body.account_mode, "api_key": body.api_key.strip(), "api_secret": body.api_secret.strip(), "app_id": body.app_id.strip()}
        # Changing credentials always disarms that broker; no implicit live trading.
        _execution["armed"][body.broker] = False
    return {"ok": True, "broker": body.broker, "account_mode": body.account_mode, "stored": "process memory only", "armed": False}

@app.post("/api/execution/disarm")
async def disarm_execution(body: ArmRequest) -> dict[str, Any]:
    with _execution_lock:
        _execution["armed"][body.broker] = False
    return {"ok": True, "broker": body.broker, "armed": False, "message": "New orders are disarmed. Existing positions are not automatically closed."}

@app.post("/api/execution/arm")
async def arm_execution(body: ArmRequest) -> dict[str, Any]:
    with _execution_lock:
        creds = _execution["credentials"].get(body.broker)
    if body.broker in ("binance", "deriv") and not creds:
        raise HTTPException(status_code=409, detail=f"Configure {body.broker} credentials first.")
    mode = creds.get("account_mode", "") if creds else "terminal_detected"
    if mode == "live" and body.confirmation != "I UNDERSTAND LIVE TRADING":
        raise HTTPException(status_code=400, detail="For live trading, enter the exact confirmation: I UNDERSTAND LIVE TRADING")
    if mode == "demo" and body.confirmation not in ("ARM DEMO", "I UNDERSTAND LIVE TRADING"):
        raise HTTPException(status_code=400, detail="For demo trading, enter: ARM DEMO")
    if body.broker == "mt5":
        try:
            import MetaTrader5 as mt5  # type: ignore
            if not mt5.initialize():
                raise HTTPException(status_code=503, detail="MT5 terminal could not initialize. Open and log in to the MetaTrader 5 desktop terminal first.")
            account = mt5.account_info()
            if account is None:
                mt5.shutdown()
                raise HTTPException(status_code=503, detail="MT5 account is not logged in.")
            # MT5_ACCOUNT_TRADE_MODE_DEMO=0, CONTEST=1, REAL=2
            is_real = int(account.trade_mode) == 2
            mt5.shutdown()
            if is_real and body.confirmation != "I UNDERSTAND LIVE TRADING":
                raise HTTPException(status_code=400, detail="MT5 terminal is logged into a REAL account. Enter: I UNDERSTAND LIVE TRADING")
            if not is_real and body.confirmation not in ("ARM DEMO", "I UNDERSTAND LIVE TRADING"):
                raise HTTPException(status_code=400, detail="Enter ARM DEMO to arm a demo MT5 account.")
        except ImportError:
            raise HTTPException(status_code=503, detail="MT5 execution requires the MetaTrader5 Python package on Windows and an installed MT5 terminal.")
    with _execution_lock:
        _execution["armed"][body.broker] = True
    return {"ok": True, "broker": body.broker, "account_mode": mode, "armed": True, "warning": "This permits order submissions from the local backend. It does not guarantee any trade will be profitable."}

async def _binance_signed(method: str, path: str, params: dict[str, Any], creds: dict[str, Any]) -> dict[str, Any]:
    base = "https://testnet.binance.vision" if creds["account_mode"] == "demo" else "https://api.binance.com"
    query = dict(params)
    query["timestamp"] = int(time.time() * 1000)
    query["recvWindow"] = 5000
    encoded = urlencode(query)
    signature = hmac.new(creds["api_secret"].encode(), encoded.encode(), hashlib.sha256).hexdigest()
    headers = {"X-MBX-APIKEY": creds["api_key"]}
    url = f"{base}{path}?{encoded}&signature={signature}"
    async with httpx.AsyncClient(timeout=12) as client:
        resp = await client.request(method, url, headers=headers)
    if resp.status_code >= 400:
        detail = "Binance rejected the request. Check account mode, key permissions, symbol filters, balance and API restrictions."
        try:
            detail += f" Provider code: {resp.json().get('code', resp.status_code)}"
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=detail)
    return resp.json()

@app.get("/api/execution/binance/account")
async def binance_account() -> dict[str, Any]:
    with _execution_lock:
        creds = _execution["credentials"].get("binance")
    if not creds:
        raise HTTPException(status_code=409, detail="Configure Binance credentials first.")
    data = await _binance_signed("GET", "/api/v3/account", {}, creds)
    balances = [{"asset": b["asset"], "free": b["free"], "locked": b["locked"]} for b in data.get("balances", []) if float(b.get("free", 0)) or float(b.get("locked", 0))]
    return {"broker": "binance", "account_mode": creds["account_mode"], "can_trade": data.get("canTrade"), "balances": balances[:100]}

@app.post("/api/execution/binance/order")
async def binance_order(body: BinanceOrderRequest) -> dict[str, Any]:
    with _execution_lock:
        creds = _execution["credentials"].get("binance")
        armed = _execution["armed"].get("binance", False)
        seen = body.client_order_id in _execution["seen_client_ids"]
    if not creds:
        raise HTTPException(status_code=409, detail="Configure Binance credentials first.")
    if not armed:
        raise HTTPException(status_code=423, detail="Binance execution is disarmed. Arm demo or explicitly arm live execution first.")
    if seen:
        raise HTTPException(status_code=409, detail="Duplicate client_order_id blocked. Use a new ID only for a genuinely new order.")
    if body.order_type == "LIMIT" and body.price is None:
        raise HTTPException(status_code=422, detail="LIMIT orders require a price.")
    # Conservative notional cap; can be lowered/raised deliberately in the private backend environment.
    notional_cap = float(os.getenv("MAX_BINANCE_ORDER_NOTIONAL", "10"))
    reference_price = body.price
    if reference_price is None:
        base = "https://testnet.binance.vision" if creds["account_mode"] == "demo" else "https://api.binance.com"
        async with httpx.AsyncClient(timeout=8) as client:
            ticker = await client.get(f"{base}/api/v3/ticker/price", params={"symbol": body.symbol})
        if ticker.status_code >= 400:
            raise HTTPException(status_code=422, detail="Could not verify a current price for notional validation.")
        reference_price = float(ticker.json().get("price", 0))
    if not reference_price or body.quantity * reference_price > notional_cap:
        raise HTTPException(status_code=422, detail=f"Order notional exceeds backend cap of {notional_cap}. Adjust MAX_BINANCE_ORDER_NOTIONAL deliberately if needed.")
    params: dict[str, Any] = {"symbol": body.symbol, "side": body.side, "type": body.order_type, "quantity": format(body.quantity, ".12f").rstrip("0").rstrip("."), "newClientOrderId": body.client_order_id}
    if body.order_type == "LIMIT":
        params.update({"timeInForce": "GTC", "price": format(body.price or 0, ".12f").rstrip("0").rstrip(".")})
    # Spot sells can sell only available base asset; this does not implement shorting or derivatives.
    result = await _binance_signed("POST", "/api/v3/order", params, creds)
    record = {"broker": "binance", "account_mode": creds["account_mode"], "symbol": body.symbol, "side": body.side, "type": body.order_type, "orderId": result.get("orderId"), "clientOrderId": result.get("clientOrderId"), "status": result.get("status"), "transactTime": result.get("transactTime"), "executedQty": result.get("executedQty"), "cummulativeQuoteQty": result.get("cummulativeQuoteQty")}
    with _execution_lock:
        _execution["seen_client_ids"].add(body.client_order_id)
        _execution["orders"].append(record)
        _execution["orders"] = _execution["orders"][-500:]
    return {"accepted_by_broker": True, "order": record, "message": "Order response received. Check the order status and account before relying on execution."}

@app.get("/api/execution/mt5/account")
async def mt5_account() -> dict[str, Any]:
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError:
        raise HTTPException(status_code=503, detail="Install the MetaTrader5 package on Windows and run the installed MT5 desktop terminal.")
    if not mt5.initialize():
        raise HTTPException(status_code=503, detail="MT5 terminal not initialized. Open MT5 and log into your demo or real account.")
    try:
        account = mt5.account_info()
        if account is None:
            raise HTTPException(status_code=503, detail="No logged-in MT5 account found.")
        mode = "real" if int(account.trade_mode) == 2 else "demo_or_contest"
        return {"broker": "mt5", "login": account.login, "server": account.server, "company": account.company, "account_mode": mode, "balance": account.balance, "equity": account.equity, "margin_free": account.margin_free, "currency": account.currency, "trade_allowed": account.trade_allowed}
    finally:
        mt5.shutdown()

@app.post("/api/execution/mt5/order")
async def mt5_order(body: MT5OrderRequest) -> dict[str, Any]:
    with _execution_lock:
        armed = _execution["armed"].get("mt5", False)
    if not armed:
        raise HTTPException(status_code=423, detail="MT5 execution is disarmed. Check the account and arm it explicitly first.")
    try:
        import MetaTrader5 as mt5  # type: ignore
    except ImportError:
        raise HTTPException(status_code=503, detail="Install the MetaTrader5 package on Windows and run the installed MT5 desktop terminal.")
    if not mt5.initialize():
        raise HTTPException(status_code=503, detail="MT5 terminal could not initialize.")
    try:
        account = mt5.account_info()
        info = mt5.symbol_info(body.symbol)
        if account is None or info is None:
            raise HTTPException(status_code=422, detail="Account or symbol unavailable. Check the exact broker instrument name in Market Watch.")
        if not account.trade_allowed or not info.visible and not mt5.symbol_select(body.symbol, True):
            raise HTTPException(status_code=409, detail="Trading is disabled or the symbol could not be selected.")
        tick = mt5.symbol_info_tick(body.symbol)
        if tick is None:
            raise HTTPException(status_code=409, detail="No current tick for this symbol.")
        order_type = mt5.ORDER_TYPE_BUY if body.side == "BUY" else mt5.ORDER_TYPE_SELL
        price = tick.ask if body.side == "BUY" else tick.bid
        # Require stop and target on the protective side of the entry.
        if body.side == "BUY" and not (body.stop_loss < price < body.take_profit):
            raise HTTPException(status_code=422, detail="For BUY, require stop_loss < current price < take_profit.")
        if body.side == "SELL" and not (body.take_profit < price < body.stop_loss):
            raise HTTPException(status_code=422, detail="For SELL, require take_profit < current price < stop_loss.")
        if body.volume < info.volume_min or body.volume > info.volume_max:
            raise HTTPException(status_code=422, detail=f"Volume must be between {info.volume_min} and {info.volume_max} lots for this symbol.")
        step = info.volume_step or info.volume_min
        steps = round(body.volume / step)
        volume = round(steps * step, 8)
        if abs(volume - body.volume) > 1e-8:
            raise HTTPException(status_code=422, detail=f"Volume must respect the broker's volume step of {step}.")
        request = {"action": mt5.TRADE_ACTION_DEAL, "symbol": body.symbol, "volume": volume, "type": order_type, "price": price, "sl": body.stop_loss, "tp": body.take_profit, "deviation": body.deviation, "magic": body.magic, "comment": body.comment, "type_time": mt5.ORDER_TIME_GTC, "type_filling": info.filling_mode}
        check = mt5.order_check(request)
        if check is None or check.retcode not in (0, mt5.TRADE_RETCODE_DONE):
            raise HTTPException(status_code=409, detail=f"MT5 order_check rejected the request: {getattr(check, 'comment', 'no response')} / {getattr(check, 'retcode', 'unknown')}.")
        result = mt5.order_send(request)
        if result is None:
            raise HTTPException(status_code=502, detail="MT5 order_send returned no response; inspect MT5 terminal history before retrying.")
        record = {"broker": "mt5", "account_mode": "real" if int(account.trade_mode) == 2 else "demo_or_contest", "symbol": body.symbol, "side": body.side, "volume": volume, "retcode": result.retcode, "order": result.order, "deal": result.deal, "price": result.price, "comment": result.comment}
        with _execution_lock:
            _execution["orders"].append(record)
            _execution["orders"] = _execution["orders"][-500:]
        if result.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, mt5.TRADE_RETCODE_DONE_PARTIAL):
            raise HTTPException(status_code=502, detail={"message": "MT5 returned a non-success retcode; check terminal history before retrying.", "order": record})
        return {"accepted_by_broker": True, "order": record}
    finally:
        mt5.shutdown()

class DerivOrderRequest(BaseModel):
    symbol: str = Field(min_length=2, max_length=50, pattern="^[A-Za-z0-9_]+$")
    side: str = Field(pattern="^(BUY|SELL)$")
    amount: float = Field(gt=0, le=10000)
    currency: str = Field(default="USD", min_length=3, max_length=10, pattern="^[A-Z]+$")
    duration: int = Field(default=5, ge=1, le=1440)
    duration_unit: str = Field(default="m", pattern="^(t|s|m|h|d)$")
    max_price: float = Field(gt=0, le=10000)
    client_order_id: str = Field(min_length=8, max_length=36)


def _deriv_socket(creds: dict[str, Any]):
    """Open an authenticated Deriv socket. New pat_ tokens use REST + a one-time socket URL; old tokens use authorize."""
    try:
        import websocket  # type: ignore
    except ImportError as exc:
        raise RuntimeError("Install websocket-client to use the Deriv adapter.") from exc
    import json
    app_id = creds.get("app_id") or os.getenv("DERIV_APP_ID", "1089")
    token = creds["api_key"]
    if str(token).startswith("pat_"):
        headers = {"Authorization": f"Bearer {token}", "Deriv-App-ID": str(app_id)}
        try:
            with httpx.Client(timeout=12) as client:
                listing = client.get("https://api.derivws.com/trading/v1/options/accounts", headers=headers)
                listing.raise_for_status()
                data = listing.json().get("data") or []
                accounts = data if isinstance(data, list) else (data.get("accounts") or data.get("items") or [])
                want_demo = creds.get("account_mode") == "demo"
                def _is_demo(a: dict[str, Any]) -> bool:
                    aid = str(a.get("account_id") or a.get("loginid") or a.get("id") or "")
                    return a.get("account_type") == "demo" or a.get("is_virtual") in (1, True) or aid.upper().startswith(("VR", "DEM"))
                chosen = next((a for a in accounts if _is_demo(a) == want_demo), None)
                if not chosen:
                    raise RuntimeError("No %s account found for this Deriv token." % ("demo" if want_demo else "real"))
                account_id = chosen.get("account_id") or chosen.get("loginid") or chosen.get("id")
                otp = client.post(f"https://api.derivws.com/trading/v1/options/accounts/{account_id}/otp", headers=headers)
                otp.raise_for_status()
                url = (otp.json().get("data") or {}).get("url")
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Deriv REST login failed: {exc.__class__.__name__}. Check the token, the App ID registered at developers.deriv.com, and the network.") from exc
        if not url:
            raise RuntimeError("Deriv did not return a socket address.")
        ws = websocket.create_connection(url, timeout=12)
        return ws, {"loginid": account_id, "currency": chosen.get("currency"), "is_virtual": _is_demo(chosen)}
    ws = websocket.create_connection(f"wss://ws.derivws.com/websockets/v3?app_id={app_id}", timeout=12)
    ws.send(json.dumps({"authorize": token}))
    auth = json.loads(ws.recv())
    if auth.get("error"):
        ws.close()
        raise RuntimeError(auth["error"].get("message", "Deriv authorization failed"))
    auth_data = auth.get("authorize", {})
    return ws, {"loginid": auth_data.get("loginid"), "currency": auth_data.get("currency"), "is_virtual": bool(auth_data.get("is_virtual"))}


def _deriv_rpc(creds: dict[str, Any], request_payload: dict[str, Any]) -> dict[str, Any]:
    """Single Deriv WebSocket request helper; never logs the token."""
    import json
    ws, auth_data = _deriv_socket(creds)
    try:
        is_virtual = bool(auth_data.get("is_virtual"))
        expected_virtual = creds.get("account_mode") == "demo"
        if is_virtual != expected_virtual:
            raise RuntimeError("Deriv token account type does not match the selected account mode. Reconfigure with the correct demo/live selection.")
        ws.send(json.dumps(request_payload))
        reply = json.loads(ws.recv())
        if reply.get("error"):
            raise RuntimeError(reply["error"].get("message", "Deriv request failed"))
        return {"authorize": {"loginid": auth_data.get("loginid"), "currency": auth_data.get("currency"), "is_virtual": is_virtual}, "response": reply}
    finally:
        ws.close()

@app.get("/api/execution/deriv/account")
async def deriv_account() -> dict[str, Any]:
    with _execution_lock:
        creds = _execution["credentials"].get("deriv")
    if not creds:
        raise HTTPException(status_code=409, detail="Configure a Deriv API token and App ID first.")
    try:
        data = await __import__("asyncio").to_thread(_deriv_rpc, creds, {"balance": 1, "subscribe": 0})
        result = data["response"].get("balance", {})
        return {"broker": "deriv", "account_mode": "demo" if data["authorize"]["is_virtual"] else "live", "loginid": data["authorize"]["loginid"], "currency": result.get("currency"), "balance": result.get("balance")}
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

@app.post("/api/execution/deriv/order")
async def deriv_order(body: DerivOrderRequest) -> dict[str, Any]:
    with _execution_lock:
        creds = _execution["credentials"].get("deriv")
        armed = _execution["armed"].get("deriv", False)
        seen = body.client_order_id in _execution["seen_client_ids"]
    if not creds:
        raise HTTPException(status_code=409, detail="Configure Deriv credentials first.")
    if not armed:
        raise HTTPException(status_code=423, detail="Deriv execution is disarmed. Arm the selected account first.")
    if seen:
        raise HTTPException(status_code=409, detail="Duplicate client_order_id blocked.")
    # This adapter uses Rise/Fall contracts, not spot BUY/SELL orders. Confirm contract semantics before enabling auto-strategy mapping.
    contract_type = "CALL" if body.side == "BUY" else "PUT"
    try:
        proposal_result = await __import__("asyncio").to_thread(_deriv_rpc, creds, {"proposal": 1, "amount": body.amount, "basis": "stake", "contract_type": contract_type, "currency": body.currency, "duration": body.duration, "duration_unit": body.duration_unit, "symbol": body.symbol})
        proposal = proposal_result["response"].get("proposal", {})
        ask_price = float(proposal.get("ask_price", 0))
        if not proposal.get("id") or ask_price <= 0:
            raise RuntimeError("Deriv did not return a valid proposal.")
        if ask_price > body.max_price:
            raise HTTPException(status_code=409, detail=f"Proposal price {ask_price} exceeds max_price {body.max_price}; no contract purchased.")
        bought_result = await __import__("asyncio").to_thread(_deriv_rpc, creds, {"buy": proposal["id"], "price": body.max_price})
        contract = bought_result["response"].get("buy", {})
        record = {"broker": "deriv", "account_mode": creds["account_mode"], "symbol": body.symbol, "side": body.side, "contract_type": contract_type, "contract_id": contract.get("contract_id"), "transaction_id": contract.get("transaction_id"), "buy_price": contract.get("buy_price"), "payout": contract.get("payout"), "client_order_id": body.client_order_id}
        with _execution_lock:
            _execution["seen_client_ids"].add(body.client_order_id)
            _execution["orders"].append(record)
            _execution["orders"] = _execution["orders"][-500:]
        return {"accepted_by_broker": True, "order": record, "warning": "This is a fixed-duration CALL/PUT contract, not a conventional spot/forex position. Contract expiry and settlement are handled by Deriv."}
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
