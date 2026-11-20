"""Bar-by-bar session replay with PAPER trading, and a manual trade journal.

PAPER ONLY. Nothing here can reach a broker. Practice runs on stored historical bars (the QQQ proxy,
scaled to index-equivalent points), and every decision is evaluated by the SAME engine as the
backtester (`run_intraday`), so the costs, session rules, stops and loss limit are identical.

You only ever see bars up to the cursor. A decision made at the cursor fills at the NEXT bar's open,
exactly like a backtest signal.
"""
from __future__ import annotations

from typing import Callable

import pandas as pd

from ..db import Database, dumps, loads, utcnow
from .contracts import MNQ, FuturesCosts, round_turn
from .engine import IntradayConfig, run_intraday
from .minute_data import NY, PROXY_SYMBOL, MinuteStore
from .proxy import PROXY_SCALE, to_index_points

DATA_NOTE = f"Historical QQQ 1-minute bars scaled ×{PROXY_SCALE:g} to Nasdaq-100 points (proxy for MNQ). Paper only."


class PracticeError(ValueError):
    pass


def session_bounds(date: str) -> tuple[str, str]:
    start = pd.Timestamp(f"{date} 09:30", tz=NY).tz_convert("UTC")
    return start.isoformat(), (start + pd.Timedelta(hours=7)).isoformat()


class Practice:
    def __init__(self, db: Database, loader: Callable[[str], pd.DataFrame] | None = None):
        self.db = db
        self.loader = loader or self._load

    def _load(self, date: str) -> pd.DataFrame:
        a, b = session_bounds(date)
        return to_index_points(MinuteStore(self.db).load(PROXY_SYMBOL, a, b))

    def sessions(self) -> list[str]:
        return MinuteStore(self.db).sessions(PROXY_SYMBOL)

    # ---------- lifecycle ----------
    def start(self, date: str, contracts: int = 1, stop_ticks: float | None = None, target_ticks: float | None = None,
              daily_loss_limit: float | None = None, commission_per_side: float = 0.62, slippage_ticks: float = 1.0,
              start_bar: int = 0) -> dict:
        bars = self.loader(date)
        if len(bars) < 30:
            raise PracticeError(f"No usable session stored for {date}.")
        cfg = IntradayConfig(contracts=contracts, stop_ticks=stop_ticks, target_ticks=target_ticks,
                             daily_loss_limit=daily_loss_limit, costs=FuturesCosts(commission_per_side, slippage_ticks))
        pid = self.db.insert("practice_sessions", {
            "created_at": utcnow(), "session_date": date, "symbol": PROXY_SYMBOL, "status": "active",
            "config_json": dumps({**cfg.to_dict(), "costs": vars(cfg.costs)}), "decisions_json": "[]",
            "cursor": max(0, min(start_bar, len(bars) - 2))})
        return self.view(pid)

    def _get(self, pid: int) -> tuple[dict, IntradayConfig, list, pd.DataFrame]:
        row = self.db.one("SELECT * FROM practice_sessions WHERE id=?", (pid,))
        if not row:
            raise PracticeError("practice session not found")
        c = loads(row["config_json"], {})
        cfg = IntradayConfig(**{**c, "costs": FuturesCosts(**c["costs"])})
        return row, cfg, loads(row["decisions_json"], []), self.loader(row["session_date"])

    @staticmethod
    def _signals(bars: pd.DataFrame, decisions: list) -> pd.Series:
        s = pd.Series(0.0, index=bars.index)
        for i, d in sorted(decisions):
            s.iloc[i:] = d
        return s

    def view(self, pid: int) -> dict:
        row, cfg, dec, bars = self._get(pid)
        k = row["cursor"]
        shown = bars.iloc[: k + 1]  # never anything after the cursor
        done = row["status"] != "active"
        res = run_intraday(shown, self._signals(shown, dec), cfg, open_end=not done) if not done else None
        local = shown.index.tz_convert(NY)
        return {
            "id": pid, "session_date": row["session_date"], "status": row["status"], "cursor": k, "total_bars": len(bars),
            "time": local[-1].strftime("%H:%M"), "config": loads(row["config_json"], {}),
            "bars": [{"t": t.isoformat(), "o": r.open, "h": r.high, "l": r.low, "c": r.close} for t, r in shown.iterrows()],
            "state": res.state if res else None, "trades": res.trades if res else loads(row["summary_json"], {}).get("trades", []),
            "net_pnl": round(sum(t["net"] for t in res.trades), 2) if res else loads(row["summary_json"], {}).get("net_pnl"),
            "data_note": DATA_NOTE,
        }

    def step(self, pid: int, n: int = 1) -> dict:
        row, _, _, bars = self._get(pid)
        if row["status"] != "active":
            raise PracticeError("session already finished")
        self.db.execute("UPDATE practice_sessions SET cursor=? WHERE id=?", (min(len(bars) - 1, row["cursor"] + max(1, int(n))), pid))
        if row["cursor"] + max(1, int(n)) >= len(bars) - 1:
            return self.finish(pid)
        return self.view(pid)

    def decide(self, pid: int, direction: int) -> dict:
        """Set the position you want: +1 long, -1 short, 0 flat. Fills at the next bar's open."""
        if direction not in (-1, 0, 1):
            raise PracticeError("direction must be -1, 0 or 1")
        row, _, dec, _ = self._get(pid)
        if row["status"] != "active":
            raise PracticeError("session already finished")
        dec = [d for d in dec if d[0] != row["cursor"]] + [[row["cursor"], direction]]
        self.db.execute("UPDATE practice_sessions SET decisions_json=? WHERE id=?", (dumps(dec), pid))
        return self.view(pid)

    def finish(self, pid: int) -> dict:
        """End practice: go flat at the next bar's open (or at the session close if at the end) and save
        the paper trades."""
        row, cfg, dec, bars = self._get(pid)
        if row["status"] != "active":
            return self.view(pid)
        k = min(row["cursor"], len(bars) - 1)
        upto = bars.iloc[: min(k + 2, len(bars))]
        dec = [d for d in dec if d[0] <= k] + ([[k, 0]] if k + 1 < len(bars) else [])
        res = run_intraday(upto, self._signals(upto, dec), cfg)
        for t in res.trades:
            self.db.insert("paper_futures_trades", {
                "practice_id": pid, "session_date": row["session_date"], "contract": "MNQ", "side": t["side"],
                "contracts": t["contracts"], "entry_ts": t["entry_ts"], "entry_price": t["entry_price"], "exit_ts": t["exit_ts"],
                "exit_price": t["exit_price"], "exit_reason": t["exit_reason"], "gross": t["gross"],
                "commission": t["commission"], "net": t["net"], "data_note": DATA_NOTE})
        summary = {"trades": res.trades, "net_pnl": res.metrics["net_pnl"], "metrics": res.metrics}
        self.db.execute("UPDATE practice_sessions SET status='finished', finished_at=?, cursor=?, summary_json=?, decisions_json=? WHERE id=?",
                        (utcnow(), len(upto) - 1, dumps(summary), dumps(dec), pid))
        return self.view(pid)

    def paper_trades(self, limit: int = 200) -> list[dict]:
        return self.db.query("SELECT * FROM paper_futures_trades ORDER BY id DESC LIMIT ?", (limit,))


