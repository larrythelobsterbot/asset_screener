import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PILOT_COHORT_POLICY_V1,
  PILOT_EVENT_POLICY_V3 as PILOT_EVENT_POLICY_V1,
  detectSmartMoneyEvents as detectSmartMoneyEventsScoped,
  deriveWalletPerformanceEvidence,
  evaluateWalletForSmartCohort,
  formatDailySmartMoneyDigest,
  formatSmartMoneyAlertDraft,
  formatWeeklySmartMoneyHonestyReport,
  type HyperliquidPortfolio,
  type SmartMoneyEventCandidate,
  type VaultSnapshot,
  type WalletPositionSnapshot,
  type WalletPerformanceEvidence,
} from "../smartMoneyPilot";

type EventDetectionInput = Parameters<typeof detectSmartMoneyEventsScoped>[0];

function detectSmartMoneyEvents(
  input: Omit<EventDetectionInput, "cohortVersionKey">,
): ReturnType<typeof detectSmartMoneyEventsScoped> {
  return detectSmartMoneyEventsScoped({ ...input, cohortVersionKey: "cohort-fixture-a" });
}

function evidence(overrides: Partial<WalletPerformanceEvidence> = {}): WalletPerformanceEvidence {
  const observedAt = Date.UTC(2026, 6, 31, 12);
  return {
    address: "0x1111111111111111111111111111111111111111",
    observedAt,
    trackStartAt: observedAt - 180 * 86_400_000,
    liveAccountValue: 1_000_000,
    pnl7d: 30_000,
    pnl30d: 100_000,
    pnl90d: 250_000,
    roi30d: 0.1,
    volume30d: 5_000_000,
    ...overrides,
  };
}

test("smart cohort requires a 90-day record and positive 7d, 30d, and 90d performance", () => {
  const eligible = evaluateWalletForSmartCohort(evidence(), PILOT_COHORT_POLICY_V1);
  assert.equal(eligible.eligible, true);
  assert.deepEqual(eligible.reasons, []);

  const tooYoung = evaluateWalletForSmartCohort(
    evidence({ trackStartAt: evidence().observedAt - 89 * 86_400_000 }),
    PILOT_COHORT_POLICY_V1,
  );
  assert.equal(tooYoung.eligible, false);
  assert.ok(tooYoung.reasons.includes("track_record_under_90d"));

  const mixedWindows = evaluateWalletForSmartCohort(
    evidence({ pnl7d: -1, pnl30d: 100_000, pnl90d: 250_000 }),
    PILOT_COHORT_POLICY_V1,
  );
  assert.equal(mixedWindows.eligible, false);
  assert.ok(mixedWindows.reasons.includes("non_positive_7d_pnl"));
  assert.equal(mixedWindows.suspectedGaming, false);

  const vanity = evaluateWalletForSmartCohort(
    evidence({ volume30d: 0 }),
    PILOT_COHORT_POLICY_V1,
  );
  assert.equal(vanity.eligible, false);
  assert.equal(vanity.suspectedGaming, true);
});

test("portfolio histories derive bounded 7d, 30d, and 90d PnL evidence", () => {
  const observedAt = Date.UTC(2026, 6, 31, 12);
  const point = (daysAgo: number, value: number): [number, string] => [
    observedAt - daysAgo * 86_400_000,
    String(value),
  ];
  const portfolio: HyperliquidPortfolio = [
    ["week", {
      accountValueHistory: [point(7, 900_000), point(0, 1_000_000)],
      pnlHistory: [point(7, 0), point(0, 20_000)],
      vlm: "2_000_000".replace("_", ""),
    }],
    ["month", {
      accountValueHistory: [point(30, 800_000), point(0, 1_000_000)],
      pnlHistory: [point(30, 0), point(0, 90_000)],
      vlm: "5000000",
    }],
    ["allTime", {
      accountValueHistory: [point(200, 500_000), point(92, 700_000), point(0, 1_000_000)],
      pnlHistory: [point(200, 0), point(92, 150_000), point(0, 360_000)],
      vlm: "25000000",
    }],
  ];

  const derived = deriveWalletPerformanceEvidence({
    address: "0x2222222222222222222222222222222222222222",
    observedAt,
    liveAccountValue: 1_000_000,
    portfolio,
  });
  assert.ok(derived);
  assert.equal(derived?.pnl7d, 20_000);
  assert.equal(derived?.pnl30d, 90_000);
  assert.equal(derived?.pnl90d, 210_000);
  assert.equal(derived?.trackStartAt, point(200, 0)[0]);
  assert.equal(derived?.volume30d, 5_000_000);
});

