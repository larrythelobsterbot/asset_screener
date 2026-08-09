import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectCohortFundingEvidence,
  fundingRunKey,
  runFundingStageIsolated,
  type FundingEvidenceStore,
} from "../smartMoneyFundingRuntime";
import {
  UserFundingFetchError,
  type RawUserFundingSource,
  type UserFundingRangeResult,
} from "../smartMoneyFunding";
import type { CollectionRunRecord, FundingRunRecord, FundingWindowRecord } from "../smartMoneyPilotStore";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const ZERO_HASH = `0x${"0".repeat(64)}`;
const DEFAULT_SCHEDULED_FOR = Date.UTC(2026, 7, 9, 8);

function rawPayment(address: string, time: number): RawUserFundingSource {
  const rawText = JSON.stringify([{
    time,
    hash: ZERO_HASH,
    delta: {
      type: "funding",
      coin: address === A ? "BTC" : "xyz:XYZ100",
      usdc: address === A ? "-1.5" : "2.5",
      szi: address === A ? "10" : "-5",
      fundingRate: "0.0001",
      nSamples: null,
    },
  }]);
  return { rawText, byteLength: Buffer.byteLength(rawText), sha256: address === A ? "a".repeat(64) : "b".repeat(64) };
}

function existingRun(
  status: FundingRunRecord["status"] = "complete",
  addresses: string[] = [A, B],
  scheduledFor = DEFAULT_SCHEDULED_FOR,
): FundingRunRecord {
  return {
    id: 44,
    runKey: fundingRunKey(7, 1),
    collectionRunId: 7,
    policyVersion: "smart-money-user-funding-v1-shadow",
    attemptNo: 1,
    startAt: scheduledFor - 24 * 3_600_000,
    endAt: scheduledFor,
    startedAt: scheduledFor - 1_000,
    completedAt: status === "running" ? null : scheduledFor,
    status,
    walletExpected: addresses.length,
    walletSucceeded: status === "complete" ? addresses.length : Math.min(1, addresses.length),
    windowCount: addresses.length,
    paymentCount: 1,
    sourceManifest: { addresses },
    error: null,
  };
}

function completeParent(
  id: number,
  scheduledFor: number,
  walletExpected: number,
  overrides: Partial<CollectionRunRecord> = {},
): CollectionRunRecord {
  return {
    id,
    runKey: `collection-${id}`,
    runKind: "collection",
    scheduledFor,
    status: "complete",
    cohortVersionId: 1,
    walletExpected,
    walletSucceeded: walletExpected,
    vaultExpected: 1,
    vaultSucceeded: 1,
    ...overrides,
  };
}

interface FakeFundingStore extends FundingEvidenceStore {
  reserved: unknown[];
  recorded: UserFundingRangeResult[];
  finished: unknown[];
  invalidated: unknown[];
  staleFailures: number;
  windows: FundingWindowRecord[];
}

function fakeStore(prior: FundingRunRecord | null = null): FakeFundingStore {
  let latest = prior;
  const store: FakeFundingStore = {
    reserved: [],
    recorded: [],
    finished: [],
    invalidated: [],
    staleFailures: 0,
    windows: prior
      ? ([A, B].slice(0, prior.walletExpected).map((address, index) => ({
        address,
        startAt: prior.startAt,
        endAt: prior.endAt,
        status: "complete" as const,
        responseCount: 1,
        sourceSha256: String.fromCharCode(97 + index).repeat(64),
        sourceBytes: 10,
        sourceArchivePath: `/archive/${String.fromCharCode(97 + index).repeat(64)}.json.gz`,
      })))
      : [],
    latestFundingRunForCollection() {
      return latest;
    },
    markStaleFundingRunsFailed(staleBefore, failedAt) {
      if (latest?.status !== "running" || latest.startedAt >= staleBefore) return 0;
      latest = {
        ...latest,
        status: "failed",
        completedAt: failedAt,
        error: "stale funding run",
      };
      this.staleFailures += 1;
      return 1;
    },
    reserveFundingRun(input) {
      this.reserved.push(input);
      const id = (latest?.id ?? 43) + 1;
      latest = {
        id,
        runKey: input.runKey,
        collectionRunId: input.collectionRunId,
        policyVersion: input.policyVersion,
        attemptNo: input.attemptNo,
        startAt: input.startAt,
        endAt: input.endAt,
        startedAt: input.startedAt,
        completedAt: null,
        status: "running",
        walletExpected: input.walletExpected,
        walletSucceeded: 0,
        windowCount: 0,
        paymentCount: 0,
        sourceManifest: input.sourceManifest,
        error: null,
      };
      return { id, created: true };
    },
    fundingRun(id) {
      return latest?.id === id ? latest : null;
    },
    fundingRunWindows() {
      return this.windows;
    },
    fundingRunPaymentAssociationCount() {
      return latest?.paymentCount ?? 0;
    },
    invalidateFundingRun(id, observedAt, error) {
      this.invalidated.push({ id, observedAt, error });
      if (!latest || latest.id !== id || latest.status !== "complete") return false;
      latest = { ...latest, status: "invalid" };
      return true;
    },
    recordFundingWalletResult(_runId, result) {
      this.recorded.push(result);
      return {
        windowsInserted: result.windows.length,
        paymentsInserted: result.payments.length,
        paymentAssociationsInserted: result.payments.length,
      };
    },
    finishFundingRun(id, input) {
      this.finished.push(input);
      if (latest?.id === id) {
        latest = {
          ...latest,
          status: input.status,
          completedAt: input.completedAt,
          walletSucceeded: input.walletSucceeded,
          windowCount: input.windowCount,
          paymentCount: input.paymentCount,
          sourceManifest: input.sourceManifest,
          error: input.error,
        };
      }
      return true;
    },
  };
  return store;
}

