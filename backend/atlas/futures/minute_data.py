"""1-minute bars for the intraday research track, plus an independent daily close for cross-checks.

Source choice (details and sources in docs/LEARN.md):
* No free source offers years of 1-minute NQ/MNQ futures history. So ATLAS uses **QQQ** (the Nasdaq-100
  ETF) 1-minute bars as a **PROXY** for the index the futures track. QQQ and MNQ move together closely
  but are not identical (different hours, a small basis, dividends, no leverage). Every result built on
  this data is labelled as proxy-based.
* Minute bars: Alpaca Market Data API, free plan, SIP (all-exchange) feed, raw prices, only bars at least
  15 minutes old (free-plan rule). Keys: ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY.
* Independent daily closes: Tiingo end-of-day API (free key: TIINGO_API_KEY), raw (unadjusted) close.

Only Regular Trading Hours bars are stored: 09:30–15:59 New York time, labelled by bar START, so the
09:30 bar covers 09:30:00–09:30:59 and the 15:59 bar is the last full minute before the 16:00 close.
"""
from __future__ import annotations

import os
import time
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx
import pandas as pd

from ..db import Database, utcnow
from .calendar import OPEN_MIN, close_minute

NY = ZoneInfo("America/New_York")
PROXY_SYMBOL = "QQQ"
ALPACA_URL = "https://data.alpaca.markets/v2/stocks/{symbol}/bars"
TIINGO_URL = "https://api.tiingo.com/tiingo/daily/{symbol}/prices"


class MissingKey(RuntimeError):
    pass


def _env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise MissingKey(f"Set the {name} environment variable (see docs/LEARN.md, 'Adding your data keys').")
    return v


def rth_only(df: pd.DataFrame) -> pd.DataFrame:
    """Keep bars whose START falls inside the regular session (New York time, weekdays):
    09:30–15:59 normally, 09:30–12:59 on early-close days (see calendar.py). Bars after an early
    close are thin after-hours trades, not part of the session."""
    if df.empty:
        return df
    local = df.index.tz_convert(NY)
    mins = local.hour * 60 + local.minute
    close = pd.Index(local.date.astype(str)).map(close_minute).to_numpy()
    keep = (mins >= OPEN_MIN) & (mins < close) & (local.weekday < 5)
    return df[keep]


def complete_sessions(df: pd.DataFrame, now: datetime | None = None) -> pd.DataFrame:
    """Drop sessions that are not whole: one still in progress, or one cut off at the start of the stored
    history (no 09:30 bar on the first stored day). Nothing is deleted from the database."""
    if df.empty:
        return df
    local = df.index.tz_convert(NY)
    day = pd.Index(local.date.astype(str))
    drop = set()
    first = day[0]
    if local[0].strftime("%H:%M") != "09:30":
        drop.add(first)
    now_ny = pd.Timestamp(now or datetime.now(timezone.utc)).tz_convert(NY)
    today = now_ny.date().isoformat()
    if day[-1] == today and now_ny.hour * 60 + now_ny.minute < close_minute(today) + 20:
        drop.add(today)
    return df[~day.isin(list(drop))] if drop else df


class AlpacaMinuteBars:
    """Alpaca historical 1-minute bars, paginated (up to 10,000 bars per page)."""

    def __init__(self, client: httpx.Client | None = None, min_interval_s: float = 0.35):
        self.client = client or httpx.Client(timeout=30, headers={"User-Agent": "atlas-personal-research/0.1"})
        self.min_interval_s = min_interval_s

    def _headers(self) -> dict:
        return {"APCA-API-KEY-ID": _env("ALPACA_API_KEY_ID"), "APCA-API-SECRET-KEY": _env("ALPACA_API_SECRET_KEY")}

    def fetch(self, symbol: str, start: datetime, end: datetime | None = None) -> pd.DataFrame:
        # Free plan: the most recent 15 minutes are not available; stay 20 minutes clear.
        latest = datetime.now(timezone.utc) - timedelta(minutes=20)
        end = min(end or latest, latest)
        params = {"timeframe": "1Min", "start": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                  "end": end.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                  "limit": 10000, "adjustment": "raw", "feed": "sip", "sort": "asc"}
        rows: list[dict] = []
        headers = self._headers()
        while True:
            r = self._get(ALPACA_URL.format(symbol=symbol), params, headers)
            rows.extend(r.get("bars") or [])
            token = r.get("next_page_token")
            if not token:
                break
            params["page_token"] = token
        if not rows:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        df = pd.DataFrame(rows).rename(columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})
        df.index = pd.to_datetime(df.pop("t"), utc=True)
        return df[["open", "high", "low", "close", "volume"]].astype(float)

    def _get(self, url: str, params: dict, headers: dict) -> dict:
        delay = 2.0
        for attempt in range(5):
            time.sleep(self.min_interval_s)
            r = self.client.get(url, params=params, headers=headers)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(delay)
                delay *= 2
                continue
            if r.status_code in (401, 403):
                raise MissingKey(f"Alpaca rejected the keys (HTTP {r.status_code}). Check ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY.")
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"Alpaca: gave up after retries ({url})")


