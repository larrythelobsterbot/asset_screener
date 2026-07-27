type SafeStorage = Pick<Storage, "getItem" | "setItem">;
type StorageAccessor = () => SafeStorage;

/** Read browser storage without allowing privacy/security failures into UI state. */
export function readStorage(getStorage: StorageAccessor, key: string): string | null {
  try {
    return getStorage().getItem(key);
  } catch {
    return null;
  }
}

/** Persist UI preferences opportunistically; in-memory state remains authoritative. */
export function writeStorage(
  getStorage: StorageAccessor,
  key: string,
  value: string,
): void {
  try {
    getStorage().setItem(key, value);
  } catch {
    // Storage may be unavailable or full. The UI must continue in memory.
  }
}
