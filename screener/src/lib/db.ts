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

const VERSION = 8;

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

// Wrapper around snapshotAt that drops rows where the matched ts is more
// than `maxAgeMs` away from `targetTs`. This is what callers should use
// when they want "the price at horizon N ago" — without this guard, a
// gap in snapshots can hand back a row from much earlier and produce
// nonsense % changes downstream.
//
// `maxAgeMs` is symmetric around the target: a 1h-ago target with
// 30min tolerance accepts rows from 30-90min ago. Defaults to half the
// distance from now to target, capped at 30 minutes.
export function snapshotAtBounded(
  targetTs: number,
  maxAgeMs: number,
  symbols?: string[],
): Map<string, number> {
  const rows = snapshotAt(targetTs, symbols);
  const out = new Map<string, number>();
  for (const [sym, row] of rows) {
    if (Math.abs(targetTs - row.ts) <= maxAgeMs) {
      out.set(sym, row.mark);
    }
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
      if (sp > 0 || cp > 0 || ss > 0 || hp > 0 || bb > 0 || fe > 0) {
        console.info(
          `[db] pruned ${sp} price, ${cp} candle, ${ss} social, ${hp} hype-pressure, ${bb} btc-binary, ${fe} feed snapshots`
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
