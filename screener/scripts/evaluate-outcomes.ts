// Standalone outcome-evaluator for persisted signal_events rows.
//
// Reads current mark prices from Hyperliquid, joins against pending rows
// in Supabase, and fills in pnl_1h/4h/24h columns where the fire is old
// enough. Designed to be run from cron — e.g. every 15 minutes:
//
//   SLASH/15 * * * * cd /home/muffinman/asset_screener/screener && \
//     npx tsx scripts/evaluate-outcomes.ts >> /var/log/screener-outcomes.log 2>&1
//
// (replace `SLASH/15` with the actual cron spelling — can't write it in
// this JSDoc-adjacent comment because the `*SLASH` sequence terminates
// block comments in TS).
//
// Exits 0 on success (including "nothing to do"), non-zero on config error.
// Individual DB failures are logged but not fatal — we want the cron to
// keep running through a transient Supabase outage.

import { evaluateSignalOutcomes } from "../src/lib/signalPersistence";
import { getMetaAndCtxs } from "../src/lib/hyperliquid";
import { isSupabaseEnabled } from "../src/lib/supabase";

async function main() {
  if (!isSupabaseEnabled()) {
    console.error(
      "Supabase not configured (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Nothing to do."
    );
    process.exit(2);
  }

  const { meta, assetCtxs } = await getMetaAndCtxs();
  const prices = new Map<string, number>();
  for (let i = 0; i < meta.universe.length; i++) {
    const px = parseFloat(assetCtxs[i].markPx || "0");
    if (px > 0) prices.set(meta.universe[i].name, px);
  }

  const result = await evaluateSignalOutcomes(prices);
  console.log(
    `[evaluate-outcomes] scanned=${result.scanned} updated=${result.updated} at ${new Date().toISOString()}`
  );
}

main().catch((err) => {
  console.error("[evaluate-outcomes] fatal:", err);
  process.exit(1);
});
