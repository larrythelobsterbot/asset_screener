import assert from "node:assert/strict";
import test from "node:test";
import {
  createVisitBaseline,
  diffSinceVisit,
  getBrowserStorage,
  loadVisitBaseline,
  serializeVisitBaseline,
  type VisitStorage,
} from "../rotationVisit";

function storage(initial: string | null = null): VisitStorage {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
    removeItem: () => { value = null; },
  };
}

test("visit baseline is versioned, identity-keyed, and compares normalized quantities", () => {
  const previous = [{
    identity: "native:native:BTC",
    symbol: "BTC",
    kind: "native" as const,
    dex: null,
    wireCoin: "BTC",
    historyKey: "BTC",
    ts: 1_000,
    price: 100,
    oi: 10,
  }];
  const current = [{
    identity: "native:native:BTC",
    symbol: "BTC",
    kind: "native" as const,
    dex: null,
    wireCoin: "BTC",
    historyKey: "BTC",
    ts: 2_000,
    price: 110,
    oi: 12,
  }];
  const baseline = createVisitBaseline(previous, 1_000);
  const parsed = loadVisitBaseline(serializeVisitBaseline(baseline), 2_000);
  assert.equal(parsed.status, "ready");
  if (parsed.status !== "ready") return;
  const diff = diffSinceVisit(current, parsed.baseline);
  assert.equal(diff.get("native:native:BTC")?.pricePct, 10);
  assert.equal(diff.get("native:native:BTC")?.oiPct, 20);
});

test("malformed, future, stale, and oversized storage is blocked safely", () => {
  assert.equal(loadVisitBaseline("{not-json", 1_000).status, "invalid");
  const future = JSON.stringify({ version: 1, capturedAt: 1_000_000, entries: [] });
  assert.equal(loadVisitBaseline(future, 1_000).status, "invalid");
  const stale = JSON.stringify({ version: 1, capturedAt: 0, entries: [] });
  assert.equal(loadVisitBaseline(stale, 20 * 86_400_000).status, "stale");
  assert.equal(loadVisitBaseline("x".repeat(250_000), 1_000).status, "invalid");
});

test("future or expired row timestamps cannot become a baseline", () => {
  const entry = { identity: "native:native:X", symbol: "X", kind: "native" as const, dex: null, wireCoin: "X", historyKey: "X", ts: 1_000, price: 10, oi: 1 };
  const future = createVisitBaseline([{ ...entry, ts: 1_000_000 }], 1_000);
  assert.equal(loadVisitBaseline(serializeVisitBaseline(future), 1_000).status, "invalid");
  const expired = createVisitBaseline([entry], 1_000);
  assert.equal(loadVisitBaseline(serializeVisitBaseline(expired), 20 * 86_400_000).status, "stale");
});

test("storage lifecycle does not replace a frozen entry baseline during polling", () => {
  const store = storage();
  const first = createVisitBaseline([{ identity: "native:native:ETH", symbol: "ETH", kind: "native", dex: null, wireCoin: "ETH", historyKey: "ETH", ts: 100, price: 10, oi: 2 }], 100);
  store.setItem("rotation", serializeVisitBaseline(first));
  const frozen = loadVisitBaseline(store.getItem("rotation"), 200);
  const later = createVisitBaseline([{ identity: "native:native:ETH", symbol: "ETH", kind: "native", dex: null, wireCoin: "ETH", historyKey: "ETH", ts: 300, price: 11, oi: 3 }], 300);
  // The caller may persist `later` for the next session, but its loaded `frozen`
  // object remains unchanged for this session's since-visit comparison.
  store.setItem("rotation", serializeVisitBaseline(later));
  assert.equal(frozen.status, "ready");
  if (frozen.status === "ready") assert.equal(frozen.baseline.entries[0].price, 10);
});

test("identity changes do not compare venues sharing a ticker", () => {
  const baseline = createVisitBaseline([{ identity: "hip3:xyz:xyz:TSLA", symbol: "TSLA", kind: "hip3", dex: "xyz", wireCoin: "xyz:TSLA", historyKey: "TSLA", ts: 100, price: 10, oi: 2 }], 100);
  const current = [{ identity: "hip3:km:km:TSLA", symbol: "TSLA", kind: "hip3" as const, dex: "km", wireCoin: "km:TSLA", historyKey: "TSLA", ts: 200, price: 20, oi: 4 }];
  assert.equal(diffSinceVisit(current, baseline).has("hip3:km:km:TSLA"), false);
});

test("blocked localStorage accessor fails closed before getItem", () => {
  const target = globalThis as typeof globalThis & { window?: unknown };
  const original = Object.getOwnPropertyDescriptor(target, "window");
  Object.defineProperty(target, "window", {
    configurable: true,
    get() { throw new Error("storage blocked"); },
  });
  try {
    assert.equal(getBrowserStorage(), null);
  } finally {
    if (original) Object.defineProperty(target, "window", original);
    else delete (target as Record<string, unknown>).window;
  }
});
