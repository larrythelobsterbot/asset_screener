// Server-boot hook (Next instrumentation). Makes the terminal "always on".
//
// Before this existed, every background job (HL WS, Tree News, snapshot
// persistence, prune) booted lazily from whichever API route first
// imported it — so after a PM2 restart the whole data layer slept until a
// human visited the site (observed: 6 days of dead feed).
//
// Implementation note: this file is deliberately import-free. Next bundles
// instrumentation for the edge runtime too, where node builtins and native
// modules (better-sqlite3) can't resolve — importing lib/db here breaks the
// build. Instead we self-ping the routes that already lazy-boot everything:
//   /api/markets → HL WS + prune job + price_snapshots persistence
//                  (the OI/funding time series the derivs radar reads)
//   /api/feed    → Tree News websocket + REST backfill poller
//   /api/social/trending → Elfa mindshare snapshot persistence. The
//                  route's own 1h cache means 60s pings cost exactly
//                  1 Elfa credit/hour (~24/day of the 950 soft cap) —
//                  this is what builds the hourly history the attention
//                  radar's acceleration baseline needs.
//   /api/social/momentum → attention-radar recompute (SQLite-only, zero
//                  credits) + its signal persistence and Telegram
//                  alerts, so divergences fire with zero visitors.
// The pings repeat every 60s, which doubles as the keepalive that keeps
// snapshots flowing with zero visitors.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const origin = process.env.SCREENER_SELF_ORIGIN ?? "http://127.0.0.1:3003";
  const ping = () => {
    fetch(`${origin}/api/markets`, { cache: "no-store" }).catch(() => {});
    fetch(`${origin}/api/feed?limit=1`, { cache: "no-store" }).catch(() => {});
    fetch(`${origin}/api/social/trending?tf=24h`, { cache: "no-store" }).catch(() => {});
    fetch(`${origin}/api/social/momentum`, { cache: "no-store" }).catch(() => {});
  };

  // Delay the first ping so `next start` has bound the port before we
  // call ourselves; transient failures self-heal on the next tick.
  setTimeout(() => {
    ping();
    const t = setInterval(ping, 60_000);
    if (typeof t.unref === "function") t.unref();
    console.info("[instrumentation] keepalive started (markets+feed+social @60s)");
  }, 10_000);
}
