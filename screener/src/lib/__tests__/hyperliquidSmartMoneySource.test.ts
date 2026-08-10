import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLeaderboardRows,
  classifyVaultStats,
  fetchLeaderboardSource,
  fetchTextWithTimeout,
  parseClearinghouseSnapshot,
  parseFundingContext,
  parseLeaderboardCandidates,
  parseVaultStats,
  validateDuplicateSourceRows,
  validateMalformedSourceRows,
  validateSourceRowCount,
} from "../hyperliquidSmartMoneySource";

test("smart-money source parsers quarantine vanity rows and normalize live evidence", () => {
  const leaderboard = [
    {
      ethAddress: "0x1111111111111111111111111111111111111111",
      accountValue: "1000000",
      windowPerformances: [
        ["week", { pnl: "10000", roi: "0.01", vlm: "1000000" }],
        ["month", { pnl: "50000", roi: "0.05", vlm: "5000000" }],
        ["allTime", { pnl: "200000", roi: "0.2", vlm: "30000000" }],
      ],
    },
    {
      ethAddress: "0x2222222222222222222222222222222222222222",
      accountValue: "2000000",
      windowPerformances: [
        ["week", { pnl: "10000", roi: "0.01", vlm: "0" }],
        ["month", { pnl: "50000", roi: "0.05", vlm: "0" }],
        ["allTime", { pnl: "200000", roi: "0.2", vlm: "0" }],
      ],
    },
  ];
  const candidates = parseLeaderboardCandidates({ leaderboardRows: leaderboard }, 50);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].address, leaderboard[0].ethAddress);

  const observedAt = Date.UTC(2026, 6, 31, 12);
  const wallet = parseClearinghouseSnapshot({
    marginSummary: { accountValue: "1000000" },
    assetPositions: [{ position: {
      coin: "xyz:SKHX",
      szi: "10",
      positionValue: "500000",
      entryPx: "12.5",
      unrealizedPnl: "2500",
      leverage: { value: 3 },
    } }],
  }, leaderboard[0].ethAddress, observedAt);
  assert.equal(wallet.accountValue, 1_000_000);
  assert.equal(wallet.positions[0].coin, "xyz:SKHX");
  assert.equal(wallet.positions[0].positionValue, 500_000);

  const vaults = parseVaultStats([
    {
      apr: 0.2,
      pnls: [["allTime", ["0", "250000"]]],
      summary: {
        name: "Evidence Vault",
        vaultAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        leader: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        tvl: "5000000",
        isClosed: false,
        relationship: { type: "normal" },
      },
    },
    {
      apr: 0,
      pnls: [["allTime", ["0", "0"]]],
      summary: {
        name: "Child",
        vaultAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
        leader: "0xdddddddddddddddddddddddddddddddddddddddd",
        tvl: "10000000",
        isClosed: false,
        relationship: { type: "child" },
      },
    },
  ], observedAt, 50);
  assert.equal(vaults.length, 1);
  assert.equal(vaults[0].cumulativePnl, 250_000);
  assert.equal(vaults[0].relationshipType, "normal");

  const funding = parseFundingContext([
    { universe: [{ name: "BTC" }, { name: "ETH" }] },
    [{ funding: "0.00001" }, { funding: "-0.00002" }],
  ], ["BTC", "ETH"]);
  assert.deepEqual(funding.map(({ symbol, rateHourly }) => ({ symbol, rateHourly })), [
    { symbol: "BTC", rateHourly: 0.00001 },
    { symbol: "ETH", rateHourly: -0.00002 },
  ]);

  const nativeOnlyFunding = parseFundingContext([
    { universe: [{ name: "xyz:BTC" }, { name: "BTC" }] },
    [{ funding: "0.5" }, { funding: "0.00001" }],
  ], ["BTC"]);
  assert.deepEqual(nativeOnlyFunding.map((row: { symbol: string; rateHourly: number }) => ({
    symbol: row.symbol,
    rateHourly: row.rateHourly,
  })), [
    { symbol: "BTC", rateHourly: 0.00001 },
  ]);
});

test("smart-money parsers reject malformed financial scalars instead of accepting numeric prefixes", () => {
  const address = "0x1111111111111111111111111111111111111111";
  const performances = [
    ["week", { pnl: "10000", roi: "0.01", vlm: "1000000" }],
    ["month", { pnl: "50000junk", roi: "0.05", vlm: "5000000" }],
    ["allTime", { pnl: "200000", roi: "0.2", vlm: "30000000" }],
  ];
  const quarantinedLeaderboard = classifyLeaderboardRows([{
    ethAddress: address,
    accountValue: "1000000",
    windowPerformances: performances,
  }]);
  assert.equal(quarantinedLeaderboard.malformedRowCount, 1);
  assert.equal(quarantinedLeaderboard.candidates.length, 0);
  assert.match(quarantinedLeaderboard.malformedRows[0].reason, /invalid financial scalar/);

  assert.throws(() => parseClearinghouseSnapshot({
    marginSummary: { accountValue: "1000000" },
    assetPositions: [{ position: {
      coin: "xyz:SKHX",
      szi: "10junk",
      positionValue: "500000",
      unrealizedPnl: "0",
    } }],
  }, address, Date.UTC(2026, 6, 31, 12)), /malformed position row/);

  assert.throws(() => parseVaultStats([{
    apr: "0.2",
    pnls: [["allTime", ["0", "250000junk"]]],
    summary: {
      name: "Malformed",
      vaultAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      leader: address,
      tvl: "5000000",
      isClosed: false,
      relationship: { type: "normal" },
    },
  }], Date.UTC(2026, 6, 31, 12)), /malformed vault row/);

  assert.throws(() => parseVaultStats([{
    apr: "0.2junk",
    pnls: [["allTime", ["0", "250000"]]],
    summary: {
      name: "Malformed excluded child",
      vaultAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      leader: address,
      tvl: "10000000",
      isClosed: false,
      relationship: { type: "child" },
    },
  }], Date.UTC(2026, 6, 31, 12)), /malformed vault row/);

  assert.throws(() => parseFundingContext([
    { universe: [{ name: "BTC" }] },
    [{ funding: "0.00001junk" }],
  ], ["BTC"]), /malformed funding row/);
});

