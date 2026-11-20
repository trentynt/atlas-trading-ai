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

    GRANULARITY = {"1d": 86400, "6h": 21600, "1h": 3600}

    def fetch_daily(self, inst: Instrument, start: date, end: date) -> pd.DataFrame:
        return self.fetch_candles(inst, start, end, "1d")

    def fetch_candles(self, inst: Instrument, start: date, end: date, timeframe: str) -> pd.DataFrame:
        product = f"{inst.base}-{inst.quote}"
        g = self.GRANULARITY[timeframe]
        rows: list[list] = []
        cur = datetime.combine(start, datetime.min.time(), timezone.utc)
        stop = datetime.combine(end, datetime.min.time(), timezone.utc) + timedelta(days=1)
        while cur < stop:  # at most 300 candles per request
            chunk_end = min(stop, cur + timedelta(seconds=g * 299))
            data = self._get(f"{self.info.url}/products/{product}/candles", params={
                "granularity": g, "start": cur.isoformat(), "end": chunk_end.isoformat()})
            if isinstance(data, list):
                # Documented order is newest-first; reverse the chunk (not sort) so genuine disorder stays visible.
                rows.extend(reversed(data))
            cur = chunk_end + timedelta(seconds=g)
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
        notes="Failover and cross-check only. Kraken returns at most the latest 720 candles per interval.",
    )
    PAIRS = {"BTC": "XBTUSD", "ETH": "ETHUSD", "SOL": "SOLUSD", "XRP": "XRPUSD", "LTC": "LTCUSD", "ADA": "ADAUSD",
             "DOGE": "XDGUSD", "AVAX": "AVAXUSD", "LINK": "LINKUSD", "DOT": "DOTUSD"}
    INTERVAL = {"1d": 1440, "1h": 60}  # Kraken has no 6h interval; 4h is never substituted

    def supports(self, inst: Instrument) -> bool:
        return inst.asset_class == "crypto" and inst.base in self.PAIRS and inst.quote == "USD"

    def fetch_daily(self, inst: Instrument, start: date, end: date) -> pd.DataFrame:
        return self.fetch_candles(inst, start, end, "1d")

    def fetch_candles(self, inst: Instrument, start: date, end: date, timeframe: str) -> pd.DataFrame:
        if timeframe not in self.INTERVAL:
            raise ValueError(f"kraken has no {timeframe} interval")
        since = int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp())
        data = self._get(f"{self.info.url}/0/public/OHLC",
                         params={"pair": self.PAIRS[inst.base], "interval": self.INTERVAL[timeframe], "since": since})
        if data.get("error"):
            raise RuntimeError(f"kraken: {data['error']}")
        result = {k: v for k, v in data["result"].items() if k != "last"}
        rows = next(iter(result.values()), [])
        # [time, open, high, low, close, vwap, volume, count]
        df = pd.DataFrame(rows, columns=["t", "open", "high", "low", "close", "vwap", "volume", "count"])
        df["ts"] = pd.to_datetime(df["t"].astype(int), unit="s", utc=True)
        df = df[OHLCV_COLUMNS].astype({c: float for c in OHLCV_COLUMNS[1:]})
        end_ts = pd.Timestamp(end, tz="UTC") + pd.Timedelta(days=1)
        return df[df["ts"] < end_ts]
