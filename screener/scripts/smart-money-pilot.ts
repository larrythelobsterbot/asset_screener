#!/usr/bin/env node

import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PILOT_COHORT_POLICY_V1,
  PILOT_EVENT_POLICY_V3,
  deriveWalletPerformanceEvidence,
  detectSmartMoneyEvents,
  evaluateWalletForSmartCohort,
  formatDailySmartMoneyDigest,
  formatSmartMoneyAlertDraft,
  formatWeeklySmartMoneyHonestyReport,
  type FundingContext,
  type WalletPerformanceEvidence,
} from "../src/lib/smartMoneyPilot";
import {
  HYPERLIQUID_INFO_URL,
  HYPERLIQUID_LEADERBOARD_URL,
  HYPERLIQUID_VAULTS_URL,
  fetchFundingContext,
  fetchLeaderboardSource,
  fetchVaultFollowerCount,
  fetchVaultSource,
  fetchWalletPortfolio,
  fetchWalletSnapshot,
  validateSourceRowCount,
  type LeaderboardCandidate,
} from "../src/lib/hyperliquidSmartMoneySource";
import { getDb, snapshotAtBounded } from "../src/lib/db";
import {
  createSmartMoneyPilotStore,
  type CohortMemberInput,
  type VaultSnapshotInput,
} from "../src/lib/smartMoneyPilotStore";
import {
  acquirePidLock,
  cohortEvidenceRunKey,
  collectionRunKey,
  contentSha256,
  digestArtifactIdentity,
  ensureBeforeDeadline,
  ensureNoCohortRetrievalFailures,
  verifyContentAddressedSourceArchive,
  verifyImmutableArtifact,
  verifyImmutableArtifactHash,
  writeContentAddressedSourceArchive,
  writeImmutableArtifact,
} from "../src/lib/smartMoneyPilotRuntime";
import {
  FUNDING_POLICY_V1,
  fetchUserFundingSource,
} from "../src/lib/smartMoneyFunding";
import {
  collectCohortFundingEvidence,
  runFundingStageIsolated,
} from "../src/lib/smartMoneyFundingRuntime";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(SCRIPT_DIR, "..");
const DRAFT_ROOT = process.env.SMART_MONEY_DRAFT_ROOT
  ?? join(ROOT_DIR, "data", "smart-money-drafts");
const LOCK_PATH = process.env.SMART_MONEY_LOCK_PATH
  ?? join(ROOT_DIR, "data", ".smart-money-pilot.lock");
const SOURCE_ARCHIVE_ROOT = process.env.SMART_MONEY_SOURCE_ARCHIVE_ROOT
  ?? join(ROOT_DIR, "data", "smart-money-source-archive");
const DAY_MS = 86_400_000;
const FOUR_HOURS_MS = 4 * 3_600_000;
const COHORT_CANDIDATE_LIMIT = 250;
const COHORT_MEMBER_LIMIT = 32;
const COHORT_RETRIEVAL_ATTEMPTS = 5;
const VAULT_LIMIT = 50;
const REQUEST_SPACING_MS = 350;
const COHORT_MAX_RUNTIME_MS = 90 * 60_000;
const MAJOR_ASSETS = [...PILOT_EVENT_POLICY_V3.majorAssets];
const store = createSmartMoneyPilotStore(getDb());

function log(message: string): void {
  console.info(`[smart-money-pilot] ${message}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function evidenceRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has invalid artifact evidence`);
  }
  return value as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function utcWeekStart(timestamp: number): number {
  const dayStart = utcDayStart(timestamp);
  const weekday = new Date(dayStart).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return dayStart - daysSinceMonday * DAY_MS;
}

function collectionBucket(timestamp: number): number {
  return Math.floor(timestamp / FOUR_HOURS_MS) * FOUR_HOURS_MS;
}

function acquireLock(): () => void {
  return acquirePidLock(LOCK_PATH);
}

function writeArtifactExclusive(path: string, content: string): boolean {
  return writeImmutableArtifact(path, content);
}

interface CandidateEvaluation {
  candidate: LeaderboardCandidate;
  performance: WalletPerformanceEvidence | null;
  decision: ReturnType<typeof evaluateWalletForSmartCohort> | null;
  sourceError: string | null;
}