function positionSnapshot(
  address: string,
  observedAt: number,
  coin: string,
  signedPositionValue: number,
): WalletPositionSnapshot {
  return {
    address,
    observedAt,
    accountValue: 10_000_000,
    positions: [{
      coin,
      szi: Math.sign(signedPositionValue),
      positionValue: Math.abs(signedPositionValue),
      leverage: 2,
    }],
  };
}

test("event detector emits a major-asset cohort positioning flip only with complete paired coverage", () => {
  const now = Date.UTC(2026, 6, 31, 12);
  const addresses = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ];
  const previous = addresses.map((address, index) =>
    positionSnapshot(address, now - 4 * 3_600_000, "BTC", index === 0 ? -2_400_000 : 0));
  const current = addresses.map((address, index) =>
    positionSnapshot(address, now, "BTC", index === 0 ? 2_600_000 : 0));

  const events = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: previous,
    currentWallets: current,
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  });
  const flip = events.find((event) => event.type === "cohort_net_flip");
  assert.ok(flip);
  assert.equal(flip?.symbol, "BTC");
  assert.equal(flip?.evidence.previousNetUsd, -2_400_000);
  assert.equal(flip?.evidence.currentNetUsd, 2_600_000);
  assert.equal(flip?.evidence.intervalHours, 4);
  assert.equal(flip?.verificationUrls.length, 3);
  assert.ok(flip?.verificationUrls.every((url: string) =>
    url.startsWith("https://app.hyperliquid.xyz/explorer/address/")));
  const cohortBFlip = detectSmartMoneyEventsScoped({
    observedAt: now,
    cohortVersionKey: "cohort-fixture-b",
    previousWallets: previous,
    currentWallets: current,
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  }).find((event) => event.type === "cohort_net_flip");
  assert.notEqual(flip?.fingerprint, cohortBFlip?.fingerprint);
  assert.equal(flip?.evidence.cohortVersionKey, "cohort-fixture-a");
  assert.equal(cohortBFlip?.evidence.cohortVersionKey, "cohort-fixture-b");

  const incomplete = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: previous.slice(0, 2),
    currentWallets: current,
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  });
  assert.equal(incomplete.length, 0, "missing paired wallet coverage must fail closed");

  const stale = detectSmartMoneyEvents({
    observedAt: now + 8 * 3_600_000,
    previousWallets: previous,
    currentWallets: current.map((snapshot) => ({
      ...snapshot,
      observedAt: now + 8 * 3_600_000,
    })),
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  });
  assert.equal(stale.length, 0, "stale position evidence must establish a new baseline");
});

test("event detector separates unusual single-wallet changes from coordinated moves", () => {
  const now = Date.UTC(2026, 6, 31, 16);
  const addresses = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ];
  const previous: WalletPositionSnapshot[] = addresses.map((address) => ({
    address,
    observedAt: now - 4 * 3_600_000,
    accountValue: 10_000_000,
    positions: [],
  }));
  const current: WalletPositionSnapshot[] = addresses.map((address, index) => ({
    address,
    observedAt: now,
    accountValue: 10_000_000,
    positions: [
      { coin: "BTC", szi: 1, positionValue: 600_000, leverage: 2 },
      ...(index === 0
        ? [{ coin: "ETH", szi: 1, positionValue: 1_500_000, leverage: 3 }]
        : []),
    ],
  }));

  const events = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: previous,
    currentWallets: current,
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  });
  const unusual = events.find((event) => event.type === "unusual_position_change");
  assert.ok(unusual);
  assert.equal(unusual?.symbol, "ETH");
  assert.equal(unusual?.address, addresses[0]);
  assert.equal(unusual?.evidence.deltaUsd, 1_500_000);
  assert.match(unusual?.verificationUrls[0] ?? "", /app\.hyperliquid\.xyz\/explorer\/address/);

  const coordinated = events.find((event) => event.type === "coordinated_position_change");
  assert.ok(coordinated);
  assert.equal(coordinated?.symbol, "BTC");
  assert.equal(coordinated?.evidence.walletCount, 3);
  assert.equal(coordinated?.evidence.deltaUsd, 1_800_000);
});

