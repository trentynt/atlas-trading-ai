"""Market-data service: licensing-aware provider failover, validation with quarantine (never repair),
cross-source checks, incremental caching in SQLite, and dataset versioning with immutable on-disk
snapshots for exact reproducibility.

Labels (shown to users; see docs/DATA_LICENSING.md):
* crypto daily  → "historical": completed UTC daily candles. The current day appears only after it closes.
* crypto 1h/6h  → "historical": completed intraday candles, limited lookback, for charts only.
* forex         → "reference": exactly "Daily ECB reference rates — not live forex quotes."
Nothing in SIGNAL is labelled "live": no source here is a real-time executable feed.
"""
from __future__ import annotations

import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ..db import Database, dumps, loads, utcnow
from ..events import EventBus
from .instruments import INSTRUMENTS, Instrument, get_instrument, slug
from .licensing import LICENSES, source_allowed
from .providers.base import Provider, ProviderError
from .providers.crypto import CoinbaseProvider, KrakenProvider
from .providers.frankfurter import FrankfurterProvider
from .validation import FREQ_ALIAS, assess, cross_source_compare, dataset_version, normalize, quality_report, resample

TIMEFRAMES = {"1d": None, "1w": "W-FRI"}  # research timeframes (1w is resampled from completed daily bars)
INTRADAY = ("1h", "6h")  # stored separately, crypto only, charts only
FX_LABEL = "Daily ECB reference rates — not live forex quotes."
CRYPTO_LABEL = "Historical daily candles (UTC). Not live: today's candle appears after the UTC day closes."
INTRADAY_LABEL = "Historical {tf} candles (UTC), last {days} days. Not live: the open candle is excluded."
CROSS_CHECK_DAYS = 120


class DataUnavailable(RuntimeError):
    pass


def data_label(inst: Instrument, timeframe: str = "1d", intraday_days: int | None = None) -> dict:
    if inst.asset_class == "fx":
        return {"kind": "reference", "label": FX_LABEL}
    if timeframe in INTRADAY:
        return {"kind": "historical", "label": INTRADAY_LABEL.format(tf=timeframe, days=intraday_days or "?")}
    return {"kind": "historical", "label": CRYPTO_LABEL}


