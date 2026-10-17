import { parseSignalSnapshot } from "@/lib/signalSnapshot";
import type { Signal } from "@/lib/signals";

// Matches the incumbent scan cache TTL; this is display metadata, not eligibility.
export const SIGNAL_CACHE_TTL_MS = 55_000;
export type SignalSnapshotStatus = "unknown" | "current" | "partial" | "stale" | "unavailable";
export interface SignalSnapshotRead {
  signals: Signal[];
  generatedAt: number | null;
  stale: boolean | null;
  malformedRows: number;
  receivedAt?: number;
  receivedMonotonicAt?: number;
}
export interface SignalSnapshotView extends SignalSnapshotRead { status: SignalSnapshotStatus; ageMs: number | null; }

function header(headers: Headers | Record<string, string | null>, name: string): string | null {
  return headers instanceof Headers ? headers.get(name) : headers[name] ?? null;
}
function generatedAtValue(raw: string | null, now: number): number | null {
  if (raw === null || !/^\d+$/.test(raw) || !Number.isFinite(now)) return null;
  const value = Number(raw);
  // Reject at receipt, permanently for this sample: waiting cannot validate it.
  return Number.isSafeInteger(value) && value > 0 && value <= now ? value : null;
}
function staleValue(raw: string | null): boolean | null { return raw === "true" ? true : raw === "false" ? false : null; }

export function parseSignalSnapshotResponse(body: unknown, headers: Headers | Record<string, string | null>, now: number, monotonicNow?: number): SignalSnapshotRead {
  const signals = parseSignalSnapshot(body, now);
  const rawRows = Array.isArray(body) ? body.length : signals.length;
  return {
    signals,
    generatedAt: generatedAtValue(header(headers, "X-Data-Generated-At"), now),
    stale: staleValue(header(headers, "X-Data-Stale")),
    malformedRows: Math.max(0, rawRows - signals.length),
    receivedAt: now,
    ...(monotonicNow !== undefined ? { receivedMonotonicAt: monotonicNow } : {}),
  };
}

export function ageSignalSnapshot(read: SignalSnapshotRead, now: number, unavailable = false, monotonicNow?: number): SignalSnapshotView {
  let ageMs: number | null = null;
  if (read.generatedAt !== null && Number.isFinite(now) && now >= read.generatedAt) {
    const wallValid = read.receivedAt === undefined || (Number.isFinite(read.receivedAt) && now >= read.receivedAt);
    const monotonicValid = read.receivedMonotonicAt === undefined || (
      Number.isFinite(read.receivedMonotonicAt) && read.receivedMonotonicAt >= 0 && Number.isFinite(monotonicNow) &&
      monotonicNow! >= read.receivedMonotonicAt
    );
    if (wallValid && monotonicValid) {
      const sourceAgeAtReceipt = read.receivedAt === undefined ? 0 : read.receivedAt - read.generatedAt;
      const monotonicElapsed = read.receivedMonotonicAt === undefined ? 0 : monotonicNow! - read.receivedMonotonicAt;
      ageMs = Math.max(now - read.generatedAt, sourceAgeAtReceipt + monotonicElapsed);
    }
  }
  const metadataKnown = read.generatedAt !== null && read.stale !== null;
  let status: SignalSnapshotStatus = unavailable ? "unavailable" : "unknown";
  if (!unavailable && metadataKnown && ageMs !== null) {
    status = read.stale || ageMs >= SIGNAL_CACHE_TTL_MS ? "stale" : read.malformedRows > 0 ? "partial" : "current";
  }
  return { ...read, status, ageMs };
}

export function signalSnapshotStatusText(view: SignalSnapshotView): string {
  const base = view.status === "unavailable"
    ? "Signal snapshot unavailable — retaining last-known rows"
    : view.status === "unknown"
      ? "Signal snapshot availability unknown"
      : view.status === "stale"
        ? "Signal snapshot stale — retaining last-known rows"
        : view.status === "partial"
          ? "Partial cached signal snapshot"
          : "Current cached signal snapshot";
  if (view.malformedRows > 0) {
    const omitted = `${view.malformedRows} malformed row${view.malformedRows === 1 ? "" : "s"} omitted`;
    return `${base} — ${view.signals.length === 0 ? "No usable signal rows; " : ""}${omitted}`;
  }
  if (view.signals.length === 0) {
    return `${base} — ${view.status === "current" ? "zero cached signals" : "No usable signal rows; empty coverage not established"}`;
  }
  return base;
}
