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
export const PILOT_EVENT_POLICY_V1: SmartMoneyEventPolicy = Object.freeze({
  version: "smart-money-pilot-events-v2-shadow",
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

export interface SmartMoneyEventEvidence {
  cohortVersionKey: string;
  previousNetUsd?: number;
  currentNetUsd?: number;
  deltaUsd?: number;
  previousPositionUsd?: number;
  currentPositionUsd?: number;
  accountValueUsd?: number;
  walletCount?: number;
  wallets?: string[];
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
  previousPositionUsd: number;
  currentPositionUsd: number;
  deltaUsd: number;
  accountValueUsd: number;
}

function positionMap(snapshot: WalletPositionSnapshot): Map<string, number> {
  const result = new Map<string, number>();
  for (const position of snapshot.positions) {
    const coin = position.coin.includes(":") ? position.coin : position.coin.toUpperCase();
    result.set(coin, (result.get(coin) ?? 0) + signedPositionValue(position));
  }
  return result;
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
      const previousPositionUsd = previousPositions.get(symbol) ?? 0;
      const currentPositionUsd = currentPositions.get(symbol) ?? 0;
      const deltaUsd = currentPositionUsd - previousPositionUsd;
      if (deltaUsd === 0) continue;
      changes.push({
        address,
        symbol,
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
  const policy = input.policy ?? PILOT_EVENT_POLICY_V1;
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
      const wallets = group.map((change) => change.address).sort();
      const deltaUsd = group.reduce((total, change) => total + change.deltaUsd, 0);
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
          walletCount: wallets.length,
          wallets,
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
    lines.push(
      `${shortAddress(address)} changed ${event.symbol} net exposure by ${formatUsd(event.evidence.deltaUsd ?? 0)}.`,
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
    return `- **${event.symbol}:** ${shortAddress(event.address ?? "unknown")} changed net exposure by ${formatUsd(event.evidence.deltaUsd ?? 0)}.${verify}`;
  }
  if (event.type === "coordinated_position_change") {
    return `- **${event.symbol}:** ${event.evidence.walletCount ?? 0} cohort wallets changed exposure in the same direction; combined change ${formatUsd(event.evidence.deltaUsd ?? 0)}.${verify}`;
  }
  return `- **Vault ${event.vaultAddress ? shortAddress(event.vaultAddress) : "unknown"}:** estimated net depositor-flow proxy ${formatUsd(event.evidence.estimatedNetDepositorFlowUsd ?? 0)} (TVL change minus PnL change).${verify}`;
}

export function formatDailySmartMoneyDigest(input: {
  dateUtc: string;
  generatedAt: number;
  currentWallets: WalletPositionSnapshot[];
  events: SmartMoneyEventCandidate[];
  funding: FundingContext[];
  policy?: SmartMoneyEventPolicy;
}): DailySmartMoneyDigest {
  const policy = input.policy ?? PILOT_EVENT_POLICY_V1;
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

  const markdown = [
    `# Smart Money Daily — ${input.dateUtc}`,
    "DRAFT — HUMAN REVIEW REQUIRED",
    `Generated ${new Date(input.generatedAt).toISOString()} from a ${input.currentWallets.length}-wallet cohort snapshot.`,
    "",
    "## Cohort positioning",
    ...positioningLines,
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
