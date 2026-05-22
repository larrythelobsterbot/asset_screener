// One-shot helper to render a sample Telegram alert with a trade card,
// without touching the live signal scan or cooldown state. Useful when
// you've changed the alert body format and want to eyeball the result
// before a real signal happens to fire.
//
// Usage:
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npx tsx scripts/test-alert.ts
//
// Sends ONE message to the configured chat using a synthesized Strong Buy
// signal set (BTC, 4h breakout + volume + sector RS). All other state is
// untouched — cooldowns, SQLite, scan caches.

import "../src/lib/db"; // boot the DB so kvGet/kvSet don't crash on cold start
import { maybeDispatchAlerts, type TradeContext } from "../src/lib/alerter";
import type { Signal } from "../src/lib/signals";

const symbol = process.argv[2] ?? "BTC";
const direction = (process.argv[3] ?? "bullish") as "bullish" | "bearish";
const price = parseFloat(process.argv[4] ?? "76800");
const atrPct = parseFloat(process.argv[5] ?? "2.5");

// Synthesize a Strong Buy / Strong Sell confluence — three families,
// multi-TF aligned, vol regime != "quiet" so it clears the alerter gate.
const now = Date.now();
const dirSign = direction === "bullish" ? 1 : -1;
const signals: Signal[] = [
  {
    symbol,
    type: "breakout_up",
    direction,
    value: price * 1.01 * dirSign,
    strength: 75,
    label: `[TEST] ${direction === "bullish" ? "Breakout above 20-bar high" : "Breakdown below 20-bar low"}`,
    family: "trend",
    timeframe: "4h",
    volRegime: "normal",
    firedAt: now,
  },
  {
    symbol,
    type: "volume_spike",
    direction,
    value: 3.2,
    strength: 80,
    label: "[TEST] Volume 3.2× 30-bar average",
    family: "volume",
    timeframe: "4h",
    volRegime: "normal",
    firedAt: now,
  },
  {
    symbol,
    type: direction === "bullish" ? "sector_leader" : "sector_laggard",
    direction,
    value: 2.8,
    strength: 65,
    label: `[TEST] Sector ${direction === "bullish" ? "leader" : "laggard"} (z=2.8)`,
    family: "structure",
    timeframe: "4h",
    volRegime: "normal",
    firedAt: now,
  },
];

const priceBySymbol = new Map<string, number>([[symbol, price]]);
const tradeCtxBySymbol = new Map<string, TradeContext>([
  [symbol, { atrPct, fundingHourly: 0.00012 }],   // +105% funding APR — long headwind
]);

// Clear any existing cooldown for this symbol so the test always fires.
import { kvSet } from "../src/lib/db";
kvSet(`tg_alert:${symbol}:${direction}`, "0");

console.log(`firing test alert: ${direction.toUpperCase()} ${symbol} @ $${price} · ATR ${atrPct}%`);
maybeDispatchAlerts(signals, priceBySymbol, tradeCtxBySymbol)
  .then((r) => {
    console.log("result:", r);
    if (r.fired === 0) {
      console.warn("⚠ no alert sent. check that conviction cleared 3.5 and TELEGRAM_* env is set.");
    }
    process.exit(r.fired > 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("send failed:", e);
    process.exit(1);
  });
