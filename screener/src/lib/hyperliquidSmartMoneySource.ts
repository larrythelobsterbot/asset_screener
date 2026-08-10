import { createHash } from "node:crypto";
import type {
  FundingContext,
  HyperliquidPortfolio,
  WalletPosition,
  WalletPositionSnapshot,
} from "./smartMoneyPilot";
import type { VaultSnapshotInput } from "./smartMoneyPilotStore";

export const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HYPERLIQUID_LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
export const HYPERLIQUID_VAULTS_URL = "https://stats-data.hyperliquid.xyz/Mainnet/vaults";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const MIN_ACCOUNT_VALUE_USD = 250_000;
const MAX_TURNOVER_30D = 50;
const MAX_ROI_30D = 2;

function numberValue(value: unknown): number {
  if (value === null || value === undefined) return Number.NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== "string") return Number.NaN;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return Number.NaN;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function canonicalMarketKey(value: string): string {
  return value.includes(":") ? value : value.toUpperCase();
}

function historyWindow(
  value: unknown,
  name: string,
): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const entry = value.find((item) => Array.isArray(item) && item[0] === name);
  return Array.isArray(entry) ? objectValue(entry[1]) : null;
}

export interface LeaderboardCandidate {
  address: string;
  accountValue: number;
  pnl7d: number;
  pnl30d: number;
  pnlAllTime: number;
  roi30d: number;
  volume30d: number;
  turnover30d: number;
}

export interface LeaderboardExclusion {
  address: string;
  accountValue: number;
  suspectedGaming: boolean;
  reasons: string[];
  evidence: Record<string, number>;
}

export interface MalformedSourceRow {
  rowIndex: number;
  address: string | null;
  reason: string;
}

