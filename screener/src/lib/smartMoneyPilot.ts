const DAY_MS = 86_400_000;

export type HyperliquidHistoryPoint = [number, string];

export interface HyperliquidPortfolioWindow {
  accountValueHistory: HyperliquidHistoryPoint[];
  pnlHistory: HyperliquidHistoryPoint[];
  vlm: string;
}

export type HyperliquidPortfolio = Array<[string, HyperliquidPortfolioWindow]>;

export interface WalletPerformanceEvidence {
  address: string;
  observedAt: number;
  trackStartAt: number;
  liveAccountValue: number;
  pnl7d: number;
  pnl30d: number;
  pnl90d: number;
  roi30d: number;
  volume30d: number;
}

export interface SmartCohortPolicy {
  version: string;
  minTrackRecordDays: number;
  minAccountValueUsd: number;
  minPnl7dUsd: number;
  minPnl30dUsd: number;
  minPnl90dUsd: number;
  maxTurnover30d: number;
  maxRoi30d: number;
}

export const PILOT_COHORT_POLICY_V1: SmartCohortPolicy = Object.freeze({
  version: "smart-money-pilot-cohort-v2",
  minTrackRecordDays: 90,
  minAccountValueUsd: 250_000,
  minPnl7dUsd: 0,
  minPnl30dUsd: 0,
  minPnl90dUsd: 0,
  maxTurnover30d: 50,
  maxRoi30d: 2,
});

export interface WalletPosition {
  coin: string;
  szi: number;
  positionValue: number;
  leverage: number | null;
}

export interface WalletPositionSnapshot {
  address: string;
  observedAt: number;
  accountValue: number;
  positions: WalletPosition[];
}

export interface VaultSnapshot {
  vaultAddress: string;
  observedAt: number;
  name: string;
  tvl: number;
  cumulativePnl: number;
  followerCount: number | null;
  verificationUrl: string;
}

export interface SmartMoneyEventPolicy {
  version: string;
  majorAssets: readonly string[];
  aggregateFlipMinEndpointUsd: number;
  aggregateFlipMinDeltaUsd: number;
  individualMinDeltaUsd: number;
  individualMinAccountFraction: number;
  coordinatedMinWallets: number;
  coordinatedMinWalletDeltaUsd: number;
  coordinatedMinAccountFraction: number;
  vaultMinTvlUsd: number;
  vaultFlowMinUsd: number;
  vaultFlowMinFraction: number;
}

// Shadow-only pilot thresholds. They create review drafts and are deliberately
// not wired to Telegram delivery. Promote or tune only after the seven-day audit.
export const PILOT_EVENT_POLICY_V3: SmartMoneyEventPolicy = Object.freeze({
  version: "smart-money-trade-change-v3-shadow",
  majorAssets: Object.freeze(["BTC", "ETH", "SOL", "HYPE"]),
  aggregateFlipMinEndpointUsd: 1_000_000,
  aggregateFlipMinDeltaUsd: 2_000_000,
  individualMinDeltaUsd: 1_000_000,
  individualMinAccountFraction: 0.1,
  coordinatedMinWallets: 3,
  coordinatedMinWalletDeltaUsd: 250_000,
  coordinatedMinAccountFraction: 0.05,
  vaultMinTvlUsd: 1_000_000,
  vaultFlowMinUsd: 500_000,
  vaultFlowMinFraction: 0.1,
});

export type SmartMoneyEventType =
  | "cohort_net_flip"
  | "unusual_position_change"
  | "coordinated_position_change"
  | "vault_flow_anomaly";

export type SmartMoneyTradeChangeKind =
  | "open_long"
  | "open_short"
  | "close_long"
  | "close_short"
  | "add_long"
  | "add_short"
  | "reduce_long"
  | "reduce_short"
  | "flip_long_to_short"
  | "flip_short_to_long";

export type SmartMoneyTradeChangeReasonCode =
  | "snapshot_net_size_change"
  | "flat_to_long_size"
  | "flat_to_short_size"
  | "long_to_flat_size"
  | "short_to_flat_size"
  | "long_size_increased"
  | "long_size_decreased"
  | "short_size_increased"
  | "short_size_decreased"
  | "long_to_short_size"
  | "short_to_long_size";

export interface SmartMoneyWalletTradeChangeEvidence {
  address: string;
  tradeChangeKind: SmartMoneyTradeChangeKind;
  inferenceConfidence: "medium";
  reasonCodes: readonly SmartMoneyTradeChangeReasonCode[];
  previousSzi: number;
  currentSzi: number;
  deltaSzi: number;
  referenceMarkPrice: number;
  previousPositionUsd: number;
  currentPositionUsd: number;
  deltaUsd: number;
}

export interface SmartMoneyEventEvidence {
  cohortVersionKey: string;
  detectorVersionKey?: string;
  previousNetUsd?: number;
  currentNetUsd?: number;
  deltaUsd?: number;
  previousPositionUsd?: number;
  currentPositionUsd?: number;
  previousSzi?: number;
  currentSzi?: number;
  deltaSzi?: number;
  referenceMarkPrice?: number;
  tradeChangeKind?: SmartMoneyTradeChangeKind;
  inferenceConfidence?: "medium";
  reasonCodes?: readonly SmartMoneyTradeChangeReasonCode[];
  accountValueUsd?: number;
  walletCount?: number;
  wallets?: string[];
  tradeChanges?: SmartMoneyWalletTradeChangeEvidence[];
  previousTvlUsd?: number;
  currentTvlUsd?: number;
  pnlChangeUsd?: number;
  estimatedNetDepositorFlowUsd?: number;
  intervalHours?: number;
}