async function recomputeCohort(now = Date.now()): Promise<void> {
  const deadlineAt = Date.now() + COHORT_MAX_RUNTIME_MS;
  const weekStart = utcWeekStart(now);
  const versionKey = `smart-money-cohort:${dateKey(weekStart)}:${PILOT_COHORT_POLICY_V1.version}`;
  const existing = store.latestCohortVersion();
  if (existing?.versionKey === versionKey) {
    log(`cohort ${versionKey} already exists (${existing.activeAddresses.length} members)`);
    return;
  }

  log(`fetching leaderboard for ${versionKey}`);
  const leaderboard = await fetchLeaderboardSource(COHORT_CANDIDATE_LIMIT, (source) => {
    const archivePath = writeContentAddressedSourceArchive(
      SOURCE_ARCHIVE_ROOT,
      "leaderboard",
      source.sha256,
      source.rawText,
    );
    log(`archived leaderboard source ${archivePath}`);
    return archivePath;
  });
  validateSourceRowCount(
    "leaderboard",
    leaderboard.sourceRowCount,
    store.latestSourceRowCount("cohort", "leaderboardSourceRows"),
  );
  const leaderboardArchivePath = leaderboard.sourceArchivePath;
  ensureBeforeDeadline(deadlineAt, Date.now(), "cohort recomputation");
  const evaluations: CandidateEvaluation[] = [];
  for (const [index, candidate] of leaderboard.candidates.entries()) {
    ensureBeforeDeadline(deadlineAt, Date.now(), "cohort recomputation");
    try {
      const [snapshot, portfolio] = await Promise.all([
        retry(() => fetchWalletSnapshot(candidate.address, now), COHORT_RETRIEVAL_ATTEMPTS),
        retry(() => fetchWalletPortfolio(candidate.address), COHORT_RETRIEVAL_ATTEMPTS),
      ]);
      const performance = deriveWalletPerformanceEvidence({
        address: candidate.address,
        observedAt: now,
        liveAccountValue: snapshot.accountValue,
        portfolio,
      });
      const decision = performance
        ? evaluateWalletForSmartCohort(performance, PILOT_COHORT_POLICY_V1)
        : null;
      evaluations.push({
        candidate,
        performance,
        decision,
        sourceError: performance ? null : "portfolio_history_insufficient_for_90d_evidence",
      });
    } catch (error) {
      evaluations.push({ candidate, performance: null, decision: null, sourceError: errorText(error) });
    }
    if ((index + 1) % 25 === 0) log(`cohort evidence ${index + 1}/${leaderboard.candidates.length}`);
    await sleep(REQUEST_SPACING_MS);
  }
  ensureBeforeDeadline(deadlineAt, Date.now(), "cohort recomputation");
  ensureNoCohortRetrievalFailures(evaluations.map(({ sourceError }) => sourceError));

  const eligible = evaluations
    .filter((evaluation) => evaluation.performance && evaluation.decision?.eligible)
    .sort((a, b) => b.decision!.score - a.decision!.score || a.candidate.address.localeCompare(b.candidate.address));
  const selected = new Set(eligible.slice(0, COHORT_MEMBER_LIMIT).map(({ candidate }) => candidate.address));
  const previousActive = new Set(existing?.activeAddresses ?? []);
  const members: CohortMemberInput[] = [];
  const evaluatedAddresses = new Set<string>();

  for (const evaluation of evaluations) {
    const { candidate, performance, decision, sourceError } = evaluation;
    evaluatedAddresses.add(candidate.address);
    const isMember = selected.has(candidate.address);
    const wasMember = previousActive.has(candidate.address);
    const exclusionReasons = [
      ...(decision?.reasons ?? []),
      ...(sourceError ? ["source_evidence_unavailable"] : []),
      ...(decision?.eligible && !isMember ? ["cohort_member_cap"] : []),
    ];
    members.push({
      address: candidate.address,
      isMember,
      membershipChange: isMember ? (wasMember ? "stay" : "entry") : (wasMember ? "exit" : "ineligible"),
      score: decision?.score ?? null,
      suspectedGaming: decision?.suspectedGaming ?? false,
      exclusionReasons,
      evidence: { candidate, performance, decision, sourceError },
    });
  }

  for (const exclusion of leaderboard.exclusions) {
    if (evaluatedAddresses.has(exclusion.address)) continue;
    evaluatedAddresses.add(exclusion.address);
    const wasMember = previousActive.has(exclusion.address);
    members.push({
      address: exclusion.address,
      isMember: false,
      membershipChange: wasMember ? "exit" : "ineligible",
      score: null,
      suspectedGaming: true,
      exclusionReasons: exclusion.reasons,
      evidence: exclusion.evidence,
    });
  }

  for (const address of previousActive) {
    if (evaluatedAddresses.has(address)) continue;
    members.push({
      address,
      isMember: false,
      membershipChange: "exit",
      score: null,
      suspectedGaming: false,
      exclusionReasons: ["not_in_current_candidate_pool"],
      evidence: {},
    });
  }

  const cohort = store.saveCohortVersion({
    versionKey,
    policyVersion: PILOT_COHORT_POLICY_V1.version,
    computedAt: now,
    candidateCount: leaderboard.candidates.length,
    eligibleCount: eligible.length,
    memberCount: selected.size,
    sourceUrl: HYPERLIQUID_LEADERBOARD_URL,
    sourceSha256: leaderboard.sha256,
    evidence: {
      sourceBytes: leaderboard.byteLength,
      sourceRowCount: leaderboard.sourceRowCount,
      sourceArchivePath: leaderboardArchivePath,
      malformedSourceRows: leaderboard.malformedRows,
      candidateLimit: COHORT_CANDIDATE_LIMIT,
      memberLimit: COHORT_MEMBER_LIMIT,
      suspectedLeaderboardExclusions: leaderboard.exclusions.length,
      apiSource: HYPERLIQUID_INFO_URL,
    },
    members,
  });
  if (!cohort.created) {
    log(`cohort ${versionKey} won a concurrent insert; keeping immutable first result`);
    return;
  }

  const performance = evaluations
    .map((evaluation) => evaluation.performance)
    .filter((row): row is WalletPerformanceEvidence => row !== null);
  const run = store.reserveCollectionRun({
    runKey: cohortEvidenceRunKey(weekStart, cohort.id),
    runKind: "cohort",
    scheduledFor: weekStart,
    startedAt: now,
    cohortVersionId: cohort.id,
    walletExpected: performance.length,
    vaultExpected: 0,
    sourceManifest: {
      leaderboardUrl: HYPERLIQUID_LEADERBOARD_URL,
      leaderboardSha256: leaderboard.sha256,
      leaderboardSourceRows: leaderboard.sourceRowCount,
      leaderboardMalformedRows: leaderboard.malformedRowCount,
      leaderboardArchivePath,
      hyperliquidInfoUrl: HYPERLIQUID_INFO_URL,
    },
  });
  if (run.created) {
    const inserted = store.recordWalletPerformance(
      run.id,
      cohort.id,
      performance,
      HYPERLIQUID_INFO_URL,
    );
    store.finishCollectionRun(run.id, {
      status: inserted === performance.length ? "complete" : "partial",
      completedAt: Date.now(),
      walletSucceeded: inserted,
      vaultSucceeded: 0,
      error: inserted === performance.length ? null : "performance insert count mismatch",
    });
  }
  log(`cohort ${versionKey}: ${selected.size} members, ${eligible.length} eligible, ${leaderboard.exclusions.length} suspected vanity/wash rows flagged`);
}

