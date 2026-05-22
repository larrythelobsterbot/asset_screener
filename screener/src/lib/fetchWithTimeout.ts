// Tiny fetch wrapper that bounds request duration with AbortController.
//
// Why: by default, Node's fetch will hang as long as the upstream takes.
// In a single-process Next.js app, one slow upstream pins the route
// handler indefinitely and blocks every concurrent caller of the same
// endpoint. Wrapping every outbound integration with a hard timeout
// keeps the worst case bounded.
//
// Usage:
//   await fetchWithTimeout(url, { method: "POST", body: ... }, 10_000);
// The third arg is timeout in ms; defaults to 15s. AbortError surfaces
// as a normal exception so callers' existing try/catch paths handle it.

export const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  // If the caller already passed an AbortSignal, respect it but compose
  // with our timeout — whichever aborts first wins.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  // Compose external signal: if it aborts, propagate to our controller.
  const external = init.signal;
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener("abort", () => ctrl.abort(external.reason), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
