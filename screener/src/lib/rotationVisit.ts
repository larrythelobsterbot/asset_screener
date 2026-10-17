import { identityKey, type RotationMarketContract } from "./rotation";

export const ROTATION_VISIT_STORAGE_KEY = "asset-screener-rotation-visit-v1";
export const ROTATION_VISIT_SCHEMA_VERSION = 1;
export const ROTATION_VISIT_MAX_AGE_MS = 14 * 86_400_000;
const ROTATION_VISIT_MAX_BYTES = 200_000;
const ROTATION_VISIT_MAX_ENTRIES = 1_000;

export interface VisitEntry {
  identity: string;
  symbol: string;
  kind: "native" | "hip3";
  dex: string | null;
  wireCoin: string;
  historyKey: string;
  ts: number;
  price: number;
  oi: number | null;
}

export interface VisitBaseline {
  version: 1;
  capturedAt: number;
  entries: VisitEntry[];
}

export interface VisitStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export type VisitBaselineResult =
  | { status: "first-visit"; baseline: null }
  | { status: "ready"; baseline: VisitBaseline }
  | { status: "stale"; baseline: null }
  | { status: "invalid"; baseline: null };

/** Accessing localStorage itself can throw in privacy/blocking modes. */
export function getBrowserStorage(): VisitStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function visitIdentity(contract: RotationMarketContract): string {
  return identityKey(contract);
}

function validEntry(value: unknown): value is VisitEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<VisitEntry>;
  const price = entry.price;
  const oi = entry.oi;
  const contractCoherent = entry.kind === "native"
    ? entry.dex === null && entry.wireCoin === entry.historyKey
    : entry.kind === "hip3" && typeof entry.dex === "string" && entry.wireCoin === `${entry.dex}:${entry.historyKey}`;
  const expectedIdentity = contractCoherent && entry.wireCoin
    ? identityKey({ kind: entry.kind as "native" | "hip3", dex: entry.dex ?? null, wireCoin: entry.wireCoin, historyKey: entry.historyKey ?? "" })
    : "";
  return typeof entry.identity === "string" && entry.identity.length > 0 && entry.identity === expectedIdentity
    && typeof entry.symbol === "string" && entry.symbol.length > 0
    && (entry.kind === "native" || entry.kind === "hip3")
    && (entry.dex === null || typeof entry.dex === "string")
    && typeof entry.wireCoin === "string" && entry.wireCoin.length > 0
    && typeof entry.historyKey === "string" && entry.historyKey.length > 0
    && Number.isFinite(entry.ts) && typeof price === "number" && Number.isFinite(price) && price > 0
    && (oi === null || (typeof oi === "number" && Number.isFinite(oi) && oi >= 0));
}

export function createVisitBaseline(entries: VisitEntry[], capturedAt: number): VisitBaseline {
  const unique = new Map<string, VisitEntry>();
  for (const entry of entries) {
    if (validEntry(entry)) unique.set(entry.identity, { ...entry });
    if (unique.size >= ROTATION_VISIT_MAX_ENTRIES) break;
  }
  return { version: ROTATION_VISIT_SCHEMA_VERSION, capturedAt, entries: [...unique.values()] };
}

export function serializeVisitBaseline(baseline: VisitBaseline): string {
  return JSON.stringify(baseline);
}

export function loadVisitBaseline(raw: string | null, now: number, maxAgeMs = ROTATION_VISIT_MAX_AGE_MS): VisitBaselineResult {
  if (raw == null) return { status: "first-visit", baseline: null };
  if (raw.length > ROTATION_VISIT_MAX_BYTES) return { status: "invalid", baseline: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "invalid", baseline: null };
  }
  if (typeof value !== "object" || value === null) return { status: "invalid", baseline: null };
  const candidate = value as Partial<VisitBaseline>;
  if (candidate.version !== ROTATION_VISIT_SCHEMA_VERSION || !Number.isFinite(candidate.capturedAt)
    || !Array.isArray(candidate.entries) || candidate.entries.length > ROTATION_VISIT_MAX_ENTRIES
    || !candidate.entries.every(validEntry)) return { status: "invalid", baseline: null };
  const capturedAt = candidate.capturedAt;
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt) || capturedAt < 0) return { status: "invalid", baseline: null };
  if (capturedAt > now + 5 * 60_000) return { status: "invalid", baseline: null };
  if (now - capturedAt > maxAgeMs) return { status: "stale", baseline: null };
  if (candidate.entries.some((entry) => entry.ts > now + 5 * 60_000)) return { status: "invalid", baseline: null };
  if (candidate.entries.some((entry) => now - entry.ts > maxAgeMs)) return { status: "stale", baseline: null };
  if (new Set(candidate.entries.map((entry) => entry.identity)).size !== candidate.entries.length) {
    return { status: "invalid", baseline: null };
  }
  const baseline = createVisitBaseline(candidate.entries, capturedAt);
  return { status: "ready", baseline };
}

export function readVisitBaseline(storage: VisitStorage, now: number): VisitBaselineResult {
  try {
    return loadVisitBaseline(storage.getItem(ROTATION_VISIT_STORAGE_KEY), now);
  } catch {
    return { status: "invalid", baseline: null };
  }
}

/** Persist only successful, non-stale payloads; blocked/full storage is harmless. */
export function writeVisitBaseline(storage: VisitStorage, baseline: VisitBaseline): boolean {
  if (baseline.version !== ROTATION_VISIT_SCHEMA_VERSION || !Number.isFinite(baseline.capturedAt)
    || baseline.capturedAt < 0 || baseline.capturedAt > Date.now() + 2 * 60_000) return false;
  const serialized = serializeVisitBaseline(baseline);
  if (serialized.length > ROTATION_VISIT_MAX_BYTES) return false;
  try {
    storage.setItem(ROTATION_VISIT_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearVisitBaseline(storage: VisitStorage): void {
  try { storage.removeItem?.(ROTATION_VISIT_STORAGE_KEY); } catch { /* blocked storage */ }
}

export interface SinceVisitDiff {
  identity: string;
  pricePct: number | null;
  oiPct: number | null;
  baselineTs: number;
  currentTs: number;
}

export function diffSinceVisit(current: VisitEntry[], baseline: VisitBaseline | null): Map<string, SinceVisitDiff> {
  const out = new Map<string, SinceVisitDiff>();
  if (!baseline) return out;
  const previous = new Map(baseline.entries.map((entry) => [entry.identity, entry]));
  for (const entry of current) {
    const prior = previous.get(entry.identity);
    if (!prior || entry.ts < prior.ts || prior.price <= 0) continue;
    const oiPct = prior.oi != null && prior.oi > 0 && entry.oi != null
      ? ((entry.oi - prior.oi) / prior.oi) * 100
      : null;
    out.set(entry.identity, {
      identity: entry.identity,
      pricePct: ((entry.price - prior.price) / prior.price) * 100,
      oiPct,
      baselineTs: prior.ts,
      currentTs: entry.ts,
    });
  }
  return out;
}
