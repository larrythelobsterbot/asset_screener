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

const VERSION = 25;

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current >= VERSION) return;

  db.transaction(() => {
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
    if (current < 13) db.exec(MIGRATION_V13);
    if (current < 14) {
      const columns = db.pragma("table_info(telegram_alerts)") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "delivery_uncertain")) db.exec(MIGRATION_V14);
      db.exec(MIGRATION_V14_BACKFILL);
    }
    if (current < 15) db.exec(MIGRATION_V15);
    if (current < 16) db.exec(MIGRATION_V16);
    if (current < 17) db.exec(MIGRATION_V17);
    if (current < 18) db.exec(MIGRATION_V18);
    if (current < 19) db.exec(MIGRATION_V19);
    if (current < 20) db.exec(MIGRATION_V20);
    if (current < 21) db.exec(MIGRATION_V21);
    if (current < 22) db.exec(MIGRATION_V22);
    if (current < 23) db.exec(MIGRATION_V23);
    if (current < 24) db.exec(MIGRATION_V24);
    if (current < 25) db.exec(MIGRATION_V25);
    db.pragma(`user_version = ${VERSION}`);
  })();
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

// V13 — append-only Telegram alert delivery and outcome ledger. This is
// deliberately separate from event_history and trades: every send attempt
// is durable, while terminal outcome updates are guarded and idempotent.
const MIGRATION_V13 = `
    create table if not exists telegram_alerts (
      id                  integer primary key autoincrement,
      created_at          integer not null,
      delivery_status     text not null check (delivery_status in ('pending', 'delivered', 'failed')),
      delivered_at        integer,
      delivery_error      text,
      telegram_message_id text,
      symbol              text not null,
      sector              text,
      direction           text not null check (direction in ('long', 'short')),
      entry_price         real,
      stop_price          real,
      target_price        real,
      size                real,
      risk_usd            real,
      conviction_score    real,
      conviction_json     text,
      signal_json         text,
      family_json         text,
      expires_at          integer not null,
      outcome_status      text not null default 'open' check (outcome_status in ('open', 'target', 'stop', 'expired', 'ambiguous', 'untrackable')),
      outcome_at          integer,
      outcome_price       real,
      pnl_r               real,
      evaluated_through   integer,
      outcome_note        text,
      outcome_provenance  text
    );
    create index if not exists idx_telegram_alerts_delivery
      on telegram_alerts(delivery_status, created_at desc);
    create index if not exists idx_telegram_alerts_outcome
      on telegram_alerts(outcome_status, expires_at, created_at desc);
    create index if not exists idx_telegram_alerts_symbol_created
      on telegram_alerts(symbol, created_at desc);
    create unique index if not exists uq_telegram_alerts_message_id
      on telegram_alerts(telegram_message_id) where telegram_message_id is not null;
  `;

// V14 — preserve the difference between a definite Telegram rejection and
// an acknowledgement whose result is unknowable after a timeout/crash.
const MIGRATION_V14 = `
    alter table telegram_alerts
      add column delivery_uncertain integer not null default 0
      check (delivery_uncertain in (0, 1));
  `;

const MIGRATION_V14_BACKFILL = `
    update telegram_alerts
      set expires_at = delivered_at + ${48 * 60 * 60 * 1_000}
      where delivery_status = 'delivered' and delivered_at is not null
        and outcome_status = 'open';
  `;

const MIGRATION_V15 = `
    create table if not exists signal_states (
      symbol      text not null,
      type        text not null,
      timeframe   text not null,
      active      integer not null check (active in (0, 1)),
      direction   text check (direction in ('bullish', 'bearish')),
      value       real,
      updated_at  integer not null,
      primary key (symbol, type, timeframe)
    );
  `;

const MIGRATION_V16 = `
    create table if not exists alert_candidates (
      id                  integer primary key autoincrement,
      evaluated_at        integer not null,
      decision_candle_at  integer,
      strategy_version    text not null,
      symbol              text not null,
      direction           text not null check (direction in ('long', 'short')),
      conviction_score    real not null,
      vol_regime          text not null,
      decision            text not null check (decision in ('rejected', 'suppressed', 'eligible')),
      decision_reason     text not null,
      conviction_json     text not null,
      signal_json         text not null,
      family_json         text not null,
      feature_json        text not null,
      telegram_attempted  integer not null default 0 check (telegram_attempted in (0, 1))
    );
    create unique index if not exists uq_alert_candidates_scan
      on alert_candidates(strategy_version, evaluated_at, symbol, direction);
    create index if not exists idx_alert_candidates_version_time
      on alert_candidates(strategy_version, evaluated_at desc);
    create index if not exists idx_alert_candidates_decision_time
      on alert_candidates(decision, decision_reason, evaluated_at desc);
  `;

const MIGRATION_V17 = `
    create index if not exists idx_alert_candidates_symbol_evaluated
      on alert_candidates(symbol, evaluated_at desc);
    create index if not exists idx_alert_candidates_version_symbol_evaluated
      on alert_candidates(strategy_version, symbol, evaluated_at desc);
  `;

const MIGRATION_V18 = `
    alter table alert_candidates add column shadow_policy_json text;
  `;

const MIGRATION_V19 = `
    create table if not exists telegram_alert_counterfactuals (
      id                  integer primary key autoincrement,
      alert_id            integer not null references telegram_alerts(id),
      policy_version      text not null,
      target_r            real not null,
      target_price        real,
      expires_at          integer not null,
      outcome_status      text not null check (outcome_status in ('open', 'target', 'stop', 'expired', 'ambiguous', 'untrackable')),
      outcome_at          integer,
      outcome_price       real,
      pnl_r               real,
      evaluated_through   integer,
      outcome_note        text,
      outcome_provenance  text,
      created_at          integer not null,
      updated_at          integer not null,
      unique(alert_id, policy_version)
    );
    create index if not exists idx_alert_counterfactuals_status_expiry
      on telegram_alert_counterfactuals(policy_version, outcome_status, expires_at);
  `;

const MIGRATION_V20 = `
    alter table telegram_alerts add column candidate_id integer references alert_candidates(id);
    create index if not exists idx_telegram_alerts_candidate
      on telegram_alerts(candidate_id) where candidate_id is not null;
  `;

const MIGRATION_V21 = `
    alter table telegram_alerts add column candidate_attribution text not null default 'legacy'
      check (candidate_attribution in ('legacy', 'linked', 'failed'));
    create index if not exists idx_telegram_alerts_candidate_attribution
      on telegram_alerts(candidate_attribution, delivery_status, created_at);
  `;

const MIGRATION_V22 = `
    create unique index if not exists uq_telegram_alerts_candidate
      on telegram_alerts(candidate_id) where candidate_id is not null;
  `;

