# Bring your own data (design only)

Status: **design, not implemented.** No broker or data-vendor connection exists in SIGNAL today. Nothing in this design places orders. SIGNAL stays paper-trading only.

## Why

Exchange terms (see `DATA_LICENSING.md`) generally allow a person to use market data for their own benefit, but not to have a third party redistribute it to them. If each beta user connects their own data account, SIGNAL fetches data on that user's behalf, under that user's agreement, and shows it only to that user. That fits the terms much better than SIGNAL redistributing one feed to everyone. Each provider's terms still need checking for this pattern before it is enabled.

## Candidate providers

| Provider | What it offers | Credential | Notes to verify before building |
|---|---|---|---|
| Alpaca Market Data API | US stocks/ETFs and crypto bars | API key ID + secret (paper account is enough) | Whether the free plan's data may be displayed in a third-party app the user controls. Use **data endpoints only**. The trading endpoints are never called. |
| OANDA v20 REST | FX bid/ask/mid candles | Personal access token for a practice (demo) account | Whether the practice-account terms allow access through a third-party application. Use the instruments/candles endpoints only. |

## Design

1. **Scope.**
   - Read-only market-data endpoints only.
   - The connector code allow-lists exact URL paths, and any order, account-transfer or position endpoint is refused before a request is made.
   - A test asserts that no trading path is reachable.
2. **Credentials.**
   - Entered by the user in Settings and stored encrypted at rest. The encryption key comes from an environment variable and is never in the database or the repository.
   - Never logged, never returned by the API after saving; only the last four characters are shown.
   - Deleting the connection deletes the secret.
3. **Isolation.**
   - Bars fetched with a user's credential are stored with `provider = "byo:<vendor>"` and `owner_user_id`.
   - Queries for that data always filter by the requesting user. Another user gets 404, not the data, and cross-user tests cover this.
   - The licensing register treats `byo:*` sources as allowed only for their owner.
4. **Labels.** The label states the source and type exactly. Examples:
   - "Your OANDA practice account · mid candles · not live"
   - "Your Alpaca account · IEX feed · 15-minute delayed"

   Nothing is called "live" unless the vendor's feed is real-time and the label says which feed.
5. **Quality.** The same validation pipeline applies: quarantine, gaps reported and never filled, a cross-check against SIGNAL's own reference data where it exists.
6. **Research integrity.** BYO bars create their own dataset versions and their own trial families. A strategy researched on BYO data has its own sealed holdout. It cannot borrow evidence from another source.
7. **Failure handling.** If the credential is revoked or rate-limited, research on that market pauses with a clear message. SIGNAL never falls back to another source without saying so.

## Not in scope

- Live order routing, real-money accounts, or holding customer funds.
- Sharing one user's BYO data with any other user, including in aggregate analytics.
