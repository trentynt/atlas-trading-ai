"""Phase 2: minute-data providers (mocked HTTP) and the fixed data-quality gate."""
from __future__ import annotations

import json

import httpx
import numpy as np
import pandas as pd
import pytest

from atlas.db import Database
from atlas.futures import gate as G
from atlas.futures.minute_data import NY, AlpacaMinuteBars, MinuteStore, MissingKey, TiingoDaily, rth_only


def session_minutes(days: pd.DatetimeIndex, drop: dict | None = None, price0: float = 400.0, seed: int = 0):
    """Synthetic RTH minute bars (TEST DATA ONLY) for the given New York dates."""
    rng = np.random.default_rng(seed)
    out, daily = [], {}
    px = price0
    for d in days:
        ts = pd.date_range(pd.Timestamp(d.date().isoformat() + " 09:30", tz=NY), periods=390, freq="min")
        r = rng.normal(0, 0.0004, 390)
        c = px * np.exp(np.cumsum(r))
        df = pd.DataFrame({"open": np.r_[px, c[:-1]], "close": c}, index=ts.tz_convert("UTC"))
        df["high"] = df[["open", "close"]].max(axis=1) * 1.0002
        df["low"] = df[["open", "close"]].min(axis=1) * 0.9998
        df["volume"] = 1000.0
        if drop and d.date().isoformat() in drop:
            df = df.drop(df.index[drop[d.date().isoformat()]])
        out.append(df)
        daily[d.date().isoformat()] = float(c[-1])
        px = c[-1]
    return pd.concat(out), pd.Series(daily)


def bdays(years=3.2):
    return pd.bdate_range("2022-01-03", periods=int(252 * years))


def test_thresholds_are_the_specified_values_and_immutable():
    assert dict(G.THRESHOLDS) == {"G1_min_years": 3.0, "G2_min_median_bars": 380, "G2_session_bars": 390,
                                  "G3_max_bps": 10.0, "G3_min_share": 0.95, "G4_min_share": 0.95}
    with pytest.raises(TypeError):
        G.THRESHOLDS["G3_max_bps"] = 50  # type: ignore[index]


def test_clean_data_passes():
    m, d = session_minutes(bdays())
    r = G.evaluate(m, d)
    assert r["passed"], r["checks"]
    assert r["checks"]["G2"]["value"] == 390 and r["checks"]["G3"]["value"] == 1.0


def test_short_history_fails_g1():
    m, d = session_minutes(bdays(2.0))
    r = G.evaluate(m, d)
    assert not r["checks"]["G1"]["passed"] and not r["passed"]


def test_thin_sessions_fail_g2():
    days = bdays()
    m, d = session_minutes(days, drop={x.date().isoformat(): list(range(100, 120)) for x in days})
    assert not G.evaluate(m, d)["checks"]["G2"]["passed"]  # 370 bars


def test_wrong_closes_fail_g3_and_missing_days_count_as_misses():
    m, d = session_minutes(bdays())
    bad = d.copy()
    bad.iloc[::10] *= 1.002  # 20 bps off on 10% of days
    assert not G.evaluate(m, bad)["checks"]["G3"]["passed"]
    # a whole missing session in the minute data is a G3 miss, not silently skipped
    keep = m[m.index.tz_convert(NY).date.astype(str) != d.index[100]]
    r = G.evaluate(keep, d)
    assert r["checks"]["G3"]["value"] < 1.0 and "1 session(s) with no minute data" in r["checks"]["G2"]["detail"]


def test_missing_open_bars_fail_g4():
    days = bdays()
    m, d = session_minutes(days, drop={x.date().isoformat(): [0] for x in days[::10]})
    assert G.evaluate(m, d)["checks"]["G4"]["value"] == pytest.approx(0.9, abs=0.01)
    assert not G.evaluate(m, d)["checks"]["G4"]["passed"]


def test_rth_filter_keeps_0930_to_1559_new_york():
    ts = pd.DatetimeIndex(["2025-03-03 14:29", "2025-03-03 14:30", "2025-03-03 20:59", "2025-03-03 21:00"], tz="UTC")
    df = pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1.0}, index=ts)
    kept = rth_only(df).index.tz_convert(NY).strftime("%H:%M").tolist()
    assert kept == ["09:30", "15:59"]  # EST in March before DST: 14:30Z = 09:30 ET


def test_alpaca_paginates_sends_keys_and_requests_raw_sip(monkeypatch):
    monkeypatch.setenv("ALPACA_API_KEY_ID", "kid")
    monkeypatch.setenv("ALPACA_API_SECRET_KEY", "sec")
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        q = dict(req.url.params)
        assert q["adjustment"] == "raw" and q["feed"] == "sip" and q["timeframe"] == "1Min"
        page = q.get("page_token")
        bar = {"t": "2025-03-03T14:30:00Z" if not page else "2025-03-03T14:31:00Z", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}
        return httpx.Response(200, json={"bars": [bar], "next_page_token": None if page else "p2"})

    a = AlpacaMinuteBars(httpx.Client(transport=httpx.MockTransport(handler)), min_interval_s=0)
    df = a.fetch("QQQ", pd.Timestamp("2025-03-03", tz="UTC").to_pydatetime(), pd.Timestamp("2025-03-04", tz="UTC").to_pydatetime())
    assert len(df) == 2 and len(seen) == 2
    assert seen[0].headers["APCA-API-KEY-ID"] == "kid" and seen[0].headers["APCA-API-SECRET-KEY"] == "sec"


def test_missing_keys_give_clear_error(monkeypatch):
    for k in ("ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "TIINGO_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    with pytest.raises(MissingKey, match="ALPACA_API_KEY_ID"):
        AlpacaMinuteBars(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))), 0).fetch(
            "QQQ", pd.Timestamp("2025-03-03", tz="UTC").to_pydatetime())
    with pytest.raises(MissingKey, match="TIINGO_API_KEY"):
        TiingoDaily(httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500)))).fetch("QQQ", pd.Timestamp("2025-01-01").date())


def test_tiingo_uses_raw_close_not_adjusted(monkeypatch):
    monkeypatch.setenv("TIINGO_API_KEY", "t")
    h = lambda r: httpx.Response(200, json=[{"date": "2025-03-03T00:00:00.000Z", "close": 500.0, "adjClose": 497.1}])
    s = TiingoDaily(httpx.Client(transport=httpx.MockTransport(h))).fetch("QQQ", pd.Timestamp("2025-03-01").date())
    assert s.to_dict() == {"2025-03-03": 500.0}


def test_store_roundtrip_and_gate_run(tmp_path):
    db = Database(tmp_path / "m.db")
    m, d = session_minutes(bdays(3.2))
    st = MinuteStore(db)
    pre = m.copy()
    pre.index = pre.index - pd.Timedelta(hours=2)  # pre-market rows must not be stored
    st.save("QQQ", pd.concat([pre.iloc[:50], m]), "test")
    st.save_daily("QQQ", d, "tiingo")
    assert len(st.load("QQQ")) == len(m)
    r = G.run(db)
    assert r["passed"] and db.kv_get("data_gate:QQQ")["passed"]
