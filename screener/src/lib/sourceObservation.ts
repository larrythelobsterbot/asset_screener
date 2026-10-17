import { cache } from "./cache";

export interface ObservedSource<T> {
  data: T;
  observedAt: number;
  stale: boolean;
  failed: boolean;
}

/** Future/unknown observation times are unavailable, never zero-age. */
export function sourceAgeMs(observedAt: number | null | undefined, now = Date.now()): number | null {
  if (observedAt == null || !Number.isFinite(observedAt) || observedAt < 0 || !Number.isFinite(now) || observedAt > now) return null;
  const age = now - observedAt;
  return Number.isFinite(age) ? age : null;
}

/**
 * Bind metadata to the exact object returned by a stale-while-refresh loader.
 * Retain the before-read snapshot: a refresh may replace the cache before the
 * awaiting caller resumes. Prefer that snapshot on identity reuse (conservative).
 */
export async function loadObservedSource<T>(key: string, load: () => Promise<T>, maxAgeMs: number): Promise<ObservedSource<T>> {
  const before = cache.getInfo<T>(key);
  let data: T;
  let failed = false;
  try { data = await load(); }
  catch {
    const fallback = cache.getInfo<T>(key);
    const age = sourceAgeMs(fallback?.createdAt);
    if (!fallback || age == null || age > maxAgeMs) throw new Error(`Source unavailable: ${key}`);
    data = fallback.data;
    failed = true;
  }
  const after = cache.getInfo<T>(key);
  const observed = before?.data === data ? before : after?.data === data ? after : null;
  const now = Date.now();
  const age = sourceAgeMs(observed?.createdAt, now);
  if (!observed || age == null || age > maxAgeMs) throw new Error(`Source observation unavailable: ${key}`);
  return { data, observedAt: observed.createdAt, failed, stale: failed || now > observed.expiresAt };
}
