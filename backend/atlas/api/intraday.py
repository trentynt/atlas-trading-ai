"""Intraday learning API: data gate status, session replay/practice (PAPER ONLY), session stats, journal."""
from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..futures import apex, holdout
from ..futures.experiments import Experiments, LockedError
from ..futures.minute_data import PROXY_SYMBOL, MinuteStore
from ..futures.practice import DATA_NOTE, Journal, Practice, PracticeError
from ..futures.proxy import PROXY_SCALE
from ..futures.stats import describe

router = APIRouter(prefix="/api/intraday", tags=["intraday"])


def _db(request: Request):
    return request.app.state.services.db


def _guard(fn, *a, **k):
    try:
        return fn(*a, **k)
    except PracticeError as e:
        raise HTTPException(400, str(e))


@router.get("/status")
def status(request: Request):
    db = _db(request)
    st = MinuteStore(db)
    span = db.one("SELECT MIN(ts) a, MAX(ts) b, COUNT(*) n FROM minute_bars WHERE symbol=?", (PROXY_SYMBOL,))
    try:
        apex.load()
        apex_ok = True
    except apex.UnverifiedRules:
        apex_ok = False
    return {"symbol": PROXY_SYMBOL, "proxy_for": "MNQ", "proxy_scale": PROXY_SCALE, "bars": span["n"],
            "first": span["a"], "last": span["b"], "daily_reference_closes": len(st.load_daily(PROXY_SYMBOL)),
            "gate": gate if (gate := db.kv_get(f"data_gate:{PROXY_SYMBOL}")) and gate.get("checks") else None,
            "data_note": DATA_NOTE,
            "keys_present": {k: bool(os.environ.get(k)) for k in ("ALPACA_API_KEY_ID", "ALPACA_API_SECRET_KEY", "TIINGO_API_KEY")},
            "apex_rules_verified": apex_ok, "holdout": holdout.info(db)}


@router.get("/holdout")
def holdout_status(request: Request):
    return {**holdout.info(_db(request)), "log": holdout.unlocks(_db(request))}


@router.get("/sessions")
def sessions(request: Request):
    return Practice(_db(request)).sessions()


@router.get("/stats")
def stats(request: Request, or_minutes: int = Query(15, ge=1, le=120), unlock_reason: str | None = None):
    try:
        df = MinuteStore(_db(request)).load(PROXY_SYMBOL, unlock_reason=unlock_reason, purpose=f"opening stats ({or_minutes} min)")
    except PermissionError as e:
        raise HTTPException(400, str(e))
    if df.empty:
        raise HTTPException(409, "No minute data stored yet. Add the API keys and run the data gate with --download.")
    return describe(df, or_minutes)


class PracticeStart(BaseModel):
    session_date: str
    contracts: int = Field(1, ge=1, le=50)
    stop_ticks: float | None = Field(None, gt=0)
    target_ticks: float | None = Field(None, gt=0)
    daily_loss_limit: float | None = Field(None, gt=0)
    commission_per_side: float = Field(0.62, ge=0)
    slippage_ticks: float = Field(1.0, ge=0)
    holdout_unlock_reason: str | None = None  # required only for sessions inside the sealed holdout; logged


@router.post("/practice")
def practice_start(request: Request, body: PracticeStart):
    return _guard(Practice(_db(request)).start, body.session_date, body.contracts, body.stop_ticks, body.target_ticks,
                  body.daily_loss_limit, body.commission_per_side, body.slippage_ticks, 0, body.holdout_unlock_reason)


@router.get("/practice/{pid}")
def practice_view(request: Request, pid: int):
    return _guard(Practice(_db(request)).view, pid)


@router.post("/practice/{pid}/step")
def practice_step(request: Request, pid: int, n: int = Query(1, ge=1, le=390)):
    return _guard(Practice(_db(request)).step, pid, n)


@router.post("/practice/{pid}/decide")
def practice_decide(request: Request, pid: int, direction: int = Query(..., ge=-1, le=1)):
    return _guard(Practice(_db(request)).decide, pid, direction)


@router.post("/practice/{pid}/finish")
def practice_finish(request: Request, pid: int):
    return _guard(Practice(_db(request)).finish, pid)


@router.get("/paper-trades")
def paper_trades(request: Request):
    return Practice(_db(request)).paper_trades()


# ---------------- experiments (pre-registered, locked, in-sample only) ----------------
def _ex(fn, *a, **k):
    try:
        return fn(*a, **k)
    except LockedError as e:
        raise HTTPException(409, str(e))
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'"))
    except ValueError as e:
        raise HTTPException(422, str(e))


class ExperimentBody(BaseModel):
    name: str
    rationale: str
    spec: dict
    gates: dict | None = None


@router.get("/experiments")
def experiments(request: Request):
    ex = Experiments(_db(request))
    return {"experiments": ex.list(), "trials": ex.trial_counts()}


@router.post("/experiments")
def experiment_create(request: Request, body: ExperimentBody):
    return _ex(Experiments(_db(request)).create, body.name, body.rationale, body.spec, body.gates)


@router.put("/experiments/{eid}")
def experiment_update(request: Request, eid: int, body: ExperimentBody):
    return _ex(Experiments(_db(request)).update, eid, body.name, body.rationale, body.spec, body.gates)


@router.delete("/experiments/{eid}")
def experiment_delete(request: Request, eid: int):
    _ex(Experiments(_db(request)).delete_draft, eid)
    return {"deleted": eid}


@router.post("/experiments/{eid}/register")
def experiment_register(request: Request, eid: int):
    return _ex(Experiments(_db(request)).register, eid)


@router.get("/experiments/{eid}")
def experiment_get(request: Request, eid: int):
    return _ex(Experiments(_db(request)).get, eid)


@router.post("/experiments/{eid}/run")
def experiment_run(request: Request, eid: int):
    return _ex(Experiments(_db(request)).run, eid)


@router.get("/runs/{rid}")
def run_get(request: Request, rid: int):
    return _ex(Experiments(_db(request)).get_run, rid)


@router.get("/journal")
def journal_list(request: Request):
    return Journal(_db(request)).list()


@router.post("/journal")
def journal_add(request: Request, body: dict):
    return _guard(Journal(_db(request)).add, body)


@router.put("/journal/{jid}")
def journal_update(request: Request, jid: int, body: dict):
    return _guard(Journal(_db(request)).update, jid, body)


@router.delete("/journal/{jid}")
def journal_delete(request: Request, jid: int):
    _guard(Journal(_db(request)).delete, jid)
    return {"deleted": jid}