// V23 — durable market-open OI positioning briefings. Reports and their
// immutable inputs are separate from trade alerts so descriptive positioning
// analytics can never contaminate directional trade-card outcomes.
const MIGRATION_V23 = `
    create table if not exists market_open_oi_reports (
      id                    integer primary key autoincrement,
      report_key            text not null unique,
      region                text not null check (region in ('asia', 'europe', 'us')),
      local_date            text not null,
      report_at             integer not null,
      open_at               integer not null,
      generated_at          integer not null,
      lookback_ms           integer not null check (lookback_ms > 0),
      calendar_covered      integer not null check (calendar_covered in (0, 1)),
      selection_config_json text not null,
      message_body          text not null check (length(message_body) between 1 and 4096),
      delivery_status       text not null default 'pending'
        check (delivery_status in ('shadow', 'pending', 'delivered', 'failed', 'unknown', 'expired')),
      delivery_attempted_at integer,
      delivered_at          integer,
      delivery_error        text,
      telegram_message_id   text,
      created_at            integer not null,
      updated_at            integer not null,
      check (
        (delivery_status = 'pending' and delivered_at is null and delivery_error is null and telegram_message_id is null)
        or (delivery_status = 'shadow' and delivery_attempted_at is null and delivered_at is null and delivery_error is null and telegram_message_id is null)
        or (delivery_status = 'delivered' and delivery_attempted_at is not null and delivered_at is not null and delivery_error is null and telegram_message_id is not null)
        or (delivery_status in ('failed', 'unknown') and delivery_attempted_at is not null and delivered_at is null and delivery_error is not null and telegram_message_id is null)
        or (delivery_status = 'expired' and delivery_attempted_at is null and delivered_at is null and delivery_error is not null and telegram_message_id is null)
      )
    );
    create unique index if not exists uq_market_open_oi_message_id
      on market_open_oi_reports(telegram_message_id) where telegram_message_id is not null;
    create index if not exists idx_market_open_oi_reports_delivery
      on market_open_oi_reports(delivery_status, generated_at desc);
    create index if not exists idx_market_open_oi_reports_open
      on market_open_oi_reports(open_at desc);

    create table if not exists market_open_oi_items (
      id                       integer primary key autoincrement,
      report_id                integer not null references market_open_oi_reports(id) on delete cascade,
      rank                     integer not null check (rank > 0),
      symbol                   text not null,
      sector                   text not null,
      universe                 text not null check (universe in ('crypto', 'equity')),
      current_ts               integer not null,
      prior_ts                 integer not null,
      current_mark             real not null check (current_mark > 0),
      prior_mark               real not null check (prior_mark > 0),
      current_oi_coins         real not null check (current_oi_coins >= 0),
      prior_oi_coins           real not null check (prior_oi_coins > 0),
      current_oi_usd           real not null check (current_oi_usd >= 0),
      prior_oi_usd             real not null check (prior_oi_usd > 0),
      oi_quantity_delta_usd    real not null,
      oi_usd_delta             real not null,
      oi_coins_change_pct      real not null,
      price_change_pct         real not null,
      funding_hourly           real,
      funding_apr              real,
      volume_24h               real not null check (volume_24h >= 0),
      quadrant                 text not null check (quadrant in (
        'expanding_up', 'expanding_down', 'contracting_up', 'contracting_down',
        'expanding_flat', 'contracting_flat'
      )),
      smart_flow_delta_usd     real,
      smart_flow_alignment     text not null check (smart_flow_alignment in (
        'aligned', 'opposed', 'not_directional', 'unknown'
      )),
      unique(report_id, universe, rank),
      unique(report_id, symbol)
    );
    create index if not exists idx_market_open_oi_items_report
      on market_open_oi_items(report_id, universe, rank);
    create index if not exists idx_market_open_oi_items_symbol
      on market_open_oi_items(symbol, report_id desc);

    create table if not exists market_open_oi_outcomes (
      item_id         integer not null references market_open_oi_items(id) on delete cascade,
      horizon         text not null check (horizon in ('open', '1h', '4h', '24h')),
      target_at       integer not null,
      status          text not null check (status in ('observed', 'missing', 'untrackable')),
      snapshot_at     integer,
      mark            real,
      return_pct      real,
      observed_at     integer not null,
      note            text,
      primary key (item_id, horizon),
      check (
        (status = 'observed' and snapshot_at is not null and mark is not null and mark > 0)
        or (status in ('missing', 'untrackable') and snapshot_at is null and mark is null and return_pct is null)
      )
    );
    create index if not exists idx_market_open_oi_outcomes_target
      on market_open_oi_outcomes(horizon, target_at);
  `;

// V24 — shadow-only Hyperliquid smart-money pilot. Every published claim can
// be traced to an immutable collection run and normalized source snapshots.
// Review and delivery are separate: collectors can only create shadow drafts,
// and a delivery queue cannot be entered until a human marks the item approved.
const MIGRATION_V24 = `
    create table if not exists smart_money_cohort_versions (
      id                 integer primary key autoincrement,
      version_key        text not null unique,
      policy_version     text not null,
      computed_at        integer not null,
      candidate_count    integer not null check (candidate_count >= 0),
      eligible_count     integer not null check (eligible_count >= 0),
      member_count       integer not null check (member_count >= 0),
      source_url         text not null,
      source_sha256      text not null check (length(source_sha256) = 64),
      evidence_json      text not null check (json_valid(evidence_json))
    );

    create table if not exists smart_money_collection_runs (
      id                 integer primary key autoincrement,
      run_key            text not null unique,
      run_kind           text not null default 'collection' check (run_kind in ('cohort', 'collection')),
      scheduled_for      integer not null,
      started_at         integer not null,
      completed_at       integer,
      status             text not null check (status in ('running', 'complete', 'partial', 'failed')),
      cohort_version_id  integer references smart_money_cohort_versions(id),
      wallet_expected    integer not null default 0 check (wallet_expected >= 0),
      wallet_succeeded   integer not null default 0 check (wallet_succeeded >= 0),
      vault_expected     integer not null default 0 check (vault_expected >= 0),
      vault_succeeded    integer not null default 0 check (vault_succeeded >= 0),
      source_manifest_json text not null check (json_valid(source_manifest_json)),
      error              text,
      created_at         integer not null,
      updated_at         integer not null,
      check ((status = 'running' and completed_at is null) or (status != 'running' and completed_at is not null))
    );
    create index if not exists idx_smart_money_runs_status
      on smart_money_collection_runs(status, scheduled_for desc);

    create table if not exists smart_money_cohort_members (
      cohort_version_id  integer not null references smart_money_cohort_versions(id) on delete cascade,
      address            text not null,
      is_member          integer not null check (is_member in (0, 1)),
      membership_change  text not null check (membership_change in ('entry', 'stay', 'exit', 'ineligible')),
      score              real,
      suspected_gaming   integer not null check (suspected_gaming in (0, 1)),
      exclusion_reasons_json text not null check (json_valid(exclusion_reasons_json)),
      evidence_json      text not null check (json_valid(evidence_json)),
      primary key (cohort_version_id, address)
    );
    create index if not exists idx_smart_money_members_active
      on smart_money_cohort_members(cohort_version_id, is_member, score desc);

    create table if not exists smart_money_wallet_performance (
      collection_run_id  integer not null references smart_money_collection_runs(id) on delete cascade,
      cohort_version_id  integer not null references smart_money_cohort_versions(id),
      address            text not null,
      observed_at        integer not null,
      track_start_at     integer not null,
      account_value      real not null check (account_value >= 0),
      pnl_7d             real not null,
      pnl_30d            real not null,
      pnl_90d            real not null,
      roi_30d            real not null,
      volume_30d         real not null check (volume_30d >= 0),
      source_url         text not null,
      primary key (collection_run_id, address)
    );
    create index if not exists idx_smart_money_perf_address
      on smart_money_wallet_performance(address, observed_at desc);

    -- Wallet heartbeat rows make flat wallets explicit. Position absence in the
    -- child table therefore means flat only when the heartbeat succeeded.
    create table if not exists smart_money_wallet_snapshots (
      collection_run_id  integer not null references smart_money_collection_runs(id) on delete cascade,
      address            text not null,
      observed_at        integer not null,
      account_value      real check (account_value >= 0),
      status             text not null check (status in ('complete', 'failed')),
      source_url         text not null,
      error              text,
      primary key (collection_run_id, address),
      check ((status = 'complete' and account_value is not null and error is null)
        or (status = 'failed' and account_value is null and error is not null))
    );
    create index if not exists idx_smart_money_wallet_snapshots_address
      on smart_money_wallet_snapshots(address, observed_at desc);

    create table if not exists smart_money_wallet_positions (
      collection_run_id  integer not null,
      address            text not null,
      coin               text not null,
      szi                real not null,
      position_value     real not null check (position_value >= 0),
      entry_px           real,
      unrealized_pnl     real,
      leverage           real,
      primary key (collection_run_id, address, coin),
      foreign key (collection_run_id, address)
        references smart_money_wallet_snapshots(collection_run_id, address) on delete cascade
    );
    create index if not exists idx_smart_money_positions_coin
      on smart_money_wallet_positions(coin, collection_run_id);

    create table if not exists smart_money_vault_snapshots (
      collection_run_id  integer not null references smart_money_collection_runs(id) on delete cascade,
      vault_address      text not null,
      observed_at        integer not null,
      name               text not null,
      leader_address     text,
      relationship_type  text not null check (relationship_type in ('normal', 'parent', 'child')),
      tvl                real not null check (tvl >= 0),
      apr                real,
      cumulative_pnl     real not null,
      follower_count     integer check (follower_count is null or follower_count >= 0),
      is_closed          integer not null check (is_closed in (0, 1)),
      verification_url   text not null,
      primary key (collection_run_id, vault_address)
    );
    create index if not exists idx_smart_money_vault_address
      on smart_money_vault_snapshots(vault_address, observed_at desc);

    create table if not exists smart_money_events (
      id                 integer primary key autoincrement,
      fingerprint        text not null unique,
      collection_run_id  integer not null references smart_money_collection_runs(id),
      event_type         text not null check (event_type in (
        'cohort_net_flip', 'unusual_position_change',
        'coordinated_position_change', 'vault_flow_anomaly'
      )),
      observed_at        integer not null,
      symbol             text,
      address            text,
      vault_address      text,
      evidence_json      text not null check (json_valid(evidence_json)),
      verification_urls_json text not null check (json_valid(verification_urls_json)),
      draft_text         text not null check (length(draft_text) between 1 and 4096),
      review_status      text not null default 'draft'
        check (review_status in ('draft', 'approved', 'rejected', 'expired')),
      delivery_status    text not null default 'shadow'
        check (delivery_status in ('shadow', 'pending', 'delivered', 'failed', 'unknown')),
      created_at         integer not null,
      updated_at         integer not null,
      check (delivery_status = 'shadow' or review_status = 'approved')
    );
    create index if not exists idx_smart_money_events_review
      on smart_money_events(review_status, delivery_status, observed_at desc);

    create table if not exists smart_money_event_outcomes (
      event_id           integer not null references smart_money_events(id) on delete cascade,
      horizon_hours      integer not null check (horizon_hours > 0),
      target_at          integer not null,
      status             text not null check (status in ('observed', 'missing', 'untrackable')),
      entry_mark         real,
      outcome_mark       real,
      return_pct         real,
      observed_at        integer not null,
      note               text,
      primary key (event_id, horizon_hours),
      check ((status = 'observed' and entry_mark > 0 and outcome_mark > 0 and return_pct is not null)
        or (status in ('missing', 'untrackable') and entry_mark is null and outcome_mark is null and return_pct is null))
    );

    create table if not exists smart_money_daily_digests (
      id                 integer primary key autoincrement,
      digest_key         text not null unique,
      period_date        text not null,
      generated_at       integer not null,
      cohort_version_id  integer not null references smart_money_cohort_versions(id),
      markdown_body      text not null,
      chart_path         text not null,
      evidence_json      text not null check (json_valid(evidence_json)),
      review_status      text not null default 'draft'
        check (review_status in ('draft', 'approved', 'rejected', 'expired'))
    );

    create table if not exists smart_money_weekly_reports (
      id                 integer primary key autoincrement,
      report_key         text not null unique,
      week_start         text not null,
      week_end           text not null,
      generated_at       integer not null,
      markdown_body      text not null,
      evidence_json      text not null check (json_valid(evidence_json)),
      review_status      text not null default 'draft'
        check (review_status in ('draft', 'approved', 'rejected', 'expired'))
    );
  `;

