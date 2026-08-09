import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../db";
import { createSmartMoneyPilotStore } from "../smartMoneyPilotStore";

test("migration v25 creates append-only smart-money and funding evidence tables", () => {
  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 25);
  const tables = new Set(
    (db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>)
      .map(({ name }) => name),
  );
  for (const table of [
    "smart_money_collection_runs",
    "smart_money_cohort_versions",
    "smart_money_cohort_members",
    "smart_money_wallet_performance",
    "smart_money_wallet_snapshots",
    "smart_money_wallet_positions",
    "smart_money_vault_snapshots",
    "smart_money_events",
    "smart_money_event_outcomes",
    "smart_money_daily_digests",
    "smart_money_weekly_reports",
    "smart_money_funding_runs",
    "smart_money_funding_windows",
    "smart_money_funding_payments",
    "smart_money_funding_run_payments",
  ]) {
    assert.ok(tables.has(table), `missing ${table}`);
  }
});

test("pilot store is idempotent and keeps unapproved drafts out of delivery", () => {
  const db = getDb();
  const store = createSmartMoneyPilotStore(db);
  const observedAt = Date.UTC(2026, 6, 31, 12);
  const cohort = store.saveCohortVersion({
    versionKey: "2026-W31",
    policyVersion: "policy-v1",
    computedAt: observedAt,
    candidateCount: 1,
    eligibleCount: 1,
    memberCount: 1,
    sourceUrl: "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
    sourceSha256: "a".repeat(64),
    evidence: { source: "fixture" },
    members: [{
      address: "0x1111111111111111111111111111111111111111",
      isMember: true,
      membershipChange: "entry",
      score: 12,
      suspectedGaming: false,
      exclusionReasons: [],
      evidence: { pnl90d: 10 },
    }],
  });
  assert.equal(cohort.created, true);

  const first = store.reserveCollectionRun({
    runKey: "smart-money:2026-07-31T12",
    scheduledFor: observedAt,
    startedAt: observedAt,
    cohortVersionId: cohort.id,
    walletExpected: 1,
    vaultExpected: 1,
    sourceManifest: { mode: "fixture", vaultSourceRows: 9_466 },
  });
  const duplicate = store.reserveCollectionRun({
    runKey: "smart-money:2026-07-31T12",
    scheduledFor: observedAt,
    startedAt: observedAt + 1,
    cohortVersionId: cohort.id,
    walletExpected: 1,
    vaultExpected: 1,
    sourceManifest: { mode: "fixture" },
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.id, first.id);

  store.recordWalletSnapshot(first.id, {
    address: "0x1111111111111111111111111111111111111111",
    observedAt,
    accountValue: 1_000_000,
    status: "complete",
    sourceUrl: "https://api.hyperliquid.xyz/info",
    error: null,
    positions: [
      { coin: "BTC", szi: 1, positionValue: 500_000, leverage: 2 },
      { coin: "xyz:SKHX", szi: 2, positionValue: 20_000, leverage: 2 },
      { coin: "abc:SKHX", szi: -3, positionValue: 30_000, leverage: 3 },
    ],
  });
  assert.deepEqual(
    store.loadWalletSnapshots(first.id)[0].positions.map((position: { coin: string }) => position.coin),
    ["BTC", "abc:SKHX", "xyz:SKHX"],
  );
  store.recordVaultSnapshots(first.id, [{
    vaultAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    observedAt,
    name: "Fixture",
    leaderAddress: null,
    relationshipType: "normal",
    tvl: 2_000_000,
    apr: 0.1,
    cumulativePnl: 100_000,
    followerCount: 10,
    isClosed: false,
    verificationUrl: "https://app.hyperliquid.xyz/vaults/vaultAddress/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }]);
  store.finishCollectionRun(first.id, {
    status: "complete",
    completedAt: observedAt + 1_000,
    walletSucceeded: 1,
    vaultSucceeded: 1,
    error: null,
  });
  assert.equal(store.latestCompleteCollectionSourceRowCount("vaultSourceRows"), 9_466);

  const candidate = {
    fingerprint: "fixture-event",
    type: "unusual_position_change" as const,
    observedAt,
    symbol: "BTC",
    address: "0x1111111111111111111111111111111111111111",
    vaultAddress: null,
    verificationUrls: ["https://app.hyperliquid.xyz/explorer/address/0x1111111111111111111111111111111111111111"],
    evidence: {
      cohortVersionKey: "2026-W31",
      detectorVersionKey: "smart-money-trade-change-v3-shadow",
      tradeChangeKind: "reduce_short" as const,
      inferenceConfidence: "medium" as const,
      reasonCodes: ["snapshot_net_size_change", "short_size_decreased"] as const,
      previousSzi: -10,
      currentSzi: -8,
      deltaSzi: 2,
      referenceMarkPrice: 250_000,
      deltaUsd: 500_000,
    },
  };
  const event = store.insertEventDraft(first.id, candidate, "DRAFT — HUMAN REVIEW REQUIRED");
  const eventDuplicate = store.insertEventDraft(first.id, candidate, "different text must not overwrite");
  assert.equal(event.created, true);
  assert.equal(eventDuplicate.created, false);
  assert.equal(eventDuplicate.id, event.id);

  const row = db.prepare("select review_status, delivery_status, draft_text, evidence_json from smart_money_events where id = ?")
    .get(event.id) as { review_status: string; delivery_status: string; draft_text: string; evidence_json: string };
  assert.deepEqual({
    review_status: row.review_status,
    delivery_status: row.delivery_status,
    draft_text: row.draft_text,
  }, {
    review_status: "draft",
    delivery_status: "shadow",
    draft_text: "DRAFT — HUMAN REVIEW REQUIRED",
  });
  assert.deepEqual(JSON.parse(row.evidence_json), candidate.evidence);
  assert.throws(() => db.prepare(
    "update smart_money_events set delivery_status = 'pending' where id = ?",
  ).run(event.id), /CHECK constraint failed/);

  assert.equal(store.saveDailyDigest({
    digestKey: "fixture-digest",
    periodDate: "2026-07-31",
    generatedAt: observedAt,
    cohortVersionId: cohort.id,
    markdownBody: "daily body",
    chartPath: "/tmp/chart.svg",
    evidence: { chartSha256: "c".repeat(64) },
  }), true);
  assert.deepEqual(store.dailyDigestRecord("fixture-digest"), {
    markdownBody: "daily body",
    chartPath: "/tmp/chart.svg",
    evidence: { chartSha256: "c".repeat(64) },
  });
  assert.equal(store.dailyDigestRecord("missing"), null);

  assert.equal(store.saveWeeklyReport({
    reportKey: "fixture-weekly",
    weekStart: "2026-07-27",
    weekEnd: "2026-08-02",
    generatedAt: observedAt,
    markdownBody: "weekly body",
    evidence: { markdownSha256: "d".repeat(64) },
  }), true);
  assert.deepEqual(store.weeklyReportRecord("fixture-weekly"), {
    markdownBody: "weekly body",
    evidence: { markdownSha256: "d".repeat(64) },
  });
});

test("paired predecessor requires a fresh cadence-aligned evidence run", () => {
  const store = createSmartMoneyPilotStore(getDb());
  const start = Date.UTC(2026, 7, 1, 0);
  const address = "0x3333333333333333333333333333333333333333";
  const cohort = store.saveCohortVersion({
    versionKey: "cadence-fixture",
    policyVersion: "policy-v1",
    computedAt: start,
    candidateCount: 1,
    eligibleCount: 1,
    memberCount: 1,
    sourceUrl: "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
    sourceSha256: "b".repeat(64),
    evidence: {},
    members: [{
      address,
      isMember: true,
      membershipChange: "entry",
      score: 1,
      suspectedGaming: false,
      exclusionReasons: [],
      evidence: {},
    }],
  });

  const completeRun = (label: string, scheduledFor: number, observedAt: number) => {
    const run = store.reserveCollectionRun({
      runKey: `cadence:${label}`,
      scheduledFor,
      startedAt: observedAt,
      cohortVersionId: cohort.id,
      walletExpected: 1,
      vaultExpected: 0,
      sourceManifest: {},
    });
    store.recordWalletSnapshot(run.id, {
      address,
      observedAt,
      accountValue: 1_000_000,
      status: "complete",
      sourceUrl: "https://api.hyperliquid.xyz/info",
      error: null,
      positions: [],
    });
    store.finishCollectionRun(run.id, {
      status: "complete",
      completedAt: observedAt + 1,
      walletSucceeded: 1,
      vaultSucceeded: 0,
      error: null,
    });
    return run;
  };

  const baseline = completeRun("baseline", start, start + 10 * 60_000);
  const fresh = completeRun("fresh", start + 4 * 3_600_000, start + 4 * 3_600_000 + 10 * 60_000);
  assert.equal(store.previousCompleteRun(fresh.id)?.id, baseline.id);

  const staleGap = completeRun("stale-gap", start + 12 * 3_600_000, start + 12 * 3_600_000 + 10 * 60_000);
  assert.equal(store.previousCompleteRun(staleGap.id), null);

  const misaligned = completeRun("misaligned", start + 16 * 3_600_000, start + 21 * 3_600_000);
  assert.equal(store.previousCompleteRun(misaligned.id), null);
});

test("cohort transition context is scoped to the requested version and its immediate predecessor", () => {
  const store = createSmartMoneyPilotStore(getDb());
  const start = Date.UTC(2026, 5, 1, 0);
  const member = (address: string, membershipChange: "entry" | "stay" | "exit") => ({
    address,
    isMember: membershipChange !== "exit",
    membershipChange,
    score: 1,
    suspectedGaming: false,
    exclusionReasons: [],
    evidence: {},
  });
  const first = store.saveCohortVersion({
    versionKey: "transition-v1",
    policyVersion: "policy-v1",
    computedAt: start,
    candidateCount: 3,
    eligibleCount: 3,
    memberCount: 3,
    sourceUrl: "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
    sourceSha256: "c".repeat(64),
    evidence: {},
    members: [
      member("0x1111111111111111111111111111111111111111", "entry"),
      member("0x2222222222222222222222222222222222222222", "entry"),
      member("0x3333333333333333333333333333333333333333", "entry"),
    ],
  });
  const second = store.saveCohortVersion({
    versionKey: "transition-v2",
    policyVersion: "policy-v1",
    computedAt: start + 7 * 86_400_000,
    candidateCount: 4,
    eligibleCount: 3,
    memberCount: 3,
    sourceUrl: "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
    sourceSha256: "d".repeat(64),
    evidence: {},
    members: [
      member("0x1111111111111111111111111111111111111111", "stay"),
      member("0x2222222222222222222222222222222222222222", "stay"),
      member("0x3333333333333333333333333333333333333333", "exit"),
      member("0x4444444444444444444444444444444444444444", "entry"),
    ],
  });

  assert.deepEqual(store.cohortTransitionContext(first.id), {
    currentVersionKey: "transition-v1",
    previousVersionKey: null,
    currentMembers: 3,
    previousMembers: 0,
    entries: 3,
    stays: 0,
    exits: 0,
  });
  assert.deepEqual(store.cohortTransitionContext(second.id), {
    currentVersionKey: "transition-v2",
    previousVersionKey: "transition-v1",
    currentMembers: 3,
    previousMembers: 3,
    entries: 1,
    stays: 2,
    exits: 1,
  });
});

test("funding store is idempotent, conflict-safe, and exposes only complete runs for aggregation", () => {
  const db = getDb();
  const store = createSmartMoneyPilotStore(db);
  const start = Date.UTC(2026, 8, 1, 0);
  const address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const cohort = store.saveCohortVersion({
    versionKey: "funding-cohort-v1",
    policyVersion: "policy-v1",
    computedAt: start,
    candidateCount: 1,
    eligibleCount: 1,
    memberCount: 1,
    sourceUrl: "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
    sourceSha256: "e".repeat(64),
    evidence: {},
    members: [{
      address,
      isMember: true,
      membershipChange: "entry",
      score: 1,
      suspectedGaming: false,
      exclusionReasons: [],
      evidence: {},
    }],
  });
  const collection = store.reserveCollectionRun({
    runKey: "funding-parent-1",
    scheduledFor: start + 24 * 3_600_000,
    startedAt: start + 24 * 3_600_000,
    cohortVersionId: cohort.id,
    walletExpected: 1,
    vaultExpected: 0,
    sourceManifest: {},
  });
  store.finishCollectionRun(collection.id, {
    status: "complete",
    completedAt: start + 24 * 3_600_000 + 1,
    walletSucceeded: 1,
    vaultSucceeded: 0,
    error: null,
  });
  const reserved = store.reserveFundingRun({
    runKey: "funding-run-1",
    attemptNo: 1,
    collectionRunId: collection.id,
    policyVersion: "funding-v1",
    startAt: start,
    endAt: start + 24 * 3_600_000,
    startedAt: start + 24 * 3_600_000 + 2,
    walletExpected: 1,
    sourceManifest: {},
  });
  assert.equal(reserved.created, true);
  assert.deepEqual(store.reserveFundingRun({
    runKey: "funding-run-1",
    attemptNo: 1,
    collectionRunId: collection.id,
    policyVersion: "funding-v1",
    startAt: start,
    endAt: start + 24 * 3_600_000,
    startedAt: start + 24 * 3_600_000 + 2,
    walletExpected: 1,
    sourceManifest: {},
  }), { id: reserved.id, created: false });
  assert.throws(() => store.reserveFundingRun({
    runKey: "funding-run-1",
    attemptNo: 1,
    collectionRunId: collection.id,
    policyVersion: "funding-v1",
    startAt: start,
    endAt: start + 23 * 3_600_000,
    startedAt: start + 24 * 3_600_000 + 2,
    walletExpected: 1,
    sourceManifest: {},
  }), /funding run key collision/i);

  assert.throws(() => store.recordFundingWalletResult(reserved.id, {
    address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    startTime: start,
    endTime: start + 24 * 3_600_000,
    windows: [],
    payments: [],
  }, start + 24 * 3_600_000 + 3), /not an active cohort member/i);

  assert.throws(() => store.recordFundingWalletResult(reserved.id, {
    address,
    startTime: start,
    endTime: start + 24 * 3_600_000,
    windows: [],
    payments: [{
      address,
      time: start + 24 * 3_600_000 + 1,
      coin: "BTC",
      usdc: 1,
      szi: 1,
      fundingRate: 0.0001,
      nSamples: null,
      hash: `0x${"0".repeat(64)}`,
    }],
  }, start + 24 * 3_600_000 + 3), /outside funding run range/i);

  const payment = {
    address,
    time: start + 3_600_000,
    coin: "xyz:XYZ100",
    usdc: -12.5,
    szi: 100,
    fundingRate: 0.0001,
    nSamples: null,
    hash: `0x${"0".repeat(64)}`,
  };
  store.recordFundingWalletResult(reserved.id, {
    address,
    startTime: start,
    endTime: start + 24 * 3_600_000,
    windows: [{
      startTime: start,
      endTime: start + 6 * 3_600_000,
      status: "complete",
      responseCount: 1,
      sourceSha256: "f".repeat(64),
      sourceBytes: 100,
      sourceArchivePath: "/archive/funding.json.gz",
    }],
    payments: [payment],
  }, start + 24 * 3_600_000 + 3);
  assert.throws(() => store.recordFundingWalletResult(reserved.id, {
    address,
    startTime: start,
    endTime: start + 24 * 3_600_000,
    windows: [],
    payments: [{ ...payment, usdc: -99 }],
  }, start + 24 * 3_600_000 + 4), /conflicting funding payment/i);

  const aggregationScope = {
    cohortVersionId: cohort.id,
    policyVersion: "funding-v1",
    lookbackMs: 24 * 3_600_000,
  };

  assert.throws(() => store.finishFundingRun(reserved.id, {
    status: "partial",
    completedAt: start + 24 * 3_600_000 + 5,
    walletSucceeded: 1,
    windowCount: 2,
    paymentCount: 1,
    sourceManifest: { coverage: "partial" },
    error: "retryable source failure",
  }), /persisted window count/i);
  assert.throws(() => store.finishFundingRun(reserved.id, {
    status: "partial",
    completedAt: start + 24 * 3_600_000 + 5,
    walletSucceeded: 1,
    windowCount: 1,
    paymentCount: 1,
    sourceManifest: { coverage: "partial" },
    error: "retryable source failure",
  }), /terminal window coverage/i);
  store.recordFundingWalletResult(reserved.id, {
    address,
    startTime: start,
    endTime: start + 24 * 3_600_000,
    windows: [{
      startTime: start + 6 * 3_600_000,
      endTime: start + 24 * 3_600_000,
      status: "complete",
      responseCount: 1,
      sourceSha256: "e".repeat(64),
      sourceBytes: 101,
      sourceArchivePath: "/archive/funding-remainder.json.gz",
    }],
    payments: [payment],
  }, start + 24 * 3_600_000 + 5);
  store.finishFundingRun(reserved.id, {
    status: "partial",
    completedAt: start + 24 * 3_600_000 + 5,
    walletSucceeded: 1,
    windowCount: 2,
    paymentCount: 1,
    sourceManifest: { coverage: "partial" },
    error: "retryable source failure",
  });
  assert.throws(
    () => store.completeFundingPayments(reserved.id, aggregationScope),
    /not aggregate-ready/i,
  );

  const retry = store.reserveFundingRun({
    runKey: "funding-run-2",
    attemptNo: 2,
    collectionRunId: collection.id,
    policyVersion: "funding-v1",
    startAt: start,
    endAt: start + 24 * 3_600_000,
    startedAt: start + 24 * 3_600_000 + 6,
    walletExpected: 1,
    sourceManifest: {},
  });
  assert.equal(retry.created, true);
  store.recordFundingWalletResult(retry.id, {
    address,
    startTime: start,
    endTime: start + 24 * 3_600_000,
    windows: [{
      startTime: start,
      endTime: start + 24 * 3_600_000,
      status: "complete",
      responseCount: 1,
      sourceSha256: "f".repeat(64),
      sourceBytes: 100,
      sourceArchivePath: "/archive/funding.json.gz",
    }],
    payments: [payment],
  }, start + 24 * 3_600_000 + 7);
  store.finishFundingRun(retry.id, {
    status: "complete",
    completedAt: start + 24 * 3_600_000 + 8,
    walletSucceeded: 1,
    windowCount: 1,
    paymentCount: 1,
    sourceManifest: { coverage: "complete" },
    error: null,
  });
  assert.equal(
    store.latestCompleteFundingRunAtOrBefore(start + 24 * 3_600_000, aggregationScope)?.id,
    retry.id,
  );
  assert.equal(store.latestCompleteFundingRunAtOrBefore(start + 24 * 3_600_000, {
    ...aggregationScope,
    cohortVersionId: cohort.id + 99,
  }), null);
  assert.equal(store.latestFundingRunForCollection(collection.id, "funding-v1")?.id, retry.id);
  assert.equal(store.fundingRunWindows(retry.id).length, 1);
  assert.deepEqual(store.completeFundingPayments(retry.id, aggregationScope), [payment]);
  assert.equal((db.prepare(`
    select count(*) as count from smart_money_funding_run_payments
    where address = ? and settlement_at = ? and coin = ?
  `).get(address, payment.time, payment.coin) as { count: number }).count, 2);
  assert.deepEqual(db.prepare(`
    select address, settlement_at, coin, usdc, source_hash
    from smart_money_funding_payments where address = ?
  `).get(address), {
    address,
    settlement_at: payment.time,
    coin: "xyz:XYZ100",
    usdc: -12.5,
    source_hash: payment.hash,
  });

  const overlap = store.reserveFundingRun({
    runKey: "funding-overlap-1",
    attemptNo: 1,
    collectionRunId: collection.id,
    policyVersion: "funding-overlap-v1",
    startAt: start,
    endAt: start + 24 * 3_600_000,
    startedAt: start + 24 * 3_600_000 + 9,
    walletExpected: 1,
    sourceManifest: {},
  });
  store.recordFundingWalletResult(overlap.id, {
    address,
    startTime: start,
    endTime: start + 24 * 3_600_000,
    windows: [{
      startTime: start,
      endTime: start + 12 * 3_600_000,
      status: "complete",
      responseCount: 0,
      sourceSha256: "c".repeat(64),
      sourceBytes: 2,
      sourceArchivePath: "/archive/overlap-a.json.gz",
    }, {
      startTime: start + 6 * 3_600_000,
      endTime: start + 24 * 3_600_000,
      status: "complete",
      responseCount: 0,
      sourceSha256: "d".repeat(64),
      sourceBytes: 2,
      sourceArchivePath: "/archive/overlap-b.json.gz",
    }],
    payments: [],
  }, start + 24 * 3_600_000 + 10);
  assert.throws(() => store.finishFundingRun(overlap.id, {
    status: "partial",
    completedAt: start + 24 * 3_600_000 + 11,
    walletSucceeded: 1,
    windowCount: 2,
    paymentCount: 0,
    sourceManifest: {},
    error: "fixture",
  }), /terminal window coverage.*gap or overlap/i);

  const wrongSet = store.reserveFundingRun({
    runKey: "funding-wrong-set-1",
    attemptNo: 1,
    collectionRunId: collection.id,
    policyVersion: "funding-wrong-set-v1",
    startAt: start,
    endAt: start + 24 * 3_600_000,
    startedAt: start + 24 * 3_600_000 + 12,
    walletExpected: 1,
    sourceManifest: {},
  });
  db.prepare(`
    insert into smart_money_funding_windows (
      funding_run_id, address, start_at, end_at, status, response_count,
      source_sha256, source_bytes, source_archive_path
    ) values (?, ?, ?, ?, 'complete', 0, ?, 2, ?)
  `).run(
    wrongSet.id,
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    start,
    start + 24 * 3_600_000,
    "6".repeat(64),
    "/archive/wrong-set.json.gz",
  );
  assert.throws(() => store.finishFundingRun(wrongSet.id, {
    status: "complete",
    completedAt: start + 24 * 3_600_000 + 13,
    walletSucceeded: 1,
    windowCount: 1,
    paymentCount: 0,
    sourceManifest: {},
    error: null,
  }), /terminal wallet set does not match active cohort members/i);

  const crashed = store.reserveFundingRun({
    runKey: "funding-stale-1",
    attemptNo: 1,
    collectionRunId: collection.id,
    policyVersion: "funding-stale-v1",
    startAt: start,
    endAt: start + 24 * 3_600_000,
    startedAt: start,
    walletExpected: 1,
    sourceManifest: {},
  });
  assert.equal(store.markStaleFundingRunsFailed(start + 1, start + 2), 1);
  assert.equal(store.fundingRun(crashed.id)?.status, "failed");
  const recovered = store.reserveFundingRun({
    runKey: "funding-stale-2",
    attemptNo: 2,
    collectionRunId: collection.id,
    policyVersion: "funding-stale-v1",
    startAt: start,
    endAt: start + 24 * 3_600_000,
    startedAt: start + 3,
    walletExpected: 1,
    sourceManifest: {},
  });
  assert.equal(store.latestFundingRunForCollection(collection.id, "funding-stale-v1")?.id, recovered.id);

  const counterEnd = start + 48 * 3_600_000;
  const incompleteCounters = store.reserveCollectionRun({
    runKey: "funding-parent-incomplete-counters",
    scheduledFor: counterEnd,
    startedAt: counterEnd,
    cohortVersionId: cohort.id,
    walletExpected: 1,
    vaultExpected: 1,
    sourceManifest: {},
  });
  store.finishCollectionRun(incompleteCounters.id, {
    status: "complete",
    completedAt: counterEnd + 1,
    walletSucceeded: 0,
    vaultSucceeded: 0,
    error: null,
  });
  const counterFunding = store.reserveFundingRun({
    runKey: "funding-parent-incomplete-counters-attempt",
    attemptNo: 1,
    collectionRunId: incompleteCounters.id,
    policyVersion: "funding-counter-v1",
    startAt: counterEnd - 24 * 3_600_000,
    endAt: counterEnd,
    startedAt: counterEnd + 2,
    walletExpected: 1,
    sourceManifest: {},
  });
  store.recordFundingWalletResult(counterFunding.id, {
    address,
    startTime: counterEnd - 24 * 3_600_000,
    endTime: counterEnd,
    windows: [{
      startTime: counterEnd - 24 * 3_600_000,
      endTime: counterEnd,
      status: "complete",
      responseCount: 0,
      sourceSha256: "7".repeat(64),
      sourceBytes: 2,
      sourceArchivePath: "/archive/counter.json.gz",
    }],
    payments: [],
  }, counterEnd + 3);
  assert.throws(() => store.finishFundingRun(counterFunding.id, {
    status: "complete",
    completedAt: counterEnd + 4,
    walletSucceeded: 1,
    windowCount: 1,
    paymentCount: 0,
    sourceManifest: {},
    error: null,
  }), /parent collection counters are incomplete/i);
  db.prepare(`
    update smart_money_funding_runs
    set status = 'complete', completed_at = @completedAt,
      wallet_succeeded = wallet_expected, error = null, updated_at = @completedAt
    where id = @id
  `).run({ id: counterFunding.id, completedAt: counterEnd + 5 });
  const counterScope = {
    cohortVersionId: cohort.id,
    policyVersion: "funding-counter-v1",
    lookbackMs: 24 * 3_600_000,
  };
  assert.equal(store.latestCompleteFundingRunAtOrBefore(counterEnd, counterScope), null);
  assert.throws(
    () => store.completeFundingPayments(counterFunding.id, counterScope),
    /not aggregate-ready/i,
  );
});

test("historical cohort members remain queryable after cohort turnover", () => {
  const store = createSmartMoneyPilotStore(getDb());
  const firstAddress = "0x1212121212121212121212121212121212121212";
  const secondAddress = "0x3434343434343434343434343434343434343434";
  const save = (versionKey: string, computedAt: number, address: string) => store.saveCohortVersion({
    versionKey,
    policyVersion: "historical-cohort-test",
    computedAt,
    candidateCount: 1,
    eligibleCount: 1,
    memberCount: 1,
    sourceUrl: "https://example.test/cohort",
    sourceSha256: versionKey.padEnd(64, "0").slice(0, 64),
    evidence: {},
    members: [{
      address,
      isMember: true,
      membershipChange: "entry",
      score: 1,
      suspectedGaming: false,
      exclusionReasons: [],
      evidence: {},
    }],
  });
  const first = save("historical-cohort-a", Date.UTC(2027, 0, 1), firstAddress);
  const second = save("historical-cohort-b", Date.UTC(2027, 0, 8), secondAddress);

  assert.equal(store.latestCohortVersion()?.id, second.id);
  assert.deepEqual(store.activeAddressesForCohort(first.id), [firstAddress]);
});

test("funding aggregation requires complete parent, expected policy, and exact lookback", () => {
  const db = getDb();
  const store = createSmartMoneyPilotStore(db);
  const dayMs = 24 * 3_600_000;
  const start = Date.UTC(2026, 7, 11);
  const end = start + dayMs;
  const policyVersion = "funding-provenance-v1";
  const cohort = store.saveCohortVersion({
    versionKey: "2026-W33-funding-provenance",
    policyVersion: "cohort-provenance-v1",
    computedAt: start,
    candidateCount: 0,
    eligibleCount: 0,
    memberCount: 0,
    sourceUrl: "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
    sourceSha256: "9".repeat(64),
    evidence: {},
    members: [],
  });
  const collection = store.reserveCollectionRun({
    runKey: "funding-provenance-core-complete",
    scheduledFor: end,
    startedAt: end,
    cohortVersionId: cohort.id,
    walletExpected: 0,
    vaultExpected: 0,
    sourceManifest: {},
  });
  store.finishCollectionRun(collection.id, {
    status: "complete",
    completedAt: end + 1,
    walletSucceeded: 0,
    vaultSucceeded: 0,
    error: null,
  });
  const reserveFunding = (
    runKey: string,
    collectionRunId: number,
    policy: string,
    attemptNo: number,
    rangeStart: number,
    rangeEnd: number,
  ) => store.reserveFundingRun({
    runKey,
    attemptNo,
    collectionRunId,
    policyVersion: policy,
    startAt: rangeStart,
    endAt: rangeEnd,
    startedAt: rangeEnd + attemptNo,
    walletExpected: 0,
    sourceManifest: {},
  });
  const finishEmpty = (id: number) => store.finishFundingRun(id, {
    status: "complete",
    completedAt: end + 100,
    walletSucceeded: 0,
    windowCount: 0,
    paymentCount: 0,
    sourceManifest: { coverage: "complete" },
    error: null,
  });

  const valid = reserveFunding("funding-provenance-valid", collection.id, policyVersion, 1, start, end);
  finishEmpty(valid.id);
  const wrongPolicy = reserveFunding(
    "funding-provenance-wrong-policy",
    collection.id,
    "funding-provenance-v2",
    1,
    start,
    end,
  );
  finishEmpty(wrongPolicy.id);
  const wrongRange = reserveFunding(
    "funding-provenance-wrong-range",
    collection.id,
    policyVersion,
    2,
    start + 3_600_000,
    end,
  );
  finishEmpty(wrongRange.id);
  const wrongAddress = reserveFunding(
    "funding-provenance-wrong-address",
    collection.id,
    policyVersion,
    3,
    start,
    end,
  );
  finishEmpty(wrongAddress.id);
  db.prepare(`
    insert into smart_money_funding_windows (
      funding_run_id, address, start_at, end_at, status, response_count,
      source_sha256, source_bytes, source_archive_path
    ) values (?, ?, ?, ?, 'complete', 0, ?, 2, ?)
  `).run(
    wrongAddress.id,
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    start,
    end,
    "8".repeat(64),
    "/archive/wrong-address.json.gz",
  );

  const incompleteCollection = store.reserveCollectionRun({
    runKey: "funding-provenance-core-incomplete",
    scheduledFor: end + dayMs,
    startedAt: end + dayMs,
    cohortVersionId: cohort.id,
    walletExpected: 0,
    vaultExpected: 0,
    sourceManifest: {},
  });
  const incompleteParent = reserveFunding(
    "funding-provenance-incomplete-parent",
    incompleteCollection.id,
    policyVersion,
    1,
    end,
    end + dayMs,
  );
  assert.throws(() => finishEmpty(incompleteParent.id), /parent collection is not complete/i);
  db.prepare(`
    update smart_money_funding_runs
    set status = 'complete', completed_at = @completedAt, updated_at = @completedAt
    where id = @id
  `).run({ id: incompleteParent.id, completedAt: end + dayMs + 1 });

  const scope = { cohortVersionId: cohort.id, policyVersion, lookbackMs: dayMs };
  assert.equal(
    store.latestCompleteFundingRunAtOrBefore(end + dayMs, scope)?.id,
    valid.id,
  );
  assert.deepEqual(store.completeFundingPayments(valid.id, scope), []);
  for (const runId of [wrongPolicy.id, wrongRange.id, wrongAddress.id, incompleteParent.id]) {
    assert.throws(
      () => store.completeFundingPayments(runId, scope),
      /not aggregate-ready/i,
    );
  }
});