test("trade-change detector ignores mark-price movement when wallet coin sizes are unchanged", () => {
  const now = Date.UTC(2026, 6, 31, 18);
  const addresses = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ];
  const snapshot = (
    address: string,
    observedAt: number,
    positionValue: number,
  ): WalletPositionSnapshot => ({
    address,
    observedAt,
    accountValue: 10_000_000,
    positions: [{ coin: "HYPE", szi: -100_000, positionValue, leverage: 2 }],
  });

  const events = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: addresses.map((address) => snapshot(
      address,
      now - 4 * 3_600_000,
      5_000_000,
    )),
    currentWallets: addresses.map((address) => snapshot(address, now, 6_500_000)),
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  });

  assert.equal(
    events.filter((event) => event.type === "unusual_position_change").length,
    0,
  );
  assert.equal(
    events.filter((event) => event.type === "coordinated_position_change").length,
    0,
  );
});

test("trade-change detector fails closed when a nonzero current position has no usable mark", () => {
  const now = Date.UTC(2026, 6, 31, 18);
  const address = "0x1111111111111111111111111111111111111111";
  const previous: WalletPositionSnapshot = {
    address,
    observedAt: now - 4 * 3_600_000,
    accountValue: 100_000,
    positions: [{ coin: "ETH", szi: 10, positionValue: 10_000_000, leverage: 2 }],
  };
  const current: WalletPositionSnapshot = {
    address,
    observedAt: now,
    accountValue: 100_000,
    positions: [{ coin: "ETH", szi: 8, positionValue: 0, leverage: 2 }],
  };

  const events = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: [previous],
    currentWallets: [current],
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  });

  assert.equal(
    events.filter((event) => event.type === "unusual_position_change").length,
    0,
  );
});

test("trade-change detector classifies opens, closes, adds, reductions, and flips from szi", () => {
  const now = Date.UTC(2026, 6, 31, 19);
  const address = "0x1111111111111111111111111111111111111111";
  const snapshot = (
    observedAt: number,
    szi: number,
    markPrice: number,
  ): WalletPositionSnapshot => ({
    address,
    observedAt,
    accountValue: 100_000,
    positions: szi === 0
      ? []
      : [{ coin: "ETH", szi, positionValue: Math.abs(szi * markPrice), leverage: 2 }],
  });
  const cases = [
    { previousSzi: 0, currentSzi: 2, expected: "open_long", reason: "flat_to_long_size", deltaSzi: 2 },
    { previousSzi: 0, currentSzi: -2, expected: "open_short", reason: "flat_to_short_size", deltaSzi: -2 },
    { previousSzi: 2, currentSzi: 0, expected: "close_long", reason: "long_to_flat_size", deltaSzi: -2 },
    { previousSzi: -2, currentSzi: 0, expected: "close_short", reason: "short_to_flat_size", deltaSzi: 2 },
    { previousSzi: 2, currentSzi: 4, expected: "add_long", reason: "long_size_increased", deltaSzi: 2 },
    { previousSzi: 4, currentSzi: 2, expected: "reduce_long", reason: "long_size_decreased", deltaSzi: -2 },
    { previousSzi: -2, currentSzi: -4, expected: "add_short", reason: "short_size_increased", deltaSzi: -2 },
    { previousSzi: -4, currentSzi: -2, expected: "reduce_short", reason: "short_size_decreased", deltaSzi: 2 },
    { previousSzi: 2, currentSzi: -2, expected: "flip_long_to_short", reason: "long_to_short_size", deltaSzi: -4 },
    { previousSzi: -2, currentSzi: 2, expected: "flip_short_to_long", reason: "short_to_long_size", deltaSzi: 4 },
  ] as const;

  for (const testCase of cases) {
    const event = detectSmartMoneyEvents({
      observedAt: now,
      previousWallets: [snapshot(now - 4 * 3_600_000, testCase.previousSzi, 500_000)],
      currentWallets: [snapshot(now, testCase.currentSzi, 1_000_000)],
      previousVaults: [],
      currentVaults: [],
      policy: PILOT_EVENT_POLICY_V1,
    }).find((candidate) => candidate.type === "unusual_position_change");
    assert.ok(event, testCase.expected);
    const eventEvidence = event.evidence as unknown as Record<string, unknown>;
    assert.equal(eventEvidence.tradeChangeKind, testCase.expected);
    assert.equal(eventEvidence.inferenceConfidence, "medium");
    assert.deepEqual(eventEvidence.reasonCodes, ["snapshot_net_size_change", testCase.reason]);
    assert.equal(eventEvidence.previousSzi, testCase.previousSzi);
    assert.equal(eventEvidence.currentSzi, testCase.currentSzi);
    assert.equal(eventEvidence.deltaSzi, testCase.deltaSzi);
    assert.equal(eventEvidence.referenceMarkPrice, testCase.currentSzi === 0 ? 500_000 : 1_000_000);
  }

  const addLong = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: [snapshot(now - 4 * 3_600_000, 2, 500_000)],
    currentWallets: [snapshot(now, 4, 1_000_000)],
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  }).find((candidate) => candidate.type === "unusual_position_change");
  assert.equal(addLong?.evidence.previousPositionUsd, 2_000_000);
  assert.equal(addLong?.evidence.currentPositionUsd, 4_000_000);
  assert.equal(addLong?.evidence.deltaUsd, 2_000_000);
});