# ---------------- journal ----------------
JOURNAL_FIELDS = ("trade_date", "contract", "side", "contracts", "entry_time", "entry_price", "exit_time", "exit_price",
                  "setup", "notes", "mistakes", "lesson", "rating", "paper_trade_id")


def _net(e: dict, costs: FuturesCosts) -> float | None:
    """Dollar P&L from the cost model when the trade details are complete (MNQ only)."""
    if e.get("contract", "MNQ") != "MNQ" or e.get("side") not in ("long", "short") or not e.get("contracts"):
        return None
    if e.get("entry_price") is None or e.get("exit_price") is None:
        return None
    return round_turn(MNQ, 1 if e["side"] == "long" else -1, int(e["contracts"]), float(e["entry_price"]),
                      float(e["exit_price"]), costs).net


class Journal:
    def __init__(self, db: Database, costs: FuturesCosts | None = None):
        self.db, self.costs = db, costs or FuturesCosts()

    def _clean(self, data: dict) -> dict:
        e = {k: data.get(k) for k in JOURNAL_FIELDS if k in data}
        if "side" in e and e["side"] not in (None, "long", "short"):
            raise PracticeError("side must be long or short")
        if e.get("contracts") is not None and (int(e["contracts"]) != float(e["contracts"]) or int(e["contracts"]) <= 0):
            raise PracticeError("contracts must be a whole number above zero")
        if e.get("rating") is not None and not 1 <= int(e["rating"]) <= 5:
            raise PracticeError("rating must be 1–5")
        return e

    def add(self, data: dict) -> dict:
        e = self._clean(data)
        if not e.get("trade_date"):
            raise PracticeError("trade_date is required")
        e.setdefault("contract", "MNQ")
        e["net"] = _net(e, self.costs)
        now = utcnow()
        jid = self.db.insert("journal_entries", {**e, "created_at": now, "updated_at": now})
        return self.get(jid)

    def update(self, jid: int, data: dict) -> dict:
        cur = self.get(jid)
        e = {**cur, **self._clean(data)}
        e["net"] = _net(e, self.costs)
        cols = [k for k in JOURNAL_FIELDS if k in e] + ["net"]
        self.db.execute(f"UPDATE journal_entries SET {', '.join(f'{c}=?' for c in cols)}, updated_at=? WHERE id=?",
                        (*[e[c] for c in cols], utcnow(), jid))
        return self.get(jid)

    def get(self, jid: int) -> dict:
        r = self.db.one("SELECT * FROM journal_entries WHERE id=?", (jid,))
        if not r:
            raise PracticeError("journal entry not found")
        return r

    def list(self, limit: int = 500) -> list[dict]:
        return self.db.query("SELECT * FROM journal_entries ORDER BY trade_date DESC, id DESC LIMIT ?", (limit,))

    def delete(self, jid: int) -> None:
        self.get(jid)
        self.db.execute("DELETE FROM journal_entries WHERE id=?", (jid,))