async function fetchVaultDetailsBestEffort(vaults: VaultSnapshotInput[]): Promise<number> {
  let succeeded = 0;
  for (const vault of vaults) {
    try {
      vault.followerCount = await retry(() => fetchVaultFollowerCount(vault.vaultAddress), 2);
      succeeded += 1;
    } catch (error) {
      log(`vault follower count unavailable for ${vault.vaultAddress.slice(0, 8)}…: ${errorText(error)}`);
    }
    await sleep(REQUEST_SPACING_MS);
  }
  return succeeded;
}

async function collect(now = Date.now()): Promise<number | null> {
  const cohort = store.latestCohortVersion();
  if (!cohort || cohort.activeAddresses.length === 0) throw new Error("no active smart-money cohort");
  const scheduledFor = collectionBucket(now);
  const runKey = collectionRunKey(scheduledFor, cohort.id, PILOT_EVENT_POLICY_V3.version);

  let vaultSource: Awaited<ReturnType<typeof fetchVaultSource>>;
  let vaultArchivePath: string | null = null;
  try {
    const validatedVaultSource = await fetchVaultSource(now, VAULT_LIMIT, (source) => {
      const archivePath = writeContentAddressedSourceArchive(
        SOURCE_ARCHIVE_ROOT,
        "vaults",
        source.sha256,
        source.rawText,
      );
      vaultArchivePath = archivePath;
      log(`archived vault source ${archivePath}`);
      return archivePath;
    });
    validateSourceRowCount(
      "vaults",
      validatedVaultSource.sourceRowCount,
      store.latestSourceRowCount("collection", "vaultSourceRows"),
    );
    vaultArchivePath = validatedVaultSource.sourceArchivePath;
    vaultSource = validatedVaultSource;
  } catch (error) {
    const failed = store.reserveCollectionRun({
      runKey,
      runKind: "collection",
      scheduledFor,
      startedAt: now,
      cohortVersionId: cohort.id,
      walletExpected: cohort.activeAddresses.length,
      vaultExpected: VAULT_LIMIT,
      sourceManifest: {
        vaultsUrl: HYPERLIQUID_VAULTS_URL,
        vaultArchivePath,
        eventPolicy: PILOT_EVENT_POLICY_V3.version,
        error: errorText(error),
      },
    });
    if (failed.created) store.finishCollectionRun(failed.id, {
      status: "failed",
      completedAt: Date.now(),
      walletSucceeded: 0,
      vaultSucceeded: 0,
      error: `vault source unavailable: ${errorText(error)}`,
    });
    throw error;
  }
  const followerDetailsSucceeded = await fetchVaultDetailsBestEffort(vaultSource.vaults);

  const run = store.reserveCollectionRun({
    runKey,
    runKind: "collection",
    scheduledFor,
    startedAt: now,
    cohortVersionId: cohort.id,
    walletExpected: cohort.activeAddresses.length,
    vaultExpected: vaultSource.vaults.length,
    sourceManifest: {
      hyperliquidInfoUrl: HYPERLIQUID_INFO_URL,
      vaultsUrl: HYPERLIQUID_VAULTS_URL,
      vaultsSha256: vaultSource.sha256,
      vaultsBytes: vaultSource.byteLength,
      vaultSourceRows: vaultSource.sourceRowCount,
      vaultEligibleRows: vaultSource.eligibleRowCount,
      vaultArchivePath: vaultSource.sourceArchivePath,
      followerDetailsSucceeded,
      eventPolicy: PILOT_EVENT_POLICY_V3.version,
    },
  });
  if (!run.created) {
    log(`${runKey} already reserved; idempotent no-op`);
    return run.id;
  }

  let walletSucceeded = 0;
  for (const [index, address] of cohort.activeAddresses.entries()) {
    try {
      const snapshot = await retry(() => fetchWalletSnapshot(address, now));
      store.recordWalletSnapshot(run.id, {
        ...snapshot,
        status: "complete",
        sourceUrl: HYPERLIQUID_INFO_URL,
        error: null,
      });
      walletSucceeded += 1;
    } catch (error) {
      store.recordWalletSnapshot(run.id, {
        address,
        observedAt: now,
        accountValue: null,
        status: "failed",
        sourceUrl: HYPERLIQUID_INFO_URL,
        error: errorText(error),
        positions: [],
      });
    }
    if ((index + 1) % 25 === 0) log(`wallet snapshots ${index + 1}/${cohort.activeAddresses.length}`);
    await sleep(REQUEST_SPACING_MS);
  }
  const vaultSucceeded = store.recordVaultSnapshots(run.id, vaultSource.vaults);
  const complete = walletSucceeded === cohort.activeAddresses.length
    && vaultSucceeded === vaultSource.vaults.length;
  store.finishCollectionRun(run.id, {
    status: complete ? "complete" : "partial",
    completedAt: Date.now(),
    walletSucceeded,
    vaultSucceeded,
    error: complete
      ? null
      : `incomplete evidence: wallets ${walletSucceeded}/${cohort.activeAddresses.length}; vaults ${vaultSucceeded}/${vaultSource.vaults.length}`,
  });
  if (!complete) {
    log(`run ${run.id} partial; event detection suppressed`);
    return run.id;
  }

  const previous = store.previousCompleteRun(run.id);
  if (!previous) {
    log(`run ${run.id} established baseline; no paired predecessor`);
    return run.id;
  }
  const currentWallets = store.loadWalletSnapshots(run.id);
  const previousWallets = store.loadWalletSnapshots(previous.id);
  const currentVaults = store.loadVaultSnapshots(run.id);
  const previousVaults = store.loadVaultSnapshots(previous.id);
  const candidates = detectSmartMoneyEvents({
    observedAt: now,
    cohortVersionKey: cohort.versionKey,
    previousWallets,
    currentWallets,
    previousVaults,
    currentVaults,
    policy: PILOT_EVENT_POLICY_V3,
  });
  let inserted = 0;
  for (const candidate of candidates) {
    const performance = candidate.address ? store.latestPerformance(candidate.address) ?? undefined : undefined;
    const result = store.insertEventDraft(
      run.id,
      candidate,
      formatSmartMoneyAlertDraft(candidate, performance),
    );
    if (result.created) inserted += 1;
  }
  log(`run ${run.id} complete: ${currentWallets.length} wallets, ${currentVaults.length} vaults, ${inserted} new review drafts`);
  return run.id;
}

