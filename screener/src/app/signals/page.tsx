"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";

type Status = "open" | "target" | "stop" | "expired" | "ambiguous" | "untrackable";

type AlertRow = {
  id: number;
  created_at: number;
  delivery_status: "pending" | "delivered" | "failed";
  delivery_uncertain: boolean;
  has_delivery_error: boolean;
  symbol: string;
  direction: "long" | "short";
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  conviction_score: number | null;
  conviction_label: string | null;
  outcome_status: Status;
  pnl_r: number | null;
  outcome_note: string | null;
};

type Group = {
  key: string;
  attempts: number;
  delivered: number;
  target: number;
  stop: number;
  expired: number;
  ambiguous: number;
  open: number;
  finiteROutcomes: number;
  decisiveTpSl: number;
  expectancyR: number | null;
  targetRateDecisivePct: number | null;
};

type ResponseData = {
  generatedAt: number;
  windowDays: number;
  sampleTruncated: boolean;
  allTime: Record<string, number>;
  summary: {
    delivery: { attempts: number; delivered: number; failed: number; unknown: number; pending: number };
    outcomes: Record<Status, number>;
    resolved: number;
    decisive: number;
    finiteROutcomes: number;
    decisiveTpSl: number;
    targetRateDecisivePct: number | null;
    successRateAllResolvedPct: number | null;
    expectancyR: number | null;
    totalR: number;
    analysisSuppressed: boolean;
    evidence: {
      classification: "insufficient" | "promising" | "weak" | "inconclusive";
      sampleSize: number;
      targetRate: number | null;
      lower95: number | null;
      upper95: number | null;
      breakevenRate: number;
    };
    byConviction: Group[];
    byFamily: Group[];
  };
  alerts: AlertRow[];
};

const colors: Record<Status, string> = {
  open: "var(--acc-warn)",
  target: "var(--acc-up)",
  stop: "var(--acc-down)",
  expired: "var(--text-muted)",
  ambiguous: "#c084fc",
  untrackable: "var(--text-muted)",
};

const pageTokens = {
  "--panel": "var(--bg-card)",
  "--text-muted": "var(--text-mute)",
} as CSSProperties;

