"""Reusable strategy interface. A strategy maps a bar history to a TARGET POSITION series in [-1, 1].

Contract (enforced by tests): target[t] may depend only on bars[0..t]. The backtest engine executes
target[t] at the NEXT bar's open (or next close for close-only data), so no same-bar look-ahead."""
from __future__ import annotations

import abc
import itertools
import random
from dataclasses import asdict, dataclass, field
from typing import Any, ClassVar

import pandas as pd


@dataclass(frozen=True)
class Param:
    name: str
    kind: str  # "int" | "float" | "bool"
    default: Any
    low: float | None = None
    high: float | None = None
    grid: tuple = ()
    description: str = ""


@dataclass
class StrategySpec:
    key: str
    name: str
    family: str
    description: str
    rules: list[str]
    risk_assumptions: list[str]
    params: list[dict] = field(default_factory=list)
    preferred_regimes: list[str] = field(default_factory=list)


# Risk params shared by every strategy and applied by the backtest engine
COMMON_PARAMS: tuple[Param, ...] = (
    Param("stop_atr", "float", 0.0, 0.0, 10.0, (0.0, 2.0, 3.0), "Stop-loss distance in ATR(14) multiples; 0 = none"),
    Param("take_profit_atr", "float", 0.0, 0.0, 20.0, (0.0, 4.0), "Take-profit distance in ATR(14) multiples; 0 = none"),
    Param("allow_short", "bool", True, grid=(True, False), description="Permit short positions"),
)


class Strategy(abc.ABC):
    key: ClassVar[str]
    name: ClassVar[str]
    family: ClassVar[str]
    description: ClassVar[str]
    rules: ClassVar[list[str]]
    risk_assumptions: ClassVar[list[str]] = [
        "Signals computed at bar close; orders execute at next bar open (next close for close-only data).",
        "Position sized by the engine (fixed fraction or volatility target), max 1x gross leverage by default.",
    ]
    params: ClassVar[tuple[Param, ...]]
    preferred_regimes: ClassVar[list[str]] = []

    def __init__(self, **kwargs: Any):
        self.p = self.resolve_params(kwargs)
        self.validate()

    @classmethod
    def all_params(cls) -> tuple[Param, ...]:
        return cls.params + COMMON_PARAMS

    @classmethod
    def resolve_params(cls, given: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        known = {p.name: p for p in cls.all_params()}
        unknown = set(given) - set(known)
        if unknown:
            raise ValueError(f"Unknown parameters for {cls.key}: {sorted(unknown)}")
        for name, p in known.items():
            v = given.get(name, p.default)
            if p.kind == "int":
                v = int(v)
            elif p.kind == "float":
                v = float(v)
            elif p.kind == "bool":
                v = bool(v)
            if p.low is not None and v < p.low or p.high is not None and v > p.high:
                raise ValueError(f"{cls.key}.{name}={v} outside [{p.low}, {p.high}]")
            out[name] = v
        return out

    def validate(self) -> None:  # override for cross-parameter constraints
        pass

    @abc.abstractmethod
    def raw_signal(self, df: pd.DataFrame) -> pd.Series:
        """Return desired position in {-1, 0, 1} (or fractional), NaN during warm-up."""

    def target(self, df: pd.DataFrame) -> pd.Series:
        s = self.raw_signal(df).astype(float).fillna(0.0).clip(-1, 1)
        if not self.p["allow_short"]:
            s = s.clip(lower=0)
        return s

    @classmethod
    def spec(cls) -> StrategySpec:
        return StrategySpec(cls.key, cls.name, cls.family, cls.description, list(cls.rules),
                            list(cls.risk_assumptions), [asdict(p) for p in cls.all_params()], list(cls.preferred_regimes))

    @classmethod
    def grid(cls, include_common: bool = False) -> list[dict]:
        ps = cls.all_params() if include_common else cls.params
        combos = [dict(zip([p.name for p in ps], vals)) for vals in itertools.product(*[p.grid or (p.default,) for p in ps])]
        valid = []
        for c in combos:
            try:
                cls(**c)
                valid.append(c)
            except ValueError:
                pass
        return valid

    @classmethod
    def sample(cls, rng: random.Random, n: int) -> list[dict]:
        g = cls.grid(include_common=True)
        rng.shuffle(g)
        return g[:n]
