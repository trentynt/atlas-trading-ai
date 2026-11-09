"""Independent, backend-enforced risk controls. Every order (manual or automated) passes through
`check_order`; every decision is written to the risk_events audit log."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field

from ..data.instruments import INSTRUMENTS, get_instrument
from ..db import Database, dumps, loads, utcnow
from ..events import EventBus
from ..research.indicators import realized_vol, rolling_percentile


class RiskLimits(BaseModel):
    max_drawdown_pct: float = Field(0.20, gt=0, le=1, description="Halt & block new risk beyond this drawdown from peak equity")
    max_daily_loss_pct: float = Field(0.03, gt=0, le=1, description="Block new risk after this loss since UTC day start")
    max_position_exposure_pct: float = Field(0.35, gt=0, le=5, description="Max |net notional| per instrument / equity")
    max_gross_exposure_pct: float = Field(1.50, gt=0, le=10, description="Max Σ|notional| / equity")
    strategy_budget_pct: float = Field(0.40, gt=0, le=5, description="Max |notional| per strategy / equity")
    max_order_notional_pct: float = Field(0.50, gt=0, le=5, description="Max single order notional / equity")
    max_correlation: float = Field(0.85, gt=0, le=1, description="Same-direction positions with 90d corr above this share one exposure limit")
    max_vol_percentile: float = Field(0.98, gt=0, le=1, description="Block new risk when 20d vol is above this 1y percentile")
    max_consecutive_losses: int = Field(6, ge=1, le=100, description="Suspend a strategy after N consecutive losing closes")
    kill_switch: bool = Field(False, description="When on, only exposure-reducing orders are accepted")


@dataclass
class OrderIntent:
    symbol: str
    qty: float  # signed
    price: float
    strategy_id: str


@dataclass
class Decision:
    approved: bool
    rule: str
    message: str


class RiskManager:
    def __init__(self, db: Database, bus: EventBus, data):
        self.db = db
        self.bus = bus
        self.data = data

    # ---------- configuration ----------
    def limits(self) -> RiskLimits:
        return RiskLimits(**self.db.kv_get("risk_limits", {}))

    def update_limits(self, patch: dict) -> RiskLimits:
        new = RiskLimits(**{**self.limits().model_dump(), **patch})
        self.db.kv_set("risk_limits", new.model_dump())
        self.audit("config", "approve", "info", f"Risk limits updated: {patch}", data=patch)
        return new

    def set_kill_switch(self, on: bool, reason: str) -> None:
        self.update_limits({"kill_switch": on})
        self.audit("kill_switch", "halt" if on else "release", "critical" if on else "info",
                   f"Kill switch {'ENGAGED' if on else 'released'}: {reason}")

    # ---------- market context ----------
    def staleness_days(self, symbol: str) -> float | None:
        r = self.db.one("SELECT MAX(ts) ts FROM bars WHERE symbol=? AND timeframe='1d'", (symbol,))
        if not r or not r["ts"]:
            return None
        return (datetime.now(timezone.utc) - datetime.fromisoformat(r["ts"]).replace(tzinfo=timezone.utc)).total_seconds() / 86400

    def vol_percentile(self, symbol: str) -> float | None:
        df = self.data.load(symbol)
        if len(df) < 100:
            return None
        inst = get_instrument(symbol)
        p = rolling_percentile(realized_vol(df["close"], 20, inst.periods_per_year), 252).iloc[-1]
        return None if pd.isna(p) else float(p)

    def correlation_matrix(self, symbols: list[str] | None = None, window: int = 90) -> pd.DataFrame:
        symbols = symbols or list(INSTRUMENTS)
        rets = {}
        for s in symbols:
            df = self.data.load(s)
            if len(df):
                # align on calendar dates; FX has no weekend prints so use inner join of dates
                rets[s] = np.log(df["close"]).diff()
        if not rets:
            return pd.DataFrame()
        m = pd.DataFrame(rets).dropna().iloc[-window:]
        return m.corr() if len(m) > 20 else pd.DataFrame()

    # ---------- the gate ----------
    def check_order(self, intent: OrderIntent, account: dict, positions: list[dict], prices: dict[str, float],
                    order_id: int | None = None) -> tuple[bool, list[Decision]]:
        L = self.limits()
        equity = account["equity"]
        sym_net = sum(p["qty"] for p in positions if p["symbol"] == intent.symbol)
        new_net = sym_net + intent.qty
        reducing = abs(new_net) < abs(sym_net) - 1e-12 and np.sign(new_net) in (0, np.sign(sym_net))
        strat_net = sum(p["qty"] for p in positions if p["symbol"] == intent.symbol and p["strategy_id"] == intent.strategy_id)
        strat_reducing = abs(strat_net + intent.qty) < abs(strat_net) - 1e-12
        decisions: list[Decision] = []

        def rule(name: str, ok: bool, msg: str):
            decisions.append(Decision(ok, name, msg))

        rule("valid_price", intent.price > 0 and np.isfinite(intent.price), f"price={intent.price}")
        if reducing and strat_reducing:
            rule("reduce_only_exemption", True, "Order reduces exposure; risk-increasing checks skipped")
        else:
            rule("kill_switch", not L.kill_switch, "Kill switch engaged — only reducing orders allowed" if L.kill_switch else "off")
            rule("account_state", account["state"] != "halted", f"account state = {account['state']}")
            st = self.staleness_days(intent.symbol)
            max_st = get_instrument(intent.symbol).max_stale_days
            rule("data_staleness", st is not None and st <= max_st + 1,
                 f"latest bar {st:.1f}d old (limit {max_st + 1}d)" if st is not None else "no data")
            dd = equity / account["peak_equity"] - 1 if account["peak_equity"] > 0 else 0
            rule("max_drawdown", dd > -L.max_drawdown_pct, f"drawdown {dd:.2%} vs limit -{L.max_drawdown_pct:.0%}")
            dl = account.get("daily_pnl_pct", 0.0)
            rule("max_daily_loss", dl > -L.max_daily_loss_pct, f"day P&L {dl:.2%} vs limit -{L.max_daily_loss_pct:.0%}")
            order_notional = abs(intent.qty) * intent.price
            rule("max_order_notional", order_notional <= L.max_order_notional_pct * equity + 1e-6,
                 f"order {order_notional:,.0f} vs limit {L.max_order_notional_pct * equity:,.0f}")
            pos_exp = abs(new_net) * intent.price
            rule("max_position_exposure", pos_exp <= L.max_position_exposure_pct * equity + 1e-6,
                 f"{intent.symbol} exposure {pos_exp:,.0f} vs limit {L.max_position_exposure_pct * equity:,.0f}")
            gross = sum(abs(p["qty"]) * prices.get(p["symbol"], 0) for p in positions if p["symbol"] != intent.symbol) + pos_exp
            rule("max_gross_exposure", gross <= L.max_gross_exposure_pct * equity + 1e-6,
                 f"gross {gross:,.0f} vs limit {L.max_gross_exposure_pct * equity:,.0f}")
            strat_exp = abs(strat_net + intent.qty) * intent.price
            budget = L.strategy_budget_pct
            if intent.strategy_id.startswith("sc:"):
                sc = self.db.one("SELECT allocation FROM strategy_configs WHERE id=?", (int(intent.strategy_id[3:]),))
                if sc and sc["allocation"]:
                    budget = min(budget, sc["allocation"] * 1.05)
            rule("strategy_budget", strat_exp <= budget * equity + 1e-6,
                 f"strategy exposure {strat_exp:,.0f} vs budget {budget * equity:,.0f}")
            # correlation clustering: correlated same-direction exposure shares the position limit
            others = {p["symbol"]: 0.0 for p in positions if p["symbol"] != intent.symbol}
            for p in positions:
                if p["symbol"] in others:
                    others[p["symbol"]] += p["qty"] * prices.get(p["symbol"], 0)
            if others:
                corr = self.correlation_matrix([intent.symbol, *others])
                clustered = pos_exp
                for s, notional in others.items():
                    c = corr.loc[intent.symbol, s] if intent.symbol in corr.index and s in corr.columns else 0
                    if abs(c) >= L.max_correlation and np.sign(notional) * np.sign(c) == np.sign(new_net):
                        clustered += abs(notional)
                rule("correlation_cluster", clustered <= L.max_position_exposure_pct * equity * 1.5 + 1e-6,
                     f"correlated cluster exposure {clustered:,.0f}")
            vp = self.vol_percentile(intent.symbol)
            rule("volatility_regime", vp is None or vp <= L.max_vol_percentile,
                 f"20d vol percentile {vp:.0%}" if vp is not None else "insufficient history")
            losses = self._consecutive_losses(intent.strategy_id)
            rule("consecutive_losses", losses < L.max_consecutive_losses,
                 f"{losses} consecutive losing closes (limit {L.max_consecutive_losses})")
        ok = all(d.approved for d in decisions)
        failed = [d for d in decisions if not d.approved]
        msg = (f"APPROVED {intent.symbol} {intent.qty:+.6g} @ {intent.price:.6g} [{intent.strategy_id}]" if ok else
               f"REJECTED {intent.symbol} {intent.qty:+.6g} [{intent.strategy_id}]: " + "; ".join(f"{d.rule}: {d.message}" for d in failed))
        self.audit("order_check", "approve" if ok else "reject", "info" if ok else "warn", msg, order_id,
                   {"checks": [d.__dict__ for d in decisions]})
        return ok, decisions

    def _consecutive_losses(self, strategy_id: str) -> int:
        rows = self.db.query("SELECT realized_pnl FROM fills WHERE strategy_id=? AND realized_pnl != 0 ORDER BY id DESC LIMIT 50",
                             (strategy_id,))
        n = 0
        for r in rows:
            if r["realized_pnl"] < 0:
                n += 1
            else:
                break
        return n

    def audit(self, rule: str, decision: str, severity: str, message: str, order_id: int | None = None,
              data: dict | None = None) -> None:
        self.db.insert("risk_events", {"ts": utcnow(), "rule": rule, "decision": decision, "severity": severity,
                                       "message": message, "order_id": order_id, "data_json": dumps(data or {})})
        self.bus.emit("risk", message, level="warn" if severity in ("warn", "critical") else "info", source="risk",
                      data={"rule": rule, "decision": decision, "node": "risk:gate"})

    def events(self, limit: int = 200) -> list[dict]:
        rows = self.db.query("SELECT * FROM risk_events ORDER BY id DESC LIMIT ?", (limit,))
        for r in rows:
            r["data"] = loads(r.pop("data_json"), {})
        return rows