class DataService:
    def __init__(self, db: Database, bus: EventBus, snapshot_dir: Path, history_start: str = "2015-01-01",
                 providers: dict[str, Provider] | None = None, timeout: float = 20.0, min_interval_s: float = 0.35,
                 mode: str = "personal", cross_source_tolerance_bps: float = 50.0,
                 intraday_history_days: dict[str, int] | None = None):
        self.db = db
        self.bus = bus
        self.snapshot_dir = snapshot_dir
        self.history_start = date.fromisoformat(history_start)
        self.mode = mode
        self.cross_tol = cross_source_tolerance_bps
        self.intraday_days = intraday_history_days or {"1h": 60, "6h": 365}
        self.providers = providers or {
            "frankfurter": FrankfurterProvider(timeout, min_interval_s),
            "coinbase": CoinbaseProvider(timeout, min_interval_s),
            "kraken": KrakenProvider(timeout, min_interval_s),
        }
        self._locks = {s: threading.Lock() for s in INSTRUMENTS}
        self._cache: dict[tuple[str, str], tuple[str, pd.DataFrame]] = {}

    # ---------- licensing ----------
    def allowed_providers(self, inst: Instrument) -> list[str]:
        return [p for p in inst.providers if p in self.providers and source_allowed(p, self.mode)
                and self.providers[p].supports(inst)]

    # ---------- ingestion ----------
    def refresh(self, symbol: str, *, full: bool = False) -> dict:
        inst = get_instrument(symbol)
        allowed = self.allowed_providers(inst)
        if not allowed:
            msg = (f"No data source for {inst.symbol} is licensed for this deployment ({self.mode}). "
                   "See docs/DATA_LICENSING.md.")
            self.bus.emit("data", msg, level="warn", source="data", data={"symbol": inst.symbol})
            raise DataUnavailable(msg)
        with self._locks[inst.symbol]:
            last = self.db.one("SELECT MAX(ts) AS ts FROM bars WHERE symbol=? AND timeframe='1d'", (inst.symbol,))["ts"]
            start = self.history_start if (full or not last) else date.fromisoformat(last[:10]) - timedelta(days=7)
            end = datetime.now(timezone.utc).date()
            errors: list[str] = []
            for pname in allowed:
                prov = self.providers[pname]
                try:
                    self.bus.emit("data", f"Fetching {inst.symbol} from {pname} ({start}→{end})", source="data",
                                  data={"symbol": inst.symbol, "provider": pname, "node": f"data:{inst.symbol}"})
                    raw = prov.fetch_daily(inst, start, end)
                    clean, norm_report = normalize(raw, drop_open_period=prov.info.has_ohlc)
                    if clean.empty:
                        raise ProviderError(f"{pname} returned no valid rows")
                    return self._store(inst, prov, clean, norm_report, others=[p for p in allowed if p != pname])
                except Exception as e:  # failover to next provider
                    errors.append(f"{pname}: {e}")
                    self.bus.emit("data", f"Provider {pname} failed for {inst.symbol}: {e}", level="warn",
                                  source="data", data={"symbol": inst.symbol, "provider": pname})
            msg = f"All providers failed for {inst.symbol}: {'; '.join(errors)}"
            self.bus.emit("data", msg, level="error", source="data", data={"symbol": inst.symbol})
            raise DataUnavailable(msg)

    def _quarantine(self, inst: Instrument, timeframe: str, provider: str, norm_report: dict) -> None:
        sample = norm_report.get("quarantine_sample") or []
        if sample:
            now = utcnow()
            self.db.executemany(
                "INSERT INTO data_quarantine(symbol,timeframe,ts,provider,reason,row_json,created_at) VALUES(?,?,?,?,?,?,?)",
                [(inst.symbol, timeframe, q["ts"], provider, q["reason"], dumps(q["row"]), now) for q in sample])

    def cross_check(self, inst: Instrument, primary_df: pd.DataFrame, others: list[str]) -> dict | None:
        """Compare the stored primary series with an independent venue over the recent window."""
        for pname in others:
            prov = self.providers[pname]
            if not prov.info.has_ohlc:
                continue
            end = datetime.now(timezone.utc).date()
            try:
                raw = prov.fetch_daily(inst, end - timedelta(days=CROSS_CHECK_DAYS), end)
                sec, _ = normalize(raw, drop_open_period=True)
            except Exception as e:
                return {"secondary": pname, "status": "unavailable", "error": str(e)[:200]}
            res = cross_source_compare(primary_df.iloc[-CROSS_CHECK_DAYS:], sec, self.cross_tol)
            return {"secondary": pname, **res}
        return None

    def _store(self, inst: Instrument, prov: Provider, clean: pd.DataFrame, norm_report: dict,
               others: list[str] | None = None) -> dict:
        self._quarantine(inst, "1d", prov.info.name, norm_report)
        rows = [(inst.symbol, "1d", ts.date().isoformat(), _f(r.open), _f(r.high), _f(r.low), float(r.close),
                 _f(r.volume), prov.info.name) for ts, r in clean.iterrows()]
        before = self.db.one("SELECT COUNT(*) n FROM bars WHERE symbol=? AND timeframe='1d'", (inst.symbol,))["n"]
        self.db.executemany(
            "INSERT INTO bars(symbol,timeframe,ts,open,high,low,close,volume,provider) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(symbol,timeframe,ts) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,"
            "close=excluded.close,volume=excluded.volume,provider=excluded.provider", rows)
        after = self.db.one("SELECT COUNT(*) n FROM bars WHERE symbol=? AND timeframe='1d'", (inst.symbol,))["n"]
        df = self.load(inst.symbol, use_cache=False, enforce_license=False)
        version = dataset_version(df)
        quality = quality_report(df, inst.asset_class)
        quality["normalization"] = {k: v for k, v in norm_report.items() if k != "quarantine_sample"}
        quality["sources"] = sorted({r["provider"] for r in self.db.query(
            "SELECT DISTINCT provider FROM bars WHERE symbol=? AND timeframe='1d'", (inst.symbol,))})
        if others and inst.asset_class == "crypto":
            quality["cross_source"] = self.cross_check(inst, df, others)
        grade = assess(quality, norm_report, max_stale_days=inst.max_stale_days, asset_class=inst.asset_class)
        quality.update(grade)
        quality.update(data_label(inst))
        existing = self.db.one("SELECT id FROM datasets WHERE symbol=? AND timeframe='1d' AND version=?",
                               (inst.symbol, version))
        changed = existing is None
        if changed:
            snap = self.snapshot_dir / f"{slug(inst.symbol)}_1d_{version}.csv.gz"
            df.to_csv(snap, compression="gzip", date_format="%Y-%m-%d")
            self.db.insert("datasets", {
                "symbol": inst.symbol, "timeframe": "1d", "version": version, "provider": prov.info.name,
                "attribution": LICENSES[prov.info.name].attribution if prov.info.name in LICENSES else prov.info.attribution,
                "start_ts": quality["start"], "end_ts": quality["end"],
                "rows": len(df), "has_ohlc": int(quality["has_ohlc"]), "has_volume": int(quality["has_volume"]),
                "quality_json": dumps(quality), "quality_status": grade["status"], "created_at": utcnow()})
        else:  # same data, refreshed checks (staleness, cross-source) — keep the latest assessment
            self.db.execute("UPDATE datasets SET quality_json=?, quality_status=? WHERE id=?",
                            (dumps(quality), grade["status"], existing["id"]))
        summary = {"symbol": inst.symbol, "provider": prov.info.name, "version": version, "changed": changed,
                   "new_rows": after - before, "rows": len(df), "end": quality["end"],
                   "missing_periods": quality["missing_periods"], "stale_days": quality["stale_days"],
                   "quality_status": grade["status"], "quarantined": norm_report.get("quarantined", 0)}
        level = "warn" if grade["status"] != "ok" else "info"
        self.bus.emit("data", f"{inst.symbol}: {len(df)} bars, +{after - before} new, version {version}"
                      f"{' (new dataset version)' if changed else ' (unchanged)'}; quality {grade['status']}",
                      level=level, source="data", data={**summary, "node": f"data:{inst.symbol}"})
        return summary

    def refresh_all(self) -> list[dict]:
        out = []
        for s in INSTRUMENTS:
            try:
                out.append(self.refresh(s))
            except DataUnavailable as e:
                out.append({"symbol": s, "error": str(e)})
        return out

    # ---------- intraday history (charts only) ----------
    def refresh_intraday(self, symbol: str, timeframe: str) -> dict:
        inst = get_instrument(symbol)
        if inst.asset_class != "crypto" or timeframe not in INTRADAY:
            raise ValueError(f"Intraday {timeframe} is available for crypto only ({', '.join(INTRADAY)})")
        days = int(self.intraday_days.get(timeframe, 60))
        end = datetime.now(timezone.utc).date()
        last = self.db.one("SELECT MAX(ts) ts FROM bars WHERE symbol=? AND timeframe=?", (inst.symbol, timeframe))["ts"]
        start = max(end - timedelta(days=days),
                    (datetime.fromisoformat(last).date() - timedelta(days=1)) if last else end - timedelta(days=days))
        errors = []
        for pname in self.allowed_providers(inst):
            prov = self.providers[pname]
            if not hasattr(prov, "fetch_candles"):
                continue
            try:
                raw = prov.fetch_candles(inst, start, end, timeframe)
                clean, rep = normalize(raw, drop_open_period=True, freq=FREQ_ALIAS[timeframe])
            except Exception as e:
                errors.append(f"{pname}: {e}")
                continue
            self._quarantine(inst, timeframe, pname, rep)
            self.db.executemany(
                "INSERT INTO bars(symbol,timeframe,ts,open,high,low,close,volume,provider) VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(symbol,timeframe,ts) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,"
                "close=excluded.close,volume=excluded.volume,provider=excluded.provider",
                [(inst.symbol, timeframe, ts.isoformat(), _f(r.open), _f(r.high), _f(r.low), float(r.close),
                  _f(r.volume), pname) for ts, r in clean.iterrows()])
            cutoff = (end - timedelta(days=days)).isoformat()
            self.db.execute("DELETE FROM bars WHERE symbol=? AND timeframe=? AND ts < ?", (inst.symbol, timeframe, cutoff))
            return {"symbol": inst.symbol, "timeframe": timeframe, "provider": pname, "rows": len(clean),
                    "quarantined": rep.get("quarantined", 0)}
        raise DataUnavailable(f"No licensed provider returned {timeframe} candles for {inst.symbol}: {'; '.join(errors)}")

    # ---------- access ----------
    def _check_license(self, inst: Instrument, timeframe: str) -> None:
        provs = [r["provider"] for r in self.db.query(
            "SELECT DISTINCT provider FROM bars WHERE symbol=? AND timeframe=?", (inst.symbol, timeframe))]
        blocked = [p for p in provs if not source_allowed(p, self.mode)]
        if blocked:
            raise DataUnavailable(f"{inst.symbol} data from {', '.join(blocked)} is not licensed for the "
                                  f"{self.mode} deployment. See docs/DATA_LICENSING.md.")

    def load(self, symbol: str, timeframe: str = "1d", *, use_cache: bool = True,
             enforce_license: bool = True) -> pd.DataFrame:
        inst = get_instrument(symbol)
        if timeframe not in TIMEFRAMES and timeframe not in INTRADAY:
            raise ValueError(f"timeframe must be one of {list(TIMEFRAMES) + list(INTRADAY)}")
        stored_tf = timeframe if timeframe in INTRADAY else "1d"
        if enforce_license and self.mode != "personal":
            self._check_license(inst, stored_tf)
        key = (inst.symbol, timeframe)
        stamp = self.db.one("SELECT COUNT(*) n, MAX(ts) m FROM bars WHERE symbol=? AND timeframe=?", (inst.symbol, stored_tf))
        stamp_s = f"{stamp['n']}:{stamp['m']}"
        if use_cache and key in self._cache and self._cache[key][0] == stamp_s:
            return self._cache[key][1].copy()
        rows = self.db.query("SELECT ts,open,high,low,close,volume FROM bars WHERE symbol=? AND timeframe=? ORDER BY ts",
                             (inst.symbol, stored_tf))
        df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
        df["ts"] = pd.to_datetime(df["ts"], utc=True, format="ISO8601")
        df = df.set_index("ts").astype(float)
        if TIMEFRAMES.get(timeframe):
            df = resample(df, TIMEFRAMES[timeframe])
        self._cache[key] = (stamp_s, df)
        return df.copy()

    def require(self, symbol: str, timeframe: str = "1d", min_rows: int = 200) -> pd.DataFrame:
        df = self.load(symbol, timeframe)
        if len(df) < min_rows:
            raise DataUnavailable(f"{symbol} has {len(df)} {timeframe} bars (< {min_rows}). Refresh market data first.")
        ds = self.latest_dataset(get_instrument(symbol).symbol)
        if ds and ds.get("quality_status") == "fail":
            raise DataUnavailable(f"{symbol} data failed quality checks and is not used for research: "
                                  + "; ".join(i["text"] for i in ds["quality"].get("issues", []) if i["level"] == "fail"))
        return df

    def latest_dataset(self, symbol: str) -> dict | None:
        r = self.db.one("SELECT * FROM datasets WHERE symbol=? AND timeframe='1d' ORDER BY id DESC LIMIT 1", (symbol,))
        if r:
            r["quality"] = loads(r.pop("quality_json"), {})
        return r

    def quarantine(self, symbol: str, limit: int = 100) -> list[dict]:
        rows = self.db.query("SELECT * FROM data_quarantine WHERE symbol=? ORDER BY id DESC LIMIT ?", (symbol, limit))
        for r in rows:
            r["row"] = loads(r.pop("row_json"), {})
        return rows

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
            prev = self.db.query("SELECT ts, close FROM bars WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 2", (s,))
            last = prev[0] if prev else None
            chg = (prev[0]["close"] / prev[1]["close"] - 1) if len(prev) == 2 else None
            prov = self.providers.get(ds["provider"]) if ds else None
            stale = None
            if last:
                stale = (datetime.now(timezone.utc) - datetime.fromisoformat(last["ts"]).replace(tzinfo=timezone.utc)).days
            licensed = bool(self.allowed_providers(inst))
            q = ds["quality"] if ds else {}
            out.append({
                "symbol": s, "asset_class": inst.asset_class, "providers": list(inst.providers),
                "last_ts": last["ts"] if last else None, "last_close": last["close"] if last else None,
                "change_1d": chg, "rows": ds["rows"] if ds else 0, "version": ds["version"] if ds else None,
                "provider": ds["provider"] if ds else None, "attribution": ds["attribution"] if ds else None,
                "has_ohlc": bool(ds["has_ohlc"]) if ds else None, "has_volume": bool(ds["has_volume"]) if ds else None,
                "provider_notes": prov.info.notes if prov else None, "stale_days": stale,
                "is_stale": stale is not None and stale > inst.max_stale_days,
                "missing_periods": q.get("missing_periods") if ds else None,
                "price_decimals": inst.price_decimals,
                "quality_status": ds.get("quality_status") if ds else None,
                "quality_issues": q.get("issues", []),
                "cross_source": q.get("cross_source"),
                "licensed": licensed, "deployment_mode": self.mode,
                "intraday": list(INTRADAY) if inst.asset_class == "crypto" else [],
                "costs": {"spread_bps": inst.default_spread_bps, "fee_bps": inst.default_fee_bps,
                          "slippage_bps": inst.default_slippage_bps},
                **data_label(inst),
            })
        return out


def _f(x) -> float | None:
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else float(x)
