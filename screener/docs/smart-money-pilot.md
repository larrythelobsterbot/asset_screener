# Hyperliquid Smart-Money Pilot

Status: **seven-day shadow validation**. Nothing in this pipeline can post to Telegram. Events, daily digests, charts, and weekly honesty reports are drafts requiring human review.

## Recommendation

Use Hyperliquid's official `/info` API as the claim-level source of truth, and use the public `stats-data.hyperliquid.xyz` leaderboard/vault files only for discovery. Do not automate Hyperdash or Mirrorly until they publish an API or grant permission. This keeps source cost at **$0/month** and preserves the $40/month ceiling for later reliability tooling.

## Source audit

| Source | Use | Current finding | Production posture |
|---|---|---|---|
| `stats-data.hyperliquid.xyz/Mainnet/leaderboard` | Weekly discovery | Public, unofficial, about 32 MB; 7d/30d/all-time performance and account value | Hash and gzip-archive raw HTTP bytes before JSON parsing; reconcile source row counts and reject malformed numeric fields, duplicate wallet identities, truncation, or fetch errors; never publish its stale position values |
| Hyperliquid `POST /info` `portfolio` | Cohort evidence | Official; contains week/month/all-time histories from which a bounded 90-day PnL delta can be derived | Claim-level cohort source |
| Hyperliquid `POST /info` `clearinghouseState` | Current account value and positions | Official and position-complete for queried addresses | Claim-level wallet/position source, polled every four hours by this pilot |
| `stats-data.hyperliquid.xyz/Mainnet/vaults` | Global vault discovery | Public, unofficial; active vault summary, TVL, APR, and PnL windows | Top 50 non-child vaults over $1M TVL; source totals, immutable gzip archive, and response hash recorded in each run manifest |
| Hyperliquid `POST /info` `vaultDetails` | Follower count | Official, address-by-address | Best-effort enrichment; event detection does not fail when count is unavailable |
| Hyperliquid `POST /info` `metaAndAssetCtxs` / local `price_snapshots` | Funding and outcome context | Official current hourly funding; local snapshots retain bounded historical marks/funding | Funding is labeled hourly; outcomes use immutable 24h bounded snapshots |
| Hyperliquid `POST /info` `userFunding` | Actual wallet funding payments | Official signed USDC settlements with position size, rate, timestamp, hash, and DEX-qualified coin identity | Trailing 24 hours collected every four hours in inclusive six-hour windows; 500-row windows are recursively bisected, overlaps are deduplicated, and incomplete cohort coverage is never interpreted |
| Hyperdash | Label discovery | Public UI and a private GraphQL endpoint are visible, but no public automation contract was established | Manual cross-check only; not scraped by this pilot |
| Mirrorly portal / curated-traders Telegram | Label discovery | Portal requires registration; Telegram content was not available to the scraper | Not a production dependency |

The vault flow field is explicitly an **estimate**: `TVL change - cumulative PnL change`. It is not described as a direct deposit ledger because fees, transfers, and accounting effects may remain.

## Cohort policy: `smart-money-pilot-cohort-v2`

A wallet is eligible only when all evidence is present:

- at least 90 days between the first all-time portfolio observation and now;
- positive PnL over 7d, 30d, and bounded 90d windows;
- live account value of at least $250,000;
- 30d turnover below 50x account value;
- 30d ROI no higher than 200%; and
- non-zero 30d volume when 30d PnL is positive.

The top 32 eligible wallets by deterministic consistency/size score become the weekly cohort. Every weekly version stores entries, stays, exits, exclusions, source hash, source evidence, and suspected gaming reasons. Zero-volume positive-PnL, extreme-turnover, and extreme-ROI rows are recorded as suspected vanity/wash candidates and are not admitted. The 32-wallet cap keeps every aggregate alert below Telegram's message limit while retaining a direct official explorer link for every constituent wallet.

## V3 shadow trade-change policy: `smart-money-trade-change-v3-shadow`

These thresholds create drafts only:

