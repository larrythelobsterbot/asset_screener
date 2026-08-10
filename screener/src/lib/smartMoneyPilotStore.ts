import type Database from "better-sqlite3";
import { getDb } from "./db";
import type {
  CohortTransitionContext,
  SmartMoneyEventCandidate,
  SmartMoneyEventOutcome,
  VaultSnapshot,
  WalletPerformanceEvidence,
  WalletPosition,
  WalletPositionSnapshot,
} from "./smartMoneyPilot";
import {
  HYPERLIQUID_INFO_URL,
  type UserFundingPayment,
  type UserFundingRangeResult,
} from "./smartMoneyFunding";

export type CohortMembershipChange = "entry" | "stay" | "exit" | "ineligible";

export interface CohortMemberInput {
  address: string;
  isMember: boolean;
  membershipChange: CohortMembershipChange;
  score: number | null;
  suspectedGaming: boolean;
  exclusionReasons: string[];
  evidence: unknown;
}

export interface SaveCohortVersionInput {
  versionKey: string;
  policyVersion: string;
  computedAt: number;
  candidateCount: number;
  eligibleCount: number;
  memberCount: number;
  sourceUrl: string;
  sourceSha256: string;
  evidence: unknown;
  members: CohortMemberInput[];
}

export interface CohortVersionRecord {
  id: number;
  versionKey: string;
  policyVersion: string;
  computedAt: number;
  activeAddresses: string[];
}

export interface ReserveCollectionRunInput {
  runKey: string;
  runKind?: "cohort" | "collection";
  scheduledFor: number;
  startedAt: number;
  cohortVersionId: number;
  walletExpected: number;
  vaultExpected: number;
  sourceManifest: unknown;
}

export interface WalletSnapshotInput {
  address: string;
  observedAt: number;
  accountValue: number | null;
  status: "complete" | "failed";
  sourceUrl: string;
  error: string | null;
  positions: WalletPosition[];
}

export interface VaultSnapshotInput extends VaultSnapshot {
  leaderAddress: string | null;
  relationshipType: "normal" | "parent" | "child";
  apr: number | null;
  isClosed: boolean;
}

export interface CollectionRunRecord {
  id: number;
  runKey: string;
  runKind: "cohort" | "collection";
  scheduledFor: number;
  status: "running" | "complete" | "partial" | "failed";
  cohortVersionId: number;
  walletExpected: number;
  walletSucceeded: number;
  vaultExpected: number;
  vaultSucceeded: number;
}

export interface FundingRunRecord {
  id: number;
  runKey: string;
  collectionRunId: number;
  policyVersion: string;
  attemptNo: number;
  startAt: number;
  endAt: number;
  startedAt: number;
  completedAt: number | null;
  status: "running" | "complete" | "partial" | "failed" | "invalid";
  walletExpected: number;
  walletSucceeded: number;
  windowCount: number;
  paymentCount: number;
  sourceManifest: unknown;
  error: string | null;
}

export interface FundingWindowRecord {
  address: string;
  startAt: number;
  endAt: number;
  status: "complete" | "saturated";
  responseCount: number;
  sourceSha256: string;
  sourceBytes: number;
  sourceArchivePath: string;
}

export interface FundingAggregationScope {
  cohortVersionId: number;
  policyVersion: string;
  lookbackMs: number;
}

