import { NextRequest, NextResponse } from "next/server";
import { cache } from "@/lib/cache";
import {
  socialSnapshotSeries,
  latestSnapshots,
  latestHypePressureSnapshot,
} from "@/lib/db";
import {
  computeSocialMomentum,
  buildSocialSignals,
  type MomentumInput,
  type MomentumRow,
} from "@/lib/socialMomentum";
import { logSignalFires } from "@/lib/signalPersistence";
import { sendTelegramMessage, isTelegramConfigured } from "@/lib/telegram";

// Attention radar: mention acceleration + price divergence, computed
// entirely from SQLite (social_snapshots × price_snapshots). Costs ZERO
// Elfa credits — the history it reads accumulates via the keepalive
// pinging /api/social/trending hourly.
//
// Side effects (fire-and-forget, both no-op without env config):
//   - classified HL rows are persisted to signal_events (12h de-bounce
//     inside buildSocialSignals) so evaluate-outcomes.ts grades them —
//     the paper track record that decides if attention earns a weight
//     in the conviction scorer later.
//   - strong quiet-accumulation setups + hollow pumps on HL symbols
//     fire a Telegram alert. De-bounce is inherited from the signal
//     emission, so at most one alert per (symbol, type) per 12h.

export const dynamic = "force-dynamic";

const ROUTE_CACHE_TTL_MS = 5 * 60_000;
// If the newest social snapshot is older than this, the series is dead
// (keepalive down / budget exhausted). We still SERVE rows for the UI
// (flagged stale) but suppress persistence + alerts — grading or
// alerting on dead data poisons the track record.
const STALE_AFTER_MS = 2 * 3_600_000;
const LOOKBACK_MS = 3 * 86_400_000;
// Alert gate: quiet accumulation needs a hard accel (3× baseline) to
// page a human; hollow pumps alert at the class threshold since the
// bearish read is time-sensitive.
const ALERT_ACCEL_MIN = parseFloat(process.env.SOCIAL_ACCEL_ALERT_MIN || "3");
// HYPE confluence (#12): social acceleration + real TWAP buy pressure.
const HYPE_CONFLUENCE_PRESSURE_USD = parseFloat(
  process.env.HYPE_CONFLUENCE_PRESSURE_USD || "500000"
);
const HYPE_CONFLUENCE_ACCEL_MIN = 1.5;

