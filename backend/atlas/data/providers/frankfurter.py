"""Frankfurter (https://frankfurter.dev) — free, keyless ECB daily reference rates.

Important limitations, surfaced to the user:
* One reference fix per business day (~16:00 CET). There is NO open/high/low and NO volume.
* Reference rates are not executable bid/ask quotes.
"""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd

from ..instruments import Instrument
from .base import OHLCV_COLUMNS, Provider, ProviderInfo


class FrankfurterProvider(Provider):
    info = ProviderInfo(
        name="frankfurter",
        url="https://api.frankfurter.dev",
        attribution="European Central Bank euro foreign exchange reference rates via Frankfurter",
        has_ohlc=False,
        has_volume=False,
        notes="Daily ECB reference fix only (close). No OHLC, no volume; not an executable quote.",
    )

    def supports(self, inst: Instrument) -> bool:
        return inst.asset_class == "fx"

    def fetch_daily(self, inst: Instrument, start: date, end: date) -> pd.DataFrame:
        rows: list[dict] = []
        # Chunk by ~1 year to keep responses small and resumable.
        cur = start
        while cur <= end:
            chunk_end = min(end, cur + timedelta(days=365))
            data = self._get(f"{self.info.url}/v1/{cur.isoformat()}..{chunk_end.isoformat()}",
                             params={"base": inst.base, "symbols": inst.quote})
            for day, rates in (data.get("rates") or {}).items():
                if inst.quote in rates:
                    rows.append({"ts": day, "close": float(rates[inst.quote])})
            cur = chunk_end + timedelta(days=1)
        df = pd.DataFrame(rows, columns=["ts", "close"])
        for c in ("open", "high", "low", "volume"):
            df[c] = np.nan
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
        return df[OHLCV_COLUMNS]
