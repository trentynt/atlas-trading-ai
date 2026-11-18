"""Paper-trading broker and autonomous signal executor.

PAPER ONLY. There is deliberately no code path to any real broker. Fills are simulated at the last
observed daily close (or ECB reference fix) adjusted by the instrument's spread + slippage, plus fees.
A future live adapter would have to implement the same interface behind separate authorisation."""
from __future__ import annotations

import threading
from datetime import datetime, timezone

import numpy as np

from ..data.instruments import INSTRUMENTS, get_instrument
from ..db import Database, loads, utcnow
from ..events import EventBus
from ..research.strategies.library import get_strategy
from ..risk.manager import OrderIntent, RiskManager

STATES = ("running", "paused", "halted")


class PaperError(ValueError):
    pass


class PaperBroker:
    def __init__(self, db: Database, bus: EventBus, data, risk: RiskManager, initial_cash: float):
        self.db = db
        self.bus = bus
        self.data = data
        self.risk = risk
        self._lock = threading.RLock()
        if not self.db.one("SELECT id FROM paper_account WHERE id=1"):
            self.db.insert("paper_account", {"id": 1, "cash": initial_cash, "initial_cash": initial_cash,
                                             "state": "paused", "updated_at": utcnow(), "peak_equity": initial_cash})

    # ---------- valuation ----------
    def prices(self) -> dict[str, float]:
        out = {}
        for s in INSTRUMENTS:
            r = self.db.one("SELECT close FROM bars WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 1", (s,))
            if r:
                out[s] = float(r["close"])
        return out

    def positions(self) -> list[dict]:
        return self.db.query("SELECT * FROM positions WHERE qty != 0 ORDER BY symbol, strategy_id")

    def account(self) -> dict:
        a = self.db.one("SELECT * FROM paper_account WHERE id=1")
        px = self.prices()
        pos = self.positions()
        mv = sum(p["qty"] * px.get(p["symbol"], p["avg_price"]) for p in pos)
        gross = sum(abs(p["qty"]) * px.get(p["symbol"], p["avg_price"]) for p in pos)
        equity = a["cash"] + mv
        unreal = sum(p["qty"] * (px.get(p["symbol"], p["avg_price"]) - p["avg_price"]) for p in pos)
        realized = self.db.one("SELECT COALESCE(SUM(realized_pnl),0) r, COALESCE(SUM(fee),0) f FROM fills")
        day = datetime.now(timezone.utc).date().isoformat()
        sod = self.db.one("SELECT equity FROM portfolio_snapshots WHERE ts < ? ORDER BY id DESC LIMIT 1", (day,))
        sod_eq = sod["equity"] if sod else a["initial_cash"]
        return {**a, "equity": equity, "market_value": mv, "gross_exposure": gross, "net_exposure": mv,
                "unrealized_pnl": unreal, "realized_pnl": realized["r"], "fees_paid": realized["f"],
                "total_return": equity / a["initial_cash"] - 1, "drawdown": equity / max(a["peak_equity"], equity) - 1,
                "daily_pnl_pct": equity / sod_eq - 1 if sod_eq else 0.0,
                "mode": "PAPER", "pricing": "last observed daily close / ECB reference fix"}

    def snapshot(self) -> dict:
        a = self.account()
        peak = max(a["peak_equity"], a["equity"])
        self.db.execute("UPDATE paper_account SET peak_equity=?, updated_at=? WHERE id=1", (peak, utcnow()))
        self.db.insert("portfolio_snapshots", {"ts": utcnow(), "cash": a["cash"], "equity": a["equity"],
                                               "gross_exposure": a["gross_exposure"], "net_exposure": a["net_exposure"],
                                               "drawdown": a["equity"] / peak - 1})
        return a

    # ---------- orders ----------
    def place_order(self, symbol: str, side: str, qty: float, order_type: str = "market", limit_price: float | None = None,
                    strategy_id: str = "manual", reason: str = "manual") -> dict:
        inst = get_instrument(symbol)
        if side not in ("buy", "sell"):
            raise PaperError("side must be buy or sell")
        if not (qty > 0 and np.isfinite(qty)):
            raise PaperError("qty must be positive")
        if order_type not in ("market", "limit"):
            raise PaperError("type must be market or limit")
        if order_type == "limit" and not (limit_price and limit_price > 0):
            raise PaperError("limit orders require a positive limit_price")
        with self._lock:
            px = self.prices().get(inst.symbol)
            if px is None:
                raise PaperError(f"No market data for {inst.symbol}; refresh data first")
            oid = self.db.insert("orders", {"created_at": utcnow(), "symbol": inst.symbol, "side": side, "qty": qty,
                                            "type": order_type, "limit_price": limit_price, "status": "new",
                                            "strategy_id": strategy_id, "reason": reason})
            signed = qty if side == "buy" else -qty
            check_px = limit_price if order_type == "limit" else px
            ok, decisions = self.risk.check_order(OrderIntent(inst.symbol, signed, check_px, strategy_id),
                                                  self.account(), self.positions(), self.prices(), oid)
            if not ok:
                why = "; ".join(f"{d.rule}: {d.message}" for d in decisions if not d.approved)
                self.db.execute("UPDATE orders SET status='rejected', reject_reason=? WHERE id=?", (why, oid))
                self.bus.emit("paper", f"Order #{oid} rejected by risk: {why}", level="warn", source="paper",
                              data={"order_id": oid, "node": "paper:broker"})
            elif order_type == "market":
                self._fill(oid, px)
            else:
                self.db.execute("UPDATE orders SET status='open' WHERE id=?", (oid,))
                self.bus.emit("paper", f"Limit order #{oid} open: {side} {qty:g} {inst.symbol} @ {limit_price}",
                              source="paper", data={"order_id": oid, "node": "paper:broker"})
            return self.db.one("SELECT * FROM orders WHERE id=?", (oid,))

    def cancel_order(self, order_id: int) -> dict:
        with self._lock:
            o = self.db.one("SELECT * FROM orders WHERE id=?", (order_id,))
            if not o:
                raise PaperError(f"order {order_id} not found")
            if o["status"] != "open":
                raise PaperError(f"order {order_id} is {o['status']}; only open orders can be cancelled")
            self.db.execute("UPDATE orders SET status='cancelled' WHERE id=?", (order_id,))
            self.bus.emit("paper", f"Order #{order_id} cancelled", source="paper", data={"order_id": order_id})
            return self.db.one("SELECT * FROM orders WHERE id=?", (order_id,))

    def _fill(self, oid: int, ref_px: float) -> None:
        o = self.db.one("SELECT * FROM orders WHERE id=?", (oid,))
        inst = get_instrument(o["symbol"])
        sign = 1 if o["side"] == "buy" else -1
        price = ref_px * (1 + sign * (inst.default_spread_bps / 2 + inst.default_slippage_bps) / 1e4)
        if o["type"] == "limit":
            price = min(price, o["limit_price"]) if sign > 0 else max(price, o["limit_price"])
        fee = abs(o["qty"]) * price * inst.default_fee_bps / 1e4
        dq = sign * o["qty"]
        with self.db.tx() as c:
            p = c.execute("SELECT * FROM positions WHERE symbol=? AND strategy_id=?", (o["symbol"], o["strategy_id"])).fetchone()
            qty, avg = (p["qty"], p["avg_price"]) if p else (0.0, 0.0)
            realized = 0.0
            if qty != 0 and np.sign(dq) != np.sign(qty):
                realized = min(abs(dq), abs(qty)) * (price - avg) * np.sign(qty)
            new_qty = qty + dq
            if abs(new_qty) < 1e-12:
                new_qty, new_avg = 0.0, 0.0
            elif qty == 0 or np.sign(new_qty) != np.sign(qty):
                new_avg = price
            elif abs(new_qty) > abs(qty):
                new_avg = (avg * abs(qty) + price * abs(dq)) / abs(new_qty)
            else:
                new_avg = avg
            if p:
                c.execute("UPDATE positions SET qty=?, avg_price=? WHERE symbol=? AND strategy_id=?",
                          (new_qty, new_avg, o["symbol"], o["strategy_id"]))
            else:
                c.execute("INSERT INTO positions(symbol,strategy_id,qty,avg_price,opened_at) VALUES(?,?,?,?,?)",
                          (o["symbol"], o["strategy_id"], new_qty, new_avg, utcnow()))
            c.execute("UPDATE paper_account SET cash = cash - ? - ?, updated_at=? WHERE id=1", (dq * price, fee, utcnow()))
            c.execute("UPDATE orders SET status='filled', filled_price=?, filled_at=?, fee=? WHERE id=?", (price, utcnow(), fee, oid))
            c.execute("INSERT INTO fills(order_id,ts,symbol,side,qty,price,fee,realized_pnl,strategy_id) VALUES(?,?,?,?,?,?,?,?,?)",
                      (oid, utcnow(), o["symbol"], o["side"], o["qty"], price, fee, realized, o["strategy_id"]))
        self.bus.emit("paper", f"FILLED #{oid} {o['side']} {o['qty']:.6g} {o['symbol']} @ {price:.6g} (fee {fee:.2f}, realized {realized:+.2f})",
                      source="paper", data={"order_id": oid, "node": "paper:broker", "symbol": o["symbol"]})

    # ---------- control ----------
    def set_state(self, action: str) -> dict:
        a = self.db.one("SELECT state FROM paper_account WHERE id=1")["state"]
        if action in ("start", "resume"):
            if a == "halted" or self.risk.limits().kill_switch:
                raise PaperError("Account halted by emergency stop / kill switch. Release the kill switch first.")
            new = "running"
        elif action == "pause":
            new = "paused"
        elif action == "emergency_stop":
            return self.emergency_stop("manual emergency stop")
        elif action == "release":
            self.risk.set_kill_switch(False, "manual release")
            new = "paused"
        else:
            raise PaperError(f"unknown action {action}")
        self.db.execute("UPDATE paper_account SET state=?, updated_at=? WHERE id=1", (new, utcnow()))
        self.bus.emit("paper", f"Paper engine state: {a} → {new}", source="paper", data={"node": "paper:broker"})
        return self.account()

    def emergency_stop(self, reason: str) -> dict:
        with self._lock:
            self.db.execute("UPDATE paper_account SET state='halted', updated_at=? WHERE id=1", (utcnow(),))
            self.risk.set_kill_switch(True, reason)
            for o in self.db.query("SELECT id FROM orders WHERE status='open'"):
                self.db.execute("UPDATE orders SET status='cancelled', reject_reason='emergency stop' WHERE id=?", (o["id"],))
            for p in self.positions():  # flatten: reduce-only orders pass the kill switch
                self.place_order(p["symbol"], "sell" if p["qty"] > 0 else "buy", abs(p["qty"]),
                                 strategy_id=p["strategy_id"], reason="emergency flatten")
            self.bus.emit("paper", f"EMERGENCY STOP: {reason}. Orders cancelled, positions flattened.", level="error",
                          source="paper", data={"node": "paper:broker"})
            return self.account()

    def reset(self) -> dict:
        with self._lock:
            a = self.db.one("SELECT * FROM paper_account WHERE id=1")
            if a["state"] == "running":
                raise PaperError("Pause the engine before resetting the paper account")
            with self.db.tx() as c:
                for t in ("positions", "orders", "fills", "portfolio_snapshots"):
                    c.execute(f"DELETE FROM {t}")
                c.execute("UPDATE paper_account SET cash=initial_cash, peak_equity=initial_cash, state='paused', updated_at=? WHERE id=1",
                          (utcnow(),))
            self.bus.emit("paper", "Paper account reset to initial cash", level="warn", source="paper")
            return self.account()

    # ---------- autonomous execution ----------
    def tick(self) -> dict:
        """Process open limit orders; when running, align deployed strategies with their latest signals."""
        summary = {"limit_fills": 0, "orders": 0, "rejected": 0, "state": None}
        with self._lock:
            px = self.prices()
            for o in self.db.query("SELECT * FROM orders WHERE status='open'"):
                p = px.get(o["symbol"])
                if p is None:
                    continue
                if (o["side"] == "buy" and p <= o["limit_price"]) or (o["side"] == "sell" and p >= o["limit_price"]):
                    self._fill(o["id"], p)
                    summary["limit_fills"] += 1
            acct = self.snapshot()
            summary["state"] = acct["state"]
            L = self.risk.limits()
            if acct["drawdown"] <= -L.max_drawdown_pct and acct["state"] != "halted":
                self.emergency_stop(f"max drawdown breached ({acct['drawdown']:.2%})")
                summary["state"] = "halted"
                return summary
            if acct["state"] != "running":
                return summary
            for sc in self.db.query("SELECT id FROM strategy_configs WHERE status IN ('retired','paused')"):
                for p in self.db.query("SELECT * FROM positions WHERE strategy_id=? AND qty != 0", (f"sc:{sc['id']}",)):
                    self.place_order(p["symbol"], "sell" if p["qty"] > 0 else "buy", abs(p["qty"]), strategy_id=p["strategy_id"],
                                     reason="strategy retired/paused: flatten")
                    summary["orders"] += 1
            for sc in self.db.query("SELECT * FROM strategy_configs WHERE status='deployed'"):
                try:
                    r = self._align(sc, acct, px)
                except Exception as e:
                    self.bus.emit("paper", f"Strategy #{sc['id']} evaluation failed: {e}", level="error", source="paper")
                    continue
                if r:
                    summary["orders"] += 1
                    summary["rejected"] += int(r["status"] == "rejected")
            self.snapshot()
        self.bus.emit("paper", f"Paper tick: {summary}", source="paper", data={"node": "paper:broker", **summary})
        return summary

    def _align(self, sc: dict, acct: dict, px: dict) -> dict | None:
        sym = sc["symbol"]
        df = self.data.load(sym)
        if len(df) < 260 or sym not in px:
            return None
        strat = get_strategy(sc["strategy"])(**loads(sc["params_json"], {}))
        tgt = float(strat.target(df).iloc[-1])
        sid = f"sc:{sc['id']}"
        cur = self.db.one("SELECT qty FROM positions WHERE symbol=? AND strategy_id=?", (sym, sid))
        cur_q = cur["qty"] if cur else 0.0
        desired = tgt * sc["allocation"] * acct["equity"] / px[sym]
        dq = desired - cur_q
        if abs(dq) < 1e-12 or (np.sign(desired) == np.sign(cur_q) and abs(dq) < 0.2 * abs(cur_q)):
            return None
        self.bus.emit("agent", f"Signal {strat.key} on {sym}: target {tgt:+.0f} → order {dq:+.6g}", source="paper",
                      data={"node": f"strategy:{sc['id']}"})
        return self.place_order(sym, "buy" if dq > 0 else "sell", abs(dq), strategy_id=sid,
                                reason=f"signal {strat.key} target={tgt:+.0f} (bar {df.index[-1].date()})")
