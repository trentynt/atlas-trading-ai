"""Market-data service: provider failover, incremental caching in SQLite, dataset versioning
with immutable on-disk snapshots for exact reproducibility."""
from __future__ import annotations

import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ..db import Database, dumps, loads, utcnow
from ..events import EventBus
from .instruments import INSTRUMENTS, Instrument, get_instrument, slug
from .providers.base import Provider, ProviderError
from .providers.crypto import CoinbaseProvider, KrakenProvider
from .providers.frankfurter import FrankfurterProvider
from .validation import dataset_version, normalize, quality_report, resample

TIMEFRAMES = {"1d": None, "1w": "W-FRI"}


class DataUnavailable(RuntimeError):
    pass


class DataService:
    def __init__(self, db: Database, bus: EventBus, snapshot_dir: Path, history_start: str = "2015-01-01",
                 providers: dict[str, Provider] | None = None, timeout: float = 20.0, min_interval_s: float = 0.35):
        self.db = db
        self.bus = bus
        self.snapshot_dir = snapshot_dir
        self.history_start = date.fromisoformat(history_start)
        self.providers = providers or {
            "frankfurter": FrankfurterProvider(timeout, min_interval_s),
            "coinbase": CoinbaseProvider(timeout, min_interval_s),
            "kraken": KrakenProvider(timeout, min_interval_s),
        }
        self._locks = {s: threading.Lock() for s in INSTRUMENTS}
        self._cache: dict[tuple[str, str], tuple[str, pd.DataFrame]] = {}

    # ---------- ingestion ----------
    def refresh(self, symbol: str, *, full: bool = False) -> dict:
        inst = get_instrument(symbol)
        with self._locks[inst.symbol]:
            last = self.db.one("SELECT MAX(ts) AS ts FROM bars WHERE symbol=? AND timeframe='1d'", (inst.symbol,))["ts"]
            start = self.history_start if (full or not last) else date.fromisoformat(last[:10]) - timedelta(days=7)
            end = datetime.now(timezone.utc).date()
            errors: list[str] = []
            for pname in inst.providers:
                prov = self.providers[pname]
                if not prov.supports(inst):
                    continue
                try:
                    self.bus.emit("data", f"Fetching {inst.symbol} from {pname} ({start}→{end})", source="data",
                                  data={"symbol": inst.symbol, "provider": pname, "node": f"data:{inst.symbol}"})
                    raw = prov.fetch_daily(inst, start, end)
                    clean, norm_report = normalize(raw, drop_open_period=prov.info.has_ohlc)
                    if clean.empty:
                        raise ProviderError(f"{pname} returned no valid rows")
                    return self._store(inst, prov, clean, norm_report)
                except Exception as e:  # failover to next provider
                    errors.append(f"{pname}: {e}")
                    self.bus.emit("data", f"Provider {pname} failed for {inst.symbol}: {e}", level="warn",
                                  source="data", data={"symbol": inst.symbol, "provider": pname})
            msg = f"All providers failed for {inst.symbol}: {'; '.join(errors)}"
            self.bus.emit("data", msg, level="error", source="data", data={"symbol": inst.symbol})
            raise DataUnavailable(msg)

    def _store(self, inst: Instrument, prov: Provider, clean: pd.DataFrame, norm_report: dict) -> dict:
        rows = [(inst.symbol, "1d", ts.date().isoformat(), _f(r.open), _f(r.high), _f(r.low), float(r.close),
                 _f(r.volume), prov.info.name) for ts, r in clean.iterrows()]
        before = self.db.one("SELECT COUNT(*) n FROM bars WHERE symbol=? AND timeframe='1d'", (inst.symbol,))["n"]
        self.db.executemany(
            "INSERT INTO bars(symbol,timeframe,ts,open,high,low,close,volume,provider) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(symbol,timeframe,ts) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,"
            "close=excluded.close,volume=excluded.volume,provider=excluded.provider", rows)
        after = self.db.one("SELECT COUNT(*) n FROM bars WHERE symbol=? AND timeframe='1d'", (inst.symbol,))["n"]
        df = self.load(inst.symbol, use_cache=False)
        version = dataset_version(df)
        quality = quality_report(df, inst.asset_class)
        quality["normalization"] = norm_report
        existing = self.db.one("SELECT id FROM datasets WHERE symbol=? AND timeframe='1d' AND version=?",
                               (inst.symbol, version))
        changed = existing is None
        if changed:
            snap = self.snapshot_dir / f"{slug(inst.symbol)}_1d_{version}.csv.gz"
            df.to_csv(snap, compression="gzip", date_format="%Y-%m-%d")
            self.db.insert("datasets", {
                "symbol": inst.symbol, "timeframe": "1d", "version": version, "provider": prov.info.name,
                "attribution": prov.info.attribution, "start_ts": quality["start"], "end_ts": quality["end"],
                "rows": len(df), "has_ohlc": int(quality["has_ohlc"]), "has_volume": int(quality["has_volume"]),
                "quality_json": dumps(quality), "created_at": utcnow()})
        summary = {"symbol": inst.symbol, "provider": prov.info.name, "version": version, "changed": changed,
                   "new_rows": after - before, "rows": len(df), "end": quality["end"],
                   "missing_periods": quality["missing_periods"], "stale_days": quality["stale_days"]}
        self.bus.emit("data", f"{inst.symbol}: {len(df)} bars, +{after - before} new, version {version}"
                      f"{' (new dataset version)' if changed else ' (unchanged)'}", source="data",
                      data={**summary, "node": f"data:{inst.symbol}"})
        return summary

    def refresh_all(self) -> list[dict]:
        out = []
        for s in INSTRUMENTS:
            try:
                out.append(self.refresh(s))
            except DataUnavailable as e:
                out.append({"symbol": s, "error": str(e)})
        return out

    # ---------- access ----------
    def load(self, symbol: str, timeframe: str = "1d", *, use_cache: bool = True) -> pd.DataFrame:
        inst = get_instrument(symbol)
        if timeframe not in TIMEFRAMES:
            raise ValueError(f"timeframe must be one of {list(TIMEFRAMES)}")
        key = (inst.symbol, timeframe)
        stamp = self.db.one("SELECT COUNT(*) n, MAX(ts) m FROM bars WHERE symbol=? AND timeframe='1d'", (inst.symbol,))
        stamp_s = f"{stamp['n']}:{stamp['m']}"
        if use_cache and key in self._cache and self._cache[key][0] == stamp_s:
            return self._cache[key][1].copy()
        rows = self.db.query("SELECT ts,open,high,low,close,volume FROM bars WHERE symbol=? AND timeframe='1d' ORDER BY ts",
                             (inst.symbol,))
        df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
        df = df.set_index("ts").astype(float)
        if TIMEFRAMES[timeframe]:
            df = resample(df, TIMEFRAMES[timeframe])
        self._cache[key] = (stamp_s, df)
        return df.copy()

    def require(self, symbol: str, timeframe: str = "1d", min_rows: int = 200) -> pd.DataFrame:
        df = self.load(symbol, timeframe)
        if len(df) < min_rows:
            raise DataUnavailable(f"{symbol} has {len(df)} {timeframe} bars (< {min_rows}). Refresh market data first.")
        return df

    def latest_dataset(self, symbol: str) -> dict | None:
        r = self.db.one("SELECT * FROM datasets WHERE symbol=? AND timeframe='1d' ORDER BY id DESC LIMIT 1", (symbol,))
        if r:
            r["quality"] = loads(r.pop("quality_json"), {})
        return r

    def load_version(self, symbol: str, version: str) -> pd.DataFrame:
        snap = self.snapshot_dir / f"{slug(symbol)}_1d_{version}.csv.gz"
        if not snap.exists():
            raise DataUnavailable(f"Snapshot for {symbol} version {version} not found")
        df = pd.read_csv(snap, parse_dates=["ts"], index_col="ts")
        df.index = pd.to_datetime(df.index, utc=True)
        return df.astype(float)

    def status(self) -> list[dict]:
        out = []
        for s, inst in INSTRUMENTS.items():
            ds = self.latest_dataset(s)
            last = self.db.one("SELECT ts, close FROM bars WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 2", (s,))
            prev = self.db.query("SELECT close FROM bars WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 2", (s,))
            chg = (prev[0]["close"] / prev[1]["close"] - 1) if len(prev) == 2 else None
            prov = self.providers.get(ds["provider"]) if ds else None
            stale = None
            if last:
                stale = (datetime.now(timezone.utc) - datetime.fromisoformat(last["ts"]).replace(tzinfo=timezone.utc)).days
            out.append({
                "symbol": s, "asset_class": inst.asset_class, "providers": list(inst.providers),
                "last_ts": last["ts"] if last else None, "last_close": last["close"] if last else None,
                "change_1d": chg, "rows": ds["rows"] if ds else 0, "version": ds["version"] if ds else None,
                "provider": ds["provider"] if ds else None, "attribution": ds["attribution"] if ds else None,
                "has_ohlc": bool(ds["has_ohlc"]) if ds else None, "has_volume": bool(ds["has_volume"]) if ds else None,
                "provider_notes": prov.info.notes if prov else None, "stale_days": stale,
                "is_stale": stale is not None and stale > inst.max_stale_days,
                "missing_periods": ds["quality"].get("missing_periods") if ds else None,
                "price_decimals": inst.price_decimals,
            })
        return out


def _f(x) -> float | None:
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else float(x)
