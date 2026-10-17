# Historical research archive (Track B)

This is a standalone, read-only export/verification/replay path for historical research. It does not import `src/lib/db.ts`, run migrations, write the live SQLite file, schedule jobs, or send notifications.

## Bundle contract

A bundle is an immutable directory containing `manifest.json` and four gzipped JSONL files:

- `snapshots.jsonl.gz`: five-minute UTC epoch-aligned rollups of `price_snapshots`.
- `candles.jsonl.gz`: source `candles_cache` records in the requested half-open interval.
- `oi-events.jsonl.gz`: selected `oi_surge_events`, including the original policy/source fields and complete `horizons_json`, `lanes_json`, `initial_evidence_json`, and `latest_evidence_json` text.
- `oi-outcomes.jsonl.gz`: every `oi_surge_outcomes` row whose event is in the selected event set.

`manifest.json` records the source schema version, **selected-range-only** source observation extents, exact `[from,to)` request, legacy-symbol provenance, per-dataset counts/ranges, schema descriptions, compressed byte sizes, and SHA-256 hashes. The requested range and each emitted dataset range are separate: a null dataset range means no rows were emitted, not complete source coverage. JSON property order and output ordering are fixed. Gzip output is streamed and uses a fixed compression level; the manifest creation timestamp is intentionally the only capture-time field.

Snapshots are intentionally **not raw snapshots**. Each rollup records `first`/`last` source values and timestamps, mark/OI min/max, count/coverage, funding sample sum/count, and `rolling24h_volume_latest`. The volume field is a rolling 24-hour value; it is never summed across rows. Venue metadata is not invented: provenance is explicitly `legacy-symbol` with `venueMetadataAvailable: false`.

## Manual export, verify, replay

Use the pinned Node runtime from the workspace:

```sh
export PATH=/home/muffinman/.nvm/versions/node/v24.14.0/bin:$PATH
cd /home/muffinman/asset_screener-candidates/trust-rotation-20260908/screener
```

Export a bounded daily interval. The source is opened with `readonly: true`, `fileMustExist: true`, and SQLite `query_only`; the exporter holds one consistent read transaction and uses ordered iterators rather than `.all()`.

```sh
npx tsx scripts/research-archive.ts export \
  --source /absolute/path/to/screener.db \
  --out /absolute/path/to/archive-2026-09-08 \
  --from 2026-09-08T00:00:00.000Z \
  --to   2026-09-09T00:00:00.000Z
```

The exporter rejects malformed ranges, non-canonical/future manifest ranges, intervals longer than 31 days, an existing output, symlink aliases (including dangling links) in source/output parents, and output paths that overlap the source. It opens the source read-only with SQLite `query_only`, gathers extents from selected rows/rollups instead of scanning whole source tables, writes a private staging directory, then atomically reserves the final directory with exclusive `mkdir`. Files are linked into that reservation without replacement and `manifest.json` is written last as the commit marker. A reserved directory without a manifest is incomplete and is rejected by verification; failed runs clean only staging and files whose inode they can prove they own, never a raced path.

Verify before analysis or transfer:

```sh
npx tsx scripts/research-archive.ts verify \
  --bundle /absolute/path/to/archive-2026-09-08
```

Verification is fail-closed. It rejects symlinked/non-regular bundle entries, unsafe manifest paths, unexpected files, unknown datasets/schema keys, non-canonical UTC timestamps, reversed/oversized/future ranges, gzip/JSONL corruption, SHA-256 or byte-size mismatches, count/range/coverage mismatches, invalid finite/null semantics, impossible rollup or candle values, malformed event JSON, unsupported outcome fields/statuses, duplicate rows, and orphan outcomes. Outcome targets after `range.to` are accepted only when linked to an exported event; this is the documented late-outcome exception.

Replay only to a **new** research database path:

```sh
npx tsx scripts/research-archive.ts replay \
  --bundle /absolute/path/to/archive-2026-09-08 \
  --out /absolute/path/to/research-2026-09-08.db
```

Replay verifies first, refuses symlink aliases and any existing destination, builds a complete SQLite database in a private temporary directory, and publishes it with a no-replace hard link. The source is never opened by replay and no live application table is created. Rollups retain the complete `first` and `last` source objects as `first_json` and `last_json` in addition to analytical columns, so `prev_day`, funding, OI, volume, and future source fields are not silently dropped. On a replay failure only the owned temporary directory is removed; an output that wins a publication race is never deleted.

## Coverage and late outcomes

The manifest’s `range` is the requested `[from,to)` declaration. `source.observationExtent` and each dataset’s `range` describe rows actually emitted from that bounded export; source extents are not claims about the entire database. A null range with a zero count is a valid empty/insufficient-coverage result, not evidence that the source had complete history. Preserve manifests alongside bundles and compare selected-range extents and counts between runs.