class TiingoDaily:
    def __init__(self, client: httpx.Client | None = None):
        self.client = client or httpx.Client(timeout=30, headers={"User-Agent": "atlas-personal-research/0.1"})

    def fetch(self, symbol: str, start: date, end: date | None = None) -> pd.Series:
        params = {"startDate": start.isoformat(), "endDate": (end or date.today()).isoformat(), "token": _env("TIINGO_API_KEY")}
        r = self.client.get(TIINGO_URL.format(symbol=symbol.lower()), params=params)
        if r.status_code in (401, 403):
            raise MissingKey(f"Tiingo rejected the key (HTTP {r.status_code}). Check TIINGO_API_KEY.")
        r.raise_for_status()
        data = r.json()
        s = pd.Series({str(d["date"])[:10]: float(d["close"]) for d in data}, dtype=float)  # raw close, not adjClose
        return s.sort_index()


class MinuteStore:
    def __init__(self, db: Database):
        self.db = db

    def save(self, symbol: str, df: pd.DataFrame, source: str) -> int:
        df = rth_only(df)
        self.db.executemany(
            "INSERT INTO minute_bars(symbol,ts,open,high,low,close,volume,source) VALUES(?,?,?,?,?,?,?,?) "
            "ON CONFLICT(symbol,ts) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,"
            "close=excluded.close,volume=excluded.volume,source=excluded.source",
            [(symbol, t.isoformat(), r.open, r.high, r.low, r.close, r.volume, source) for t, r in df.iterrows()])
        return len(df)

    def save_daily(self, symbol: str, s: pd.Series, source: str) -> int:
        self.db.executemany("INSERT OR REPLACE INTO reference_daily(symbol,date,close,source) VALUES(?,?,?,?)",
                            [(symbol, d, float(c), source) for d, c in s.items()])
        return len(s)

    def load(self, symbol: str, start: str | None = None, end: str | None = None, raw: bool = False) -> pd.DataFrame:
        q, a = "SELECT ts,open,high,low,close,volume FROM minute_bars WHERE symbol=?", [symbol]
        if start:
            q += " AND ts >= ?"; a.append(start)
        if end:
            q += " AND ts < ?"; a.append(end)
        df = pd.DataFrame(self.db.query(q + " ORDER BY ts", tuple(a)), columns=["ts", "open", "high", "low", "close", "volume"])
        df.index = pd.to_datetime(df.pop("ts"), utc=True, format="ISO8601")
        df = df.astype(float)
        # Re-apply the session calendar on read, so rows stored before a calendar fix are still filtered.
        return complete_sessions(rth_only(df)) if raw is False else df

    def load_daily(self, symbol: str, source: str = "tiingo") -> pd.Series:
        rows = self.db.query("SELECT date, close FROM reference_daily WHERE symbol=? AND source=? ORDER BY date", (symbol, source))
        return pd.Series({r["date"]: r["close"] for r in rows}, dtype=float)

    def last_ts(self, symbol: str) -> str | None:
        return self.db.one("SELECT MAX(ts) m FROM minute_bars WHERE symbol=?", (symbol,))["m"]

    def sessions(self, symbol: str) -> list[str]:
        """Dates (New York) that have at least one stored RTH bar."""
        df = self.load(symbol)
        return sorted({d.isoformat() for d in df.index.tz_convert(NY).date}) if len(df) else []


def download(db: Database, years: float = 3.5, symbol: str = PROXY_SYMBOL, log=print) -> dict:
    """Fetch (incrementally) minute bars and independent daily closes. Requires the API keys."""
    store = MinuteStore(db)
    start = datetime.now(timezone.utc) - timedelta(days=int(years * 365.25))
    last = store.last_ts(symbol)
    m_start = max(start, datetime.fromisoformat(last) - timedelta(days=1)) if last else start
    alp = AlpacaMinuteBars()
    total = 0
    cur = m_start
    now = datetime.now(timezone.utc)
    while cur < now:  # month-sized chunks so progress is saved as it goes
        nxt = min(cur + timedelta(days=31), now)
        n = store.save(symbol, alp.fetch(symbol, cur, nxt), "alpaca_sip")
        total += n
        log(f"{symbol} minute bars {cur.date()} → {nxt.date()}: {n} RTH bars")
        cur = nxt
    daily = TiingoDaily().fetch(symbol, start.date())
    nd = store.save_daily(symbol, daily, "tiingo")
    log(f"{symbol} Tiingo daily closes: {nd}")
    db.kv_set(f"minute_data:{symbol}", {"updated_at": utcnow(), "minute_source": "alpaca_sip (free plan)",
                                        "daily_source": "tiingo", "proxy_for": "MNQ"})
    return {"symbol": symbol, "minute_bars_saved": total, "daily_closes": nd}
