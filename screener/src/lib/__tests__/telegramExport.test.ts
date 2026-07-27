import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseTelegramExport,
  parseTelegramMessage,
  toBackfilledTelegramAlert,
  type TelegramExportMessage,
} from "../telegramExport";

const alertText = [
  "🟢 <b>STRONG BUY</b> · LONG · score <code>4.20</code>",
  "<b>BTC</b> · <i>crypto</i> · @ <code>$100,000</code>",
  "",
  "<b>[ TRADE CARD ]</b>",
  "entry: <code>$100,000</code>  ·  ATR(14·4h): 2.00%",
  "stop:  <code>$97,000</code>  (3.00% · 1.5× ATR)",
  "target: <code>$109,000</code>  (3R)",
].join("\n");

test("parseTelegramMessage extracts the current alert format from string text", () => {
  const parsed = parseTelegramMessage({
    id: 42,
    type: "message",
    date: "2026-07-21T12:34:56Z",
    text: alertText,
  });

  assert.deepEqual(parsed, {
    messageId: 42,
    date: "2026-07-21T12:34:56Z",
    timestamp: Date.parse("2026-07-21T12:34:56Z"),
    normalizedDate: "2026-07-21T12:34:56.000Z",
    timestampSource: "date",
    symbol: "BTC",
    direction: "LONG",
    entry: 100000,
    stop: 97000,
    target: 109000,
    score: 4.2,
    label: "STRONG BUY",
  });
});

test("parseTelegramMessage joins Telegram entity-array text before parsing", () => {
  const message: TelegramExportMessage = {
    id: "43",
    type: "message",
    date: "2026-07-21T12:35:00+00:00",
    text: [
      { type: "bold", text: "🟢 STRONG SELL" },
      { type: "plain", text: " · SHORT · score " },
      { type: "code", text: "-4.50" },
      { type: "plain", text: "\n" },
      { type: "bold", text: "ETH" },
      { type: "plain", text: " · @ $2,500\nentry: $2,500\nstop: $2,575\ntarget: $2,275" },
    ],
  };

  assert.deepEqual(parseTelegramMessage(message), {
    messageId: 43,
    date: "2026-07-21T12:35:00+00:00",
    timestamp: Date.parse("2026-07-21T12:35:00+00:00"),
    normalizedDate: "2026-07-21T12:35:00.000Z",
    timestampSource: "date",
    symbol: "ETH",
    direction: "SHORT",
    entry: 2500,
    stop: 2575,
    target: 2275,
    score: -4.5,
    label: "STRONG SELL",
  });
});

test("parseTelegramExport reports skipped messages without inventing missing fields", () => {
  const result = parseTelegramExport({
    name: "alerts",
    messages: [
      { id: 1, type: "service", date: "2026-07-21T00:00:00Z", text: "joined" },
      { id: 2, type: "message", date: "2026-07-21T00:01:00Z", text: "LONG BTC score 4" },
      { id: 3, type: "message", date: "2026-07-21T00:02:00Z", text: alertText },
    ],
  });

  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].messageId, 3);
  assert.deepEqual(result.skipped, [
    { messageId: 1, reason: "not a user message" },
    { messageId: 2, reason: "missing or invalid alert fields" },
  ]);
});

test("parseTelegramMessage prefers date_unixtime and retains normalized timestamp source", () => {
  const parsed = parseTelegramMessage({
    id: 44,
    type: "message",
    date: "2026-07-21T12:35:00-04:00",
    date_unixtime: "1784637300",
    text: alertText,
  });
  assert.ok(parsed);
  assert.equal(parsed.timestamp, 1784637300000);
  assert.equal(parsed.normalizedDate, "2026-07-21T12:35:00.000Z");
  assert.equal(parsed.timestampSource, "date_unixtime");
});

test("parseTelegramMessage rejects ambiguous zone-less dates unless an offset is supplied", () => {
  const message = { id: 45, type: "message", date: "2026-07-21T12:34:56", text: alertText };
  assert.equal(parseTelegramMessage(message), null);
  const parsed = parseTelegramMessage(message, { defaultOffsetMinutes: -240 });
  assert.ok(parsed);
  assert.equal(parsed.timestamp, Date.parse("2026-07-21T12:34:56-04:00"));
  assert.equal(parsed.timestampSource, "date+default-offset");
});

test("parseTelegramExport gives invalid prices and geometry a distinct skip reason", () => {
  const result = parseTelegramExport({
    messages: [
      { id: 46, type: "message", date: "2026-07-21T00:00:00Z", text: alertText.replace("$97,000", "$0") },
      { id: 47, type: "message", date: "2026-07-21T00:00:00Z", text: alertText.replace("$109,000", "$98,000") },
    ],
  });
  assert.equal(result.alerts.length, 0);
  assert.deepEqual(result.skipped, [
    { messageId: 46, reason: "invalid prices or direction geometry" },
    { messageId: 47, reason: "invalid prices or direction geometry" },
  ]);
});

test("parsed export alerts map to idempotent delivered ledger rows", () => {
  const parsed = parseTelegramMessage({ id: 42, type: "message", date: "2026-07-21T12:34:56Z", text: alertText });
  assert.ok(parsed);
  const row = toBackfilledTelegramAlert(parsed);
  assert.equal(row.delivery_status, "delivered");
  assert.equal(row.telegram_message_id, "42");
  assert.equal(row.direction, "long");
  assert.equal(row.entry_price, 100000);
  assert.equal(row.stop_price, 97000);
  assert.equal(row.target_price, 109000);
  assert.equal(row.outcome_status, "open");
  assert.equal(row.expires_at, parsed.timestamp + 48 * 60 * 60 * 1000);
  assert.equal(row.outcome_provenance, "telegram_export_backfill");
  assert.equal(row.outcome_note, "Backfilled from Telegram export; outcome not yet evaluated.");
  assert.match(row.conviction_json ?? "", /telegram_export_backfill/);
});