export interface SmartMoneyEventCandidate {
  fingerprint: string;
  type: SmartMoneyEventType;
  observedAt: number;
  symbol: string | null;
  address: string | null;
  vaultAddress: string | null;
  verificationUrls: string[];
  evidence: SmartMoneyEventEvidence;
}

function normalizedAddressSet(snapshots: WalletPositionSnapshot[]): string[] {
  return snapshots.map((snapshot) => snapshot.address.toLowerCase()).sort();
}

function hasPairedWalletCoverage(
  previous: WalletPositionSnapshot[],
  current: WalletPositionSnapshot[],
): boolean {
  if (previous.length === 0 || previous.length !== current.length) return false;
  const previousAddresses = normalizedAddressSet(previous);
  const currentAddresses = normalizedAddressSet(current);
  return previousAddresses.every((address, index) => address === currentAddresses[index]);
}

function pairedIntervalHours(
  previous: Array<{ observedAt: number }>,
  current: Array<{ observedAt: number }>,
): number | null {
  const previousTimes = [...new Set(previous.map(({ observedAt }) => observedAt))];
  const currentTimes = [...new Set(current.map(({ observedAt }) => observedAt))];
  if (previousTimes.length !== 1 || currentTimes.length !== 1) return null;
  const intervalHours = (currentTimes[0] - previousTimes[0]) / 3_600_000;
  return intervalHours > 0 && intervalHours <= 6 ? intervalHours : null;
}

function signedPositionValue(position: WalletPosition): number {
  if (!Number.isFinite(position.positionValue) || !Number.isFinite(position.szi)) return 0;
  return Math.sign(position.szi) * Math.abs(position.positionValue);
}

function netPositionByCoin(snapshots: WalletPositionSnapshot[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const snapshot of snapshots) {
    for (const position of snapshot.positions) {
      const coin = position.coin.includes(":") ? position.coin : position.coin.toUpperCase();
      result.set(coin, (result.get(coin) ?? 0) + signedPositionValue(position));
    }
  }
  return result;
}

interface WalletPositionChange {
  address: string;
  symbol: string;
  tradeChangeKind: SmartMoneyTradeChangeKind;
  inferenceConfidence: "medium";
  reasonCodes: readonly SmartMoneyTradeChangeReasonCode[];
  previousSzi: number;
  currentSzi: number;
  deltaSzi: number;
  referenceMarkPrice: number;
  previousPositionUsd: number;
  currentPositionUsd: number;
  deltaUsd: number;
  accountValueUsd: number;
}

interface WalletPositionState {
  szi: number;
  signedPositionUsd: number;
}

function positionMap(snapshot: WalletPositionSnapshot): Map<string, WalletPositionState> {
  const result = new Map<string, WalletPositionState>();
  for (const position of snapshot.positions) {
    const coin = position.coin.includes(":") ? position.coin : position.coin.toUpperCase();
    const existing = result.get(coin) ?? { szi: 0, signedPositionUsd: 0 };
    result.set(coin, {
      szi: existing.szi + position.szi,
      signedPositionUsd: existing.signedPositionUsd + signedPositionValue(position),
    });
  }
  return result;
}

function impliedMarkPrice(state: WalletPositionState | undefined): number | null {
  if (!state || state.szi === 0) return null;
  const markPrice = Math.abs(state.signedPositionUsd / state.szi);
  return Number.isFinite(markPrice) && markPrice > 0 ? markPrice : null;
}

function classifyTradeChange(
  previousSzi: number,
  currentSzi: number,
): { kind: SmartMoneyTradeChangeKind; reasonCode: SmartMoneyTradeChangeReasonCode } {
  if (previousSzi === 0) return currentSzi > 0
    ? { kind: "open_long", reasonCode: "flat_to_long_size" }
    : { kind: "open_short", reasonCode: "flat_to_short_size" };
  if (currentSzi === 0) return previousSzi > 0
    ? { kind: "close_long", reasonCode: "long_to_flat_size" }
    : { kind: "close_short", reasonCode: "short_to_flat_size" };
  if (previousSzi > 0 && currentSzi < 0) {
    return { kind: "flip_long_to_short", reasonCode: "long_to_short_size" };
  }
  if (previousSzi < 0 && currentSzi > 0) {
    return { kind: "flip_short_to_long", reasonCode: "short_to_long_size" };
  }
  if (previousSzi > 0) return currentSzi > previousSzi
    ? { kind: "add_long", reasonCode: "long_size_increased" }
    : { kind: "reduce_long", reasonCode: "long_size_decreased" };
  return currentSzi < previousSzi
    ? { kind: "add_short", reasonCode: "short_size_increased" }
    : { kind: "reduce_short", reasonCode: "short_size_decreased" };
}

