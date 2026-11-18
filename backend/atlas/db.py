"""SQLite persistence layer. A single connection guarded by a re-entrant lock keeps writes
serialized across worker threads; WAL mode keeps reads cheap."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS bars (
    symbol TEXT NOT NULL, timeframe TEXT NOT NULL, ts TEXT NOT NULL,
    open REAL, high REAL, low REAL, close REAL NOT NULL, volume REAL,
    provider TEXT NOT NULL,
    PRIMARY KEY (symbol, timeframe, ts)
);
CREATE TABLE IF NOT EXISTS datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, timeframe TEXT NOT NULL, version TEXT NOT NULL,
    provider TEXT NOT NULL, attribution TEXT, start_ts TEXT, end_ts TEXT, rows INTEGER,
    has_ohlc INTEGER, has_volume INTEGER, quality_json TEXT, created_at TEXT NOT NULL,
    UNIQUE(symbol, timeframe, version)
);
CREATE TABLE IF NOT EXISTS experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
    symbol TEXT, strategy TEXT, params_json TEXT, config_json TEXT,
    dataset_version TEXT, code_version TEXT, metrics_json TEXT, verdict TEXT,
    reasons_json TEXT, job_id INTEGER, cycle_id INTEGER, hypothesis_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_exp_strategy ON experiments(strategy, symbol);
CREATE TABLE IF NOT EXISTS experiment_artifacts (
    experiment_id INTEGER NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL,
    PRIMARY KEY (experiment_id, name)
);
CREATE TABLE IF NOT EXISTS strategy_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
    name TEXT NOT NULL, strategy TEXT NOT NULL, symbol TEXT NOT NULL, params_json TEXT NOT NULL,
    status TEXT NOT NULL, allocation REAL DEFAULT 0, source_experiment INTEGER, notes TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, status TEXT NOT NULL,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
    params_json TEXT, result_json TEXT, error TEXT, progress REAL DEFAULT 0, message TEXT
);
CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, job_id INTEGER,
    started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
    inputs_json TEXT, outputs_json TEXT, error TEXT, duration_ms REAL
);
CREATE INDEX IF NOT EXISTS ix_agent_runs ON agent_runs(agent, id);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, category TEXT NOT NULL,
    level TEXT NOT NULL, source TEXT, message TEXT NOT NULL, data_json TEXT
);
CREATE TABLE IF NOT EXISTS paper_account (
    id INTEGER PRIMARY KEY CHECK (id = 1), cash REAL NOT NULL, initial_cash REAL NOT NULL,
    state TEXT NOT NULL, updated_at TEXT NOT NULL, peak_equity REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS positions (
    symbol TEXT NOT NULL, strategy_id TEXT NOT NULL, qty REAL NOT NULL, avg_price REAL NOT NULL,
    opened_at TEXT NOT NULL, stop REAL, take_profit REAL,
    PRIMARY KEY (symbol, strategy_id)
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, symbol TEXT NOT NULL,
    side TEXT NOT NULL, qty REAL NOT NULL, type TEXT NOT NULL, limit_price REAL,
    status TEXT NOT NULL, filled_price REAL, filled_at TEXT, fee REAL DEFAULT 0,
    strategy_id TEXT NOT NULL, reason TEXT, reject_reason TEXT
);
CREATE TABLE IF NOT EXISTS fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, ts TEXT NOT NULL,
    symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL,
    fee REAL NOT NULL, realized_pnl REAL NOT NULL, strategy_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, cash REAL NOT NULL,
    equity REAL NOT NULL, gross_exposure REAL NOT NULL, net_exposure REAL NOT NULL, drawdown REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, rule TEXT NOT NULL,
    decision TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL,
    order_id INTEGER, data_json TEXT
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    markets_json TEXT, experience TEXT, source TEXT
);
"""


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def dumps(obj: Any) -> str:
    """Strict JSON: NaN/inf become null, numpy scalars become Python scalars."""
    try:
        return json.dumps(obj, default=_json_default, allow_nan=False)
    except ValueError:
        return json.dumps(_sanitize(obj), default=_json_default, allow_nan=False)


def _sanitize(o: Any) -> Any:
    import math
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _sanitize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_sanitize(v) for v in o]
    return o


def _json_default(o: Any) -> Any:
    import numpy as np
    import pandas as pd
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.isoformat()
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(f"not serializable: {type(o)}")


def loads(s: str | None, default: Any = None) -> Any:
    return default if s is None else json.loads(s)


class Database:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        if self.path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise

    def execute(self, sql: str, params: tuple | dict = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._conn.execute(sql, params)

    def executemany(self, sql: str, rows: list) -> None:
        with self.tx() as c:
            c.executemany(sql, rows)

    def query(self, sql: str, params: tuple | dict = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._conn.execute(sql, params).fetchall()]

    def one(self, sql: str, params: tuple | dict = ()) -> dict | None:
        with self._lock:
            r = self._conn.execute(sql, params).fetchone()
            return dict(r) if r else None

    def insert(self, table: str, row: dict) -> int:
        cols = ",".join(row)
        qs = ",".join("?" for _ in row)
        with self._lock:
            cur = self._conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({qs})", tuple(row.values()))
            return int(cur.lastrowid)

    def kv_get(self, key: str, default: Any = None) -> Any:
        r = self.one("SELECT value_json FROM kv WHERE key=?", (key,))
        return loads(r["value_json"]) if r else default

    def kv_set(self, key: str, value: Any) -> None:
        self.execute("INSERT INTO kv(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
                     (key, dumps(value)))

    def close(self) -> None:
        with self._lock:
            self._conn.close()