test("funding runtime collects complete trailing-day evidence with explicit pacing and manifest proof", async () => {
  const scheduledFor = Date.UTC(2026, 7, 9, 8);
  const store = fakeStore();
  const sleeps: number[] = [];
  const result = await collectCohortFundingEvidence({
    collectionRunId: 7,
    scheduledFor,
    addresses: [B, A],
    parentCollection: completeParent(7, scheduledFor, 2),
    store,
    now: () => scheduledFor + 10,
    sleep: async (ms) => { sleeps.push(ms); },
    cooldownMs: 60_000,
    requestSpacingMs: 2_500,
    baseWindowMs: 24 * 3_600_000,
    fetchWindow: async (address, _startTime, endTime) => rawPayment(address, endTime),
    archiveSource: (source, _startTime, _endTime, address) => `/archive/${address}/${source.sha256}.json.gz`,
    verifyArchive: () => {},
  });

  assert.equal(
    fundingRunKey(7, 1),
    "smart-money-funding:7:smart-money-user-funding-v1-shadow:attempt-1",
  );
  assert.deepEqual(sleeps, [60_000, 2_500, 2_500]);
  assert.equal(store.recorded.length, 2);
  assert.deepEqual(store.recorded.map(({ address }) => address), [A, B]);
  assert.equal(result.status, "complete");
  assert.equal(result.walletSucceeded, 2);
  assert.equal(result.paymentCount, 2);
  assert.equal(result.requestCount, 2);
  assert.deepEqual(result.failedWallets, []);
  assert.equal(store.finished.length, 1);
  assert.equal((store.finished[0] as { status: string }).status, "complete");
  assert.deepEqual((store.finished[0] as { sourceManifest: { failedWallets: unknown[] } }).sourceManifest.failedWallets, []);
});

test("funding runtime isolates wallet failures as a partial funding run", async () => {
  const scheduledFor = Date.UTC(2026, 7, 9, 8);
  const store = fakeStore();
  const result = await collectCohortFundingEvidence({
    collectionRunId: 8,
    scheduledFor,
    addresses: [A, B],
    parentCollection: completeParent(8, scheduledFor, 2),
    store,
    now: () => scheduledFor + 20,
    sleep: async () => {},
    cooldownMs: 0,
    requestSpacingMs: 0,
    baseWindowMs: 24 * 3_600_000,
    fetchWindow: async (address, _startTime, endTime) => {
      if (address === B) throw new Error("HTTP 429");
      return rawPayment(address, endTime);
    },
    archiveSource: () => "/archive/source.json.gz",
    verifyArchive: () => {},
  });

  assert.equal(result.status, "partial");
  assert.equal(result.walletSucceeded, 1);
  assert.deepEqual(result.failedWallets, [{ address: B, error: "HTTP 429" }]);
  assert.equal(store.recorded.length, 1);
  assert.equal((store.finished[0] as { status: string }).status, "partial");
});

test("funding runtime is idempotent when its policy-scoped run already exists", async () => {
  const scheduledFor = Date.UTC(2026, 7, 9, 8);
  const store = fakeStore(existingRun());
  let fetched = false;
  let verified = 0;
  const result = await collectCohortFundingEvidence({
    collectionRunId: 7,
    scheduledFor,
    addresses: [A, B],
    parentCollection: completeParent(7, scheduledFor, 2),
    store,
    now: () => scheduledFor,
    sleep: async () => { throw new Error("should not sleep"); },
    fetchWindow: async () => { fetched = true; throw new Error("should not fetch"); },
    archiveSource: () => "/archive/unused.json.gz",
    verifyArchive: () => { verified += 1; },
  });

  assert.equal(result.created, false);
  assert.equal(result.status, "complete");
  assert.equal(fetched, false);
  assert.equal(verified, 2);
  assert.equal(store.recorded.length, 0);
  assert.equal(store.finished.length, 0);
});