// V25 — separately paced, shadow-only Hyperliquid userFunding evidence.
// Funding completeness is independent from wallet/vault collection, and the
// durable payment identity does not rely on Hyperliquid's sometimes-zero hash.
const MIGRATION_V25 = `
    create table if not exists smart_money_funding_runs (
      id                    integer primary key autoincrement,
      run_key               text not null unique,
      collection_run_id     integer not null references smart_money_collection_runs(id),
      policy_version        text not null,
      attempt_no            integer not null check (attempt_no >= 1),
      start_at              integer not null,
      end_at                integer not null,
      started_at            integer not null,
      completed_at          integer,
      status                text not null check (status in ('running', 'complete', 'partial', 'failed', 'invalid')),
      wallet_expected       integer not null check (wallet_expected >= 0),
      wallet_succeeded      integer not null default 0 check (wallet_succeeded >= 0),
      window_count          integer not null default 0 check (window_count >= 0),
      payment_count         integer not null default 0 check (payment_count >= 0),
      source_manifest_json  text not null check (json_valid(source_manifest_json)),
      error                 text,
      created_at            integer not null,
      updated_at            integer not null,
      unique (collection_run_id, policy_version, attempt_no),
      check (end_at >= start_at),
      check (wallet_succeeded <= wallet_expected),
      check ((status = 'running' and completed_at is null)
        or (status != 'running' and completed_at is not null)),
      check ((status = 'complete' and wallet_succeeded = wallet_expected and error is null)
        or status != 'complete')
    );
    create index if not exists idx_smart_money_funding_runs_status
      on smart_money_funding_runs(status, end_at desc);

    create table if not exists smart_money_funding_windows (
      funding_run_id        integer not null references smart_money_funding_runs(id) on delete cascade,
      address               text not null,
      start_at              integer not null,
      end_at                integer not null,
      status                text not null check (status in ('complete', 'saturated')),
      response_count        integer not null check (response_count >= 0 and response_count <= 500),
      source_sha256         text not null check (length(source_sha256) = 64),
      source_bytes          integer not null check (source_bytes >= 2),
      source_archive_path   text not null check (length(source_archive_path) > 0),
      primary key (funding_run_id, address, start_at, end_at),
      check (end_at >= start_at)
    );
    create index if not exists idx_smart_money_funding_windows_address
      on smart_money_funding_windows(address, end_at desc);

    create table if not exists smart_money_funding_payments (
      address               text not null,
      settlement_at         integer not null,
      coin                  text not null check (length(coin) between 1 and 128),
      usdc                  real not null,
      szi                   real not null,
      funding_rate          real not null,
      n_samples             integer check (n_samples is null or n_samples >= 0),
      source_hash           text not null check (length(source_hash) = 66),
      first_funding_run_id  integer not null references smart_money_funding_runs(id),
      source_url            text not null,
      created_at            integer not null,
      primary key (address, settlement_at, coin)
    );
    create index if not exists idx_smart_money_funding_payments_time
      on smart_money_funding_payments(settlement_at desc);
    create index if not exists idx_smart_money_funding_payments_coin
      on smart_money_funding_payments(coin, settlement_at desc);

    create table if not exists smart_money_funding_run_payments (
      funding_run_id        integer not null references smart_money_funding_runs(id) on delete cascade,
      address               text not null,
      settlement_at         integer not null,
      coin                  text not null,
      primary key (funding_run_id, address, settlement_at, coin),
      foreign key (address, settlement_at, coin)
        references smart_money_funding_payments(address, settlement_at, coin)
    );
    create index if not exists idx_smart_money_funding_run_payments_identity
      on smart_money_funding_run_payments(address, settlement_at, coin, funding_run_id);
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
  volume: number | null;
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
    `select mark, oi, funding, volume, ts from price_snapshots
      where symbol = ? and ts <= ? and ts >= ?
      order by ts desc limit 1`
  );
  for (const sym of list) {
    const row = stmt.get(sym, targetTs, targetTs - maxAgeMs) as
      | SnapshotPointFull
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

export interface PriceObservationRow {
  ts: number;
  mark: number;
}

// Bounded indexed evidence read for alert outcome evaluation. Callers pass
// one symbol and a narrow time window; never scan the snapshot table whole.
export function priceSnapshotsInRange(
  symbol: string,
  fromTs: number,
  toTs: number,
  limit = 5_000,
): PriceObservationRow[] {
  return getDb().prepare(`
    select ts, mark from price_snapshots
    where symbol = ? and ts >= ? and ts <= ?
    order by ts asc limit ?
  `).all(symbol, fromTs, toTs, Math.max(1, Math.min(limit, 10_000))) as PriceObservationRow[];
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

export function candlesInRange(
  symbol: string,
  interval: string,
  fromTs: number,
  toTs: number,
  limit = 1_000,
): CandleRow[] {
  return getDb().prepare(`
    select symbol, interval, t, o, h, l, c, v
    from candles_cache
    where symbol = ? and interval = ? and t >= ? and t <= ?
    order by t asc limit ?
  `).all(symbol, interval, fromTs, toTs, Math.max(1, Math.min(limit, 5_000))) as CandleRow[];
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

export interface SignalStateRow {
  symbol: string;
  type: string;
  timeframe: string;
  active: 0 | 1;
  direction: "bullish" | "bearish" | null;
  value: number | null;
  updated_at: number;
}

export function signalStateKey(symbol: string, type: string, timeframe?: string | null): string {
  return `${symbol}:${type}:${timeframe ?? "_"}`;
}

export function loadSignalStates(): Map<string, SignalStateRow> {
  const rows = getDb().prepare(
    `select symbol, type, timeframe, active, direction, value, updated_at from signal_states`,
  ).all() as SignalStateRow[];
  return new Map(rows.map((row) => [signalStateKey(row.symbol, row.type, row.timeframe), row]));
}

export function upsertSignalState(row: SignalStateRow): void {
  getDb().prepare(
    `insert into signal_states (symbol, type, timeframe, active, direction, value, updated_at)
     values (@symbol, @type, @timeframe, @active, @direction, @value, @updated_at)
     on conflict(symbol, type, timeframe) do update set
       active = excluded.active,
       direction = excluded.direction,
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(row);
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
      const ac = pruneAlertCandidates();
      if (sp > 0 || cp > 0 || ss > 0 || hp > 0 || bb > 0 || fe > 0 || dv > 0 || wp > 0 || ac > 0) {
        console.info(
          `[db] pruned ${sp} price, ${cp} candle, ${ss} social, ${hp} hype-pressure, ${bb} btc-binary, ${fe} feed, ${dv} derivs, ${wp} wallet-position snapshots, ${ac} alert candidates`
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

export function latestSocialSnapshotTs(): number | null {
  const db = getDb();
  const r = db.prepare(`select max(ts) ts from social_snapshots`).get() as { ts: number | null };
  return r?.ts ?? null;
}

export function latestWalletPositionTs(): number | null {
  const db = getDb();
  const r = db.prepare(`select max(ts) ts from wallet_positions`).get() as { ts: number | null };
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
export interface SmartFlowSnapshot {
  points: Map<string, SmartFlowPoint>;
  requestedWallets: number;
  observedWallets: number;
  complete: boolean;
}

export function smartFlowSnapshotAt(
  targetTs: number,
  maxAgeMs: number,
  addresses?: string[],
): SmartFlowSnapshot {
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
  let observedWallets = 0;
  for (const address of walletList) {
    const latest = latestTsStmt.get(address, targetTs, targetTs - maxAgeMs) as
      | { ts: number }
      | undefined;
    if (!latest) continue; // no row for this wallet in the window
    observedWallets += 1; // a flat-wallet heartbeat is complete evidence too

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

  return {
    points: out,
    requestedWallets: walletList.length,
    observedWallets,
    complete: walletList.length > 0 && observedWallets === walletList.length,
  };
}

export function smartFlowAt(
  targetTs: number,
  maxAgeMs: number,
  addresses?: string[],
): Map<string, SmartFlowPoint> {
  return smartFlowSnapshotAt(targetTs, maxAgeMs, addresses).points;
}

// 30-day retention prune, same cadence as the other time-series tables.
export function pruneWalletPositions(maxAgeMs: number = 30 * 86_400_000): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  return db.prepare(`delete from wallet_positions where ts < ?`).run(cutoff).changes;
}

export type AlertCandidateDecision = "rejected" | "suppressed" | "eligible";

export interface AlertCandidateRow {
  id: number;
  evaluated_at: number;
  decision_candle_at: number | null;
  strategy_version: string;
  symbol: string;
  direction: "long" | "short";
  conviction_score: number;
  vol_regime: string;
  decision: AlertCandidateDecision;
  decision_reason: string;
  conviction_json: string;
  signal_json: string;
  family_json: string;
  feature_json: string;
  shadow_policy_json: string | null;
  telegram_attempted: 0 | 1;
}

export type NewAlertCandidate = Omit<AlertCandidateRow, "id" | "shadow_policy_json"> & {
  shadow_policy_json?: string | null;
};

export function insertAlertCandidate(row: NewAlertCandidate): number {
  const db = getDb();
  const result = db.prepare(`
    insert into alert_candidates (
      evaluated_at, decision_candle_at, strategy_version, symbol, direction,
      conviction_score, vol_regime, decision, decision_reason,
      conviction_json, signal_json, family_json, feature_json, shadow_policy_json, telegram_attempted
    ) values (
      @evaluated_at, @decision_candle_at, @strategy_version, @symbol, @direction,
      @conviction_score, @vol_regime, @decision, @decision_reason,
      @conviction_json, @signal_json, @family_json, @feature_json, @shadow_policy_json, @telegram_attempted
    )
    on conflict(strategy_version, evaluated_at, symbol, direction) do update set
      decision_candle_at = excluded.decision_candle_at,
      conviction_score = excluded.conviction_score,
      vol_regime = excluded.vol_regime,
      decision = excluded.decision,
      decision_reason = excluded.decision_reason,
      conviction_json = excluded.conviction_json,
      signal_json = excluded.signal_json,
      family_json = excluded.family_json,
      feature_json = excluded.feature_json,
      shadow_policy_json = excluded.shadow_policy_json,
      telegram_attempted = max(alert_candidates.telegram_attempted, excluded.telegram_attempted)
    returning id
  `).get({ ...row, shadow_policy_json: row.shadow_policy_json ?? null }) as { id: number };
  return result.id;
}

export function markAlertCandidateTelegramAttempted(id: number): boolean {
  return getDb().prepare(`
    update alert_candidates
    set telegram_attempted = 1
    where id = ? and telegram_attempted = 0
  `).run(id).changes === 1;
}

export function pruneAlertCandidates(maxAgeMs: number = 90 * 86_400_000): number {
  const cutoff = Date.now() - maxAgeMs;
  return getDb().prepare(`delete from alert_candidates where evaluated_at < ?`).run(cutoff).changes;
}

export function listAlertCandidates(options: {
  symbol?: string;
  strategy_version?: string;
  decision?: AlertCandidateDecision;
  from?: number;
  limit?: number;
} = {}): AlertCandidateRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.symbol) { clauses.push("symbol = ?"); params.push(options.symbol); }
  if (options.strategy_version) { clauses.push("strategy_version = ?"); params.push(options.strategy_version); }
  if (options.decision) { clauses.push("decision = ?"); params.push(options.decision); }
  if (options.from !== undefined) { clauses.push("evaluated_at >= ?"); params.push(options.from); }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const limit = Math.max(1, Math.min(options.limit ?? 100, 5_000));
  return getDb().prepare(
    `select * from alert_candidates ${where} order by evaluated_at desc, id desc limit ?`,
  ).all(...params, limit) as AlertCandidateRow[];
}

// ── telegram_alerts (durable delivery/outcome ledger, v13) ──────────────

export type TelegramDeliveryStatus = "pending" | "delivered" | "failed";
export type TelegramOutcomeStatus = "open" | "target" | "stop" | "expired" | "ambiguous" | "untrackable";
export type TelegramCandidateAttribution = "legacy" | "linked" | "failed";

export interface TelegramAlertRow {
  id: number;
  created_at: number;
  delivery_status: TelegramDeliveryStatus;
  delivered_at: number | null;
  delivery_error: string | null;
  delivery_uncertain: 0 | 1;
  telegram_message_id: string | null;
  symbol: string;
  sector: string | null;
  direction: "long" | "short";
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  size: number | null;
  risk_usd: number | null;
  conviction_score: number | null;
  conviction_json: string | null;
  signal_json: string | null;
  family_json: string | null;
  expires_at: number;
  outcome_status: TelegramOutcomeStatus;
  outcome_at: number | null;
  outcome_price: number | null;
  pnl_r: number | null;
  evaluated_through: number | null;
  outcome_note: string | null;
  outcome_provenance: string | null;
  candidate_id?: number | null;
  candidate_attribution?: TelegramCandidateAttribution;
}

export type NewTelegramAlert = Omit<TelegramAlertRow,
  "id" | "delivered_at" | "delivery_uncertain"> & { delivered_at?: number | null };

export interface TelegramOutcomeUpdate {
  outcome_status: Exclude<TelegramOutcomeStatus, "open">;
  outcome_at: number;
  outcome_price: number | null;
  pnl_r: number | null;
  evaluated_through: number;
  outcome_note: string | null;
  outcome_provenance: string;
}

function validateNewTelegramAlert(row: NewTelegramAlert): void {
  const candidateAttribution = row.candidate_attribution
    ?? (row.candidate_id != null ? "linked" : "legacy");
  if (candidateAttribution === "linked" && row.candidate_id == null) {
    throw new Error("Linked Telegram alert requires candidate_id");
  }
  if (candidateAttribution !== "linked" && row.candidate_id != null) {
    throw new Error(`${candidateAttribution} Telegram attribution cannot have candidate_id`);
  }
  const deliveredAt = row.delivered_at ?? null;
  if (row.delivery_status === "delivered") {
    if (deliveredAt === null) throw new Error("Delivered Telegram alert requires delivered_at");
    if (!row.telegram_message_id) throw new Error("Delivered Telegram alert requires telegram_message_id");
    if (row.delivery_error !== null) throw new Error("Delivered Telegram alert cannot have delivery_error");
    return;
  }

  if (deliveredAt !== null) throw new Error(`${row.delivery_status} Telegram alert cannot have delivered_at`);
  if (row.delivery_status === "pending") {
    if (row.telegram_message_id !== null || row.delivery_error !== null || row.outcome_status !== "open") {
      throw new Error("Pending Telegram alert must have an open, unacknowledged delivery state");
    }
    return;
  }

  if (row.telegram_message_id !== null || row.outcome_status !== "untrackable") {
    throw new Error("Failed Telegram alert must be untrackable and have no message id");
  }
}

export function insertTelegramAlert(row: NewTelegramAlert): number {
  validateNewTelegramAlert(row);
  const db = getDb();
  const result = db.prepare(`
    insert into telegram_alerts (
      created_at, delivery_status, delivered_at, delivery_error, telegram_message_id,
      symbol, sector, direction, entry_price, stop_price, target_price, size, risk_usd,
      conviction_score, conviction_json, signal_json, family_json, expires_at,
      outcome_status, outcome_at, outcome_price, pnl_r, evaluated_through, outcome_note, outcome_provenance,
      candidate_id, candidate_attribution
    ) values (
      @created_at, @delivery_status, @delivered_at, @delivery_error, @telegram_message_id,
      @symbol, @sector, @direction, @entry_price, @stop_price, @target_price, @size, @risk_usd,
      @conviction_score, @conviction_json, @signal_json, @family_json, @expires_at,
      @outcome_status, @outcome_at, @outcome_price, @pnl_r, @evaluated_through, @outcome_note, @outcome_provenance,
      @candidate_id, @candidate_attribution
    )`).run({
      ...row,
      delivered_at: row.delivered_at ?? null,
      candidate_id: row.candidate_id ?? null,
      candidate_attribution: row.candidate_attribution
        ?? (row.candidate_id != null ? "linked" : "legacy"),
    });
  return Number(result.lastInsertRowid);
}

export type TelegramAlertReservation =
  | { kind: "inserted"; id: number }
  | { kind: "blocked"; reason: "active_thesis" };

export function reserveTelegramAlert(row: NewTelegramAlert): TelegramAlertReservation {
  validateNewTelegramAlert(row);
  const db = getDb();
  const reserve = db.transaction((): TelegramAlertReservation => {
    const active = db.prepare(`
      select 1 from telegram_alerts
      where symbol = ? and direction = ? and (
        delivery_status = 'pending'
        or (delivery_uncertain = 1 and expires_at > ?)
        or (
          delivery_status = 'delivered' and (
            outcome_status = 'open'
            or (outcome_status = 'untrackable' and expires_at > ?)
          )
        )
      )
      limit 1
    `).get(row.symbol, row.direction, row.created_at, row.created_at);
    if (active != null) return { kind: "blocked", reason: "active_thesis" };
    return { kind: "inserted", id: insertTelegramAlert(row) };
  });
  return reserve.immediate();
}

export function markTelegramAlertDelivered(id: number, messageId: string, deliveredAt = Date.now()): boolean {
  const db = getDb();
  return db.transaction(() => db.prepare(`
    update telegram_alerts set delivery_status = 'delivered', delivered_at = ?,
      telegram_message_id = ?, delivery_error = null, delivery_uncertain = 0,
      expires_at = ?
    where id = ? and delivery_status = 'pending'
  `).run(deliveredAt, messageId, deliveredAt + 48 * 60 * 60 * 1_000, id).changes === 1)();
}

export function markTelegramAlertFailed(id: number, error: string, failedAt = Date.now()): boolean {
  const db = getDb();
  return db.transaction(() => db.prepare(`
    update telegram_alerts set delivery_status = 'failed', delivered_at = null, delivery_error = ?, delivery_uncertain = 0,
      outcome_status = 'untrackable', outcome_at = ?, evaluated_through = ?,
      outcome_note = 'Telegram delivery failed', outcome_provenance = 'delivery'
    where id = ? and delivery_status = 'pending'
  `).run(error.slice(0, 1000), failedAt, failedAt, id).changes === 1)();
}

export function markTelegramAlertDeliveryUnknown(id: number, error: string, observedAt = Date.now()): boolean {
  const db = getDb();
  return db.transaction(() => db.prepare(`
    update telegram_alerts set delivery_status = 'failed', delivered_at = null,
      delivery_error = ?, delivery_uncertain = 1,
      outcome_status = 'untrackable', outcome_at = ?, evaluated_through = ?,
      outcome_note = 'Telegram delivery acknowledgement unknown', outcome_provenance = 'delivery'
    where id = ? and delivery_status = 'pending'
  `).run(error.slice(0, 1000), observedAt, observedAt, id).changes === 1)();
}

export function reconcileStalePendingTelegramAlerts(cutoff: number, observedAt = Date.now()): number {
  const db = getDb();
  return db.transaction(() => db.prepare(`
    update telegram_alerts set delivery_status = 'failed', delivered_at = null,
      delivery_error = 'Process ended before Telegram acknowledgement was persisted', delivery_uncertain = 1,
      outcome_status = 'untrackable', outcome_at = ?, evaluated_through = ?,
      outcome_note = 'Telegram delivery acknowledgement unknown after stale pending attempt',
      outcome_provenance = 'delivery_reconciliation'
    where delivery_status = 'pending' and created_at <= ?
  `).run(observedAt, observedAt, cutoff).changes)();
}

export function hasActiveTelegramThesis(
  symbol: string,
  direction: "long" | "short",
  now = Date.now(),
): boolean {
  const row = getDb().prepare(`
    select 1 from telegram_alerts
    where symbol = ? and direction = ? and (
      delivery_status = 'pending'
      or (delivery_uncertain = 1 and expires_at > ?)
      or (
        delivery_status = 'delivered' and (
          outcome_status = 'open'
          or (outcome_status = 'untrackable' and expires_at > ?)
        )
      )
    )
    limit 1
  `).get(symbol, direction, now, now);
  return row != null;
}

export function listOpenTelegramAlerts(now = Date.now(), limit = 500): TelegramAlertRow[] {
  const db = getDb();
  return db.prepare(`
    select * from telegram_alerts
    where delivery_status = 'delivered' and outcome_status = 'open'
      and created_at <= ?
    order by created_at asc limit ?
  `).all(now, Math.max(1, Math.min(limit, 5000))) as TelegramAlertRow[];
}

export function updateTelegramAlertOutcome(id: number, update: TelegramOutcomeUpdate): boolean {
  const db = getDb();
  return db.transaction(() => db.prepare(`
    update telegram_alerts set outcome_status = @outcome_status, outcome_at = @outcome_at,
      outcome_price = @outcome_price, pnl_r = @pnl_r, evaluated_through = @evaluated_through,
      outcome_note = @outcome_note, outcome_provenance = @outcome_provenance
    where id = @id and outcome_status = 'open'
  `).run({ ...update, id }).changes === 1)();
}

export const TARGET_COUNTERFACTUAL_POLICY_VERSION = "target-1_5r-v1";

export interface TargetCounterfactualRow {
  id: number;
  alert_id: number;
  policy_version: string;
  target_r: number;
  target_price: number | null;
  expires_at: number;
  outcome_status: TelegramOutcomeStatus;
  outcome_at: number | null;
  outcome_price: number | null;
  pnl_r: number | null;
  evaluated_through: number | null;
  outcome_note: string | null;
  outcome_provenance: string | null;
  created_at: number;
  updated_at: number;
}

export interface OpenTargetCounterfactualRow extends TargetCounterfactualRow {
  symbol: string;
  direction: "long" | "short";
  entry_price: number;
  stop_price: number;
  delivered_at: number;
}

export type TargetCounterfactualOutcomeUpdate = TelegramOutcomeUpdate;

export function ensureTargetCounterfactuals(now = Date.now()): number {
  const targetR = 1.5;
  return getDb().prepare(`
    insert into telegram_alert_counterfactuals (
      alert_id, policy_version, target_r, target_price, expires_at,
      outcome_status, outcome_at, outcome_price, pnl_r, evaluated_through,
      outcome_note, outcome_provenance, created_at, updated_at
    )
    select
      alert.id,
      @policy_version,
      @target_r,
      case
        when alert.delivered_at is not null
          and alert.entry_price > 0 and alert.stop_price > 0
          and ((alert.direction = 'long' and alert.stop_price < alert.entry_price)
            or (alert.direction = 'short' and alert.stop_price > alert.entry_price))
        then case alert.direction
          when 'long' then alert.entry_price + @target_r * abs(alert.entry_price - alert.stop_price)
          else alert.entry_price - @target_r * abs(alert.entry_price - alert.stop_price)
        end
        else null
      end,
      alert.expires_at,
      case
        when alert.delivered_at is not null
          and alert.entry_price > 0 and alert.stop_price > 0
          and ((alert.direction = 'long' and alert.stop_price < alert.entry_price)
            or (alert.direction = 'short' and alert.stop_price > alert.entry_price))
        then 'open'
        else 'untrackable'
      end,
      case
        when alert.delivered_at is not null
          and alert.entry_price > 0 and alert.stop_price > 0
          and ((alert.direction = 'long' and alert.stop_price < alert.entry_price)
            or (alert.direction = 'short' and alert.stop_price > alert.entry_price))
        then null else @now
      end,
      null,
      null,
      case
        when alert.delivered_at is not null
          and alert.entry_price > 0 and alert.stop_price > 0
          and ((alert.direction = 'long' and alert.stop_price < alert.entry_price)
            or (alert.direction = 'short' and alert.stop_price > alert.entry_price))
        then null else @now
      end,
      case
        when alert.delivered_at is not null
          and alert.entry_price > 0 and alert.stop_price > 0
          and ((alert.direction = 'long' and alert.stop_price < alert.entry_price)
            or (alert.direction = 'short' and alert.stop_price > alert.entry_price))
        then null
        when alert.delivered_at is null then 'Confirmed delivery timestamp unavailable'
        else 'Trade geometry unavailable'
      end,
      case
        when alert.delivered_at is not null
          and alert.entry_price > 0 and alert.stop_price > 0
          and ((alert.direction = 'long' and alert.stop_price < alert.entry_price)
            or (alert.direction = 'short' and alert.stop_price > alert.entry_price))
        then null else 'counterfactual_seed'
      end,
      @now,
      @now
    from telegram_alerts alert
    where alert.delivery_status = 'delivered'
      and alert.delivery_uncertain = 0
      and not exists (
        select 1 from telegram_alert_counterfactuals existing
        where existing.alert_id = alert.id and existing.policy_version = @policy_version
      )
  `).run({
    policy_version: TARGET_COUNTERFACTUAL_POLICY_VERSION,
    target_r: targetR,
    now,
  }).changes;
}

export function listOpenTargetCounterfactuals(now = Date.now(), limit = 500): OpenTargetCounterfactualRow[] {
  return getDb().prepare(`
    select counterfactual.*, alert.symbol, alert.direction, alert.entry_price,
      alert.stop_price, alert.delivered_at
    from telegram_alert_counterfactuals counterfactual
    join telegram_alerts alert on alert.id = counterfactual.alert_id
    where counterfactual.policy_version = ?
      and counterfactual.outcome_status = 'open'
      and alert.delivery_status = 'delivered'
      and alert.delivery_uncertain = 0
      and alert.delivered_at is not null
      and alert.delivered_at <= ?
    order by alert.delivered_at asc
    limit ?
  `).all(
    TARGET_COUNTERFACTUAL_POLICY_VERSION,
    now,
    Math.max(1, Math.min(limit, 5_000)),
  ) as OpenTargetCounterfactualRow[];
}

export function updateTargetCounterfactualOutcome(
  id: number,
  update: TargetCounterfactualOutcomeUpdate,
): boolean {
  return getDb().transaction(() => getDb().prepare(`
    update telegram_alert_counterfactuals
    set outcome_status = @outcome_status,
      outcome_at = @outcome_at,
      outcome_price = @outcome_price,
      pnl_r = @pnl_r,
      evaluated_through = @evaluated_through,
      outcome_note = @outcome_note,
      outcome_provenance = @outcome_provenance,
      updated_at = @updated_at
    where id = @id and outcome_status = 'open'
  `).run({ ...update, id, updated_at: update.evaluated_through }).changes === 1)();
}

export function listTargetCounterfactuals(options: {
  alert_id?: number;
  outcome_status?: TelegramOutcomeStatus;
  limit?: number;
} = {}): TargetCounterfactualRow[] {
  const clauses = ["policy_version = ?"];
  const params: unknown[] = [TARGET_COUNTERFACTUAL_POLICY_VERSION];
  if (options.alert_id !== undefined) { clauses.push("alert_id = ?"); params.push(options.alert_id); }
  if (options.outcome_status) { clauses.push("outcome_status = ?"); params.push(options.outcome_status); }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 5_000));
  return getDb().prepare(`
    select * from telegram_alert_counterfactuals
    where ${clauses.join(" and ")}
    order by id desc limit ?
  `).all(...params, limit) as TargetCounterfactualRow[];
}

