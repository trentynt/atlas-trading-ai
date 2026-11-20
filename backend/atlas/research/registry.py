"""Persistent trial registry and sealed-holdout policy.

Every research attempt — hypotheses, parameter variants, manual backtests and manual validations —
is recorded permanently so multiple-testing corrections can account for the true search effort.
Nothing is ever deleted from the registry."""
from __future__ import annotations

import math
from datetime import timedelta

import numpy as np
import pandas as pd

from ..config import code_version
from ..db import Database, dumps, loads, utcnow
from .integrity import by_adjust, effective_trials, per_bar_sharpe

METHODOLOGY = "v2"
HOLDOUT_FRACTION = 0.20
MIN_HOLDOUT_BARS = {"crypto": 90, "fx": 63}  # ~3 months of daily data before a forward confirmation is attempted
FDR_Q = 0.10


def _blob(r: pd.Series | None) -> bytes | None:
    if r is None or len(r) == 0:
        return None
    return np.asarray(r.values, dtype=np.float32).tobytes()


class TrialRegistry:
    def __init__(self, db: Database):
        self.db = db

    # ---------- trials ----------
    def register(self, *, user_id: int, kind: str, symbol: str, strategy: str, params: dict, dataset_version: str | None,
                 window: tuple[str, str] | None, returns: pd.Series | None, selection_returns: pd.Series | None = None,
                 p_value: float | None = None, sharpe: float | None = None, cycle_id: int | None = None,
                 experiment_id: int | None = None, hypothesis_key: str | None = None, family: str | None = None,
                 method: str = "", timeframe: str = "1d", disposition: str | None = None, touches_holdout: bool = False) -> int:
        sr = per_bar_sharpe(selection_returns) if selection_returns is not None else per_bar_sharpe(returns) if returns is not None else None
        return self.db.insert("trials", {
            "user_id": user_id, "cycle_id": cycle_id, "experiment_id": experiment_id, "hypothesis_key": hypothesis_key,
            "family": family, "strategy": strategy, "symbol": symbol, "timeframe": timeframe, "params_json": dumps(params),
            "dataset_version": dataset_version, "code_version": code_version(), "kind": kind,
            "window_start": window[0] if window else None, "window_end": window[1] if window else None,
            "returns_start": returns.index[0].date().isoformat() if returns is not None and len(returns) else None,
            "method": method, "n_obs": int(len(selection_returns)) if selection_returns is not None else (int(len(returns)) if returns is not None else 0),
            "sharpe": sharpe, "sr_bar": sr, "p_value": p_value, "returns_blob": _blob(returns),
            "disposition": disposition, "touches_holdout": int(touches_holdout), "methodology": METHODOLOGY, "created_at": utcnow()})

    def set_disposition(self, trial_id: int, disposition: str) -> None:
        self.db.execute("UPDATE trials SET disposition=? WHERE id=?", (disposition, trial_id))

    def counts(self, user_id: int, symbol: str | None = None) -> dict:
        sql = "SELECT kind, COUNT(*) n FROM trials WHERE user_id=?" + (" AND symbol=?" if symbol else "") + " GROUP BY kind"
        rows = self.db.query(sql, (user_id, symbol) if symbol else (user_id,))
        out = {r["kind"]: r["n"] for r in rows}
        out["total"] = sum(out.values())
        return out

    def family_stats(self, user_id: int, symbol: str, max_trials: int = 300) -> dict:
        """Raw and effective trial counts plus the cross-trial variance of per-bar Sharpe for one symbol.

        N_eff uses trials with stored returns (hypotheses and variants, which share the research
        window). Manual runs are added to the raw count; they are counted as fully independent in
        N_eff because their windows differ — the conservative choice."""
        rows = self.db.query(
            "SELECT id, kind, returns_blob, returns_start, sr_bar FROM trials WHERE user_id=? AND symbol=? ORDER BY id DESC LIMIT ?",
            (user_id, symbol, max_trials))
        n_raw = self.db.one("SELECT COUNT(*) n FROM trials WHERE user_id=? AND symbol=?", (user_id, symbol))["n"]
        research = [r for r in rows if r["kind"] in ("hypothesis", "variant") and r["returns_blob"]]
        manual = sum(1 for r in rows if r["kind"].startswith("manual"))
        # align series on the most common start date / length so correlations are computed on one window
        series = {}
        for r in research:
            series.setdefault(r["returns_start"], []).append(np.frombuffer(r["returns_blob"], dtype=np.float32))
        n_eff_research = 0.0
        if series:
            start, group = max(series.items(), key=lambda kv: len(kv[1]))
            L = min(len(a) for a in group)
            n_eff_research = effective_trials([a[-L:].astype(float) for a in group]) if L > 30 else float(len(group))
            n_eff_research += sum(len(g) for s, g in series.items() if s != start)  # other windows: count fully
        # Attempts older than the correlation window are NOT dropped: each counts as fully independent
        # (the conservative choice), so the luck bar keeps rising however many attempts accumulate.
        tot = self.db.one("SELECT SUM(kind IN ('hypothesis','variant')) r, SUM(kind LIKE 'manual%') m FROM trials "
                          "WHERE user_id=? AND symbol=?", (user_id, symbol))
        beyond = max(0, int(tot["r"] or 0) - len(research)) + max(0, int(tot["m"] or 0) - manual)
        srs = [r["sr_bar"] for r in self.db.query(
            "SELECT sr_bar FROM trials WHERE user_id=? AND symbol=? AND sr_bar IS NOT NULL", (user_id, symbol))]
        return {"n_raw": int(n_raw), "n_research": int(tot["r"] or 0), "n_manual": int(tot["m"] or 0),
                "n_eff": float(max(1.0, n_eff_research + manual + beyond)), "n_beyond_window": beyond,
                "sr_var": float(np.var(srs, ddof=1)) if len(srs) > 2 else 0.0}

    def global_stats(self, user_id: int) -> dict:
        """Attempts across EVERY market. Markets are treated as independent of each other (effective
        counts are summed), which can only make the luck bar higher — the stricter choice."""
        syms = [r["symbol"] for r in self.db.query("SELECT DISTINCT symbol FROM trials WHERE user_id=?", (user_id,))]
        per = [self.family_stats(user_id, s) for s in syms]
        srs = [r["sr_bar"] for r in self.db.query("SELECT sr_bar FROM trials WHERE user_id=? AND sr_bar IS NOT NULL", (user_id,))]
        return {"n_raw": sum(f["n_raw"] for f in per), "n_eff": float(max(1.0, sum(f["n_eff"] for f in per))),
                "markets": len(syms), "sr_var": float(np.var(srs, ddof=1)) if len(srs) > 2 else 0.0}

    def fdr_family(self, user_id: int) -> list[dict]:
        """All hypothesis-level research trials for the user (the FDR family), with BY q-values."""
        rows = self.db.query("SELECT id, experiment_id, symbol, p_value FROM trials WHERE user_id=? AND kind='hypothesis' AND p_value IS NOT NULL ORDER BY id", (user_id,))
        q = by_adjust([r["p_value"] for r in rows])
        for r, qv in zip(rows, q):
            r["q_value"] = qv
        return rows

    def q_value(self, user_id: int, trial_id: int) -> tuple[float | None, int]:
        fam = self.fdr_family(user_id)
        for r in fam:
            if r["id"] == trial_id:
                return r["q_value"], len(fam)
        return None, len(fam)

    # ---------- sealed holdout ----------
    def holdout_start(self, user_id: int, symbol: str, index: pd.DatetimeIndex) -> pd.Timestamp:
        """Return (sealing on first use) the start of the sealed holdout for this user+symbol.

        * If any research already exists for the symbol, all history to date has been used for
          selection, so the holdout is FORWARD-ONLY: it starts the day after the latest bar.
        * Otherwise the last 20% of history is sealed and never used for selection."""
        key = f"holdout:{user_id}:{symbol}"
        v = self.db.kv_get(key)
        if v:
            return pd.Timestamp(v["start"], tz="UTC")
        prior = self.db.one("SELECT COUNT(*) n FROM experiments WHERE user_id=? AND symbol=? AND kind IN ('hypothesis_test','manual_backtest')",
                            (user_id, symbol))["n"]
        if prior > 0 or len(index) < 500:
            start = index[-1] + timedelta(days=1)
            policy = "forward_only"
        else:
            start = index[int(len(index) * (1 - HOLDOUT_FRACTION))]
            policy = "last_20pct"
        self.db.kv_set(key, {"start": start.date().isoformat(), "policy": policy, "sealed_at": utcnow()})
        return pd.Timestamp(start.date().isoformat(), tz="UTC")

    def holdout_info(self, user_id: int, symbol: str) -> dict | None:
        v = self.db.kv_get(f"holdout:{user_id}:{symbol}")
        if not v:
            return None
        v["accesses"] = self.db.one("SELECT COUNT(*) n FROM holdout_evaluations WHERE user_id=? AND symbol=?", (user_id, symbol))["n"]
        return v

    def holdout_result(self, user_id: int, symbol: str, strategy: str, params: dict, holdout_start: str) -> dict | None:
        r = self.db.one("SELECT * FROM holdout_evaluations WHERE user_id=? AND symbol=? AND strategy=? AND params_json=? AND holdout_start=?",
                        (user_id, symbol, strategy, dumps(params), holdout_start))
        if r:
            r["metrics"] = loads(r.pop("metrics_json"), {})
        return r

    def record_holdout(self, *, user_id: int, symbol: str, strategy: str, params: dict, holdout_start: str, holdout_end: str,
                       metrics: dict, experiment_id: int | None) -> int:
        """Record the single permitted look at the holdout for this configuration."""
        return self.db.insert("holdout_evaluations", {
            "user_id": user_id, "symbol": symbol, "strategy": strategy, "params_json": dumps(params),
            "holdout_start": holdout_start, "holdout_end": holdout_end, "metrics_json": dumps(metrics),
            "experiment_id": experiment_id, "created_at": utcnow()})

    def holdout_accesses(self, user_id: int, symbol: str) -> int:
        return self.db.one("SELECT COUNT(*) n FROM holdout_evaluations WHERE user_id=? AND symbol=?", (user_id, symbol))["n"]


def bonferroni_alpha(alpha: float, k: int) -> float:
    return alpha / max(1, k)


def ceil_div(a: int, b: int) -> int:
    return int(math.ceil(a / b))
