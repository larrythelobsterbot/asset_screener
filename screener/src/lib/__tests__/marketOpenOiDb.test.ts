import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listMarketOpenOiItems,
  listMarketOpenOiReports,
  listPendingMarketOpenOiReports,
  markMarketOpenOiDelivered,
  markMarketOpenOiDeliveryAttempted,
  reserveMarketOpenOiReport,
  summarizeMarketOpenOiReports,
  upsertMarketOpenOiOutcome,
  type NewMarketOpenOiItem,
  type NewMarketOpenOiReport,
} from "../db";

function report(key: string, at: number): NewMarketOpenOiReport {
  const [region, local_date] = key.split(":") as ["asia" | "europe" | "us", string];
  return {
    report_key: key,
    region,
    local_date,
    report_at: at,
    open_at: at + 30 * 60_000,
    generated_at: at,
    lookback_ms: 4 * 60 * 60_000,
    calendar_covered: 1,
    selection_config_json: "{}",
    message_body: `OI report ${key}`,
  };
}

function item(symbol: string, rank: number, currentOi = 120): NewMarketOpenOiItem {
  return {
    rank,
    symbol,
    sector: "majors",
    universe: "crypto",
    current_ts: 20_000,
    prior_ts: 10_000,
    current_mark: 100,
    prior_mark: 100,
    current_oi_coins: currentOi,
    prior_oi_coins: 100,
    current_oi_usd: currentOi * 100,
    prior_oi_usd: 10_000,
    oi_quantity_delta_usd: (currentOi - 100) * 100,
    oi_usd_delta: (currentOi - 100) * 100,
    oi_coins_change_pct: currentOi - 100,
    price_change_pct: 0,
    funding_hourly: 0,
    funding_apr: 0,
    volume_24h: 10_000_000,
    quadrant: currentOi >= 100 ? "expanding_flat" : "contracting_flat",
    smart_flow_delta_usd: null,
    smart_flow_alignment: "unknown",
  };
}

test("market-open OI report reservation is idempotent and delivery facts are durable", () => {
  const at = Date.now() + 700_000_000;
  const input = report("asia:2099-04-01", at);
  const first = reserveMarketOpenOiReport(input, [item("BTC", 1), item("ETH", 2)]);
  assert.equal(first.kind, "inserted");
  const duplicate = reserveMarketOpenOiReport(input, [item("BTC", 1), item("ETH", 2)]);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(markMarketOpenOiDeliveryAttempted(first.id, at + 1), true);
  assert.equal(markMarketOpenOiDelivered(first.id, "12345", at + 2), true);
  const persisted = listMarketOpenOiReports({ key: input.report_key })[0];
  assert.equal(persisted.delivery_status, "delivered");
  assert.equal(persisted.telegram_message_id, "12345");
  assert.equal(listMarketOpenOiItems(persisted.id).length, 2);
});

test("shadow evidence stays out of delivery recovery and accepts a complete unwind", () => {
  const at = Date.now() + 800_000_000;
  const input = report("us:2099-04-02", at);
  const reserved = reserveMarketOpenOiReport(input, [item("UNWIND", 1, 0), item("BTC", 2)], "shadow");
  assert.equal(reserved.kind, "inserted");
  const persisted = listMarketOpenOiReports({ key: input.report_key })[0];
  assert.equal(persisted.delivery_status, "shadow");
  assert.equal(listPendingMarketOpenOiReports(100).some((row) => row.id === persisted.id), false);
  assert.ok(summarizeMarketOpenOiReports().shadow >= 1);
  const unwind = listMarketOpenOiItems(persisted.id).find((row) => row.symbol === "UNWIND");
  assert.equal(unwind?.current_oi_coins, 0);
  assert.equal(upsertMarketOpenOiOutcome({
    item_id: unwind!.id,
    horizon: "open",
    target_at: input.open_at,
    status: "observed",
    snapshot_at: input.open_at,
    mark: 100,
    return_pct: null,
    observed_at: input.open_at + 1,
    note: null,
  }), true);
});
