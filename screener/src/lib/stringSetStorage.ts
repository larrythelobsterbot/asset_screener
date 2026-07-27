const STORAGE_VERSION = 1;

interface StoredStringSet {
  version: typeof STORAGE_VERSION;
  values: string[];
}

function isSafeValue(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function parseStoredStringSet(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);

    // Version-0 migration for the arrays used by the original hooks.
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter(isSafeValue));
    }

    if (typeof parsed !== "object" || parsed === null) return new Set();
    const envelope = parsed as Partial<StoredStringSet>;
    if (envelope.version !== STORAGE_VERSION || !Array.isArray(envelope.values)) {
      return new Set();
    }
    if (!envelope.values.every(isSafeValue)) return new Set();
    return new Set(envelope.values);
  } catch {
    return new Set();
  }
}

export function serializeStringSet(values: Set<string>): string {
  const envelope: StoredStringSet = {
    version: STORAGE_VERSION,
    values: [...values].filter(isSafeValue),
  };
  return JSON.stringify(envelope);
}