test("coordinated trade changes include only wallets whose coin sizes changed", () => {
  const now = Date.UTC(2026, 6, 31, 19);
  const changedAddresses = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ];
  const markOnlyAddress = "0x4444444444444444444444444444444444444444";
  const snapshot = (
    address: string,
    observedAt: number,
    szi: number,
    markPrice: number,
  ): WalletPositionSnapshot => ({
    address,
    observedAt,
    accountValue: 1_000_000,
    positions: [{ coin: "HYPE", szi, positionValue: Math.abs(szi * markPrice), leverage: 2 }],
  });

  const event = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: [
      ...changedAddresses.map((address) => snapshot(address, now - 4 * 3_600_000, -10, 500_000)),
      snapshot(markOnlyAddress, now - 4 * 3_600_000, -10, 500_000),
    ],
    currentWallets: [
      ...changedAddresses.map((address) => snapshot(address, now, -8, 500_000)),
      snapshot(markOnlyAddress, now, -10, 650_000),
    ],
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  }).find((candidate) => candidate.type === "coordinated_position_change");

  assert.ok(event);
  assert.equal(event.evidence.walletCount, 3);
  assert.deepEqual(event.evidence.wallets, changedAddresses);
  const tradeChanges = (event.evidence as unknown as {
    tradeChanges: Array<{
      address: string;
      tradeChangeKind: string;
      inferenceConfidence: string;
      reasonCodes: string[];
      previousSzi: number;
      currentSzi: number;
      deltaSzi: number;
      deltaUsd: number;
    }>;
  }).tradeChanges;
  assert.equal(tradeChanges.length, 3);
  assert.ok(tradeChanges.every((change) => change.tradeChangeKind === "reduce_short"));
  assert.ok(tradeChanges.every((change) => change.inferenceConfidence === "medium"));
  assert.ok(tradeChanges.every((change) => change.reasonCodes.includes("snapshot_net_size_change")));
  assert.ok(tradeChanges.every((change) => change.previousSzi === -10));
  assert.ok(tradeChanges.every((change) => change.currentSzi === -8));
  assert.ok(tradeChanges.every((change) => change.deltaSzi === 2));
  assert.ok(tradeChanges.every((change) => change.deltaUsd === 1_000_000));
  assert.ok(tradeChanges.every((change) => change.address !== markOnlyAddress));
});

test("coordinated HIP-3 events retain the full DEX-qualified market identity", () => {
  const now = Date.UTC(2026, 6, 31, 20);
  const addresses = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
  ];
  const events = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: addresses.map((address) => positionSnapshot(address, now - 4 * 3_600_000, "xyz:SKHX", 0)),
    currentWallets: addresses.map((address) => positionSnapshot(address, now, "xyz:SKHX", 600_000)),
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  });
  const coordinated = events.find(
    (event: SmartMoneyEventCandidate) => event.type === "coordinated_position_change",
  );
  assert.equal(coordinated?.symbol, "xyz:SKHX");
  assert.match(coordinated?.fingerprint ?? "", /xyz:SKHX/);
});

