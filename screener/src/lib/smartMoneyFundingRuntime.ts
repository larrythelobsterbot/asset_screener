import {
  FUNDING_POLICY_V1,
  HYPERLIQUID_INFO_URL,
  collectUserFundingRange,
  isRetryableUserFundingFetchError,
  type RawUserFundingSource,
  type UserFundingRangeResult,
  type UserFundingWindowFetcher,
} from "./smartMoneyFunding";
import type { CollectionRunRecord, FundingRunRecord, FundingWindowRecord } from "./smartMoneyPilotStore";

export interface FundingEvidenceStore {
  reserveFundingRun(input: {
    runKey: string;
    attemptNo: number;
    collectionRunId: number;
    policyVersion: string;
    startAt: number;
    endAt: number;
    startedAt: number;
    walletExpected: number;
    sourceManifest: unknown;
  }): { id: number; created: boolean };
  fundingRun(id: number): FundingRunRecord | null;
  latestFundingRunForCollection(collectionRunId: number, policyVersion: string): FundingRunRecord | null;
  markStaleFundingRunsFailed(staleBefore: number, observedAt: number): number;
  fundingRunWindows(fundingRunId: number): FundingWindowRecord[];
  fundingRunPaymentAssociationCount(fundingRunId: number): number;
  invalidateFundingRun(id: number, observedAt: number, error: string): boolean;
  recordFundingWalletResult(
    fundingRunId: number,
    result: UserFundingRangeResult,
    createdAt: number,
  ): {
    windowsInserted: number;
    paymentsInserted: number;
    paymentAssociationsInserted: number;
  };
  finishFundingRun(id: number, input: {
    status: "complete" | "partial" | "failed";
    completedAt: number;
    walletSucceeded: number;
    windowCount: number;
    paymentCount: number;
    sourceManifest: unknown;
    error: string | null;
  }): boolean;
}

