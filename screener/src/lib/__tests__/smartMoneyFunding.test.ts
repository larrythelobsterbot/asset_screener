import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FUNDING_POLICY_V1,
  collectUserFundingRange,
  fundingBaseWindows,
  fundingPaymentKey,
  parseUserFundingResponse,
  type RawUserFundingSource,
} from "../smartMoneyFunding";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const ZERO_HASH = `0x${"0".repeat(64)}`;

function raw(rows: unknown[]): RawUserFundingSource {
  const rawText = JSON.stringify(rows);
  return {
    rawText,
    byteLength: Buffer.byteLength(rawText),
    sha256: "a".repeat(64),
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    delta: {
      type: "funding",
      coin: "BTC",
      usdc: "-3.625312",
      szi: "49.1477",
      fundingRate: "0.0000417",
      nSamples: null,
    },
    hash: ZERO_HASH,
    time: 1_000,
    ...overrides,
  };
}

test("userFunding parser preserves signed payments, zero hashes, and HIP-3 market identity", () => {
  const parsed = parseUserFundingResponse({
    address: ADDRESS,
    startTime: 900,
    endTime: 1_100,
    rawText: JSON.stringify([
      row(),
      row({
        time: 1_001,
        delta: {
          type: "funding",
          coin: "xyz:XYZ100",
          usdc: "2.378343",
          szi: "-15.0",
          fundingRate: "0.00000625",
          nSamples: 3,
        },
      }),
    ]),
  });

  assert.deepEqual(parsed, [
    {
      address: ADDRESS,
      time: 1_000,
      coin: "BTC",
      usdc: -3.625312,
      szi: 49.1477,
      fundingRate: 0.0000417,
      nSamples: null,
      hash: ZERO_HASH,
    },
    {
      address: ADDRESS,
      time: 1_001,
      coin: "xyz:XYZ100",
      usdc: 2.378343,
      szi: -15,
      fundingRate: 0.00000625,
      nSamples: 3,
      hash: ZERO_HASH,
    },
  ]);
  assert.notEqual(fundingPaymentKey(parsed[0]), fundingPaymentKey(parsed[1]));
});

test("userFunding parser fails closed on malformed and out-of-window evidence", () => {
  assert.throws(() => parseUserFundingResponse({
    address: ADDRESS,
    startTime: 900,
    endTime: 1_100,
    rawText: JSON.stringify([row({ time: 899 })]),
  }), /outside requested window/i);
  assert.throws(() => parseUserFundingResponse({
    address: ADDRESS,
    startTime: 900,
    endTime: 1_100,
    rawText: JSON.stringify([row({ hash: "0x1234" })]),
  }), /hash/i);
  assert.throws(() => parseUserFundingResponse({
    address: ADDRESS,
    startTime: 900,
    endTime: 1_100,
    rawText: JSON.stringify([row({
      delta: { type: "funding", coin: "BTC", usdc: "NaN", szi: "1", fundingRate: "0.1", nSamples: null },
    })]),
  }), /usdc/i);
  assert.throws(() => parseUserFundingResponse({
    address: ADDRESS,
    startTime: 900,
    endTime: 1_100,
    rawText: JSON.stringify([row({
      delta: { type: "deposit", coin: "BTC", usdc: "1", szi: "1", fundingRate: "0.1", nSamples: null },
    })]),
  }), /funding/i);
  assert.throws(() => parseUserFundingResponse({
    address: ADDRESS,
    startTime: 900,
    endTime: 1_100,
    rawText: JSON.stringify([row({
      delta: { type: "funding", coin: "BTC", usdc: "0x10", szi: "1", fundingRate: "0.1", nSamples: null },
    })]),
  }), /numeric string/i);
});

test("funding windows cover a trailing day in inclusive six-hour slices", () => {
  const hour = 3_600_000;
  assert.deepEqual(fundingBaseWindows(0, 24 * hour, 6 * hour), [
    { startTime: 0, endTime: 6 * hour },
    { startTime: 6 * hour, endTime: 12 * hour },
    { startTime: 12 * hour, endTime: 18 * hour },
    { startTime: 18 * hour, endTime: 24 * hour },
  ]);
});

test("range collector bisects capped windows and deduplicates inclusive boundaries", async () => {
  const calls: Array<[number, number]> = [];
  const boundary = row({ time: 50 });
  const fetchWindow = async (_address: string, startTime: number, endTime: number) => {
    calls.push([startTime, endTime]);
    if (startTime === 0 && endTime === 100) return raw(Array.from({ length: FUNDING_POLICY_V1.responseCap }, () => boundary));
    if (startTime === 0 && endTime === 50) return raw([boundary]);
    if (startTime === 50 && endTime === 100) return raw([boundary, row({ time: 75, delta: {
      type: "funding", coin: "xyz:XYZ100", usdc: "2", szi: "-3", fundingRate: "0.01", nSamples: null,
    } })]);
    throw new Error(`unexpected window ${startTime}-${endTime}`);
  };

  const result = await collectUserFundingRange({
    address: ADDRESS,
    startTime: 0,
    endTime: 100,
    baseWindowMs: 100,
    fetchWindow,
    archiveSource: (_source, startTime, endTime) => `/archive/${startTime}-${endTime}.json.gz`,
  });

  assert.deepEqual(calls, [[0, 100], [0, 50], [50, 100]]);
  assert.equal(result.windows.filter(({ status }) => status === "saturated").length, 1);
  assert.equal(result.windows.filter(({ status }) => status === "complete").length, 2);
  assert.deepEqual(result.payments.map(({ time, coin }) => [time, coin]), [[50, "BTC"], [75, "xyz:XYZ100"]]);
});

test("range collector rejects conflicting overlap and unresolved saturation", async () => {
  await assert.rejects(() => collectUserFundingRange({
    address: ADDRESS,
    startTime: 0,
    endTime: 100,
    baseWindowMs: 50,
    fetchWindow: async (_address, startTime, endTime) => raw([
      row({ time: startTime === 0 ? endTime : startTime, delta: {
        type: "funding", coin: "BTC", usdc: startTime === 0 ? "1" : "2", szi: "1", fundingRate: "0.01", nSamples: null,
      } }),
    ]),
    archiveSource: () => "/archive/conflict.json.gz",
  }), /conflicting duplicate/i);

  await assert.rejects(() => collectUserFundingRange({
    address: ADDRESS,
    startTime: 0,
    endTime: 1,
    baseWindowMs: 1,
    fetchWindow: async () => raw(Array.from({ length: FUNDING_POLICY_V1.responseCap }, () => row({ time: 0 }))),
    archiveSource: () => "/archive/saturated.json.gz",
  }), /unresolved saturation/i);
});

test("range collector archives raw source before rejecting malformed evidence", async () => {
  let archived = false;
  await assert.rejects(() => collectUserFundingRange({
    address: ADDRESS,
    startTime: 0,
    endTime: 100,
    baseWindowMs: 100,
    fetchWindow: async () => ({
      rawText: "not-json",
      byteLength: 8,
      sha256: "a".repeat(64),
    }),
    archiveSource: () => {
      archived = true;
      return "/archive/malformed.json.gz";
    },
  }), /valid JSON/i);
  assert.equal(archived, true);
});
