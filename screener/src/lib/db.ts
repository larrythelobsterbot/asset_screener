import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";

// Single SQLite file, lives next to the app so PM2 restarts don't lose it.
// WAL mode lets readers and writers coexist without blocking — important
// because the API routes write snapshots while the same process serves
// reads for the heatmap/signals UI.
//
// The DB is intentionally process-local: this app is a single PM2 process,
// and a future signal-bot would be a *separate* process that talks to the
// same file (better-sqlite3 supports concurrent readers across processes
// in WAL mode). Supabase remains the path for centralized signal_events.

const DB_PATH =
  process.env.SCREENER_DB_PATH ??
  join(process.cwd(), "data", "screener.db");

let dbSingleton: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbSingleton) return dbSingleton;
  mkdirSync(join(DB_PATH, ".."), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  dbSingleton = db;
  return db;
}

// ── Migrations ──────────────────────────────────────────────────────────
// Versioned via PRAGMA user_version so we can add schema changes without
// blowing away the local file. Bump VERSION and add a step.

const VERSION = 12;

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= VERSION) return;

  if (current < 1) db.exec(MIGRATION_V1);
  if (current < 2) db.exec(MIGRATION_V2);
  if (current < 3) db.exec(MIGRATION_V3);
  if (current < 4) db.exec(MIGRATION_V4);
  if (current < 5) db.exec(MIGRATION_V5);
  if (current < 6) db.exec(MIGRATION_V6);
  if (current < 7) db.exec(MIGRATION_V7);
  if (current < 8) db.exec(MIGRATION_V8);
  if (current < 9) db.exec(MIGRATION_V9);
  if (current < 10) db.exec(MIGRATION_V10);
  if (current < 11) db.exec(MIGRATION_V11);
  if (current < 12) db.exec(MIGRATION_V12);
  db.pragma(`user_version = ${VERSION}`);
}

// Schema migrations are split into versioned blocks so an existing db
// only runs the steps it's missing. Adding a new step: bump VERSION,
// add a new MIGRATION_V<n> block, and append the `if (current < n)`
// guard above.

const MIGRATION_V1 = `
    -- Time-series of per-symbol market context. One row per symbol per scan.
    -- Used for: multi-horizon sector RS, sparklines, backtests, cache warmup.
    create table if not exists price_snapshots (
      symbol     text    not null,
      ts         integer not null,
      mark       real    not null,
      prev_day   real,
      funding    real,
      oi         real,
      volume     real
    );
    create index if not exists idx_snap_sym_ts on price_snapshots(symbol, ts desc);
    create index if not exists idx_snap_ts on price_snapshots(ts);

    -- Persistent candle cache. Survives PM2 restarts. Keyed by (symbol, interval, t).
    -- Same shape as Hyperliquid's HLCandle minus the redundant T (end ts).
    create table if not exists candles_cache (
      symbol    text    not null,
      interval  text    not null,
      t         integer not null,
      o         real    not null,
      h         real    not null,
      l         real    not null,
      c         real    not null,
      v         real    not null,
      primary key (symbol, interval, t)
    );
    create index if not exists idx_candle_sym_iv_t on candles_cache(symbol, interval, t desc);

    -- Anti-spam de-bouncer state for signals. Survives restarts so
    -- a PM2 reload doesn't refire every persistent signal at once.
    create table if not exists event_history (
      symbol         text    not null,
      type           text    not null,
      last_fired_at  integer not null,
      primary key (symbol, type)
    );

    -- Generic kv for runtime state (last successful scan, schema versions
    -- of derivative caches, etc). Keeps us from sprinkling one-row tables.
    create table if not exists runtime_kv (
      key    text primary key,
      value  text not null,
      ts     integer not null
    );
  `;

// V2 — social snapshots for Elfa AI mindshare/mention data. One row per
// (symbol, ts). Symbols stored UPPERCASE for consistency with the rest of
// the app even though Elfa returns lowercase — caller normalises on read.
const MIGRATION_V2 = `
    create table if not exists social_snapshots (
      symbol         text    not null,
      ts             integer not null,
      mention_count  integer not null,
      prev_count     integer,
      change_pct     real,
      primary key (symbol, ts)
    );
    create index if not exists idx_social_sym_ts on social_snapshots(symbol, ts desc);
    create index if not exists idx_social_ts on social_snapshots(ts);
  `;

// V3 — HYPE TWAP pressure time series. Pressure values are signed USD
// (positive = net buy pressure, negative = net sell pressure). hype_price
// snapshot stored alongside so historical reads don't need to look up
// the contemporaneous price separately.
const MIGRATION_V3 = `
    create table if not exists hype_pressure_snapshots (
      ts                 integer primary key,
      pressure_1h_usd    real    not null,
      pressure_24h_usd   real    not null,
      hype_price         real    not null,
      active_twap_count  integer not null
    );
    create index if not exists idx_hype_pressure_ts on hype_pressure_snapshots(ts desc);
  `;

// V4 — make event_history timeframe-aware. The v1 PK was (symbol, type)
// which collapsed multi-TF scans into one suppression bucket: a
// macd_bullish on 1h would silently suppress the same on 4h+1d for the
// 24h persistence window, undercutting cross-TF conviction scoring.
//
// We DROP the old table rather than carry forward stale rows. The
// suppression window is at most 48h (golden/death cross), so a fresh
// table means at worst one duplicate fire of each persistent signal
// per (symbol, type, tf) over the next 48h, which is the right
// outcome — those should fire across timeframes anyway.
const MIGRATION_V4 = `
    drop table if exists event_history;
    create table event_history (
      symbol         text    not null,
      type           text    not null,
      timeframe      text    not null default '_',
      last_fired_at  integer not null,
      primary key (symbol, type, timeframe)
    );
  `;

// V6 — Daily BTC binary outcome (HIP-4) time series. Polled every 60s
// alongside the existing TWAP pressure poller. Each contract day has a
// fresh `target_price` and `expiry_ms`; rows from prior contracts stay
// in the table for backtests. We index on ts (the snapshot time, not
// the contract expiry) so range queries by clock time are fast.
//
// target_price is the strike: payout = $1 if BTC mark >= target at
// expiry, $0 otherwise. yes_price / no_price are the live market mids.
const MIGRATION_V6 = `
    create table if not exists btc_binary_snapshots (
      ts            integer primary key,
      target_price  real    not null,
      expiry_ms     integer not null,
      yes_price     real    not null,
      no_price      real    not null,
      btc_mid       real    not null
    );
    create index if not exists idx_btc_binary_ts on btc_binary_snapshots(ts desc);
    create index if not exists idx_btc_binary_expiry on btc_binary_snapshots(expiry_ms desc);
  `;

// V5 — social_snapshots gains a `time_window` column. The route
// (/api/social/trending?tf=1h|4h|12h|24h|7d) advertises different
// horizons, but the v2 PK (symbol, ts) meant a 24h snapshot could be
// served for a tf=1h request. With time_window in the key, each
// horizon gets its own bucket and the cache layer correctly differen-
// tiates between them.
//
// DROPs the existing data — no migration path because we can't infer
// the original time_window of legacy rows. The /api/social/trending
// route re-fetches on first access, so cold-start cost is at most one
// Elfa credit per horizon used.
const MIGRATION_V5 = `
    drop table if exists social_snapshots;
    create table social_snapshots (
      symbol         text    not null,
      time_window    text    not null default '24h',
      ts             integer not null,
      mention_count  integer not null,
      prev_count     integer,
      change_pct     real,
      primary key (symbol, time_window, ts)
    );
    create index if not exists idx_social_sym_tw_ts on social_snapshots(symbol, time_window, ts desc);
    create index if not exists idx_social_ts on social_snapshots(ts);
  `;

