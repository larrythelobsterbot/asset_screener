# Rotation view

The Home **Rotation** tab is a descriptive, read-only surface. It keeps the existing Ideas, Explore, and Data views and uses the existing search, filters, watchlist, and market-detail flow.

## Evidence contract

- Crypto/native and HIP-3 rows are separated by the current market contract, not by sector labels. Native Hyperliquid owns a contested bare ticker; builder DEX order is deterministic after native precedence.
- Every `1h`, `8h`, `24h`, `48h`, and `7d` metric pairs the current market snapshot with a bounded historical `price_snapshots` row. Current evidence is limited to two minutes and historical matching to ten minutes. Missing history is `unavailable`, never a fabricated zero or flat return.
- Price changes use display marks. Coin-denominated OI changes use `rawPriceOf(symbol, mark)`. Quantity effect is `(current OI coins - prior OI coins) × prior raw price`; it is a quantity-valued observation, not a claim of money flowing into the market. USD OI delta values each snapshot at its own raw price.
- A zero current OI is real evidence. A zero prior OI has no percentage denominator, so contract percentage is unavailable while the quantity effect can remain observed.
- Turnover uses contiguous, complete cached `1h` candle bars only. It is an estimate of base candle volume multiplied by representative raw candle price. The source window is the latest completed aligned-hour window, not a rolling-24h snapshot sum; gaps and fractional endpoints are unavailable. Hover a cell for provenance and coverage.
- Funding is projected at the current hourly rate held constant over the displayed horizon (`hourly rate × hours`), labeled as a projection. It is not APR, a percentile, or a profitability score.

## Cache and API lifecycle

`GET /api/rotation` is informational and read-only. It uses cached native and builder metadata, five indexed bounded snapshot reads (one per horizon), and one bounded bulk candle read. Computation is cached for about 30 seconds; healthy data may be served stale for at most ten minutes during a refresh failure. Cold or empty source data is shown as warming/unavailable.

Payload metadata states the source, snapshot table, current and historical tolerances, candle interval, cache age, stale state, and the legacy-symbol history limitation. Historical rows predate venue-qualified identity, so current HIP-3 provenance is exact but historical identity remains a bare-symbol limitation.

## Since-visit changes

The browser stores a versioned, bounded `localStorage` baseline under `asset-screener-rotation-visit-v1`. It stores each current contract identity, mark, coin OI, and observation time. The baseline loaded when Rotation is entered is frozen for that mounted visit; polling does not turn the comparison into a 30-second delta. A healthy successful payload updates storage for the next session, while stale payloads never overwrite a healthy baseline.

Storage is opportunistic and blocked-safe. Malformed, oversized, wrong-version, future, stale, or venue-mismatched records are ignored. **Mark reviewed** clears the local baseline. No account or server storage is used.
