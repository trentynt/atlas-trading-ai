"""Event-driven backtest engine.

Bar loop, per bar i:
  1. OPEN   — pending market orders (created at close i-1) fill at open[i] ± half-spread ± slippage.
              Close-only datasets (ECB fixes) fill at close[i] instead: a full bar of delay.
  2. INTRABAR — stop-loss / take-profit checks against high/low (close for close-only data). Gaps
              through a stop fill at the open, not the stop. If both levels are touched in one bar the
              stop is assumed first (conservative).
  3. CLOSE  — mark-to-market, record equity.
  4. SIGNAL — strategy target computed from bars[0..i] produces an order for bar i+1.

Signals are computed on data truncated at the end of the evaluation window, so nothing after the
window can influence results.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from ..research.indicators import atr, realized_vol
from ..research.strategies.base import Strategy
from .metrics import performance


@dataclass
class CostModel:
    spread_bps: float = 1.0
    fee_bps: float = 0.0
    slippage_bps: float = 0.5


@dataclass
class BacktestConfig:
    initial_cash: float = 100_000.0
    sizing: str = "fixed_fraction"  # "fixed_fraction" | "vol_target"
    fraction: float = 1.0  # notional as fraction of equity at |target| = 1
    vol_target: float = 0.10  # annualised, used when sizing == vol_target
    max_leverage: float = 1.0
    rebalance_threshold: float = 0.25  # vol_target only: resize when qty deviates > 25%
    costs: CostModel = field(default_factory=CostModel)
    periods_per_year: int = 252
    start: str | None = None  # trading window (ISO dates); signals still use prior history for warm-up
    end: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "BacktestConfig":
        d = dict(d)
        d["costs"] = CostModel(**d.get("costs", {}))
        return cls(**d)


@dataclass
class Order:
    id: int
    created_ts: pd.Timestamp
    qty: float  # signed
    reason: str
    status: str = "pending"  # pending → filled | rejected | cancelled
    fill_ts: pd.Timestamp | None = None
    fill_price: float | None = None
    fee: float = 0.0
    note: str = ""


@dataclass
class BacktestResult:
    metrics: dict
    benchmark: dict
    equity: pd.Series
    benchmark_equity: pd.Series
    drawdown: pd.Series
    position: pd.Series
    trades: list[dict]
    orders: list[dict]
    attribution: dict
    config: dict
    returns: pd.Series

    def to_payload(self, max_points: int = 1500) -> dict:
        step = max(1, len(self.equity) // max_points)
        idx = self.equity.index[::step]
        if len(self.equity) and idx[-1] != self.equity.index[-1]:
            idx = idx.append(self.equity.index[-1:])
        def ser(s):
            return [{"t": t.date().isoformat(), "v": _r(s.get(t))} for t in idx]
        return {
            "metrics": self.metrics, "benchmark": self.benchmark, "attribution": self.attribution,
            "config": self.config, "trades": self.trades[-500:], "orders": self.orders[-300:],
            "series": {"equity": ser(self.equity), "benchmark": ser(self.benchmark_equity),
                       "drawdown": ser(self.drawdown), "position": ser(self.position)},
        }


def _label(x) -> str | None:
    return x if isinstance(x, str) else None


def _r(x) -> float | None:
    return None if x is None or not np.isfinite(x) else float(x)


def run_backtest(df: pd.DataFrame, strategy: Strategy, cfg: BacktestConfig,
                 regimes: pd.Series | None = None) -> BacktestResult:
    if cfg.end:
        df = df[df.index <= pd.Timestamp(cfg.end, tz="UTC")]
    if len(df) < 3:
        raise ValueError("Not enough bars for backtest")
    close = df["close"].to_numpy(float)
    has_ohlc = bool(df[["open", "high", "low"]].notna().all().all())
    open_ = df["open"].to_numpy(float) if has_ohlc else close
    high = df["high"].to_numpy(float) if has_ohlc else close
    low = df["low"].to_numpy(float) if has_ohlc else close
    idx = df.index
    target = strategy.target(df).to_numpy(float)
    atr_v = atr(df, 14).to_numpy(float)
    vol = realized_vol(df["close"], 20, cfg.periods_per_year).to_numpy(float)
    start_i = int(np.searchsorted(idx, pd.Timestamp(cfg.start, tz="UTC"))) if cfg.start else 0
    start_i = max(start_i, 1)
    c = cfg.costs
    exec_cost = (c.spread_bps / 2 + c.slippage_bps) / 1e4
    stop_m, tp_m = strategy.p["stop_atr"], strategy.p["take_profit_atr"]

    cash, qty, avg = cfg.initial_cash, 0.0, 0.0
    stop = tp = None
    pending: Order | None = None
    orders: list[Order] = []
    trades: list[dict] = []
    trade: dict | None = None
    blocked_dir = 0  # after a stop/TP exit, don't re-enter same direction until the signal resets
    eq = np.full(len(df), np.nan)
    pos = np.zeros(len(df))
    costs_paid = {"fees": 0.0, "spread": 0.0, "slippage": 0.0}

    def fill(i: int, dq: float, raw_price: float, reason: str, order: Order | None = None):
        nonlocal cash, qty, avg, trade, stop, tp
        side = np.sign(dq)
        price = raw_price * (1 + side * exec_cost)
        notional = abs(dq) * price
        fee = notional * c.fee_bps / 1e4
        costs_paid["fees"] += fee
        costs_paid["spread"] += abs(dq) * raw_price * c.spread_bps / 2 / 1e4
        costs_paid["slippage"] += abs(dq) * raw_price * c.slippage_bps / 1e4
        cash -= dq * price + fee
        realized = 0.0
        new_qty = qty + dq
        if qty != 0 and np.sign(dq) != np.sign(qty):  # reducing / closing / flipping
            closed = min(abs(dq), abs(qty))
            realized = closed * (price - avg) * np.sign(qty)
        flip = qty != 0 and np.sign(new_qty) != 0 and np.sign(new_qty) != np.sign(qty)
        close_share = abs(qty) / abs(dq) if flip else 1.0  # on a flip, frictions are split pro-rata
        friction = fee + abs(dq) * raw_price * exec_cost
        if trade is not None:
            trade["pnl"] += realized - fee * close_share
            trade["costs"] += friction * close_share
        if new_qty == 0 or (qty != 0 and np.sign(new_qty) != np.sign(qty)):
            if trade is not None:
                trade.update(exit_ts=idx[i].date().isoformat(), exit_price=price, exit_reason=reason,
                             bars_held=i - trade["_entry_i"])
                trade["return"] = trade["pnl"] / trade["_entry_notional"]
                trades.append({k: v for k, v in trade.items() if not k.startswith("_")})
                trade = None
            stop = tp = None
        if new_qty != 0 and (qty == 0 or np.sign(new_qty) != np.sign(qty)):  # opening
            avg = price
            open_share = 1.0 - close_share if flip else 1.0
            trade = {"side": "long" if new_qty > 0 else "short", "entry_ts": idx[i].date().isoformat(),
                     "entry_price": price, "qty": abs(new_qty), "pnl": -fee * open_share,
                     "costs": friction * open_share,
                     "_entry_i": i, "_entry_notional": abs(new_qty) * price,
                     "regime": _label(regimes.iloc[i]) if regimes is not None and i < len(regimes) else None}
            a = atr_v[i - 1] if i > 0 else np.nan
            if stop_m > 0 and np.isfinite(a):
                stop = price - np.sign(new_qty) * stop_m * a
            if tp_m > 0 and np.isfinite(a):
                tp = price + np.sign(new_qty) * tp_m * a
        elif np.sign(new_qty) == np.sign(qty) and abs(new_qty) > abs(qty):  # adding
            avg = (avg * abs(qty) + price * abs(dq)) / abs(new_qty)
            if trade is not None:
                trade["qty"] = abs(new_qty)
                trade["_entry_notional"] += abs(dq) * price
        qty = new_qty
        if order is not None:
            order.status, order.fill_ts, order.fill_price, order.fee = "filled", idx[i], price, fee

    for i in range(len(df)):
        in_window = i >= start_i
        # 1. execute pending order
        if pending is not None:
            px = open_[i] if has_ohlc else close[i]
            if np.isfinite(px) and px > 0:
                fill(i, pending.qty, px, pending.reason, pending)
            else:
                pending.status, pending.note = "rejected", "no valid execution price"
            pending = None
        # 2. stops / take-profit (armed late if the position opened before ATR had warmed up)
        if qty != 0 and i > 0 and np.isfinite(atr_v[i - 1]):
            if stop is None and stop_m > 0:
                stop = avg - np.sign(qty) * stop_m * atr_v[i - 1]
            if tp is None and tp_m > 0:
                tp = avg + np.sign(qty) * tp_m * atr_v[i - 1]
        if qty != 0 and (stop is not None or tp is not None):
            s = np.sign(qty)
            o_, h_, l_ = open_[i], high[i], low[i]
            hit_stop = stop is not None and ((s > 0 and l_ <= stop) or (s < 0 and h_ >= stop))
            hit_tp = tp is not None and ((s > 0 and h_ >= tp) or (s < 0 and l_ <= tp))
            if hit_stop:
                px = (min(o_, stop) if s > 0 else max(o_, stop)) if has_ohlc else close[i]
                orders.append(Order(len(orders) + 1, idx[i], -qty, "stop_loss"))
                fill(i, -qty, px, "stop_loss", orders[-1])
                blocked_dir = int(s)
            elif hit_tp:
                px = (max(o_, tp) if s > 0 else min(o_, tp)) if has_ohlc else close[i]
                orders.append(Order(len(orders) + 1, idx[i], -qty, "take_profit"))
                fill(i, -qty, px, "take_profit", orders[-1])
                blocked_dir = int(s)
        # 3. mark to market
        equity = cash + qty * close[i]
        eq[i] = equity
        pos[i] = qty * close[i] / equity if equity > 0 else 0.0
        if equity <= 0:
            eq[i:] = equity
            break
        # 4. signal → order for next bar
        if not in_window or i == len(df) - 1:
            continue
        tgt = target[i]
        if blocked_dir and np.sign(tgt) != blocked_dir:
            blocked_dir = 0
        if blocked_dir and np.sign(tgt) == blocked_dir:
            tgt = 0.0
        if cfg.sizing == "vol_target" and np.isfinite(vol[i]) and vol[i] > 0:
            lev = min(cfg.max_leverage, cfg.vol_target / vol[i])
        else:
            lev = min(cfg.fraction, cfg.max_leverage)
        desired = tgt * lev * equity / close[i]
        dq = desired - qty
        if abs(dq) < 1e-12:
            continue
        sign_change = np.sign(desired) != np.sign(qty)
        if not sign_change:
            if cfg.sizing != "vol_target":
                continue  # fixed fraction: don't churn on price drift
            if abs(dq) < cfg.rebalance_threshold * abs(qty):
                continue
        pending = Order(len(orders) + 1, idx[i], dq, "signal")
        orders.append(pending)

    # close any open position at the final close (marked as "end_of_test", costs applied)
    last = len(df) - 1
    if qty != 0:
        orders.append(Order(len(orders) + 1, idx[last], -qty, "end_of_test"))
        fill(last, -qty, close[last], "end_of_test", orders[-1])
        eq[last] = cash
    if pending is not None and pending.status == "pending":
        pending.status = "cancelled"

    eq_s = pd.Series(eq, index=idx).ffill()
    window = eq_s.iloc[start_i - 1:] if start_i > 0 else eq_s
    pos_s = pd.Series(pos, index=idx).iloc[start_i - 1:]
    exposure = float((pos_s.iloc[1:].abs() > 1e-9).mean()) if len(pos_s) > 1 else 0.0
    window_trades = [t for t in trades if t["entry_ts"] >= window.index[0].date().isoformat()]
    metrics = performance(window, window_trades, cfg.periods_per_year, exposure)
    bench = pd.Series(close, index=idx).iloc[start_i - 1:]
    bench_eq = cfg.initial_cash * bench / bench.iloc[0]
    benchmark = performance(bench_eq, [], cfg.periods_per_year, 1.0)
    benchmark = {k: benchmark.get(k) for k in ("total_return", "annualized_return", "max_drawdown", "sharpe", "sortino", "annualized_vol")}
    _, dd = (lambda e: (0, e / e.cummax() - 1))(window)
    metrics["costs_paid"] = {k: round(v, 2) for k, v in costs_paid.items()}
    metrics["excess_return_vs_benchmark"] = (metrics["total_return"] - benchmark["total_return"]
                                             if metrics.get("total_return") is not None and benchmark.get("total_return") is not None else None)
    return BacktestResult(
        metrics=metrics, benchmark=benchmark, equity=window, benchmark_equity=bench_eq, drawdown=dd,
        position=pos_s, trades=window_trades,
        orders=[{"id": o.id, "created": o.created_ts.date().isoformat(), "qty": o.qty, "reason": o.reason,
                 "status": o.status, "fill_ts": o.fill_ts.date().isoformat() if o.fill_ts is not None else None,
                 "fill_price": o.fill_price, "fee": o.fee, "note": o.note} for o in orders
                if o.created_ts >= window.index[0]],
        attribution=_attribution(window_trades, costs_paid),
        config={"strategy": strategy.key, "params": strategy.p, **cfg.to_dict()},
        returns=window.pct_change().dropna(),
    )


def _attribution(trades: list[dict], costs: dict) -> dict:
    def agg(key: str) -> dict[str, Any]:
        out: dict[str, dict] = {}
        for t in trades:
            k = str(t.get(key))
            d = out.setdefault(k, {"pnl": 0.0, "trades": 0, "wins": 0})
            d["pnl"] += t["pnl"]
            d["trades"] += 1
            d["wins"] += int(t["pnl"] > 0)
        return {k: {**v, "pnl": round(v["pnl"], 2)} for k, v in out.items()}
    return {"by_side": agg("side"), "by_exit_reason": agg("exit_reason"), "by_regime": agg("regime"),
            "total_costs": round(sum(costs.values()), 2),
            "gross_pnl_before_costs": round(sum(t["pnl"] for t in trades) + sum(t["costs"] for t in trades), 2)}
