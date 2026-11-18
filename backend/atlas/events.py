"""Event bus. Every event is persisted to SQLite and fanned out to WebSocket subscribers.
The frontend's computation graph animates ONLY in response to these real events."""
from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

from .db import Database, dumps, utcnow

log = logging.getLogger("atlas.events")


class EventBus:
    def __init__(self, db: Database):
        self.db = db
        self._subs: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._subs.discard(q)

    def emit(self, category: str, message: str, *, level: str = "info", source: str | None = None,
             data: dict[str, Any] | None = None, user_id: int | None = None) -> dict:
        """user_id=None marks a system-wide event (e.g. market data); otherwise only that user sees it."""
        ev = {"ts": utcnow(), "category": category, "level": level, "source": source,
              "message": message, "data": data or {}, "user_id": user_id}
        try:
            ev["id"] = self.db.insert("events", {"ts": ev["ts"], "category": category, "level": level, "source": source,
                                                 "message": message, "data_json": dumps(ev["data"]), "user_id": user_id if user_id is not None else 0})
        except Exception:  # never let telemetry break the caller
            log.exception("failed to persist event")
        getattr(log, "warning" if level in ("warn", "error") else "info")(f"[{category}] {message}")
        loop = self._loop
        if loop and not loop.is_closed():
            with self._lock:
                subs = list(self._subs)
            for q in subs:
                loop.call_soon_threadsafe(_put_nowait, q, ev)
        return ev


def _put_nowait(q: asyncio.Queue, ev: dict) -> None:
    try:
        q.put_nowait(ev)
    except asyncio.QueueFull:
        pass
