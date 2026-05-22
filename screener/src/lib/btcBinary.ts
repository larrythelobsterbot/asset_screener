// HIP-4 daily BTC binary outcome — parser, market lookup, probability
// model.
//
// The recurring contract: every 24h at 06:00 UTC, a new binary deploys
// with a fresh target price. Settles to YES ($1) if BTC mark ≥ target
// at expiry, NO ($0) otherwise. YES and NO trade as separate tokens
// on a merged orderbook (parity-enforced: yes_px + no_px ≈ 1).
//
// Description format:
//   class:priceBinary|underlying:BTC|expiry:20260523-0600|targetPrice:77451|period:1d
//
// Encoding rules (per docs/asset-ids):
//   yes spot coin: "#" + (10*outcome + 0)   // e.g. "#800"
//   no  spot coin: "#" + (10*outcome + 1)   // e.g. "#801"
//   yes asset id: 100_000_000 + 10*outcome + 0
//   no  asset id: 100_000_000 + 10*outcome + 1

import { getOutcomeMeta, type OutcomeSpec } from "./hyperliquid";
import { getMid } from "./hyperliquidWs";

// ── Description parsing ────────────────────────────────────────────────

export interface ParsedBinaryDescription {
  class: "priceBinary";
  underlying: string;            // e.g. "BTC"
  expiryMs: number;              // ms since epoch
  targetPrice: number;
  period: string;                // e.g. "1d"
}

// description is pipe-delimited key:value pairs in a fixed but
// undocumented order. We parse by key, not by position, so a future
// re-ordering doesn't silently break us.
export function parseBinaryDescription(desc: string): ParsedBinaryDescription | null {
  if (!desc.includes("class:priceBinary")) return null;
  const fields: Record<string, string> = {};
  for (const part of desc.split("|")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    fields[part.slice(0, idx)] = part.slice(idx + 1);
  }
  if (fields.class !== "priceBinary") return null;
  const expiryMs = parseExpiry(fields.expiry);
  const targetPrice = parseFloat(fields.targetPrice);
  if (expiryMs == null || !Number.isFinite(targetPrice) || targetPrice <= 0) return null;
  return {
    class: "priceBinary",
    underlying: fields.underlying ?? "",
    expiryMs,
    targetPrice,
    period: fields.period ?? "",
  };
}

// Expiry format: "YYYYMMDD-HHMM" (UTC). e.g. "20260523-0600".
function parseExpiry(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [, yyyy, mm, dd, hh, mn] = m;
  const ms = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mn, 0, 0);
  return Number.isFinite(ms) ? ms : null;
}

// ── Market lookup ──────────────────────────────────────────────────────

export interface BtcBinaryMarket {
  outcomeId: number;
  targetPrice: number;
  expiryMs: number;
  period: string;
  yesAssetId: number;
  noAssetId: number;
  yesCoin: string;               // e.g. "#800"
  noCoin: string;                // e.g. "#801"
}

// Pick the active BTC daily binary from outcomeMeta. Multiple binary
// outcomes can exist concurrently (e.g. testnet); we filter by
// underlying === "BTC" and prefer the one whose expiry is in the
// future and closest to now (the currently-trading contract). Returns
// null if no matching outcome is currently deployed.
export function findActiveBtcBinary(outcomes: OutcomeSpec[]): BtcBinaryMarket | null {
  const now = Date.now();
  const candidates: BtcBinaryMarket[] = [];
  for (const o of outcomes) {
    const parsed = parseBinaryDescription(o.description);
    if (!parsed) continue;
    if (parsed.underlying !== "BTC") continue;
    if (parsed.expiryMs <= now) continue;          // already settled
    const encoding = 10 * o.outcome + 0;           // yes side
    candidates.push({
      outcomeId: o.outcome,
      targetPrice: parsed.targetPrice,
      expiryMs: parsed.expiryMs,
      period: parsed.period,
      yesAssetId: 100_000_000 + 10 * o.outcome + 0,
      noAssetId:  100_000_000 + 10 * o.outcome + 1,
      yesCoin: `#${encoding}`,
      noCoin:  `#${encoding + 1}`,
    });
  }
  if (candidates.length === 0) return null;
  // Closest-future-expiry = currently-trading contract.
  candidates.sort((a, b) => a.expiryMs - b.expiryMs);
  return candidates[0];
}