export interface MomentumResponse {
  generated_at: number;          // newest snapshot ts the compute saw
  stale: boolean;
  count: number;
  hypeConfluence: {
    active: boolean;
    accel: number | null;
    pressure1hUsd: number | null;
  };
  data: Array<Omit<MomentumRow, "series"> & { series: number[] }>;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

async function alertOnSignals(
  signals: ReturnType<typeof buildSocialSignals>,
  rowsBySymbol: Map<string, MomentumRow>,
): Promise<void> {
  if (!isTelegramConfigured()) return;
  for (const s of signals) {
    const row = rowsBySymbol.get(s.symbol);
    if (!row) continue;
    const isAccum = s.type === "social_accel" && row.klass === "quiet_accumulation";
    const isHollow = s.type === "social_divergence";
    if (isAccum && row.accel < ALERT_ACCEL_MIN) continue;
    if (!isAccum && !isHollow) continue;

    const text = isAccum
      ? [
          `👁 <b>Quiet Accumulation — ${s.symbol}</b>`,
          ``,
          `Mentions: <b>${row.mentions}</b> (${row.accel.toFixed(1)}× the ${row.seriesSpanHours}h baseline of ${row.baseline})`,
          `Price 24h: <code>${row.price24hPct != null ? fmtPct(row.price24hPct) : "—"}</code> — attention is moving, price isn't yet.`,
          ``,
          `Attention radar · not in conviction scoring · paper-tracked`,
        ].join("\n")
      : [
          `🕳 <b>Hollow Pump — ${s.symbol}</b>`,
          ``,
          `Price 24h: <code>${row.price24hPct != null ? fmtPct(row.price24hPct) : "—"}</code> but mentions FADED to ${row.accel.toFixed(2)}× baseline (${row.mentions} vs ~${row.baseline}).`,
          `Move without organic attention — be careful chasing.`,
          ``,
          `Attention radar · not in conviction scoring · paper-tracked`,
        ].join("\n");

    const r = await sendTelegramMessage(text);
    if (!r.ok) console.warn(`[social-momentum] alert send failed (${s.symbol}):`, r.error);
    else console.info(`[social-momentum] ALERT ${s.type} fired for ${s.symbol}`);
  }
}

export async function GET(req: NextRequest) {
  const hlOnly = req.nextUrl.searchParams.get("hl") === "1";
  const cacheKey = `api:social:momentum:${hlOnly ? "hl" : "all"}`;
  const cached = cache.get<MomentumResponse>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const now = Date.now();
    const seriesBySymbol = socialSnapshotSeries("24h", now - LOOKBACK_MS);

    // HL price context: symbols present in price_snapshots ARE the HL
    // universe (written by every /api/markets scan). mark vs prev_day
    // gives the 24h change without touching the network.
    const priceMap = latestSnapshots();

    const inputs: MomentumInput[] = [];
    for (const [symbol, series] of seriesBySymbol) {
      const p = priceMap.get(symbol);
      const price24hPct =
        p && p.prev_day && p.prev_day > 0
          ? ((p.mark - p.prev_day) / p.prev_day) * 100
          : null;
      inputs.push({ symbol, series, price24hPct, isHL: !!p });
    }

    let rows = computeSocialMomentum(inputs);
    if (hlOnly) rows = rows.filter((r) => r.isHL);

    let newestTs = 0;
    for (const series of seriesBySymbol.values()) {
      const last = series[series.length - 1];
      if (last && last.ts > newestTs) newestTs = last.ts;
    }
    const stale = newestTs === 0 || now - newestTs > STALE_AFTER_MS;

    // HYPE confluence: attention accelerating on HYPE while TWAP buy
    // pressure is stacked. Both halves read from SQLite.
    const hypeRow = rows.find((r) => r.symbol === "HYPE") ?? null;
    let pressure1hUsd: number | null = null;
    try {
      pressure1hUsd = latestHypePressureSnapshot()?.pressure_1h_usd ?? null;
    } catch {
      // hype table empty / unavailable — confluence just reads inactive.
    }
    const hypeConfluence = {
      active:
        !stale &&
        hypeRow != null &&
        hypeRow.accel >= HYPE_CONFLUENCE_ACCEL_MIN &&
        pressure1hUsd != null &&
        pressure1hUsd >= HYPE_CONFLUENCE_PRESSURE_USD,
      accel: hypeRow?.accel ?? null,
      pressure1hUsd,
    };

    if (!stale) {
      // Persist + alert only on live data. buildSocialSignals de-bounces
      // (symbol, type) for 12h, so recomputes are cheap no-ops after the
      // first fire.
      const signals = buildSocialSignals(rows);
      if (signals.length > 0) {
        const priceBySymbol = new Map<string, number>();
        for (const [sym, p] of priceMap) if (p.mark > 0) priceBySymbol.set(sym, p.mark);
        logSignalFires(signals, priceBySymbol).catch((e) =>
          console.warn("[social-momentum] persistence error:", e)
        );
        const rowsBySymbol = new Map(rows.map((r) => [r.symbol, r]));
        alertOnSignals(signals, rowsBySymbol).catch((e) =>
          console.warn("[social-momentum] alert error:", e)
        );
        console.info(
          `[social-momentum] fired: ${signals.map((s) => `${s.symbol}:${s.type}`).join(", ")}`
        );
      }
    }

    const TOP_N = 40;
    const body: MomentumResponse = {
      generated_at: newestTs || now,
      stale,
      count: rows.length,
      hypeConfluence,
      // Trim sparkline series to the last 24 points to keep the payload
      // lean — 3 days of hourly history is ~72 numbers per row otherwise.
      data: rows.slice(0, TOP_N).map((r) => ({ ...r, series: r.series.slice(-24) })),
    };
    cache.set(cacheKey, body, ROUTE_CACHE_TTL_MS);
    return NextResponse.json(body);
  } catch (err) {
    const staleBody = cache.getStale<MomentumResponse>(cacheKey);
    if (staleBody) return NextResponse.json(staleBody);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