export interface ListTelegramAlertsOptions {
  symbol?: string;
  delivery_status?: TelegramDeliveryStatus;
  outcome_status?: TelegramOutcomeStatus;
  from?: number;
  to?: number;
  limit?: number;
}

export function listTelegramAlerts(options: ListTelegramAlertsOptions = {}): TelegramAlertRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.symbol) { clauses.push("symbol = ?"); params.push(options.symbol); }
  if (options.delivery_status) { clauses.push("delivery_status = ?"); params.push(options.delivery_status); }
  if (options.outcome_status) { clauses.push("outcome_status = ?"); params.push(options.outcome_status); }
  if (options.from !== undefined) { clauses.push("created_at >= ?"); params.push(options.from); }
  if (options.to !== undefined) { clauses.push("created_at <= ?"); params.push(options.to); }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 5000));
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  return getDb().prepare(`select * from telegram_alerts ${where} order by created_at desc limit ?`).all(...params, limit) as TelegramAlertRow[];
}

export type TelegramAlertSummary = Record<TelegramOutcomeStatus | TelegramDeliveryStatus, number> & {
  total: number;
  unknown_delivery: number;
};

export function summarizeTelegramAlerts(options: Omit<ListTelegramAlertsOptions, "limit" | "delivery_status" | "outcome_status"> = {}): TelegramAlertSummary {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.symbol) { clauses.push("symbol = ?"); params.push(options.symbol); }
  if (options.from !== undefined) { clauses.push("created_at >= ?"); params.push(options.from); }
  if (options.to !== undefined) { clauses.push("created_at <= ?"); params.push(options.to); }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const rows = getDb().prepare(`
    select delivery_status, outcome_status, delivery_uncertain, count(*) as count
    from telegram_alerts ${where}
    group by delivery_status, outcome_status, delivery_uncertain
  `).all(...params) as Array<{
    delivery_status: TelegramDeliveryStatus;
    outcome_status: TelegramOutcomeStatus;
    delivery_uncertain: 0 | 1;
    count: number;
  }>;
  const summary = {
    total: 0, pending: 0, delivered: 0, failed: 0, unknown_delivery: 0,
    open: 0, target: 0, stop: 0, expired: 0, ambiguous: 0, untrackable: 0,
  } as TelegramAlertSummary;
  for (const row of rows) {
    summary.total += row.count;
    summary[row.delivery_status] += row.count;
    if (row.delivery_uncertain) summary.unknown_delivery += row.count;
    summary[row.outcome_status] += row.count;
  }
  return summary;
}

