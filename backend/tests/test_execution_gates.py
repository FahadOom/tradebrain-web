from fastapi.testclient import TestClient
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import app, _execution, _execution_lock

client = TestClient(app)

def reset_state():
    with _execution_lock:
        _execution["credentials"].clear()
        _execution["armed"] = {"binance": False, "deriv": False, "mt5": False}
        _execution["orders"].clear()
        _execution["seen_client_ids"].clear()

def test_credentials_are_masked_and_execution_starts_disarmed():
    reset_state()
    r = client.post("/api/execution/credentials", json={
        "broker": "binance", "account_mode": "demo", "api_key": "TEST_API_KEY_123456", "api_secret": "TEST_SECRET_123456"
    })
    assert r.status_code == 200
    status = client.get("/api/execution/status").json()
    assert status["credentials"]["binance"]["configured"] is True
    assert "TEST_SECRET_123456" not in str(status)
    assert status["armed"]["binance"] is False

def test_live_arm_requires_exact_confirmation():
    reset_state()
    client.post("/api/execution/credentials", json={
        "broker": "binance", "account_mode": "live", "api_key": "TEST_API_KEY_123456", "api_secret": "TEST_SECRET_123456"
    })
    denied = client.post("/api/execution/arm", json={"broker": "binance", "confirmation": "ARM DEMO"})
    assert denied.status_code == 400
    accepted = client.post("/api/execution/arm", json={"broker": "binance", "confirmation": "I UNDERSTAND LIVE TRADING"})
    assert accepted.status_code == 200
    assert client.get("/api/execution/status").json()["armed"]["binance"] is True
    reset_state()

def test_order_is_blocked_while_disarmed():
    reset_state()
    client.post("/api/execution/credentials", json={
        "broker": "binance", "account_mode": "demo", "api_key": "TEST_API_KEY_123456", "api_secret": "TEST_SECRET_123456"
    })
    r = client.post("/api/execution/binance/order", json={
        "symbol": "BTCUSDT", "side": "BUY", "order_type": "MARKET", "quantity": 0.0001, "client_order_id": "AIB4TEST00001"
    })
    assert r.status_code == 423
    reset_state()