export interface CohortFundingCollectionResult {
  id: number;
  created: boolean;
  status: FundingRunRecord["status"];
  walletExpected: number;
  walletSucceeded: number;
  windowCount: number;
  paymentCount: number;
  requestCount: number;
  failedWallets: Array<{ address: string; error: string }>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runFundingStageIsolated(
  stage: () => Promise<void>,
  reportFailure: (message: string) => void,
): Promise<boolean> {
  try {
    await stage();
    return true;
  } catch (error) {
    reportFailure(errorText(error));
    return false;
  }
}

export function fundingRunKey(
  collectionRunId: number,
  attemptNo: number,
  policyVersion = FUNDING_POLICY_V1.version,
): string {
  if (!Number.isInteger(collectionRunId) || collectionRunId <= 0) {
    throw new Error("funding collection run id is invalid");
  }
  if (!Number.isInteger(attemptNo) || attemptNo <= 0) throw new Error("funding attempt number is invalid");
  if (!policyVersion.trim()) throw new Error("funding policy version is required");
  return `smart-money-funding:${collectionRunId}:${policyVersion}:attempt-${attemptNo}`;
}

export async function collectCohortFundingEvidence(input: {
  collectionRunId: number;
  scheduledFor: number;
  addresses: string[];
  parentCollection: CollectionRunRecord;
  store: FundingEvidenceStore;
  fetchWindow: UserFundingWindowFetcher;
  archiveSource: (
    source: RawUserFundingSource,
    startTime: number,
    endTime: number,
    address: string,
  ) => string;
  verifyArchive: (path: string, expectedSha256: string, expectedBytes: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cooldownMs?: number;
  requestSpacingMs?: number;
  baseWindowMs?: number;
  maxTotalRequests?: number;
  maxFetchAttempts?: number;
  retryBackoffMs?: number;
}): Promise<CohortFundingCollectionResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cooldownMs = input.cooldownMs ?? 60_000;
  const requestSpacingMs = input.requestSpacingMs ?? FUNDING_POLICY_V1.requestSpacingMs;
  const maxTotalRequests = input.maxTotalRequests ?? 160;
  const maxFetchAttempts = input.maxFetchAttempts ?? 3;
  const retryBackoffMs = input.retryBackoffMs ?? 5_000;
  if (!Number.isInteger(input.scheduledFor) || input.scheduledFor < FUNDING_POLICY_V1.lookbackMs) {
    throw new Error("funding scheduled time is invalid");
  }
  if (![cooldownMs, requestSpacingMs, retryBackoffMs]
    .every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error("funding pacing must use non-negative integer milliseconds");
  }
  if (!Number.isInteger(maxTotalRequests) || maxTotalRequests <= 0) {
    throw new Error("funding request budget must be a positive integer");
  }
  if (!Number.isInteger(maxFetchAttempts) || maxFetchAttempts <= 0 || maxFetchAttempts > 5) {
    throw new Error("funding fetch attempts must be an integer from 1 to 5");
  }
  const addresses = input.addresses.map((address) => address.toLowerCase()).sort();
  if (new Set(addresses).size !== addresses.length) throw new Error("funding cohort contains duplicate addresses");
  const parent = input.parentCollection;
  if (parent.id !== input.collectionRunId || parent.runKind !== "collection" || parent.status !== "complete"
    || parent.scheduledFor !== input.scheduledFor
    || parent.walletExpected !== addresses.length || parent.walletSucceeded !== parent.walletExpected
    || parent.vaultSucceeded !== parent.vaultExpected) {
    throw new Error(`funding parent collection ${input.collectionRunId} is not complete or does not match the request`);
  }
  const startAt = input.scheduledFor - FUNDING_POLICY_V1.lookbackMs;
  const endAt = input.scheduledFor;
  const startedAt = now();
  input.store.markStaleFundingRunsFailed(startedAt - 2 * 3_600_000, startedAt);
  const existingResult = (run: FundingRunRecord): CohortFundingCollectionResult => ({
    id: run.id,
    created: false,
    status: run.status,
    walletExpected: run.walletExpected,
    walletSucceeded: run.walletSucceeded,
    windowCount: run.windowCount,
    paymentCount: run.paymentCount,
    requestCount: 0,
    failedWallets: [],
  });
  const verifyRequestIdentity = (run: FundingRunRecord): void => {
    if (run.collectionRunId !== input.collectionRunId
      || run.policyVersion !== FUNDING_POLICY_V1.version
      || run.startAt !== startAt
      || run.endAt !== endAt
      || run.walletExpected !== addresses.length) {
      throw new Error(`funding run ${run.id} does not match the requested collection, policy, range, or wallet count`);
    }
  };
  const verifyCompleteRun = (run: FundingRunRecord): void => {
    verifyRequestIdentity(run);
    const windows = input.store.fundingRunWindows(run.id);
    if (windows.length !== run.windowCount) {
      throw new Error(`funding run ${run.id} window count ${windows.length} != ${run.windowCount}`);
    }
    const associatedPayments = input.store.fundingRunPaymentAssociationCount(run.id);
    if (associatedPayments !== run.paymentCount) {
      throw new Error(`funding run ${run.id} payment count ${associatedPayments} != ${run.paymentCount}`);
    }
    if (run.walletSucceeded !== addresses.length) {
      throw new Error(`funding run ${run.id} wallet success count does not match the requested cohort`);
    }
    const expectedAddresses = new Set(addresses);
    const terminalByAddress = new Map<string, FundingWindowRecord[]>();
    for (const window of windows.filter(({ status }) => status === "complete")) {
      const address = window.address.toLowerCase();
      if (!expectedAddresses.has(address)) {
        throw new Error(`funding run ${run.id} contains unexpected terminal wallet ${address}`);
      }
      const terminal = terminalByAddress.get(address) ?? [];
      terminal.push(window);
      terminalByAddress.set(address, terminal);
    }
    if (terminalByAddress.size !== expectedAddresses.size) {
      throw new Error(`funding run ${run.id} terminal wallet set does not match the requested cohort`);
    }
    for (const address of expectedAddresses) {
      const terminal = (terminalByAddress.get(address) ?? [])
        .sort((left, right) => left.startAt - right.startAt || left.endAt - right.endAt);
      let coveredEnd = startAt;
      for (const window of terminal) {
        if (window.startAt !== coveredEnd || window.endAt <= window.startAt || window.endAt > endAt) {
          throw new Error(`funding run ${run.id} terminal partition is invalid for ${address}`);
        }
        coveredEnd = window.endAt;
      }
      if (coveredEnd !== endAt) {
        throw new Error(`funding run ${run.id} terminal partition is incomplete for ${address}`);
      }
    }
    for (const window of windows) {
      input.verifyArchive(window.sourceArchivePath, window.sourceSha256, window.sourceBytes);
    }
  };

  let previous = input.store.latestFundingRunForCollection(
    input.collectionRunId,
    FUNDING_POLICY_V1.version,
  );
  if (previous?.status === "complete") {
    try {
      verifyCompleteRun(previous);
      return existingResult(previous);
    } catch (error) {
      const message = `complete funding evidence failed revalidation: ${errorText(error)}`.slice(0, 2_000);
      if (!input.store.invalidateFundingRun(previous.id, startedAt, message)) {
        throw new Error(`funding run ${previous.id} could not be invalidated after archive failure`);
      }
      previous = { ...previous, status: "invalid" };
    }
  }
  if (previous?.status === "running") {
    verifyRequestIdentity(previous);
    return existingResult(previous);
  }

  const attemptNo = (previous?.attemptNo ?? 0) + 1;
  const runKey = fundingRunKey(input.collectionRunId, attemptNo);
  const initialManifest = {
    sourceUrl: HYPERLIQUID_INFO_URL,
    policyVersion: FUNDING_POLICY_V1.version,
    attemptNo,
    range: { startAt, endAt, inclusive: true },
    pagination: {
      responseCap: FUNDING_POLICY_V1.responseCap,
      baseWindowMs: input.baseWindowMs ?? FUNDING_POLICY_V1.baseWindowMs,
      overlapBoundary: true,
      cappedWindowAction: "bisect",
    },
    pacing: { cooldownMs, requestSpacingMs, retryBackoffMs, maxFetchAttempts },
    maxTotalRequests,
    walletExpected: addresses.length,
  };
  const reserved = input.store.reserveFundingRun({
    runKey,
    attemptNo,
    collectionRunId: input.collectionRunId,
    policyVersion: FUNDING_POLICY_V1.version,
    startAt,
    endAt,
    startedAt,
    walletExpected: addresses.length,
    sourceManifest: initialManifest,
  });
  if (!reserved.created) {
    const existing = input.store.fundingRun(reserved.id);
    if (!existing) throw new Error(`reserved funding run ${reserved.id} is missing`);
    if (existing.status === "complete") verifyCompleteRun(existing);
    else verifyRequestIdentity(existing);
    return existingResult(existing);
  }

  if (addresses.length > 0 && cooldownMs > 0) await sleep(cooldownMs);
  let requestCount = 0;
  const pacedFetch: UserFundingWindowFetcher = async (address, windowStart, windowEnd) => {
    for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
      if (requestCount >= maxTotalRequests) {
        throw new Error(`funding request budget exhausted at ${maxTotalRequests}`);
      }
      requestCount += 1;
      if (requestSpacingMs > 0) await sleep(requestSpacingMs);
      try {
        return await input.fetchWindow(address, windowStart, windowEnd);
      } catch (error) {
        if (!isRetryableUserFundingFetchError(error) || attempt === maxFetchAttempts) throw error;
        const backoff = retryBackoffMs * (2 ** (attempt - 1));
        if (backoff > 0) await sleep(backoff);
      }
    }
    throw new Error("funding retry loop exhausted unexpectedly");
  };
  const failedWallets: Array<{ address: string; error: string }> = [];
  const walletEvidence: Array<{
    address: string;
    status: "complete" | "failed";
    windowCount: number;
    paymentCount: number;
    error: string | null;
  }> = [];
  let walletSucceeded = 0;
  let windowCount = 0;
  let paymentCount = 0;

