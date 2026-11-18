"""Phase 2: data quality, licensing modes, crypto universe, cross-source checks, labels."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from atlas.data.instruments import LIQUID_CRYPTO, build_instruments, parse_crypto_assets
from atlas.data.licensing import LICENSES, source_allowed
from atlas.data.service import FX_LABEL, DataService, DataUnavailable, data_label
from atlas.data.validation import assess, cross_source_compare, normalize, quality_report
from atlas.db import Database
from atlas.events import EventBus

from .conftest import FakeProvider, synthetic_ohlcv


def _raw(df):
    return df.reset_index()


def test_invalid_ohlc_is_quarantined_not_repaired():
    df = synthetic_ohlcv(10)
    df.iloc[3, df.columns.get_loc("high")] = df.iloc[3]["close"] * 0.5  # high below close
    df.iloc[5, df.columns.get_loc("low")] = df.iloc[5]["close"] * 2.0  # low above close
    df.iloc[6, df.columns.get_loc("open")] = 0.0  # non-positive price
    clean, rep = normalize(_raw(df), drop_open_period=False)
    assert rep["invalid_ohlc_quarantined"] == 3
    assert len(clean) == 7
    assert df.index[3] not in clean.index  # excluded, so it shows up as a missing candle
    # surviving rows are byte-identical to the input: nothing was modified
    pd.testing.assert_frame_equal(clean, df.drop(df.index[[3, 5, 6]]), check_freq=False, check_names=False)


def test_out_of_order_duplicates_and_conflicts_reported():
    df = synthetic_ohlcv(6)
    raw = _raw(df)
    raw = pd.concat([raw.iloc[[0, 2, 1, 3, 4, 5]], raw.iloc[[4]].assign(**{c: raw.iloc[4][c] * 1.01 for c in ("open", "high", "low", "close")})])
    clean, rep = normalize(raw, drop_open_period=False)
    assert rep["out_of_order_rows"] >= 1
    assert rep["duplicates_dropped"] == 1 and rep["conflicting_duplicates"] == 1
    assert clean.index.is_monotonic_increasing and len(clean) == 6


def test_missing_candles_are_reported_never_filled():
    df = synthetic_ohlcv(100).drop(synthetic_ohlcv(100).index[40:43])
    clean, rep = normalize(_raw(df), drop_open_period=False)
    q = quality_report(clean, "crypto", now=clean.index[-1].to_pydatetime())
    assert q["missing_periods"] == 3 and len(clean) == 97
    grade = assess(q, rep, max_stale_days=2, asset_class="crypto")
    assert grade["status"] == "warn" and any(i["code"] == "missing" for i in grade["issues"])


def test_heavy_quarantine_fails_dataset():
    rep = {"raw_rows": 100, "quarantined": 10}
    q = {"completeness": 1.0, "stale_days": 0.5, "outliers": []}
    assert assess(q, rep, max_stale_days=2, asset_class="crypto")["status"] == "fail"


def test_intraday_alignment():
    idx = pd.date_range("2026-01-01", periods=5, freq="h", tz="UTC")
    raw = pd.DataFrame({"ts": list(idx) + [idx[-1] + pd.Timedelta(minutes=30)], "open": 1.0, "high": 1.1,
                        "low": 0.9, "close": 1.0, "volume": 1.0})
    clean, rep = normalize(raw, drop_open_period=False, freq="h")
    assert rep["misaligned_quarantined"] == 1 and len(clean) == 5


def test_cross_source_agreement_and_mismatch():
    a = synthetic_ohlcv(120)
    rng = np.random.default_rng(3)
    b = a.copy()
    b["close"] = a["close"] * (1 + rng.normal(0, 0.0005, len(a)))  # ~5 bps venue noise
    ok = cross_source_compare(a, b, 50)
    assert ok["status"] == "ok" and ok["overlap"] == 120 and ok["median_abs_bps"] < 10
    bad = b.copy()
    bad.iloc[50:70, bad.columns.get_loc("close")] *= 1.03
    mm = cross_source_compare(a, bad, 50)
    assert mm["status"] == "mismatch" and mm["days_over_tolerance"] == 20
    shifted = a.copy()
    shifted["close"] = a["close"].shift(1)  # secondary lags by one day
    assert cross_source_compare(a, shifted.dropna(), 50)["status"] in ("possible_time_shift", "mismatch")


def test_licensing_modes():
    assert source_allowed("frankfurter", "beta") and source_allowed("frankfurter", "personal")
    for p in ("coinbase", "kraken"):
        assert source_allowed(p, "personal") and not source_allowed(p, "beta")
    assert not source_allowed("binance", "personal")  # not integrated
    assert source_allowed("byo:alpaca", "beta")
    assert LICENSES["kraken"].status == "restricted" and LICENSES["coinbase"].status == "unverified"
    with pytest.raises(ValueError):
        source_allowed("frankfurter", "public")


def test_beta_mode_blocks_unlicensed_sources(tmp_path):
    db, bus = Database(tmp_path / "t.db"), EventBus(None)
    (tmp_path / "s").mkdir()
    provs = {"frankfurter": FakeProvider(False, "frankfurter"), "coinbase": FakeProvider(True, "coinbase"),
             "kraken": FakeProvider(True, "kraken")}
    personal = DataService(db, bus, tmp_path / "s", "2021-01-01", providers=provs, mode="personal")
    personal.refresh("BTC/USD")
    assert len(personal.load("BTC/USD")) > 300
    beta = DataService(db, bus, tmp_path / "s", "2021-01-01", providers=provs, mode="beta")
    calls = provs["coinbase"].calls
    with pytest.raises(DataUnavailable, match="licensed"):
        beta.refresh("BTC/USD")
    assert provs["coinbase"].calls == calls  # no request made to an unlicensed source
    with pytest.raises(DataUnavailable, match="not licensed"):
        beta.load("BTC/USD")  # stored data from an unlicensed source is not served either
    beta.refresh("EUR/USD")
    assert len(beta.load("EUR/USD")) > 300
    st = {m["symbol"]: m for m in beta.status()}
    assert st["BTC/USD"]["licensed"] is False and st["EUR/USD"]["licensed"] is True


def test_refresh_records_quality_cross_source_and_labels(tmp_path):
    db, bus = Database(tmp_path / "t.db"), EventBus(None)
    (tmp_path / "s").mkdir()
    provs = {"frankfurter": FakeProvider(False, "frankfurter"), "coinbase": FakeProvider(True, "coinbase"),
             "kraken": FakeProvider(True, "kraken")}
    ds = DataService(db, bus, tmp_path / "s", "2021-01-01", providers=provs)
    out = ds.refresh("ETH/USD")
    assert out["quality_status"] in ("ok", "warn") and out["provider"] == "coinbase"
    q = ds.latest_dataset("ETH/USD")["quality"]
    assert q["cross_source"]["secondary"] == "kraken" and q["cross_source"]["status"] == "ok"  # same fixture data
    assert q["kind"] == "historical" and "Not live" in q["label"]
    fx = {m["symbol"]: m for m in ds.status()}["EUR/USD"]
    assert fx["label"] == "Daily ECB reference rates — not live forex quotes." == FX_LABEL
    assert fx["kind"] == "reference"


def test_crypto_universe_configurable():
    assert parse_crypto_assets("") == ("BTC", "ETH")
    assert parse_crypto_assets("sol, xrp ,ETH") == ("BTC", "ETH", "SOL", "XRP")
    with pytest.raises(ValueError):
        parse_crypto_assets("SHIBAINU2")
    inst = build_instruments(parse_crypto_assets("SOL"))
    assert list(inst)[:3] == ["BTC/USD", "ETH/USD", "SOL/USD"]  # crypto first
    assert inst["SOL/USD"].default_spread_bps >= inst["BTC/USD"].default_spread_bps
    assert set(LIQUID_CRYPTO) >= {"BTC", "ETH"}


def test_no_source_is_labelled_live():
    for inst in build_instruments(tuple(LIQUID_CRYPTO)).values():
        for tf in ("1d", "1h"):
            lab = data_label(inst, tf, 60)
            assert lab["kind"] in ("historical", "reference") and "live" not in lab["kind"]
