import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseSignalSnapshot } from "@/lib/signalSnapshot";
import type { Signal } from "@/lib/signals";

const NOW = 1_800_000_000_000;

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    symbol: "BTC",
    type: "breakout_up",
    family: "structure",
    direction: "bullish",
    value: 1,
    label: "Range breakout",
    firedAt: NOW - 60_000,
    timeframe: "4h",
    ...overrides,
  };
}

test("signal snapshots reject malformed envelopes", () => {
  for (const payload of [null, {}, "signals", 1]) {
    assert.throws(() => parseSignalSnapshot(payload, NOW), /invalid signal snapshot/i);
  }
});

test("signal snapshots drop malformed rows and invalid timestamps", () => {
  const valid = signal();
  const parsed = parseSignalSnapshot([
    valid,
    null,
    signal({ firedAt: Number.NaN }),
    signal({ firedAt: Number.POSITIVE_INFINITY }),
    signal({ firedAt: -1 }),
    signal({ firedAt: NOW + 5 * 60_000 + 1 }),
    signal({ value: Number.NaN }),
    { ...valid, symbol: 42 },
  ], NOW);

  assert.deepEqual(parsed, [valid]);
});

test("signal snapshots tolerate small clock skew", () => {
  const slightlyFuture = signal({ firedAt: NOW + 5 * 60_000 });
  assert.deepEqual(parseSignalSnapshot([slightlyFuture], NOW), [slightlyFuture]);
});