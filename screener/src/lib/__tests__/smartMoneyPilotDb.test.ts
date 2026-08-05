import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../db";
import { createSmartMoneyPilotStore } from "../smartMoneyPilotStore";

test("migration v24 creates append-only smart-money pilot evidence tables", () => {
  const db = getDb();
  assert.equal(db.pragma("user_version", { simple: true }), 24);
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
    evidence: { cohortVersionKey: "2026-W31", deltaUsd: 500_000 },
  };
  const event = store.insertEventDraft(first.id, candidate, "DRAFT — HUMAN REVIEW REQUIRED");
  const eventDuplicate = store.insertEventDraft(first.id, candidate, "different text must not overwrite");
  assert.equal(event.created, true);
  assert.equal(eventDuplicate.created, false);
  assert.equal(eventDuplicate.id, event.id);

  const row = db.prepare("select review_status, delivery_status, draft_text from smart_money_events where id = ?")
    .get(event.id) as { review_status: string; delivery_status: string; draft_text: string };
  assert.deepEqual(row, {
    review_status: "draft",
    delivery_status: "shadow",
    draft_text: "DRAFT — HUMAN REVIEW REQUIRED",
  });
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
