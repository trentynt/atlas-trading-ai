from __future__ import annotations

from dataclasses import dataclass


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


INSTRUMENTS: dict[str, Instrument] = {
    i.symbol: i for i in [
        Instrument("EUR/USD", "fx", "EUR", "USD", ("frankfurter",), 252, 4, 1.0, 0.0, 0.5, 5),
        Instrument("GBP/USD", "fx", "GBP", "USD", ("frankfurter",), 252, 4, 1.5, 0.0, 0.5, 5),
        Instrument("USD/JPY", "fx", "USD", "JPY", ("frankfurter",), 252, 4, 1.5, 0.0, 0.5, 3),
        Instrument("BTC/USD", "crypto", "BTC", "USD", ("coinbase", "kraken"), 365, 2, 5.0, 10.0, 5.0, 2),
        Instrument("ETH/USD", "crypto", "ETH", "USD", ("coinbase", "kraken"), 365, 2, 5.0, 10.0, 5.0, 2),
    ]
}


def get_instrument(symbol: str) -> Instrument:
    try:
        return INSTRUMENTS[symbol.upper()]
    except KeyError as e:
        raise KeyError(f"Unknown instrument {symbol!r}. Supported: {', '.join(INSTRUMENTS)}") from e


def slug(symbol: str) -> str:
    return symbol.replace("/", "-")


def unslug(s: str) -> str:
    return s.replace("-", "/").upper()
