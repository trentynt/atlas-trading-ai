"""Statistical-integrity tests (methodology v2). Worked examples are computed by hand in comments."""
import math
import os
import tempfile

import numpy as np
import pandas as pd
import pytest

from atlas.backtest.metrics import expected_max_sharpe
from atlas.db import Database, dumps, utcnow
from atlas.research.integrity import by_adjust, effective_trials, hac_t_test, holm_adjust
from atlas.research.registry import TrialRegistry
from atlas.research.validation import Validator, final_disposition

from .conftest import synthetic_ohlcv


# ---------------- multiple-testing arithmetic ----------------
def test_holm_worked_example():
    # p = [.01, .04, .03, .005], m = 4 → sorted .005,.01,.03,.04 × (4,3,2,1) = .02,.03,.06,.04 → monotone .02,.03,.06,.06
    assert np.allclose(holm_adjust([0.01, 0.04, 0.03, 0.005]), [0.03, 0.06, 0.06, 0.02])


def test_by_worked_example():
    # c(4) = 1 + 1/2 + 1/3 + 1/4 = 2.0833; adjusted = p·m·c / rank, then step-up minimum
    c = 1 + 1 / 2 + 1 / 3 + 1 / 4
    expected = [0.01 * 4 * c / 2, 0.04 * 4 * c / 4, 0.03 * 4 * c / 3, 0.005 * 4 * c / 1]
    expected = [min(expected[0], expected[1], expected[2]), expected[1], min(expected[2], expected[1]), min(expected[3], expected[0])]
    assert np.allclose(by_adjust([0.01, 0.04, 0.03, 0.005]), expected)
    # BY is never less conservative than raw p-values
    p = list(np.random.default_rng(0).uniform(size=50))
    assert all(a >= b for a, b in zip(by_adjust(p), p))


def test_hac_matches_classic_t_without_lags_and_controls_size():
    x = np.random.default_rng(1).normal(0.001, 0.01, 500)
    t, _ = hac_t_test(x, lag=0)
    assert math.isclose(t, x.mean() / (x.std(ddof=0) / math.sqrt(len(x))), rel_tol=1e-9)
    rng = np.random.default_rng(2)
    rejections = np.mean([hac_t_test(rng.normal(0, 1, 400))[1] < 0.05 for _ in range(400)])
    assert 0.02 <= rejections <= 0.09  # nominal 5% one-sided size under the null


def test_hac_is_more_conservative_under_positive_autocorrelation():
    rng = np.random.default_rng(3)
    e = rng.normal(0, 1, 2000)
    x = np.empty_like(e); x[0] = e[0]
    for i in range(1, len(e)):
        x[i] = 0.6 * x[i - 1] + e[i]
    x = x * 0.01 + 0.0015
    _, p_naive = hac_t_test(x, lag=0)
    _, p_hac = hac_t_test(x)
    assert p_hac > p_naive


def test_effective_trials_galwey():
    rng = np.random.default_rng(4)
    base = rng.normal(size=(800, 1))
    assert math.isclose(effective_trials(np.repeat(base, 5, axis=1)), 1.0, abs_tol=1e-6)  # identical strategies count once
    indep = rng.normal(size=(5000, 10))
    assert 8.0 <= effective_trials(indep) <= 10.0  # independent strategies count (almost) fully
    two = np.hstack([np.repeat(rng.normal(size=(800, 1)), 4, axis=1), np.repeat(rng.normal(size=(800, 1)), 4, axis=1)])
    assert math.isclose(effective_trials(two), 2.0, abs_tol=0.15)


def test_deflated_threshold_grows_with_trials():
    assert expected_max_sharpe(100, 0.01) > expected_max_sharpe(10, 0.01) > expected_max_sharpe(2, 0.01) > 0


# ---------------- registry ----------------
@pytest.fixture
def db():
    return Database(os.path.join(tempfile.mkdtemp(), "t.db"))


def _series(vals, start="2022-01-01"):
    return pd.Series(vals, index=pd.date_range(start, periods=len(vals), freq="D", tz="UTC"))


def test_trial_accounting_counts_every_attempt(db):
    reg = TrialRegistry(db)
    r = _series(np.random.default_rng(5).normal(0, 0.01, 300))
    for kind in ("hypothesis", "variant", "variant", "manual_backtest", "manual_validation"):
        reg.register(user_id=1, kind=kind, symbol="BTC/USD", strategy="ma_crossover", params={"fast": 10}, dataset_version="v",
                     window=("2022-01-01", "2022-10-27"), returns=r if not kind.startswith("manual_b") else None, selection_returns=r)
    # repeating the identical configuration is a repeated search and must count again
    reg.register(user_id=1, kind="hypothesis", symbol="BTC/USD", strategy="ma_crossover", params={"fast": 10}, dataset_version="v",
                 window=("2022-01-01", "2022-10-27"), returns=r, selection_returns=r)
    c = reg.counts(1, "BTC/USD")
    assert c == {"hypothesis": 2, "variant": 2, "manual_backtest": 1, "manual_validation": 1, "total": 6}
    fam = reg.family_stats(1, "BTC/USD")
    assert fam["n_raw"] == 6
    # four research trials with IDENTICAL returns collapse to ~1 effective trial, plus manual runs counted fully
    assert 2.5 <= fam["n_eff"] <= 3.5
    assert reg.counts(2, "BTC/USD")["total"] == 0  # other users' searches never count against you