// ── market-open OI positioning briefings ────────────────────────────────

export type MarketOpenOiDeliveryStatus = "shadow" | "pending" | "delivered" | "failed" | "unknown" | "expired";
export type MarketOpenOiRegion = "asia" | "europe" | "us";
export type MarketOpenOiUniverse = "crypto" | "equity";
export type MarketOpenOiOutcomeHorizon = "open" | "1h" | "4h" | "24h";

export interface MarketOpenOiReportRow {
  id: number;
  report_key: string;
  region: MarketOpenOiRegion;
  local_date: string;
  report_at: number;
  open_at: number;
  generated_at: number;
  lookback_ms: number;
  calendar_covered: 0 | 1;
  selection_config_json: string;
  message_body: string;
  delivery_status: MarketOpenOiDeliveryStatus;
  delivery_attempted_at: number | null;
  delivered_at: number | null;
  delivery_error: string | null;
  telegram_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export type NewMarketOpenOiReport = Pick<MarketOpenOiReportRow,
  | "report_key"
  | "region"
  | "local_date"
  | "report_at"
  | "open_at"
  | "generated_at"
  | "lookback_ms"
  | "calendar_covered"
  | "selection_config_json"
  | "message_body"
>;

export interface MarketOpenOiItemRow {
  id: number;
  report_id: number;
  rank: number;
  symbol: string;
  sector: string;
  universe: MarketOpenOiUniverse;
  current_ts: number;
  prior_ts: number;
  current_mark: number;
  prior_mark: number;
  current_oi_coins: number;
  prior_oi_coins: number;
  current_oi_usd: number;
  prior_oi_usd: number;
  oi_quantity_delta_usd: number;
  oi_usd_delta: number;
  oi_coins_change_pct: number;
  price_change_pct: number;
  funding_hourly: number | null;
  funding_apr: number | null;
  volume_24h: number;
  quadrant: "expanding_up" | "expanding_down" | "contracting_up" | "contracting_down" | "expanding_flat" | "contracting_flat";
  smart_flow_delta_usd: number | null;
  smart_flow_alignment: "aligned" | "opposed" | "not_directional" | "unknown";
}

export type NewMarketOpenOiItem = Omit<MarketOpenOiItemRow, "id" | "report_id">;

export type MarketOpenOiReservation =
  | { kind: "inserted"; id: number }
  | { kind: "duplicate"; id: number };

function validateMarketOpenOiReservation(
  report: NewMarketOpenOiReport,
  items: NewMarketOpenOiItem[],
): void {
  if (!/^(asia|europe|us):\d{4}-\d{2}-\d{2}$/.test(report.report_key)) {
    throw new Error("Market-open OI report requires a stable region:local-date key");
  }
  if (!report.message_body || report.message_body.length > 4_096) {
    throw new Error("Market-open OI report requires a Telegram-safe message body");
  }
  if (items.length < 2) throw new Error("Market-open OI report requires at least two items");
  const symbols = new Set<string>();
  const ranks = new Set<string>();
  for (const item of items) {
    if (!item.symbol || symbols.has(item.symbol)) throw new Error("Market-open OI report item symbols must be unique");
    symbols.add(item.symbol);
    const rankKey = `${item.universe}:${item.rank}`;
    if (!Number.isInteger(item.rank) || item.rank <= 0 || ranks.has(rankKey)) {
      throw new Error("Market-open OI report ranks must be positive and unique per universe");
    }
    ranks.add(rankKey);
  }
}

export function reserveMarketOpenOiReport(
  report: NewMarketOpenOiReport,
  items: NewMarketOpenOiItem[],
  deliveryStatus: "pending" | "shadow" = "pending",
): MarketOpenOiReservation {
  validateMarketOpenOiReservation(report, items);
  const db = getDb();
  const reserve = db.transaction((): MarketOpenOiReservation => {
    const existing = db.prepare(`select id from market_open_oi_reports where report_key = ?`)
      .get(report.report_key) as { id: number } | undefined;
    if (existing) return { kind: "duplicate", id: existing.id };

    const inserted = db.prepare(`
      insert into market_open_oi_reports (
        report_key, region, local_date, report_at, open_at, generated_at,
        lookback_ms, calendar_covered, selection_config_json, message_body, delivery_status,
        delivery_attempted_at, delivered_at, delivery_error, telegram_message_id,
        created_at, updated_at
      ) values (
        @report_key, @region, @local_date, @report_at, @open_at, @generated_at,
        @lookback_ms, @calendar_covered, @selection_config_json, @message_body, @delivery_status,
        null, null, null, null, @generated_at, @generated_at
      )
    `).run({ ...report, delivery_status: deliveryStatus });
    const reportId = Number(inserted.lastInsertRowid);
    const insertItem = db.prepare(`
      insert into market_open_oi_items (
        report_id, rank, symbol, sector, universe, current_ts, prior_ts,
        current_mark, prior_mark, current_oi_coins, prior_oi_coins,
        current_oi_usd, prior_oi_usd, oi_quantity_delta_usd, oi_usd_delta,
        oi_coins_change_pct, price_change_pct, funding_hourly, funding_apr,
        volume_24h, quadrant, smart_flow_delta_usd, smart_flow_alignment
      ) values (
        @report_id, @rank, @symbol, @sector, @universe, @current_ts, @prior_ts,
        @current_mark, @prior_mark, @current_oi_coins, @prior_oi_coins,
        @current_oi_usd, @prior_oi_usd, @oi_quantity_delta_usd, @oi_usd_delta,
        @oi_coins_change_pct, @price_change_pct, @funding_hourly, @funding_apr,
        @volume_24h, @quadrant, @smart_flow_delta_usd, @smart_flow_alignment
      )
    `);
    for (const item of items) insertItem.run({ report_id: reportId, ...item });
    return { kind: "inserted", id: reportId };
  });
  return reserve.immediate();
}

export function listMarketOpenOiReports(
  options: { key?: string; limit?: number } = {},
): MarketOpenOiReportRow[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
  if (options.key) {
    return getDb().prepare(`
      select * from market_open_oi_reports where report_key = ?
      order by generated_at desc limit ?
    `).all(options.key, limit) as MarketOpenOiReportRow[];
  }
  return getDb().prepare(`
    select * from market_open_oi_reports order by generated_at desc limit ?
  `).all(limit) as MarketOpenOiReportRow[];
}

export function listPendingMarketOpenOiReports(limit = 100): MarketOpenOiReportRow[] {
  return getDb().prepare(`
    select * from market_open_oi_reports
    where delivery_status = 'pending'
    order by generated_at asc, id asc limit ?
  `).all(Math.max(1, Math.min(1_000, limit))) as MarketOpenOiReportRow[];
}

export function reconcileStaleAttemptedMarketOpenOiReports(
  attemptedBefore: number,
  observedAt = Date.now(),
): number {
  return getDb().prepare(`
    update market_open_oi_reports
    set delivery_status = 'unknown',
      delivery_error = 'Process ended after delivery attempt; acknowledgement is unknown',
      updated_at = @observedAt
    where delivery_status = 'pending'
      and delivery_attempted_at is not null
      and delivery_attempted_at < @attemptedBefore
  `).run({ attemptedBefore, observedAt }).changes;
}

export function listMarketOpenOiItems(reportId: number): MarketOpenOiItemRow[] {
  return getDb().prepare(`
    select * from market_open_oi_items where report_id = ?
    order by case universe when 'crypto' then 0 else 1 end, rank asc
  `).all(reportId) as MarketOpenOiItemRow[];
}

function boundedPositiveIds(ids: number[], maximum: number): number[] {
  const normalized = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (normalized.length > maximum) throw new Error(`Too many ids requested; maximum is ${maximum}`);
  return normalized;
}

export function listMarketOpenOiItemsForReports(reportIds: number[]): MarketOpenOiItemRow[] {
  const ids = boundedPositiveIds(reportIds, 20);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return getDb().prepare(`
    select * from market_open_oi_items
    where report_id in (${placeholders})
    order by report_id desc, universe asc, rank asc
    limit 200
  `).all(...ids) as MarketOpenOiItemRow[];
}

export function markMarketOpenOiDeliveryAttempted(id: number, attemptedAt = Date.now()): boolean {
  return getDb().prepare(`
    update market_open_oi_reports
    set delivery_attempted_at = ?, updated_at = ?
    where id = ? and delivery_status = 'pending' and delivery_attempted_at is null
  `).run(attemptedAt, attemptedAt, id).changes === 1;
}

export function markMarketOpenOiDelivered(
  id: number,
  messageId: string,
  deliveredAt = Date.now(),
): boolean {
  if (!messageId) return false;
  return getDb().prepare(`
    update market_open_oi_reports
    set delivery_status = 'delivered', delivered_at = ?, delivery_error = null,
      telegram_message_id = ?, updated_at = ?
    where id = ? and delivery_status = 'pending' and delivery_attempted_at is not null
  `).run(deliveredAt, messageId, deliveredAt, id).changes === 1;
}

export function markMarketOpenOiFailed(
  id: number,
  error: string,
  failedAt = Date.now(),
): boolean {
  return getDb().prepare(`
    update market_open_oi_reports
    set delivery_status = 'failed', delivery_error = ?, updated_at = ?
    where id = ? and delivery_status = 'pending' and delivery_attempted_at is not null
  `).run(error.slice(0, 1_000), failedAt, id).changes === 1;
}

export function markMarketOpenOiUnknown(
  id: number,
  error: string,
  observedAt = Date.now(),
): boolean {
  return getDb().prepare(`
    update market_open_oi_reports
    set delivery_status = 'unknown', delivery_error = ?, updated_at = ?
    where id = ? and delivery_status = 'pending' and delivery_attempted_at is not null
  `).run(error.slice(0, 1_000), observedAt, id).changes === 1;
}

export function markMarketOpenOiExpired(
  id: number,
  error: string,
  observedAt = Date.now(),
): boolean {
  return getDb().prepare(`
    update market_open_oi_reports
    set delivery_status = 'expired', delivery_error = ?, updated_at = ?
    where id = ? and delivery_status = 'pending' and delivery_attempted_at is null
  `).run(error.slice(0, 1_000), observedAt, id).changes === 1;
}

export interface MarketOpenOiReportSummary {
  total: number;
  shadow: number;
  pending: number;
  delivered: number;
  failed: number;
  unknown: number;
  expired: number;
}

export function summarizeMarketOpenOiReports(): MarketOpenOiReportSummary {
  const rows = getDb().prepare(`
    select delivery_status, count(*) as count
    from market_open_oi_reports group by delivery_status
  `).all() as Array<{ delivery_status: MarketOpenOiDeliveryStatus; count: number }>;
  const summary: MarketOpenOiReportSummary = {
    total: 0,
    shadow: 0,
    pending: 0,
    delivered: 0,
    failed: 0,
    unknown: 0,
    expired: 0,
  };
  for (const row of rows) {
    summary.total += row.count;
    summary[row.delivery_status] += row.count;
  }
  return summary;
}

export interface MarketOpenOiOutcomeRow {
  item_id: number;
  horizon: MarketOpenOiOutcomeHorizon;
  target_at: number;
  status: "observed" | "missing" | "untrackable";
  snapshot_at: number | null;
  mark: number | null;
  return_pct: number | null;
  observed_at: number;
  note: string | null;
}

export function upsertMarketOpenOiOutcome(row: MarketOpenOiOutcomeRow): boolean {
  return getDb().prepare(`
    insert into market_open_oi_outcomes (
      item_id, horizon, target_at, status, snapshot_at, mark, return_pct, observed_at, note
    ) values (
      @item_id, @horizon, @target_at, @status, @snapshot_at, @mark, @return_pct, @observed_at, @note
    ) on conflict(item_id, horizon) do nothing
  `).run(row).changes === 1;
}

export function listMarketOpenOiOutcomes(itemId: number): MarketOpenOiOutcomeRow[] {
  return getDb().prepare(`
    select * from market_open_oi_outcomes where item_id = ?
    order by case horizon when 'open' then 0 when '1h' then 1 when '4h' then 2 else 3 end
  `).all(itemId) as MarketOpenOiOutcomeRow[];
}

export function listMarketOpenOiOutcomesForItems(itemIds: number[]): MarketOpenOiOutcomeRow[] {
  const ids = boundedPositiveIds(itemIds, 200);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return getDb().prepare(`
    select * from market_open_oi_outcomes
    where item_id in (${placeholders})
    order by item_id asc,
      case horizon when 'open' then 0 when '1h' then 1 when '4h' then 2 else 3 end
    limit 800
  `).all(...ids) as MarketOpenOiOutcomeRow[];
}

export interface PendingMarketOpenOiOutcomeItem {
  itemId: number;
  symbol: string;
  openAt: number;
}

export function listPendingMarketOpenOiOutcomeItems(
  now: number,
  limit = 500,
): PendingMarketOpenOiOutcomeItem[] {
  const settledThrough = now - 10 * 60_000;
  return getDb().prepare(`
    select i.id as itemId, i.symbol, r.open_at as openAt
    from market_open_oi_items i
    join market_open_oi_reports r on r.id = i.report_id
    where
      (r.open_at <= @settledThrough and not exists (
        select 1 from market_open_oi_outcomes o where o.item_id = i.id and o.horizon = 'open'
      ))
      or (r.open_at + 3600000 <= @settledThrough and not exists (
        select 1 from market_open_oi_outcomes o where o.item_id = i.id and o.horizon = '1h'
      ))
      or (r.open_at + 14400000 <= @settledThrough and not exists (
        select 1 from market_open_oi_outcomes o where o.item_id = i.id and o.horizon = '4h'
      ))
      or (r.open_at + 86400000 <= @settledThrough and not exists (
        select 1 from market_open_oi_outcomes o where o.item_id = i.id and o.horizon = '24h'
      ))
    order by r.open_at asc, i.id asc
    limit @limit
  `).all({ settledThrough, limit: Math.max(1, Math.min(5_000, limit)) }) as PendingMarketOpenOiOutcomeItem[];
}