// V7 — Trade journal. Captures the full snapshot of a trade decision
// (signals fired, conviction, ATR, funding) at the moment the user
// commits to it, so later retros can answer "which family combinations
// edge?" without having to reconstruct old market state.
//
// Lifecycle: opened (entry / stop / target / size set) → closed (exit
// price + reason set → pnl_usd, pnl_r computed in the API layer). Mode
// "paper" by default; "live" only set explicitly so we don't accidentally
// treat backtests as real trades during retros.
//
// Snapshot fields are stored as JSON strings to keep the schema flat —
// signals_json is the array of { type, family, timeframe, strength }
// tuples, families_json the deduped family list. We don't need to query
// inside them, only filter the parent row, so JSON is fine.
const MIGRATION_V7 = `
    create table if not exists trades (
      id                integer primary key autoincrement,
      ts_opened         integer not null,
      ts_closed         integer,
      symbol            text    not null,
      sector            text,
      direction         text    not null,           -- 'long' | 'short'
      mode              text    not null default 'paper',  -- 'paper' | 'live'
      entry_price       real    not null,
      stop_price        real    not null,
      target_price      real    not null,
      size              real    not null,
      risk_usd          real    not null,
      conviction_score  real,
      conviction_label  text,
      vol_regime        text,
      atr_pct           real,
      funding_hourly    real,
      signals_json      text,                       -- JSON: signal snapshots
      families_json     text,                       -- JSON: contributing families
      exit_price        real,
      exit_reason       text,                       -- 'stop' | 'target' | 'manual' | 'expired'
      pnl_usd           real,
      pnl_r             real,                       -- exit pnl in units of stop_distance
      notes             text
    );
    create index if not exists idx_trades_opened on trades(ts_opened desc);
    create index if not exists idx_trades_symbol on trades(symbol, ts_opened desc);
    create index if not exists idx_trades_open on trades(ts_closed) where ts_closed is null;
  `;

// V8 — unified catalyst feed. One row per inbound item from any source
// (Tree News now; Telegram / Twitter later). dedup_key is the source's
// native id (e.g. Tree's `_id`) with a unique index so re-polling the
// same window never double-inserts. symbols_json holds the matched
// tickers (uppercase, intersected with our perp universe) so the UI can
// filter the stream by symbol. importance: 0 normal, 1 notable (mentions
// a tracked symbol), 2 market-moving (listing / hack / ETF / macro).
const MIGRATION_V8 = `
    create table if not exists feed_events (
      id           integer primary key autoincrement,
      ts           integer not null,
      source       text    not null,          -- 'tree' | 'telegram' | 'twitter'
      author       text,                       -- sourceName / channel / handle
      title        text    not null,
      body         text,
      url          text,
      symbols_json text,                        -- JSON: ["BTC","HYPE"]
      importance   integer not null default 0,
      dedup_key    text    not null unique,
      raw_json     text
    );
    create index if not exists idx_feed_ts on feed_events(ts desc);
    create index if not exists idx_feed_source_ts on feed_events(source, ts desc);
    create index if not exists idx_feed_importance_ts on feed_events(importance, ts desc);
  `;

// V9 — cross-exchange derivatives snapshots (Coinalyze). One row per
// (base_asset, ts). The poller writes the aggregate OI, HL-specific OI +
// funding, windowed liquidations, and the DERIVED regime fields (OI delta
// vs price delta → the OI×Price 2×2) so the read route/UI stay dumb.
// regime ∈ new_longs | short_squeeze | new_shorts | long_flush | flat.
const MIGRATION_V9 = `
    create table if not exists derivs_snapshots (
      base             text    not null,
      ts               integer not null,
      oi_usd           real    not null,   -- aggregate OI across venues (USD)
      oi_hl_usd        real,                -- Hyperliquid-only OI (USD)
      funding_hl       real,                -- HL current funding rate
      liq_long_usd     real,                -- long liquidations over window
      liq_short_usd    real,                -- short liquidations over window
      oi_delta_pct     real,                -- vs lookback snapshot
      price            real,                -- HL mark at snapshot
      price_delta_pct  real,                -- vs same lookback
      regime           text,
      venues           integer,
      primary key (base, ts)
    );
    create index if not exists idx_derivs_base_ts on derivs_snapshots(base, ts desc);
    create index if not exists idx_derivs_ts on derivs_snapshots(ts desc);
  `;

// Covering index for the 24h mean-funding read (avgFundingSince). That
// query averages ~1440 rows per symbol; with only idx_snap_sym_ts it has
// to fetch each row from the 13.7M-row table to reach `funding`, costing
// ~490ms per call — which, because better-sqlite3 is synchronous, blocks
// the event loop for every request in flight. Carrying `funding` in the
// index lets SQLite answer from the index alone: ~27ms.
//
// Cost: ~300MB on a ~1.6GB db, and one extra index to maintain on the
// ~320-row/60s snapshot insert (negligible). Building it over existing
// history takes ~11s, which lands once, on the first getDb() after this
// migration ships.
const MIGRATION_V10 = `
    create index if not exists idx_snap_sym_ts_funding
      on price_snapshots(symbol, ts, funding);
  `;

// V11 — smart-money flow (Phase 1, wallet cohorts). wallet_registry is the
// curated cohort (~300 "sharp" + up to 100 "whale" wallets, selected by the
// leaderboard-ingest script and re-validated for liveness — see
// smart-flow-build-plan.md). wallet_positions is the poller's raw feed: one
// row per open position per snapshot, PLUS one heartbeat row (coin='',
// szi=0) when a wallet has zero open positions, so "cohort went flat" is
// distinguishable from "poller didn't run".
//
// Volume math: 300 wallets × 96 snapshots/day (15-min cadence) × ~4
// positions/wallet ≈ 115k rows/day, ~3.5M rows at the 30-day retention this
// table gets (pruneWalletPositions) — about a quarter of price_snapshots'
// steady-state size. idx_wpos_addr_ts is what smartFlowAt seeks on (find
// each wallet's newest row in a bounded ts window, same shape as
// snapshotAtBounded); idx_wpos_coin_ts serves per-coin time-series reads
// (the /api/smart-flow route, the Task 6 validation report).
// V12 — ts-only index for pruneWalletPositions' range delete. Neither V11
// composite (coin,ts / address,ts) has ts as the leading column, so the
// daily prune's `delete ... where ts < ?` was a full table scan — the
// exact synchronous-scan-blocks-everything gotcha idx_snap_ts exists to
// prevent on price_snapshots, reintroduced on a table projected to hold
// ~3.5M rows at steady state. Added while the table is still small so the
// index build is instant.
const MIGRATION_V12 = `
    create index if not exists idx_wpos_ts on wallet_positions(ts);
  `;

