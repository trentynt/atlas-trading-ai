"""Keyless public crypto market-data endpoints.

* Coinbase Exchange public candles (primary): https://docs.cdp.coinbase.com/exchange/reference/exchangerestapi_getproductcandles
  Max 300 candles per request; daily candles are UTC-aligned.
* Kraken public OHLC (failover): https://docs.kraken.com/api/docs/rest-api/get-ohlc-data
  Returns only the most recent 720 candles regardless of `since`.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pandas as pd

from ..instruments import Instrument
from .base import OHLCV_COLUMNS, Provider, ProviderInfo


class CoinbaseProvider(Provider):
    info = ProviderInfo(
        name="coinbase",
        url="https://api.exchange.coinbase.com",
        attribution="Coinbase Exchange public market data",
        has_ohlc=True,
        has_volume=True,
        notes="Daily UTC candles from a single venue (Coinbase). Volume is venue volume in base currency.",
    )

    def supports(self, inst: Instrument) -> bool:
        return inst.asset_class == "crypto"

    def fetch_daily(self, inst: Instrument, start: date, end: date) -> pd.DataFrame:
        product = f"{inst.base}-{inst.quote}"
        rows: list[list] = []
        cur = start
        while cur <= end:
            chunk_end = min(end, cur + timedelta(days=299))
            data = self._get(f"{self.info.url}/products/{product}/candles", params={
                "granularity": 86400,
                "start": datetime.combine(cur, datetime.min.time(), timezone.utc).isoformat(),
                "end": datetime.combine(chunk_end, datetime.min.time(), timezone.utc).isoformat(),
            })
            if isinstance(data, list):
                rows.extend(data)
            cur = chunk_end + timedelta(days=1)
        # Coinbase rows: [time, low, high, open, close, volume]
        df = pd.DataFrame(rows, columns=["t", "low", "high", "open", "close", "volume"])
        df["ts"] = pd.to_datetime(df["t"], unit="s", utc=True)
        return df[OHLCV_COLUMNS].astype({c: float for c in OHLCV_COLUMNS[1:]})


class KrakenProvider(Provider):
    info = ProviderInfo(
        name="kraken",
        url="https://api.kraken.com",
        attribution="Kraken public market data",
        has_ohlc=True,
        has_volume=True,
        notes="Failover only. Kraken returns at most the latest 720 daily candles.",
    )
    PAIRS = {"BTC": "XBTUSD", "ETH": "ETHUSD"}

    def supports(self, inst: Instrument) -> bool:
        return inst.asset_class == "crypto" and inst.base in self.PAIRS and inst.quote == "USD"

    def fetch_daily(self, inst: Instrument, start: date, end: date) -> pd.DataFrame:
        since = int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp())
        data = self._get(f"{self.info.url}/0/public/OHLC",
                         params={"pair": self.PAIRS[inst.base], "interval": 1440, "since": since})
        if data.get("error"):
            raise RuntimeError(f"kraken: {data['error']}")
        result = {k: v for k, v in data["result"].items() if k != "last"}
        rows = next(iter(result.values()), [])
        # [time, open, high, low, close, vwap, volume, count]
        df = pd.DataFrame(rows, columns=["t", "open", "high", "low", "close", "vwap", "volume", "count"])
        df["ts"] = pd.to_datetime(df["t"].astype(int), unit="s", utc=True)
        df = df[OHLCV_COLUMNS].astype({c: float for c in OHLCV_COLUMNS[1:]})
        end_ts = pd.Timestamp(end, tz="UTC")
        return df[df["ts"] <= end_ts]