async function collectFundingForRun(collectionRunId: number): Promise<void> {
  const run = store.collectionRun(collectionRunId);
  if (!run || run.status !== "complete") {
    log(`funding skipped for collection ${collectionRunId}: core evidence is not complete`);
    return;
  }
  const addresses = store.activeAddressesForCohort(run.cohortVersionId);
  if (addresses.length !== run.walletExpected) {
    throw new Error(`funding cohort membership is incomplete for collection ${collectionRunId}`);
  }
  const result = await collectCohortFundingEvidence({
    collectionRunId,
    scheduledFor: run.scheduledFor,
    addresses,
    parentCollection: run,
    store,
    fetchWindow: fetchUserFundingSource,
    archiveSource: (source) => writeContentAddressedSourceArchive(
      SOURCE_ARCHIVE_ROOT,
      "funding",
      source.sha256,
      source.rawText,
    ),
    verifyArchive: verifyContentAddressedSourceArchive,
  });
  log(`funding run ${result.id} ${result.status}: ${result.walletSucceeded}/${result.walletExpected} wallets, ${result.requestCount} requests, ${result.windowCount} windows, ${result.paymentCount} normalized payments (${FUNDING_POLICY_V1.version})`);
}

function dailyFundingContext(startAt: number, endAt: number): FundingContext[] {
  const db = getDb();
  const statement = db.prepare(`
    select avg(funding) as rate from price_snapshots
    where symbol = ? and ts >= ? and ts < ? and funding is not null
  `);
  const rows: FundingContext[] = [];
  for (const symbol of MAJOR_ASSETS) {
    const row = statement.get(symbol, startAt, endAt) as { rate: number | null };
    if (row.rate !== null && Number.isFinite(row.rate)) {
      rows.push({ symbol, rateHourly: row.rate, sourceUrl: HYPERLIQUID_INFO_URL });
    }
  }
  return rows;
}

