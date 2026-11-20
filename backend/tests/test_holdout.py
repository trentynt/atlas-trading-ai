"""Sealed intraday holdout: excluded by default, explicit logged unlocks, later data not sealed."""
import pandas as pd
import pytest

from atlas.db import Database
from atlas.futures import holdout as H
from atlas.futures.minute_data import NY, MinuteStore
from atlas.futures.practice import Practice, PracticeError
from atlas.futures.stats import describe

from .test_minute_data import session_minutes


@pytest.fixture
def store(tmp_path):
    db = Database(tmp_path / "h.db")
    days = pd.bdate_range("2026-01-05", "2026-12-04")  # before, inside and after the sealed window
    m, d = session_minutes(days)
    st = MinuteStore(db)
    st.save("QQQ", m, "test")
    return db, st


def days_of(df):
    return sorted(set(df.index.tz_convert(NY).date.astype(str)))


def test_window_is_fixed():
    assert (H.SEALED_ON, H.HOLDOUT_START, H.HOLDOUT_END) == ("2026-11-20", "2026-02-20", "2026-11-19")


def test_default_reads_exclude_holdout_but_keep_later_data(store):
    db, st = store
    d = days_of(st.load("QQQ"))
    assert not any(H.HOLDOUT_START <= x <= H.HOLDOUT_END for x in d)
    assert d[0] < H.HOLDOUT_START and d[-1] > H.HOLDOUT_END  # data after sealing day stays usable
    assert H.unlocks(db) == []
    assert not any(H.in_holdout(x) for x in st.sessions("QQQ"))
    assert describe(st.load("QQQ"))["sessions"] == len(d)


def test_unlock_requires_reason_and_is_logged(store):
    db, st = store
    with pytest.raises(PermissionError):
        st.load("QQQ", unlock_reason=" ")
    full = st.load("QQQ", unlock_reason="final check of idea #1", purpose="test")
    assert any(H.in_holdout(x) for x in days_of(full))
    log = H.unlocks(db)
    assert len(log) == 1 and log[0]["reason"] == "final check of idea #1" and log[0]["window"] == "2026-02-20..2026-11-19"


def test_practice_refuses_sealed_dates_without_unlock(store):
    db, st = store
    p = Practice(db)
    with pytest.raises(PracticeError, match="sealed holdout"):
        p.start("2026-06-01")
    v = p.start("2026-06-01", unlock_reason="practise on a sealed day, deliberately")
    assert len(v["bars"]) == 1 and len(H.unlocks(db)) >= 1
    n = len(H.unlocks(db))
    p.step(v["id"])
    assert len(H.unlocks(db)) > n  # every read of the sealed session is logged
    assert p.start("2026-12-01")["session_date"] == "2026-12-01"  # after the window: no unlock needed