export function classifyLeaderboardRows(
  payload: unknown,
  limit = 250,
): {
  candidates: LeaderboardCandidate[];
  exclusions: LeaderboardExclusion[];
  malformedRows: MalformedSourceRow[];
  malformedRowCount: number;
  duplicateAddressCount: number;
  sourceRowCount: number;
} {
  const envelope = objectValue(payload);
  const rows = Array.isArray(payload)
    ? payload
    : (envelope && Array.isArray(envelope.leaderboardRows)
      ? envelope.leaderboardRows
      : null);
  if (!rows) throw new Error("leaderboard payload has no leaderboardRows array");
  const candidates: LeaderboardCandidate[] = [];
  const exclusions: LeaderboardExclusion[] = [];
  const malformedRows: MalformedSourceRow[] = [];
  const seenAddresses = new Set<string>();
  let duplicateAddressCount = 0;
  for (const [index, raw] of rows.entries()) {
    const row = objectValue(raw);
    const address = typeof row?.ethAddress === "string" ? row.ethAddress.toLowerCase() : "";
    try {
      if (!ADDRESS_RE.test(address)) throw new Error("invalid address");
      if (seenAddresses.has(address)) {
        duplicateAddressCount += 1;
        throw new Error("duplicate address");
      }
      seenAddresses.add(address);
      const accountValue = numberValue(row?.accountValue);
      const week = historyWindow(row?.windowPerformances, "week");
      const month = historyWindow(row?.windowPerformances, "month");
      const allTime = historyWindow(row?.windowPerformances, "allTime");
      if (!week || !month || !allTime) throw new Error("missing performance window");
      const pnl7d = numberValue(week.pnl);
      const pnl30d = numberValue(month.pnl);
      const pnlAllTime = numberValue(allTime.pnl);
      const roi30d = numberValue(month.roi);
      const volume30d = numberValue(month.vlm);
      const turnover30d = accountValue > 0 ? volume30d / accountValue : 0;
      const metrics = [accountValue, pnl7d, pnl30d, pnlAllTime, roi30d, volume30d, turnover30d];
      if (metrics.some((metric) => !Number.isFinite(metric))) throw new Error("invalid financial scalar");

      const reasons: string[] = [];
      if (accountValue < MIN_ACCOUNT_VALUE_USD) reasons.push("account_value_under_floor");
      if (pnl7d <= 0) reasons.push("non_positive_7d_pnl");
      if (pnl30d <= 0) reasons.push("non_positive_30d_pnl");
      if (pnlAllTime <= 0) reasons.push("non_positive_all_time_pnl");
      if (volume30d <= 0 && pnl30d > 0) reasons.push("zero_volume_positive_pnl");
      if (turnover30d >= MAX_TURNOVER_30D) reasons.push("turnover_above_ceiling");
      if (roi30d > MAX_ROI_30D) reasons.push("roi_above_vanity_ceiling");
      const suspectedGaming = reasons.some((reason) => [
        "zero_volume_positive_pnl",
        "turnover_above_ceiling",
        "roi_above_vanity_ceiling",
      ].includes(reason));

      if (reasons.length === 0) {
        candidates.push({
          address,
          accountValue,
          pnl7d,
          pnl30d,
          pnlAllTime,
          roi30d,
          volume30d,
          turnover30d,
        });
      } else if (suspectedGaming) {
        exclusions.push({
          address,
          accountValue,
          suspectedGaming,
          reasons,
          evidence: { accountValue, pnl7d, pnl30d, pnlAllTime, roi30d, volume30d, turnover30d },
        });
      }
    } catch (error) {
      malformedRows.push({
        rowIndex: index,
        address: ADDRESS_RE.test(address) ? address : null,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  candidates.sort((a, b) =>
    b.pnl30d - a.pnl30d || b.accountValue - a.accountValue || a.address.localeCompare(b.address));
  exclusions.sort((a, b) => b.accountValue - a.accountValue || a.address.localeCompare(b.address));
  return {
    candidates: candidates.slice(0, Math.max(1, limit)),
    exclusions: exclusions.slice(0, 100),
    malformedRows,
    malformedRowCount: malformedRows.length,
    duplicateAddressCount,
    sourceRowCount: rows.length,
  };
}

export function parseLeaderboardCandidates(payload: unknown, limit = 250): LeaderboardCandidate[] {
  return classifyLeaderboardRows(payload, limit).candidates;
}

export interface ParsedWalletPosition extends WalletPosition {
  entryPx: number | null;
  unrealizedPnl: number | null;
}

export interface ParsedWalletSnapshot extends Omit<WalletPositionSnapshot, "positions"> {
  positions: ParsedWalletPosition[];
}

export function parseClearinghouseSnapshot(
  payload: unknown,
  address: string,
  observedAt: number,
): ParsedWalletSnapshot {
  const state = objectValue(payload);
  const margin = objectValue(state?.marginSummary);
  const accountValue = numberValue(margin?.accountValue);
  if (!Number.isFinite(accountValue) || accountValue < 0 || !Array.isArray(state?.assetPositions)) {
    throw new Error(`invalid clearinghouseState for ${address}`);
  }
  const positions: ParsedWalletPosition[] = [];
  for (const raw of state.assetPositions) {
    const outer = objectValue(raw);
    const position = objectValue(outer?.position);
    const rawCoin = typeof position?.coin === "string" ? position.coin : "";
    const szi = numberValue(position?.szi);
    const positionValue = numberValue(position?.positionValue);
    const unrealizedPnl = numberValue(position?.unrealizedPnl);
    const entryPx = position?.entryPx === null || position?.entryPx === undefined
      ? null
      : numberValue(position.entryPx);
    const leverageObject = objectValue(position?.leverage);
    const leverage = leverageObject?.value === undefined
      ? null
      : numberValue(leverageObject.value);
    if (
      !rawCoin
      || !Number.isFinite(szi)
      || !Number.isFinite(positionValue)
      || !Number.isFinite(unrealizedPnl)
      || (entryPx !== null && !Number.isFinite(entryPx))
      || (leverage !== null && !Number.isFinite(leverage))
    ) throw new Error(`malformed position row for ${address}`);
    positions.push({
      coin: canonicalMarketKey(rawCoin),
      szi,
      positionValue: Math.abs(positionValue),
      leverage,
      entryPx,
      unrealizedPnl,
    });
  }
  return { address: address.toLowerCase(), observedAt, accountValue, positions };
}

function lastPnlValue(pnls: unknown, windowName: string): number {
  if (!Array.isArray(pnls)) return Number.NaN;
  const entry = pnls.find((item) => Array.isArray(item) && item[0] === windowName);
  if (!Array.isArray(entry) || !Array.isArray(entry[1]) || entry[1].length === 0) return Number.NaN;
  return numberValue(entry[1].at(-1));
}

export function classifyVaultStats(
  payload: unknown,
  observedAt: number,
  limit = 50,
): { vaults: VaultSnapshotInput[]; sourceRowCount: number; eligibleRowCount: number } {
  if (!Array.isArray(payload)) throw new Error("vault stats payload is not an array");
  const rows: VaultSnapshotInput[] = [];
  const seenAddresses = new Set<string>();
  for (const [index, raw] of payload.entries()) {
    const record = objectValue(raw);
    const summary = objectValue(record?.summary);
    const relationship = objectValue(summary?.relationship);
    const relationshipType = relationship?.type;
    const vaultAddress = typeof summary?.vaultAddress === "string"
      ? summary.vaultAddress.toLowerCase()
      : "";
    const leaderAddress = typeof summary?.leader === "string"
      ? summary.leader.toLowerCase()
      : null;
    const tvl = numberValue(summary?.tvl);
    const cumulativePnl = lastPnlValue(record?.pnls, "allTime");
    const apr = numberValue(record?.apr);
    const isClosed = summary?.isClosed === true;
    if (!ADDRESS_RE.test(vaultAddress)
      || !["normal", "parent", "child"].includes(String(relationshipType))
      || !Number.isFinite(tvl)) {
      throw new Error(`malformed vault row ${index}`);
    }
    if (seenAddresses.has(vaultAddress)) throw new Error(`duplicate vault address at row ${index}`);
    seenAddresses.add(vaultAddress);
    if (!Number.isFinite(cumulativePnl)
      || (record?.apr !== null && record?.apr !== undefined && !Number.isFinite(apr))) {
      throw new Error(`malformed vault row ${index}`);
    }
    if (relationshipType === "child" || isClosed || tvl < 1_000_000) continue;
    rows.push({
      vaultAddress,
      observedAt,
      name: typeof summary?.name === "string" ? summary.name : "Unnamed vault",
      leaderAddress: leaderAddress && ADDRESS_RE.test(leaderAddress) ? leaderAddress : null,
      relationshipType: relationshipType as "normal" | "parent",
      tvl,
      apr: Number.isFinite(apr) ? apr : null,
      cumulativePnl,
      followerCount: null,
      isClosed,
      verificationUrl: `https://app.hyperliquid.xyz/vaults/vaultAddress/${vaultAddress}`,
    });
  }
  const sorted = rows.sort((a, b) => b.tvl - a.tvl || a.vaultAddress.localeCompare(b.vaultAddress));
  return {
    vaults: sorted.slice(0, Math.max(1, limit)),
    sourceRowCount: payload.length,
    eligibleRowCount: sorted.length,
  };
}

export function parseVaultStats(
  payload: unknown,
  observedAt: number,
  limit = 50,
): VaultSnapshotInput[] {
  return classifyVaultStats(payload, observedAt, limit).vaults;
}

export function validateSourceRowCount(
  source: "leaderboard" | "vaults",
  current: number,
  previous?: number | null,
): void {
  const absoluteMinimum = source === "leaderboard" ? 10_000 : 1_000;
  if (!Number.isInteger(current) || current < absoluteMinimum) {
    throw new Error(`${source} source unexpectedly sparse: ${current} rows (minimum ${absoluteMinimum})`);
  }
  if (previous !== null && previous !== undefined && current < previous * 0.9) {
    throw new Error(`${source} source row count dropped more than 10%: ${previous} -> ${current}`);
  }
}

export function validateMalformedSourceRows(
  source: "leaderboard" | "vaults",
  sourceRowCount: number,
  malformedRowCount: number,
): void {
  const allowed = Math.max(10, Math.floor(sourceRowCount * 0.001));
  if (!Number.isInteger(malformedRowCount) || malformedRowCount < 0 || malformedRowCount > allowed) {
    throw new Error(
      `${source} source has ${malformedRowCount} malformed rows; maximum allowed is ${allowed} of ${sourceRowCount}`,
    );
  }
}

export function validateDuplicateSourceRows(
  source: "leaderboard" | "vaults",
  duplicateCount: number,
): void {
  if (!Number.isInteger(duplicateCount) || duplicateCount !== 0) {
    throw new Error(`${source} source contains ${duplicateCount} duplicate stable identities`);
  }
}

export function parseFundingContext(payload: unknown, symbols: readonly string[]): FundingContext[] {
  if (!Array.isArray(payload) || payload.length < 2) throw new Error("invalid metaAndAssetCtxs response");
  const meta = objectValue(payload[0]);
  const universe = Array.isArray(meta?.universe) ? meta.universe : null;
  const contexts = Array.isArray(payload[1]) ? payload[1] : null;
  if (!universe || !contexts || universe.length !== contexts.length) {
    throw new Error("metaAndAssetCtxs universe/context mismatch");
  }
  const wanted = new Set(symbols.map(canonicalMarketKey));
  const result: FundingContext[] = [];
  for (let index = 0; index < universe.length; index += 1) {
    const asset = objectValue(universe[index]);
    const context = objectValue(contexts[index]);
    const rawName = typeof asset?.name === "string" ? asset.name : "";
    const symbol = canonicalMarketKey(rawName);
    const rateHourly = numberValue(context?.funding);
    if (wanted.has(symbol) && !Number.isFinite(rateHourly)) {
      throw new Error(`malformed funding row ${index}`);
    }
    if (wanted.has(symbol)) {
      result.push({ symbol, rateHourly, sourceUrl: HYPERLIQUID_INFO_URL });
    }
  }
  return result.sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
}

export async function fetchTextWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonText(
  url: string,
  timeoutMs: number,
  archiveRawSource: ArchiveRawJsonSource,
): Promise<{
  payload: unknown;
  sha256: string;
  byteLength: number;
  sourceArchivePath: string;
}> {
  const response = await fetchTextWithTimeout(url, {}, timeoutMs);
  const text = response.text;
  const evidence = {
    rawText: text,
    sha256: createHash("sha256").update(text).digest("hex"),
    byteLength: Buffer.byteLength(text),
  };
  const sourceArchivePath = archiveRawSource(evidence);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}; archived at ${sourceArchivePath}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned invalid JSON; archived at ${sourceArchivePath}`);
  }
  return {
    payload,
    sha256: evidence.sha256,
    byteLength: evidence.byteLength,
    sourceArchivePath,
  };
}

export interface RawJsonSourceEvidence {
  rawText: string;
  sha256: string;
  byteLength: number;
}

type ArchiveRawJsonSource = (source: RawJsonSourceEvidence) => string;

export async function fetchLeaderboardSource(limit: number, archiveRawSource: ArchiveRawJsonSource) {
  const source = await fetchJsonText(HYPERLIQUID_LEADERBOARD_URL, 60_000, archiveRawSource);
  const classified = classifyLeaderboardRows(source.payload, limit);
  validateSourceRowCount("leaderboard", classified.sourceRowCount);
  validateMalformedSourceRows("leaderboard", classified.sourceRowCount, classified.malformedRowCount);
  validateDuplicateSourceRows("leaderboard", classified.duplicateAddressCount);
  return {
    sha256: source.sha256,
    byteLength: source.byteLength,
    sourceArchivePath: source.sourceArchivePath,
    ...classified,
  };
}

export async function fetchVaultSource(
  observedAt: number,
  limit: number,
  archiveRawSource: ArchiveRawJsonSource,
) {
  const source = await fetchJsonText(HYPERLIQUID_VAULTS_URL, 60_000, archiveRawSource);
  const classified = classifyVaultStats(source.payload, observedAt, limit);
  validateSourceRowCount("vaults", classified.sourceRowCount);
  return {
    sha256: source.sha256,
    byteLength: source.byteLength,
    sourceArchivePath: source.sourceArchivePath,
    ...classified,
  };
}

export async function postHyperliquidInfo<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const response = await fetchTextWithTimeout(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 15_000);
  if (!response.ok) throw new Error(`Hyperliquid /info returned HTTP ${response.status}`);
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new Error("Hyperliquid /info returned invalid JSON");
  }
}

export async function fetchWalletPortfolio(address: string): Promise<HyperliquidPortfolio> {
  const payload = await postHyperliquidInfo<unknown>({ type: "portfolio", user: address });
  if (!Array.isArray(payload)) throw new Error(`invalid portfolio response for ${address}`);
  return payload as HyperliquidPortfolio;
}

export async function fetchWalletSnapshot(
  address: string,
  observedAt: number,
): Promise<ParsedWalletSnapshot> {
  const payload = await postHyperliquidInfo({ type: "clearinghouseState", user: address });
  return parseClearinghouseSnapshot(payload, address, observedAt);
}

export async function fetchVaultFollowerCount(vaultAddress: string): Promise<number> {
  const payload = objectValue(await postHyperliquidInfo({ type: "vaultDetails", vaultAddress }));
  if (!payload || !Array.isArray(payload.followers)) {
    throw new Error(`invalid vaultDetails response for ${vaultAddress}`);
  }
  return payload.followers.length;
}

export async function fetchFundingContext(symbols: readonly string[]): Promise<FundingContext[]> {
  return parseFundingContext(
    await postHyperliquidInfo({ type: "metaAndAssetCtxs" }),
    symbols,
  );
}
