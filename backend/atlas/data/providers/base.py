"""Provider abstraction with client-side rate limiting and retry/backoff."""
from __future__ import annotations

import abc
import threading
import time
from dataclasses import dataclass
from datetime import date

import httpx
import pandas as pd

from ..instruments import Instrument

OHLCV_COLUMNS = ["ts", "open", "high", "low", "close", "volume"]


class ProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProviderInfo:
    name: str
    url: str
    attribution: str
    has_ohlc: bool
    has_volume: bool
    notes: str


class Provider(abc.ABC):
    info: ProviderInfo

    def __init__(self, timeout: float = 20.0, min_interval_s: float = 0.35, max_retries: int = 4,
                 client: httpx.Client | None = None):
        self.timeout = timeout
        self.min_interval_s = min_interval_s
        self.max_retries = max_retries
        self._client = client or httpx.Client(timeout=timeout, headers={"User-Agent": "atlas-research/0.1"})
        self._last = 0.0
        self._lock = threading.Lock()

    def _get(self, url: str, params: dict | None = None):
        delay = 1.0
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            with self._lock:  # rate limit: at most one request per min_interval_s
                wait = self.min_interval_s - (time.monotonic() - self._last)
                if wait > 0:
                    time.sleep(wait)
                self._last = time.monotonic()
            try:
                r = self._client.get(url, params=params)
                if r.status_code == 429 or r.status_code >= 500:
                    retry_after = float(r.headers.get("Retry-After", delay))
                    last_err = ProviderError(f"{self.info.name}: HTTP {r.status_code}")
                    time.sleep(min(retry_after, 30))
                    delay *= 2
                    continue
                if r.status_code >= 400:
                    raise ProviderError(f"{self.info.name}: HTTP {r.status_code} {r.text[:200]}")
                return r.json()
            except (httpx.TransportError, ValueError) as e:
                last_err = e
                time.sleep(delay)
                delay *= 2
        raise ProviderError(f"{self.info.name}: failed after {self.max_retries} attempts: {last_err}")

    @abc.abstractmethod
    def supports(self, inst: Instrument) -> bool: ...

    @abc.abstractmethod
    def fetch_daily(self, inst: Instrument, start: date, end: date) -> pd.DataFrame:
        """Return raw daily rows with OHLCV_COLUMNS (ts as UTC timestamps). NaN where unavailable."""
