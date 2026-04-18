import { getSupabase, isSupabaseEnabled } from "./supabase";
import type { Signal } from "./signals";

// Signal persistence layer.
//
// The goal is a zero-config track record: every distinct signal fire is
// inserted into the `signal_events` table with the price at fire time;
// later a cron job (see `evaluateSignalOutcomes`) re-reads prices at
// 1h/4h/24h and fills in the pnl_* columns. That gives us, after a few
// weeks of operation, enough labeled data to compute hit rates per
// signal type and prune / reweight the conviction scorer.
//
// We swallow database errors here — persistence is a side-observation of
// the live scan, not the hot path, and we don't want a transient DB
// outage to degrade the signal endpoint itself. Failures are logged.

export interface SignalEventRow {
  symbol: string;
  type: string;
  family: string;
  direction: string;
  value: number;
  label: string;
  fired_at: string;
  timeframe: string | null;
  vol_regime: string | null;
  strength: number | null;
  price_at_fire: number | null;
}

export async function logSignalFires(
  signals: Signal[],
  priceBySymbol: Map<string, number>
): Promise<void> {
  if (!isSupabaseEnabled()) return;
  const client = getSupabase();
  if (!client || signals.length === 0) return;

  const rows: SignalEventRow[] = signals.map((s) => ({
    symbol: s.symbol,
    type: s.type,
    family: s.family,
    direction: s.direction,
    value: Number.isFinite(s.value) ? s.value : 0,
    label: s.label,
    fired_at: new Date(s.firedAt).toISOString(),
    timeframe: s.timeframe ?? null,
    vol_regime: s.volRegime ?? null,
    strength: s.strength ?? null,
    price_at_fire: priceBySymbol.get(s.symbol) ?? null,
  }));

  // Dedup key: (symbol, type, timeframe, fired_at) — if the cache re-serves
  // the same signal within its TTL we don't want duplicate rows. The DB
  // unique constraint (see schema) enforces this; `upsert` with
  // ignoreDuplicates avoids throwing on retries.
  const { error } = await client
    .from("signal_events")
    .upsert(rows, { onConflict: "symbol,type,timeframe,fired_at", ignoreDuplicates: true });

  if (error) {
    console.warn(`[signalPersistence] failed to insert ${rows.length} rows: ${error.message}`);
  }
}

// Cron target: re-read prices for signal fires that haven't been evaluated
// yet and fill in the pnl_* columns. The current schema stores pnl_1h,
// pnl_4h, pnl_24h — whichever is ready at cron time gets filled; the
// others are filled on subsequent runs until all three are set, after
// which the row is considered fully evaluated.
//
// This is intentionally a pure function of (row → current price): it does
// not mutate the signal logic. That means we can re-run it safely with a
// different price source (e.g. a longer-term on-chain oracle) later if we
// want to grade the same events differently.
export interface OutcomeUpdate {
  id: string;
  pnl_1h_pct?: number | null;
  pnl_4h_pct?: number | null;
  pnl_24h_pct?: number | null;
  evaluated_at?: string;
}

export async function evaluateSignalOutcomes(
  currentPriceBySymbol: Map<string, number>,
  now: number = Date.now()
): Promise<{ scanned: number; updated: number }> {
  if (!isSupabaseEnabled()) return { scanned: 0, updated: 0 };
  const client = getSupabase();
  if (!client) return { scanned: 0, updated: 0 };

  // Pull rows where any of the three pnl slots is still null AND the row
  // is at least 1h old (nothing to evaluate before then).
  const cutoff = new Date(now - 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await client
    .from("signal_events")
    .select("id, symbol, direction, fired_at, price_at_fire, pnl_1h_pct, pnl_4h_pct, pnl_24h_pct")
    .lte("fired_at", cutoff)
    .or("pnl_1h_pct.is.null,pnl_4h_pct.is.null,pnl_24h_pct.is.null")
    .limit(500);

  if (error) {
    console.warn(`[signalPersistence] evaluateSignalOutcomes read failed: ${error.message}`);
    return { scanned: 0, updated: 0 };
  }
  if (!rows || rows.length === 0) return { scanned: 0, updated: 0 };

  const WINDOWS: Array<{ col: "pnl_1h_pct" | "pnl_4h_pct" | "pnl_24h_pct"; hours: number }> = [
    { col: "pnl_1h_pct", hours: 1 },
    { col: "pnl_4h_pct", hours: 4 },
    { col: "pnl_24h_pct", hours: 24 },
  ];

  const updates: OutcomeUpdate[] = [];
  for (const row of rows as Array<{
    id: string;
    symbol: string;
    direction: string;
    fired_at: string;
    price_at_fire: number | null;
    pnl_1h_pct: number | null;
    pnl_4h_pct: number | null;
    pnl_24h_pct: number | null;
  }>) {
    if (row.price_at_fire == null || row.price_at_fire === 0) continue;
    const currentPrice = currentPriceBySymbol.get(row.symbol);
    if (currentPrice == null) continue;

    const firedAt = new Date(row.fired_at).getTime();
    const ageMs = now - firedAt;
    const update: OutcomeUpdate = { id: row.id };
    let anyChange = false;
    for (const w of WINDOWS) {
      if (row[w.col] != null) continue;
      // Only fill a window once it's "ripe": we're at least w.hours past
      // fire time. The oldest window that fills also gets evaluated_at.
      if (ageMs < w.hours * 3600_000) continue;
      // PnL sign is keyed to signal direction. Bullish signal: positive
      // price change = win. Bearish: inverted.
      const pctChange = ((currentPrice - row.price_at_fire) / row.price_at_fire) * 100;
      const signed = row.direction === "bullish" ? pctChange : -pctChange;
      update[w.col] = signed;
      anyChange = true;
    }
    if (anyChange) {
      update.evaluated_at = new Date(now).toISOString();
      updates.push(update);
    }
  }

  if (updates.length === 0) return { scanned: rows.length, updated: 0 };

  // Issue individual updates keyed by id. Supabase doesn't support bulk
  // partial updates; if this gets expensive we can chunk into parallel
  // promises.
  let updated = 0;
  for (const u of updates) {
    const { id, ...fields } = u;
    const { error: uerr } = await client.from("signal_events").update(fields).eq("id", id);
    if (!uerr) updated += 1;
  }
  return { scanned: rows.length, updated };
}
