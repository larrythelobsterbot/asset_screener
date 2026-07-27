import type { MarketOpenRegion, MarketOpenUniverse } from "./marketOpenOi";

export type MarketOpenOiBacktestCohort =
  | "selected-open"
  | "eligible-open"
  | "selected-control+2h";

export interface MarketOpenOiBacktestObservation {
  cohort: MarketOpenOiBacktestCohort;
  region: MarketOpenRegion;
  universe: MarketOpenUniverse;
  quadrant: string;
  horizon: string;
  returnPct: number | null;
  absReturnPct: number | null;
  continuationReturnPct: number | null;
}

export interface MarketOpenOiBacktestSummaryRow {
  cohort: MarketOpenOiBacktestCohort;
  region: MarketOpenRegion;
  universe: MarketOpenUniverse;
  quadrant: string;
  horizon: string;
  n: number;
  requested: number;
  missing: number;
  complete: boolean;
  adequateSample: boolean;
  meanReturnPct: number | null;
  meanAbsReturnPct: number | null;
  meanContinuationReturnPct: number | null;
  positiveContinuationRate: number | null;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeMarketOpenOiBacktest(
  observations: MarketOpenOiBacktestObservation[],
  minimumGroupSize: number,
): MarketOpenOiBacktestSummaryRow[] {
  if (!Number.isInteger(minimumGroupSize) || minimumGroupSize < 1) {
    throw new Error("minimumGroupSize must be a positive integer");
  }
  const groups = new Map<string, MarketOpenOiBacktestObservation[]>();
  for (const observation of observations) {
    const key = [
      observation.cohort,
      observation.region,
      observation.universe,
      observation.quadrant,
      observation.horizon,
    ].join(":");
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => {
      const [cohort, region, universe, quadrant, horizon] = key.split(":") as [
        MarketOpenOiBacktestCohort,
        MarketOpenRegion,
        MarketOpenUniverse,
        string,
        string,
      ];
      const observed = rows.filter((row): row is MarketOpenOiBacktestObservation & {
        returnPct: number;
        absReturnPct: number;
        continuationReturnPct: number;
      } => row.returnPct !== null && row.absReturnPct !== null && row.continuationReturnPct !== null);
      const missing = rows.length - observed.length;
      const complete = missing === 0;
      const adequateSample = complete && observed.length >= minimumGroupSize;
      return {
        cohort,
        region,
        universe,
        quadrant,
        horizon,
        n: observed.length,
        requested: rows.length,
        missing,
        complete,
        adequateSample,
        meanReturnPct: adequateSample ? mean(observed.map((row) => row.returnPct)) : null,
        meanAbsReturnPct: adequateSample ? mean(observed.map((row) => row.absReturnPct)) : null,
        meanContinuationReturnPct: adequateSample
          ? mean(observed.map((row) => row.continuationReturnPct))
          : null,
        positiveContinuationRate: adequateSample
          ? observed.filter((row) => row.continuationReturnPct > 0).length / observed.length
          : null,
      };
    });
}