test("vault anomaly uses TVL change net of PnL and labels it as an estimate", () => {
  const now = Date.UTC(2026, 6, 31, 20);
  const vaultAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const vault = (
    observedAt: number,
    tvl: number,
    cumulativePnl: number,
  ): VaultSnapshot => ({
    vaultAddress,
    observedAt,
    name: "Evidence Vault",
    tvl,
    cumulativePnl,
    followerCount: 42,
    verificationUrl: `https://app.hyperliquid.xyz/vaults/vaultAddress/${vaultAddress}`,
  });

  const events = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: [],
    currentWallets: [],
    previousVaults: [vault(now - 4 * 3_600_000, 10_000_000, 1_000_000)],
    currentVaults: [vault(now, 12_000_000, 1_200_000)],
    policy: PILOT_EVENT_POLICY_V1,
  });
  const anomaly = events.find((event) => event.type === "vault_flow_anomaly");
  assert.ok(anomaly);
  assert.equal(anomaly?.vaultAddress, vaultAddress);
  assert.equal(anomaly?.evidence.estimatedNetDepositorFlowUsd, 1_800_000);
  assert.equal(anomaly?.evidence.pnlChangeUsd, 200_000);

  const pnlExplainsTvl = detectSmartMoneyEvents({
    observedAt: now,
    previousWallets: [],
    currentWallets: [],
    previousVaults: [vault(now - 4 * 3_600_000, 10_000_000, 1_000_000)],
    currentVaults: [vault(now, 12_000_000, 2_700_000)],
    policy: PILOT_EVENT_POLICY_V1,
  });
  assert.equal(pnlExplainsTvl.length, 0);
});

