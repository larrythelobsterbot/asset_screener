import type { MarketOpenRegion } from "./marketOpenOi";

const MINUTE_MS = 60_000;
const REPORT_LEAD_MS = 30 * MINUTE_MS;
export const MARKET_OPEN_OI_DUE_GRACE_MS = 10 * MINUTE_MS;

interface SessionDefinition {
  timeZone: string;
  openHour: number;
  openMinute: number;
  label: string;
}

const SESSION_DEFINITIONS: Record<MarketOpenRegion, SessionDefinition> = {
  asia: { timeZone: "Asia/Tokyo", openHour: 9, openMinute: 0, label: "Asia / Tokyo" },
  europe: { timeZone: "Europe/London", openHour: 8, openMinute: 0, label: "Europe / London" },
  us: { timeZone: "America/New_York", openHour: 9, openMinute: 30, label: "US / New York" },
};

const EXCHANGE_HOLIDAYS: Record<MarketOpenRegion, ReadonlySet<string>> = {
  asia: new Set([
    "2026-01-01", "2026-01-02", "2026-01-12", "2026-02-11", "2026-02-23",
    "2026-03-20", "2026-04-29", "2026-05-04", "2026-05-05", "2026-05-06",
    "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23",
    "2026-10-12", "2026-11-03", "2026-11-23", "2026-12-31",
    "2027-01-01", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-22",
    "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19",
    "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03",
    "2027-11-23", "2027-12-31",
  ]),
  europe: new Set([
    "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25",
    "2026-08-31", "2026-12-25", "2026-12-28",
    "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31",
    "2027-08-30", "2027-12-27", "2027-12-28",
  ]),
  us: new Set([
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  ]),
};

export interface MarketOpenSchedule {
  region: MarketOpenRegion;
  label: string;
  timeZone: string;
  localDate: string;
  key: string;
  reportAt: number;
  openAt: number;
  isTradingDay: boolean;
  closedReason: "weekend" | "holiday" | null;
  calendarCovered: boolean;
}

export interface MarketOpenCalendarCoverage {
  localYear: number;
  covered: boolean;
}

function calendarYearCovered(year: number): boolean {
  return year === 2026 || year === 2027;
}

export function marketOpenCalendarCoverageAt(
  now: number,
): Record<MarketOpenRegion, MarketOpenCalendarCoverage> {
  if (!Number.isFinite(now)) throw new Error("Calendar coverage requires a finite timestamp");
  return Object.fromEntries(
    (Object.keys(SESSION_DEFINITIONS) as MarketOpenRegion[]).map((region) => {
      const localYear = zonedParts(now, SESSION_DEFINITIONS[region].timeZone).year;
      return [region, { localYear, covered: calendarYearCovered(localYear) }];
    }),
  ) as Record<MarketOpenRegion, MarketOpenCalendarCoverage>;
}

function parseLocalDate(localDate: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error(`Invalid local market date: ${localDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid local market date: ${localDate}`);
  }
  return { year, month, day };
}

function zonedParts(epochMs: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function zonedDateTimeToEpoch(
  localDate: string,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const { year, month, day } = parseLocalDate(localDate);
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = desiredAsUtc;
  for (let attempt = 0; attempt < 3; attempt++) {
    const actual = zonedParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    candidate -= actualAsUtc - desiredAsUtc;
  }
  const verified = zonedParts(candidate, timeZone);
  if (
    verified.year !== year
    || verified.month !== month
    || verified.day !== day
    || verified.hour !== hour
    || verified.minute !== minute
  ) {
    throw new Error(`Could not resolve ${localDate} ${hour}:${minute} in ${timeZone}`);
  }
  return candidate;
}

function localDateAt(epochMs: number, timeZone: string): string {
  const parts = zonedParts(epochMs, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}


export function marketOpenScheduleForDate(
  region: MarketOpenRegion,
  localDate: string,
): MarketOpenSchedule {
  const definition = SESSION_DEFINITIONS[region];
  const { year, month, day } = parseLocalDate(localDate);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  const calendarCovered = calendarYearCovered(year);
  const holiday = calendarCovered && EXCHANGE_HOLIDAYS[region].has(localDate);
  const openAt = zonedDateTimeToEpoch(
    localDate,
    definition.openHour,
    definition.openMinute,
    definition.timeZone,
  );
  return {
    region,
    label: definition.label,
    timeZone: definition.timeZone,
    localDate,
    key: `${region}:${localDate}`,
    reportAt: openAt - REPORT_LEAD_MS,
    openAt,
    isTradingDay: !weekend && !holiday,
    closedReason: weekend ? "weekend" : holiday ? "holiday" : null,
    calendarCovered,
  };
}

export function dueMarketOpenSessions(
  now: number,
  graceMs = MARKET_OPEN_OI_DUE_GRACE_MS,
): MarketOpenSchedule[] {
  if (!Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs <= 0) return [];
  return (Object.keys(SESSION_DEFINITIONS) as MarketOpenRegion[])
    .map((region) => {
      const definition = SESSION_DEFINITIONS[region];
      return marketOpenScheduleForDate(region, localDateAt(now, definition.timeZone));
    })
    .filter((schedule) => schedule.isTradingDay
      && now >= schedule.reportAt
      && now < schedule.reportAt + graceMs)
    .sort((left, right) => left.reportAt - right.reportAt);
}

export function recentMarketOpenSchedules(
  now: number,
  tradingDaysPerRegion: number,
  matureAfterMs = 24 * 60 * 60_000,
): MarketOpenSchedule[] {
  if (
    !Number.isFinite(now)
    || !Number.isInteger(tradingDaysPerRegion)
    || tradingDaysPerRegion <= 0
    || !Number.isFinite(matureAfterMs)
    || matureAfterMs < 0
  ) return [];
  const regions = Object.keys(SESSION_DEFINITIONS) as MarketOpenRegion[];
  const counts = new Map(regions.map((region) => [region, 0]));
  const seen = new Set<string>();
  const schedules: MarketOpenSchedule[] = [];
  const maxLookbackDays = tradingDaysPerRegion * 10 + 370;

  for (let offset = 1; offset <= maxLookbackDays; offset += 1) {
    const cursor = now - offset * 24 * 60 * 60_000;
    for (const region of regions) {
      if ((counts.get(region) ?? 0) >= tradingDaysPerRegion) continue;
      const definition = SESSION_DEFINITIONS[region];
      const localDate = localDateAt(cursor, definition.timeZone);
      const key = `${region}:${localDate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const schedule = marketOpenScheduleForDate(region, localDate);
      if (!schedule.isTradingDay || schedule.openAt + matureAfterMs > now) continue;
      schedules.push(schedule);
      counts.set(region, (counts.get(region) ?? 0) + 1);
    }
    if (regions.every((region) => (counts.get(region) ?? 0) >= tradingDaysPerRegion)) break;
  }

  return schedules.sort((left, right) => left.openAt - right.openAt || left.region.localeCompare(right.region));
}
