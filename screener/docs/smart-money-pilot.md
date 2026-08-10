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

## Shadow event policy: `smart-money-pilot-events-v2-shadow`

These thresholds create drafts only:

- **Cohort net flip:** BTC, ETH, SOL, or HYPE changes sign with at least $1M absolute notional at both endpoints and a $2M aggregate change.
- **Unusual wallet change:** absolute position delta is at least the larger of $1M or 10% of live account value.
- **Coordinated change:** three or more cohort wallets move the same asset in the same delta direction; each wallet crosses the larger of $250,000 or 5% of account value.
- **Vault anomaly:** prior TVL is at least $1M and estimated net depositor-flow proxy crosses the larger of $500,000 or 10% of prior TVL.

Wallet events require complete paired cohort coverage and an actual observation interval no longer than six hours. A partial, stale, cadence-misaligned, malformed, duplicate-identity, or suspiciously truncated collection writes failure evidence and suppresses event generation. HIP-3 positions retain the full DEX-qualified market key (for example, `xyz:SKHX`) throughout storage, deltas, and fingerprints. Event fingerprints make retries idempotent and are scoped to both the event policy and exact cohort version.

## Durable evidence and review gate

Migration V24 adds append-only tables for:

- cohort versions and membership decisions;
- collection runs and source manifests;
- wallet heartbeats, positions, and performance windows;
- vault snapshots;
- event drafts and immutable 24h outcomes;
- daily digest/chart drafts; and
- weekly honesty reports.

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
npx tsx scripts/smart-money-pilot.ts digest YYYY-MM-DD
npx tsx scripts/smart-money-pilot.ts weekly YYYY-MM-DD
npx tsx scripts/smart-money-pilot.ts funding-probe
```

The scheduled command drafts the previous UTC day's digest and, on Monday UTC, the previous week's honesty report. `run --bootstrap-digest` creates a separate `smart-money-baseline:<run-id>` artifact and cannot consume the complete daily digest's idempotency key. The process lock verifies PID liveness and heartbeats its lease; cohort recomputation has a 90-minute fail-closed deadline.

## Seven-day validation scorecard

Track these from collection runs and draft tables:

1. **Coverage:** complete wallet and vault evidence in at least 90% of scheduled runs.
2. **Freshness:** paired position evidence no older than the four-hour collection cadence.
3. **Evidence chain:** every event resolves to its collection run, normalized snapshots, policy version, and verification URL.
4. **Signal volume:** at least two threshold events with complete paired evidence in seven days.
5. **Publishing honesty:** three reviewed daily digests and one weekly report that lists every flag, follow-through, miss, and unresolved outcome.
6. **Cost:** external source spend remains $0 during the pilot.

**Kill/escalate criterion:** if the official position snapshots plus four-hour cadence do not produce at least two clean events, or if the resulting wallet deltas are not materially more useful than free Hyperliquid dashboards, do not launch the paid wallet-alert product. Test a vault-first angle using the PnL-adjusted TVL proxy and follower-count changes before considering any paid scraping source.
