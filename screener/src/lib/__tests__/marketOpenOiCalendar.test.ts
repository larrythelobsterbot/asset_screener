import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dueMarketOpenSessions,
  marketOpenCalendarCoverageAt,
  marketOpenScheduleForDate,
  recentMarketOpenSchedules,
} from "../marketOpenOiCalendar";

test("computes Tokyo report/open instants across the UTC date boundary", () => {
  const schedule = marketOpenScheduleForDate("asia", "2026-07-27");
  assert.equal(schedule.openAt, Date.parse("2026-07-27T00:00:00.000Z"));
  assert.equal(schedule.reportAt, Date.parse("2026-07-26T23:30:00.000Z"));
  assert.equal(schedule.key, "asia:2026-07-27");
  assert.equal(schedule.isTradingDay, true);
});

test("applies London and New York daylight saving time", () => {
  const londonSummer = marketOpenScheduleForDate("europe", "2026-07-27");
  const londonWinter = marketOpenScheduleForDate("europe", "2026-12-01");
  const newYorkSummer = marketOpenScheduleForDate("us", "2026-07-27");
  const newYorkWinter = marketOpenScheduleForDate("us", "2026-12-01");

  assert.equal(londonSummer.openAt, Date.parse("2026-07-27T07:00:00.000Z"));
  assert.equal(londonSummer.reportAt, Date.parse("2026-07-27T06:30:00.000Z"));
  assert.equal(londonWinter.openAt, Date.parse("2026-12-01T08:00:00.000Z"));
  assert.equal(londonWinter.reportAt, Date.parse("2026-12-01T07:30:00.000Z"));
  assert.equal(newYorkSummer.openAt, Date.parse("2026-07-27T13:30:00.000Z"));
  assert.equal(newYorkSummer.reportAt, Date.parse("2026-07-27T13:00:00.000Z"));
  assert.equal(newYorkWinter.openAt, Date.parse("2026-12-01T14:30:00.000Z"));
  assert.equal(newYorkWinter.reportAt, Date.parse("2026-12-01T14:00:00.000Z"));
});

test("suppresses weekends and exchange holidays", () => {
  const weekend = marketOpenScheduleForDate("europe", "2026-07-26");
  const thanksgiving = marketOpenScheduleForDate("us", "2026-11-26");
  const tokyoHoliday = marketOpenScheduleForDate("asia", "2026-09-22");

  assert.deepEqual([weekend.isTradingDay, weekend.closedReason], [false, "weekend"]);
  assert.deepEqual([thanksgiving.isTradingDay, thanksgiving.closedReason], [false, "holiday"]);
  assert.deepEqual([tokyoHoliday.isTradingDay, tokyoHoliday.closedReason], [false, "holiday"]);
});

test("due-window is bounded and retains a stable local-date idempotency key", () => {
  const dueAt = Date.parse("2026-07-27T13:05:00.000Z");
  assert.deepEqual(dueMarketOpenSessions(dueAt).map((session) => session.key), ["us:2026-07-27"]);
  assert.deepEqual(dueMarketOpenSessions(Date.parse("2026-07-27T13:11:00.000Z")), []);
});

test("future uncovered holiday years remain weekday-operable but disclose missing coverage", () => {
  const schedule = marketOpenScheduleForDate("us", "2028-07-03");
  assert.equal(schedule.isTradingDay, true);
  assert.equal(schedule.calendarCovered, false);
});

test("calendar health exposes region-local coverage years", () => {
  const covered = marketOpenCalendarCoverageAt(Date.parse("2026-12-31T23:30:00Z"));
  assert.deepEqual(covered.asia, { localYear: 2027, covered: true });
  assert.deepEqual(covered.europe, { localYear: 2026, covered: true });

  const uncovered = marketOpenCalendarCoverageAt(Date.parse("2028-06-01T12:00:00Z"));
  assert.equal(uncovered.asia.covered, false);
  assert.equal(uncovered.europe.covered, false);
  assert.equal(uncovered.us.covered, false);
});

test("historical windows return exactly N mature trading days per region", () => {
  const now = Date.parse("2026-07-28T20:00:00Z");
  const schedules = recentMarketOpenSchedules(now, 2);
  assert.equal(schedules.length, 6);
  for (const region of ["asia", "europe", "us"] as const) {
    const regional = schedules.filter((schedule) => schedule.region === region);
    assert.equal(regional.length, 2);
    assert.deepEqual(regional.map((schedule) => schedule.localDate), ["2026-07-24", "2026-07-27"]);
  }
  assert.ok(schedules.every((schedule) => schedule.openAt + 24 * 60 * 60_000 <= now));
});