OI events are selected by `started_at` in the requested interval. Their matching outcomes are exported even when the outcome `target_at` is later than the interval, so the event evidence and later result remain linked. A later outcome refresh should use a new bundle directory and a new replay destination; never mutate an existing bundle or overwrite an existing research DB.

Recommended late-outcome refresh:

1. Export a new interval covering the event start window and the newly available outcome horizon.
2. Verify the new bundle.
3. Replay into a new database.
4. Compare event IDs and outcome rows before replacing any downstream research artifact.
5. Keep both manifests; do not infer outcomes for missing/untrackable rows.

## Full-history bootstrap (manual, not activated)

For an initial archive, bootstrap from a **known earliest retained observation** supplied by the operator or an approved retention record; do not discover the start by scanning the live tables. Round that known timestamp down to its UTC midnight for `BOOTSTRAP_FROM_UTC`. Set `BOOTSTRAP_TO_UTC` to today's UTC midnight (the exclusive end of the last completed day). Both inputs must use the exact `YYYY-MM-DDT00:00:00.000Z` format. Never include the current partial day.

Use one new bundle and one new research database per small daily partition. Run the loop manually, review each manifest, and stop on the first non-zero exit:

```bash
# NOT ACTIVE — GNU date/Bash example only. Review paths and storage first.
set -euo pipefail
: "${BOOTSTRAP_FROM_UTC:?Set the approved earliest UTC midnight}"
: "${BOOTSTRAP_TO_UTC:?Set the exclusive completed-day boundary}"
for boundary in "$BOOTSTRAP_FROM_UTC" "$BOOTSTRAP_TO_UTC"; do
  [[ "$boundary" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T00:00:00\.000Z$ ]] || exit 1
  [[ "$(date -u -d "$boundary" '+%Y-%m-%dT00:00:00.000Z')" == "$boundary" ]] || exit 1
done
cursor_epoch=$(date -u -d "$BOOTSTRAP_FROM_UTC" +%s)
end_epoch=$(date -u -d "$BOOTSTRAP_TO_UTC" +%s)
today_epoch=$(date -u -d "$(date -u +%F)T00:00:00Z" +%s)
(( cursor_epoch < end_epoch && end_epoch <= today_epoch )) || exit 1
while (( cursor_epoch < end_epoch )); do
  next_epoch=$((cursor_epoch + 86400))
  cursor=$(date -u -d "@$cursor_epoch" '+%Y-%m-%dT00:00:00.000Z')
  next=$(date -u -d "@$next_epoch" '+%Y-%m-%dT00:00:00.000Z')
  bundle="/absolute/path/to/archive-${cursor%%T*}"
  db="/absolute/path/to/research-${cursor%%T*}.db"
  npx tsx scripts/research-archive.ts export --source /absolute/path/to/screener.db --out "$bundle" --from "$cursor" --to "$next"
  npx tsx scripts/research-archive.ts verify --bundle "$bundle"
  npx tsx scripts/research-archive.ts replay --bundle "$bundle" --out "$db"
  cursor_epoch="$next_epoch"
done
```

This is a bounded daily-partition loop, not a live range scan: every invocation has an explicit `[from,to)` interval, and the source is opened read-only. It does not install or enable a scheduler. Keep the original manifests and stop for operator review if the known retention start, a partition boundary, or a manifest extent is unexpected.

## Not-activated schedule template

This template is documentation only. It is deliberately not installed, enabled, or added to package scripts by Track B. An operator must review retention, destination storage, source path, time window, and credentials/environment before activation.

```cron
# NOT ACTIVE — daily archive example; install only after review.
# 10 0 * * * /absolute/path/to/run-research-archive-daily.sh >> /absolute/path/to/archive.log 2>&1
```

A safe wrapper should compute the previous UTC day, choose a new destination, run `export`, then `verify`, and alert on non-zero exit. It must not call `src/lib/db.ts`, use a live write connection, overwrite an existing bundle/database, or activate a scheduler as part of installation.

## Tests

Focused tests use synthetic temporary SQLite databases and cover bounded source extents, rollup semantics, non-summed rolling volume, complete first/last OI values and evidence/outcomes, recomputed-hash logical tampering, OI null/range and funding endpoint/count invariants, corrupted gzip propagation, strict range/schema validation, orphan and late outcomes, symlink/broken-alias rejection, replacement during one-pass verification/replay, atomic no-clobber publication, and replay into a new DB:

```sh
node --test --import tsx src/lib/__tests__/researchArchive.test.ts
```

Parent integration should run the repository’s full test/build gates after review. No production database read is required for these implementation tests.
