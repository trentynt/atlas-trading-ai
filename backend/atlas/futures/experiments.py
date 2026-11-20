"""No-code intraday experiments: fixed building blocks, pre-registration, locked specs, honest results.

Lifecycle:  draft (editable) → registered (spec + gates LOCKED forever) → runs (each run = a recorded trial)
A change to a registered experiment means a new experiment. Runs read only the OPEN data: MinuteStore.load
is called without an unlock, so the sealed holdout (holdout.py) is never visible here.

Execution rules (same as the backtester, docs/LEARN.md):
* Decisions are made on a bar's close and filled at the NEXT bar's open, with slippage ticks against you.
* Stops/targets are checked inside every bar after entry, including the entry bar; if one bar touches both,
  the stop counts first; if a bar opens beyond the stop, the fill is the open.
* One trade per session at most. No entries after 15:50 (12:50 on early-close days). Flat by the session close.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field, field_validator, model_validator

from ..backtest.metrics import deflated_sharpe, expected_max_sharpe
from ..db import Database, dumps, loads, utcnow
from ..research.registry import TrialRegistry
from .calendar import EARLY_CLOSES, last_bar
from .contracts import MNQ, FuturesCosts, fill_price
from .minute_data import NY, PROXY_SYMBOL, MinuteStore
from .proxy import PROXY_SCALE, to_index_points

MARKET = "MNQ"  # registry market name for all intraday experiments (QQQ proxy data)
ACCOUNT = 50_000.0  # notional account for converting daily dollars to returns (Sharpe / deflated Sharpe)
BOOTSTRAP_RESAMPLES = 10_000


class LockedError(RuntimeError):
    pass


# ---------------- specification ----------------
class Stop(BaseModel):
    kind: Literal["or_opposite", "ticks", "atr"]
    value: float | None = None  # ticks, or ATR multiple

    @model_validator(mode="after")
    def _v(self):
        if self.kind != "or_opposite" and (self.value is None or self.value <= 0):
            raise ValueError("stop value must be > 0 for ticks / ATR stops")
        return self


class Exit(BaseModel):
    kind: Literal["session_close", "target_r", "clock"]
    value: float | str | None = None  # R multiple, or "HH:MM" New York

    @model_validator(mode="after")
    def _v(self):
        if self.kind == "target_r" and (not isinstance(self.value, (int, float)) or self.value <= 0):
            raise ValueError("target must be a positive R multiple")
        if self.kind == "clock":
            h, m = str(self.value).split(":")
            if not (9 * 60 + 31 <= int(h) * 60 + int(m) <= 15 * 60 + 59):
                raise ValueError("exit time must be between 09:31 and 15:59")
            self.value = f"{int(h):02d}:{int(m):02d}"
        return self


class Filters(BaseModel):
    weekdays: list[int] | None = None  # 0=Mon … 4=Fri; None = all
    gap_min_bps: float | None = None  # |gap| bounds, basis points
    gap_max_bps: float | None = None
    prior_range_min_bps: float | None = None  # prior session high-low, basis points
    prior_range_max_bps: float | None = None

    @field_validator("weekdays")
    @classmethod
    def _wd(cls, v):
        if v is not None and (not v or any(d not in range(5) for d in v)):
            raise ValueError("weekdays must be a non-empty list of 0–4")
        return sorted(set(v)) if v else v


class Spec(BaseModel):
    or_minutes: int = Field(ge=1, le=60)
    entry: Literal["or_breakout", "first_bar_direction"]
    direction: Literal["long", "short", "both"] = "both"
    stop: Stop
    exit: Exit
    filters: Filters = Field(default_factory=Filters)
    contracts: Literal[1] = 1
    commission_per_side: float = Field(0.62, ge=0)
    slippage_ticks: float = Field(1.0, ge=0)


class Gates(BaseModel):
    min_net_expectancy: float = 0.0  # $ per trade, must be ABOVE this
    max_bootstrap_p: float = Field(0.05, gt=0, lt=1)
    drop_best_days: int = Field(5, ge=0, le=50)  # must stay positive without the N best days
    slippage_multiple: float = Field(2.0, ge=1, le=10)  # must stay positive at this × slippage


def spec_hash(name: str, rationale: str, spec: Spec, gates: Gates) -> str:
    blob = json.dumps({"name": name, "rationale": rationale, "spec": spec.model_dump(), "gates": gates.model_dump()},
                      sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


# ---------------- simulation ----------------
def _features(df: pd.DataFrame) -> pd.DataFrame:
    """Per-session values known BEFORE each session opens: prior close, prior range, 14-session ATR,
    gap. Values are blank after a break in the data (e.g. across the sealed holdout)."""
    local = df.index.tz_convert(NY)
    g = df.groupby(local.date.astype(str))
    d = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(), "close": g["close"].last()})
    dates = pd.to_datetime(d.index)
    contiguous = pd.Series((dates[1:] - dates[:-1]).days <= 5, index=d.index[1:]).reindex(d.index, fill_value=False)
    prev_close = d["close"].shift(1).where(contiguous)
    tr = pd.concat([d["high"] - d["low"], (d["high"] - prev_close).abs(), (d["low"] - prev_close).abs()], axis=1).max(axis=1)
    block = (~contiguous).cumsum()  # ATR only within an unbroken run of sessions
    atr = tr.groupby(block).transform(lambda s: s.rolling(14, min_periods=14).mean()).shift(1).where(contiguous)
    return pd.DataFrame({"prev_close": prev_close,
                         "prior_range_bps": ((d["high"] - d["low"]) / d["close"] * 1e4).shift(1).where(contiguous),
                         "atr": atr, "gap_bps": (d["open"] / prev_close - 1) * 1e4, "weekday": dates.weekday}, index=d.index)


def _passes_filters(f: Filters, row) -> bool:
    if f.weekdays is not None and row.weekday not in f.weekdays:
        return False
    checks = ((f.gap_min_bps, f.gap_max_bps, abs(row.gap_bps) if pd.notna(row.gap_bps) else None),  # gap size, either way
              (f.prior_range_min_bps, f.prior_range_max_bps, row.prior_range_bps if pd.notna(row.prior_range_bps) else None))
    for lo, hi, v in checks:
        if lo is None and hi is None:
            continue
        if v is None:
            return False  # unknown (first session, or just after a data break) → no trade, never guess
        if (lo is not None and v < lo) or (hi is not None and v > hi):
            return False
    return True


def simulate(df: pd.DataFrame, spec: Spec, slippage_ticks: float | None = None) -> tuple[list[dict], pd.Series]:
    """Run the spec over index-point bars. Returns (trades, daily net P&L in $ for EVERY session)."""
    c = MNQ
    costs = FuturesCosts(spec.commission_per_side, spec.slippage_ticks if slippage_ticks is None else slippage_ticks)
    feats = _features(df)
    local = df.index.tz_convert(NY)
    days = local.date.astype(str)
    trades, daily = [], {}
    for day, g in df.groupby(days, sort=True):
        daily[day] = 0.0
        hm = g.index.tz_convert(NY).strftime("%H:%M")
        n = spec.or_minutes
        if len(g) <= n or hm[0] != "09:30":
            continue
        row = feats.loc[day]
        if not _passes_filters(spec.filters, row):
            continue
        o, h, l, cl = (g[k].to_numpy(float) for k in ("open", "high", "low", "close"))
        or_hi, or_lo = h[:n].max(), l[:n].min()
        cutoff = "12:50" if day in EARLY_CLOSES else "15:50"
        # 1. decision bar and side (decided on a bar's close, filled at the next open)
        side, k = 0, None
        if spec.entry == "first_bar_direction":
            side = int(np.sign(cl[0] - o[0]))
            k = n - 1  # decided when the opening range is complete
        else:
            for j in range(n, len(g) - 1):
                if hm[j] >= cutoff:
                    break
                if cl[j] > or_hi:
                    side, k = 1, j
                    break
                if cl[j] < or_lo:
                    side, k = -1, j
                    break
        if side == 0 or k is None or k + 1 >= len(g) - 1 or hm[k] >= cutoff:
            continue
        if (spec.direction == "long" and side < 0) or (spec.direction == "short" and side > 0):
            continue
        e = k + 1
        entry = fill_price(c, side, o[e], costs)
        # 2. stop and target
        if spec.stop.kind == "or_opposite":
            stop = or_lo if side > 0 else or_hi
        elif spec.stop.kind == "ticks":
            stop = entry - side * spec.stop.value * c.tick_size
        else:
            if not np.isfinite(row.atr):
                continue  # not enough history for ATR → no trade
            stop = c.round_to_tick(entry - side * spec.stop.value * row.atr)
        risk = (entry - stop) * side
        if risk <= 0:
            continue  # entry already beyond the stop: no valid risk, no trade
        target = entry + side * spec.exit.value * risk if spec.exit.kind == "target_r" else None
        # 3. manage the position bar by bar
        exit_px, reason, x = None, None, None
        last = len(g) - 1
        for j in range(e, len(g)):
            if spec.exit.kind == "clock" and j > e and hm[j] >= spec.exit.value:
                exit_px, reason, x = fill_price(c, -side, o[j], costs), "clock", j
                break
            hit_stop = (side > 0 and l[j] <= stop) or (side < 0 and h[j] >= stop)
            hit_tgt = target is not None and ((side > 0 and h[j] >= target) or (side < 0 and l[j] <= target))
            if hit_stop:
                gap = (side > 0 and o[j] < stop) or (side < 0 and o[j] > stop)
                exit_px, reason, x = fill_price(c, -side, o[j] if gap and j > e else stop, costs), "stop_gap" if gap and j > e else "stop", j
                break
            if hit_tgt:
                exit_px, reason, x = fill_price(c, -side, max(o[j], target) if side > 0 else min(o[j], target), costs), "target", j
                break
            if j == last:
                exit_px, reason, x = fill_price(c, -side, cl[j], costs), "session_close", j
        points = (exit_px - entry) * side
        gross = points * c.multiplier * spec.contracts
        comm = 2 * costs.commission_per_side * spec.contracts
        net = round(gross - comm, 2)
        daily[day] = net
        trades.append({"session": day, "side": "long" if side > 0 else "short",
                       "entry_ts": g.index[e].tz_convert(NY).isoformat(), "entry": entry, "stop": round(stop, 2),
                       "target": round(target, 2) if target is not None else None,
                       "exit_ts": g.index[x].tz_convert(NY).isoformat(), "exit": exit_px, "exit_reason": reason,
                       "points": round(points, 2), "r": round(points / risk, 3), "gross": round(gross, 2),
                       "commission": round(comm, 2), "slippage": round(2 * costs.slippage_ticks * c.tick_value * spec.contracts, 2),
                       "net": net})
    return trades, pd.Series(daily, dtype=float).sort_index()


def bootstrap_p(nets: np.ndarray, seed: int) -> float | None:
    """One-sided p-value for 'mean net P&L per trade > 0': resample the trades with the mean removed
    (the no-edge world) and count how often chance alone reaches the observed mean."""
    x = np.asarray(nets, float)
    if len(x) < 10:
        return None
    rng = np.random.default_rng(seed)
    centered = x - x.mean()
    means = centered[rng.integers(0, len(x), (BOOTSTRAP_RESAMPLES, len(x)))].mean(axis=1)
    return float((np.sum(means >= x.mean()) + 1) / (BOOTSTRAP_RESAMPLES + 1))


# ---------------- store ----------------
class Experiments:
    def __init__(self, db: Database, loader=None):
        self.db = db
        self.reg = TrialRegistry(db)
        self.loader = loader or (lambda: to_index_points(MinuteStore(db).load(PROXY_SYMBOL)))  # never unlocks the holdout

    # drafts
    def create(self, name: str, rationale: str, spec: dict, gates: dict | None = None) -> dict:
        s, g = Spec(**spec), Gates(**(gates or {}))
        name, rationale = name.strip(), rationale.strip()
        if not name or len(rationale) < 10:
            raise ValueError("An experiment needs a name and a one-sentence reason why it should work.")
        if self.db.one("SELECT id FROM intraday_experiments WHERE name=?", (name,)):
            raise ValueError(f"An experiment named {name!r} already exists. Changes need a new name.")
        now = utcnow()
        eid = self.db.insert("intraday_experiments", {"name": name, "rationale": rationale, "spec_json": dumps(s.model_dump()),
                                                      "gates_json": dumps(g.model_dump()), "status": "draft",
                                                      "created_at": now, "updated_at": now})
        return self.get(eid)

    def update(self, eid: int, name: str | None = None, rationale: str | None = None, spec: dict | None = None,
               gates: dict | None = None) -> dict:
        e = self.get(eid)
        if e["status"] != "draft":
            raise LockedError("This experiment is registered and locked. A change means a new experiment.")
        s = Spec(**(spec if spec is not None else e["spec"]))
        g = Gates(**(gates if gates is not None else e["gates"]))
        self.db.execute("UPDATE intraday_experiments SET name=?, rationale=?, spec_json=?, gates_json=?, updated_at=? WHERE id=? AND status='draft'",
                        ((name or e["name"]).strip(), (rationale or e["rationale"]).strip(), dumps(s.model_dump()),
                         dumps(g.model_dump()), utcnow(), eid))
        return self.get(eid)

    def delete_draft(self, eid: int) -> None:
        if self.get(eid)["status"] != "draft":
            raise LockedError("Registered experiments are permanent records and cannot be deleted.")
        self.db.execute("DELETE FROM intraday_experiments WHERE id=? AND status='draft'", (eid,))

    def register(self, eid: int) -> dict:
        e = self.get(eid)
        if e["status"] != "draft":
            raise LockedError("Already registered.")
        h = spec_hash(e["name"], e["rationale"], Spec(**e["spec"]), Gates(**e["gates"]))
        self.db.execute("UPDATE intraday_experiments SET status='registered', registered_at=?, spec_hash=? WHERE id=? AND status='draft'",
                        (utcnow(), h, eid))
        return self.get(eid)

    def get(self, eid: int) -> dict:
        r = self.db.one("SELECT * FROM intraday_experiments WHERE id=?", (eid,))
        if not r:
            raise KeyError("experiment not found")
        r["spec"], r["gates"] = loads(r.pop("spec_json"), {}), loads(r.pop("gates_json"), {})
        r["runs"] = self.db.query("SELECT id, ran_at, sessions, trades, net_pnl, passed, trial_id FROM intraday_runs "
                                  "WHERE experiment_id=? ORDER BY id DESC", (eid,))
        return r

    def list(self) -> list[dict]:
        ids = [r["id"] for r in self.db.query("SELECT id FROM intraday_experiments ORDER BY id DESC")]
        return [self.get(i) for i in ids]

    def trial_counts(self) -> dict:
        g = self.reg.global_stats(1)
        m = self.db.one("SELECT COUNT(*) n FROM trials WHERE user_id=1 AND symbol=?", (MARKET,))["n"]
        return {"global": g["n_raw"], "mnq": m, "markets": g["markets"]}

    # running
    def run(self, eid: int) -> dict:
        e = self.get(eid)
        if e["status"] != "registered":
            raise LockedError("Register the experiment first: only locked, pre-registered experiments can run.")
        spec, gates = Spec(**e["spec"]), Gates(**e["gates"])
        if spec_hash(e["name"], e["rationale"], spec, gates) != e["spec_hash"]:
            raise LockedError("Stored spec does not match its registration hash; refusing to run.")
        bars = self.loader()
        if bars.empty:
            raise ValueError("No open (non-holdout) minute data stored.")
        trades, daily = simulate(bars, spec)
        _, daily_2x = simulate(bars, spec, slippage_ticks=spec.slippage_ticks * gates.slippage_multiple)
        nets = np.array([t["net"] for t in trades])
        seed = int(e["spec_hash"][:8], 16)
        p = bootstrap_p(nets, seed)
        expectancy = float(nets.mean()) if len(nets) else None
        best = daily.sort_values(ascending=False).head(gates.drop_best_days).index
        without_best = float(daily.drop(best).sum())
        returns = daily / ACCOUNT
        returns.index = pd.to_datetime(returns.index, utc=True)  # registry stores time-indexed return series
        # Record the trial FIRST, so this run counts toward the luck bar it is judged against.
        tid = self.reg.register(user_id=1, kind="manual_intraday", symbol=MARKET, strategy=e["name"],
                                params={"experiment_id": eid, **spec.model_dump()}, dataset_version=f"{daily.index[0]}..{daily.index[-1]}",
                                window=(daily.index[0], daily.index[-1]), returns=returns, p_value=p,
                                sharpe=float(returns.mean() / returns.std(ddof=1) * math.sqrt(252)) if returns.std(ddof=1) > 0 else None,
                                method="intraday_experiment")
        fam, glob = self.reg.family_stats(1, MARKET), self.reg.global_stats(1)

        def dsr(f):
            n = max(2, int(round(f["n_eff"])))
            return (deflated_sharpe(returns, n, f["sr_var"]) if f["sr_var"] > 0 else None,
                    expected_max_sharpe(n, f["sr_var"]) * math.sqrt(252) if f["sr_var"] > 0 else None)
        dsr_m, bar_m = dsr(fam)
        dsr_g, bar_g = dsr(glob)
        checks = [
            {"gate": "Net expectancy per trade", "value": expectancy, "threshold": f"> ${gates.min_net_expectancy:.2f}",
             "passed": expectancy is not None and expectancy > gates.min_net_expectancy},
            {"gate": "Bootstrap p-value (edge could be luck)", "value": p, "threshold": f"< {gates.max_bootstrap_p}",
             "passed": p is not None and p < gates.max_bootstrap_p},
            {"gate": f"Net P&L without the {gates.drop_best_days} best days", "value": round(without_best, 2), "threshold": "> $0",
             "passed": without_best > 0},
            {"gate": f"Net P&L at {gates.slippage_multiple:g}× slippage", "value": round(float(daily_2x.sum()), 2), "threshold": "> $0",
             "passed": float(daily_2x.sum()) > 0},
        ]
        result = {
            "experiment": {k: e[k] for k in ("id", "name", "rationale", "spec", "gates", "spec_hash", "registered_at")},
            "data": {"from": daily.index[0], "to": daily.index[-1], "sessions": int(len(daily)), "proxy": f"QQQ ×{PROXY_SCALE:g} (MNQ proxy)",
                     "holdout": "excluded (sealed)"},
            "checks": checks, "passed": all(c["passed"] for c in checks),
            "summary": {"trades": len(trades), "net_pnl": round(float(daily.sum()), 2), "expectancy": expectancy,
                        "win_rate": round(float((nets > 0).mean()), 4) if len(nets) else None,
                        "avg_r": round(float(np.mean([t["r"] for t in trades])), 3) if trades else None,
                        "commission": round(sum(t["commission"] for t in trades), 2),
                        "slippage": round(sum(t["slippage"] for t in trades), 2),
                        "net_without_best_days": round(without_best, 2), "best_days_removed": list(best),
                        "net_at_slippage_multiple": round(float(daily_2x.sum()), 2)},
            "deflated_sharpe": {"market": dsr_m, "global": dsr_g, "luck_bar_sharpe_market": bar_m, "luck_bar_sharpe_global": bar_g,
                                "stricter": min([x for x in (dsr_m, dsr_g) if x is not None], default=None),
                                "trials_market": fam["n_raw"], "trials_global": glob["n_raw"]},
            "equity": [{"t": d, "v": round(float(v), 2)} for d, v in (ACCOUNT + daily.cumsum()).items()],
            "equity_without_best_days": [{"t": d, "v": round(float(v), 2)} for d, v in (ACCOUNT + daily.drop(best).cumsum()).items()],
            "trades": trades,
            "trial_id": tid,
        }
        rid = self.db.insert("intraday_runs", {"experiment_id": eid, "ran_at": utcnow(), "sessions": len(daily), "trades": len(trades),
                                               "net_pnl": result["summary"]["net_pnl"], "passed": int(result["passed"]),
                                               "trial_id": tid, "result_json": dumps(result)})
        self.db.execute("UPDATE trials SET experiment_id=? WHERE id=?", (rid, tid))
        return {"run_id": rid, **result}

    def get_run(self, rid: int) -> dict:
        r = self.db.one("SELECT * FROM intraday_runs WHERE id=?", (rid,))
        if not r:
            raise KeyError("run not found")
        return {"run_id": rid, "ran_at": r["ran_at"], **loads(r["result_json"], {})}


ORB1 = {
    "name": "ORB-1",
    "rationale": "The direction of the first one-minute bar may reflect overnight order imbalance that keeps pushing price "
                 "the same way through the rest of the session.",
    "spec": {"or_minutes": 5, "entry": "first_bar_direction", "direction": "both", "stop": {"kind": "or_opposite"},
             "exit": {"kind": "session_close"}, "filters": {}, "contracts": 1, "commission_per_side": 0.62, "slippage_ticks": 1.0},
}


def ensure_seed(db: Database) -> None:
    """Pre-load ORB-1 as a registered (locked) experiment, once. It is never run automatically."""
    if db.one("SELECT id FROM intraday_experiments WHERE name=?", (ORB1["name"],)):
        return
    ex = Experiments(db)
    ex.register(ex.create(ORB1["name"], ORB1["rationale"], ORB1["spec"])["id"])
