"""Sealed holdout for the intraday track (sealed 2026-11-20).

The most recent ~9 months of QQQ minute data at sealing time are set aside so that a future idea can be
checked ONCE on data that played no part in designing it. Replay, opening statistics and backtests read
minute bars through MinuteStore.load, which excludes these sessions unless the caller passes an explicit
unlock reason; every unlock is written to the `holdout_unlocks` table with time, reason and purpose.

The window is fixed: sessions dated after HOLDOUT_END (data downloaded after sealing day) are NOT added.
"""
from __future__ import annotations

from ..db import Database, utcnow

SEALED_ON = "2026-11-20"
HOLDOUT_START = "2026-02-20"  # first sealed session date (New York), 9 months before sealing
HOLDOUT_END = "2026-11-19"  # last complete session stored at sealing; later sessions stay open


def in_holdout(date: str) -> bool:
    return HOLDOUT_START <= date <= HOLDOUT_END


def log_unlock(db: Database, reason: str, purpose: str) -> int:
    reason = (reason or "").strip()
    if len(reason) < 5:
        raise PermissionError("Unlocking the holdout needs a written reason (at least 5 characters).")
    return db.insert("holdout_unlocks", {"ts": utcnow(), "reason": reason, "purpose": purpose,
                                         "window": f"{HOLDOUT_START}..{HOLDOUT_END}"})


def unlocks(db: Database) -> list[dict]:
    return db.query("SELECT * FROM holdout_unlocks ORDER BY id DESC")


def info(db: Database) -> dict:
    return {"sealed_on": SEALED_ON, "start": HOLDOUT_START, "end": HOLDOUT_END, "unlocks": len(unlocks(db)),
            "rule": "Excluded from replay, statistics and backtests unless explicitly unlocked; every unlock is logged. "
                    "Data after the end date is not sealed."}
