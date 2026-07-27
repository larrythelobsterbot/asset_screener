import type { Sector } from "@/config/sectors";
import { escapeHtml } from "./telegram";

export type MarketOpenUniverse = "crypto" | "equity";
export type MarketOpenRegion = "asia" | "europe" | "us";
export type OiPriceQuadrant =
  | "expanding_up"
  | "expanding_down"
  | "contracting_up"
  | "contracting_down"
  | "expanding_flat"
  | "contracting_flat";
export type SmartFlowAlignment = "aligned" | "opposed" | "not_directional" | "unknown";

export interface MarketOpenOiSnapshot {
  ts: number;
  mark: number;
  oi: number | null;
  funding: number | null;
  volume: number | null;
}

export interface MarketOpenOiInput {
  symbol: string;
  sector: Sector;
  displayScale: number;
  current: MarketOpenOiSnapshot;
  prior: MarketOpenOiSnapshot;
  smartFlowDeltaUsd?: number | null;
}

export interface MarketOpenOiItem {
  symbol: string;
  sector: Sector;
  universe: MarketOpenUniverse;
  currentTs: number;
  priorTs: number;
  currentMark: number;
  priorMark: number;
  currentOiCoins: number;
  priorOiCoins: number;
  currentOiUsd: number;
  priorOiUsd: number;
  oiQuantityDeltaUsd: number;
  oiUsdDelta: number;
  oiCoinsChangePct: number;
  priceChangePct: number;
  fundingHourly: number | null;
  fundingApr: number | null;
  volume24h: number;
  quadrant: OiPriceQuadrant;
  smartFlowDeltaUsd: number | null;
  smartFlowAlignment: SmartFlowAlignment;
}

export interface MarketOpenOiMaterialityGate {
  minCurrentOiUsd: number;
  minVolume24h: number;
  minAbsOiPct: number;
  minAbsQuantityDeltaUsd: number;
}

export interface MarketOpenOiSelectionConfig {
  crypto: MarketOpenOiMaterialityGate;
  equity: MarketOpenOiMaterialityGate;
  maxPerUniverse: number;
}

export interface MarketOpenOiSelection {
  crypto: MarketOpenOiItem[];
  equity: MarketOpenOiItem[];
}

export interface MarketOpenOiTelegramPayload {
  region: MarketOpenRegion;
  sessionLabel: string;
  localDate: string;
  reportAt: number;
  openAt: number;
  generatedAt: number;
  lookbackMs: number;
  selection: MarketOpenOiSelection;
}

const CRYPTO_SECTORS = new Set<Sector>([
  "majors",
  "l1",
  "defi",
  "meme",
  "ai",
  "gaming",
  "infra",
  "crypto-major",
  "crypto-alt",
]);
const EQUITY_SECTORS = new Set<Sector>(["stocks", "preipo", "indices"]);

const ASIA_EQUITY_SYMBOLS = new Set([
  "BABA", "EWT", "EWJ", "EWY", "H100", "HYUNDAI", "JP225", "JPN225",
  "KIOXIA", "KR200", "KWEB", "NIFTY", "SKHX", "SMSN", "SOFTBANK", "TENCENT",
  "TSM", "XIAOMI",
]);
const EUROPE_EQUITY_SYMBOLS = new Set(["ASML"]);

export const DEFAULT_MARKET_OPEN_OI_SELECTION: MarketOpenOiSelectionConfig = {
  crypto: {
    minCurrentOiUsd: 5_000_000,
    minVolume24h: 1_000_000,
    minAbsOiPct: 0.5,
    minAbsQuantityDeltaUsd: 250_000,
  },
  equity: {
    minCurrentOiUsd: 2_000_000,
    minVolume24h: 1_000_000,
    minAbsOiPct: 0.5,
    minAbsQuantityDeltaUsd: 100_000,
  },
  maxPerUniverse: 5,
};

export function marketOpenUniverse(sector: Sector): MarketOpenUniverse | null {
  if (CRYPTO_SECTORS.has(sector)) return "crypto";
  if (EQUITY_SECTORS.has(sector)) return "equity";
  return null;
}