test("source completeness preserves upstream totals and rejects suspicious truncation", () => {
  const leaderboard = classifyLeaderboardRows({ leaderboardRows: [{
    ethAddress: "0x1111111111111111111111111111111111111111",
    accountValue: "1000000",
    windowPerformances: [
      ["week", { pnl: "10000", roi: "0.01", vlm: "1000000" }],
      ["month", { pnl: "50000", roi: "0.05", vlm: "5000000" }],
      ["allTime", { pnl: "200000", roi: "0.2", vlm: "30000000" }],
    ],
  }] });
  assert.equal(leaderboard.sourceRowCount, 1);

  const vaults = classifyVaultStats([{
    apr: 0.2,
    pnls: [["allTime", ["0", "250000"]]],
    summary: {
      name: "Evidence Vault",
      vaultAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      leader: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      tvl: "5000000",
      isClosed: false,
      relationship: { type: "normal" },
    },
  }], Date.UTC(2026, 6, 31, 12), 50);
  assert.deepEqual({ source: vaults.sourceRowCount, eligible: vaults.vaults.length }, {
    source: 1,
    eligible: 1,
  });

  assert.doesNotThrow(() => validateSourceRowCount("leaderboard", 41_004));
  assert.doesNotThrow(() => validateSourceRowCount("vaults", 9_466, 9_500));
  assert.throws(() => validateSourceRowCount("leaderboard", 999), /unexpectedly sparse/);
  assert.throws(() => validateSourceRowCount("vaults", 8_000, 9_466), /dropped more than/);
  assert.doesNotThrow(() => validateMalformedSourceRows("leaderboard", 41_000, 4));
  assert.throws(() => validateMalformedSourceRows("leaderboard", 41_000, 50), /malformed/);
});

test("duplicate source identities fail closed before persistence", () => {
  const row = {
    ethAddress: "0x1111111111111111111111111111111111111111",
    accountValue: "1000000",
    windowPerformances: [
      ["week", { pnl: "10000", roi: "0.01", vlm: "1000000" }],
      ["month", { pnl: "50000", roi: "0.05", vlm: "5000000" }],
      ["allTime", { pnl: "200000", roi: "0.2", vlm: "30000000" }],
    ],
  };
  const duplicateLeaderboard = classifyLeaderboardRows({ leaderboardRows: [row, row] });
  assert.equal(duplicateLeaderboard.duplicateAddressCount, 1);
  assert.throws(
    () => validateDuplicateSourceRows("leaderboard", duplicateLeaderboard.duplicateAddressCount),
    /duplicate stable identities/,
  );

  const vault = {
    apr: 0.2,
    pnls: [["allTime", ["0", "250000"]]],
    summary: {
      name: "Duplicate",
      vaultAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      leader: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      tvl: "5000000",
      isClosed: false,
      relationship: { type: "normal" },
    },
  };
  assert.throws(
    () => classifyVaultStats([vault, vault], Date.UTC(2026, 6, 31, 12)),
    /duplicate vault address/,
  );
});

test("raw leaderboard bytes are archived before validation can fail", async () => {
  const originalFetch = globalThis.fetch;
  let archived = false;
  globalThis.fetch = async () => new Response(JSON.stringify({ leaderboardRows: [] }), { status: 200 });
  try {
    await assert.rejects(
      fetchLeaderboardSource(1, ({ rawText }) => {
        archived = rawText.includes("leaderboardRows");
        return "/immutable/source.json.gz";
      }),
      /unexpectedly sparse/,
    );
    assert.equal(archived, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed JSON is archived before parsing fails", async () => {
  const originalFetch = globalThis.fetch;
  let archived = false;
  globalThis.fetch = async () => new Response("{truncated", { status: 200 });
  try {
    await assert.rejects(
      fetchLeaderboardSource(1, ({ rawText }) => {
        archived = rawText === "{truncated";
        return "/immutable/malformed-source.json.gz";
      }),
      /invalid JSON.*malformed-source/,
    );
    assert.equal(archived, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP timeout remains active while the response body is consumed", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async (_input, init) => ({
    ok: true,
    status: 200,
    text: () => new Promise<string>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
    }),
  }) as Response) as typeof fetch;

  await assert.rejects(
    () => fetchTextWithTimeout("https://example.test/stalled-body", {}, 5),
    /body aborted/,
  );
});
