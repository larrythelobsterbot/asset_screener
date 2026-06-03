// Standalone end-to-end check for the Phase 2 derivs path. Hits the live
// Coinalyze API + a TEMP SQLite (no Next.js, so it can't touch the prod
// .next build). Run: SCREENER_DB_PATH=/tmp/x.db tsx scripts/verify-coinalyze.ts
import { getDerivsForCoins, isCoinalyzeConfigured } from "../src/lib/coinalyze";
import { insertDerivsSnapshots, latestDerivsSnapshots, derivsSnapshotAt, type DerivsRow } from "../src/lib/db";
import { classifyRegime } from "../src/lib/coinalyzePoller";

async function main() {
  console.log("configured:", isCoinalyzeConfigured());
  if (!isCoinalyzeConfigured()) { console.error("no key in env"); process.exit(1); }

  const bases = ["BTC", "ETH", "SOL", "HYPE", "DOGE"];
  console.log("fetching derivs for", bases.join(", "), "…");
  const derivs = await getDerivsForCoins(bases);
  console.log(`got ${derivs.length} coins`);
  for (const d of derivs) {
    console.log(
      `  ${d.base.padEnd(5)} OI=$${(d.oiUsd / 1e9).toFixed(2)}B (HL $${((d.oiHlUsd ?? 0) / 1e9).toFixed(2)}B, ${d.venues} venues)` +
      ` fundHL=${d.fundingHl != null ? (d.fundingHl * 100).toFixed(4) + "%" : "n/a"}` +
      ` liqL=$${(d.liqLongUsd / 1e6).toFixed(2)}M liqS=$${(d.liqShortUsd / 1e6).toFixed(2)}M`
    );
  }

  // Persist a "prior" snapshot (simulate 15m ago with lower OI) then a "now"
  // snapshot, to exercise delta + regime + DAL round-trip.
  const now = Date.now();
  const prior: DerivsRow[] = derivs.map((d) => ({
    base: d.base, ts: now - 15 * 60_000,
    oi_usd: d.oiUsd * 0.98, oi_hl_usd: d.oiHlUsd, funding_hl: d.fundingHl,
    liq_long_usd: 0, liq_short_usd: 0, oi_delta_pct: null,
    price: 100, price_delta_pct: null, regime: "flat", venues: d.venues,
  }));
  insertDerivsSnapshots(prior);

  const cur: DerivsRow[] = derivs.map((d) => {
    const p = derivsSnapshotAt(d.base, now);
    const oiDelta = p && p.oi_usd > 0 ? ((d.oiUsd - p.oi_usd) / p.oi_usd) * 100 : null;
    const pxDelta = 0.5; // pretend price +0.5%
    return {
      base: d.base, ts: now, oi_usd: d.oiUsd, oi_hl_usd: d.oiHlUsd, funding_hl: d.fundingHl,
      liq_long_usd: d.liqLongUsd, liq_short_usd: d.liqShortUsd,
      oi_delta_pct: oiDelta, price: 100.5, price_delta_pct: pxDelta,
      regime: classifyRegime(oiDelta, pxDelta), venues: d.venues,
    };
  });
  insertDerivsSnapshots(cur);

  console.log("\nlatestDerivsSnapshots() round-trip:");
  for (const r of latestDerivsSnapshots()) {
    console.log(`  ${r.base.padEnd(5)} ΔOI=${r.oi_delta_pct?.toFixed(2)}% px=${r.price_delta_pct}% -> ${r.regime}`);
  }
  console.log("\nOK");
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
