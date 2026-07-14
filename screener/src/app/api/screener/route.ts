import { NextRequest, NextResponse } from "next/server";
import { computeAllIndicators, rsi as computeRsi } from "@/lib/indicators";
import { getCandlesBulkFromCache, type CandleRow } from "@/lib/db";
import { HL_PERP_SECTOR_MAP, builderOnlyTickers } from "@/config/sectors";
import { cache } from "@/lib/cache";

// Batch indicator endpoint for the screener table view. Returns one row
// per HL symbol that has enough cached candles at the requested timeframe.
// Symbols without cached candles are simply omitted — the UI is expected
// to LEFT JOIN this against /api/markets and render the asset as a "—"
// row, not error out.
//
// This route never calls Hyperliquid directly. Everything reads from the
// SQLite candles_cache table populated by /api/signals + /api/asset, so
// it's cheap to compute and won't pressure the HL rate limit.

export const dynamic = "force-dynamic";

type TF = "1h" | "4h" | "1d";

const VALID_TFS: TF[] = ["1h", "4h", "1d"];
const BARS_NEEDED = 30;          // min candles to compute indicators
const SPARKLINE_BARS = 30;       // bars to return for the sparkline polyline
const VOL_AVG_WINDOW = 20;       // window for vol_ratio computation
const CACHE_TTL_MS = 60_000;     // 1m — indicator math is cheap enough; this caps recompute under load

export interface ScreenerRow {
  symbol: string;
  timeframe: TF;
  // RSI 0-100 or null if not enough history
  rsi: number | null;
  // Moving average values at the latest bar
  ma: {
    ema13: number | null;
    ema25: number | null;
    ema32: number | null;
    ma100: number | null;
    ma300: number | null;
    ema200: number | null;
  };
  // Convenience: price-above-MA flags. true if the current close > MA,
  // false if below, null if MA isn't computed yet.
  above: {
    ema13: boolean | null;
    ema25: boolean | null;
    ema32: boolean | null;
    ma100: boolean | null;
    ma300: boolean | null;
    ema200: boolean | null;
  };
  // Volume ratio: latest bar volume / avg of prior VOL_AVG_WINDOW bars.
  // Same metric the volume_spike signal uses; surfacing as a column means
  // the user can see the ratio even when it's not yet >2× (signal threshold).
  vol_ratio: number | null;
  // % off the all-time high observed within cached candles — an
  // "observed-history" ATH%, not a true ATH%. The UI should label it
  // accordingly. We warm up to ~300 bars per interval for every symbol, but
  // the window is bounded by the market's actual age: the HIP-3 listings are
  // young (SKHX first traded 2026-02-19), so their ATH% looks back months
  // where a crypto major's looks back a year. Compare across rows with that
  // in mind.
  ath_pct: number | null;
  // Last SPARKLINE_BARS closes for a mini-chart. Just numbers, no timestamps
  // — the receiver can render an SVG polyline directly.
  sparkline: number[];
  // Last bar's close at the requested TF, exposed so the UI can compute
  // a price-vs-1h, price-vs-4h diff without re-fetching candles.
  last_close: number;
}