function deriveWalletPositionChanges(
  previous: WalletPositionSnapshot[],
  current: WalletPositionSnapshot[],
): WalletPositionChange[] {
  const previousByAddress = new Map(
    previous.map((snapshot) => [snapshot.address.toLowerCase(), snapshot]),
  );
  const changes: WalletPositionChange[] = [];
  for (const currentSnapshot of current) {
    const address = currentSnapshot.address.toLowerCase();
    const previousSnapshot = previousByAddress.get(address)!;
    const previousPositions = positionMap(previousSnapshot);
    const currentPositions = positionMap(currentSnapshot);
    const symbols = new Set([...previousPositions.keys(), ...currentPositions.keys()]);
    for (const symbol of symbols) {
      const previousPosition = previousPositions.get(symbol);
      const currentPosition = currentPositions.get(symbol);
      const previousSzi = previousPosition?.szi ?? 0;
      const currentSzi = currentPosition?.szi ?? 0;
      const deltaSzi = currentSzi - previousSzi;
      if (deltaSzi === 0) continue;
      const referenceMarkPrice = currentSzi === 0
        ? impliedMarkPrice(previousPosition)
        : impliedMarkPrice(currentPosition);
      if (referenceMarkPrice === null) continue;
      const previousPositionUsd = previousSzi * referenceMarkPrice;
      const currentPositionUsd = currentSzi * referenceMarkPrice;
      const deltaUsd = deltaSzi * referenceMarkPrice;
      const inference = classifyTradeChange(previousSzi, currentSzi);
      changes.push({
        address,
        symbol,
        tradeChangeKind: inference.kind,
        inferenceConfidence: "medium",
        reasonCodes: ["snapshot_net_size_change", inference.reasonCode],
        previousSzi,
        currentSzi,
        deltaSzi,
        referenceMarkPrice,
        previousPositionUsd,
        currentPositionUsd,
        deltaUsd,
        accountValueUsd: currentSnapshot.accountValue,
      });
    }
  }
  return changes;
}

function walletVerificationUrl(address: string): string {
  return `https://app.hyperliquid.xyz/explorer/address/${address}`;
}

