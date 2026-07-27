import Database from "better-sqlite3";
import { join } from "node:path";

import { sectorOf } from "../src/config/sectors";
import { displayScaleOf } from "../src/lib/hyperliquid";
import {
  recentMarketOpenSchedules,
  type MarketOpenSchedule,
} from "../src/lib/marketOpenOiCalendar";
import {
  DEFAULT_MARKET_OPEN_OI_SELECTION,
  marketOpenUniverse,
  type MarketOpenOiItem,
  type MarketOpenRegion,
  type MarketOpenOiSnapshot,
} from "../src/lib/marketOpenOi";
import {
  summarizeMarketOpenOiBacktest,
  type MarketOpenOiBacktestCohort,
  type MarketOpenOiBacktestObservation,
} from "../src/lib/marketOpenOiBacktest";
import {
  buildMarketOpenOiPreview,
  type MarketOpenOiSourceAsset,
} from "../src/lib/marketOpenOiService";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MINIMUM_GROUP_SIZE = 5;
const HORIZONS = [
  { label: "1h", offsetMs: HOUR_MS },
  { label: "4h", offsetMs: 4 * HOUR_MS },
  { label: "24h", offsetMs: DAY_MS },
] as const;

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number`);
  return value;
}

function shiftedSchedule(schedule: MarketOpenSchedule, offsetMs: number): MarketOpenSchedule {
  return {
    ...schedule,
    key: `${schedule.key}:control+2h`,
    label: `${schedule.label} control +2h`,
    reportAt: schedule.reportAt + offsetMs,
    openAt: schedule.openAt + offsetMs,
  };
}

interface HistoricalOiSymbol {
  symbol: string;
}

function historicalOiSymbols(db: Database.Database): HistoricalOiSymbol[] {
  return db.prepare(`
    select distinct symbol
    from price_snapshots
    where oi is not null
    order by symbol asc
  `).all() as HistoricalOiSymbol[];
}

function historicalSourceAssets(rows: HistoricalOiSymbol[]): MarketOpenOiSourceAsset[] {
  const assets: MarketOpenOiSourceAsset[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.symbol)) continue;
    seen.add(row.symbol);
    const sector = sectorOf(row.symbol);
    if (!marketOpenUniverse(sector)) continue;
    assets.push({ symbol: row.symbol, sector, displayScale: displayScaleOf(row.symbol) });
  }
  return assets.sort((left, right) => left.symbol.localeCompare(right.symbol));
}

async function main() {
  const days = numberArg("--days", 14);
  if (!Number.isInteger(days) || days > 90) {
    throw new Error("--days requires an integer from 1 through 90");
  }
  const dbPath = process.env.SCREENER_DB_PATH ?? join(process.cwd(), "data", "screener.db");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  const snapshotStatement = db.prepare(`
    select mark, oi, funding, volume, ts
    from price_snapshots
    where symbol = ? and ts <= ? and ts >= ?
    order by ts desc limit 1
  `);
  const snapshots = (
    targetAt: number,
    toleranceMs: number,
    symbols: string[],
  ): Map<string, MarketOpenOiSnapshot> => {
    const rows = new Map<string, MarketOpenOiSnapshot>();
    for (const symbol of symbols) {
      const row = snapshotStatement.get(
        symbol,
        targetAt,
        targetAt - toleranceMs,
      ) as MarketOpenOiSnapshot | undefined;
      if (row) rows.set(symbol, row);
    }
    return rows;
  };
  const assets = historicalSourceAssets(historicalOiSymbols(db));
  const deps = {
    assets: () => assets,
    snapshots,
    smartFlowDeltas: () => new Map<string, number>(),
  };
  const eligibleDeps = {
    ...deps,
  };
  const allEligibleSelection = {
    ...DEFAULT_MARKET_OPEN_OI_SELECTION,
    maxPerUniverse: assets.length,
  };
  const assetScale = new Map(assets.map((asset) => [asset.symbol, asset.displayScale]));
  const now = Date.now();
  const observations: MarketOpenOiBacktestObservation[] = [];
  const sampleBodies: Array<{ cohort: string; key: string; body: string }> = [];
  let evaluatedCohorts = 0;
  let suppressedCohorts = 0;
  let requestedObservations = 0;
  let missingObservations = 0;
  const tradingSessionsByRegion: Record<MarketOpenRegion, number> = { asia: 0, europe: 0, us: 0 };
  const schedules = recentMarketOpenSchedules(now, days, 26 * HOUR_MS + 10 * 60_000);

  function appendOutcomes(
    cohort: MarketOpenOiBacktestCohort,
    base: MarketOpenSchedule,
    schedule: MarketOpenSchedule,
    items: MarketOpenOiItem[],
  ): void {
    const appendMissing = (item: MarketOpenOiItem, horizon: string) => {
      observations.push({
        cohort,
        region: base.region,
        universe: item.universe,
        quadrant: item.quadrant,
        horizon,
        returnPct: null,
        absReturnPct: null,
        continuationReturnPct: null,
      });
    };
    for (const item of items) {
      const scale = assetScale.get(item.symbol) ?? 1;
      const openPoint = snapshots(schedule.openAt, 10 * 60_000, [item.symbol]).get(item.symbol);
      if (!openPoint || openPoint.mark <= 0) {
        requestedObservations += HORIZONS.length;
        missingObservations += HORIZONS.length;
        for (const horizon of HORIZONS) appendMissing(item, horizon.label);
        continue;
      }
      const openPrice = openPoint.mark / scale;
      for (const horizon of HORIZONS) {
        requestedObservations += 1;
        const point = snapshots(
          schedule.openAt + horizon.offsetMs,
          10 * 60_000,
          [item.symbol],
        ).get(item.symbol);
        if (!point || point.mark <= 0) {
          missingObservations += 1;
          appendMissing(item, horizon.label);
          continue;
        }
        const price = point.mark / scale;
        const returnPct = ((price - openPrice) / openPrice) * 100;
        const priorDirection = Math.sign(item.priceChangePct);
        observations.push({
          cohort,
          region: base.region,
          universe: item.universe,
          quadrant: item.quadrant,
          horizon: horizon.label,
          returnPct,
          absReturnPct: Math.abs(returnPct),
          continuationReturnPct: priorDirection === 0 ? 0 : priorDirection * returnPct,
        });
      }
    }
  }

  for (const base of schedules) {
    tradingSessionsByRegion[base.region] += 1;
    for (const [cohort, schedule, selection, buildDeps] of [
      ["selected-open", base, DEFAULT_MARKET_OPEN_OI_SELECTION, deps],
      ["eligible-open", base, allEligibleSelection, eligibleDeps],
      ["selected-control+2h", shiftedSchedule(base, 2 * HOUR_MS), DEFAULT_MARKET_OPEN_OI_SELECTION, deps],
    ] as const) {
      const preview = buildMarketOpenOiPreview(schedule, schedule.reportAt, selection, buildDeps);
      if (preview.status !== "ready") {
        suppressedCohorts += 1;
        continue;
      }
      evaluatedCohorts += 1;
      if (sampleBodies.length < 3 && cohort === "selected-open") {
        sampleBodies.push({ cohort, key: base.key, body: preview.body });
      }
      appendOutcomes(
        cohort,
        base,
        schedule,
        [...preview.selection.crypto, ...preview.selection.equity],
      );
    }
  }

  db.close();
  console.log(JSON.stringify({
    generatedAt: new Date(now).toISOString(),
    requestedDays: days,
    policy: "descriptive shadow analysis; SQLite reads only; no API routes, writes, or Telegram sends",
    source: "price_snapshots and static sector/display-scale configuration",
    assets: assets.length,
    minimumGroupSize: MINIMUM_GROUP_SIZE,
    tradingSessionsByRegion,
    eligibleTradingSessions: schedules.length,
    evaluatedCohorts,
    suppressedCohorts,
    requestedObservations,
    missingObservations,
    observations: requestedObservations - missingObservations,
    summary: summarizeMarketOpenOiBacktest(observations, MINIMUM_GROUP_SIZE),
    samples: sampleBodies,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
