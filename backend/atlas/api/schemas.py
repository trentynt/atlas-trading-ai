"""Typed request contracts (Pydantic). Responses are plain JSON documents mirrored by TypeScript types
in frontend/src/lib/types.ts."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class CostsIn(BaseModel):
    spread_bps: float | None = Field(None, ge=0, le=500)
    fee_bps: float | None = Field(None, ge=0, le=500)
    slippage_bps: float | None = Field(None, ge=0, le=500)


class BacktestRequest(BaseModel):
    symbol: str
    strategy: str
    params: dict = Field(default_factory=dict)
    start: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    sizing: Literal["fixed_fraction", "vol_target"] = "fixed_fraction"
    fraction: float = Field(1.0, gt=0, le=3)
    vol_target: float = Field(0.10, gt=0, le=1)
    max_leverage: float = Field(1.0, gt=0, le=5)
    initial_cash: float = Field(100_000, gt=0, le=1e9)
    costs: CostsIn = Field(default_factory=CostsIn)
    timeframe: Literal["1d", "1w"] = "1d"
    save: bool = True
    include_holdout: bool = False  # exploratory only: results that include the sealed holdout are labelled as such


class EvaluateRequest(BaseModel):
    symbol: str
    strategy: str
    params: dict = Field(default_factory=dict)
    walk_forward: bool = True


class ForecastRequest(BaseModel):
    symbol: str
    model: Literal["naive", "drift", "rolling_mean", "ar1", "holt"] = "naive"
    horizon: int = Field(20, ge=1, le=120)
    evaluate: bool = True
    eval_origins: int = Field(120, ge=20, le=400)


class OrderRequest(BaseModel):
    symbol: str
    side: Literal["buy", "sell"]
    qty: float = Field(gt=0)
    type: Literal["market", "limit"] = "market"
    limit_price: float | None = Field(None, gt=0)


class ControlRequest(BaseModel):
    action: Literal["start", "pause", "resume", "emergency_stop", "release", "reset"]


class DeployRequest(BaseModel):
    experiment_id: int | None = None
    symbol: str | None = None
    strategy: str | None = None
    params: dict = Field(default_factory=dict)
    allocation: float = Field(0.1, gt=0, le=1)


class StrategyStatusRequest(BaseModel):
    status: Literal["deployed", "paused", "retired"]
    allocation: float | None = Field(None, gt=0, le=1)


class CycleRequest(BaseModel):
    max_hypotheses: int = Field(8, ge=1, le=100)
    symbols: list[str] | None = None
    refresh: bool = True


class RefreshRequest(BaseModel):
    symbols: list[str] | None = None
    full: bool = False
