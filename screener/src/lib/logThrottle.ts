export function shouldLogChangedOrExpired(
  previousSignature: string | null,
  nextSignature: string,
  lastLoggedAt: number,
  now: number,
  intervalMs: number,
): boolean {
  return previousSignature == null
    || previousSignature !== nextSignature
    || now - lastLoggedAt >= intervalMs;
}