test("alert drafts are descriptive, address-shortened, and evidence-linked", () => {
  const observedAt = Date.UTC(2026, 6, 31, 16);
  const address = "0x1111111111111111111111111111111111111111";
  const event = detectSmartMoneyEvents({
    observedAt,
    previousWallets: [{ address, observedAt: observedAt - 4 * 3_600_000, accountValue: 10_000_000, positions: [] }],
    currentWallets: [positionSnapshot(address, observedAt, "ETH", 1_500_000)],
    previousVaults: [],
    currentVaults: [],
    policy: PILOT_EVENT_POLICY_V1,
  }).find((candidate) => candidate.type === "unusual_position_change");
  assert.ok(event);
  assert.equal(
    (event.evidence as unknown as Record<string, unknown>).detectorVersionKey,
    PILOT_EVENT_POLICY_V1.version,
  );

  const draft = formatSmartMoneyAlertDraft(event!, evidence({ address, observedAt }));
  assert.match(draft, /DRAFT — HUMAN REVIEW REQUIRED/);
  assert.match(draft, /0x1111…1111/);
  assert.match(draft, /90-day PnL/);
  assert.match(draft, /4\.0-hour paired interval/);
  assert.match(draft, /likely opened a long between snapshots/i);
  assert.doesNotMatch(draft, /changed .*net exposure/i);
  assert.match(draft, /https:\/\/app\.hyperliquid\.xyz\/explorer\/address\//);
  assert.match(draft, /not trade advice/i);
  assert.doesNotMatch(draft, /\b(buy|sell)\b/i);
});

test("daily digest includes positioning, evidence, funding context, and one SVG chart", () => {
  const observedAt = Date.UTC(2026, 6, 31, 20);
  const wallets = [
    positionSnapshot("0x1111111111111111111111111111111111111111", observedAt, "BTC", 2_000_000),
    positionSnapshot("0x2222222222222222222222222222222222222222", observedAt, "ETH", -1_000_000),
  ];
  const event = {
    fingerprint: "fixture",
    type: "unusual_position_change" as const,
    observedAt,
    symbol: "BTC",
    address: wallets[0].address,
    vaultAddress: null,
    verificationUrls: [`https://app.hyperliquid.xyz/explorer/address/${wallets[0].address}`],
    evidence: {
      cohortVersionKey: "cohort-fixture-a",
      detectorVersionKey: PILOT_EVENT_POLICY_V1.version,
      tradeChangeKind: "open_long" as const,
      inferenceConfidence: "medium" as const,
      reasonCodes: ["snapshot_net_size_change", "flat_to_long_size"] as const,
      previousSzi: 0,
      currentSzi: 2,
      deltaSzi: 2,
      referenceMarkPrice: 1_000_000,
      previousPositionUsd: 500_000,
      currentPositionUsd: 2_000_000,
      deltaUsd: 1_500_000,
      accountValueUsd: 10_000_000,
    },
  };

  const digest = formatDailySmartMoneyDigest({
    dateUtc: "2026-07-31",
    generatedAt: observedAt,
    currentWallets: wallets,
    events: [event],
    funding: [
      { symbol: "BTC", rateHourly: 0.0001, sourceUrl: "https://api.hyperliquid.xyz/info" },
      { symbol: "ETH", rateHourly: -0.0002, sourceUrl: "https://api.hyperliquid.xyz/info" },
    ],
    policy: PILOT_EVENT_POLICY_V1,
  });
  assert.match(digest.markdown, /Cohort positioning/);
  assert.match(digest.markdown, /Funding context/);
  assert.match(digest.markdown, /Cohort verification/);
  assert.match(digest.markdown, /likely opened a long between snapshots/i);
  assert.match(digest.markdown, /0x1111…1111/);
  assert.match(digest.markdown, /https:\/\/app\.hyperliquid\.xyz\/explorer\/address\//);
  assert.match(digest.markdown, /not trade advice/i);
  assert.doesNotMatch(digest.markdown, /\b(buy|sell)\b/i);
  assert.match(digest.chartSvg, /^<svg/);
  assert.equal((digest.chartSvg.match(/data-symbol=/g) ?? []).length, 4);
});

test("daily digest does not relabel historical V2 coordinated exposure events as size changes", () => {
  const observedAt = Date.UTC(2026, 6, 31, 20);
  const legacyEvent: SmartMoneyEventCandidate = {
    fingerprint: "legacy-v2-coordinated",
    type: "coordinated_position_change",
    observedAt,
    symbol: "HYPE",
    address: null,
    vaultAddress: null,
    verificationUrls: [],
    evidence: {
      cohortVersionKey: "cohort-fixture-a",
      detectorVersionKey: "smart-money-pilot-events-v2-shadow",
      walletCount: 3,
      wallets: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
        "0x3333333333333333333333333333333333333333",
      ],
      deltaUsd: 1_500_000,
    },
  };

  const digest = formatDailySmartMoneyDigest({
    dateUtc: "2026-07-31",
    generatedAt: observedAt,
    currentWallets: [],
    events: [legacyEvent],
    funding: [],
    policy: PILOT_EVENT_POLICY_V1,
  });

  assert.match(digest.markdown, /changed exposure in the same direction/i);
  assert.doesNotMatch(digest.markdown, /changed actual position sizes/i);
});

test("weekly honesty report publishes follow-through misses without causal claims", () => {
  const observedAt = Date.UTC(2026, 6, 27, 12);
  const makeEvent = (symbol: string, deltaUsd: number) => ({
    fingerprint: `fixture-${symbol}`,
    type: "coordinated_position_change" as const,
    observedAt,
    symbol,
    address: null,
    vaultAddress: null,
    verificationUrls: [`https://app.hyperliquid.xyz/explorer/address/0x${symbol.toLowerCase().padEnd(40, "0")}`],
    evidence: { cohortVersionKey: "cohort-fixture-a", deltaUsd, walletCount: 3, wallets: [] },
  });
  const btc = makeEvent("BTC", 2_000_000);
  const eth = makeEvent("ETH", -2_000_000);
  const report = formatWeeklySmartMoneyHonestyReport({
    weekStartUtc: "2026-07-27",
    weekEndUtc: "2026-08-02",
    events: [btc, eth],
    outcomes: [
      { eventFingerprint: btc.fingerprint, horizonHours: 24, status: "observed", priceReturnPct: -2 },
      { eventFingerprint: eth.fingerprint, horizonHours: 24, status: "observed", priceReturnPct: -1 },
    ],
  });
  assert.match(report, /Misses: 1/);
  assert.match(report, /BTC[\s\S]*MISS/);
  assert.match(report, /ETH[\s\S]*FOLLOW-THROUGH/);
  assert.match(report, /not evidence of causation/i);
  assert.match(report, /not trade advice/i);
  assert.doesNotMatch(report, /\b(buy|sell)\b/i);
});