test("funding runtime rejects complete replay when parent counters are incomplete", async () => {
  const scheduledFor = DEFAULT_SCHEDULED_FOR;
  const store = fakeStore(existingRun("complete", [A], scheduledFor));

  await assert.rejects(() => collectCohortFundingEvidence({
    collectionRunId: 7,
    scheduledFor,
    addresses: [A],
    parentCollection: completeParent(7, scheduledFor, 1, { vaultSucceeded: 0 }),
    store,
    now: () => scheduledFor,
    sleep: async () => { throw new Error("should not sleep"); },
    fetchWindow: async () => { throw new Error("should not fetch"); },
    archiveSource: () => "/archive/unused.json.gz",
    verifyArchive: () => { throw new Error("should not verify"); },
  }), /parent collection.*not complete/i);

  assert.equal(store.invalidated.length, 0);
  assert.equal(store.staleFailures, 0);
});

test("funding runtime invalidates complete replay when the requested address set changes", async () => {
  const scheduledFor = DEFAULT_SCHEDULED_FOR;
  const store = fakeStore(existingRun("complete", [A, B], scheduledFor));
  let fetched = 0;
  const result = await collectCohortFundingEvidence({
    collectionRunId: 7,
    scheduledFor,
    addresses: [A, C],
    parentCollection: completeParent(7, scheduledFor, 2),
    store,
    now: () => scheduledFor + 1,
    sleep: async () => {},
    cooldownMs: 0,
    requestSpacingMs: 0,
    baseWindowMs: 24 * 3_600_000,
    fetchWindow: async (address, _startTime, endTime) => {
      fetched += 1;
      return rawPayment(address, endTime);
    },
    archiveSource: () => "/archive/source.json.gz",
    verifyArchive: () => {},
  });

  assert.equal(store.invalidated.length, 1);
  assert.equal((store.reserved[0] as { attemptNo: number }).attemptNo, 2);
  assert.equal(fetched, 2);
  assert.equal(result.status, "complete");
});

test("funding runtime invalidates complete replay when the requested range changes", async () => {
  const previousSchedule = DEFAULT_SCHEDULED_FOR;
  const scheduledFor = previousSchedule + 4 * 3_600_000;
  const store = fakeStore(existingRun("complete", [A, B], previousSchedule));
  const result = await collectCohortFundingEvidence({
    collectionRunId: 7,
    scheduledFor,
    addresses: [A, B],
    parentCollection: completeParent(7, scheduledFor, 2),
    store,
    now: () => scheduledFor + 1,
    sleep: async () => {},
    cooldownMs: 0,
    requestSpacingMs: 0,
    baseWindowMs: 24 * 3_600_000,
    fetchWindow: async (address, _startTime, endTime) => rawPayment(address, endTime),
    archiveSource: () => "/archive/source.json.gz",
    verifyArchive: () => {},
  });

  assert.equal(store.invalidated.length, 1);
  assert.equal((store.reserved[0] as { attemptNo: number }).attemptNo, 2);
  assert.equal(result.status, "complete");
});

test("funding runtime fails remaining wallets closed when its cohort request budget is exhausted", async () => {
  const scheduledFor = Date.UTC(2026, 7, 9, 8);
  const store = fakeStore();
  const result = await collectCohortFundingEvidence({
    collectionRunId: 9,
    scheduledFor,
    addresses: [A, B],
    parentCollection: completeParent(9, scheduledFor, 2),
    store,
    now: () => scheduledFor + 30,
    sleep: async () => {},
    cooldownMs: 0,
    requestSpacingMs: 0,
    baseWindowMs: 24 * 3_600_000,
    maxTotalRequests: 1,
    fetchWindow: async (address, _startTime, endTime) => rawPayment(address, endTime),
    archiveSource: () => "/archive/source.json.gz",
    verifyArchive: () => {},
  });

  assert.equal(result.status, "partial");
  assert.equal(result.requestCount, 1);
  assert.equal(result.walletSucceeded, 1);
  assert.match(result.failedWallets[0].error, /request budget exhausted/i);
  assert.equal((store.finished[0] as { sourceManifest: { requestCount: number } }).sourceManifest.requestCount, 1);
});

