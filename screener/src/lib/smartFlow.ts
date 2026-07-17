import type { SmartFlowPoint } from "@/lib/db";

// Response item for /api/smart-flow — exported for the terminal-panel task
// (task 5) to import against.
export interface SmartFlowCoin {
  coin: string;
  longUsd: number;
  shortUsd: number;
  netUsd: number;
  wallets: number;
  netDelta1h: number | null;
  netDelta24h: number | null;
  crowdOiChange24hPct: number | null;
  diverging: boolean;
}

const MIN_GROSS_USD = 50_000;
const DIVERGENCE_MIN_ABS_USD = 250_000;

// Null-vs-zero semantics for a historical lookup: smartFlowAt returns an
// EMPTY map when the poller has no rows at all inside that window (too
// young / a gap) — in that case we genuinely don't know the cohort's prior
// state, so the delta must be null, not zero (a null renders as "warming
// up" in the UI; a zero would falsely claim "no change"). A NON-EMPTY map
// that simply lacks an entry for this particular coin means the cohort
// definitely had data at that point and held nothing in this coin — that
// prior value is a genuine 0.
function priorNet(map: Map<string, SmartFlowPoint>, coin: string): number | null {
  if (map.size === 0) return null;
  return map.get(coin)?.netUsd ?? 0;
}

function sign(n: number): -1 | 0 | 1 {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

// Pure derivation of the /api/smart-flow response body from three
// point-in-time cohort snapshots (now, -1h, -24h) plus the crowd's cached
// OI-change figures. Kept side-effect-free (no DB, no cache reads) so the
// null-vs-zero delta semantics and the divergence gate are unit-testable
// without a real DB — see src/lib/__tests__/smartFlow.test.ts. The route
// (src/app/api/smart-flow/route.ts) is a thin shell around this.
export function computeSmartFlowRows(
  nowMap: Map<string, SmartFlowPoint>,
  map1h: Map<string, SmartFlowPoint>,
  map24h: Map<string, SmartFlowPoint>,
  crowdBySymbol: Map<string, number | null>
): SmartFlowCoin[] {
  const rows: SmartFlowCoin[] = [];

  for (const [coin, point] of nowMap) {
    // smartFlowAt already excludes coin='' heartbeat rows (a flat wallet's
    // heartbeat batch contributes to no coin — see its own comment in
    // db.ts). Assert rather than assume: a heartbeat leaking through here
    // would corrupt the gross-exposure filter below.
    if (coin === "") continue;

    const gross = point.longUsd + point.shortUsd;
    if (gross <= MIN_GROSS_USD) continue;

    const prior1h = priorNet(map1h, coin);
    const netDelta1h = prior1h === null ? null : point.netUsd - prior1h;

    const prior24h = priorNet(map24h, coin);
    const netDelta24h = prior24h === null ? null : point.netUsd - prior24h;

    const crowdOiChange24hPct = crowdBySymbol.get(coin) ?? null;

    // diverging: the sharp cohort's 24h net move points the opposite way
    // from the crowd's 24h OI change, and the cohort's move is large
    // enough to not be noise. This IS the product — the divergence read
    // between the sharp cohort and the crowd.
    const diverging =
      netDelta24h !== null &&
      crowdOiChange24hPct !== null &&
      sign(netDelta24h) !== sign(crowdOiChange24hPct) &&
      Math.abs(netDelta24h) > DIVERGENCE_MIN_ABS_USD;

    rows.push({
      coin,
      longUsd: point.longUsd,
      shortUsd: point.shortUsd,
      netUsd: point.netUsd,
      wallets: point.wallets,
      netDelta1h,
      netDelta24h,
      crowdOiChange24hPct,
      diverging,
    });
  }

  // Sort by |netDelta24h| desc, nulls last.
  rows.sort((a, b) => {
    if (a.netDelta24h === null && b.netDelta24h === null) return 0;
    if (a.netDelta24h === null) return 1;
    if (b.netDelta24h === null) return -1;
    return Math.abs(b.netDelta24h) - Math.abs(a.netDelta24h);
  });

  return rows;
}
