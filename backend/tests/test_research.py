import numpy as np
import pandas as pd
import pytest

from atlas.backtest.engine import BacktestConfig, CostModel, run_backtest
from atlas.backtest.metrics import block_bootstrap_pvalue, max_drawdown, probabilistic_sharpe, sharpe
from atlas.backtest.walkforward import chronological_splits, full_evaluation, walk_forward
from atlas.data.validation import dataset_version, normalize, quality_report, resample
from atlas.forecasting.models import MODELS, forecast, rolling_evaluation
from atlas.research.features import build_features, feature_importance
from atlas.research.regime import classify, summarize
from atlas.research.strategies.base import Strategy
from atlas.research.strategies.library import REGISTRY

from .conftest import synthetic_ohlcv


class AlwaysLong(Strategy):
    """Test-only strategy (not registered)."""
    key, name, family, description, rules = "_test_long", "Always long", "test", "test", ["long"]
    params = ()

    def raw_signal(self, df):
        return pd.Series(1.0, index=df.index)


# ---------------- validation ----------------
def test_normalize_dedup_invalid_open_period_and_ohlc_repair():
    raw = pd.DataFrame({
        "ts": ["2024-01-01T05:00:00Z", "2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"],
        "open": [1, 1, 1, 1, 1], "high": [0.5, 1.2, 1.2, 1.2, 1.2], "low": [0.9, 0.9, 0.9, 0.9, 0.9],
        "close": [1.0, 1.1, -1, 1.05, 1.0], "volume": [1, 1, 1, -5, 1]})
    df, rep = normalize(raw, drop_open_period=True, now=pd.Timestamp("2024-01-04T12:00Z"))
    assert rep["duplicates_dropped"] == 1 and rep["invalid_close_dropped"] == 1
    assert rep["incomplete_period_dropped"] == 1  # 2024-01-04 still open at noon
    assert list(df.index.strftime("%Y-%m-%d")) == ["2024-01-01", "2024-01-03"]
    assert df.loc["2024-01-01", "close"].item() == 1.1  # last duplicate wins
    assert np.isnan(df.loc["2024-01-03", "volume"].item())  # negative volume nulled
    assert (df["high"] >= df[["open", "close"]].max(axis=1)).all()


def test_quality_report_detects_fx_gaps_and_version_changes():
    df = synthetic_ohlcv(300, freq="B", ohlc=False)
    holed = df.drop(df.index[100:105])
    q = quality_report(holed, "fx", now=df.index[-1].to_pydatetime())
    assert q["missing_periods"] == 5 and q["gap_count"] == 1
    assert q["has_ohlc"] is False and q["has_volume"] is False
    assert dataset_version(df) != dataset_version(holed)
    assert dataset_version(df) == dataset_version(df.copy())


def test_weekly_resample_drops_open_week():
    df = synthetic_ohlcv(17, start="2024-01-01")  # Mon 1 Jan .. Wed 17 Jan
    w = resample(df, "W-FRI")
    assert w.index[-1] <= df.index[-1]
    assert w.loc["2024-01-05", "close"] == df.loc["2024-01-05", "close"]


# ---------------- causality / look-ahead ----------------
@pytest.mark.parametrize("key", list(REGISTRY))
def test_strategies_are_causal(key):
    """target[t] on the full history must equal target[t] on history truncated at t."""
    df = synthetic_ohlcv(900, seed=3)
    cls = REGISTRY[key]
    full = cls().target(df)
    for cut in (400, 555, 701, 899):
        trunc = cls().target(df.iloc[: cut + 1])
        assert np.isclose(full.iloc[cut], trunc.iloc[-1]), f"{key} leaks future data at bar {cut}"


def test_features_are_causal():
    df = synthetic_ohlcv(800, seed=5)
    full = build_features(df)
    trunc = build_features(df.iloc[:601])
    pd.testing.assert_series_equal(full.iloc[600], trunc.iloc[-1], check_names=False)


def test_feature_importance_shapes():
    out = feature_importance(synthetic_ohlcv(1200, seed=9), 365)
    assert out["features"] and {"ic_train", "ic_test", "sign_stable"} <= set(out["features"][0])


# ---------------- engine ----------------
def test_fills_happen_at_next_bar_open():
    df = synthetic_ohlcv(50)
    res = run_backtest(df, AlwaysLong(), BacktestConfig(costs=CostModel(0, 0, 0)))
    first = res.trades[0]
    assert first["entry_ts"] == df.index[2].date().isoformat()  # signal at close of bar 1 → open of bar 2
    assert np.isclose(first["entry_price"], df["open"].iloc[2])


def test_close_only_data_fills_at_next_close():
    df = synthetic_ohlcv(50, ohlc=False)
    res = run_backtest(df, AlwaysLong(), BacktestConfig(costs=CostModel(0, 0, 0)))
    assert np.isclose(res.trades[0]["entry_price"], df["close"].iloc[2])