def test_holdout_policy_and_sealing(db):
    reg = TrialRegistry(db)
    idx = synthetic_ohlcv(1000).index
    fresh = reg.holdout_start(1, "SOL/USD", idx)
    assert fresh == idx[800]  # last 20% sealed for a never-researched market
    db.insert("experiments", {"created_at": utcnow(), "kind": "hypothesis_test", "status": "completed", "symbol": "ETH/USD", "user_id": 1})
    fwd = reg.holdout_start(1, "ETH/USD", idx)
    assert fwd > idx[-1]  # forward-only when history was already used for selection
    longer = synthetic_ohlcv(1200).index
    assert reg.holdout_start(1, "SOL/USD", longer) == fresh  # sealing is permanent


# ---------------- holdout isolation and single look ----------------
class _NoData:
    def load(self, symbol):  # pragma: no cover - the tests always pass df explicitly
        raise AssertionError("must not load")


def test_research_evaluation_cannot_see_holdout(db):
    V = Validator(db, _NoData(), TrialRegistry(db))
    full = synthetic_ohlcv(1500, seed=7)
    research, hs, _ = V.windows(1, "BTC/USD", df=full)
    poisoned = full.copy()
    poisoned.loc[poisoned.index >= hs, ["open", "high", "low", "close"]] *= 25.0
    research_p, hs_p, _ = V.windows(1, "BTC/USD", df=poisoned)
    assert hs == hs_p and research.equals(research_p)
    a = V.evaluate(1, "BTC/USD", "ts_momentum", {"lookback": 60}, research_df=research, dataset_version="a")
    b = V.evaluate(1, "BTC/USD", "ts_momentum", {"lookback": 60}, research_df=research_p, dataset_version="b")
    assert a["test"] == b["test"] and a["splits"] == b["splits"]
    assert pd.Timestamp(a["splits"]["test"][1], tz="UTC") < hs


def test_holdout_single_look_and_bonferroni(db):
    reg = TrialRegistry(db)
    V = Validator(db, _NoData(), reg)
    full = synthetic_ohlcv(1500, seed=8)
    _, hs, _ = V.windows(1, "BTC/USD", df=full)
    first = V.confirm(1, "BTC/USD", "ts_momentum", {"lookback": 60}, full, hs, None)
    assert first["status"] in ("passed", "failed") and first["look_number"] == 1 and first["alpha"] == 0.05
    again = V.confirm(1, "BTC/USD", "ts_momentum", {"lookback": 60}, full, hs, None)
    assert again.get("cached") and reg.holdout_accesses(1, "BTC/USD") == 1
    second = V.confirm(1, "BTC/USD", "ma_crossover", {"fast": 20, "slow": 100}, full, hs, None)
    assert second["look_number"] == 2 and math.isclose(second["alpha"], 0.025)


def test_forward_holdout_pending_until_enough_new_data(db):
    reg = TrialRegistry(db)
    V = Validator(db, _NoData(), reg)
    db.insert("experiments", {"created_at": utcnow(), "kind": "hypothesis_test", "status": "completed", "symbol": "ETH/USD", "user_id": 1})
    full = synthetic_ohlcv(1200, seed=9)
    _, hs, _ = V.windows(1, "ETH/USD", df=full)
    res = V.confirm(1, "ETH/USD", "ts_momentum", {"lookback": 60}, full, hs, None)
    assert res["status"] == "pending" and reg.holdout_accesses(1, "ETH/USD") == 0
    assert final_disposition("pending_holdout", res) == "requires_confirmation"


