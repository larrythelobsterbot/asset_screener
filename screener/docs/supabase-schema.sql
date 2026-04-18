-- ──────────────────────────────────────────────────────────────────────
-- Signal persistence schema for the asset screener.
--
-- Run this once in your Supabase project's SQL editor (or via the CLI).
-- After the schema exists, set these env vars on the server:
--   NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
--   SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
-- The signals route will begin writing on the next scan.
--
-- Design notes:
-- - `fired_at` is keyed alongside (symbol, type, timeframe) for idempotent
--   upserts: the cached signal endpoint may re-emit the same fire within
--   its 30 s TTL, and we want the second write to be a no-op.
-- - `pnl_*_pct` columns are intentionally signed relative to `direction`
--   (bullish signal + price up = positive). Lets us compute hit rate with
--   a trivial `pnl > 0` predicate instead of re-deriving direction.
-- - We don't store the full `signals` payload — just the flattened columns
--   the outcome evaluator + reporting queries actually need. Keeps rows
--   cheap and predictable.
-- ──────────────────────────────────────────────────────────────────────

create table if not exists signal_events (
  id            uuid primary key default gen_random_uuid(),
  symbol        text        not null,
  type          text        not null,
  family        text        not null,
  direction     text        not null,         -- 'bullish' | 'bearish'
  value         numeric     not null default 0,
  label         text        not null,
  fired_at      timestamptz not null,
  timeframe     text,                         -- '1h' | '4h' | '1d' | 'cross' | null
  vol_regime    text,                         -- 'quiet' | 'normal' | 'wild' | 'unknown' | null
  strength      numeric,                      -- 0–100, nullable
  price_at_fire numeric,                      -- reference price at fire time
  -- Outcomes — filled in by the evaluator cron. Signed relative to direction.
  pnl_1h_pct    numeric,
  pnl_4h_pct    numeric,
  pnl_24h_pct   numeric,
  evaluated_at  timestamptz
);

-- Upsert key — mirrors the onConflict target in signalPersistence.ts.
create unique index if not exists signal_events_uniq
  on signal_events (symbol, type, timeframe, fired_at);

-- Query patterns we care about:
--   * "recent fires for symbol X" → (symbol, fired_at desc)
--   * "events needing outcome eval" → (fired_at) filtered on pnl_* nulls
--   * "hit rate by type" → (type, direction) grouped
create index if not exists signal_events_symbol_time
  on signal_events (symbol, fired_at desc);

create index if not exists signal_events_unevaluated
  on signal_events (fired_at)
  where pnl_1h_pct is null or pnl_4h_pct is null or pnl_24h_pct is null;

create index if not exists signal_events_type
  on signal_events (type, direction);

-- ──────────────────────────────────────────────────────────────────────
-- Convenience view: per-signal-type hit rate.
-- A signal "hits" when the signed pnl is positive. We evaluate at the
-- 4h horizon by default since it matches the primary scan timeframe.
-- ──────────────────────────────────────────────────────────────────────

create or replace view signal_hit_rate_4h as
select
  type,
  direction,
  count(*)                                   as n,
  count(*) filter (where pnl_4h_pct > 0)     as wins,
  avg(pnl_4h_pct)                            as avg_pnl,
  percentile_cont(0.5) within group (order by pnl_4h_pct) as median_pnl
from signal_events
where pnl_4h_pct is not null
group by type, direction
order by n desc;
