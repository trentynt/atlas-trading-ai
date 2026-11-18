"""Test fixtures. SYNTHETIC data is used ONLY inside tests (deterministic, no network)."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from atlas.config import Settings
from atlas.data.instruments import Instrument
from atlas.data.providers.base import OHLCV_COLUMNS, Provider, ProviderInfo


def synthetic_ohlcv(n: int = 1500, seed: int = 1, start: str = "2020-01-01", drift: float = 0.0003,
                    vol: float = 0.02, ohlc: bool = True, freq: str = "D", end: date | None = None) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    if end is not None:
        idx = pd.date_range(end=pd.Timestamp(end), periods=n, freq=freq, tz="UTC")
    else:
        idx = pd.date_range(start, periods=n, freq=freq, tz="UTC")
    # regime-switching drift so trend strategies have something to find
    regime = np.sign(np.sin(np.arange(n) / 90.0))
    r = drift + 0.0015 * regime + rng.normal(0, vol, n)
    close = 100 * np.exp(np.cumsum(r))
    open_ = close * np.exp(rng.normal(0, vol / 4, n))
    high = np.maximum(open_, close) * np.exp(np.abs(rng.normal(0, vol / 3, n)))
    low = np.minimum(open_, close) * np.exp(-np.abs(rng.normal(0, vol / 3, n)))
    df = pd.DataFrame({"open": open_, "high": high, "low": low, "close": close,
                       "volume": rng.uniform(100, 1000, n)}, index=idx)
    if not ohlc:
        df[["open", "high", "low", "volume"]] = np.nan
    df.index.name = "ts"
    return df


class FakeProvider(Provider):
    """Deterministic offline provider used by integration tests."""

    def __init__(self, ohlc: bool, name: str):
        super().__init__(min_interval_s=0)
        self.info = ProviderInfo(name, "test://", "SYNTHETIC TEST DATA", ohlc, ohlc, "test fixture")
        self.calls = 0

    def supports(self, inst: Instrument) -> bool:
        return (inst.asset_class == "crypto") == self.info.has_ohlc

    def fetch_daily(self, inst, start, end):
        self.calls += 1
        y = datetime.now(timezone.utc).date() - timedelta(days=1)
        seed = sum(map(ord, inst.symbol))
        df = synthetic_ohlcv(1300, seed=seed, ohlc=self.info.has_ohlc, freq="D" if self.info.has_ohlc else "B", end=y,
                             vol=0.03 if self.info.has_ohlc else 0.006)
        df = df[(df.index.date >= start) & (df.index.date <= end)].reset_index()
        return df[OHLCV_COLUMNS]


class FailingProvider(FakeProvider):
    def fetch_daily(self, inst, start, end):
        self.calls += 1
        raise RuntimeError("simulated outage")


@pytest.fixture
def settings(tmp_path) -> Settings:
    s = Settings(data_dir=tmp_path, history_start="2020-01-01", worker_threads=2, max_job_runtime_s=300)
    (tmp_path / "snapshots").mkdir()
    return s


@pytest.fixture
def providers():
    return {"frankfurter": FakeProvider(False, "frankfurter"), "coinbase": FailingProvider(True, "coinbase"),
            "kraken": FakeProvider(True, "kraken")}