def test_no_edge_strategies_are_not_positively_labelled(db):
    """Pure noise: repeated searching must not manufacture a 'survived' result."""
    reg = TrialRegistry(db)
    V = Validator(db, _NoData(), reg)
    rng = np.random.default_rng(10)
    idx = pd.date_range("2016-01-01", periods=2200, freq="D", tz="UTC")
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.02, len(idx))))
    df = pd.DataFrame({"open": close, "high": close * 1.01, "low": close * 0.99, "close": close, "volume": 1.0}, index=idx)
    research, hs, _ = V.windows(1, "BTC/USD", df=df)
    disps = []
    for strat, params in [("ma_crossover", {"fast": 10, "slow": 50}), ("ma_crossover", {"fast": 20, "slow": 100}),
                          ("donchian_breakout", {"entry": 20, "exit": 10}), ("ts_momentum", {"lookback": 20}),
                          ("ts_momentum", {"lookback": 120}), ("bollinger_reversion", {"window": 20, "entry_z": 2.0, "exit_z": 0.5})]:
        ev = V.evaluate(1, "BTC/USD", strat, params, research_df=research, dataset_version="noise")
        disps.append(V.judge(1, "BTC/USD", ev)["disposition"])
    assert "pending_holdout" not in disps


# ---------------- revalidation ----------------
def test_revalidation_handles_missing_snapshots_and_is_idempotent(settings, providers):
    from atlas.research.revalidate import revalidate
    from atlas.services import Services
    sv = Services.build(settings, providers)
    sv.data.refresh_all()
    v = sv.data.latest_dataset("BTC/USD")["version"]
    ok_id = sv.db.insert("experiments", {"created_at": utcnow(), "kind": "hypothesis_test", "status": "completed", "user_id": 1,
                                         "symbol": "BTC/USD", "strategy": "ts_momentum", "params_json": dumps({"lookback": 60}),
                                         "config_json": dumps({}), "dataset_version": v, "verdict": "accepted", "metrics_json": dumps({"test": {}})})
    gone_id = sv.db.insert("experiments", {"created_at": utcnow(), "kind": "hypothesis_test", "status": "completed", "user_id": 1,
                                           "symbol": "ETH/USD", "strategy": "ts_momentum", "params_json": dumps({"lookback": 60}),
                                           "config_json": dumps({}), "dataset_version": "does-not-exist", "verdict": "accepted", "metrics_json": dumps({})})
    sc = sv.db.insert("strategy_configs", {"created_at": utcnow(), "user_id": 1, "name": "x", "strategy": "ts_momentum", "symbol": "ETH/USD",
                                           "params_json": dumps({"lookback": 60}), "status": "deployed", "allocation": 0.1, "source_experiment": gone_id})
    out = revalidate(sv, 1)
    assert out["missing_snapshot"] == [gone_id]
    gone = sv.db.one("SELECT disposition FROM experiments WHERE id=?", (gone_id,))
    assert gone["disposition"] == "requires_revalidation"
    ok = sv.db.one("SELECT disposition, methodology FROM experiments WHERE id=?", (ok_id,))
    assert ok["methodology"] == "v2" and ok["disposition"] in ("rejected", "insufficient_evidence", "requires_confirmation", "survived")
    assert sv.db.one("SELECT status FROM strategy_configs WHERE id=?", (sc,))["status"] == "retired"
    n = sv.registry.counts(1)["total"]
    assert n >= 1
    again = revalidate(sv, 1)
    assert again["legacy_hypotheses"] == 0 and sv.registry.counts(1)["total"] == n  # idempotent: no duplicate trials


def _fill(reg, symbol, n, seed=0, kind="variant"):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2020-01-01", periods=120, freq="D", tz="UTC")
    for i in range(n):
        reg.register(user_id=1, kind=kind, symbol=symbol, strategy="s", params={"i": i}, dataset_version="v",
                     window=("2020-01-01", "2020-04-30"), returns=pd.Series(rng.normal(0, 0.01, 120), index=idx))


def test_attempts_beyond_correlation_window_still_count(tmp_path):
    reg = TrialRegistry(Database(tmp_path / "t.db"))
    _fill(reg, "BTC/USD", 340)
    f = reg.family_stats(1, "BTC/USD")
    assert f["n_raw"] == 340 and f["n_research"] == 340
    assert f["n_beyond_window"] == 40  # older than the 300 used for correlations: counted as independent
    assert f["n_eff"] >= 40 and f["n_eff"] <= 340


def test_global_count_is_at_least_any_market(tmp_path):
    reg = TrialRegistry(Database(tmp_path / "t.db"))
    _fill(reg, "BTC/USD", 30, seed=1)
    _fill(reg, "ETH/USD", 50, seed=2)
    g = reg.global_stats(1)
    a, b = reg.family_stats(1, "BTC/USD"), reg.family_stats(1, "ETH/USD")
    assert g["n_raw"] == 80 and g["markets"] == 2
    assert g["n_eff"] == pytest.approx(a["n_eff"] + b["n_eff"]) and g["n_eff"] > max(a["n_eff"], b["n_eff"])
    # More effective trials → higher luck bar → stricter test
    assert expected_max_sharpe(int(g["n_eff"]), 1.0) > expected_max_sharpe(int(b["n_eff"]), 1.0)