function pct(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function r(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function price(value: number | null): string {
  if (value == null) return "—";
  const digits = value >= 1_000 ? 0 : value >= 1 ? 3 : 8;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

function evidenceCopy(data: ResponseData): { title: string; detail: string; color: string } {
  if (data.sampleTruncated || data.summary.analysisSuppressed) {
    return {
      title: "Analysis suppressed/incomplete",
      detail: "This window contains more than the 5,000-row analysis limit. Verdicts, target rates, and expectancy are withheld until the window can be analyzed completely.",
      color: "var(--acc-warn)",
    };
  }
  const evidence = data.summary.evidence;
  const interval = evidence.lower95 == null || evidence.upper95 == null
    ? ""
    : ` The 95% target-rate interval is ${(evidence.lower95 * 100).toFixed(1)}–${(evidence.upper95 * 100).toFixed(1)}%.`;
  switch (evidence.classification) {
    case "promising":
      return { title: "Promising evidence", detail: `The lower confidence bound is above the 25% pre-fee breakeven rate for a 3R/-1R system.${interval}`, color: "var(--acc-up)" };
    case "weak":
      return { title: "Weak evidence", detail: `The upper confidence bound is below the 25% pre-fee breakeven rate.${interval}`, color: "var(--acc-down)" };
    case "inconclusive":
      return { title: "Inconclusive evidence", detail: `The sample is large enough to inspect, but it does not yet distinguish edge from noise.${interval}`, color: "var(--acc-warn)" };
    default:
      return { title: "Collecting evidence", detail: `${evidence.sampleSize}/30 decisive target-or-stop outcomes collected. No strength verdict is shown before the minimum sample.`, color: "var(--acc-warn)" };
  }
}

export default function SignalPerformancePage() {
  const [data, setData] = useState<ResponseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/alert-performance?days=90", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json() as ResponseData);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const evidence = data ? evidenceCopy(data) : null;
  const cards = data ? [
    ["Send attempts", data.summary.delivery.attempts],
    ["Delivered", data.summary.delivery.delivered],
    ["Failed", data.summary.delivery.failed],
    ["Unknown ACK", data.summary.delivery.unknown],
    ["Pending", data.summary.delivery.pending],
    ["Targets", data.summary.outcomes.target],
    ["Stops", data.summary.outcomes.stop],
    ["Open", data.summary.outcomes.open],
    ["Expired", data.summary.outcomes.expired],
    ["Ambiguous", data.summary.outcomes.ambiguous],
    ["Untrackable", data.summary.outcomes.untrackable],
    ["Finite-R outcomes", data.summary.finiteROutcomes],
    ["Decisive TP/SL", data.summary.decisiveTpSl],
    ["Expectancy (avg finite-R resolved, incl. expiry MTM)", data.sampleTruncated ? "—" : r(data.summary.expectancyR)],
    ["Target rate (target / (target + stop))", data.sampleTruncated ? "—" : pct(data.summary.targetRateDecisivePct)],
  ] : [];

  return (
    <main style={{ ...pageTokens, minHeight: "100vh", padding: "24px", background: "var(--bg)", color: "var(--text)" }}>
      <div style={{ maxWidth: 1440, margin: "0 auto" }}>
        <header style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", marginBottom: 24 }}>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase" }}>Telegram alert audit</div>
            <h1 style={{ margin: "4px 0", fontSize: 28 }}>Signal performance</h1>
            <p style={{ margin: 0, color: "var(--text-muted)", maxWidth: 760 }}>
              Delivery acknowledgements and deterministic 48-hour TP/SL outcomes. Full 1h bars are used after the alert hour; partial opening and expiry hours use sampled marks. Same-candle dual hits are ambiguous, never counted as wins.
            </p>
          </div>
          <nav style={{ display: "flex", gap: 10 }} aria-label="Signal performance navigation">
            <Link href="/" className="btn-ghost" style={{ textDecoration: "none" }}>Screener</Link>
            <Link href="/journal" className="btn-ghost" style={{ textDecoration: "none" }}>Journal</Link>
            <button type="button" className="btn-ghost" onClick={() => void load()}>Refresh</button>
          </nav>
        </header>

        {error && <div role="alert" style={{ border: "1px solid var(--acc-down)", padding: 12, marginBottom: 16 }}>Unable to load alert performance: {error}</div>}
        {loading && !data && <p>Loading alert ledger…</p>}

        {data && evidence && (
          <>
            <section style={{ border: `1px solid ${evidence.color}`, background: "var(--panel)", padding: 16, marginBottom: 16 }}>
              <strong style={{ color: evidence.color }}>{evidence.title}</strong>
              <div style={{ marginTop: 6, color: "var(--text-muted)" }}>{evidence.detail}</div>
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>
                Window: {data.windowDays} days · All-time send attempts: {data.allTime.total ?? 0} · Decisive TP/SL sample: {data.summary.decisiveTpSl} · Finite-R outcomes: {data.summary.finiteROutcomes}
                {data.sampleTruncated ? " · Window truncated at 5,000 rows" : ""}
              </div>
            </section>

            <section aria-label="Performance summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 24 }}>
              {cards.map(([label, value]) => (
                <div key={String(label)} style={{ border: "1px solid var(--border)", background: "var(--panel)", padding: 14 }}>
                  <div style={{ color: "var(--text-muted)", fontSize: 12, textTransform: "uppercase" }}>{label}</div>
                  <div style={{ fontSize: 24, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}</div>
                </div>
              ))}
            </section>

            <section style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 18 }}>By conviction</h2>
              <div style={{ overflowX: "auto", border: "1px solid var(--border)" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
                  <thead><tr>{["Conviction", "Delivered", "Target", "Stop", "Expired", "Open", "Finite-R outcomes", "Decisive TP/SL", "Target rate (target / (target + stop))", "Expectancy (avg finite-R resolved, incl. expiry MTM)"].map((heading) => <th key={heading} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>{heading}</th>)}</tr></thead>
                  <tbody>{data.summary.byConviction.map((group) => <tr key={group.key}>
                    <td style={{ padding: 10 }}>{group.key}</td><td style={{ padding: 10 }}>{group.delivered}</td><td style={{ padding: 10 }}>{group.target}</td><td style={{ padding: 10 }}>{group.stop}</td><td style={{ padding: 10 }}>{group.expired}</td><td style={{ padding: 10 }}>{group.open}</td><td style={{ padding: 10 }}>{group.finiteROutcomes}</td><td style={{ padding: 10 }}>{group.decisiveTpSl}</td><td style={{ padding: 10 }}>{data.sampleTruncated ? "—" : pct(group.targetRateDecisivePct)}</td><td style={{ padding: 10 }}>{data.sampleTruncated ? "—" : r(group.expectancyR)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </section>

            {data.summary.byFamily.length > 0 && (
              <section style={{ marginBottom: 24 }}>
                <h2 style={{ fontSize: 18 }}>By signal family</h2>
                <p style={{ margin: "-4px 0 12px", color: "#707070", fontSize: 12 }}>
                  One alert can contain multiple signal families, so these rows are not additive.
                </p>
                <div style={{ overflowX: "auto", border: "1px solid var(--border)" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
                    <thead><tr>{["Family", "Delivered", "Target", "Stop", "Expired", "Open", "Finite-R outcomes", "Decisive TP/SL", "Target rate (target / (target + stop))", "Expectancy (avg finite-R resolved, incl. expiry MTM)"].map((heading) => <th key={heading} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>{heading}</th>)}</tr></thead>
                    <tbody>{data.summary.byFamily.map((group) => <tr key={group.key}>
                      <td style={{ padding: 10 }}>{group.key}</td><td style={{ padding: 10 }}>{group.delivered}</td><td style={{ padding: 10 }}>{group.target}</td><td style={{ padding: 10 }}>{group.stop}</td><td style={{ padding: 10 }}>{group.expired}</td><td style={{ padding: 10 }}>{group.open}</td><td style={{ padding: 10 }}>{group.finiteROutcomes}</td><td style={{ padding: 10 }}>{group.decisiveTpSl}</td><td style={{ padding: 10 }}>{data.sampleTruncated ? "—" : pct(group.targetRateDecisivePct)}</td><td style={{ padding: 10 }}>{data.sampleTruncated ? "—" : r(group.expectancyR)}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              </section>
            )}

            <section>
              <h2 style={{ fontSize: 18 }}>Recent alert lifecycle</h2>
              {data.alerts.length === 0 ? (
                <div style={{ border: "1px solid var(--border)", background: "var(--panel)", padding: 18, color: "var(--text-muted)" }}>
                  No durable alerts yet. Tracking starts with the next qualifying Telegram alert; historical alerts require a Telegram Desktop JSON export.
                </div>
              ) : (
                <div style={{ overflowX: "auto", border: "1px solid var(--border)" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1080 }}>
                    <thead><tr>{["Time", "Asset", "Direction", "Delivery", "Outcome", "Entry", "Stop", "Target", "Result", "Conviction"].map((heading) => <th key={heading} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>{heading}</th>)}</tr></thead>
                    <tbody>{data.alerts.map((alert) => (
                      <tr key={alert.id} title={alert.outcome_note ?? undefined}>
                        <td style={{ padding: 10, whiteSpace: "nowrap" }}>{new Date(alert.created_at).toLocaleString()}</td>
                        <td style={{ padding: 10, fontWeight: 700 }}>{alert.symbol}</td>
                        <td style={{ padding: 10, textTransform: "uppercase" }}>{alert.direction}</td>
                        <td style={{ padding: 10 }}>{alert.delivery_uncertain ? "unknown ACK" : alert.delivery_status}{alert.has_delivery_error ? " ⚠" : ""}</td>
                        <td style={{ padding: 10, color: colors[alert.outcome_status], fontWeight: 700 }}>{alert.outcome_status}</td>
                        <td style={{ padding: 10 }}>{price(alert.entry_price)}</td>
                        <td style={{ padding: 10 }}>{price(alert.stop_price)}</td>
                        <td style={{ padding: 10 }}>{price(alert.target_price)}</td>
                        <td style={{ padding: 10 }}>{r(alert.pnl_r)}</td>
                        <td style={{ padding: 10 }}>{alert.conviction_label ?? "—"} {alert.conviction_score == null ? "" : `(${alert.conviction_score.toFixed(2)})`}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