export interface BtcBinaryState extends BtcBinaryMarket {
  yesMid: number | null;
  noMid: number | null;
  btcMid: number | null;
}

// One-shot fetch — calls HL info, finds the active binary, resolves
// live mids from our WS client. All four mid lookups are O(1) hashmap
// reads — no extra network.
export async function getCurrentBtcBinary(): Promise<BtcBinaryState | null> {
  const meta = await getOutcomeMeta();
  const market = findActiveBtcBinary(meta.outcomes);
  if (!market) return null;
  return {
    ...market,
    yesMid: getMid(market.yesCoin),
    noMid: getMid(market.noCoin),
    btcMid: getMid("BTC"),
  };
}

// ── Probability model (Black-Scholes binary, geometric Brownian motion) ──
// P(S_T >= K) under risk-neutral GBM:
//   d2 = (ln(S/K) + (r - σ²/2) · T) / (σ · √T)
//   P(S_T >= K) = N(d2)
//
// For our purposes r ≈ 0 (perp HYPE has funding but BTC binary is on
// the spot index; the time horizon is < 24h so funding negligible).
// σ is annualized realized vol from cached daily candles.
//
// This is a NAIVE model — it assumes lognormal returns with constant
// vol. Real BTC has fat tails and stochastic vol, so the actual
// probability deviates from this. The point isn't to "beat the
// market"; it's to surface where the market price disagrees with a
// simple baseline, so the user can investigate.

// Approximation of the standard normal CDF (Abramowitz-Stegun 26.2.17,
// max abs error ~1.5e-7 — more than enough precision for this metric).
function normalCdf(z: number): number {
  // Use the relationship N(z) = 1 - N(-z) for z < 0 to keep the
  // polynomial in its accurate range.
  if (z < 0) return 1 - normalCdf(-z);
  const a1 = 0.319381530, a2 = -0.356563782, a3 = 1.781477937;
  const a4 = -1.821255978, a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * z);
  const w = k * (a1 + k * (a2 + k * (a3 + k * (a4 + k * a5))));
  // PDF = e^(-z²/2) / √(2π)
  const pdf = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
  return 1 - pdf * w;
}

export interface ModelInputs {
  spot: number;          // current BTC price
  strike: number;        // contract target price
  ttlMs: number;         // time to expiry in ms
  sigmaAnnualized: number; // annualized realized vol (std-dev of log returns × √365)
}

// Returns the model-implied probability of settlement >= strike
// (i.e. YES). Caller should pass a positive ttlMs; if ttl is <= 0
// we return the deterministic outcome (1 if S > K, 0 otherwise, 0.5
// at the boundary — but this is degenerate, expiry already happened).
export function modelYesProbability(input: ModelInputs): number {
  if (input.ttlMs <= 0) {
    return input.spot > input.strike ? 1 : input.spot < input.strike ? 0 : 0.5;
  }
  if (!(input.spot > 0) || !(input.strike > 0) || !(input.sigmaAnnualized > 0)) {
    return 0.5; // model can't compute — return ignorant prior
  }
  const T = input.ttlMs / (365 * 86_400_000);
  const sigmaSqrtT = input.sigmaAnnualized * Math.sqrt(T);
  // r = 0 (we ignore funding here — short horizon, low impact)
  const d2 = (
    Math.log(input.spot / input.strike) - (input.sigmaAnnualized ** 2 / 2) * T
  ) / sigmaSqrtT;
  return normalCdf(d2);
}

// Annualized realized vol from a series of daily closes (oldest-first).
// Returns the stdev of log returns, scaled by √365. Needs at least 2
// closes; returns null otherwise.
export function annualizedRealizedVol(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      rets.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  const dailyStdev = Math.sqrt(variance);
  return dailyStdev * Math.sqrt(365);
}
