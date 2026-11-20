"""Convert QQQ proxy prices to Nasdaq-100 index-equivalent points, so MNQ dollar maths ($2/point,
0.25 tick) can be applied to them.

PROXY_SCALE ≈ Nasdaq-100 index level ÷ QQQ price. INFERENCE: about 41 in recent years. It drifts slowly
(QQQ pays dividends; the fund has costs). Check it yourself: divide today's Nasdaq-100 level by QQQ's
price and set ATLAS_PROXY_SCALE. It only changes the dollar SCALE of results, never when signals fire.
"""
from __future__ import annotations

import os

import pandas as pd

PROXY_SCALE = float(os.environ.get("ATLAS_PROXY_SCALE", "41.0"))


def to_index_points(df: pd.DataFrame, scale: float = PROXY_SCALE) -> pd.DataFrame:
    out = df.copy()
    for k in ("open", "high", "low", "close"):
        out[k] = out[k] * scale
    return out
