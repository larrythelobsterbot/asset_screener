import type { AssetData } from "../src/lib/types";
import { snapshotFullAtBounded } from "../src/lib/db";
import {
  recentMarketOpenSchedules,
  type MarketOpenSchedule,
} from "../src/lib/marketOpenOiCalendar";
import type { MarketOpenRegion } from "../src/lib/marketOpenOi";
import {
  buildMarketOpenOiPreview,
  defaultMarketOpenOiBuildDeps,
  marketOpenOiAssetsFromMarkets,
} from "../src/lib/marketOpenOiService";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const HORIZONS = [
  { label: "1h", offsetMs: HOUR_MS },
  { label: "4h", offsetMs: 4 * HOUR_MS },
  { label: "24h", offsetMs: DAY_MS },
] as const;

interface Observation {
  cohort: "open" | "control+2h";
  region: MarketOpenRegion;
  universe: "crypto" | "equity";
  quadrant: string;
  horizon: string;
  returnPct: number;
  absReturnPct: number;
  continuationReturnPct: number;
}

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

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(observations: Observation[]) {
  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = [observation.cohort, observation.region, observation.universe, observation.horizon].join(":");
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [cohort, region, universe, horizon] = key.split(":");
    return {
      cohort,
      region,
      universe,
      horizon,
      n: rows.length,
      meanReturnPct: mean(rows.map((row) => row.returnPct)),
      meanAbsReturnPct: mean(rows.map((row) => row.absReturnPct)),
      meanContinuationReturnPct: mean(rows.map((row) => row.continuationReturnPct)),
      positiveContinuationRate: rows.filter((row) => row.continuationReturnPct > 0).length / rows.length,
    };
  });
}

async function main() {
  const days = numberArg("--days", 14);
  if (!Number.isInteger(days) || days > 90) {
    throw new Error("--days requires an integer from 1 through 90");
  }
  const origin = process.env.SCREENER_SELF_ORIGIN ?? "http://127.0.0.1:3003";
  const response = await fetch(`${origin}/api/markets`, { cache: "no-store" });
  if (!response.ok) throw new Error(`market universe request failed: HTTP ${response.status}`);
  const markets = await response.json() as AssetData[];
  const assets = marketOpenOiAssetsFromMarkets(markets);
  const deps = { ...defaultMarketOpenOiBuildDeps, assets: () => assets };
  const assetScale = new Map(assets.map((asset) => [asset.symbol, asset.displayScale]));
  const now = Date.now();
  const observations: Observation[] = [];
  const sampleBodies: Array<{ cohort: string; key: string; body: string }> = [];
  let evaluatedCohorts = 0;
  let suppressedCohorts = 0;
  const tradingSessionsByRegion: Record<MarketOpenRegion, number> = { asia: 0, europe: 0, us: 0 };
  const schedules = recentMarketOpenSchedules(now, days, 26 * HOUR_MS + 10 * 60_000);

  for (const base of schedules) {
    tradingSessionsByRegion[base.region] += 1;
    for (const [cohort, schedule] of [
      ["open", base],
      ["control+2h", shiftedSchedule(base, 2 * HOUR_MS)],
    ] as const) {
      const preview = buildMarketOpenOiPreview(schedule, schedule.reportAt, undefined, deps);
      if (preview.status !== "ready") {
        suppressedCohorts += 1;
        continue;
      }
      evaluatedCohorts += 1;
      if (sampleBodies.length < 3 && cohort === "open") {
        sampleBodies.push({ cohort, key: base.key, body: preview.body });
      }
      for (const item of [...preview.selection.crypto, ...preview.selection.equity]) {
        const scale = assetScale.get(item.symbol) ?? 1;
        const openPoint = snapshotFullAtBounded(schedule.openAt, 10 * 60_000, [item.symbol]).get(item.symbol);
        if (!openPoint || openPoint.mark <= 0) continue;
        const openPrice = openPoint.mark / scale;
        for (const horizon of HORIZONS) {
          const point = snapshotFullAtBounded(
            schedule.openAt + horizon.offsetMs,
            10 * 60_000,
            [item.symbol],
          ).get(item.symbol);
          if (!point || point.mark <= 0) continue;
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
  }

  console.log(JSON.stringify({
    generatedAt: new Date(now).toISOString(),
    requestedDays: days,
    policy: "descriptive shadow analysis; no writes and no Telegram sends",
    assets: assets.length,
    tradingSessionsByRegion,
    eligibleTradingSessions: schedules.length,
    evaluatedCohorts,
    suppressedCohorts,
    observations: observations.length,
    summary: summarize(observations),
    samples: sampleBodies,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