- **Cohort net flip:** BTC, ETH, SOL, or HYPE changes sign with at least $1M absolute notional at both endpoints and a $2M aggregate change.
- **Unusual wallet trade change:** actual Hyperliquid position size (`szi`) changes, and the quantity delta valued at one reference mark is at least the larger of $1M or 10% of live account value. V3 classifies the snapshot transition as a likely long/short open, close, addition, reduction, or direction flip with medium inference confidence and structural reason codes; it does not claim an exact fill sequence.
- **Coordinated trade change:** three or more cohort wallets change actual `szi` for the same DEX-qualified market in the same signed-exposure direction; each quantity delta valued at one reference mark crosses the larger of $250,000 or 5% of account value.
- **Vault anomaly:** prior TVL is at least $1M and estimated net depositor-flow proxy crosses the larger of $500,000 or 10% of prior TVL.

Wallet events require complete paired cohort coverage and an actual observation interval no longer than six hours. V3 ignores USD notional changes caused only by mark-price movement: trade-change USD values are `deltaSzi × referenceMarkPrice`, using the current implied mark or the previous implied mark for a full close. Coordinated evidence retains each participating wallet's prior/current size, size delta, qualified classification, confidence, reason codes, reference mark, and valued delta; unchanged wallets are excluded. A partial, stale, cadence-misaligned, malformed, duplicate-identity, or suspiciously truncated collection writes failure evidence and suppresses event generation. HIP-3 positions retain the full DEX-qualified market key (for example, `xyz:SKHX`) throughout storage, deltas, and fingerprints. Event fingerprints make retries idempotent and are scoped to the V3 detector policy and exact cohort version. Collection run keys are also scoped to scheduled bucket, cohort version, and detector policy version, so a historical V2 reservation cannot suppress V3 detection in the same bucket.

## Interpretation guards and wallet funding evidence

Every new daily draft evaluates the cohort boundary used by its positioning snapshot. When the cohort changed, the draft reports entries, retained wallets, exits, and current-cohort overlap, and warns that aggregate positioning is not directly comparable with the prior cohort. Events whose evidence uses another cohort version are labeled as a cohort boundary rather than implied to be changes by the current cohort. For BTC, ETH, SOL, and HYPE, the draft also warns when one wallet is at least 50% of gross exposure or the top two wallets are at least 75%; net exposure is then explicitly described as not broad cohort consensus.

Actual wallet funding uses policy `smart-money-user-funding-v1-shadow`. A funding run is separate from the core position/vault collection so source failures cannot corrupt or relabel a complete detector run. The scheduled orchestrator catches the entire auxiliary funding stage so reservation, archive, finalization, or storage failures cannot suppress outcomes, daily digests, or weekly reports from an already-complete core run. After a 60-second rate-limit cooldown, requests are globally paced at 2.5 seconds and capped at 160 attempts per cohort run; retryable 429, 5xx, and transport failures receive at most three exponentially backed-off attempts, all charged to that same cap. Each run re-collects the trailing 24 hours for every active cohort wallet in four inclusive six-hour windows. A response with exactly 500 rows is treated as potentially truncated and recursively bisected; identical overlap at window boundaries is deduplicated by wallet + exact settlement time + DEX-qualified coin, while conflicting duplicates fail closed. Raw bytes are hash-verified and gzip-archived before parsing. Every funding-runtime invocation first marks attempts older than two hours failed; retries resolve wallet membership from the parent collection's historical cohort rather than the latest cohort version. Partial, failed, stale, and archive-invalid attempts preserve their evidence but are not aggregate-ready, and the invocation reserves the next numbered attempt instead of treating them as idempotent success. Existing complete attempts are accepted only when the fresh parent collection's identity, run kind, schedule, wallet/vault counters, policy, exact requested range, wallet count, exact normalized address set, terminal partition, persisted counts, and every archived request window all revalidate. Signed USDC payments remain shadow evidence only: they do not change trade classifications, event thresholds, review state, or delivery state, and no funding-derived claim is generated until complete live coverage has been reviewed.

