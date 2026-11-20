"""Phase 4: descriptive opening statistics on hand-built sessions with known answers."""
import pandas as pd
import pytest

from atlas.futures import stats
from atlas.futures.minute_data import NY


def day(date, rows):
    idx = pd.date_range(pd.Timestamp(f"{date} 09:30", tz=NY), periods=len(rows), freq="min").tz_convert("UTC")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx).assign(volume=1.0)


def bar(p, w=0.1):
    return (p, p + w, p - w, p)


def test_opening_range_size_and_break_direction():
    # 5-minute range 99.9–100.5 (open 100); breaks UP at minute 7, never down
    d1 = day("2025-03-04", [bar(100), bar(100.2), bar(100.4), bar(100.3), bar(100.1), bar(100.2), bar(100.3), bar(100.7), bar(100.8)])
    r = stats.opening_range(d1, minutes=5)
    assert r["days"] == 1 and r["size_bps"]["median"] == pytest.approx(60.0, abs=0.01)  # (100.5-99.9)/100
    assert r["broke_up_pct"] == 100.0 and r["broke_down_pct"] == 0.0 and r["first_break_up_pct"] == 100.0
    assert r["minutes_to_first_break"]["median"] == 3.0  # 09:37 vs last OR bar 09:34
    assert r["close_vs_range_pct"] == {"above": 100.0}


def test_gap_fill_detected_and_timed():
    d1 = day("2025-03-04", [bar(100)] * 3)  # previous close 100
    d2 = day("2025-03-05", [bar(101), bar(100.6), bar(100.05)])  # gaps up 100 bps; low 99.95 at 09:32 fills
    d3 = day("2025-03-06", [bar(99), bar(98.9), bar(98.8)])  # gaps down from 100.05; never fills
    g = stats.gaps(pd.concat([d1, d2, d3]))
    assert g["days"] == 2 and g["fill_pct"] == 50.0 and g["up_gaps"] == 1 and g["down_gaps"] == 1
    assert g["by_size"] == [{"bucket": "≥ 100 bps", "days": 2, "fill_pct": 50.0, "median_minutes_to_fill": 2.0}]


def test_volatility_by_time_buckets_and_excludes_overnight():
    d1 = day("2025-03-04", [bar(100)] * 20)
    d2 = day("2025-03-05", [bar(150)] + [bar(150 * (1.001 if i % 2 else 1)) for i in range(19)])  # big overnight jump ignored
    v = stats.volatility_by_time(pd.concat([d1, d2]), bucket_minutes=15)
    assert [b["from"] for b in v] == ["09:30", "09:45"]
    assert max(b["mean_abs_move_bps"] for b in v) < 10  # the 50% overnight jump is not counted