function generateDailyDigest(
  periodDate: string,
  now = Date.now(),
  kind: "daily" | "baseline" = "daily",
): boolean {
  const startAt = Date.parse(`${periodDate}T00:00:00.000Z`);
  if (!Number.isFinite(startAt)) throw new Error(`invalid UTC date ${periodDate}`);
  const endAt = startAt + DAY_MS;
  const run = store.latestCompleteCollectionRunAtOrBefore(Math.min(endAt - 1, now));
  if (!run || run.scheduledFor < startAt) {
    log(`${kind} digest for ${periodDate} skipped: no complete collection within period`);
    return false;
  }
  const artifact = digestArtifactIdentity(DRAFT_ROOT, periodDate, run.id, kind);
  const existing = store.dailyDigestRecord(artifact.key);
  if (existing) {
    const evidence = evidenceRecord(existing.evidence, artifact.key);
    if (evidence.markdownPath !== artifact.markdownPath || existing.chartPath !== artifact.chartPath) {
      throw new Error(`${artifact.key} artifact path mismatch`);
    }
    if (typeof evidence.markdownSha256 !== "string" || typeof evidence.chartSha256 !== "string") {
      throw new Error(`${artifact.key} is missing artifact hash evidence`);
    }
    verifyImmutableArtifact(artifact.markdownPath, existing.markdownBody);
    verifyImmutableArtifactHash(artifact.markdownPath, evidence.markdownSha256);
    verifyImmutableArtifactHash(artifact.chartPath, evidence.chartSha256);
    log(`${artifact.key} already exists and its artifacts verify`);
    return false;
  }
  const wallets = store.loadWalletSnapshots(run.id);
  const events = store.listEvents(startAt, endAt);
  const funding = dailyFundingContext(startAt, Math.min(endAt, now));
  const cohortContext = store.cohortTransitionContext(run.cohortVersionId);
  const digest = formatDailySmartMoneyDigest({
    dateUtc: periodDate,
    generatedAt: now,
    currentWallets: wallets,
    events,
    funding,
    cohortContext,
    policy: PILOT_EVENT_POLICY_V3,
  });
  const markdown = kind === "baseline"
    ? digest.markdown
      .replace(`# Smart Money Daily — ${periodDate}`, `# Smart Money Baseline — ${periodDate}`)
      .replace("DRAFT — HUMAN REVIEW REQUIRED", "DRAFT BASELINE — HUMAN REVIEW REQUIRED")
    : digest.markdown;
  const markdownCreated = writeArtifactExclusive(artifact.markdownPath, markdown);
  const chartCreated = writeArtifactExclusive(artifact.chartPath, digest.chartSvg);
  try {
    const inserted = store.saveDailyDigest({
      digestKey: artifact.key,
      periodDate,
      generatedAt: now,
      cohortVersionId: run.cohortVersionId,
      markdownBody: markdown,
      chartPath: artifact.chartPath,
      evidence: {
        kind,
        collectionRunId: run.id,
        markdownPath: artifact.markdownPath,
        markdownSha256: contentSha256(markdown),
        chartSha256: contentSha256(digest.chartSvg),
        eventFingerprints: events.map(({ fingerprint }) => fingerprint),
        cohortContext,
        fundingWindow: { startAt, endAt: Math.min(endAt, now) },
      },
    });
    if (!inserted) throw new Error(`${artifact.key} won a concurrent insert`);
  } catch (error) {
    if (markdownCreated) rmSync(artifact.markdownPath, { force: true });
    if (chartCreated) rmSync(artifact.chartPath, { force: true });
    throw error;
  }
  log(`drafted ${kind} artifact ${artifact.markdownPath} with ${events.length} evidence events`);
  return true;
}

