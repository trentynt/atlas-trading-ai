"""Futures contracts and an exact dollar cost model.

Why a separate model from the daily engine: futures P&L is not a percentage of notional. One MNQ contract
gains or loses a fixed dollar amount per index point ($2) and prices move in whole ticks (0.25 points).
Costs are a flat commission per contract per side plus slippage measured in ticks. Using basis points
here would make small trades look cheaper or dearer than they really are.

Facts (see docs/LEARN.md for sources):
* MNQ multiplier $2 × index, tick 0.25 points = $0.50 — VERIFIED (CME Group contract specs, 2026-11-20).
* Commission default $0.62 per contract per side — PLACEHOLDER, VERIFY with your broker / Apex
  (all-in commission + exchange + NFA fees varies by broker).
"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class FuturesContract:
    symbol: str
    name: str
    multiplier: float  # dollars per 1.0 index point
    tick_size: float  # minimum price increment, index points
    session_tz: str = "America/New_York"
    rth_open: str = "09:30"
    rth_close: str = "16:00"

    @property
    def tick_value(self) -> float:
        return self.multiplier * self.tick_size

    def round_to_tick(self, price: float) -> float:
        """Snap a price onto the tick grid (prices between ticks cannot trade)."""
        return round(round(price / self.tick_size) * self.tick_size, 10)

    def points_to_dollars(self, points: float, contracts: int = 1) -> float:
        return points * self.multiplier * contracts


MNQ = FuturesContract("MNQ", "Micro E-mini Nasdaq-100", multiplier=2.0, tick_size=0.25)
NQ = FuturesContract("NQ", "E-mini Nasdaq-100", multiplier=20.0, tick_size=0.25)  # reference only
CONTRACTS = {c.symbol: c for c in (MNQ, NQ)}


@dataclass(frozen=True)
class FuturesCosts:
    commission_per_side: float = 0.62  # $ per contract per side — VERIFY (placeholder)
    slippage_ticks: float = 1.0  # ticks against you on every market/stop fill, per side

    def __post_init__(self):
        if self.commission_per_side < 0 or self.slippage_ticks < 0:
            raise ValueError("costs cannot be negative")


def whole_contracts(qty) -> int:
    """Futures trade in whole contracts only. Anything else is a bug upstream, so fail loudly."""
    if isinstance(qty, bool) or not float(qty).is_integer():
        raise ValueError(f"futures quantity must be a whole number of contracts, got {qty!r}")
    return int(qty)


def fill_price(contract: FuturesContract, side: int, reference: float, costs: FuturesCosts) -> float:
    """Price you actually get: the reference price moved against you by the slippage ticks.
    side +1 = buy (pay more), -1 = sell (receive less)."""
    if side not in (1, -1):
        raise ValueError("side must be +1 (buy) or -1 (sell)")
    return contract.round_to_tick(reference) + side * costs.slippage_ticks * contract.tick_size


@dataclass(frozen=True)
class RoundTurn:
    gross: float  # P&L from the fill prices (slippage already inside the prices)
    commission: float
    slippage: float  # dollars lost to slippage (for reporting; already inside gross)
    net: float
    points: float  # points captured per contract at the fill prices


def round_turn(contract: FuturesContract, direction: int, contracts, entry_ref: float, exit_ref: float,
               costs: FuturesCosts) -> RoundTurn:
    """Dollar P&L of opening and closing a position. direction +1 long, -1 short."""
    n = whole_contracts(contracts)
    if n <= 0:
        raise ValueError("contracts must be positive")
    entry = fill_price(contract, direction, entry_ref, costs)
    exit_ = fill_price(contract, -direction, exit_ref, costs)
    points = (exit_ - entry) * direction
    gross = contract.points_to_dollars(points, n)
    commission = 2 * costs.commission_per_side * n
    slippage = 2 * costs.slippage_ticks * contract.tick_value * n
    return RoundTurn(gross=round(gross, 2), commission=round(commission, 2), slippage=round(slippage, 2),
                     net=round(gross - commission, 2), points=points)


def ticks(contract: FuturesContract, points: float) -> float:
    return points / contract.tick_size if not math.isnan(points) else math.nan
