export type HealthStatus = "ok" | "degraded";

export interface HealthSample {
  status: HealthStatus;
  now: number;
  hlWs: { connected: boolean; symbolCount: number; msSinceLastMessage: number | null };
  treeWs: { connected: boolean; authed: boolean; isSub: boolean | null };
  snapshotAgeMs: number | null;
  feedAgeMs: number | null;
}

export interface HealthReceipt { sample: HealthSample; receivedAt: number; receivedWallAt?: number; }

export type HealthAvailability = "unknown" | "usable" | "error" | "expired";
export type HealthTone = "ok" | "warn" | "bad";

export interface HealthView {
  availability: HealthAvailability;
  sample: HealthSample | null;
  receiptAgeMs: number | null;
  prices: HealthTone;
  snapshots: HealthTone;
  feed: HealthTone;
  tree: HealthTone;
  pricesAgeMs: number | null;
  snapshotsAgeMs: number | null;
  feedAgeMs: number | null;
}

const MAX_CLIENT_RECEIPT_AGE_MS = 45_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function age(value: unknown): value is number | null { return value === null || (finite(value) && value >= 0); }

/** Validate only the health fields consumed by the terminal strip. */
export function parseHealthResponse(value: unknown): HealthSample | null {
  if (!record(value) || (value.status !== "ok" && value.status !== "degraded") || !finite(value.now) || value.now <= 0) return null;
  const hl = value.hlWs;
  const tree = value.treeWs;
  if (!record(hl) || !record(tree)) return null;
  const ms = hl.msSinceLastMessage;
  const symbolCount = hl.symbolCount;
  if (!finite(ms) && ms !== -1) return null;
  if (finite(ms) && ms < 0 && ms !== -1) return null;
  if (typeof hl.connected !== "boolean" || typeof symbolCount !== "number" || !Number.isInteger(symbolCount) || symbolCount < 0) return null;
  if (typeof tree.connected !== "boolean" || typeof tree.authed !== "boolean" || (tree.isSub !== null && typeof tree.isSub !== "boolean")) return null;
  if (!age(value.snapshotAgeMs) || !age(value.feedAgeMs)) return null;
  return {
    status: value.status,
    now: value.now,
    hlWs: { connected: hl.connected, symbolCount, msSinceLastMessage: ms === -1 ? null : ms },
    treeWs: { connected: tree.connected, authed: tree.authed, isSub: tree.isSub },
    snapshotAgeMs: value.snapshotAgeMs,
    feedAgeMs: value.feedAgeMs,
  };
}

/** A sample only renews client receipt evidence when server generation advances. */
export function acceptHealthSample(previous: HealthReceipt | null, candidate: HealthSample, receivedAt: number, receivedWallAt?: number): HealthReceipt | null {
  if (!finite(receivedAt) || receivedAt < 0) return null;
  if (receivedWallAt !== undefined && (!finite(receivedWallAt) || receivedWallAt < 0)) return null;
  if (previous && candidate.now <= previous.sample.now) return null;
  return { sample: candidate, receivedAt, ...(finite(receivedWallAt) && receivedWallAt >= 0 ? { receivedWallAt } : {}) };
}

function elapsed(base: number | null, receiptAgeMs: number | null): number | null {
  if (base === null) return null;
  if (!finite(receiptAgeMs) || receiptAgeMs < 0) return null;
  return base + receiptAgeMs;
}
function tone(ms: number | null, warnAt: number, badAt: number): HealthTone {
  if (ms === null) return "bad";
  if (ms > badAt) return "bad";
  if (ms > warnAt) return "warn";
  return "ok";
}

function projectedReceiptAge(receipt: HealthReceipt, now: number, wallNow: number | undefined): number | null {
  const monotonicAge = finite(now) && now >= receipt.receivedAt ? now - receipt.receivedAt : null;
  if (receipt.receivedWallAt !== undefined && (!finite(wallNow) || wallNow < receipt.receivedWallAt)) return null;
  const wallAge = receipt.receivedWallAt !== undefined && finite(wallNow) && wallNow >= receipt.receivedWallAt
    ? wallNow - receipt.receivedWallAt
    : null;
  if (monotonicAge === null) return null;
  return Math.max(monotonicAge, wallAge ?? 0);
}

export function getHealthView(receipt: HealthReceipt | null, now: number, requestError = false, wallNow?: number): HealthView {
  if (!receipt) return { availability: requestError ? "error" : "unknown", sample: null, receiptAgeMs: null, prices: "warn", snapshots: "warn", feed: "warn", tree: "warn", pricesAgeMs: null, snapshotsAgeMs: null, feedAgeMs: null };
  const receiptAgeMs = projectedReceiptAge(receipt, now, wallNow);
  const expired = receiptAgeMs === null || receiptAgeMs >= MAX_CLIENT_RECEIPT_AGE_MS;
  const unavailable = requestError || expired;
  const sample = receipt.sample;
  const degraded = sample.status === "degraded";
  const pricesAgeMs = elapsed(sample.hlWs.msSinceLastMessage, receiptAgeMs);
  const snapshotsAgeMs = elapsed(sample.snapshotAgeMs, receiptAgeMs);
  const feedAgeMs = elapsed(sample.feedAgeMs, receiptAgeMs);
  const prices: HealthTone = sample.hlWs.connected && pricesAgeMs !== null && pricesAgeMs < 10_000 ? "ok" : "warn";
  const snapshots = tone(snapshotsAgeMs, 3 * 60_000, 10 * 60_000);
  const feed = tone(feedAgeMs, 30 * 60_000, 3 * 3600_000);
  const tree: HealthTone = sample.treeWs.connected && sample.treeWs.authed ? "ok" : "warn";
  const qualify = (v: HealthTone): HealthTone => (unavailable || degraded) && v === "ok" ? "warn" : v;
  return { availability: unavailable ? (expired ? "expired" : "error") : "usable", sample, receiptAgeMs, prices: qualify(prices), snapshots: qualify(snapshots), feed: qualify(feed), tree: qualify(tree), pricesAgeMs, snapshotsAgeMs, feedAgeMs };
}

export const HEALTH_RECEIPT_EXPIRY_MS = MAX_CLIENT_RECEIPT_AGE_MS;
