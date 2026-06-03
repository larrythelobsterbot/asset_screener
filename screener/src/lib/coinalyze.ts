// Coinalyze client — cross-exchange derivatives data (OI / funding /
// liquidations) for the Phase 2 "derivs radar".
//
// Why cross-exchange: our screener already pulls Hyperliquid's OWN OI and
// funding directly. Coinalyze's value-add is the rest of the market — total
// OI across all venues (for the OI x price regime read), and liquidations,
// which HL does not expose through Coinalyze (verified: HL liq history is
// empty; 0/179 HL markets carry long/short data). So we aggregate the major
// perp venues per coin.
//
// Constraints (verified against the live API, 2026-06-03):
//   - base URL https://api.coinalyze.net/v1/, auth header `api_key`
//   - 40 requests / minute / key (429 with Retry-After when exceeded)
//   - ~20 symbols max per request (excess is silently truncated)
//   - HL OI is BASE_ASSET-denominated → always pass convert_to_usd=true
//   - symbol format: `<pair>.<exchangeCode>` (e.g. BTCUSDT_PERP.A = Binance,
//     BTC.H = Hyperliquid). exchange codes come from /exchanges.

import { fetchWithTimeout } from "./fetchWithTimeout";
import { cache } from "./cache";

const BASE = "https://api.coinalyze.net/v1";
const MAX_SYMBOLS_PER_REQ = 20;
// Major perp venues we aggregate OI over, by Coinalyze exchange code.
// A=Binance 6=Bybit 3=OKX H=Hyperliquid 4=Huobi F=Bitfinex W=WOO 8=dYdX.
const OI_EXCHANGES = new Set(["A", "6", "3", "H", "4", "F", "W", "8"]);
// Venues that actually report liquidations (HL does not).
const LIQ_EXCHANGES = new Set(["A", "6", "3", "4"]);
const HL_CODE = "H";

function key(): string | undefined {
  return process.env.COINALYZE_API_KEY;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Thrown on HTTP 429 so the poller can recognise rate-limiting and enter a
// cooldown rather than immediately re-poking the key.
export class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("coinalyze 429 rate-limited");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

// IMPORTANT: do NOT retry in-call. Coinalyze renews its throttle penalty on
// every request made while limited, so an in-call retry loop keeps the key
// permanently throttled (observed in prod). We fail fast on 429 and let the
// POLLER back off as a whole — that's the only way the window actually cools.
async function czGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const k = key();
  if (!k) throw new Error("COINALYZE_API_KEY not set");
  const qs = new URLSearchParams(params).toString();
  const res = await fetchWithTimeout(
    `${BASE}${path}?${qs}`,
    { headers: { api_key: k, accept: "application/json" } },
    15_000
  );
  if (res.status === 429) {
    const ra = parseFloat(res.headers.get("retry-after") || "");
    throw new RateLimitError((Number.isFinite(ra) ? ra : 60) * 1000);
  }
  if (!res.ok) throw new Error(`coinalyze ${path} ${res.status}`);
  return (await res.json()) as T;
}

// ── Markets index ───────────────────────────────────────────────────────

interface FutureMarket {
  symbol: string;
  exchange: string;
  base_asset: string;
  is_perpetual: boolean;
}

// base_asset (UPPERCASE) → perp symbols on our aggregation venues. Cached
// 6h — the market list is near-static and this is the only unbounded call.
async function symbolIndex(): Promise<Map<string, string[]>> {
  const cached = cache.get<[string, string[]][]>("cz:symindex");
  if (cached) return new Map(cached);
  const markets = await czGet<FutureMarket[]>("/future-markets", {});
  const idx = new Map<string, string[]>();
  for (const m of markets) {
    if (!m.is_perpetual || !OI_EXCHANGES.has(m.exchange)) continue;
    const base = m.base_asset?.toUpperCase();
    if (!base) continue;
    const list = idx.get(base) ?? [];
    list.push(m.symbol);
    idx.set(base, list);
  }
  cache.set("cz:symindex", [...idx.entries()], 6 * 3600_000);
  return idx;
}

// ── Raw fetches (chunked, sequential to respect the rate budget) ────────

interface PointVal { symbol: string; value: number; update: number }
interface HistorySeries { symbol: string; history: { t: number; l: number; s: number }[] }