def test_accounting_identity_and_costs():
    df = synthetic_ohlcv(600, seed=11)
    strat = REGISTRY["ma_crossover"](fast=10, slow=50)
    free = run_backtest(df, strat, BacktestConfig(costs=CostModel(0, 0, 0)))
    costly = run_backtest(df, strat, BacktestConfig(costs=CostModel(10, 10, 10)))
    assert costly.metrics["total_return"] < free.metrics["total_return"]
    for r in (free, costly):  # equity change == sum of round-trip trade P&L
        assert np.isclose(r.equity.iloc[-1] - r.equity.iloc[0], sum(t["pnl"] for t in r.trades), rtol=1e-9, atol=1e-6)
    assert costly.metrics["costs_paid"]["fees"] > 0


def test_stop_loss_gap_fills_at_open_not_stop():
    idx = pd.date_range("2024-01-01", periods=30, freq="D", tz="UTC")
    c = np.full(30, 100.0)
    c[25:] = 80.0
    df = pd.DataFrame({"open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1.0}, index=idx)
    df.iloc[25, df.columns.get_loc("open")] = 79.0  # gap far below the stop
    res = run_backtest(df, AlwaysLong(stop_atr=2.0), BacktestConfig(costs=CostModel(0, 0, 0)))
    stops = [t for t in res.trades if t["exit_reason"] == "stop_loss"]
    assert stops and np.isclose(stops[0]["exit_price"], 79.0)
    # no immediate re-entry in the same direction after a stop while signal is unchanged
    assert len(res.trades) == 1


def test_always_long_matches_asset_return_without_costs():
    df = synthetic_ohlcv(300, ohlc=False)
    res = run_backtest(df, AlwaysLong(), BacktestConfig(costs=CostModel(0, 0, 0)))
    # sized at the signal bar's close (bar 1), filled at the next close (bar 2): P&L = qty × (P_end − P_fill)
    qty = 100_000 / df.close.iloc[1]
    expected = qty * (df.close.iloc[-1] - df.close.iloc[2]) / 100_000
    assert abs(res.metrics["total_return"] - expected) < 1e-9


def test_trading_window_and_end_truncation():
    df = synthetic_ohlcv(800)
    res = run_backtest(df, REGISTRY["ts_momentum"](), BacktestConfig(start="2021-01-01", end="2021-06-30"))
    assert res.equity.index[-1] <= pd.Timestamp("2021-06-30", tz="UTC")
    assert all(t["entry_ts"] >= "2021-01-01" for t in res.trades)


# ---------------- metrics ----------------
def test_metrics_basic():
    eq = pd.Series([100, 110, 99, 120], index=pd.date_range("2024", periods=4, tz="UTC"), dtype=float)
    assert np.isclose(max_drawdown(eq)[0], 99 / 110 - 1)
    r = pd.Series(np.random.default_rng(0).normal(0.001, 0.01, 2000))
    assert 1.0 < sharpe(r, 252) < 2.5
    assert probabilistic_sharpe(r) > 0.95
    assert block_bootstrap_pvalue(r) < 0.05
    assert block_bootstrap_pvalue(-r) > 0.95


# ---------------- walk-forward ----------------
def test_splits_are_chronological_and_disjoint():
    sp = chronological_splits(synthetic_ohlcv(1500).index)
    assert sp.train[1] < sp.validation[0] <= sp.validation[1] < sp.test[0] <= sp.test[1]


def test_walk_forward_and_full_evaluation():
    df = synthetic_ohlcv(1500, seed=21)
    cls = REGISTRY["ma_crossover"]
    wf = walk_forward(df, cls, cls.grid()[:4], BacktestConfig(periods_per_year=365), n_folds=3)
    assert len(wf["folds"]) == 3
    assert all(f["train"][1] < f["test"][0] for f in wf["folds"])
    p = {"fast": 20, "slow": 100}
    ev = full_evaluation(df, cls, p, BacktestConfig(periods_per_year=365), walkforward_grid=[p])
    assert {"train", "validation", "test", "cost_stress", "psr_test", "bootstrap_p_test", "walk_forward"} <= set(ev)
    assert ev["cost_stress"]["x3"]["total_return"] <= ev["cost_stress"]["x2"]["total_return"] + 1e-12


# ---------------- regimes & forecasting ----------------
def test_regime_summary():
    s = summarize(classify(synthetic_ohlcv(900), 365))
    assert s["current"]["trend"] in ("trend_up", "trend_down", "range")
    assert s["segments"]


def test_forecast_intervals_and_rolling_evaluation():
    df = synthetic_ohlcv(900, ohlc=False, freq="B")
    for m in MODELS:
        p = forecast(df, m, 10)["path"][-1]
        assert p["lo95"] < p["lo80"] < p["lo50"] <= p["mean"] <= p["hi50"] < p["hi80"] < p["hi95"]
    ev = rolling_evaluation(df, horizon=5, n_origins=40)
    naive = next(m for m in ev["models"] if m["model"] == "naive")
    assert np.isclose(naive["mase"], 1.0)
    assert 0 <= naive["coverage"]["95"] <= 1
