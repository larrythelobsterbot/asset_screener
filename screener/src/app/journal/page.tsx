"use client";

// Trade journal — table view of everything in the `trades` SQLite table.
//
// What this view is for:
//   1. See open trades at a glance (status: live, distance-to-stop visible)
//   2. Close trades inline with one click (uses live mid by default)
//   3. Get a quick read on whether the screener's edge is real:
//      win rate, expectancy R, total R since first trade.
//
// What it is NOT for: deep retros by family combination — that's the next
// page (/journal/retro). This one is the "what's on the book" view.
//
// Polling cadence: 30s — same as the screener. Trades don't change second-
// by-second; we just want fresh distance-to-stop numbers when a position
// is live.

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import type { TradeRow } from "@/lib/db";
import { AssetData } from "@/lib/types";

const POLL_MS = 30_000;

type StatusFilter = "all" | "open" | "closed";
type ModeFilter = "all" | "paper" | "live";

// ── Formatting helpers ──────────────────────────────────────────────────

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 100) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 1) return n.toFixed(3);
  if (abs >= 0.01) return n.toFixed(5);
  return n.toFixed(8);
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtR(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}R`;
}

function fmtTimeAgo(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

// Distance from current mid to the stop, as a percentage of stop_distance.
// 0% = at stop; 100% = at entry; 300% = at target. Lets you see at a
// glance how close to ruin/payout each open trade is.
function progress(t: TradeRow, mid: number | null): { pct: number; tone: "up" | "down" | "warn" | null } | null {
  if (mid == null) return null;
  const entry = t.entry_price;
  const stop = t.stop_price;
  const stopDist = Math.abs(entry - stop);
  if (stopDist <= 0) return null;
  // For a long: progress = (mid - stop) / stop_dist × 100
  // For a short: progress = (stop - mid) / stop_dist × 100
  // Either way: 0 = stopped, 100 = at entry, 300 = at target (3R).
  const pct = t.direction === "long"
    ? ((mid - stop) / stopDist) * 100
    : ((stop - mid) / stopDist) * 100;
  let tone: "up" | "down" | "warn" | null = null;
  if (pct >= 200) tone = "up";        // running toward target
  else if (pct >= 100) tone = "warn";  // above entry but not yet 2R
  else if (pct >= 50) tone = null;     // between stop and entry
  else if (pct < 50 && pct > 0) tone = "down"; // close to stop
  else if (pct <= 0) tone = "down";    // at/through stop
  return { pct, tone };
}

// ── Summary ─────────────────────────────────────────────────────────────

interface Summary {
  total: number;
  open: number;
  closed: number;
  winRate: number | null;     // % of CLOSED trades with pnl_r > 0
  expectancyR: number | null; // mean pnl_r across CLOSED trades
  totalR: number;             // sum of pnl_r across CLOSED trades
  bestR: number | null;
  worstR: number | null;
}

function computeSummary(trades: TradeRow[]): Summary {
  const closed = trades.filter((t) => t.ts_closed != null && t.pnl_r != null);
  const wins = closed.filter((t) => (t.pnl_r ?? 0) > 0);
  const rs = closed.map((t) => t.pnl_r ?? 0);
  return {
    total: trades.length,
    open: trades.filter((t) => t.ts_closed == null).length,
    closed: closed.length,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    expectancyR: closed.length > 0 ? rs.reduce((a, b) => a + b, 0) / closed.length : null,
    totalR: rs.reduce((a, b) => a + b, 0),
    bestR: closed.length > 0 ? Math.max(...rs) : null,
    worstR: closed.length > 0 ? Math.min(...rs) : null,
  };
}

// ── Page ────────────────────────────────────────────────────────────────

export default function JournalPage() {
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [symbolFilter, setSymbolFilter] = useState("");
  // Live mids — used for distance-to-stop progress on open trades.
  const [mids, setMids] = useState<Map<string, number>>(new Map());
  // Per-row close state — keyed by trade id. UI shows a spinner / error
  // inline without affecting the rest of the table.
  const [closing, setClosing] = useState<Map<number, "pending" | "err">>(new Map());
  const [closeErrors, setCloseErrors] = useState<Map<number, string>>(new Map());

  const fetchTrades = useCallback(() => {
    fetch("/api/trades?status=all&limit=500")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: { trades: TradeRow[] }) => {
        setTrades(j.trades);
        setLoading(false);
        setError(null);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  // Mids come from /api/markets — same source the heatmap uses.
  const fetchMids = useCallback(() => {
    fetch("/api/markets")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AssetData[] | null) => {
        if (!Array.isArray(data)) return;
        const m = new Map<string, number>();
        for (const a of data) if (a.price > 0) m.set(a.symbol, a.price);
        setMids(m);
      })
      .catch(() => { /* mids are nice-to-have; non-fatal */ });
  }, []);

  useEffect(() => {
    fetchTrades();
    fetchMids();
    const t = setInterval(() => {
      fetchTrades();
      fetchMids();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [fetchTrades, fetchMids]);

  // Inline close. Default exit_reason "manual" when triggered from UI —
  // the user is explicitly closing rather than the trade hitting a level.
  // exit_price omitted = server uses live mid.
  const closeTradeRow = useCallback(
    (id: number, exit_reason: "stop" | "target" | "manual" | "expired" = "manual") => {
      setClosing((m) => new Map(m).set(id, "pending"));
      setCloseErrors((m) => { const n = new Map(m); n.delete(id); return n; });
      fetch(`/api/trades/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exit_reason }),
      })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (ok) {
            // Local-update the row so we don't need to round-trip /api/trades
            // before the user sees the change.
            setTrades((arr) => arr.map((t) => (t.id === id ? (j as TradeRow) : t)));
            setClosing((m) => { const n = new Map(m); n.delete(id); return n; });
          } else {
            setClosing((m) => { const n = new Map(m); n.delete(id); return n; });
            setCloseErrors((m) => new Map(m).set(id, String(j.error ?? "close failed")));
          }
        })
        .catch((e) => {
          setClosing((m) => { const n = new Map(m); n.delete(id); return n; });
          setCloseErrors((m) => new Map(m).set(id, String(e)));
        });
    },
    []
  );

  const filtered = useMemo(() => {
    let xs = trades;
    if (statusFilter === "open") xs = xs.filter((t) => t.ts_closed == null);
    if (statusFilter === "closed") xs = xs.filter((t) => t.ts_closed != null);
    if (modeFilter !== "all") xs = xs.filter((t) => t.mode === modeFilter);
    if (symbolFilter.trim()) {
      const q = symbolFilter.trim().toUpperCase();
      xs = xs.filter((t) => t.symbol.includes(q));
    }
    return xs;
  }, [trades, statusFilter, modeFilter, symbolFilter]);

  // Summary is always computed off the FILTERED set so the numbers match
  // what's visible. Filtering to "open" → expectancyR will be null
  // (nothing closed), which is honest.
  const summary = useMemo(() => computeSummary(filtered), [filtered]);

  return (
    <main style={{ padding: "20px 24px 60px", minHeight: "100vh", background: "var(--bg)" }}>
      {/* Header */}
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18, gap: 16 }}>
        <div>
          <div className="br-label" style={{ fontSize: 11, color: "var(--text-mute)" }}>JOURNAL</div>
          <div style={{
            fontSize: 22, fontWeight: 600, color: "var(--text-strong)", marginTop: 2,
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          }}>
            Trade Journal
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/signals" style={{
            fontSize: 11, color: "var(--acc-up)", textDecoration: "none",
            padding: "6px 10px", borderRadius: "var(--radius)",
            border: ".5px solid color-mix(in oklab, var(--acc-up) 45%, transparent)",
          }}>◎ signal performance</Link>
          <Link href="/terminal" style={{
            fontSize: 11, color: "var(--acc-warn)", textDecoration: "none",
            padding: "6px 10px", borderRadius: "var(--radius)",
            border: ".5px solid color-mix(in oklab, var(--acc-warn) 45%, transparent)",
            background: "color-mix(in oklab, var(--acc-warn) 9%, transparent)",
          }}>⌗ terminal</Link>
          <Link href="/" style={{
            fontSize: 11, color: "var(--text-mute)", textDecoration: "none",
            padding: "6px 10px", border: ".5px solid var(--border)", borderRadius: "var(--radius)",
          }}>← screener</Link>
        </div>
      </header>

      {/* Summary tiles */}
      <section style={{
        display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 1,
        background: "var(--border-soft)", borderRadius: "var(--radius)",
        overflow: "hidden", marginBottom: 20,
      }}>
        <SummaryTile label="Total" value={String(summary.total)} />
        <SummaryTile label="Open" value={String(summary.open)} tone={summary.open > 0 ? "warn" : undefined} />
        <SummaryTile label="Closed" value={String(summary.closed)} />
        <SummaryTile
          label="Win Rate"
          value={summary.winRate == null ? "—" : `${summary.winRate.toFixed(0)}%`}
          tone={summary.winRate != null && summary.winRate >= 50 ? "up" : summary.winRate != null && summary.winRate < 35 ? "down" : undefined}
        />
        <SummaryTile
          label="Expectancy"
          value={fmtR(summary.expectancyR)}
          tone={summary.expectancyR != null && summary.expectancyR > 0 ? "up" : summary.expectancyR != null && summary.expectancyR < 0 ? "down" : undefined}
        />
        <SummaryTile
          label="Total R"
          value={fmtR(summary.totalR)}
          tone={summary.totalR > 0 ? "up" : summary.totalR < 0 ? "down" : undefined}
        />
      </section>

      {/* Filters */}
      <section style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <div className="seg">
          <button className={statusFilter === "all" ? "on" : ""} onClick={() => setStatusFilter("all")}>All</button>
          <button className={statusFilter === "open" ? "on" : ""} onClick={() => setStatusFilter("open")}>Open</button>
          <button className={statusFilter === "closed" ? "on" : ""} onClick={() => setStatusFilter("closed")}>Closed</button>
        </div>
        <div className="seg">
          <button className={modeFilter === "all" ? "on" : ""} onClick={() => setModeFilter("all")}>All modes</button>
          <button className={modeFilter === "paper" ? "on" : ""} onClick={() => setModeFilter("paper")}>Paper</button>
          <button className={modeFilter === "live" ? "on" : ""} onClick={() => setModeFilter("live")}>Live</button>
        </div>
        <input
          type="search"
          placeholder="filter by symbol…"
          value={symbolFilter}
          onChange={(e) => setSymbolFilter(e.target.value)}
          style={{
            background: "transparent", border: ".5px solid var(--border)", borderRadius: "var(--radius)",
            color: "var(--text)", padding: "6px 10px", fontSize: 11, width: 180,
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          }}
        />
        <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-mute)" }}>
          {filtered.length} / {trades.length} shown
        </div>
      </section>

      {/* Table */}
      <section style={{
        borderRadius: "var(--radius)", border: ".5px solid var(--border)",
        background: "var(--bg-card)", overflow: "hidden",
      }}>
        {loading && (
          <div style={{ padding: 60, textAlign: "center", color: "var(--text-mute)", fontSize: 11 }}>
            loading trades…
          </div>
        )}
        {error && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--acc-down)", fontSize: 11 }}>
            ✗ {error}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div style={{ padding: 60, textAlign: "center", color: "var(--text-mute)", fontSize: 11 }}>
            no trades match this filter. open an asset side-panel and click <b>LOG LONG</b> / <b>LOG SHORT</b> to start journaling.
          </div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <table style={{
            width: "100%", borderCollapse: "collapse", fontSize: 11,
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          }}>
            <thead>
              <tr style={{ borderBottom: ".5px solid var(--border)" }}>
                <Th>#</Th>
                <Th>Symbol</Th>
                <Th>Side</Th>
                <Th align="right">Entry</Th>
                <Th align="right">Stop</Th>
                <Th align="right">Target</Th>
                <Th align="right">Size</Th>
                <Th align="right">Risk</Th>
                <Th align="right">Live / Exit</Th>
                <Th align="right">Progress / R</Th>
                <Th>Opened</Th>
                <Th>Status</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const isOpen = t.ts_closed == null;
                const mid = mids.get(t.symbol) ?? null;
                const prog = isOpen ? progress(t, mid) : null;
                const closeState = closing.get(t.id);
                const closeErr = closeErrors.get(t.id);
                return (
                  <tr
                    key={t.id}
                    style={{
                      borderBottom: ".5px solid var(--border-soft)",
                      transition: "background .12s",
                    }}
                    onMouseOver={(e) => { e.currentTarget.style.background = "var(--bg-chip-h)"; }}
                    onMouseOut={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <Td muted>{t.id}</Td>
                    <Td><span className="sym">{t.symbol}</span></Td>
                    <Td>
                      <span className={t.direction === "long" ? "tone-up" : "tone-down"}>
                        {t.direction === "long" ? "▲ LONG" : "▼ SHORT"}
                      </span>
                    </Td>
                    <Td align="right">${fmtPrice(t.entry_price)}</Td>
                    <Td align="right" muted>${fmtPrice(t.stop_price)}</Td>
                    <Td align="right" muted>${fmtPrice(t.target_price)}</Td>
                    <Td align="right">{t.size < 1 ? t.size.toFixed(4) : t.size.toFixed(2)}</Td>
                    <Td align="right" muted>${t.risk_usd.toFixed(0)}</Td>
                    <Td align="right">
                      {isOpen
                        ? mid != null ? `$${fmtPrice(mid)}` : "—"
                        : `$${fmtPrice(t.exit_price)}`}
                    </Td>
                    <Td align="right">
                      {isOpen ? (
                        prog ? (
                          <span className={prog.tone ? `tone-${prog.tone}` : ""}>
                            {prog.pct.toFixed(0)}%
                          </span>
                        ) : "—"
                      ) : (
                        <span className={(t.pnl_r ?? 0) > 0 ? "tone-up" : "tone-down"}>
                          {fmtR(t.pnl_r)} <span style={{ color: "var(--text-mute)", marginLeft: 4 }}>{fmtUsd(t.pnl_usd)}</span>
                        </span>
                      )}
                    </Td>
                    <Td muted>{fmtTimeAgo(t.ts_opened)}</Td>
                    <Td>
                      {isOpen ? (
                        <span className="tone-warn" style={{ color: "var(--acc-warn)" }}>OPEN</span>
                      ) : (
                        <span style={{ color: "var(--text-mute)" }}>
                          {t.exit_reason?.toUpperCase()}
                        </span>
                      )}
                      {t.mode === "live" && <span style={{ marginLeft: 6, color: "var(--acc-warn)", fontSize: 9 }}>· LIVE</span>}
                    </Td>
                    <Td>
                      {isOpen && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <button
                            onClick={() => closeTradeRow(t.id, "manual")}
                            disabled={closeState === "pending"}
                            className="btn-ghost"
                            style={{ fontSize: 9, padding: "3px 8px" }}
                            title="Close at live mid · marks reason 'manual'"
                          >
                            {closeState === "pending" ? "…" : "CLOSE"}
                          </button>
                          {closeErr && (
                            <span style={{ fontSize: 9, color: "var(--acc-down)" }}>✗ {closeErr}</span>
                          )}
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Footer note */}
      <footer style={{ marginTop: 16, fontSize: 9, color: "var(--text-mute)", letterSpacing: ".06em" }}>
        polling every {POLL_MS / 1000}s · {summary.bestR != null && `best ${fmtR(summary.bestR)} · worst ${fmtR(summary.worstR)}`}
      </footer>
    </main>
  );
}