function buildRow(symbol: string, tf: TF, candles: CandleRow[]): ScreenerRow | null {
  if (candles.length < BARS_NEEDED) return null;
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const volumes = candles.map((c) => c.v);
  const last = closes.length - 1;

  const ind = computeAllIndicators(closes);
  const lastClose = closes[last];

  const ma = {
    ema13: ind.ema13[last] ?? null,
    ema25: ind.ema25[last] ?? null,
    ema32: ind.ema32[last] ?? null,
    ma100: ind.ma100[last] ?? null,
    ma300: ind.ma300[last] ?? null,
    ema200: ind.ema200[last] ?? null,
  };

  // above[k] = price > ma[k]. null if the MA isn't computed yet (warm-up
  // window). We don't fold this into `ma` to keep the shape ergonomic for
  // the table renderer.
  const above = {
    ema13: ma.ema13 != null ? lastClose > ma.ema13 : null,
    ema25: ma.ema25 != null ? lastClose > ma.ema25 : null,
    ema32: ma.ema32 != null ? lastClose > ma.ema32 : null,
    ma100: ma.ma100 != null ? lastClose > ma.ma100 : null,
    ma300: ma.ma300 != null ? lastClose > ma.ma300 : null,
    ema200: ma.ema200 != null ? lastClose > ma.ema200 : null,
  };

  // Volume ratio. Skip if we don't have a full window of prior bars.
  let volRatio: number | null = null;
  if (volumes.length >= VOL_AVG_WINDOW + 1) {
    const prior = volumes.slice(last - VOL_AVG_WINDOW, last);
    const avg = prior.reduce((a, b) => a + b, 0) / VOL_AVG_WINDOW;
    if (avg > 0) volRatio = volumes[last] / avg;
  }

  // ATH within cached history. We use highs (not closes) because the
  // intuition of "% off the high" is intraday-high-based, not close-based.
  const observedAth = Math.max(...highs);
  const athPct = observedAth > 0 ? ((lastClose - observedAth) / observedAth) * 100 : null;

  // Sparkline: last 30 closes. Keep it small; UI scales to whatever width.
  const sparkStart = Math.max(0, closes.length - SPARKLINE_BARS);
  const sparkline = closes.slice(sparkStart);

  // RSI: take the last non-null value rather than rsi[last] directly,
  // because in pathological short series the very last bar might be in
  // the warm-up window (shouldn't happen given the BARS_NEEDED gate, but
  // defensive — and free).
  let rsiCur: number | null = null;
  for (let i = ind.rsi.length - 1; i >= 0; i--) {
    if (ind.rsi[i] != null) { rsiCur = ind.rsi[i]!; break; }
  }
  // Reference computeRsi to keep the import live for downstream readers
  // who might want to compute RSI on a non-default window later.
  void computeRsi;

  return {
    symbol,
    timeframe: tf,
    rsi: rsiCur,
    ma,
    above,
    vol_ratio: volRatio,
    ath_pct: athPct,
    sparkline,
    last_close: lastClose,
  };
}

export async function GET(req: NextRequest) {
  const tfParam = req.nextUrl.searchParams.get("tf") ?? "1d";
  if (!VALID_TFS.includes(tfParam as TF)) {
    return NextResponse.json(
      { error: `invalid tf "${tfParam}" — expected one of ${VALID_TFS.join("|")}` },
      { status: 400 }
    );
  }
  const tf = tfParam as TF;

  const cacheKey = `api:screener:${tf}`;
  const cached = cache.get<ScreenerRow[]>(cacheKey);
  if (cached) return NextResponse.json(cached);

  // Native perps + the HIP-3 board. Both are symbols we populate candles
  // for (natives via /api/signals + /api/asset, HIP-3 via the 6h warmer in
  // lib/hip3CandleWarmer). Anything without enough cached candles is
  // dropped by the BARS_NEEDED gate in buildRow, so listing a symbol here
  // costs one Map lookup and never fabricates a row.
  //
  // HIP-3 markets only have 1d candles warmed, so they appear at tf=1d and
  // are absent at 1h/4h — which is exactly the documented contract above
  // (the UI LEFT JOINs this and renders "—").
  //
  // This widens the INDICATOR surface only. /api/signals — the one path to
  // the Telegram alerter — derives its universe from meta.universe (native
  // perps), which these tickers are not in, so alerting is unaffected.
  //
  // Bulk-read all symbols' candles in ONE SQLite query. Previously this
  // loop did 1 query per symbol (200+ synchronous reads); the bulk
  // variant uses a window function + IN() so the entire scan completes
  // in a single dispatched statement. Per-symbol error handling stays
  // identical — buildRow() is pure and only throws if its math fails.
  const symbols = [...Object.keys(HL_PERP_SECTOR_MAP), ...builderOnlyTickers()];
  let candlesBySymbol: Map<string, CandleRow[]>;
  try {
    candlesBySymbol = getCandlesBulkFromCache(symbols, tf, 350);
  } catch (err) {
    console.warn(`[screener] bulk candle read failed:`, err);
    candlesBySymbol = new Map();
  }
  const rows: ScreenerRow[] = [];
  for (const symbol of symbols) {
    try {
      const candles = candlesBySymbol.get(symbol) ?? [];
      const row = buildRow(symbol, tf, candles);
      if (row) rows.push(row);
    } catch (err) {
      console.warn(`[screener] buildRow failed for ${symbol}:`, err);
    }
  }

  cache.set(cacheKey, rows, CACHE_TTL_MS);
  return NextResponse.json(rows);
}
