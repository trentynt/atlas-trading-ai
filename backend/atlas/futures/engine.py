"""Intraday futures backtester (1-minute bars, Regular Trading Hours).

Per bar i (all prices in index points, P&L in dollars):
  1. OPEN      a pending order (decided at the close of bar i-1) fills at open[i] ± slippage ticks.
               Orders never carry across sessions: a signal on a session's last bar is dropped.
  2. INTRABAR  protective stop / profit target, set in ticks from the entry fill. If a bar touches BOTH,
               the stop is assumed to have happened first (conservative). If the bar opens beyond the
               stop (a gap), the fill is at the open, not at the stop.
  3. CLOSE     mark to market. Daily loss limit: if the session's realised + open P&L is at or below
               -limit, an exit is ordered for the next bar's open and no new entries are allowed that day.
  4. SESSION   on the session's last bar the position is closed at that bar's close (± slippage), so the
               account is always flat overnight.
  5. SIGNAL    target position from `signals[i]` (computed only from bars up to i) → order for bar i+1.
               No new entries after `last_entry` (default 15:50 New York).

Annualisation: intraday P&L is summed per session and Sharpe uses those DAILY returns × √252. Per-minute
returns are autocorrelated and mostly zero, so √(252·390) would overstate precision.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from .contracts import MNQ, FuturesContract, FuturesCosts, fill_price, whole_contracts
from .minute_data import NY

SESSIONS_PER_YEAR = 252


@dataclass
class IntradayConfig:
    contracts: int = 1
    initial_equity: float = 50_000.0
    costs: FuturesCosts = field(default_factory=FuturesCosts)
    stop_ticks: float | None = None  # protective stop distance from the entry fill, in ticks
    target_ticks: float | None = None  # profit target distance, in ticks
    daily_loss_limit: float | None = None  # dollars per session (e.g. a prop-firm rule; see apex_rules.toml)
    last_entry: str = "15:50"  # New York time; no new positions after this minute

    def __post_init__(self):
        self.contracts = whole_contracts(self.contracts)
        if self.contracts <= 0:
            raise ValueError("contracts must be at least 1")

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class IntradayResult:
    trades: list[dict]
    daily: pd.DataFrame  # per session: pnl, equity, return, trades, stopped_by_loss_limit
    equity: pd.Series  # per bar, dollars
    position: pd.Series  # per bar, signed contracts
    metrics: dict
    config: dict
    state: dict | None = None  # open_end runs only: position, pending order and open trade at the last bar


def _ts(t: pd.Timestamp) -> str:
    return t.tz_convert(NY).isoformat()


def run_intraday(df: pd.DataFrame, signals: pd.Series, cfg: IntradayConfig,
                 contract: FuturesContract = MNQ, open_end: bool = False) -> IntradayResult:
    """open_end=True: the data stops mid-session (bar-by-bar practice). The last bar is NOT treated as
    the session close, nothing is force-closed, and the live state is returned instead."""
    if df.empty:
        raise ValueError("no bars")
    if not df.index.is_monotonic_increasing:
        raise ValueError("bars must be in time order")
    sig = signals.reindex(df.index).fillna(0.0).clip(-1, 1).to_numpy()
    o, h, l, c = (df[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    local = df.index.tz_convert(NY)
    day = np.asarray(local.date.astype(str))
    hm = np.asarray(local.strftime("%H:%M"))
    n = len(df)
    last_of_day = np.r_[day[1:] != day[:-1], not open_end]
    tick, mult, costs = contract.tick_size, contract.multiplier, cfg.costs

    pos = 0  # signed contracts
    entry_px = 0.0
    stop = target = None
    pending: tuple[int, str] | None = None  # (target position, reason)
    realized_day = 0.0
    locked = False  # daily loss limit hit
    blocked = 0  # direction blocked after a stop/target exit until the signal resets
    cur_day = None
    cash = cfg.initial_equity
    trades: list[dict] = []
    trade: dict | None = None
    eq = np.empty(n)
    pos_s = np.zeros(n)
    day_rows: dict[str, dict] = {}

    def execute(i: int, new_pos: int, ref: float, reason: str, at_open: bool):
        """Move from `pos` to `new_pos` at reference price `ref` (slippage applied per side)."""
        nonlocal pos, entry_px, stop, target, cash, realized_day, trade
        if new_pos == pos:
            return
        if pos != 0:  # close the existing position first (a reversal = exit + new entry)
            side = -int(np.sign(pos))
            px = fill_price(contract, side, ref, costs)
            gross = (px - entry_px) * np.sign(pos) * abs(pos) * mult
            comm = costs.commission_per_side * abs(pos)
            cash += gross - comm
            realized_day += gross - comm
            trade["commission"] += comm
            trade.update(exit_ts=_ts(df.index[i]), exit_price=px, exit_reason=reason,
                         points=round((px - entry_px) * np.sign(pos), 4))
            trade["gross"] = round(gross, 2)
            trade["net"] = round(gross - trade["commission"], 2)
            trade["commission"] = round(trade["commission"], 2)
            trade["bars_held"] = i - trade.pop("_i")
            trades.append(trade)
            trade, pos, stop, target = None, 0, None, None
        if new_pos != 0:
            side = int(np.sign(new_pos))
            px = fill_price(contract, side, ref, costs)
            comm = costs.commission_per_side * abs(new_pos)
            cash -= comm
            realized_day -= comm
            pos, entry_px = new_pos, px
            stop = px - side * cfg.stop_ticks * tick if cfg.stop_ticks else None
            target = px + side * cfg.target_ticks * tick if cfg.target_ticks else None
            trade = {"side": "long" if side > 0 else "short", "contracts": abs(new_pos), "entry_ts": _ts(df.index[i]),
                     "entry_price": px, "entry_reason": reason, "commission": comm, "session": day[i], "_i": i}

    for i in range(n):
        if day[i] != cur_day:  # new session
            cur_day, realized_day, locked, blocked = day[i], 0.0, False, 0
            day_rows[cur_day] = {"start_equity": cash}
        # 1. pending order at this bar's open
        if pending is not None:
            execute(i, pending[0], o[i], pending[1], True)
            pending = None
        # 2. stop / target inside the bar (stop first if both are touched)
        if pos != 0:
            s = int(np.sign(pos))
            hit_stop = stop is not None and ((s > 0 and l[i] <= stop) or (s < 0 and h[i] >= stop))
            hit_tgt = target is not None and ((s > 0 and h[i] >= target) or (s < 0 and l[i] <= target))
            if hit_stop:
                gap = (s > 0 and o[i] < stop) or (s < 0 and o[i] > stop)
                execute(i, 0, o[i] if gap else stop, "stop_gap" if gap else "stop", False)
                blocked = s
            elif hit_tgt:
                gap = (s > 0 and o[i] > target) or (s < 0 and o[i] < target)
                execute(i, 0, o[i] if gap else target, "target", False)
                blocked = s
        # 3. mark to market + daily loss limit
        open_pnl = (c[i] - entry_px) * np.sign(pos) * abs(pos) * mult if pos else 0.0
        eq[i] = cash + open_pnl
        pos_s[i] = pos
        if cfg.daily_loss_limit is not None and not locked and realized_day + open_pnl <= -abs(cfg.daily_loss_limit):
            locked = True
            day_rows[cur_day]["stopped_by_loss_limit"] = hm[i]
            if pos != 0 and not last_of_day[i]:
                pending = (0, "daily_loss_limit")
                continue
        # 4. session close: always flat overnight
        if last_of_day[i]:
            if pos != 0:
                execute(i, 0, c[i], "session_close", False)
                eq[i] = cash
                pos_s[i] = 0
            pending = None
            continue
        # 5. signal → order for the next bar
        direction = int(np.sign(sig[i]))
        if blocked and direction != blocked:
            blocked = 0  # the signal has reset since the stop/target exit
        if blocked and direction == blocked:
            direction = 0  # don't re-enter the same way straight after a stop/target exit
        want = direction * cfg.contracts
        if locked:
            want = 0  # after the daily loss limit: flat for the rest of the session
        elif hm[i] >= cfg.last_entry and want != pos:
            want = 0  # late in the session: exits allowed, no new or reversed positions
        if want != pos:
            pending = (want, "signal")

    state = None
    if open_end:
        state = {"position": pos, "entry_price": entry_px if pos else None, "stop": stop, "target": target,
                 "pending": {"position": pending[0], "reason": pending[1]} if pending else None,
                 "open_trade": {k: v for k, v in trade.items() if not k.startswith("_")} if trade else None,
                 "open_pnl": round((c[-1] - entry_px) * np.sign(pos) * abs(pos) * mult, 2) if pos else 0.0,
                 "loss_limit_hit": locked}
    elif pos != 0:  # data ended mid-session
        execute(n - 1, 0, c[-1], "end_of_data", False)
        eq[-1] = cash

    equity = pd.Series(eq, index=df.index)
    sess_end = pd.Series(eq, index=day).groupby(level=0).last()
    rows = []
    for d, end in sess_end.items():
        start = day_rows[d]["start_equity"]
        rows.append({"session": d, "pnl": round(end - start, 2), "equity": round(end, 2),
                     "return": (end - start) / start if start > 0 else 0.0,
                     "trades": sum(1 for t in trades if t["session"] == d),
                     "stopped_by_loss_limit": day_rows[d].get("stopped_by_loss_limit")})
    daily = pd.DataFrame(rows).set_index("session")
    return IntradayResult(trades=trades, daily=daily, equity=equity, position=pd.Series(pos_s, index=df.index),
                          metrics=intraday_metrics(daily, trades, cfg.initial_equity), config=cfg.to_dict(), state=state)


def intraday_metrics(daily: pd.DataFrame, trades: list[dict], initial: float) -> dict:
    r = daily["return"] if len(daily) else pd.Series(dtype=float)
    sd = r.std(ddof=1) if len(r) > 2 else float("nan")
    eq = daily["equity"] if len(daily) else pd.Series([initial])
    dd = (eq / eq.cummax().clip(lower=initial) - 1).min() if len(eq) else 0.0
    nets = [t["net"] for t in trades]
    return {
        "sessions": int(len(daily)), "trades": len(trades),
        "net_pnl": round(float(daily["pnl"].sum()), 2) if len(daily) else 0.0,
        "commission": round(sum(t["commission"] for t in trades), 2),
        "win_rate": round(float(sum(x > 0 for x in nets)) / len(nets), 4) if nets else None,
        "avg_trade": round(float(np.mean(nets)), 2) if nets else None,
        "sharpe_daily_annualised": round(float(r.mean() / sd * math.sqrt(SESSIONS_PER_YEAR)), 3) if sd and sd > 0 else None,
        "max_drawdown": round(float(dd), 4),
        "worst_session": round(float(daily["pnl"].min()), 2) if len(daily) else None,
        "sessions_stopped_by_loss_limit": int(daily["stopped_by_loss_limit"].notna().sum()) if len(daily) else 0,
        "annualisation": "daily P&L, sqrt(252)",
    }


def assert_causal(signal_fn, df: pd.DataFrame, cut: int) -> None:
    """Look-ahead check for any signal function: values up to `cut` must not depend on later bars."""
    full = signal_fn(df).iloc[:cut]
    part = signal_fn(df.iloc[:cut])
    pd.testing.assert_series_equal(full, part, check_names=False, obj=f"signal before bar {cut}")
