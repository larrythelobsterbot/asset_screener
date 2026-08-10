import type Database from "better-sqlite3";
import { getDb } from "./db";
import type {
  SmartMoneyEventCandidate,
  SmartMoneyEventOutcome,
  VaultSnapshot,
  WalletPerformanceEvidence,
  WalletPosition,
  WalletPositionSnapshot,
} from "./smartMoneyPilot";

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
    const addresses = db.prepare(`
      select address from smart_money_cohort_members
      where cohort_version_id = ? and is_member = 1
      order by score desc, address asc
    `).all(version.id) as Array<{ address: string }>;
    return {
      id: version.id,
      versionKey: version.version_key,
      policyVersion: version.policy_version,
      computedAt: version.computed_at,
      activeAddresses: addresses.map(({ address }) => address),
    };
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
    previousActiveAddresses,
    reserveCollectionRun,
    markStaleRunsFailed,
    finishCollectionRun,
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
