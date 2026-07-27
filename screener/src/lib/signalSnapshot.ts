import type { Signal } from "@/lib/signals";

const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSignalRow(value: unknown, now: number): value is Signal {
  if (!isRecord(value)) return false;
  if (typeof value.symbol !== "string" || value.symbol.trim() === "") return false;
  if (typeof value.type !== "string" || value.type === "") return false;
  if (typeof value.family !== "string" || value.family === "") return false;
  if (value.direction !== "bullish" && value.direction !== "bearish") return false;
  if (typeof value.value !== "number" || !Number.isFinite(value.value)) return false;
  if (typeof value.label !== "string" || value.label.trim() === "") return false;
  if (
    typeof value.firedAt !== "number"
    || !Number.isFinite(value.firedAt)
    || value.firedAt <= 0
    || value.firedAt > now + MAX_FUTURE_CLOCK_SKEW_MS
  ) return false;
  if (
    value.strength !== undefined
    && (typeof value.strength !== "number" || !Number.isFinite(value.strength))
  ) return false;
  return true;
}

/** Keep malformed cache rows out of every signal consumer, not just Ideas. */
export function parseSignalSnapshot(value: unknown, now = Date.now()): Signal[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid signal snapshot: expected an array");
  }
  return value.filter((row): row is Signal => isSignalRow(row, now));
}