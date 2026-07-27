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
//   /api/signals → TA scan persistence + Telegram alerts, independent of
//                  whether a browser currently has the screener open.
//   /api/alert-outcomes/evaluate → independent durable-alert TP/SL evaluator;
//                  not coupled to success of the expensive TA scan.
//   /api/market-open-oi/run → DST/calendar-aware market-open OI briefing
//                  scheduler plus its independent outcome tracker.
//   /api/hype/pressure and /api/btc/binary → recurring bootstrap requests
//                  that start their idempotent background pollers and retry
//                  automatically after any transient startup failure.
// The pings repeat every 60s, which doubles as the keepalive that keeps
// snapshots flowing with zero visitors.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const origin = process.env.SCREENER_SELF_ORIGIN ?? "http://127.0.0.1:3003";
  const capabilityGlobal = globalThis as typeof globalThis & {
    __assetScreenerAlertOutcomeCapability?: string;
  };
  const alertOutcomeCapability = capabilityGlobal.__assetScreenerAlertOutcomeCapability
    ?? globalThis.crypto.randomUUID();
  capabilityGlobal.__assetScreenerAlertOutcomeCapability = alertOutcomeCapability;
  const pingCore = () => {
    fetch(`${origin}/api/markets`, { cache: "no-store" }).catch(() => {});
    fetch(`${origin}/api/feed?limit=1`, { cache: "no-store" }).catch(() => {});
    fetch(`${origin}/api/social/trending?tf=24h`, { cache: "no-store" }).catch(() => {});
    fetch(`${origin}/api/social/momentum`, { cache: "no-store" }).catch(() => {});
  };
  const pingSignals = () => {
    fetch(`${origin}/api/signals`, { cache: "no-store" }).catch(() => {});
  };
  const pingAlertOutcomes = () => {
    fetch(`${origin}/api/alert-outcomes/evaluate`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "X-Asset-Screener-Outcome-Capability": alertOutcomeCapability,
      },
    }).catch(() => {});
  };
  const pingMarketOpenOi = () => {
    fetch(`${origin}/api/market-open-oi/run`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "X-Asset-Screener-Outcome-Capability": alertOutcomeCapability,
      },
    }).catch(() => {});
  };
  const bootstrapPollers = () => {
    fetch(`${origin}/api/hype/pressure`, { cache: "no-store" }).catch(() => {});
    fetch(`${origin}/api/btc/binary`, { cache: "no-store" }).catch(() => {});
  };
  const pingRuntime = () => {
    pingCore();
    bootstrapPollers();
  };

  // Delay the first ping so `next start` has bound the port before we
  // call ourselves; transient failures self-heal on the next tick.
  const coreBootstrapTimer = setTimeout(() => {
    pingRuntime();
    const coreTimer = setInterval(pingRuntime, 60_000);
    if (typeof coreTimer.unref === "function") coreTimer.unref();
    console.info("[instrumentation] keepalive started (markets+feed+social+HYPE+BTC @60s)");
  }, 10_000);
  if (typeof coreBootstrapTimer.unref === "function") coreBootstrapTimer.unref();

  // Stagger the expensive 160-call TA scan away from the core refresh so
  // it does not contend with the initial markets/Elfa requests at boot.
  const signalBootstrapTimer = setTimeout(() => {
    pingSignals();
    const signalTimer = setInterval(pingSignals, 60_000);
    if (typeof signalTimer.unref === "function") signalTimer.unref();
    console.info("[instrumentation] signal scan keepalive started (@60s)");
  }, 30_000);
  if (typeof signalBootstrapTimer.unref === "function") signalBootstrapTimer.unref();

  const alertOutcomeBootstrapTimer = setTimeout(() => {
    pingAlertOutcomes();
    const outcomeTimer = setInterval(pingAlertOutcomes, 60_000);
    if (typeof outcomeTimer.unref === "function") outcomeTimer.unref();
    console.info("[instrumentation] alert outcome evaluator keepalive started (@60s)");
  }, 45_000);
  if (typeof alertOutcomeBootstrapTimer.unref === "function") alertOutcomeBootstrapTimer.unref();

  const marketOpenOiBootstrapTimer = setTimeout(() => {
    pingMarketOpenOi();
    const marketOpenOiTimer = setInterval(pingMarketOpenOi, 60_000);
    if (typeof marketOpenOiTimer.unref === "function") marketOpenOiTimer.unref();
    console.info("[instrumentation] market-open OI scheduler keepalive started (@60s)");
  }, 55_000);
  if (typeof marketOpenOiBootstrapTimer.unref === "function") marketOpenOiBootstrapTimer.unref();
}