function processOutcomes(now = Date.now()): number {
  const pending = store.pendingOutcomeEvents(now - 10 * 60_000);
  let inserted = 0;
  for (const event of pending) {
    const targetAt = event.observedAt + DAY_MS;
    if (!event.symbol) {
      inserted += Number(store.insertOutcome(event.id, {
        eventFingerprint: event.fingerprint,
        horizonHours: 24,
        targetAt,
        status: "untrackable",
        entryMark: null,
        outcomeMark: null,
        priceReturnPct: null,
        observedAt: now,
        note: "vault-flow event has no single-asset price outcome",
      }));
      continue;
    }
    const entryMark = snapshotAtBounded(event.observedAt, 20 * 60_000, [event.symbol]).get(event.symbol);
    const outcomeMark = snapshotAtBounded(targetAt, 20 * 60_000, [event.symbol]).get(event.symbol);
    if (!entryMark || !outcomeMark) {
      inserted += Number(store.insertOutcome(event.id, {
        eventFingerprint: event.fingerprint,
        horizonHours: 24,
        targetAt,
        status: "missing",
        entryMark: null,
        outcomeMark: null,
        priceReturnPct: null,
        observedAt: now,
        note: "no bounded price snapshot at event or 24h horizon",
      }));
      continue;
    }
    inserted += Number(store.insertOutcome(event.id, {
      eventFingerprint: event.fingerprint,
      horizonHours: 24,
      targetAt,
      status: "observed",
      entryMark,
      outcomeMark,
      priceReturnPct: ((outcomeMark - entryMark) / entryMark) * 100,
      observedAt: now,
      note: null,
    }));
  }
  if (inserted > 0) log(`recorded ${inserted} immutable 24h event outcomes`);
  return inserted;
}