test("funding runtime retries a prior partial attempt with durable attempt numbering", async () => {
  const scheduledFor = Date.UTC(2026, 7, 9, 8);
  const store = fakeStore(existingRun("partial", [A]));
  const result = await collectCohortFundingEvidence({
    collectionRunId: 7,
    scheduledFor,
    addresses: [A],
    parentCollection: completeParent(7, scheduledFor, 1),
    store,
    now: () => scheduledFor + 40,
    sleep: async () => {},
    cooldownMs: 0,
    requestSpacingMs: 0,
    baseWindowMs: 24 * 3_600_000,
    fetchWindow: async (address, _startTime, endTime) => rawPayment(address, endTime),
    archiveSource: () => "/archive/source.json.gz",
    verifyArchive: () => {},
  });

  assert.equal(result.created, true);
  assert.equal(result.status, "complete");
  assert.equal(result.id, 45);
  assert.equal((store.reserved[0] as { attemptNo: number }).attemptNo, 2);
});

test("funding runtime recovers a stale running attempt for every caller", async () => {
  const scheduledFor = Date.UTC(2026, 7, 9, 8);
  const stale = {
    ...existingRun("running", [A]),
    startedAt: scheduledFor - 3 * 3_600_000,
  };
  const store = fakeStore(stale);
  const result = await collectCohortFundingEvidence({
    collectionRunId: 7,
    scheduledFor,
    addresses: [A],
    parentCollection: completeParent(7, scheduledFor, 1),
    store,
    now: () => scheduledFor,
    sleep: async () => {},
    cooldownMs: 0,
    requestSpacingMs: 0,
    baseWindowMs: 24 * 3_600_000,
    fetchWindow: async (address, _startTime, endTime) => rawPayment(address, endTime),
    archiveSource: () => "/archive/source.json.gz",
    verifyArchive: () => {},
  });

  assert.equal(store.staleFailures, 1);
  assert.equal((store.reserved[0] as { attemptNo: number }).attemptNo, 2);
  assert.equal(result.status, "complete");
});

test("funding runtime invalidates corrupt complete evidence and recollects a new attempt", async () => {
  const scheduledFor = Date.UTC(2026, 7, 9, 8);
  const store = fakeStore(existingRun("complete", [A]));
  let fetched = 0;
  const result = await collectCohortFundingEvidence({
    collectionRunId: 7,
    scheduledFor,
    addresses: [A],
    parentCollection: completeParent(7, scheduledFor, 1),
    store,
    now: () => scheduledFor + 50,
    sleep: async () => {},
    cooldownMs: 0,
    requestSpacingMs: 0,
    baseWindowMs: 24 * 3_600_000,
    fetchWindow: async (address, _startTime, endTime) => {
      fetched += 1;
      return rawPayment(address, endTime);
    },
    archiveSource: () => "/archive/source.json.gz",
    verifyArchive: () => { throw new Error("archive hash mismatch"); },
  });

  assert.equal(store.invalidated.length, 1);
  assert.equal((store.reserved[0] as { attemptNo: number }).attemptNo, 2);
  assert.equal(fetched, 1);
  assert.equal(result.status, "complete");
});

test("funding runtime retries retryable fetch failures with backoff inside its persisted budget", async () => {
  const scheduledFor = Date.UTC(2026, 7, 9, 8);
  const store = fakeStore();
  const sleeps: number[] = [];
  let fetches = 0;
  const result = await collectCohortFundingEvidence({
    collectionRunId: 10,
    scheduledFor,
    addresses: [A],
    parentCollection: completeParent(10, scheduledFor, 1),
    store,
    now: () => scheduledFor + 60,
    sleep: async (ms) => { sleeps.push(ms); },
    cooldownMs: 0,
    requestSpacingMs: 0,
    retryBackoffMs: 100,
    maxFetchAttempts: 3,
    baseWindowMs: 24 * 3_600_000,
    fetchWindow: async (address, _startTime, endTime) => {
      fetches += 1;
      if (fetches < 3) throw new UserFundingFetchError("HTTP 429", true, 429);
      return rawPayment(address, endTime);
    },
    archiveSource: () => "/archive/source.json.gz",
    verifyArchive: () => {},
  });

  assert.equal(result.status, "complete");
  assert.equal(result.requestCount, 3);
  assert.deepEqual(sleeps, [100, 200]);
  assert.equal(
    (store.finished[0] as { sourceManifest: { requestCount: number } }).sourceManifest.requestCount,
    3,
  );
});

test("funding stage isolation reports auxiliary failure without rejecting core follow-up", async () => {
  const failures: string[] = [];
  const completed = await runFundingStageIsolated(
    async () => { throw new Error("archive invalidation race"); },
    (message) => { failures.push(message); },
  );

  assert.equal(completed, false);
  assert.deepEqual(failures, ["archive invalidation race"]);
});
