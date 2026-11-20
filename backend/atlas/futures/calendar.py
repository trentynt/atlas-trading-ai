"""NYSE regular-session hours, including early (13:00 New York) closes.

* 2026–2028: VERIFIED — NYSE "Holidays & Trading Hours", https://www.nyse.com/markets/hours-calendars,
  read 2026-11-20 ("Each market will close early at 1:00 p.m." on the listed dates).
* 2023–2025: INFERENCE — the same NYSE rules (Independence Day eve, day after Thanksgiving, Christmas Eve)
  applied to those years, corroborated by the stored minute data: every listed day has a truncated,
  thin session after 13:00 (299–381 bars), while normal sessions have 390.
Full holidays need no list: no bars are stored for them.
Add future years from the NYSE page when they are published.
"""
from __future__ import annotations

EARLY_CLOSES: dict[str, str] = {
    "2023-07-03": "INFERENCE", "2023-11-24": "INFERENCE",
    "2024-07-03": "INFERENCE", "2024-11-29": "INFERENCE", "2024-12-24": "INFERENCE",
    "2025-07-03": "INFERENCE", "2025-11-28": "INFERENCE", "2025-12-24": "INFERENCE",
    "2026-11-27": "VERIFIED", "2026-12-24": "VERIFIED",
    "2027-11-26": "VERIFIED",
    "2028-07-03": "VERIFIED", "2028-11-24": "VERIFIED",
}

OPEN_MIN = 9 * 60 + 30
REGULAR_CLOSE_MIN = 16 * 60
EARLY_CLOSE_MIN = 13 * 60


def close_minute(date: str) -> int:
    """Minutes after midnight (New York) when the regular session ends on `date`."""
    return EARLY_CLOSE_MIN if date in EARLY_CLOSES else REGULAR_CLOSE_MIN


def last_bar(date: str) -> str:
    m = close_minute(date) - 1
    return f"{m // 60:02d}:{m % 60:02d}"