function generateWeeklyReport(weekStartDate: string, now = Date.now()): boolean {
  const startAt = Date.parse(`${weekStartDate}T00:00:00.000Z`);
  if (!Number.isFinite(startAt)) throw new Error(`invalid UTC date ${weekStartDate}`);
  const endAt = startAt + 7 * DAY_MS;
  const weekEndDate = dateKey(endAt - DAY_MS);
  const reportKey = `smart-money-weekly:${weekStartDate}`;
  const path = join(DRAFT_ROOT, `week-${weekStartDate}`, "honesty-report.md");
  const existing = store.weeklyReportRecord(reportKey);
  if (existing) {
    const evidence = evidenceRecord(existing.evidence, reportKey);
    if (evidence.markdownPath !== path || typeof evidence.markdownSha256 !== "string") {
      throw new Error(`${reportKey} artifact evidence mismatch`);
    }
    verifyImmutableArtifact(path, existing.markdownBody);
    verifyImmutableArtifactHash(path, evidence.markdownSha256);
    log(`${reportKey} already exists and its artifact verifies`);
    return false;
  }
  const events = store.listEvents(startAt, endAt);
  const outcomes = store.listOutcomes(events.map(({ id }) => id));
  const markdown = formatWeeklySmartMoneyHonestyReport({
    weekStartUtc: weekStartDate,
    weekEndUtc: weekEndDate,
    events,
    outcomes,
  });
  const artifactCreated = writeArtifactExclusive(path, markdown);
  try {
    const inserted = store.saveWeeklyReport({
      reportKey,
      weekStart: weekStartDate,
      weekEnd: weekEndDate,
      generatedAt: now,
      markdownBody: markdown,
      evidence: {
        markdownPath: path,
        markdownSha256: contentSha256(markdown),
        eventIds: events.map(({ id }) => id),
        outcomeCount: outcomes.length,
      },
    });
    if (!inserted) throw new Error(`${reportKey} won a concurrent insert`);
  } catch (error) {
    if (artifactCreated) rmSync(path, { force: true });
    throw error;
  }
  log(`drafted ${path} for ${events.length} events`);
  return true;
}

async function runScheduled(now = Date.now(), bootstrapDigest = false): Promise<void> {
  store.markStaleRunsFailed(now - 2 * 3_600_000, now);
  const cohort = store.latestCohortVersion();
  if (!cohort
    || cohort.policyVersion !== PILOT_COHORT_POLICY_V1.version
    || now - cohort.computedAt >= 7 * DAY_MS) await recomputeCohort(now);
  const collectionRunId = await collect(now);
  if (collectionRunId !== null) {
    await runFundingStageIsolated(
      () => collectFundingForRun(collectionRunId),
      (message) => log(`funding stage failed after core run ${collectionRunId}; continuing: ${message}`),
    );
  }
  processOutcomes(now);
  const previousDate = dateKey(utcDayStart(now) - DAY_MS);
  generateDailyDigest(previousDate, now);
  if (bootstrapDigest) generateDailyDigest(dateKey(now), now, "baseline");
  if (new Date(now).getUTCDay() === 1) {
    generateWeeklyReport(dateKey(utcWeekStart(now) - 7 * DAY_MS), now);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  const arg = process.argv[3];
  const releaseLock = acquireLock();
  const release = () => {
    releaseLock();
    process.off("exit", release);
  };
  process.on("exit", release);
  try {
    if (command === "run") await runScheduled(Date.now(), process.argv.includes("--bootstrap-digest"));
    else if (command === "cohort") await recomputeCohort();
    else if (command === "collect") await collect();
    else if (command === "digest") generateDailyDigest(arg ?? dateKey(utcDayStart(Date.now()) - DAY_MS));
    else if (command === "outcomes") processOutcomes();
    else if (command === "funding") {
      const latest = store.latestCompleteCollectionRunAtOrBefore(Date.now());
      if (!latest) throw new Error("no complete smart-money collection for funding");
      await collectFundingForRun(latest.id);
    }
    else if (command === "weekly") generateWeeklyReport(arg ?? dateKey(utcWeekStart(Date.now()) - 7 * DAY_MS));
    else if (command === "funding-probe") {
      const funding = await fetchFundingContext(MAJOR_ASSETS);
      log(`funding probe returned ${funding.length}/${MAJOR_ASSETS.length} majors`);
    } else throw new Error(`unknown command ${command}`);
  } finally {
    release();
  }
}

main().catch((error) => {
  console.error(`[smart-money-pilot] failed: ${errorText(error)}`);
  process.exitCode = 1;
});