async function currentOI(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const c of chunk(symbols, MAX_SYMBOLS_PER_REQ)) {
    const rows = await czGet<PointVal[]>("/open-interest", {
      symbols: c.join(","),
      convert_to_usd: "true",
    });
    for (const r of rows) out.set(r.symbol, r.value);
  }
  return out;
}

async function currentFunding(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const c of chunk(symbols, MAX_SYMBOLS_PER_REQ)) {
    const rows = await czGet<PointVal[]>("/funding-rate", { symbols: c.join(",") });
    for (const r of rows) out.set(r.symbol, r.value);
  }
  return out;
}

// Summed long/short liquidation USD over [from,to] per symbol.
async function liquidations(
  symbols: string[], from: number, to: number
): Promise<Map<string, { long: number; short: number }>> {
  const out = new Map<string, { long: number; short: number }>();
  for (const c of chunk(symbols, MAX_SYMBOLS_PER_REQ)) {
    const series = await czGet<HistorySeries[]>("/liquidation-history", {
      symbols: c.join(","),
      interval: "1hour",
      from: String(from),
      to: String(to),
      convert_to_usd: "true",
    });
    for (const s of series) {
      const long = s.history.reduce((a, h) => a + (h.l || 0), 0);
      const short = s.history.reduce((a, h) => a + (h.s || 0), 0);
      out.set(s.symbol, { long, short });
    }
  }
  return out;
}

// ── Aggregation ─────────────────────────────────────────────────────────

export interface CoinDerivs {
  base: string;
  oiUsd: number;          // aggregate OI across venues (USD)
  oiHlUsd: number | null; // Hyperliquid-only OI (USD), if covered
  fundingHl: number | null; // HL current funding rate (what the user pays)
  liqLongUsd: number;     // summed long liquidations over the window
  liqShortUsd: number;    // summed short liquidations over the window
  venues: number;         // how many venue symbols contributed to oiUsd
}

// Fetch + aggregate derivs for the given base assets (e.g. ["BTC","ETH"]).
// liqWindowMs sets the liquidation lookback (default 1h). Bases with no
// Coinalyze coverage are simply omitted from the result.
export async function getDerivsForCoins(
  bases: string[],
  liqWindowMs = 3600_000,
  now = Date.now(),
): Promise<CoinDerivs[]> {
  const idx = await symbolIndex();
  const wanted = bases.map((b) => b.toUpperCase()).filter((b) => idx.has(b));
  if (wanted.length === 0) return [];

  // Build the symbol → base reverse map for the venues we care about.
  const oiSymbols: string[] = [];
  const liqSymbols: string[] = [];
  const hlSymbolOf = new Map<string, string>();
  const baseOfSymbol = new Map<string, string>();
  for (const base of wanted) {
    for (const sym of idx.get(base)!) {
      oiSymbols.push(sym);
      baseOfSymbol.set(sym, base);
      const code = sym.split(".").pop()!;
      if (code === HL_CODE) hlSymbolOf.set(base, sym);
      if (LIQ_EXCHANGES.has(code)) liqSymbols.push(sym);
    }
  }

  const from = Math.floor((now - liqWindowMs) / 1000);
  const to = Math.floor(now / 1000);

  // Sequential to stay well under 40/min. OI is the big one; funding only
  // needs the HL symbols; liquidations only the liq venues.
  const oi = await currentOI(oiSymbols);
  const hlSymbols = [...hlSymbolOf.values()];
  const funding = hlSymbols.length ? await currentFunding(hlSymbols) : new Map<string, number>();
  const liq = liqSymbols.length ? await liquidations(liqSymbols, from, to) : new Map();

  const result: CoinDerivs[] = [];
  for (const base of wanted) {
    let oiUsd = 0, venues = 0;
    for (const sym of idx.get(base)!) {
      const v = oi.get(sym);
      if (v != null && Number.isFinite(v)) { oiUsd += v; venues += 1; }
    }
    const hlSym = hlSymbolOf.get(base);
    const oiHlUsd = hlSym ? oi.get(hlSym) ?? null : null;
    const fundingHl = hlSym ? funding.get(hlSym) ?? null : null;
    let liqLongUsd = 0, liqShortUsd = 0;
    for (const sym of idx.get(base)!) {
      const l = liq.get(sym);
      if (l) { liqLongUsd += l.long; liqShortUsd += l.short; }
    }
    result.push({ base, oiUsd, oiHlUsd, fundingHl, liqLongUsd, liqShortUsd, venues });
  }
  return result;
}

export function isCoinalyzeConfigured(): boolean {
  return !!key();
}
