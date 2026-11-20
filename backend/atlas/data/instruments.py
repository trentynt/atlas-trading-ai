from __future__ import annotations

from dataclasses import dataclass

from ..config import get_settings


@dataclass(frozen=True)
class Instrument:
    symbol: str
    asset_class: str  # "fx" | "crypto"
    base: str
    quote: str
    providers: tuple[str, ...]  # priority order; later ones are failover
    periods_per_year: int  # for annualisation of daily statistics
    max_stale_days: int  # data-staleness tolerance (FX has weekend gaps)
    default_spread_bps: float
    default_fee_bps: float
    default_slippage_bps: float
    price_decimals: int


# Liquid USD-quoted crypto that may be enabled. Costs are deliberately conservative retail assumptions
# (spread, taker fee, slippage in bps); smaller assets get wider spreads and more slippage.
LIQUID_CRYPTO: dict[str, tuple[float, float, float, int]] = {
    "BTC": (5.0, 10.0, 5.0, 2), "ETH": (5.0, 10.0, 5.0, 2),
    "SOL": (8.0, 10.0, 8.0, 2), "XRP": (8.0, 10.0, 8.0, 4), "LTC": (10.0, 10.0, 10.0, 2),
    "ADA": (10.0, 10.0, 10.0, 4), "DOGE": (10.0, 10.0, 10.0, 5), "AVAX": (12.0, 10.0, 12.0, 2),
    "LINK": (12.0, 10.0, 12.0, 3), "DOT": (12.0, 10.0, 12.0, 3),
}
DEFAULT_CRYPTO = ("BTC", "ETH")

FX: list[Instrument] = [
    Instrument("EUR/USD", "fx", "EUR", "USD", ("frankfurter",), 252, 4, 1.0, 0.0, 0.5, 5),
    Instrument("GBP/USD", "fx", "GBP", "USD", ("frankfurter",), 252, 4, 1.5, 0.0, 0.5, 5),
    Instrument("USD/JPY", "fx", "USD", "JPY", ("frankfurter",), 252, 4, 1.5, 0.0, 0.5, 3),
]


def parse_crypto_assets(raw: str | None) -> tuple[str, ...]:
    """Parse a comma list such as "BTC,ETH,SOL". BTC and ETH are always included; unknown or illiquid
    assets are rejected rather than silently ignored."""
    assets = [a.strip().upper() for a in (raw or "").split(",") if a.strip()]
    unknown = [a for a in assets if a not in LIQUID_CRYPTO]
    if unknown:
        raise ValueError(f"Unsupported crypto asset(s) {unknown}. Allowed: {', '.join(LIQUID_CRYPTO)}")
    out = list(DEFAULT_CRYPTO)
    out += [a for a in assets if a not in out]
    return tuple(out)


def build_instruments(crypto_assets: tuple[str, ...] = DEFAULT_CRYPTO) -> dict[str, Instrument]:
    crypto = []
    for a in crypto_assets:
        spread, fee, slip, dec = LIQUID_CRYPTO[a]
        crypto.append(Instrument(f"{a}/USD", "crypto", a, "USD", ("coinbase", "kraken"), 365, 2, spread, fee, slip, dec))
    # Crypto first: it is the primary research universe; FX is reference-rate only.
    return {i.symbol: i for i in [*crypto, *FX]}


INSTRUMENTS: dict[str, Instrument] = build_instruments(parse_crypto_assets(get_settings().crypto_assets))


def get_instrument(symbol: str) -> Instrument:
    try:
        return INSTRUMENTS[symbol.upper()]
    except KeyError as e:
        raise KeyError(f"Unknown instrument {symbol!r}. Supported: {', '.join(INSTRUMENTS)}") from e


def slug(symbol: str) -> str:
    return symbol.replace("/", "-")


def unslug(s: str) -> str:
    return s.replace("-", "/").upper()