// ── Tiny presentational components ──────────────────────────────────────

function SummaryTile({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "warn" }) {
  const toneClass = tone === "up" ? "tone-up" : tone === "down" ? "tone-down" : tone === "warn" ? "" : "";
  const color = tone === "warn" ? "var(--acc-warn)" : undefined;
  return (
    <div style={{
      background: "var(--bg-card)",
      padding: "12px 14px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{ fontSize: 9, letterSpacing: ".14em", color: "var(--text-mute)" }}>
        {label.toUpperCase()}
      </div>
      <div className={toneClass} style={{
        fontSize: 18, fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        color: color, fontWeight: 500,
      }}>
        {value}
      </div>
    </div>
  );
}

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th style={{
      padding: "10px 12px",
      textAlign: align,
      fontSize: 9, letterSpacing: ".14em", fontWeight: 500,
      color: "var(--text-mute)",
      whiteSpace: "nowrap",
    }}>{children}</th>
  );
}

function Td({ children, align = "left", muted }: { children: React.ReactNode; align?: "left" | "right"; muted?: boolean }) {
  return (
    <td style={{
      padding: "9px 12px",
      textAlign: align,
      color: muted ? "var(--text-mute)" : "var(--text)",
      whiteSpace: "nowrap",
    }}>{children}</td>
  );
}