export function equityRegionOf(symbol: string): MarketOpenRegion {
  if (ASIA_EQUITY_SYMBOLS.has(symbol)) return "asia";
  if (EUROPE_EQUITY_SYMBOLS.has(symbol)) return "europe";
  return "us";
}

function passesGate(item: MarketOpenOiItem, gate: MarketOpenOiMaterialityGate): boolean {
  return Math.max(item.currentOiUsd, item.priorOiUsd) >= gate.minCurrentOiUsd
    && item.volume24h >= gate.minVolume24h
    && Math.abs(item.oiCoinsChangePct) >= gate.minAbsOiPct
    && Math.abs(item.oiQuantityDeltaUsd) >= gate.minAbsQuantityDeltaUsd;
}

export function selectMarketOpenOiItems(
  items: MarketOpenOiItem[],
  region: MarketOpenRegion,
  config: MarketOpenOiSelectionConfig = DEFAULT_MARKET_OPEN_OI_SELECTION,
): MarketOpenOiSelection {
  const rank = (left: MarketOpenOiItem, right: MarketOpenOiItem) =>
    Math.abs(right.oiQuantityDeltaUsd) - Math.abs(left.oiQuantityDeltaUsd)
    || left.symbol.localeCompare(right.symbol);
  const limit = Math.max(0, Math.floor(config.maxPerUniverse));
  const crypto = items
    .filter((item) => item.universe === "crypto" && passesGate(item, config.crypto))
    .sort(rank)
    .slice(0, limit);
  const equity = items
    .filter((item) => item.universe === "equity"
      && equityRegionOf(item.symbol) === region
      && passesGate(item, config.equity))
    .sort(rank)
    .slice(0, limit);
  return { crypto, equity };
}

function signedPercent(value: number, decimals = 2): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