export interface StoredSmartMoneyEvent extends SmartMoneyEventCandidate {
  id: number;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function lower(address: string): string {
  return address.toLowerCase();
}

export function createSmartMoneyPilotStore(db: Database.Database = getDb()) {
  function validateFundingAggregationScope(scope: FundingAggregationScope): void {
    if (!Number.isInteger(scope.cohortVersionId) || scope.cohortVersionId <= 0
      || !scope.policyVersion.trim()
      || !Number.isInteger(scope.lookbackMs) || scope.lookbackMs <= 0) {
      throw new Error("funding aggregation scope is invalid");
    }
  }

  function ensureFundingTerminalWindowCoverage(
    fundingRunId: number,
    run: FundingRunRecord,
    expectedWallets: number,
  ): void {
    const rows = db.prepare(`
      select address, start_at, end_at
      from smart_money_funding_windows
      where funding_run_id = ? and status = 'complete'
      order by address, start_at, end_at
    `).all(fundingRunId) as Array<{ address: string; start_at: number; end_at: number }>;
    const byAddress = new Map<string, Array<{ startAt: number; endAt: number }>>();
    for (const row of rows) {
      const windows = byAddress.get(row.address) ?? [];
      windows.push({ startAt: row.start_at, endAt: row.end_at });
      byAddress.set(row.address, windows);
    }
    if (byAddress.size !== expectedWallets) {
      throw new Error(
        `funding run ${fundingRunId} terminal window coverage has ${byAddress.size} wallets != ${expectedWallets}`,
      );
    }
    for (const [address, windows] of byAddress) {
      if (windows[0]?.startAt !== run.startAt) {
        throw new Error(`funding run ${fundingRunId} terminal window coverage for ${address} has no range start`);
      }
      let coveredEnd = run.startAt;
      for (const window of windows) {
        if (window.startAt < run.startAt || window.endAt > run.endAt
          || window.endAt <= window.startAt || window.startAt !== coveredEnd) {
          throw new Error(`funding run ${fundingRunId} terminal window coverage for ${address} has a gap or overlap`);
        }
        coveredEnd = Math.max(coveredEnd, window.endAt);
      }
      if (coveredEnd !== run.endAt) {
        throw new Error(`funding run ${fundingRunId} terminal window coverage for ${address} has no range end`);
      }
    }
  }

  function ensureFundingTerminalWalletSet(
    fundingRunId: number,
    cohortVersionId: number,
  ): void {
    const mismatch = db.prepare(`
      select address from (
        select expected.address
        from smart_money_cohort_members expected
        where expected.cohort_version_id = @cohortVersionId and expected.is_member = 1
          and not exists (
            select 1 from smart_money_funding_windows observed
            where observed.funding_run_id = @fundingRunId and observed.status = 'complete'
              and observed.address = expected.address
          )
        union all
        select observed.address
        from smart_money_funding_windows observed
        where observed.funding_run_id = @fundingRunId and observed.status = 'complete'
          and not exists (
            select 1 from smart_money_cohort_members expected
            where expected.cohort_version_id = @cohortVersionId and expected.is_member = 1
              and expected.address = observed.address
          )
      ) limit 1
    `).get({ fundingRunId, cohortVersionId }) as { address: string } | undefined;
    if (mismatch) {
      throw new Error(`funding run ${fundingRunId} terminal wallet set does not match active cohort members`);
    }
  }

  function saveCohortVersion(input: SaveCohortVersionInput): { id: number; created: boolean } {
    return db.transaction(() => {
      const insert = db.prepare(`
        insert into smart_money_cohort_versions (
          version_key, policy_version, computed_at, candidate_count, eligible_count,
          member_count, source_url, source_sha256, evidence_json
        ) values (
          @versionKey, @policyVersion, @computedAt, @candidateCount, @eligibleCount,
          @memberCount, @sourceUrl, @sourceSha256, @evidenceJson
        ) on conflict(version_key) do nothing
      `).run({ ...input, evidenceJson: json(input.evidence) });
      const row = db.prepare(
        "select id from smart_money_cohort_versions where version_key = ?",
      ).get(input.versionKey) as { id: number };
      const created = insert.changes === 1;
      if (created) {
        const memberStmt = db.prepare(`
          insert into smart_money_cohort_members (
            cohort_version_id, address, is_member, membership_change, score,
            suspected_gaming, exclusion_reasons_json, evidence_json
          ) values (
            @cohortVersionId, @address, @isMember, @membershipChange, @score,
            @suspectedGaming, @exclusionReasonsJson, @evidenceJson
          )
        `);
        for (const member of input.members) {
          memberStmt.run({
            cohortVersionId: row.id,
            address: lower(member.address),
            isMember: member.isMember ? 1 : 0,
            membershipChange: member.membershipChange,
            score: member.score,
            suspectedGaming: member.suspectedGaming ? 1 : 0,
            exclusionReasonsJson: json(member.exclusionReasons),
            evidenceJson: json(member.evidence),
          });
        }
      }
      return { id: row.id, created };
    })();
  }

  function latestCohortVersion(): CohortVersionRecord | null {
    const version = db.prepare(`
      select id, version_key, policy_version, computed_at
      from smart_money_cohort_versions order by computed_at desc, id desc limit 1
    `).get() as {
      id: number;
      version_key: string;
      policy_version: string;
      computed_at: number;
    } | undefined;
    if (!version) return null;
    return {
      id: version.id,
      versionKey: version.version_key,
      policyVersion: version.policy_version,
      computedAt: version.computed_at,
      activeAddresses: activeAddressesForCohort(version.id),
    };
  }

  function activeAddressesForCohort(cohortVersionId: number): string[] {
    return (db.prepare(`
      select address from smart_money_cohort_members
      where cohort_version_id = ? and is_member = 1
      order by score desc, address asc
    `).all(cohortVersionId) as Array<{ address: string }>).map(({ address }) => address);
  }

  function previousActiveAddresses(): Set<string> {
    const versions = db.prepare(`
      select id from smart_money_cohort_versions order by computed_at desc, id desc limit 2
    `).all() as Array<{ id: number }>;
    const previous = versions[1];
    if (!previous) return new Set();
    return new Set((db.prepare(`
      select address from smart_money_cohort_members
      where cohort_version_id = ? and is_member = 1
    `).all(previous.id) as Array<{ address: string }>).map(({ address }) => address));
  }

  function cohortTransitionContext(cohortVersionId: number): CohortTransitionContext {
    const current = db.prepare(`
      select id, version_key, computed_at from smart_money_cohort_versions where id = ?
    `).get(cohortVersionId) as {
      id: number;
      version_key: string;
      computed_at: number;
    } | undefined;
    if (!current) throw new Error(`unknown cohort version ${cohortVersionId}`);
    const previous = db.prepare(`
      select id, version_key from smart_money_cohort_versions
      where computed_at < @computedAt or (computed_at = @computedAt and id < @id)
      order by computed_at desc, id desc limit 1
    `).get({ computedAt: current.computed_at, id: current.id }) as {
      id: number;
      version_key: string;
    } | undefined;
    const activeAddresses = (versionId: number): Set<string> => new Set((db.prepare(`
      select address from smart_money_cohort_members
      where cohort_version_id = ? and is_member = 1
    `).all(versionId) as Array<{ address: string }>).map(({ address }) => address));
    const currentAddresses = activeAddresses(current.id);
    const previousAddresses = previous ? activeAddresses(previous.id) : new Set<string>();
    let stays = 0;
    for (const address of currentAddresses) {
      if (previousAddresses.has(address)) stays += 1;
    }
    return {
      currentVersionKey: current.version_key,
      previousVersionKey: previous?.version_key ?? null,
      currentMembers: currentAddresses.size,
      previousMembers: previousAddresses.size,
      entries: currentAddresses.size - stays,
      stays,
      exits: previousAddresses.size - stays,
    };
  }

  function reserveCollectionRun(input: ReserveCollectionRunInput): { id: number; created: boolean } {
    const insert = db.prepare(`
      insert into smart_money_collection_runs (
        run_key, run_kind, scheduled_for, started_at, status, cohort_version_id,
        wallet_expected, vault_expected, source_manifest_json, created_at, updated_at
      ) values (
        @runKey, @runKind, @scheduledFor, @startedAt, 'running', @cohortVersionId,
        @walletExpected, @vaultExpected, @sourceManifestJson, @startedAt, @startedAt
      ) on conflict(run_key) do nothing
    `).run({ ...input, runKind: input.runKind ?? "collection", sourceManifestJson: json(input.sourceManifest) });
    const row = db.prepare(
      "select id from smart_money_collection_runs where run_key = ?",
    ).get(input.runKey) as { id: number };
    return { id: row.id, created: insert.changes === 1 };
  }

  function markStaleRunsFailed(staleBefore: number, observedAt: number): number {
    return db.prepare(`
      update smart_money_collection_runs
      set status = 'failed', completed_at = @observedAt,
        error = 'stale running collection recovered after process exit', updated_at = @observedAt
      where status = 'running' and started_at < @staleBefore
    `).run({ staleBefore, observedAt }).changes;
  }

  function finishCollectionRun(id: number, input: {
    status: "complete" | "partial" | "failed";
    completedAt: number;
    walletSucceeded: number;
    vaultSucceeded: number;
    error: string | null;
  }): boolean {
    return db.prepare(`
      update smart_money_collection_runs
      set status = @status, completed_at = @completedAt,
        wallet_succeeded = @walletSucceeded, vault_succeeded = @vaultSucceeded,
        error = @error, updated_at = @completedAt
      where id = @id and status = 'running'
    `).run({ id, ...input, error: input.error?.slice(0, 2_000) ?? null }).changes === 1;
  }

  function reserveFundingRun(input: {
    runKey: string;
    attemptNo: number;
    collectionRunId: number;
    policyVersion: string;
    startAt: number;
    endAt: number;
    startedAt: number;
    walletExpected: number;
    sourceManifest: unknown;
  }): { id: number; created: boolean } {
    const insert = db.prepare(`
      insert into smart_money_funding_runs (
        run_key, collection_run_id, policy_version, attempt_no, start_at, end_at,
        started_at, status, wallet_expected, source_manifest_json, created_at, updated_at
      ) values (
        @runKey, @collectionRunId, @policyVersion, @attemptNo, @startAt, @endAt,
        @startedAt, 'running', @walletExpected, @sourceManifestJson, @startedAt, @startedAt
      ) on conflict do nothing
    `).run({ ...input, sourceManifestJson: json(input.sourceManifest) });
    const row = db.prepare(
      "select id from smart_money_funding_runs where run_key = ?",
    ).get(input.runKey) as { id: number };
    const existing = fundingRun(row.id);
    if (!existing
      || existing.collectionRunId !== input.collectionRunId
      || existing.policyVersion !== input.policyVersion
      || existing.attemptNo !== input.attemptNo
      || existing.startAt !== input.startAt
      || existing.endAt !== input.endAt
      || existing.walletExpected !== input.walletExpected) {
      throw new Error(`funding run key collision for ${input.runKey}`);
    }
    return { id: row.id, created: insert.changes === 1 };
  }

  function fundingRun(id: number): FundingRunRecord | null {
    const row = db.prepare(`
      select id, run_key, collection_run_id, policy_version, attempt_no, start_at, end_at,
        started_at, completed_at, status, wallet_expected, wallet_succeeded, window_count,
        payment_count, source_manifest_json, error
      from smart_money_funding_runs where id = ?
    `).get(id) as {
      id: number; run_key: string; collection_run_id: number; policy_version: string; attempt_no: number;
      start_at: number; end_at: number; started_at: number; completed_at: number | null;
      status: FundingRunRecord["status"];
      wallet_expected: number; wallet_succeeded: number; window_count: number;
      payment_count: number; source_manifest_json: string; error: string | null;
    } | undefined;
    return row ? {
      id: row.id,
      runKey: row.run_key,
      collectionRunId: row.collection_run_id,
      policyVersion: row.policy_version,
      attemptNo: row.attempt_no,
      startAt: row.start_at,
      endAt: row.end_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: row.status,
      walletExpected: row.wallet_expected,
      walletSucceeded: row.wallet_succeeded,
      windowCount: row.window_count,
      paymentCount: row.payment_count,
      sourceManifest: JSON.parse(row.source_manifest_json),
      error: row.error,
    } : null;
  }

  function latestFundingRunForCollection(
    collectionRunId: number,
    policyVersion: string,
  ): FundingRunRecord | null {
    const row = db.prepare(`
      select id from smart_money_funding_runs
      where collection_run_id = ? and policy_version = ?
      order by attempt_no desc limit 1
    `).get(collectionRunId, policyVersion) as { id: number } | undefined;
    return row ? fundingRun(row.id) : null;
  }

  function fundingRunWindows(fundingRunId: number): FundingWindowRecord[] {
    return (db.prepare(`
      select address, start_at, end_at, status, response_count,
        source_sha256, source_bytes, source_archive_path
      from smart_money_funding_windows
      where funding_run_id = ?
      order by address, start_at, end_at
    `).all(fundingRunId) as Array<{
      address: string; start_at: number; end_at: number;
      status: FundingWindowRecord["status"]; response_count: number;
      source_sha256: string; source_bytes: number; source_archive_path: string;
    }>).map((row) => ({
      address: row.address,
      startAt: row.start_at,
      endAt: row.end_at,
      status: row.status,
      responseCount: row.response_count,
      sourceSha256: row.source_sha256,
      sourceBytes: row.source_bytes,
      sourceArchivePath: row.source_archive_path,
    }));
  }

  function fundingRunPaymentAssociationCount(fundingRunId: number): number {
    return (db.prepare(`
      select count(*) as count from smart_money_funding_run_payments where funding_run_id = ?
    `).get(fundingRunId) as { count: number }).count;
  }

  function invalidateFundingRun(id: number, observedAt: number, error: string): boolean {
    return db.prepare(`
      update smart_money_funding_runs
      set status = 'invalid', error = @error, updated_at = @observedAt
      where id = @id and status = 'complete'
    `).run({ id, observedAt, error: error.slice(0, 2_000) }).changes === 1;
  }

  function markStaleFundingRunsFailed(staleBefore: number, observedAt: number): number {
    return db.prepare(`
      update smart_money_funding_runs
      set status = 'failed', completed_at = @observedAt,
        error = 'stale running funding collection recovered after process exit', updated_at = @observedAt
      where status = 'running' and started_at < @staleBefore
    `).run({ staleBefore, observedAt }).changes;
  }

  function recordFundingWalletResult(
    fundingRunId: number,
    result: UserFundingRangeResult,
    createdAt: number,
  ): { windowsInserted: number; paymentsInserted: number; paymentAssociationsInserted: number } {
    return db.transaction(() => {
      const run = fundingRun(fundingRunId);
      if (!run || run.status !== "running") throw new Error(`funding run ${fundingRunId} is not running`);
      const address = lower(result.address);
      const activeMember = db.prepare(`
        select 1
        from smart_money_collection_runs collection
        join smart_money_cohort_members member
          on member.cohort_version_id = collection.cohort_version_id
        where collection.id = ? and member.address = ? and member.is_member = 1
      `).get(run.collectionRunId, address);
      if (!activeMember) {
        throw new Error(`funding wallet ${address} is not an active cohort member for run ${fundingRunId}`);
      }
      if (result.startTime !== run.startAt || result.endTime !== run.endAt) {
        throw new Error(`funding wallet range does not match run ${fundingRunId}`);
      }
      let windowsInserted = 0;
      for (const window of result.windows) {
        const values = {
          fundingRunId,
          address,
          startAt: window.startTime,
          endAt: window.endTime,
          status: window.status,
          responseCount: window.responseCount,
          sourceSha256: window.sourceSha256,
          sourceBytes: window.sourceBytes,
          sourceArchivePath: window.sourceArchivePath,
        };
        const existing = db.prepare(`
          select status, response_count, source_sha256, source_bytes, source_archive_path
          from smart_money_funding_windows
          where funding_run_id = @fundingRunId and address = @address
            and start_at = @startAt and end_at = @endAt
        `).get(values) as {
          status: string; response_count: number; source_sha256: string;
          source_bytes: number; source_archive_path: string;
        } | undefined;
        if (existing) {
          if (existing.status !== values.status
            || existing.response_count !== values.responseCount
            || existing.source_sha256 !== values.sourceSha256
            || existing.source_bytes !== values.sourceBytes
            || existing.source_archive_path !== values.sourceArchivePath) {
            throw new Error(`conflicting funding window ${result.address}:${window.startTime}-${window.endTime}`);
          }
          continue;
        }
        windowsInserted += db.prepare(`
          insert into smart_money_funding_windows (
            funding_run_id, address, start_at, end_at, status, response_count,
            source_sha256, source_bytes, source_archive_path
          ) values (
            @fundingRunId, @address, @startAt, @endAt, @status, @responseCount,
            @sourceSha256, @sourceBytes, @sourceArchivePath
          )
        `).run(values).changes;
      }
      let paymentsInserted = 0;
      let paymentAssociationsInserted = 0;
      for (const payment of result.payments) {
        if (lower(payment.address) !== address) {
          throw new Error(`funding payment address ${payment.address} does not match result wallet ${address}`);
        }
        if (!Number.isInteger(payment.time) || payment.time < run.startAt || payment.time > run.endAt) {
          throw new Error(`funding payment time ${payment.time} is outside funding run range`);
        }
        const values = {
          address: lower(payment.address),
          settlementAt: payment.time,
          coin: payment.coin,
          usdc: payment.usdc,
          szi: payment.szi,
          fundingRate: payment.fundingRate,
          nSamples: payment.nSamples,
          sourceHash: payment.hash,
          firstFundingRunId: fundingRunId,
          sourceUrl: HYPERLIQUID_INFO_URL,
          createdAt,
        };
        const existing = db.prepare(`
          select usdc, szi, funding_rate, n_samples, source_hash
          from smart_money_funding_payments
          where address = @address and settlement_at = @settlementAt and coin = @coin
        `).get(values) as {
          usdc: number; szi: number; funding_rate: number;
          n_samples: number | null; source_hash: string;
        } | undefined;
        if (existing) {
          if (existing.usdc !== values.usdc
            || existing.szi !== values.szi
            || existing.funding_rate !== values.fundingRate
            || existing.n_samples !== values.nSamples
            || existing.source_hash !== values.sourceHash) {
            throw new Error(`conflicting funding payment ${values.address}:${values.settlementAt}:${values.coin}`);
          }
        } else {
          paymentsInserted += db.prepare(`
            insert into smart_money_funding_payments (
              address, settlement_at, coin, usdc, szi, funding_rate, n_samples,
              source_hash, first_funding_run_id, source_url, created_at
            ) values (
              @address, @settlementAt, @coin, @usdc, @szi, @fundingRate, @nSamples,
              @sourceHash, @firstFundingRunId, @sourceUrl, @createdAt
            )
          `).run(values).changes;
        }
        paymentAssociationsInserted += db.prepare(`
          insert into smart_money_funding_run_payments (
            funding_run_id, address, settlement_at, coin
          ) values (@fundingRunId, @address, @settlementAt, @coin)
          on conflict(funding_run_id, address, settlement_at, coin) do nothing
        `).run({ fundingRunId, ...values }).changes;
      }
      return { windowsInserted, paymentsInserted, paymentAssociationsInserted };
    })();
  }

  function finishFundingRun(id: number, input: {
    status: "complete" | "partial" | "failed";
    completedAt: number;
    walletSucceeded: number;
    windowCount: number;
    paymentCount: number;
    sourceManifest: unknown;
    error: string | null;
  }): boolean {
    return db.transaction(() => {
      const run = fundingRun(id);
      if (!run || run.status !== "running") return false;
      if (input.status === "complete") {
        const parent = db.prepare(`
          select status, run_kind, scheduled_for, cohort_version_id,
            wallet_expected, wallet_succeeded, vault_expected, vault_succeeded
          from smart_money_collection_runs where id = ?
        `).get(run.collectionRunId) as {
          status: CollectionRunRecord["status"];
          run_kind: CollectionRunRecord["runKind"];
          scheduled_for: number;
          cohort_version_id: number;
          wallet_expected: number;
          wallet_succeeded: number;
          vault_expected: number;
          vault_succeeded: number;
        } | undefined;
        if (!parent || parent.status !== "complete" || parent.run_kind !== "collection") {
          throw new Error(`funding run ${id} parent collection is not complete`);
        }
        if (parent.scheduled_for !== run.endAt) {
          throw new Error(`funding run ${id} does not end at its parent collection time`);
        }
        if (parent.wallet_expected !== run.walletExpected) {
          throw new Error(`funding run ${id} wallet expectation does not match its parent collection`);
        }
        if (parent.wallet_succeeded !== parent.wallet_expected
          || parent.vault_succeeded !== parent.vault_expected) {
          throw new Error(`funding run ${id} parent collection counters are incomplete`);
        }
        const activeMemberCount = (db.prepare(`
          select count(*) as count from smart_money_cohort_members
          where cohort_version_id = ? and is_member = 1
        `).get(parent.cohort_version_id) as { count: number }).count;
        if (activeMemberCount !== run.walletExpected) {
          throw new Error(`funding run ${id} wallet expectation does not match its active cohort members`);
        }
        ensureFundingTerminalWalletSet(id, parent.cohort_version_id);
      }
      const persistedWindows = fundingRunWindows(id).length;
      if (persistedWindows !== input.windowCount) {
        throw new Error(`funding run ${id} persisted window count ${persistedWindows} != ${input.windowCount}`);
      }
      const persistedPayments = fundingRunPaymentAssociationCount(id);
      if (persistedPayments !== input.paymentCount) {
        throw new Error(`funding run ${id} persisted payment count ${persistedPayments} != ${input.paymentCount}`);
      }
      const persistedWallets = (db.prepare(`
        select count(distinct address) as count
        from smart_money_funding_windows where funding_run_id = ? and status = 'complete'
      `).get(id) as { count: number }).count;
      if (persistedWallets !== input.walletSucceeded) {
        throw new Error(`funding run ${id} persisted wallet count ${persistedWallets} != ${input.walletSucceeded}`);
      }
      ensureFundingTerminalWindowCoverage(id, run, input.walletSucceeded);
      return db.prepare(`
        update smart_money_funding_runs
        set status = @status, completed_at = @completedAt,
          wallet_succeeded = @walletSucceeded, window_count = @windowCount,
          payment_count = @paymentCount, source_manifest_json = @sourceManifestJson,
          error = @error, updated_at = @completedAt
        where id = @id and status = 'running'
      `).run({
        id,
        ...input,
        sourceManifestJson: json(input.sourceManifest),
        error: input.error?.slice(0, 2_000) ?? null,
      }).changes === 1;
    })();
  }

  function latestCompleteFundingRunAtOrBefore(
    endAt: number,
    scope: FundingAggregationScope,
  ): FundingRunRecord | null {
    validateFundingAggregationScope(scope);
    if (!Number.isInteger(endAt)) throw new Error("funding aggregation end time is invalid");
    const row = db.prepare(`
      select funding.id
      from smart_money_funding_runs funding
      join smart_money_collection_runs collection
        on collection.id = funding.collection_run_id
      where funding.status = 'complete' and funding.end_at <= @endAt
        and collection.status = 'complete' and collection.run_kind = 'collection'
        and collection.wallet_succeeded = collection.wallet_expected
        and collection.vault_succeeded = collection.vault_expected
        and collection.cohort_version_id = @cohortVersionId
        and collection.scheduled_for = funding.end_at
        and funding.wallet_expected = collection.wallet_expected
        and funding.wallet_expected = (
          select count(*) from smart_money_cohort_members expected
          where expected.cohort_version_id = collection.cohort_version_id
            and expected.is_member = 1
        )
        and not exists (
          select 1 from smart_money_funding_windows observed
          where observed.funding_run_id = funding.id and observed.status = 'complete'
            and not exists (
              select 1 from smart_money_cohort_members expected
              where expected.cohort_version_id = collection.cohort_version_id
                and expected.is_member = 1 and expected.address = observed.address
            )
        )
        and not exists (
          select 1 from smart_money_cohort_members expected
          where expected.cohort_version_id = collection.cohort_version_id
            and expected.is_member = 1
            and not exists (
              select 1 from smart_money_funding_windows observed
              where observed.funding_run_id = funding.id and observed.status = 'complete'
                and observed.address = expected.address
            )
        )
        and funding.policy_version = @policyVersion
        and funding.end_at - funding.start_at = @lookbackMs
      order by funding.end_at desc, funding.id desc limit 1
    `).get({ endAt, ...scope }) as { id: number } | undefined;
    return row ? fundingRun(row.id) : null;
  }

  function completeFundingPayments(
    fundingRunId: number,
    scope: FundingAggregationScope,
  ): UserFundingPayment[] {
    validateFundingAggregationScope(scope);
    const aggregateReady = db.prepare(`
      select funding.id
      from smart_money_funding_runs funding
      join smart_money_collection_runs collection
        on collection.id = funding.collection_run_id
      where funding.id = @fundingRunId and funding.status = 'complete'
        and collection.status = 'complete' and collection.run_kind = 'collection'
        and collection.wallet_succeeded = collection.wallet_expected
        and collection.vault_succeeded = collection.vault_expected
        and collection.cohort_version_id = @cohortVersionId
        and collection.scheduled_for = funding.end_at
        and funding.wallet_expected = collection.wallet_expected
        and funding.wallet_expected = (
          select count(*) from smart_money_cohort_members expected
          where expected.cohort_version_id = collection.cohort_version_id
            and expected.is_member = 1
        )
        and not exists (
          select 1 from smart_money_funding_windows observed
          where observed.funding_run_id = funding.id and observed.status = 'complete'
            and not exists (
              select 1 from smart_money_cohort_members expected
              where expected.cohort_version_id = collection.cohort_version_id
                and expected.is_member = 1 and expected.address = observed.address
            )
        )
        and not exists (
          select 1 from smart_money_cohort_members expected
          where expected.cohort_version_id = collection.cohort_version_id
            and expected.is_member = 1
            and not exists (
              select 1 from smart_money_funding_windows observed
              where observed.funding_run_id = funding.id and observed.status = 'complete'
                and observed.address = expected.address
            )
        )
        and funding.policy_version = @policyVersion
        and funding.end_at - funding.start_at = @lookbackMs
    `).get({ fundingRunId, ...scope }) as { id: number } | undefined;
    if (!aggregateReady) {
      throw new Error(`funding run ${fundingRunId} is not aggregate-ready`);
    }
    return (db.prepare(`
      select payment.address, payment.settlement_at, payment.coin, payment.usdc,
        payment.szi, payment.funding_rate, payment.n_samples, payment.source_hash
      from smart_money_funding_run_payments association
      join smart_money_funding_payments payment
        on payment.address = association.address
        and payment.settlement_at = association.settlement_at
        and payment.coin = association.coin
      where association.funding_run_id = ?
      order by payment.settlement_at, payment.coin, payment.address
    `).all(fundingRunId) as Array<{
      address: string; settlement_at: number; coin: string; usdc: number;
      szi: number; funding_rate: number; n_samples: number | null; source_hash: string;
    }>).map((row) => ({
      address: row.address,
      time: row.settlement_at,
      coin: row.coin,
      usdc: row.usdc,
      szi: row.szi,
      fundingRate: row.funding_rate,
      nSamples: row.n_samples,
      hash: row.source_hash,
    }));
  }

  function recordWalletSnapshot(runId: number, snapshot: WalletSnapshotInput): boolean {
    return db.transaction(() => {
      const inserted = db.prepare(`
        insert into smart_money_wallet_snapshots (
          collection_run_id, address, observed_at, account_value, status, source_url, error
        ) values (@runId, @address, @observedAt, @accountValue, @status, @sourceUrl, @error)
        on conflict(collection_run_id, address) do nothing
      `).run({
        runId,
        ...snapshot,
        address: lower(snapshot.address),
        error: snapshot.error?.slice(0, 1_000) ?? null,
      }).changes === 1;
      if (!inserted || snapshot.status !== "complete") return inserted;
      const stmt = db.prepare(`
        insert into smart_money_wallet_positions (
          collection_run_id, address, coin, szi, position_value, entry_px, unrealized_pnl, leverage
        ) values (@runId, @address, @coin, @szi, @positionValue, @entryPx, @unrealizedPnl, @leverage)
      `);
      for (const position of snapshot.positions) {
        stmt.run({
          runId,
          address: lower(snapshot.address),
          coin: position.coin.includes(":") ? position.coin : position.coin.toUpperCase(),
          szi: position.szi,
          positionValue: Math.abs(position.positionValue),
          entryPx: (position as WalletPosition & { entryPx?: number | null }).entryPx ?? null,
          unrealizedPnl: (position as WalletPosition & { unrealizedPnl?: number | null }).unrealizedPnl ?? null,
          leverage: position.leverage,
        });
      }
      return true;
    })();
  }

  function recordVaultSnapshots(runId: number, snapshots: VaultSnapshotInput[]): number {
    const stmt = db.prepare(`
      insert into smart_money_vault_snapshots (
        collection_run_id, vault_address, observed_at, name, leader_address,
        relationship_type, tvl, apr, cumulative_pnl, follower_count, is_closed,
        verification_url
      ) values (
        @runId, @vaultAddress, @observedAt, @name, @leaderAddress,
        @relationshipType, @tvl, @apr, @cumulativePnl, @followerCount, @isClosed,
        @verificationUrl
      ) on conflict(collection_run_id, vault_address) do nothing
    `);
    return db.transaction((rows: VaultSnapshotInput[]) => {
      let inserted = 0;
      for (const snapshot of rows) {
        inserted += stmt.run({
          ...snapshot,
          runId,
          vaultAddress: lower(snapshot.vaultAddress),
          leaderAddress: snapshot.leaderAddress ? lower(snapshot.leaderAddress) : null,
          isClosed: snapshot.isClosed ? 1 : 0,
        }).changes;
      }
      return inserted;
    })(snapshots);
  }

  function recordWalletPerformance(
    runId: number,
    cohortVersionId: number,
    rows: WalletPerformanceEvidence[],
    sourceUrl: string,
  ): number {
    const stmt = db.prepare(`
      insert into smart_money_wallet_performance (
        collection_run_id, cohort_version_id, address, observed_at, track_start_at,
        account_value, pnl_7d, pnl_30d, pnl_90d, roi_30d, volume_30d, source_url
      ) values (
        @runId, @cohortVersionId, @address, @observedAt, @trackStartAt,
        @liveAccountValue, @pnl7d, @pnl30d, @pnl90d, @roi30d, @volume30d, @sourceUrl
      ) on conflict(collection_run_id, address) do nothing
    `);
    return db.transaction((evidence: WalletPerformanceEvidence[]) => {
      let inserted = 0;
      for (const row of evidence) inserted += stmt.run({
        ...row,
        runId,
        cohortVersionId,
        address: lower(row.address),
        sourceUrl,
      }).changes;
      return inserted;
    })(rows);
  }

  function collectionRun(id: number): CollectionRunRecord | null {
    const row = db.prepare(`
      select id, run_key, run_kind, scheduled_for, status, cohort_version_id,
        wallet_expected, wallet_succeeded, vault_expected, vault_succeeded
      from smart_money_collection_runs where id = ?
    `).get(id) as {
      id: number; run_key: string; run_kind: CollectionRunRecord["runKind"];
      scheduled_for: number; status: CollectionRunRecord["status"];
      cohort_version_id: number; wallet_expected: number; wallet_succeeded: number;
      vault_expected: number; vault_succeeded: number;
    } | undefined;
    return row ? {
      id: row.id,
      runKey: row.run_key,
      runKind: row.run_kind,
      scheduledFor: row.scheduled_for,
      status: row.status,
      cohortVersionId: row.cohort_version_id,
      walletExpected: row.wallet_expected,
      walletSucceeded: row.wallet_succeeded,
      vaultExpected: row.vault_expected,
      vaultSucceeded: row.vault_succeeded,
    } : null;
  }

  function hasCadenceAlignedEvidence(run: CollectionRunRecord): boolean {
    const windowEnd = run.scheduledFor + 4 * 3_600_000;
    const wallet = db.prepare(`
      select count(*) as total,
        sum(case when status = 'complete' and observed_at >= @start and observed_at < @end then 1 else 0 end) as aligned
      from smart_money_wallet_snapshots where collection_run_id = @runId
    `).get({ runId: run.id, start: run.scheduledFor, end: windowEnd }) as {
      total: number; aligned: number | null;
    };
    const vault = db.prepare(`
      select count(*) as total,
        sum(case when observed_at >= @start and observed_at < @end then 1 else 0 end) as aligned
      from smart_money_vault_snapshots where collection_run_id = @runId
    `).get({ runId: run.id, start: run.scheduledFor, end: windowEnd }) as {
      total: number; aligned: number | null;
    };
    return wallet.total === run.walletExpected
      && (wallet.aligned ?? 0) === run.walletExpected
      && vault.total === run.vaultExpected
      && (vault.aligned ?? 0) === run.vaultExpected;
  }

  function previousCompleteRun(currentRunId: number): CollectionRunRecord | null {
    const current = collectionRun(currentRunId);
    if (!current || !hasCadenceAlignedEvidence(current)) return null;
    const rows = db.prepare(`
      select id from smart_money_collection_runs
      where id != @currentRunId and cohort_version_id = @cohortVersionId
        and run_kind = 'collection'
        and status = 'complete' and scheduled_for < @scheduledFor
        and scheduled_for >= @minimumScheduledFor
        and wallet_succeeded = wallet_expected and vault_succeeded = vault_expected
      order by scheduled_for desc
    `).get({
      currentRunId,
      cohortVersionId: current.cohortVersionId,
      scheduledFor: current.scheduledFor,
      minimumScheduledFor: current.scheduledFor - 6 * 3_600_000,
    }) as { id: number } | undefined;
    const previous = rows ? collectionRun(rows.id) : null;
    return previous && hasCadenceAlignedEvidence(previous) ? previous : null;
  }

  function latestCompleteCollectionRunAtOrBefore(timestamp: number): CollectionRunRecord | null {
    const row = db.prepare(`
      select id from smart_money_collection_runs
      where run_kind = 'collection' and status = 'complete'
        and scheduled_for <= @timestamp
        and wallet_succeeded = wallet_expected and vault_succeeded = vault_expected
      order by scheduled_for desc limit 1
    `).get({ timestamp }) as { id: number } | undefined;
    return row ? collectionRun(row.id) : null;
  }

  function latestSourceRowCount(runKind: "cohort" | "collection", key: string): number | null {
    const row = db.prepare(`
      select source_manifest_json from smart_money_collection_runs
      where run_kind = @runKind and status = 'complete'
        and wallet_succeeded = wallet_expected and vault_succeeded = vault_expected
      order by scheduled_for desc, id desc limit 1
    `).get({ runKind }) as { source_manifest_json: string } | undefined;
    if (!row) return null;
    const manifest = JSON.parse(row.source_manifest_json) as Record<string, unknown>;
    const value = manifest[key];
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  }

  function latestCompleteCollectionSourceRowCount(key: string): number | null {
    return latestSourceRowCount("collection", key);
  }

  function loadWalletSnapshots(runId: number): WalletPositionSnapshot[] {
    const wallets = db.prepare(`
      select address, observed_at, account_value
      from smart_money_wallet_snapshots
      where collection_run_id = ? and status = 'complete'
      order by address
    `).all(runId) as Array<{ address: string; observed_at: number; account_value: number }>;
    const positions = db.prepare(`
      select address, coin, szi, position_value, leverage
      from smart_money_wallet_positions where collection_run_id = ?
      order by address, coin
    `).all(runId) as Array<{
      address: string; coin: string; szi: number; position_value: number; leverage: number | null;
    }>;
    const byAddress = new Map<string, WalletPosition[]>();
    for (const position of positions) {
      const list = byAddress.get(position.address) ?? [];
      list.push({
        coin: position.coin,
        szi: position.szi,
        positionValue: position.position_value,
        leverage: position.leverage,
      });
      byAddress.set(position.address, list);
    }
    return wallets.map((wallet) => ({
      address: wallet.address,
      observedAt: wallet.observed_at,
      accountValue: wallet.account_value,
      positions: byAddress.get(wallet.address) ?? [],
    }));
  }

  function loadVaultSnapshots(runId: number): VaultSnapshot[] {
    return (db.prepare(`
      select vault_address, observed_at, name, tvl, cumulative_pnl,
        follower_count, verification_url
      from smart_money_vault_snapshots where collection_run_id = ?
      order by vault_address
    `).all(runId) as Array<{
      vault_address: string; observed_at: number; name: string; tvl: number;
      cumulative_pnl: number; follower_count: number | null; verification_url: string;
    }>).map((row) => ({
      vaultAddress: row.vault_address,
      observedAt: row.observed_at,
      name: row.name,
      tvl: row.tvl,
      cumulativePnl: row.cumulative_pnl,
      followerCount: row.follower_count,
      verificationUrl: row.verification_url,
    }));
  }

  function insertEventDraft(
    runId: number,
    event: SmartMoneyEventCandidate,
    draftText: string,
  ): { id: number; created: boolean } {
    const insert = db.prepare(`
      insert into smart_money_events (
        fingerprint, collection_run_id, event_type, observed_at, symbol, address,
        vault_address, evidence_json, verification_urls_json, draft_text,
        review_status, delivery_status, created_at, updated_at
      ) values (
        @fingerprint, @runId, @type, @observedAt, @symbol, @address,
        @vaultAddress, @evidenceJson, @verificationUrlsJson, @draftText,
        'draft', 'shadow', @observedAt, @observedAt
      ) on conflict(fingerprint) do nothing
    `).run({
      ...event,
      runId,
      address: event.address ? lower(event.address) : null,
      vaultAddress: event.vaultAddress ? lower(event.vaultAddress) : null,
      evidenceJson: json(event.evidence),
      verificationUrlsJson: json(event.verificationUrls),
      draftText,
    });
    const row = db.prepare("select id from smart_money_events where fingerprint = ?")
      .get(event.fingerprint) as { id: number };
    return { id: row.id, created: insert.changes === 1 };
  }

  function listEvents(startAt: number, endAt: number): StoredSmartMoneyEvent[] {
    const rows = db.prepare(`
      select id, fingerprint, event_type, observed_at, symbol, address, vault_address,
        evidence_json, verification_urls_json
      from smart_money_events
      where observed_at >= ? and observed_at < ?
      order by observed_at, id
    `).all(startAt, endAt) as Array<{
      id: number; fingerprint: string; event_type: SmartMoneyEventCandidate["type"];
      observed_at: number; symbol: string | null; address: string | null;
      vault_address: string | null; evidence_json: string; verification_urls_json: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      fingerprint: row.fingerprint,
      type: row.event_type,
      observedAt: row.observed_at,
      symbol: row.symbol,
      address: row.address,
      vaultAddress: row.vault_address,
      evidence: JSON.parse(row.evidence_json),
      verificationUrls: JSON.parse(row.verification_urls_json),
    }));
  }

  function pendingOutcomeEvents(settledThrough: number, limit = 500): StoredSmartMoneyEvent[] {
    const boundedLimit = Math.max(1, Math.min(500, limit));
    const rows = db.prepare(`
      select id, fingerprint, event_type, observed_at, symbol, address, vault_address,
        evidence_json, verification_urls_json
      from smart_money_events e
      where e.observed_at + 86400000 <= @settledThrough
        and not exists (
          select 1 from smart_money_event_outcomes o
          where o.event_id = e.id and o.horizon_hours = 24
        )
      order by e.observed_at, e.id
      limit @limit
    `).all({ settledThrough, limit: boundedLimit }) as Array<{
      id: number; fingerprint: string; event_type: SmartMoneyEventCandidate["type"];
      observed_at: number; symbol: string | null; address: string | null;
      vault_address: string | null; evidence_json: string; verification_urls_json: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      fingerprint: row.fingerprint,
      type: row.event_type,
      observedAt: row.observed_at,
      symbol: row.symbol,
      address: row.address,
      vaultAddress: row.vault_address,
      evidence: JSON.parse(row.evidence_json),
      verificationUrls: JSON.parse(row.verification_urls_json),
    }));
  }

  function latestPerformance(address: string): WalletPerformanceEvidence | null {
    const row = db.prepare(`
      select address, observed_at, track_start_at, account_value, pnl_7d, pnl_30d,
        pnl_90d, roi_30d, volume_30d
      from smart_money_wallet_performance where address = ?
      order by observed_at desc limit 1
    `).get(lower(address)) as {
      address: string; observed_at: number; track_start_at: number; account_value: number;
      pnl_7d: number; pnl_30d: number; pnl_90d: number; roi_30d: number; volume_30d: number;
    } | undefined;
    return row ? {
      address: row.address,
      observedAt: row.observed_at,
      trackStartAt: row.track_start_at,
      liveAccountValue: row.account_value,
      pnl7d: row.pnl_7d,
      pnl30d: row.pnl_30d,
      pnl90d: row.pnl_90d,
      roi30d: row.roi_30d,
      volume30d: row.volume_30d,
    } : null;
  }

  function insertOutcome(eventId: number, input: SmartMoneyEventOutcome & {
    targetAt: number;
    entryMark: number | null;
    outcomeMark: number | null;
    observedAt: number;
    note: string | null;
  }): boolean {
    return db.prepare(`
      insert into smart_money_event_outcomes (
        event_id, horizon_hours, target_at, status, entry_mark, outcome_mark,
        return_pct, observed_at, note
      ) values (
        @eventId, @horizonHours, @targetAt, @status, @entryMark, @outcomeMark,
        @priceReturnPct, @observedAt, @note
      ) on conflict(event_id, horizon_hours) do nothing
    `).run({ eventId, ...input }).changes === 1;
  }

  function listOutcomes(eventIds: number[]): SmartMoneyEventOutcome[] {
    if (eventIds.length === 0) return [];
    if (eventIds.length > 500) throw new Error("Too many smart-money event ids");
    const placeholders = eventIds.map(() => "?").join(",");
    return (db.prepare(`
      select e.fingerprint, o.horizon_hours, o.status, o.return_pct
      from smart_money_event_outcomes o
      join smart_money_events e on e.id = o.event_id
      where o.event_id in (${placeholders})
    `).all(...eventIds) as Array<{
      fingerprint: string; horizon_hours: number;
      status: SmartMoneyEventOutcome["status"]; return_pct: number | null;
    }>).map((row) => ({
      eventFingerprint: row.fingerprint,
      horizonHours: row.horizon_hours,
      status: row.status,
      priceReturnPct: row.return_pct,
    }));
  }

  function saveDailyDigest(input: {
    digestKey: string;
    periodDate: string;
    generatedAt: number;
    cohortVersionId: number;
    markdownBody: string;
    chartPath: string;
    evidence: unknown;
  }): boolean {
    return db.prepare(`
      insert into smart_money_daily_digests (
        digest_key, period_date, generated_at, cohort_version_id,
        markdown_body, chart_path, evidence_json, review_status
      ) values (
        @digestKey, @periodDate, @generatedAt, @cohortVersionId,
        @markdownBody, @chartPath, @evidenceJson, 'draft'
      ) on conflict(digest_key) do nothing
    `).run({ ...input, evidenceJson: json(input.evidence) }).changes === 1;
  }

  function dailyDigestRecord(digestKey: string): {
    markdownBody: string;
    chartPath: string;
    evidence: unknown;
  } | null {
    const row = db.prepare(`
      select markdown_body, chart_path, evidence_json
      from smart_money_daily_digests where digest_key = ?
    `).get(digestKey) as {
      markdown_body: string;
      chart_path: string;
      evidence_json: string;
    } | undefined;
    return row ? {
      markdownBody: row.markdown_body,
      chartPath: row.chart_path,
      evidence: JSON.parse(row.evidence_json),
    } : null;
  }

  function saveWeeklyReport(input: {
    reportKey: string;
    weekStart: string;
    weekEnd: string;
    generatedAt: number;
    markdownBody: string;
    evidence: unknown;
  }): boolean {
    return db.prepare(`
      insert into smart_money_weekly_reports (
        report_key, week_start, week_end, generated_at,
        markdown_body, evidence_json, review_status
      ) values (
        @reportKey, @weekStart, @weekEnd, @generatedAt,
        @markdownBody, @evidenceJson, 'draft'
      ) on conflict(report_key) do nothing
    `).run({ ...input, evidenceJson: json(input.evidence) }).changes === 1;
  }

  function weeklyReportRecord(reportKey: string): { markdownBody: string; evidence: unknown } | null {
    const row = db.prepare(`
      select markdown_body, evidence_json
      from smart_money_weekly_reports where report_key = ?
    `).get(reportKey) as { markdown_body: string; evidence_json: string } | undefined;
    return row ? { markdownBody: row.markdown_body, evidence: JSON.parse(row.evidence_json) } : null;
  }

  return {
    saveCohortVersion,
    latestCohortVersion,
    activeAddressesForCohort,
    previousActiveAddresses,
    cohortTransitionContext,
    reserveCollectionRun,
    markStaleRunsFailed,
    finishCollectionRun,
    reserveFundingRun,
    fundingRun,
    latestFundingRunForCollection,
    fundingRunWindows,
    fundingRunPaymentAssociationCount,
    invalidateFundingRun,
    markStaleFundingRunsFailed,
    recordFundingWalletResult,
    finishFundingRun,
    latestCompleteFundingRunAtOrBefore,
    completeFundingPayments,
    recordWalletSnapshot,
    recordVaultSnapshots,
    recordWalletPerformance,
    collectionRun,
    previousCompleteRun,
    latestCompleteCollectionRunAtOrBefore,
    latestSourceRowCount,
    latestCompleteCollectionSourceRowCount,
    loadWalletSnapshots,
    loadVaultSnapshots,
    insertEventDraft,
    listEvents,
    pendingOutcomeEvents,
    latestPerformance,
    insertOutcome,
    listOutcomes,
    saveDailyDigest,
    dailyDigestRecord,
    saveWeeklyReport,
    weeklyReportRecord,
  };
}

export type SmartMoneyPilotStore = ReturnType<typeof createSmartMoneyPilotStore>;