const MIGRATION_V11 = `
    create table if not exists wallet_registry (
      address        text primary key,
      cohort         text not null,          -- 'sharp' | 'whale'
      account_value  real,                   -- LIVE value from validation, not leaderboard
      pnl_week       real, pnl_month real, roi_month real,
      turnover_month real,                   -- vlm_month / account_value (MM screen input)
      is_tracked     integer not null default 1,
      first_seen     integer not null, last_validated integer not null
    );
    create table if not exists wallet_positions (
      address  text not null,  ts integer not null,
      coin     text not null,
      szi      real not null,                -- signed, coins
      entry_px real,  position_value real,   -- USD, unsigned (HL's own figure)
      unrealized_pnl real,  leverage real,
      account_value  real                    -- marginSummary at snapshot time
    );
    create index if not exists idx_wpos_coin_ts on wallet_positions(coin, ts);
    create index if not exists idx_wpos_addr_ts on wallet_positions(address, ts);
  `;

// ── price_snapshots ─────────────────────────────────────────────────────

export interface PriceSnapshotRow {
  symbol: string;
  ts: number;
  mark: number;
  prev_day: number | null;
  funding: number | null;
  oi: number | null;
  volume: number | null;
}

export function insertPriceSnapshots(rows: PriceSnapshotRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  // Wrap in a transaction — better-sqlite3 transactions are ~order of
  // magnitude faster than per-row inserts and we're inserting ~230 rows
  // per scan.
  const stmt = db.prepare(
    `insert into price_snapshots (symbol, ts, mark, prev_day, funding, oi, volume)
     values (@symbol, @ts, @mark, @prev_day, @funding, @oi, @volume)`
  );
  const insertMany = db.transaction((batch: PriceSnapshotRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  insertMany(rows);
}

// Get the most recent snapshot for each symbol, optionally filtered by a
// min timestamp. Returns a Map symbol → snapshot row for O(1) lookup at
// call sites that need the latest known price.
export function latestSnapshots(symbols?: string[]): Map<string, PriceSnapshotRow> {
  const db = getDb();
  const rows = (symbols && symbols.length > 0
    ? db.prepare(
        `select symbol, ts, mark, prev_day, funding, oi, volume
         from price_snapshots
         where symbol in (${symbols.map(() => "?").join(",")})
         and ts = (select max(ts) from price_snapshots p2 where p2.symbol = price_snapshots.symbol)`
      ).all(...symbols)
    : db.prepare(
        `select p.symbol, p.ts, p.mark, p.prev_day, p.funding, p.oi, p.volume
         from price_snapshots p
         join (select symbol, max(ts) as max_ts from price_snapshots group by symbol) latest
           on p.symbol = latest.symbol and p.ts = latest.max_ts`
      ).all()) as PriceSnapshotRow[];
  const out = new Map<string, PriceSnapshotRow>();
  for (const r of rows) out.set(r.symbol, r);
  return out;
}

// Get snapshot of all symbols at or before a target timestamp. Used for
// multi-horizon sector-RS: e.g. "what was each symbol's mark 4h ago".
//
// Returns symbol → { mark, ts }. The ts is the ACTUAL timestamp of the
// matched row, which can be older than `targetTs`. Callers MUST inspect
// it and reject rows that are too old for their horizon — otherwise,
// after a process downtime, a "1h change" could be computed against a
// snapshot from days or weeks ago (still within the 30-day retention),
// producing garbage signals on resume. See `snapshotAtBounded` for the
// safe wrapper.
export function snapshotAt(targetTs: number, symbols?: string[]): Map<string, { mark: number; ts: number }> {
  const db = getDb();
  // For each symbol, the row with the greatest ts <= targetTs. Window
  // function would be cleaner but better-sqlite3 supports it; using a
  // correlated subquery for portability.
  const rows = (symbols && symbols.length > 0
    ? db.prepare(
        `select p.symbol, p.mark, p.ts
         from price_snapshots p
         where p.symbol in (${symbols.map(() => "?").join(",")})
         and p.ts = (
           select max(ts) from price_snapshots p2
           where p2.symbol = p.symbol and p2.ts <= ?
         )`
      ).all(...symbols, targetTs)
    : db.prepare(
        `select p.symbol, p.mark, p.ts
         from price_snapshots p
         where p.ts = (
           select max(ts) from price_snapshots p2
           where p2.symbol = p.symbol and p2.ts <= ?
         )`
      ).all(targetTs)) as Array<{ symbol: string; mark: number; ts: number }>;
  const out = new Map<string, { mark: number; ts: number }>();
  for (const r of rows) out.set(r.symbol, { mark: r.mark, ts: r.ts });
  return out;
}

// Returns, per symbol, the mark from the newest snapshot in the window
// [targetTs - maxAgeMs, targetTs] — i.e. "the price at horizon N ago",
// with a guard so that a gap in snapshots yields *nothing* rather than a
// row from much earlier that would produce a nonsense % change.
//
// Symbols with no row in the window are absent from the result; callers
// must treat absence as "no data" (null), not as zero.
//
// Implementation note — do NOT reintroduce the `snapshotAt`-then-filter
// shape this replaced. That ran a correlated subquery per candidate row
// over the whole 13.7M-row table (~7.3s per call, ×5 calls per scan
// cycle => the 20-40s /api/markets cache-miss latency measured on
// 2026-07-14). Pushing both bounds into the WHERE lets SQLite walk
// idx_snap_sym_ts backwards from targetTs and stop at the first hit:
// ~4.5ms for all ~340 symbols, a ~1600x improvement.
//
// The results are identical to the old shape, not merely similar: the
// newest row <= targetTs is the closest one from below, so if it falls
// outside the tolerance then every older row does too — which is exactly
// what bounding the range below at targetTs - maxAgeMs expresses.
export function snapshotAtBounded(
  targetTs: number,
  maxAgeMs: number,
  symbols?: string[],
): Map<string, number> {
  const out = new Map<string, number>();
  const db = getDb();
  const list = symbols && symbols.length > 0 ? symbols : distinctSnapshotSymbols();
  const stmt = db.prepare(
    `select mark from price_snapshots
      where symbol = ? and ts <= ? and ts >= ?
      order by ts desc limit 1`
  );
  for (const sym of list) {
    const row = stmt.get(sym, targetTs, targetTs - maxAgeMs) as { mark: number } | undefined;
    if (row) out.set(sym, row.mark);
  }
  return out;
}

// Distinct symbol list for the unfiltered variants of the bounded
// lookups. Callers in the app always pass an explicit symbol list; this
// is the fallback so `symbols`-less calls keep working.
function distinctSnapshotSymbols(): string[] {
  const db = getDb();
  const rows = db.prepare(`select distinct symbol from price_snapshots`).all() as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

// Like snapshotAtBounded, but returns the full market context from the
// matched row rather than just the mark.
//
// Why this exists: OI is denominated in COINS, so USD OI at time T is
// oi(T) × mark(T) — the oi and the mark MUST come from the same row. A
// caller that combined snapshotAtBounded's historical mark with a
// separately-fetched oi (or vice versa) would silently compute a delta
// against a price/OI pair that never coexisted. Returning the row whole
// makes that mistake hard to write.
//
// Same bounding semantics as snapshotAtBounded: rows whose actual ts is
// more than maxAgeMs from targetTs are dropped rather than returned, so
// a snapshot gap yields null downstream instead of a garbage delta.
export interface SnapshotPointFull {
  mark: number;
  oi: number | null;
  funding: number | null;
  ts: number;
}

export function snapshotFullAtBounded(
  targetTs: number,
  maxAgeMs: number,
  symbols?: string[],
): Map<string, SnapshotPointFull> {
  const out = new Map<string, SnapshotPointFull>();
  const db = getDb();
  const list = symbols && symbols.length > 0 ? symbols : distinctSnapshotSymbols();
  // Same bounded-seek shape as snapshotAtBounded — see the perf note there
  // before changing it.
  const stmt = db.prepare(
    `select mark, oi, funding, ts from price_snapshots
      where symbol = ? and ts <= ? and ts >= ?
      order by ts desc limit 1`
  );
  for (const sym of list) {
    const row = stmt.get(sym, targetTs, targetTs - maxAgeMs) as
      | { mark: number; oi: number | null; funding: number | null; ts: number }
      | undefined;
    if (row) out.set(sym, row);
  }
  return out;
}

// Mean hourly funding rate per symbol since a timestamp.
//
// The instantaneous funding print is noisy on the HIP-3 builder markets —
// SKHX swung from +454% to -215% APR inside an hour on 2026-07-14. A
// screener column reading the spot value therefore flags "crowded" on what
// is really a two-sided battleground. The 24h mean separates structural
// positioning (persistently one-signed) from that noise.
//
// Rows with null funding are excluded by SQL avg(), so the mean is over
// observations we actually have rather than treating gaps as zero.
// Per-symbol seeks rather than one `group by symbol` over the window: the
// grouped form can't use idx_snap_sym_ts_funding as a covering index for
// the aggregate and lands at ~470ms, while looping indexed seeks stays at
// ~27ms for all ~340 symbols. Same reasoning as snapshotAtBounded.
export function avgFundingSince(sinceTs: number, symbols?: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const db = getDb();
  const list = symbols && symbols.length > 0 ? symbols : distinctSnapshotSymbols();
  const stmt = db.prepare(
    `select avg(funding) as f from price_snapshots
      where symbol = ? and ts >= ? and funding is not null`
  );
  for (const sym of list) {
    const row = stmt.get(sym, sinceTs) as { f: number | null } | undefined;
    if (row?.f != null && Number.isFinite(row.f)) out.set(sym, row.f);
  }
  return out;
}

// 30-day retention prune. Called by a periodic job so the table doesn't
// grow unboundedly. ~660k rows/day for 230 symbols at 30s scan cadence.
export function prunePriceSnapshots(maxAgeMs: number = 30 * 86_400_000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare(`delete from price_snapshots where ts < ?`).run(cutoff);
  return result.changes;
}

// ── candles_cache ───────────────────────────────────────────────────────

export interface CandleRow {
  symbol: string;
  interval: string;
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function upsertCandles(rows: CandleRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `insert into candles_cache (symbol, interval, t, o, h, l, c, v)
     values (@symbol, @interval, @t, @o, @h, @l, @c, @v)
     on conflict(symbol, interval, t) do update set
       o = excluded.o, h = excluded.h, l = excluded.l,
       c = excluded.c, v = excluded.v`
  );
  const upsertMany = db.transaction((batch: CandleRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  upsertMany(rows);
}

export function getCandlesFromCache(
  symbol: string,
  interval: string,
  count: number
): CandleRow[] {
  const db = getDb();
  // Latest `count` candles for the symbol/interval, returned oldest-first
  // (matches HL's response shape so callers can drop in unchanged).
  const rows = db.prepare(
    `select symbol, interval, t, o, h, l, c, v
     from candles_cache
     where symbol = ? and interval = ?
     order by t desc
     limit ?`
  ).all(symbol, interval, count) as CandleRow[];
  return rows.reverse();
}

// Bulk variant — fetches the latest `count` candles per symbol for the
// given interval in a single SQL query. Returns a Map<symbol, candles>
// where each entry is oldest-first to match the single-symbol variant.
//
// Why: routes like /api/screener and /api/markets backfill loop over
// 40+ symbols and call getCandlesFromCache() once each, producing
// 40+ synchronous SQLite reads that block the event loop. better-
// sqlite3 prepared statements are fast but still synchronous —
// batching into one IN(...) query cuts dispatch overhead and gives
// the DB engine room to optimize. Measured 10–20× speedup on the
// screener route under typical load.
//
// Implementation uses a window-function partition to grab the top-N
// per symbol; SQLite has supported row_number() over since 3.25.
export function getCandlesBulkFromCache(
  symbols: string[],
  interval: string,
  count: number,
): Map<string, CandleRow[]> {
  const out = new Map<string, CandleRow[]>();
  if (symbols.length === 0) return out;
  const db = getDb();
  const placeholders = symbols.map(() => "?").join(",");
  const rows = db.prepare(
    `select symbol, interval, t, o, h, l, c, v
     from (
       select *,
         row_number() over (partition by symbol order by t desc) as rn
       from candles_cache
       where symbol in (${placeholders}) and interval = ?
     )
     where rn <= ?
     order by symbol, t asc`
  ).all(...symbols, interval, count) as CandleRow[];
  for (const r of rows) {
    const list = out.get(r.symbol) ?? [];
    list.push(r);
    out.set(r.symbol, list);
  }
  return out;
}

// Prune candle history older than N days *per interval* — daily candles
// are worth keeping longer than 1h candles. Defaults are generous.
export function pruneCandles(): number {
  const db = getDb();
  const now = Date.now();
  const cutoffs: Record<string, number> = {
    "1h": now - 30 * 86_400_000,
    "4h": now - 90 * 86_400_000,
    "1d": now - 365 * 86_400_000,
  };
  let total = 0;
  for (const [interval, cutoff] of Object.entries(cutoffs)) {
    const r = db.prepare(
      `delete from candles_cache where interval = ? and t < ?`
    ).run(interval, cutoff);
    total += r.changes;
  }
  return total;
}

// ── event_history (signal de-bouncer, TF-aware) ─────────────────────────
// Key includes `timeframe` so a fire on one TF doesn't suppress the same
// signal type on another TF. The `_` sentinel is used for TF-less /
// cross-sectional signals (sector_leader, social_spike) so they get
// their own suppression bucket separate from per-TF scans.

// Build a stable in-memory key from (symbol, type, tf-or-sentinel).
// Exported so callers don't have to know the encoding.
export function eventHistoryKey(symbol: string, type: string, timeframe?: string | null): string {
  return `${symbol}:${type}:${timeframe ?? "_"}`;
}

export function loadEventHistory(): Map<string, number> {
  const db = getDb();
  const rows = db.prepare(
    `select symbol, type, timeframe, last_fired_at from event_history`
  ).all() as Array<{ symbol: string; type: string; timeframe: string; last_fired_at: number }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(eventHistoryKey(r.symbol, r.type, r.timeframe), r.last_fired_at);
  return m;
}

export function recordEventFire(
  symbol: string,
  type: string,
  firedAt: number,
  timeframe?: string | null,
): void {
  const db = getDb();
  const tf = timeframe ?? "_";
  db.prepare(
    `insert into event_history (symbol, type, timeframe, last_fired_at)
     values (?, ?, ?, ?)
     on conflict(symbol, type, timeframe) do update set last_fired_at = excluded.last_fired_at`
  ).run(symbol, type, tf, firedAt);
}

// ── social_snapshots (time-window-aware in v5) ──────────────────────────

export interface SocialSnapshotRow {
  symbol: string;
  time_window: string;       // "1h" | "4h" | "12h" | "24h" | "7d"
  ts: number;
  mention_count: number;
  prev_count: number | null;
  change_pct: number | null;
}

export function insertSocialSnapshots(rows: SocialSnapshotRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `insert into social_snapshots (symbol, time_window, ts, mention_count, prev_count, change_pct)
     values (@symbol, @time_window, @ts, @mention_count, @prev_count, @change_pct)
     on conflict(symbol, time_window, ts) do update set
       mention_count = excluded.mention_count,
       prev_count = excluded.prev_count,
       change_pct = excluded.change_pct`
  );
  const insertMany = db.transaction((batch: SocialSnapshotRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  insertMany(rows);
}

// Latest snapshot per (symbol, time_window). Pass `timeWindow` to scope
// the read — different horizons return DIFFERENT data and must not be
// served interchangeably.
export function latestSocialSnapshots(
  timeWindow: string,
  symbols?: string[],
): Map<string, SocialSnapshotRow> {
  const db = getDb();
  const rows = (symbols && symbols.length > 0
    ? db.prepare(
        `select symbol, time_window, ts, mention_count, prev_count, change_pct
         from social_snapshots
         where time_window = ? and symbol in (${symbols.map(() => "?").join(",")})
         and ts = (
           select max(ts) from social_snapshots p2
           where p2.symbol = social_snapshots.symbol and p2.time_window = ?
         )`
      ).all(timeWindow, ...symbols, timeWindow)
    : db.prepare(
        `select p.symbol, p.time_window, p.ts, p.mention_count, p.prev_count, p.change_pct
         from social_snapshots p
         join (
           select symbol, max(ts) as max_ts from social_snapshots
           where time_window = ? group by symbol
         ) latest
           on p.symbol = latest.symbol and p.ts = latest.max_ts and p.time_window = ?`
      ).all(timeWindow, timeWindow)) as SocialSnapshotRow[];
  const out = new Map<string, SocialSnapshotRow>();
  for (const r of rows) out.set(r.symbol, r);
  return out;
}

// Full snapshot series per symbol since `sinceTs`, oldest-first — the
// substrate for mention-acceleration ranking. Scoped to one time_window
// (same rule as latestSocialSnapshots: horizons are not interchangeable).
// No symbol filter: the whole point is discovering tickers we don't
// track yet, so callers get the full Elfa universe and intersect with
// the HL universe themselves.
export function socialSnapshotSeries(
  timeWindow: string,
  sinceTs: number,
): Map<string, Array<{ ts: number; mentions: number }>> {
  const db = getDb();
  const rows = db
    .prepare(
      `select symbol, ts, mention_count from social_snapshots
        where time_window = ? and ts >= ?
        order by ts asc`
    )
    .all(timeWindow, sinceTs) as Array<{ symbol: string; ts: number; mention_count: number }>;
  const out = new Map<string, Array<{ ts: number; mentions: number }>>();
  for (const r of rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({ ts: r.ts, mentions: r.mention_count });
    out.set(r.symbol, list);
  }
  return out;
}

export function pruneSocialSnapshots(maxAgeMs: number = 30 * 86_400_000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  return db.prepare(`delete from social_snapshots where ts < ?`).run(cutoff).changes;
}

// ── hype_pressure_snapshots ─────────────────────────────────────────────

export interface HypePressureRow {
  ts: number;
  pressure_1h_usd: number;
  pressure_24h_usd: number;
  hype_price: number;
  active_twap_count: number;
}

export function insertHypePressureSnapshot(row: HypePressureRow): void {
  const db = getDb();
  db.prepare(
    `insert into hype_pressure_snapshots
       (ts, pressure_1h_usd, pressure_24h_usd, hype_price, active_twap_count)
     values (@ts, @pressure_1h_usd, @pressure_24h_usd, @hype_price, @active_twap_count)
     on conflict(ts) do update set
       pressure_1h_usd = excluded.pressure_1h_usd,
       pressure_24h_usd = excluded.pressure_24h_usd,
       hype_price = excluded.hype_price,
       active_twap_count = excluded.active_twap_count`
  ).run(row);
}

export function latestHypePressureSnapshot(): HypePressureRow | null {
  const db = getDb();
  const row = db.prepare(
    `select ts, pressure_1h_usd, pressure_24h_usd, hype_price, active_twap_count
     from hype_pressure_snapshots order by ts desc limit 1`
  ).get() as HypePressureRow | undefined;
  return row ?? null;
}

export function pruneHypePressureSnapshots(maxAgeMs: number = 30 * 86_400_000): number {
  const db = getDb();
  return db.prepare(`delete from hype_pressure_snapshots where ts < ?`)
    .run(Date.now() - maxAgeMs).changes;
}

// ── btc_binary_snapshots (HIP-4 daily BTC binary, v6) ───────────────────

export interface BtcBinaryRow {
  ts: number;
  target_price: number;
  expiry_ms: number;
  yes_price: number;
  no_price: number;
  btc_mid: number;
}

export function insertBtcBinarySnapshot(row: BtcBinaryRow): void {
  const db = getDb();
  db.prepare(
    `insert into btc_binary_snapshots
       (ts, target_price, expiry_ms, yes_price, no_price, btc_mid)
     values (@ts, @target_price, @expiry_ms, @yes_price, @no_price, @btc_mid)
     on conflict(ts) do update set
       target_price = excluded.target_price,
       expiry_ms = excluded.expiry_ms,
       yes_price = excluded.yes_price,
       no_price = excluded.no_price,
       btc_mid = excluded.btc_mid`
  ).run(row);
}

// Returns the hype-pressure snapshot whose ts is closest to (and ≤)
// `targetTs`. Used by the divergence detector to compare current
// pressure against pressure from N minutes ago — without this we'd
// have to load the full series and filter in JS.
export function hypePressureSnapshotAt(targetTs: number): HypePressureRow | null {
  const db = getDb();
  const row = db.prepare(
    `select ts, pressure_1h_usd, pressure_24h_usd, hype_price, active_twap_count
     from hype_pressure_snapshots
     where ts <= ?
     order by ts desc
     limit 1`
  ).get(targetTs) as HypePressureRow | undefined;
  return row ?? null;
}

export function latestBtcBinarySnapshot(): BtcBinaryRow | null {
  const db = getDb();
  const row = db.prepare(
    `select ts, target_price, expiry_ms, yes_price, no_price, btc_mid
     from btc_binary_snapshots order by ts desc limit 1`
  ).get() as BtcBinaryRow | undefined;
  return row ?? null;
}

export function pruneBtcBinarySnapshots(maxAgeMs: number = 30 * 86_400_000): number {
  const db = getDb();
  return db.prepare(`delete from btc_binary_snapshots where ts < ?`)
    .run(Date.now() - maxAgeMs).changes;
}

// ── runtime_kv ──────────────────────────────────────────────────────────

export function kvGet(key: string): string | null {
  const db = getDb();
  const row = db.prepare(`select value from runtime_kv where key = ?`).get(key) as
    | { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `insert into runtime_kv (key, value, ts) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, ts = excluded.ts`
  ).run(key, value, Date.now());
}

// Atomic increment of an integer-valued kv. Returns the new value.
// Used by Elfa's budget tracker so concurrent callers near the cap
// can't both pass a check-then-increment. SQLite is single-writer
// per connection so the UPDATE is naturally atomic; the COALESCE
// handles the "row doesn't exist yet" case for the first call of
// a UTC day.
export function kvAtomicIncrement(key: string, delta: number = 1): number {
  const db = getDb();
  const txn = db.transaction(() => {
    db.prepare(
      `insert into runtime_kv (key, value, ts) values (?, '0', ?)
       on conflict(key) do nothing`
    ).run(key, Date.now());
    db.prepare(
      `update runtime_kv
       set value = cast(cast(value as integer) + ? as text), ts = ?
       where key = ?`
    ).run(delta, Date.now(), key);
    const row = db.prepare(`select value from runtime_kv where key = ?`).get(key) as
      | { value: string } | undefined;
    return row ? parseInt(row.value, 10) : delta;
  });
  return txn() as number;
}

// ── trades (journal) ────────────────────────────────────────────────────
// Wide row, sparse on close-time fields until a trade is closed. We DON'T
// prune trades — the journal is the long-term retro substrate and a few
// hundred rows/year is nothing.

export interface TradeRow {
  id: number;
  ts_opened: number;
  ts_closed: number | null;
  symbol: string;
  sector: string | null;
  direction: "long" | "short";
  mode: "paper" | "live";
  entry_price: number;
  stop_price: number;
  target_price: number;
  size: number;
  risk_usd: number;
  conviction_score: number | null;
  conviction_label: string | null;
  vol_regime: string | null;
  atr_pct: number | null;
  funding_hourly: number | null;
  signals_json: string | null;
  families_json: string | null;
  exit_price: number | null;
  exit_reason: "stop" | "target" | "manual" | "expired" | null;
  pnl_usd: number | null;
  pnl_r: number | null;
  notes: string | null;
}

// Insert a new trade. Caller pre-computes the entry/stop/target/size — we
// don't re-compute on this side to keep the DAL dumb. Returns the new id.
export function insertTrade(
  row: Omit<TradeRow, "id" | "ts_closed" | "exit_price" | "exit_reason" | "pnl_usd" | "pnl_r">
): number {
  const db = getDb();
  const stmt = db.prepare(
    `insert into trades (
       ts_opened, symbol, sector, direction, mode,
       entry_price, stop_price, target_price, size, risk_usd,
       conviction_score, conviction_label, vol_regime, atr_pct, funding_hourly,
       signals_json, families_json, notes
     ) values (
       @ts_opened, @symbol, @sector, @direction, @mode,
       @entry_price, @stop_price, @target_price, @size, @risk_usd,
       @conviction_score, @conviction_label, @vol_regime, @atr_pct, @funding_hourly,
       @signals_json, @families_json, @notes
     )`
  );
  const result = stmt.run(row);
  return result.lastInsertRowid as number;
}

// Close a trade. Computes pnl_usd and pnl_r server-side from the stored
// entry/stop/size — caller only supplies exit_price + reason + optional
// note. Returns the updated row, or null if the trade is already closed
// or doesn't exist.
export function closeTrade(
  id: number,
  exit_price: number,
  exit_reason: "stop" | "target" | "manual" | "expired",
  appendNote?: string
): TradeRow | null {
  const db = getDb();
  const existing = db.prepare(`select * from trades where id = ?`).get(id) as TradeRow | undefined;
  if (!existing) return null;
  if (existing.ts_closed != null) return existing; // idempotent: already closed

  const dirSign = existing.direction === "long" ? 1 : -1;
  const stopDistance = Math.abs(existing.entry_price - existing.stop_price);
  // P&L in USD: (exit - entry) × size × dirSign for long, inverted for short
  const pnl_usd = (exit_price - existing.entry_price) * existing.size * dirSign;
  // R-multiple: how many stop-distances of profit/loss this trade earned.
  // Positive = won (in favor); negative = lost (stopped out or worse).
  // A clean 3R win means we hit our target; -1R means we hit our stop exactly.
  const pnl_r = stopDistance > 0 ? (pnl_usd / (stopDistance * existing.size)) : 0;

  const notesValue = appendNote && existing.notes
    ? `${existing.notes}\n— ${appendNote}`
    : (appendNote ?? existing.notes);

  db.prepare(
    `update trades
     set ts_closed = ?, exit_price = ?, exit_reason = ?,
         pnl_usd = ?, pnl_r = ?, notes = coalesce(?, notes)
     where id = ?`
  ).run(Date.now(), exit_price, exit_reason, pnl_usd, pnl_r, notesValue, id);

  return db.prepare(`select * from trades where id = ?`).get(id) as TradeRow;
}

// List trades, newest-first. Optional filters keep the journal page
// responsive once the table grows past a few hundred rows.
export function listTrades(opts: {
  symbol?: string;
  mode?: "paper" | "live";
  status?: "open" | "closed" | "all";
  limit?: number;
} = {}): TradeRow[] {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.symbol) { where.push("symbol = @symbol"); params.symbol = opts.symbol.toUpperCase(); }
  if (opts.mode)   { where.push("mode = @mode"); params.mode = opts.mode; }
  if (opts.status === "open")   where.push("ts_closed is null");
  if (opts.status === "closed") where.push("ts_closed is not null");
  const sql =
    `select * from trades
     ${where.length ? "where " + where.join(" and ") : ""}
     order by ts_opened desc
     limit ${Math.min(1000, Math.max(1, opts.limit ?? 200))}`;
  return db.prepare(sql).all(params) as TradeRow[];
}

export function getTrade(id: number): TradeRow | null {
  const db = getDb();
  return (db.prepare(`select * from trades where id = ?`).get(id) as TradeRow | undefined) ?? null;
}

// ── Periodic prune scheduler ────────────────────────────────────────────
// Kicks off a daily prune. Idempotent — caller can invoke multiple times
// (subsequent calls are no-ops if the timer already exists).

let pruneTimer: ReturnType<typeof setInterval> | null = null;

export function startPruneJob(): void {
  if (pruneTimer) return;
  // Run once on startup so the first prune doesn't have to wait a full day,
  // then every 24h. Wrap in try/catch so a transient SQLite error doesn't
  // kill the whole process (unlikely but cheap insurance).
  const runOnce = () => {
    try {
      const sp = prunePriceSnapshots();
      const cp = pruneCandles();
      const ss = pruneSocialSnapshots();
      const hp = pruneHypePressureSnapshots();
      const bb = pruneBtcBinarySnapshots();
      const fe = pruneFeedEvents();
      const dv = pruneDerivsSnapshots();
      const wp = pruneWalletPositions();
      if (sp > 0 || cp > 0 || ss > 0 || hp > 0 || bb > 0 || fe > 0 || dv > 0 || wp > 0) {
        console.info(
          `[db] pruned ${sp} price, ${cp} candle, ${ss} social, ${hp} hype-pressure, ${bb} btc-binary, ${fe} feed, ${dv} derivs, ${wp} wallet-position snapshots`
        );
      }
    } catch (err) {
      console.warn(`[db] prune failed:`, err);
    }
  };
  runOnce();
  pruneTimer = setInterval(runOnce, 24 * 3600 * 1000);
  // Don't keep the event loop alive just for this timer.
  if (typeof pruneTimer.unref === "function") pruneTimer.unref();
}

// ── feed_events ─────────────────────────────────────────────────────────

export interface FeedEventRow {
  id: number;
  ts: number;
  source: string;
  author: string | null;
  title: string;
  body: string | null;
  url: string | null;
  symbols_json: string | null;
  importance: number;
  dedup_key: string;
  raw_json: string | null;
}

export type FeedEventInput = Omit<FeedEventRow, "id">;

// Insert feed items, ignoring any whose dedup_key already exists. Returns
// the count actually inserted — lets the poller log "5 new" without a
// separate read. Wrapped in a transaction so a batch poll is one fsync.
export function insertFeedEvents(rows: FeedEventInput[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `insert or ignore into feed_events
       (ts, source, author, title, body, url, symbols_json, importance, dedup_key, raw_json)
     values (@ts, @source, @author, @title, @body, @url, @symbols_json, @importance, @dedup_key, @raw_json)`
  );
  const tx = db.transaction((batch: FeedEventInput[]) => {
    let inserted = 0;
    for (const r of batch) {
      const info = stmt.run(r);
      inserted += info.changes;
    }
    return inserted;
  });
  return tx(rows);
}

// Read the feed newest-first with optional filters. `symbol` matches rows
// whose symbols_json array contains it (uppercase). `since` is a ts lower
// bound (exclusive) for incremental polling from the client.
export function listFeedEvents(opts: {
  source?: string;
  symbol?: string;
  minImportance?: number;
  since?: number;
  limit?: number;
} = {}): FeedEventRow[] {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.source) { where.push("source = @source"); params.source = opts.source; }
  if (opts.minImportance != null) { where.push("importance >= @minImportance"); params.minImportance = opts.minImportance; }
  if (opts.since != null) { where.push("ts > @since"); params.since = opts.since; }
  if (opts.symbol) {
    // symbols_json is a JSON array of bare uppercase tickers. Match the
    // quoted token so "BTC" doesn't substring-hit "WBTC". Cheap LIKE is
    // fine at this table's size; a json_each index isn't worth it yet.
    // Validate the ticker shape first — `%`/`_` are LIKE wildcards, so an
    // unvalidated symbol could broaden the match to everything; a bad
    // shape simply drops the filter (audit finding M3).
    const sym = opts.symbol.toUpperCase();
    if (/^[A-Z0-9]{1,20}$/.test(sym)) {
      where.push(`symbols_json like @symLike`);
      params.symLike = `%"${sym}"%`;
    }
  }
  const clause = where.length ? `where ${where.join(" and ")}` : "";
  // Clamp to [1,500]. Without the lower bound, limit=-1 (which passes
  // Number.isFinite upstream) becomes SQLite `LIMIT -1` = unbounded scan
  // on a public endpoint (audit finding H2).
  const reqLimit = Math.floor(opts.limit ?? 100);
  const limit = Number.isFinite(reqLimit) ? Math.max(1, Math.min(500, reqLimit)) : 100;
  return db
    .prepare(`select * from feed_events ${clause} order by ts desc limit ${limit}`)
    .all(params) as FeedEventRow[];
}

export function pruneFeedEvents(maxAgeMs: number = 14 * 86_400_000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  return db.prepare(`delete from feed_events where ts < ?`).run(cutoff).changes;
}

// Recent snapshot series for a set of symbols, oldest-first. Powers the
// HL-native derivs radar: OI/price deltas + sparklines come straight from
// this table (written ~60s by the /api/markets pipeline + keepalive).
// The since-bound keeps the result naturally windowed — a multi-day gap in
// snapshots (sleeping poller) can't leak ancient rows into delta math.
export function snapshotSeriesBulk(
  symbols: string[],
  sinceTs: number
): Map<string, { ts: number; mark: number; oi: number | null; funding: number | null }[]> {
  const out = new Map<string, { ts: number; mark: number; oi: number | null; funding: number | null }[]>();
  if (symbols.length === 0) return out;
  const db = getDb();
  const placeholders = symbols.map(() => "?").join(",");
  const rows = db
    .prepare(
      `select symbol, ts, mark, oi, funding from price_snapshots
        where ts >= ? and symbol in (${placeholders})
        order by ts asc`
    )
    .all(sinceTs, ...symbols) as {
      symbol: string; ts: number; mark: number; oi: number | null; funding: number | null;
    }[];
  for (const r of rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({ ts: r.ts, mark: r.mark, oi: r.oi, funding: r.funding });
    out.set(r.symbol, list);
  }
  return out;
}

// Freshness probes for the status bar — newest row timestamps.
export function latestSnapshotTs(): number | null {
  const db = getDb();
  const r = db.prepare(`select max(ts) ts from price_snapshots`).get() as { ts: number | null };
  return r?.ts ?? null;
}

export function latestFeedTs(): number | null {
  const db = getDb();
  const r = db.prepare(`select max(ts) ts from feed_events`).get() as { ts: number | null };
  return r?.ts ?? null;
}

// ── derivs_snapshots ────────────────────────────────────────────────────

export interface DerivsRow {
  base: string;
  ts: number;
  oi_usd: number;
  oi_hl_usd: number | null;
  funding_hl: number | null;
  liq_long_usd: number | null;
  liq_short_usd: number | null;
  oi_delta_pct: number | null;
  price: number | null;
  price_delta_pct: number | null;
  regime: string | null;
  venues: number | null;
}

export function insertDerivsSnapshots(rows: DerivsRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `insert or replace into derivs_snapshots
       (base, ts, oi_usd, oi_hl_usd, funding_hl, liq_long_usd, liq_short_usd,
        oi_delta_pct, price, price_delta_pct, regime, venues)
     values (@base, @ts, @oi_usd, @oi_hl_usd, @funding_hl, @liq_long_usd, @liq_short_usd,
        @oi_delta_pct, @price, @price_delta_pct, @regime, @venues)`
  );
  const tx = db.transaction((batch: DerivsRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  tx(rows);
}

// Latest snapshot per base, newest-first by ts. `maxAgeMs` drops bases that
// haven't updated recently (stale poller / dropped coverage).
export function latestDerivsSnapshots(maxAgeMs = 10 * 60_000): DerivsRow[] {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  return db
    .prepare(
      `select d.* from derivs_snapshots d
         join (select base, max(ts) ts from derivs_snapshots group by base) m
           on d.base = m.base and d.ts = m.ts
        where d.ts >= ?
        order by d.oi_usd desc`
    )
    .all(cutoff) as DerivsRow[];
}

// Closest snapshot for one base at-or-before targetTs — used by the poller
// to compute OI/price deltas over a fixed lookback window.
export function derivsSnapshotAt(base: string, targetTs: number): DerivsRow | null {
  const db = getDb();
  return (
    (db
      .prepare(
        `select * from derivs_snapshots where base = ? and ts <= ? order by ts desc limit 1`
      )
      .get(base, targetTs) as DerivsRow | undefined) ?? null
  );
}

export function pruneDerivsSnapshots(maxAgeMs: number = 7 * 86_400_000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  return db.prepare(`delete from derivs_snapshots where ts < ?`).run(cutoff).changes;
}

// ── wallet_registry / wallet_positions (smart-money flow, v11) ──────────

export interface WalletRegistryRow {
  address: string;
  cohort: string;                 // 'sharp' | 'whale'
  account_value: number | null;   // LIVE value from validation, not the leaderboard
  pnl_week: number | null;
  pnl_month: number | null;
  roi_month: number | null;
  turnover_month: number | null;
  is_tracked: number;             // 0 | 1
  first_seen: number;
  last_validated: number;
}

// Upsert cohort rows keyed on address. `first_seen` is preserved across
// re-ingests (min of existing/incoming) so a wallet that drops out and
// re-qualifies later doesn't look freshly discovered; every other column
// reflects the latest ingest run, including is_tracked — this is how the
// ingest script "untracks" a wallet that fell out of the cohort without
// deleting its history.
export function upsertWalletRegistry(rows: WalletRegistryRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `insert into wallet_registry
       (address, cohort, account_value, pnl_week, pnl_month, roi_month,
        turnover_month, is_tracked, first_seen, last_validated)
     values (@address, @cohort, @account_value, @pnl_week, @pnl_month, @roi_month,
        @turnover_month, @is_tracked, @first_seen, @last_validated)
     on conflict(address) do update set
       cohort = excluded.cohort,
       account_value = excluded.account_value,
       pnl_week = excluded.pnl_week,
       pnl_month = excluded.pnl_month,
       roi_month = excluded.roi_month,
       turnover_month = excluded.turnover_month,
       is_tracked = excluded.is_tracked,
       first_seen = min(wallet_registry.first_seen, excluded.first_seen),
       last_validated = excluded.last_validated`
  );
  const upsertMany = db.transaction((batch: WalletRegistryRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  upsertMany(rows);
}

// Currently-tracked cohort — the poller's work list.
export function trackedWallets(): WalletRegistryRow[] {
  const db = getDb();
  return db
    .prepare(`select * from wallet_registry where is_tracked = 1`)
    .all() as WalletRegistryRow[];
}

// Untrack a single wallet — used by the position poller after N consecutive
// clearinghouseState failures (dead/vanished account). Targeted UPDATE, not
// a delete: history in wallet_positions stays, and a re-ingest can revive
// the wallet later by flipping is_tracked back via upsertWalletRegistry.
export function demoteWallet(address: string): void {
  const db = getDb();
  db.prepare(`update wallet_registry set is_tracked = 0 where address = ?`).run(address);
}

export interface WalletPositionRow {
  address: string;
  ts: number;
  coin: string;                    // '' = heartbeat row (wallet has zero open positions)
  szi: number;                     // signed, coins
  entry_px: number | null;
  position_value: number | null;   // USD, unsigned (HL's own figure — never derive from szi × price)
  unrealized_pnl: number | null;
  leverage: number | null;
  account_value: number | null;    // marginSummary.accountValue at snapshot time
}

export function insertWalletPositions(rows: WalletPositionRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `insert into wallet_positions
       (address, ts, coin, szi, entry_px, position_value, unrealized_pnl, leverage, account_value)
     values (@address, @ts, @coin, @szi, @entry_px, @position_value, @unrealized_pnl, @leverage, @account_value)`
  );
  const insertMany = db.transaction((batch: WalletPositionRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  insertMany(rows);
}

// Distinct addresses ever seen in wallet_positions. Covered by
// idx_wpos_addr_ts (leading column address) so this is an index-only scan,
// not a table scan — same fallback pattern as distinctSnapshotSymbols.
function distinctWalletAddresses(): string[] {
  const db = getDb();
  const rows = db.prepare(`select distinct address from wallet_positions`).all() as Array<{ address: string }>;
  return rows.map((r) => r.address);
}

export interface SmartFlowPoint {
  longUsd: number;
  shortUsd: number;
  netUsd: number;
  wallets: number;
}

// Per-coin aggregate of the cohort's positioning at a point in time.
//
// The unit of truth is a WALLET's newest snapshot batch inside the window
// [targetTs - maxAgeMs, targetTs] — not a per-(coin) newest row. The
// poller writes one row per open position (all sharing the same ts) plus,
// for a flat wallet, a single heartbeat row (coin='', szi=0) at that ts.
// So for each address we first seek its own newest ts in the window (a
// bounded index seek on idx_wpos_addr_ts, same shape as snapshotAtBounded
// — see that function's perf comment before changing this), then pull
// every row written at exactly that ts and fold it into the per-coin
// totals in one pass.
//
// This is deliberate, not incidental, for two invariants:
//   1. Same-row pairing — szi (direction) and position_value (magnitude)
//      always come from the row the wallet wrote together, so a position
//      that flipped between two polls contributes the newer poll's
//      direction AND magnitude, never a mix of the two.
//   2. Heartbeat semantics — if a wallet's newest row in-window is the
//      heartbeat, it contributes to no coin at all, even if an OLDER
//      in-window row shows it holding a position. A naive per-(coin,
//      address) seek (ignoring the wallet's other rows) would miss this:
//      it would still find that older coin row and report the wallet as
//      still holding, silently double-counting a position the wallet has
//      since closed.
//
// Magnitude is always position_value (HL's own USD figure) — never
// szi × price; see AGENTS.md's SPX OI gotcha for why that multiplication
// is unsafe in general.
// `addresses` scopes the aggregation to a known wallet set. Callers that
// compute DELTAS (the smart-flow route diffs three points in time) must
// pass the SAME list for every point — otherwise the delta conflates
// position changes with cohort-composition changes (a wallet demoted an
// hour ago would count in the -24h total but not the NOW total, showing
// a phantom outflow). It is also the perf-critical path: the fallback
// distinctWalletAddresses() scans all-history DISTINCT — including
// demoted wallets whose rows haven't aged out, a set that only grows —
// measured at ~600ms of blocked event loop per route call at projected
// scale, vs ~14ms when scoped to the tracked registry.
export function smartFlowAt(
  targetTs: number,
  maxAgeMs: number,
  addresses?: string[],
): Map<string, SmartFlowPoint> {
  const out = new Map<string, SmartFlowPoint>();
  const walletsByCoin = new Map<string, Set<string>>();
  const db = getDb();

  const latestTsStmt = db.prepare(
    `select ts from wallet_positions
      where address = ? and ts <= ? and ts >= ?
      order by ts desc limit 1`
  );
  const rowsAtTsStmt = db.prepare(
    `select coin, szi, position_value from wallet_positions
      where address = ? and ts = ?`
  );

  const walletList = addresses ?? distinctWalletAddresses();
  for (const address of walletList) {
    const latest = latestTsStmt.get(address, targetTs, targetTs - maxAgeMs) as
      | { ts: number }
      | undefined;
    if (!latest) continue; // no row for this wallet in the window

    const batch = rowsAtTsStmt.all(address, latest.ts) as Array<{
      coin: string;
      szi: number;
      position_value: number | null;
    }>;

    // A heartbeat batch is a single coin='' row — the wallet is flat at
    // its newest in-window snapshot. Contributes to no coin.
    if (batch.length === 1 && batch[0].coin === "") continue;

    for (const row of batch) {
      if (row.coin === "" || row.szi === 0) continue; // heartbeat noise / no exposure
      const magnitude = row.position_value ?? 0;
      const point = out.get(row.coin) ?? { longUsd: 0, shortUsd: 0, netUsd: 0, wallets: 0 };
      if (row.szi > 0) point.longUsd += magnitude;
      else point.shortUsd += magnitude;
      point.netUsd = point.longUsd - point.shortUsd;
      out.set(row.coin, point);

      const wset = walletsByCoin.get(row.coin) ?? new Set<string>();
      wset.add(address);
      walletsByCoin.set(row.coin, wset);
    }
  }

  for (const [coin, wset] of walletsByCoin) {
    const point = out.get(coin);
    if (point) point.wallets = wset.size;
  }

  return out;
}

// 30-day retention prune, same cadence as the other time-series tables.
export function pruneWalletPositions(maxAgeMs: number = 30 * 86_400_000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  return db.prepare(`delete from wallet_positions where ts < ?`).run(cutoff).changes;
}