export function detectSmartMoneyEvents(input: {
  observedAt: number;
  cohortVersionKey: string;
  previousWallets: WalletPositionSnapshot[];
  currentWallets: WalletPositionSnapshot[];
  previousVaults: VaultSnapshot[];
  currentVaults: VaultSnapshot[];
  policy?: SmartMoneyEventPolicy;
}): SmartMoneyEventCandidate[] {
  const policy = input.policy ?? PILOT_EVENT_POLICY_V3;
  if (input.cohortVersionKey.trim().length === 0) throw new Error("cohortVersionKey is required");
  const events: SmartMoneyEventCandidate[] = [];
  const bucket = Math.floor(input.observedAt / (4 * 3_600_000));

  const walletIntervalHours = pairedIntervalHours(input.previousWallets, input.currentWallets);
  if (hasPairedWalletCoverage(input.previousWallets, input.currentWallets)
    && walletIntervalHours !== null) {
    const previousNet = netPositionByCoin(input.previousWallets);
    const currentNet = netPositionByCoin(input.currentWallets);
    const cohortVerificationUrls = input.currentWallets
      .map(({ address }) => address.toLowerCase())
      .sort()
      .map(walletVerificationUrl);
    for (const symbol of policy.majorAssets) {
      const previousNetUsd = previousNet.get(symbol) ?? 0;
      const currentNetUsd = currentNet.get(symbol) ?? 0;
      const flipped = Math.sign(previousNetUsd) !== 0
        && Math.sign(currentNetUsd) !== 0
        && Math.sign(previousNetUsd) !== Math.sign(currentNetUsd);
      const deltaUsd = currentNetUsd - previousNetUsd;
      if (
        flipped
        && Math.abs(previousNetUsd) >= policy.aggregateFlipMinEndpointUsd
        && Math.abs(currentNetUsd) >= policy.aggregateFlipMinEndpointUsd
        && Math.abs(deltaUsd) >= policy.aggregateFlipMinDeltaUsd
      ) {
        events.push({
          fingerprint: `${policy.version}:${input.cohortVersionKey}:cohort_net_flip:${symbol}:${bucket}`,
          type: "cohort_net_flip",
          observedAt: input.observedAt,
          symbol,
          address: null,
          vaultAddress: null,
          verificationUrls: cohortVerificationUrls,
          evidence: {
            cohortVersionKey: input.cohortVersionKey,
            detectorVersionKey: policy.version,
            previousNetUsd,
            currentNetUsd,
            deltaUsd,
            intervalHours: walletIntervalHours,
          },
        });
      }
    }

    const changes = deriveWalletPositionChanges(input.previousWallets, input.currentWallets);
    for (const change of changes) {
      const threshold = Math.max(
        policy.individualMinDeltaUsd,
        change.accountValueUsd * policy.individualMinAccountFraction,
      );
      if (Math.abs(change.deltaUsd) < threshold) continue;
      events.push({
        fingerprint: `${policy.version}:${input.cohortVersionKey}:unusual_position_change:${change.address}:${change.symbol}:${bucket}`,
        type: "unusual_position_change",
        observedAt: input.observedAt,
        symbol: change.symbol,
        address: change.address,
        vaultAddress: null,
        verificationUrls: [walletVerificationUrl(change.address)],
        evidence: {
          cohortVersionKey: input.cohortVersionKey,
          detectorVersionKey: policy.version,
          tradeChangeKind: change.tradeChangeKind,
          inferenceConfidence: change.inferenceConfidence,
          reasonCodes: change.reasonCodes,
          previousSzi: change.previousSzi,
          currentSzi: change.currentSzi,
          deltaSzi: change.deltaSzi,
          referenceMarkPrice: change.referenceMarkPrice,
          previousPositionUsd: change.previousPositionUsd,
          currentPositionUsd: change.currentPositionUsd,
          deltaUsd: change.deltaUsd,
          accountValueUsd: change.accountValueUsd,
          intervalHours: walletIntervalHours,
        },
      });
    }

    const coordinatedGroups = new Map<string, {
      symbol: string;
      direction: "increase" | "decrease";
      changes: WalletPositionChange[];
    }>();
    for (const change of changes) {
      const threshold = Math.max(
        policy.coordinatedMinWalletDeltaUsd,
        change.accountValueUsd * policy.coordinatedMinAccountFraction,
      );
      if (Math.abs(change.deltaUsd) < threshold) continue;
      const direction = Math.sign(change.deltaUsd) > 0 ? "increase" : "decrease";
      const key = JSON.stringify([change.symbol, direction]);
      const group = coordinatedGroups.get(key) ?? { symbol: change.symbol, direction, changes: [] };
      group.changes.push(change);
      coordinatedGroups.set(key, group);
    }
    for (const { symbol, direction, changes: group } of coordinatedGroups.values()) {
      if (group.length < policy.coordinatedMinWallets) continue;
      const sortedChanges = [...group].sort((a, b) => a.address.localeCompare(b.address));
      const wallets = sortedChanges.map((change) => change.address);
      const deltaUsd = sortedChanges.reduce((total, change) => total + change.deltaUsd, 0);
      events.push({
        fingerprint: `${policy.version}:${input.cohortVersionKey}:coordinated_position_change:${symbol}:${direction}:${bucket}`,
        type: "coordinated_position_change",
        observedAt: input.observedAt,
        symbol,
        address: null,
        vaultAddress: null,
        verificationUrls: wallets.map(walletVerificationUrl),
        evidence: {
          cohortVersionKey: input.cohortVersionKey,
          detectorVersionKey: policy.version,
          walletCount: wallets.length,
          wallets,
          tradeChanges: sortedChanges.map((change) => ({
            address: change.address,
            tradeChangeKind: change.tradeChangeKind,
            inferenceConfidence: change.inferenceConfidence,
            reasonCodes: change.reasonCodes,
            previousSzi: change.previousSzi,
            currentSzi: change.currentSzi,
            deltaSzi: change.deltaSzi,
            referenceMarkPrice: change.referenceMarkPrice,
            previousPositionUsd: change.previousPositionUsd,
            currentPositionUsd: change.currentPositionUsd,
            deltaUsd: change.deltaUsd,
          })),
          deltaUsd,
          intervalHours: walletIntervalHours,
        },
      });
    }
  }

  const previousVaults = new Map(
    input.previousVaults.map((snapshot) => [snapshot.vaultAddress.toLowerCase(), snapshot]),
  );
  for (const current of input.currentVaults) {
    const vaultAddress = current.vaultAddress.toLowerCase();
    const previous = previousVaults.get(vaultAddress);
    if (!previous || previous.tvl < policy.vaultMinTvlUsd) continue;
    const vaultIntervalHours = pairedIntervalHours([previous], [current]);
    if (vaultIntervalHours === null) continue;
    const tvlChangeUsd = current.tvl - previous.tvl;
    const pnlChangeUsd = current.cumulativePnl - previous.cumulativePnl;
    // This is intentionally a proxy: TVL can also move through fees, transfers,
    // or accounting effects. Draft copy must preserve the word "estimated".
    const estimatedNetDepositorFlowUsd = tvlChangeUsd - pnlChangeUsd;
    const threshold = Math.max(
      policy.vaultFlowMinUsd,
      previous.tvl * policy.vaultFlowMinFraction,
    );
    if (Math.abs(estimatedNetDepositorFlowUsd) < threshold) continue;
    events.push({
      fingerprint: `${policy.version}:${input.cohortVersionKey}:vault_flow_anomaly:${vaultAddress}:${bucket}`,
      type: "vault_flow_anomaly",
      observedAt: input.observedAt,
      symbol: null,
      address: null,
      vaultAddress,
      verificationUrls: [current.verificationUrl],
      evidence: {
        cohortVersionKey: input.cohortVersionKey,
        detectorVersionKey: policy.version,
        previousTvlUsd: previous.tvl,
        currentTvlUsd: current.tvl,
        pnlChangeUsd,
        estimatedNetDepositorFlowUsd,
        intervalHours: vaultIntervalHours,
      },
    });
  }

  return events;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatUsd(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  if (absolute >= 1_000_000_000) return `${sign}$${(absolute / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}K`;
  return `${sign}$${absolute.toFixed(0)}`;
}

function positionLabel(value: number): string {
  if (value > 0) return `net-long ${formatUsd(value)}`;
  if (value < 0) return `net-short $${formatUsd(Math.abs(value)).replace(/^\+?\$/, "")}`;
  return "flat";
}

function tradeChangeAction(kind: SmartMoneyTradeChangeKind | undefined): string | null {
  switch (kind) {
    case "open_long": return "likely opened a long between snapshots";
    case "open_short": return "likely opened a short between snapshots";
    case "close_long": return "likely closed a long between snapshots";
    case "close_short": return "likely closed a short between snapshots";
    case "add_long": return "likely added to a long between snapshots";
    case "add_short": return "likely added to a short between snapshots";
    case "reduce_long": return "likely reduced a long between snapshots";
    case "reduce_short": return "likely reduced a short between snapshots";
    case "flip_long_to_short": return "likely flipped from long to short between snapshots";
    case "flip_short_to_long": return "likely flipped from short to long between snapshots";
    default: return null;
  }
}

export function formatSmartMoneyAlertDraft(
  event: SmartMoneyEventCandidate,
  performance?: WalletPerformanceEvidence,
): string {
  const lines = [
    "DRAFT — HUMAN REVIEW REQUIRED",
    `Observed ${new Date(event.observedAt).toISOString()}`,
  ];

  if (event.type === "cohort_net_flip") {
    lines.push(
      `${event.symbol} cohort positioning changed from ${positionLabel(event.evidence.previousNetUsd ?? 0)} to ${positionLabel(event.evidence.currentNetUsd ?? 0)}.`,
      `Aggregate change: ${formatUsd(event.evidence.deltaUsd ?? 0)}.`,
    );
  } else if (event.type === "unusual_position_change") {
    const address = event.address ?? "unknown";
    const action = tradeChangeAction(event.evidence.tradeChangeKind);
    lines.push(
      action
        ? `${shortAddress(address)} ${action} in ${event.symbol}; estimated signed exposure change ${formatUsd(event.evidence.deltaUsd ?? 0)} at one reference mark.`
        : `${shortAddress(address)} changed ${event.symbol} net exposure by ${formatUsd(event.evidence.deltaUsd ?? 0)}.`,
      `Position: ${positionLabel(event.evidence.previousPositionUsd ?? 0)} → ${positionLabel(event.evidence.currentPositionUsd ?? 0)}.`,
    );
    if (performance) {
      lines.push(
        `Track record: ${Math.floor((performance.observedAt - performance.trackStartAt) / DAY_MS)} days; 30-day PnL ${formatUsd(performance.pnl30d)}; 90-day PnL ${formatUsd(performance.pnl90d)}.`,
      );
    }
  } else if (event.type === "coordinated_position_change") {
    const wallets = event.evidence.wallets ?? [];
    lines.push(
      `${event.evidence.walletCount ?? wallets.length} cohort wallets changed ${event.symbol} exposure in the same direction.`,
      `Combined net-exposure change: ${formatUsd(event.evidence.deltaUsd ?? 0)}.`,
      `Wallets: ${wallets.map(shortAddress).join(", ")}.`,
    );
  } else {
    lines.push(
      `Vault ${event.vaultAddress ? shortAddress(event.vaultAddress) : "unknown"} recorded an estimated net depositor-flow proxy of ${formatUsd(event.evidence.estimatedNetDepositorFlowUsd ?? 0)}.`,
      `TVL: ${formatUsd(event.evidence.previousTvlUsd ?? 0)} → ${formatUsd(event.evidence.currentTvlUsd ?? 0)}; PnL change ${formatUsd(event.evidence.pnlChangeUsd ?? 0)}.`,
      "The flow value is an estimate: TVL change minus PnL change, not a direct deposit ledger.",
    );
  }

  const intervalHours = event.evidence.intervalHours;
  if (typeof intervalHours === "number" && Number.isFinite(intervalHours)) {
    lines.push(`Evidence uses a ${intervalHours.toFixed(1)}-hour paired interval.`);
  }

  if (event.verificationUrls.length > 0) {
    lines.push("Verify:", ...event.verificationUrls.map((url) => `- ${url}`));
  }
  lines.push("Descriptive data only; not trade advice. No causal claim about subsequent price movement.");
  return lines.join("\n");
}

export interface FundingContext {
  symbol: string;
  rateHourly: number;
  sourceUrl: string;
}

export interface DailySmartMoneyDigest {
  markdown: string;
  chartSvg: string;
}

export interface CohortTransitionContext {
  currentVersionKey: string;
  previousVersionKey: string | null;
  currentMembers: number;
  previousMembers: number;
  entries: number;
  stays: number;
  exits: number;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cohortPositioningChart(
  dateUtc: string,
  values: Array<{ symbol: string; netUsd: number }>,
): string {
  const width = 960;
  const height = 440;
  const baseline = 480;
  const left = 210;
  const maxWidth = 620;
  const maxAbsolute = Math.max(1, ...values.map(({ netUsd }) => Math.abs(netUsd)));
  const rows = values.map(({ symbol, netUsd }, index) => {
    const y = 112 + index * 72;
    const barWidth = Math.max(1, Math.round((Math.abs(netUsd) / maxAbsolute) * (maxWidth / 2)));
    const x = netUsd >= 0 ? baseline : baseline - barWidth;
    const color = netUsd >= 0 ? "#39d98a" : "#ff6b7a";
    return [
      `<g data-symbol="${escapeXml(symbol)}">`,
      `<text x="${left}" y="${y + 20}" fill="#e8edf5" font-size="22" font-family="ui-monospace, monospace">${escapeXml(symbol)}</text>`,
      `<rect x="${x}" y="${y}" width="${barWidth}" height="28" rx="6" fill="${color}"/>`,
      `<text x="${netUsd >= 0 ? x + barWidth + 12 : x - 12}" y="${y + 21}" text-anchor="${netUsd >= 0 ? "start" : "end"}" fill="#b8c1d1" font-size="17" font-family="ui-monospace, monospace">${escapeXml(formatUsd(netUsd))}</text>`,
      "</g>",
    ].join("");
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Smart cohort net positioning for ${escapeXml(dateUtc)}"><rect width="100%" height="100%" fill="#0b1020"/><text x="48" y="52" fill="#f4f7fb" font-size="28" font-family="ui-sans-serif, sans-serif" font-weight="700">Smart cohort net positioning</text><text x="48" y="80" fill="#8f9bb3" font-size="16" font-family="ui-sans-serif, sans-serif">${escapeXml(dateUtc)} · signed notional USD · descriptive snapshot</text><line x1="${baseline}" y1="96" x2="${baseline}" y2="392" stroke="#516078" stroke-width="2"/>${rows}<text x="${baseline - 12}" y="420" text-anchor="end" fill="#ff8c98" font-size="15" font-family="ui-sans-serif, sans-serif">net-short</text><text x="${baseline + 12}" y="420" fill="#62e3a7" font-size="15" font-family="ui-sans-serif, sans-serif">net-long</text></svg>`;
}

function digestEventLine(event: SmartMoneyEventCandidate): string {
  const verify = event.verificationUrls[0]
    ? ` [Verify](${event.verificationUrls[0]})`
    : "";
  if (event.type === "cohort_net_flip") {
    return `- **${event.symbol}:** cohort net positioning changed from ${positionLabel(event.evidence.previousNetUsd ?? 0)} to ${positionLabel(event.evidence.currentNetUsd ?? 0)}.${verify}`;
  }
  if (event.type === "unusual_position_change") {
    const action = tradeChangeAction(event.evidence.tradeChangeKind);
    return action
      ? `- **${event.symbol}:** ${shortAddress(event.address ?? "unknown")} ${action}; estimated signed exposure change ${formatUsd(event.evidence.deltaUsd ?? 0)} at one reference mark.${verify}`
      : `- **${event.symbol}:** ${shortAddress(event.address ?? "unknown")} changed net exposure by ${formatUsd(event.evidence.deltaUsd ?? 0)}.${verify}`;
  }
  if (event.type === "coordinated_position_change") {
    const hasV3SizeEvidence = event.evidence.detectorVersionKey === PILOT_EVENT_POLICY_V3.version
      && Array.isArray(event.evidence.tradeChanges);
    return hasV3SizeEvidence
      ? `- **${event.symbol}:** ${event.evidence.walletCount ?? 0} cohort wallets changed actual position sizes in the same signed-exposure direction; combined quantity change valued at ${formatUsd(event.evidence.deltaUsd ?? 0)}.${verify}`
      : `- **${event.symbol}:** ${event.evidence.walletCount ?? 0} cohort wallets changed exposure in the same direction; combined change ${formatUsd(event.evidence.deltaUsd ?? 0)}.${verify}`;
  }
  return `- **Vault ${event.vaultAddress ? shortAddress(event.vaultAddress) : "unknown"}:** estimated net depositor-flow proxy ${formatUsd(event.evidence.estimatedNetDepositorFlowUsd ?? 0)} (TVL change minus PnL change).${verify}`;
}

export function formatDailySmartMoneyDigest(input: {
  dateUtc: string;
  generatedAt: number;
  currentWallets: WalletPositionSnapshot[];
  events: SmartMoneyEventCandidate[];
  funding: FundingContext[];
  cohortContext?: CohortTransitionContext;
  policy?: SmartMoneyEventPolicy;
}): DailySmartMoneyDigest {
  const policy = input.policy ?? PILOT_EVENT_POLICY_V3;
  const net = netPositionByCoin(input.currentWallets);
  const positioning = policy.majorAssets.map((symbol) => ({
    symbol,
    netUsd: net.get(symbol) ?? 0,
  }));
  const positioningLines = positioning.map(({ symbol, netUsd }) =>
    `- **${symbol}:** ${positionLabel(netUsd)}`);
  const cohortVerificationLines = [...input.currentWallets]
    .sort((a, b) => a.address.localeCompare(b.address))
    .map(({ address }) =>
      `- [${shortAddress(address)}](${walletVerificationUrl(address)})`);
  const eventLines = input.events.length > 0
    ? input.events.map(digestEventLine)
    : ["- No shadow-policy event crossed its review threshold in this period."];
  const fundingLines = input.funding.length > 0
    ? input.funding.map(({ symbol, rateHourly, sourceUrl }) => {
      const annualized = rateHourly * 24 * 365 * 100;
      return `- **${symbol}:** ${(rateHourly * 100).toFixed(4)}% hourly (${annualized.toFixed(1)}% simple annualized). [Source](${sourceUrl})`;
    })
    : ["- Funding context unavailable; no value inferred."];
  const interpretationGuards: string[] = [];
  if (input.cohortContext) {
    const cohort = input.cohortContext;
    if ([
      cohort.currentMembers,
      cohort.previousMembers,
      cohort.entries,
      cohort.stays,
      cohort.exits,
    ].some((value) => !Number.isInteger(value) || value < 0)) {
      throw new Error("cohort transition counts must be non-negative integers");
    }
    if (cohort.entries + cohort.stays !== cohort.currentMembers
      || cohort.exits + cohort.stays !== cohort.previousMembers) {
      throw new Error("cohort transition counts are inconsistent");
    }
    if (cohort.entries > 0 || cohort.exits > 0) {
      const carryover = cohort.currentMembers > 0
        ? (cohort.stays / cohort.currentMembers) * 100
        : 0;
      interpretationGuards.push(
        `- **Cohort turnover:** ${cohort.entries} entries, ${cohort.stays} retained, and ${cohort.exits} exits; ${carryover.toFixed(1)}% of current members carried over. Current positioning is not directly comparable with the previous cohort.`,
      );
    }
    const eventCohorts = [...new Set(input.events
      .map((event) => event.evidence.cohortVersionKey)
      .filter((value): value is string => typeof value === "string" && value !== cohort.currentVersionKey))]
      .sort();
    if (eventCohorts.length > 0) {
      interpretationGuards.push(
        `- **Cohort boundary:** ${input.events.filter((event) => eventCohorts.includes(String(event.evidence.cohortVersionKey))).length} evidence event(s) use a different cohort (${eventCohorts.join(", ")}) from current positioning (${cohort.currentVersionKey}); do not attribute those changes to the current cohort.`,
      );
    }
  }
  for (const symbol of policy.majorAssets) {
    const byWallet = input.currentWallets.map((wallet) => ({
      address: wallet.address,
      grossUsd: wallet.positions
        .filter((position) => position.coin === symbol)
        .reduce((sum, position) => sum + Math.abs(position.positionValue), 0),
    })).filter(({ grossUsd }) => grossUsd > 0)
      .sort((a, b) => b.grossUsd - a.grossUsd || a.address.localeCompare(b.address));
    const grossUsd = byWallet.reduce((sum, wallet) => sum + wallet.grossUsd, 0);
    if (grossUsd <= 0) continue;
    const topOneShare = byWallet[0].grossUsd / grossUsd;
    const topTwoShare = (byWallet[0].grossUsd + (byWallet[1]?.grossUsd ?? 0)) / grossUsd;
    if (topOneShare >= 0.5 || topTwoShare >= 0.75) {
      interpretationGuards.push(
        `- **${symbol} concentration:** the largest wallet is ${(topOneShare * 100).toFixed(1)}% of gross exposure and the top two are ${(topTwoShare * 100).toFixed(1)}%; aggregate net exposure is not broad cohort consensus.`,
      );
    }
  }
  const interpretationSection = interpretationGuards.length > 0
    ? ["", "## Interpretation guards", ...interpretationGuards]
    : [];

  const markdown = [
    `# Smart Money Daily — ${input.dateUtc}`,
    "DRAFT — HUMAN REVIEW REQUIRED",
    `Generated ${new Date(input.generatedAt).toISOString()} from a ${input.currentWallets.length}-wallet cohort snapshot.`,
    "",
    "## Cohort positioning",
    ...positioningLines,
    ...interpretationSection,
    "",
    "## Cohort verification",
    ...cohortVerificationLines,
    "",
    "## Notable evidence",
    ...eventLines,
    "",
    "## Funding context",
    ...fundingLines,
    "",
    "Chart: cohort signed notional for BTC, ETH, SOL, and HYPE (attached SVG).",
    "",
    "Sources: [Hyperliquid public API](https://api.hyperliquid.xyz/info) and official explorer links above. Descriptive data only; not trade advice. No causal claim about price movement.",
  ].join("\n");

  return {
    markdown,
    chartSvg: cohortPositioningChart(input.dateUtc, positioning),
  };
}

export interface SmartMoneyEventOutcome {
  eventFingerprint: string;
  horizonHours: number;
  status: "observed" | "missing" | "untrackable";
  priceReturnPct: number | null;
}

function eventDirection(event: SmartMoneyEventCandidate): number | null {
  if (event.type === "cohort_net_flip") {
    return Math.sign(event.evidence.currentNetUsd ?? 0) || null;
  }
  if (event.type === "unusual_position_change" || event.type === "coordinated_position_change") {
    return Math.sign(event.evidence.deltaUsd ?? 0) || null;
  }
  return null;
}

export function formatWeeklySmartMoneyHonestyReport(input: {
  weekStartUtc: string;
  weekEndUtc: string;
  events: SmartMoneyEventCandidate[];
  outcomes: SmartMoneyEventOutcome[];
}): string {
  const outcomes = new Map(
    input.outcomes
      .filter((outcome) => outcome.horizonHours === 24)
      .map((outcome) => [outcome.eventFingerprint, outcome]),
  );
  let followThrough = 0;
  let misses = 0;
  let unresolved = 0;
  const evidenceLines = input.events.map((event) => {
    const outcome = outcomes.get(event.fingerprint);
    const direction = eventDirection(event);
    const label = event.symbol ?? (event.vaultAddress ? `Vault ${shortAddress(event.vaultAddress)}` : "Unattributed event");
    const verify = event.verificationUrls[0]
      ? ` [Evidence](${event.verificationUrls[0]})`
      : "";
    if (!outcome || outcome.status !== "observed" || outcome.priceReturnPct === null || direction === null) {
      unresolved += 1;
      return `- **${label}: UNRESOLVED** — no comparable 24h price outcome.${verify}`;
    }
    const aligned = Math.sign(outcome.priceReturnPct) === direction && outcome.priceReturnPct !== 0;
    if (aligned) followThrough += 1;
    else misses += 1;
    const status = aligned ? "FOLLOW-THROUGH" : "MISS";
    return `- **${label}: ${status}** — 24h price return ${outcome.priceReturnPct >= 0 ? "+" : ""}${outcome.priceReturnPct.toFixed(2)}% after the descriptive flag.${verify}`;
  });
  if (evidenceLines.length === 0) evidenceLines.push("- No events were flagged during this period.");

  return [
    `# Smart Money Honesty Report — ${input.weekStartUtc} to ${input.weekEndUtc}`,
    "DRAFT — HUMAN REVIEW REQUIRED",
    "",
    `Flags reviewed: ${input.events.length}`,
    `24h follow-through: ${followThrough}`,
    `Misses: ${misses}`,
    `Unresolved/untrackable: ${unresolved}`,
    "",
    "## Every flagged event",
    ...evidenceLines,
    "",
    "Method: FOLLOW-THROUGH means the 24h price-return sign matched the sign of the observed cohort exposure change; MISS means it did not. This diagnostic is not evidence of causation or predictive skill.",
    "Descriptive data only; not trade advice.",
  ].join("\n");
}

export type SmartCohortExclusionReason =
  | "invalid_performance_evidence"
  | "track_record_under_90d"
  | "account_value_under_floor"
  | "non_positive_7d_pnl"
  | "non_positive_30d_pnl"
  | "non_positive_90d_pnl"
  | "zero_volume_positive_pnl"
  | "turnover_above_ceiling"
  | "roi_above_vanity_ceiling";

export interface SmartCohortDecision {
  eligible: boolean;
  suspectedGaming: boolean;
  reasons: SmartCohortExclusionReason[];
  score: number;
  trackRecordDays: number;
  turnover30d: number | null;
}

function finiteHistory(history: HyperliquidHistoryPoint[]): Array<[number, number]> {
  return history
    .map(([timestamp, raw]): [number, number] => [Number(timestamp), Number(raw)])
    .filter(([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value))
    .sort((a, b) => a[0] - b[0]);
}

function pnlChange(history: HyperliquidHistoryPoint[], anchorAt?: number): number | null {
  const points = finiteHistory(history);
  if (points.length < 2) return null;
  const latest = points.at(-1)!;
  if (anchorAt === undefined) return latest[1] - points[0][1];
  const anchor = [...points].reverse().find(([timestamp]) => timestamp <= anchorAt);
  if (!anchor || anchorAt - anchor[0] > 21 * DAY_MS) return null;
  return latest[1] - anchor[1];
}

export function deriveWalletPerformanceEvidence(input: {
  address: string;
  observedAt: number;
  liveAccountValue: number;
  portfolio: HyperliquidPortfolio;
}): WalletPerformanceEvidence | null {
  const windows = new Map(input.portfolio);
  const week = windows.get("week") ?? windows.get("perpWeek");
  const month = windows.get("month") ?? windows.get("perpMonth");
  const allTime = windows.get("allTime") ?? windows.get("perpAllTime");
  if (!week || !month || !allTime) return null;

  const allTimePnl = finiteHistory(allTime.pnlHistory);
  const monthAccounts = finiteHistory(month.accountValueHistory);
  const pnl7d = pnlChange(week.pnlHistory);
  const pnl30d = pnlChange(month.pnlHistory);
  const pnl90d = pnlChange(allTime.pnlHistory, input.observedAt - 90 * DAY_MS);
  const volume30d = Number(month.vlm);
  const monthStartValue = monthAccounts[0]?.[1] ?? Number.NaN;
  if (
    allTimePnl.length < 2
    || pnl7d === null
    || pnl30d === null
    || pnl90d === null
    || !Number.isFinite(volume30d)
    || !(monthStartValue > 0)
  ) return null;

  return {
    address: input.address.toLowerCase(),
    observedAt: input.observedAt,
    trackStartAt: allTimePnl[0][0],
    liveAccountValue: input.liveAccountValue,
    pnl7d,
    pnl30d,
    pnl90d,
    roi30d: pnl30d / monthStartValue,
    volume30d,
  };
}

export function evaluateWalletForSmartCohort(
  evidence: WalletPerformanceEvidence,
  policy: SmartCohortPolicy = PILOT_COHORT_POLICY_V1,
): SmartCohortDecision {
  const values = [
    evidence.observedAt,
    evidence.trackStartAt,
    evidence.liveAccountValue,
    evidence.pnl7d,
    evidence.pnl30d,
    evidence.pnl90d,
    evidence.roi30d,
    evidence.volume30d,
  ];
  if (values.some((value) => !Number.isFinite(value))) {
    return {
      eligible: false,
      suspectedGaming: false,
      reasons: ["invalid_performance_evidence"],
      score: Number.NEGATIVE_INFINITY,
      trackRecordDays: 0,
      turnover30d: null,
    };
  }

  const reasons: SmartCohortExclusionReason[] = [];
  const trackRecordDays = Math.max(0, (evidence.observedAt - evidence.trackStartAt) / DAY_MS);
  const turnover30d = evidence.liveAccountValue > 0
    ? evidence.volume30d / evidence.liveAccountValue
    : null;

  if (trackRecordDays < policy.minTrackRecordDays) reasons.push("track_record_under_90d");
  if (evidence.liveAccountValue < policy.minAccountValueUsd) reasons.push("account_value_under_floor");
  if (evidence.pnl7d <= policy.minPnl7dUsd) reasons.push("non_positive_7d_pnl");
  if (evidence.pnl30d <= policy.minPnl30dUsd) reasons.push("non_positive_30d_pnl");
  if (evidence.pnl90d <= policy.minPnl90dUsd) reasons.push("non_positive_90d_pnl");

  const zeroVolumePositivePnl = evidence.volume30d <= 0 && evidence.pnl30d > 0;
  const turnoverAboveCeiling = turnover30d === null || turnover30d >= policy.maxTurnover30d;
  const roiAboveVanityCeiling = evidence.roi30d > policy.maxRoi30d;
  if (zeroVolumePositivePnl) reasons.push("zero_volume_positive_pnl");
  if (turnoverAboveCeiling) reasons.push("turnover_above_ceiling");
  if (roiAboveVanityCeiling) reasons.push("roi_above_vanity_ceiling");

  const suspectedGaming = zeroVolumePositivePnl || turnoverAboveCeiling || roiAboveVanityCeiling;
  const consistency = [evidence.pnl7d, evidence.pnl30d, evidence.pnl90d]
    .filter((pnl) => pnl > 0).length / 3;
  const sizeScore = Math.log10(Math.max(1, evidence.liveAccountValue));
  const roiScore = Math.min(Math.max(evidence.roi30d, 0), policy.maxRoi30d);

  return {
    eligible: reasons.length === 0,
    suspectedGaming,
    reasons,
    score: consistency * 10 + sizeScore + roiScore,
    trackRecordDays,
    turnover30d,
  };
}