function compactUsd(value: number): string {
  const sign = value < 0 ? "-" : "+";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${sign}$${(absolute / 1_000_000_000).toFixed(2)}b`;
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}m`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}k`;
  return `${sign}$${absolute.toFixed(0)}`;
}

const QUADRANT_LABEL: Record<OiPriceQuadrant, string> = {
  expanding_up: "OI↑ / Px↑",
  expanding_down: "OI↑ / Px↓",
  contracting_up: "OI↓ / Px↑",
  contracting_down: "OI↓ / Px↓",
  expanding_flat: "OI↑ / Px→",
  contracting_flat: "OI↓ / Px→",
};

function formatItem(item: MarketOpenOiItem, rank: number): string {
  const funding = item.fundingApr === null ? "n/a" : signedPercent(item.fundingApr, 1);
  const flow = item.smartFlowDeltaUsd === null ? "n/a" : compactUsd(item.smartFlowDeltaUsd);
  const alignment = item.smartFlowAlignment === "aligned"
    ? "✓"
    : item.smartFlowAlignment === "opposed"
      ? "↔ divergence"
      : "";
  return [
    `${rank}. <b>${escapeHtml(item.symbol)}</b> · OI qty <code>${compactUsd(item.oiQuantityDeltaUsd)} (${signedPercent(item.oiCoinsChangePct)})</code>`,
    `   total OI <code>${compactUsd(item.oiUsdDelta)}</code> · Px <code>${signedPercent(item.priceChangePct)}</code> · fund <code>${funding}</code>`,
    `   <code>${QUADRANT_LABEL[item.quadrant]}</code> · smart <code>${flow}</code>${alignment ? ` ${alignment}` : ""}`,
  ].join("\n");
}

export function formatMarketOpenOiTelegram(payload: MarketOpenOiTelegramPayload): string | null {
  const total = payload.selection.crypto.length + payload.selection.equity.length;
  if (total < 2) return null;
  const minutesToOpen = Math.max(0, Math.round((payload.openAt - payload.generatedAt) / 60_000));
  const lookbackHours = payload.lookbackMs / 3_600_000;
  const itemTimestamps = [...payload.selection.crypto, ...payload.selection.equity]
    .map((item) => item.currentTs);
  const snapshotAgeMinutes = itemTimestamps.length > 0
    ? Math.max(0, Math.round((payload.generatedAt - Math.min(...itemTimestamps)) / 60_000))
    : 0;
  const blocks = [
    `🌐 <b>${escapeHtml(payload.sessionLabel.toUpperCase())} · ${lookbackHours.toFixed(0)}H POSITIONING</b>`,
    `<code>${escapeHtml(payload.localDate)}</code> · cash open in ${minutesToOpen}m · data age ≤${snapshotAgeMinutes}m`,
    "<i>Informational positioning watch — not a trade signal.</i>",
  ];
  if (payload.selection.crypto.length > 0) {
    blocks.push("", "<b>CRYPTO</b>", payload.selection.crypto
      .map((item, index) => formatItem(item, index + 1)).join("\n"));
  }
  if (payload.selection.equity.length > 0) {
    blocks.push("", "<b>EQUITY PERPS</b>", payload.selection.equity
      .map((item, index) => formatItem(item, index + 1)).join("\n"));
  }
  blocks.push("", "<a href=\"https://asset.lekker.design\">open screener</a>");
  return blocks.join("\n");
}

function finitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function quadrant(oiDelta: number, priceDelta: number): OiPriceQuadrant {
  if (oiDelta > 0) {
    if (priceDelta > 0) return "expanding_up";
    if (priceDelta < 0) return "expanding_down";
    return "expanding_flat";
  }
  if (priceDelta > 0) return "contracting_up";
  if (priceDelta < 0) return "contracting_down";
  return "contracting_flat";
}

function smartFlowAlignment(
  oiDelta: number,
  priceDelta: number,
  smartFlowDeltaUsd: number | null,
): SmartFlowAlignment {
  if (smartFlowDeltaUsd === null || !Number.isFinite(smartFlowDeltaUsd)) return "unknown";
  if (oiDelta <= 0 || priceDelta === 0) return "not_directional";
  return Math.sign(priceDelta) === Math.sign(smartFlowDeltaUsd) ? "aligned" : "opposed";
}

export function deriveMarketOpenOiItem(input: MarketOpenOiInput): MarketOpenOiItem | null {
  const universe = marketOpenUniverse(input.sector);
  if (!universe || !finitePositive(input.displayScale)) return null;
  const currentOi = input.current.oi;
  const priorOi = input.prior.oi;
  if (
    !finitePositive(input.current.mark)
    || !finitePositive(input.prior.mark)
    || !finiteNonNegative(currentOi)
    || !finitePositive(priorOi)
  ) return null;

  const currentRawPrice = input.current.mark / input.displayScale;
  const priorRawPrice = input.prior.mark / input.displayScale;
  const currentOiUsd = currentOi * currentRawPrice;
  const priorOiUsd = priorOi * priorRawPrice;
  const oiCoinsDelta = currentOi - priorOi;
  const oiCoinsChangePct = (oiCoinsDelta / priorOi) * 100;
  const priceChangePct = ((input.current.mark - input.prior.mark) / input.prior.mark) * 100;
  const fundingHourly = input.current.funding != null && Number.isFinite(input.current.funding)
    ? input.current.funding
    : null;
  const flow = input.smartFlowDeltaUsd != null && Number.isFinite(input.smartFlowDeltaUsd)
    ? input.smartFlowDeltaUsd
    : null;

  return {
    symbol: input.symbol,
    sector: input.sector,
    universe,
    currentTs: input.current.ts,
    priorTs: input.prior.ts,
    currentMark: input.current.mark,
    priorMark: input.prior.mark,
    currentOiCoins: currentOi,
    priorOiCoins: priorOi,
    currentOiUsd,
    priorOiUsd,
    oiQuantityDeltaUsd: oiCoinsDelta * priorRawPrice,
    oiUsdDelta: currentOiUsd - priorOiUsd,
    oiCoinsChangePct,
    priceChangePct,
    fundingHourly,
    fundingApr: fundingHourly === null ? null : fundingHourly * 8_760 * 100,
    volume24h: input.current.volume != null && Number.isFinite(input.current.volume)
      ? Math.max(0, input.current.volume)
      : 0,
    quadrant: quadrant(oiCoinsDelta, input.current.mark - input.prior.mark),
    smartFlowDeltaUsd: flow,
    smartFlowAlignment: smartFlowAlignment(oiCoinsDelta, input.current.mark - input.prior.mark, flow),
  };
}
