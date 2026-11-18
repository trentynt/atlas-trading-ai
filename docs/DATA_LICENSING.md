# Market data licensing

Last checked: **2026-11-18**. This records what could be verified from each source's published terms. It is not legal advice. Before the closed beta shows any exchange data to invited users, a person with authority should confirm each entry, ideally with written permission from the source.

## How SIGNAL enforces this

`backend/atlas/data/licensing.py` holds the register below. The `ATLAS_DEPLOYMENT_MODE` setting chooses how it is applied:

| Mode | Who sees the data | Sources used |
|---|---|---|
| `personal` (default) | Only the operator, for their own research | Every integrated source |
| `beta` | Invited users | Only sources whose terms were **verified** to allow showing data to other people |

In `beta` mode:

- The data service makes no requests to sources that are not allowed (this is tested).
- Data already stored from those sources is not served by any endpoint (this is tested).
- The Markets screen explains why a market has no prices. It never substitutes another source silently.

## Register

| Source | Used for | Status | Beta | Evidence |
|---|---|---|---|---|
| ECB reference rates via Frankfurter | EUR/USD, GBP/USD, USD/JPY | **Verified** | Allowed | See below |
| Coinbase Exchange public API | Crypto daily and intraday candles (primary) | **Unverified** | Blocked | See below |
| Kraken public API | Crypto failover and cross-check | **Restricted** | Blocked | See below |
| Binance | — | **Not integrated** | Blocked | See below |

### ECB reference rates via Frankfurter: verified

- **ECB reuse policy.** *Policy regarding the reuse of ESCB statistics* (ecb.europa.eu, usage_policy page). It says statistics may be reused "free of charge… irrespective of any subsequent commercial or non-commercial use", "on the condition that the source is quoted" and "that the statistics (including metadata) are not modified". Suggested attribution: "Source: ECB statistics."
  - The reuse page and the reference-rates page were read only partly. Some wording came from a summary of the rest of the page, so the exact clauses should be re-read before launch.
- **ECB reference-rates page.** The rates are "published for information purposes only" and "using the rates for transaction purposes is strongly discouraged". They are updated around 16:00 CET on working days.
- **Frankfurter.** Its code is under the MIT licence. On data it says it "doesn't own the rates… If a provider publishes terms of use, they apply." It has no quotas, and caching daily observations locally is "encouraged".
- **Default blending.** Frankfurter blends providers by default. SIGNAL requests `providers=ecb` explicitly. We tested the v1 endpoint on 2026-11-18 and it returned identical values with and without that parameter.
- **Cross rates.** GBP/USD and USD/JPY are cross rates that Frankfurter derives from EUR-based ECB fixes. SIGNAL shows them unmodified.
- **Label shown everywhere:** "Daily ECB reference rates — not live forex quotes."

### Coinbase Exchange: unverified, blocked for beta

- **Terms binding.** Coinbase's Exchange docs (docs.cdp.coinbase.com/exchange/introduction/welcome) say: "By accessing the Exchange Market Data API, you agree to be bound by the Market Data Terms of Use." The docs also describe the market data APIs as "public". That word is not a licence grant.
- **Terms not reviewed.** The Market Data Terms (coinbase.com/legal/market_data) returned HTTP 403 to automated retrieval, so we could not read them.
- **Redistribution.** Coinbase runs an authorised redistribution partner programme, which suggests that showing its data to third parties requires a licence.
- **Next step:** a person reads the terms in a browser and, if needed, asks Coinbase or an authorised redistributor for permission.

### Kraken: restricted, blocked for beta

- **Global Terms of Service** (kraken.com/legal/global-terms), last updated 2026-11-06. Section 8 grants use of "Our Content" "only for your own benefit". Section 9 prohibits users to "license, sublicense, sell, resell, transfer… or otherwise commercially exploit or make available to any third party Our Content". It also restricts automated extraction, and developing "third-party applications that interact with Our Content without our prior written consent".
- **No separate licence found.** We found no API data licence (`/legal/api-terms` returns 404).
- **Current use.** Kraken is used for the operator's own research only: as a failover source, and as the second venue in the cross-source check.

### Binance: not integrated

- **Terms not readable.** The Terms of Use page rendered without its terms text when fetched.
- **Binance Vision.** The historical-data terms PDF has a section titled "Non-commercial licence grant". Its body text could not be extracted, so the restriction is unconfirmed.
- **Forum thread.** The developer-forum thread about commercial use returned HTTP 451.
- **Availability.** Availability to users in Canada and the US is restricted. We did not confirm this from a primary source in this review.
- **Decision.** Binance is not integrated, and adding it would need the same verification first.

## What this means for the beta

**Crypto is the primary research universe, but no crypto source is verified for showing data to invited users.** This is the main data blocker for a crypto-first beta. There are three ways forward. Each needs a decision from the owner, and some need spending.

1. **Get written permission or a licence** from Coinbase, an authorised Coinbase redistributor, or Kraken.
2. **Bring your own data** (`docs/BYO_DATA.md`). Each user connects their own data account, and the data is shown only to that user. This is designed but not built.
3. **Use a commercial data vendor** whose licence explicitly covers display to end users. This is a paid service, so it needs approval before anything is done.

Until one of these is in place, a `beta` deployment offers forex research on ECB reference rates only. Crypto markets appear in that deployment marked as unavailable.

## Data labels

| Data | Kind | Label |
|---|---|---|
| Crypto daily | historical | Historical daily candles (UTC). Not live: today's candle appears after the UTC day closes. |
| Crypto 1h / 6h | historical | Historical {interval} candles (UTC), last N days. Not live: the open candle is excluded. Used for charts only; research uses daily data. |
| Forex | reference | Daily ECB reference rates — not live forex quotes. |

Nothing in SIGNAL is labelled "live" or "delayed real-time", because no source here is a real-time executable feed.

## Data-quality controls

The checks are implemented in `backend/atlas/data/validation.py` and tested in `backend/tests/test_data_quality.py`.

| Check | What happens |
|---|---|
| Missing candles | Counted and listed as gaps. **Never filled.** |
| Duplicate timestamps | Latest kept. Duplicates with conflicting prices are reported. |
| Out-of-order rows | Reported, then sorted. Coinbase's documented newest-first order is reversed in the provider, so only real disorder is counted. |
| Invalid OHLC (non-positive values, high below open/close, low above open/close, high < low) | Candle **quarantined**: excluded, stored in `data_quarantine`, and shown as excluded. Never repaired. |
| Invalid close | Quarantined |
| UTC alignment (daily candles at 00:00 UTC, hourly on the hour) | Misaligned rows quarantined, not floored into a neighbouring candle |
| Incomplete current period | Dropped until it closes |
| Large moves (robust z > 10) | Flagged for review and kept as reported |
| Zero-volume periods | Reported |
| Stale data | Flagged when the last bar is older than the instrument's tolerance |
| Cross-source check (crypto) | Latest 120 daily closes compared with a second venue. Median, p95 and max gap in basis points, plus a one-day-shift test. A mismatch over 50 bps on more than 5% of days is flagged. |

Each dataset gets a grade:

- **ok**
- **warn**: usable, with the caveats shown
- **fail**: more than 5% of candles quarantined, or completeness below 90%. The dataset is not used for research.

**First real check (2026-11-18).** Coinbase and Kraken daily closes agreed to a median of 0.64 bps for BTC/USD and 0.85 bps for ETH/USD over 120 days.
