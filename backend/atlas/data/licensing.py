"""Data-source licensing register. See docs/DATA_LICENSING.md for the evidence behind each entry.

A source may serve data to other people (deployment_mode="beta") only when its terms were read and
permit that use. Anything unverified or restricted stays limited to the operator's own personal research
(deployment_mode="personal"). Nothing here is legal advice; statuses record what could be verified.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Status = Literal["verified", "unverified", "restricted", "not_integrated"]


@dataclass(frozen=True)
class SourceLicense:
    name: str
    status: Status
    terms_url: str
    checked_on: str  # ISO date the terms were last checked
    summary: str
    attribution: str
    beta_allowed: bool  # may serve data to invited beta users


LICENSES: dict[str, SourceLicense] = {
    "frankfurter": SourceLicense(
        "frankfurter", "verified",
        "https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html",
        "2026-11-18",
        "ECB statistics may be reused free of charge, for commercial or non-commercial use, provided the source "
        "is quoted and the statistics are not modified. Reference rates are for information only, not transactions.",
        "Source: ECB statistics (via Frankfurter).", True),
    "coinbase": SourceLicense(
        "coinbase", "unverified", "https://www.coinbase.com/legal/market_data", "2026-11-18",
        "Use of the Exchange Market Data API is bound by Coinbase's Market Data Terms of Use. The terms page could "
        "not be retrieved for review (HTTP 403 to automated access). Coinbase lists authorised redistribution "
        "partners, which suggests redistribution needs a licence.",
        "Coinbase Exchange public market data.", False),
    "kraken": SourceLicense(
        "kraken", "restricted", "https://www.kraken.com/legal/global-terms", "2026-11-18",
        "Global Terms (updated 2026-11-06) grant use of 'Our Content' only for your own benefit and prohibit "
        "making it available to any third party or commercially exploiting it without written permission.",
        "Kraken public market data.", False),
    "binance": SourceLicense(
        "binance", "not_integrated", "https://www.binance.com/en/terms", "2026-11-18",
        "Not integrated. Terms body could not be retrieved; Binance Vision historical data is under a "
        "non-commercial licence. Binance.com availability in Canada and the US is restricted.",
        "", False),
}

MODES = ("personal", "beta")


def source_allowed(provider: str, mode: str) -> bool:
    """Whether data from `provider` may be fetched and shown in this deployment mode."""
    if mode not in MODES:
        raise ValueError(f"deployment_mode must be one of {MODES}")
    if provider.startswith("byo:"):  # user-supplied data, shown only to that user (see docs/BYO_DATA.md)
        return True
    lic = LICENSES.get(provider)
    if lic is None:
        return mode == "personal"
    if lic.status == "not_integrated":
        return False
    return True if mode == "personal" else lic.beta_allowed


def describe(mode: str) -> list[dict]:
    return [{"source": l.name, "status": l.status, "terms_url": l.terms_url, "checked_on": l.checked_on,
             "summary": l.summary, "allowed": source_allowed(l.name, mode)} for l in LICENSES.values()]
