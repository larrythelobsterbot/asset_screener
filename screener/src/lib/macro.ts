import type { MacroData } from "./types";
import { fetchWithTimeout } from "./fetchWithTimeout";

const FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv";

export interface FredObservation {
  date: string;
  value: number;
}

export interface FredMacroSeries {
  seriesId: string;
  symbol: string;
  label: string;
}

export const FRED_MACRO_SERIES: readonly FredMacroSeries[] = [
  { seriesId: "DTWEXBGS", symbol: "USD", label: "Broad US Dollar" },
  { seriesId: "VIXCLS", symbol: "VIX", label: "Volatility" },
  { seriesId: "DGS10", symbol: "US10Y", label: "US 10Y Yield" },
];

export function parseFredCsv(csv: string): FredObservation[] {
  const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const observations: FredObservation[] = [];
  for (const line of lines.slice(1)) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    const rawValue = line.slice(comma + 1).trim();
    const value = Number(rawValue);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || rawValue === "." || !Number.isFinite(value)) continue;
    observations.push({ date, value });
  }
  return observations;
}

export function macroDataFromFredCsv(
  csv: string,
  symbol: string,
  label: string,
): MacroData {
  const observations = parseFredCsv(csv);
  const latest = observations.at(-1);
  const previous = observations.at(-2);
  if (!latest) {
    return { symbol, label, value: null, change: null, source: "delayed", asOf: null };
  }

  const change = previous && previous.value !== 0
    ? ((latest.value - previous.value) / previous.value) * 100
    : null;
  return {
    symbol,
    label,
    value: latest.value,
    change,
    source: "delayed",
    asOf: Date.parse(`${latest.date}T00:00:00Z`),
  };
}

export async function fetchFredMacroData(series: FredMacroSeries): Promise<MacroData> {
  const url = `${FRED_CSV_URL}?id=${encodeURIComponent(series.seriesId)}`;
  const response = await fetchWithTimeout(url, {
    cache: "no-store",
    headers: { accept: "text/csv" },
  }, 10_000);
  if (!response.ok) throw new Error(`FRED ${series.seriesId}: HTTP ${response.status}`);
  return macroDataFromFredCsv(await response.text(), series.symbol, series.label);
}

export function mergeMacroData(
  current: MacroData[],
  previous: MacroData[],
): { data: MacroData[]; degraded: boolean } {
  const previousBySymbol = new Map(previous.map((point) => [point.symbol, point]));
  let degraded = false;
  const data = current.map((point) => {
    if (point.value != null) return { ...point, stale: false };
    degraded = true;
    const fallback = previousBySymbol.get(point.symbol);
    return fallback?.value != null
      ? { ...fallback, stale: true }
      : { ...point, stale: true };
  });
  return { data, degraded };
}