## Durable evidence and review gate

Migration V24 adds append-only tables for:

- cohort versions and membership decisions;
- collection runs and source manifests;
- wallet heartbeats, positions, and performance windows;
- vault snapshots;
- event drafts and immutable 24h outcomes;
- daily digest/chart drafts; and
- weekly honesty reports.

Migration V25 adds a separate numbered funding-attempt ledger, raw request-window evidence, immutable normalized wallet funding payments, and per-attempt payment associations so a retried complete attempt can prove coverage without duplicating payment facts. Funding hashes are retained but are not identity keys because Hyperliquid may return all-zero hashes; wallet + settlement time + DEX-qualified coin is the durable key. The store rejects payments outside the inclusive funding range. Finalization verifies persisted wallet/window/payment counts, requires the funding wallet expectation and exact terminal-wallet address set to match the parent core run's active cohort members, requires both parent wallet and vault success counters to be complete, and proves that each successful wallet's terminal `complete` leaves form an exact non-overlapping partition of the entire run range; saturated parent windows remain evidence but are not terminal coverage. Future aggregate reads require those same complete parent counters, matching cohort version and member set, expected funding policy, exact 24-hour lookback, and a funding end time paired to the parent collection schedule.

A database constraint prevents an event from entering `pending`, `delivered`, `failed`, or `unknown` delivery state unless `review_status = 'approved'`. The collector always writes `review_status = 'draft'` and `delivery_status = 'shadow'`. No Telegram sender imports or credentials are used.

Generated files live under `data/smart-money-drafts/` and are ignored by Git. Content-addressed source archives live under `data/smart-money-source-archive/`. Artifact paths and SHA-256 hashes are bound into database evidence; every idempotent retry revalidates existing bytes, and missing, moved, or corrupted files fail closed. Each event draft contains shortened display addresses, the actual paired interval, and full official explorer/vault links.

## Schedule and commands

PM2 app `smart-money-pilot` runs at minute 17 every four hours:

```text
17 */4 * * *
```

Useful commands:

```bash
npm run smart-money:pilot                 # due cohort + collect + outcomes + reports
npx tsx scripts/smart-money-pilot.ts cohort
npx tsx scripts/smart-money-pilot.ts collect
npx tsx scripts/smart-money-pilot.ts funding
npx tsx scripts/smart-money-pilot.ts digest YYYY-MM-DD
npx tsx scripts/smart-money-pilot.ts outcomes
npx tsx scripts/smart-money-pilot.ts weekly YYYY-MM-DD
npx tsx scripts/smart-money-pilot.ts funding-probe
```

The scheduled command drafts the previous UTC day's digest and, on Monday UTC, the previous week's honesty report. `run --bootstrap-digest` creates a separate `smart-money-baseline:<run-id>` artifact and cannot consume the complete daily digest's idempotency key. The process lock verifies PID liveness and heartbeats its lease; cohort recomputation has a 90-minute fail-closed deadline.

## Seven-day validation scorecard

Track these from collection runs and draft tables:

1. **Coverage:** complete wallet and vault evidence in at least 90% of scheduled runs; funding coverage is tracked separately and must be complete for every cohort wallet before interpretation.
2. **Freshness:** paired position evidence no older than the four-hour collection cadence.
3. **Evidence chain:** every event resolves to its collection run, normalized snapshots, policy version, and verification URL.
4. **Signal volume:** at least two threshold events with complete paired evidence in seven days.
5. **Publishing honesty:** three reviewed daily digests and one weekly report that lists every flag, follow-through, miss, and unresolved outcome.
6. **Cost:** external source spend remains $0 during the pilot.

**Kill/escalate criterion:** if the official position snapshots plus four-hour cadence do not produce at least two clean events, or if the resulting wallet deltas are not materially more useful than free Hyperliquid dashboards, do not launch the paid wallet-alert product. Test a vault-first angle using the PnL-adjusted TVL proxy and follower-count changes before considering any paid scraping source.