  for (const address of addresses) {
    try {
      const result = await collectUserFundingRange({
        address,
        startTime: startAt,
        endTime: endAt,
        baseWindowMs: input.baseWindowMs,
        fetchWindow: pacedFetch,
        archiveSource: input.archiveSource,
      });
      input.store.recordFundingWalletResult(reserved.id, result, now());
      walletSucceeded += 1;
      windowCount += result.windows.length;
      paymentCount += result.payments.length;
      walletEvidence.push({
        address,
        status: "complete",
        windowCount: result.windows.length,
        paymentCount: result.payments.length,
        error: null,
      });
    } catch (error) {
      const message = errorText(error).slice(0, 1_000);
      failedWallets.push({ address, error: message });
      walletEvidence.push({ address, status: "failed", windowCount: 0, paymentCount: 0, error: message });
    }
  }

  const status = walletSucceeded === addresses.length
    ? "complete"
    : walletSucceeded > 0 ? "partial" : "failed";
  const completedAt = now();
  const failureSummary = failedWallets.length > 0
    ? `${failedWallets.length}/${addresses.length} funding wallets failed`
    : null;
  const sourceManifest = {
    ...initialManifest,
    coverage: status === "complete" ? "complete" : "incomplete",
    walletSucceeded,
    windowCount,
    paymentCount,
    requestCount,
    failedWallets,
    wallets: walletEvidence,
  };
  const finished = input.store.finishFundingRun(reserved.id, {
    status,
    completedAt,
    walletSucceeded,
    windowCount,
    paymentCount,
    sourceManifest,
    error: failureSummary,
  });
  if (!finished) throw new Error(`funding run ${reserved.id} did not finish from running state`);
  return {
    id: reserved.id,
    created: true,
    status,
    walletExpected: addresses.length,
    walletSucceeded,
    windowCount,
    paymentCount,
    requestCount,
    failedWallets,
  };
}
