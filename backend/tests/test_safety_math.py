def risk_budget(equity: float, risk_percent: float) -> float:
    if equity <= 0 or not 0 < risk_percent <= 5:
        raise ValueError("invalid risk inputs")
    return equity * risk_percent / 100

def size_for_risk(equity: float, risk_percent: float, loss_per_unit: float) -> float:
    if loss_per_unit <= 0:
        raise ValueError("loss_per_unit must be positive")
    return risk_budget(equity, risk_percent) / loss_per_unit

def test_ten_dollar_one_percent_risk():
    assert round(risk_budget(10, 1), 2) == 0.10

def test_size_uses_stop_loss_cash_per_unit():
    assert round(size_for_risk(10, 1, 0.10), 6) == 1.0

def test_invalid_risk_rejected():
    try:
        risk_budget(10, 10)
    except ValueError:
        return
    assert False, "risk > 5% should be rejected by this calculator test"

def test_nonpositive_unit_loss_rejected():
    try:
        size_for_risk(10, 1, 0)
    except ValueError:
        return
    assert False, "zero unit loss must be rejected"
