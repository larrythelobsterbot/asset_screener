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

const VERSION = 3;

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= VERSION) return;

  if (current < 1) db.exec(MIGRATION_V1);
  if (current < 2) db.exec(MIGRATION_V2);
  if (current < 3) db.exec(MIGRATION_V3);
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
// Returns symbol → mark price.
export function snapshotAt(targetTs: number, symbols?: string[]): Map<string, number> {
  const db = getDb();
  // For each symbol, the row with the greatest ts <= targetTs. Window
  // function would be cleaner but better-sqlite3 supports it; using a
  // correlated subquery for portability.
  const rows = (symbols && symbols.length > 0
    ? db.prepare(
        `select p.symbol, p.mark
         from price_snapshots p
         where p.symbol in (${symbols.map(() => "?").join(",")})
         and p.ts = (
           select max(ts) from price_snapshots p2
           where p2.symbol = p.symbol and p2.ts <= ?
         )`
      ).all(...symbols, targetTs)
    : db.prepare(
        `select p.symbol, p.mark
         from price_snapshots p
         where p.ts = (
           select max(ts) from price_snapshots p2
           where p2.symbol = p.symbol and p2.ts <= ?
         )`
      ).all(targetTs)) as Array<{ symbol: string; mark: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.symbol, r.mark);
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

// ── event_history (signal de-bouncer) ───────────────────────────────────

export function loadEventHistory(): Map<string, number> {
  const db = getDb();
  const rows = db.prepare(
    `select symbol, type, last_fired_at from event_history`
  ).all() as Array<{ symbol: string; type: string; last_fired_at: number }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(`${r.symbol}:${r.type}`, r.last_fired_at);
  return m;
}

export function recordEventFire(symbol: string, type: string, firedAt: number): void {
  const db = getDb();
  db.prepare(
    `insert into event_history (symbol, type, last_fired_at)
     values (?, ?, ?)
     on conflict(symbol, type) do update set last_fired_at = excluded.last_fired_at`
  ).run(symbol, type, firedAt);
}

// ── social_snapshots ────────────────────────────────────────────────────

export interface SocialSnapshotRow {
  symbol: string;
  ts: number;
  mention_count: number;
  prev_count: number | null;
  change_pct: number | null;
}

export function insertSocialSnapshots(rows: SocialSnapshotRow[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `insert into social_snapshots (symbol, ts, mention_count, prev_count, change_pct)
     values (@symbol, @ts, @mention_count, @prev_count, @change_pct)
     on conflict(symbol, ts) do update set
       mention_count = excluded.mention_count,
       prev_count = excluded.prev_count,
       change_pct = excluded.change_pct`
  );
  const insertMany = db.transaction((batch: SocialSnapshotRow[]) => {
    for (const r of batch) stmt.run(r);
  });
  insertMany(rows);
}

// Latest snapshot per symbol. Same pattern as latestSnapshots() for prices.
// Symbols passed in are UPPERCASE; we match on what's stored.
export function latestSocialSnapshots(symbols?: string[]): Map<string, SocialSnapshotRow> {
  const db = getDb();
  const rows = (symbols && symbols.length > 0
    ? db.prepare(
        `select symbol, ts, mention_count, prev_count, change_pct
         from social_snapshots
         where symbol in (${symbols.map(() => "?").join(",")})
         and ts = (select max(ts) from social_snapshots p2 where p2.symbol = social_snapshots.symbol)`
      ).all(...symbols)
    : db.prepare(
        `select p.symbol, p.ts, p.mention_count, p.prev_count, p.change_pct
         from social_snapshots p
         join (select symbol, max(ts) as max_ts from social_snapshots group by symbol) latest
           on p.symbol = latest.symbol and p.ts = latest.max_ts`
      ).all()) as SocialSnapshotRow[];
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
      if (sp > 0 || cp > 0 || ss > 0 || hp > 0) {
        console.info(
          `[db] pruned ${sp} price, ${cp} candle, ${ss} social, ${hp} hype-pressure snapshots`
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
