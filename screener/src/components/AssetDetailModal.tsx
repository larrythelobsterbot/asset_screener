"use client";

// Slide-in side panel for asset detail. The component name stays
// "AssetDetailModal" so existing call sites work unchanged, but the
// behavior is now a right-side panel with backdrop-blur scrim.
//
// Closes on: scrim click, ✕ button, Escape key.
// Locks body scroll while open.

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  HL_PERP_SECTOR_MAP, HL_BUILDER_PERP_MAP,
  ASSET_DESCRIPTIONS, SECTORS,
} from "@/config/sectors";
import Sparkline from "./Sparkline";
import RSIGauge from "./RSIGauge";
import MomentumCell from "./MomentumCell";
import type { ScreenerRow } from "@/app/api/screener/route";
import type { SocialResponse } from "@/app/api/social/trending/route";
import type { BtcBinaryResponse } from "@/app/api/btc/binary/route";
import type { TopMentionsRouteResponse } from "@/app/api/social/top-mentions/[symbol]/route";

const BUILDER_TICKER_INFO: Record<string, { sector: string; label: string }> = {};
for (const [key, info] of Object.entries(HL_BUILDER_PERP_MAP)) {
  const ticker = key.split(":")[1];
  if (ticker && !(ticker in BUILDER_TICKER_INFO)) {
    BUILDER_TICKER_INFO[ticker] = info;
  }
}

interface AssetDetail {
  symbol: string;
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  indicators: {
    rsi: (number | null)[];
    macd: { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] };
    ema13: (number | null)[];
    ema25: (number | null)[];
    ema32: (number | null)[];
    ma100: (number | null)[];
    ma300: (number | null)[];
    ema200: (number | null)[];
  };
  signals: Array<{ type: string; direction: string; label: string; value: number }>;
  stats: {
    price: number;
    oraclePrice: number;
    fundingRate: number;
    openInterest: number;
    volume24h: number;
  } | null;
}

interface Props {
  symbol: string;
  onClose: () => void;
}

// ── Formatters ──────────────────────────────────────────────────────────

function fmtPrice(n: number): string {
  if (n < 0.01) return n.toPrecision(3);
  if (n < 1) return n.toPrecision(4);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}
function fmtVol(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
function toneClass(n: number | null): string {
  if (n == null) return "tone-mute";
  if (n > 0.005) return "tone-up";
  if (n < -0.005) return "tone-down";
  return "tone-flat";
}

// ── Stat tile (corner-bracket framing) ──────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "warn" | "mute" }) {
  const valColor =
    tone === "up" ? "var(--acc-up)" :
    tone === "down" ? "var(--acc-down)" :
    tone === "warn" ? "var(--acc-warn)" :
    tone === "mute" ? "var(--text-mute)" :
    "var(--text-strong)";
  return (
    <div className="stat">
      <div style={{ fontSize: 9, color: "var(--text-mute)", letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, color: valColor, fontFamily: "var(--font-geist-mono), ui-monospace, monospace" }}>
        {value}
      </div>
      <style jsx>{`
        .stat {
          padding: 12px 14px;
          background: var(--bg-card);
          border: .5px solid var(--border-soft);
          position: relative;
        }
        .stat::before, .stat::after {
          content: "";
          position: absolute;
          width: 6px; height: 6px;
          border: 1px solid var(--text-mute);
          opacity: 0.4;
        }
        .stat::before {
          top: -1px; left: -1px;
          border-right: 0; border-bottom: 0;
        }
        .stat::after {
          bottom: -1px; right: -1px;
          border-left: 0; border-top: 0;
        }
      `}</style>
    </div>
  );
}

// ── Confluence row ──────────────────────────────────────────────────────

function ConfRow({ label, hit, detail }: { label: string; hit: boolean; detail: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "16px 1fr auto",
        gap: 10,
        alignItems: "center",
        padding: "8px 12px",
        background: hit
          ? "color-mix(in oklab, var(--acc-warn) 8%, var(--bg-chip))"
          : "var(--bg-chip)",
        borderRadius: "var(--radius)",
        border: `.5px solid ${hit ? "color-mix(in oklab, var(--acc-warn) 30%, transparent)" : "var(--border-soft)"}`,
        fontSize: 12,
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: hit ? "var(--acc-warn)" : "var(--text-mute)",
        boxShadow: hit ? "0 0 0 3px color-mix(in oklab, var(--acc-warn) 25%, transparent)" : undefined,
      }} />
      <span style={{ color: hit ? "var(--acc-warn)" : "var(--text)" }}>{label}</span>
      <span style={{
        color: hit ? "var(--acc-warn)" : "var(--text-mute)",
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        fontSize: 10,
      }}>
        {detail}
      </span>
    </div>
  );
}

// ── BTC daily binary section (HIP-4) ───────────────────────────────────
// Compact card showing target price, expiry countdown, market-implied
// vs model-implied probability, and divergence. Highlights mustard
// when |divergence| ≥ 10% (the threshold suggested in the LTF research
// notes for "the market and the model disagree enough to investigate").

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function BtcBinarySection({ binary }: { binary: BtcBinaryResponse }) {
  const marketPct = binary.market_probability * 100;
  const modelPct = binary.model_probability != null ? binary.model_probability * 100 : null;
  const divergencePct = binary.divergence != null ? binary.divergence * 100 : null;
  // Highlight when |divergence| crosses the threshold for "worth a look".
  const hot = divergencePct != null && Math.abs(divergencePct) >= 10;
  // Direction-of-divergence color: model > market = model thinks YES
  // is underpriced (positive divergence, green); inverse otherwise.
  const divTone =
    divergencePct == null ? "tone-mute" :
    divergencePct >= 10 ? "tone-up" :
    divergencePct <= -10 ? "tone-down" :
    "tone-mute";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Top row: target + countdown */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 12,
        alignItems: "baseline",
        padding: "8px 12px",
        background: "var(--bg-chip)",
        borderRadius: "var(--radius)",
        border: ".5px solid var(--border-soft)",
      }}>
        <div>
          <div style={{
            fontSize: 9, color: "var(--text-mute)",
            letterSpacing: ".14em", textTransform: "uppercase",
          }}>
            Settles ≥ Target?
          </div>
          <div style={{
            fontSize: 18,
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            color: "var(--text-strong)",
            marginTop: 2,
          }}>
            ${binary.target_price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{
            fontSize: 9, color: "var(--text-mute)",
            letterSpacing: ".14em", textTransform: "uppercase",
          }}>
            Expires In
          </div>
          <div style={{
            fontSize: 18,
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            color: "var(--text)",
            marginTop: 2,
          }}>
            {formatTimeRemaining(binary.ms_to_expiry)}
          </div>
        </div>
      </div>

      {/* Probability comparison */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 1,
        background: "var(--border-soft)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        border: hot
          ? ".5px solid color-mix(in oklab, var(--acc-warn) 35%, transparent)"
          : undefined,
      }}>
        <div style={{ padding: "10px 12px", background: "var(--bg-card)" }}>
          <div style={{ fontSize: 9, color: "var(--text-mute)", letterSpacing: ".14em", textTransform: "uppercase" }}>
            Market
          </div>
          <div style={{
            fontSize: 16,
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            color: "var(--text-strong)",
            marginTop: 4,
          }}>
            {marketPct.toFixed(1)}%
          </div>
        </div>
        <div style={{ padding: "10px 12px", background: "var(--bg-card)" }}>
          <div style={{ fontSize: 9, color: "var(--text-mute)", letterSpacing: ".14em", textTransform: "uppercase" }}>
            Model
          </div>
          <div style={{
            fontSize: 16,
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            color: modelPct == null ? "var(--text-mute)" : "var(--text-strong)",
            marginTop: 4,
          }}>
            {modelPct == null ? "—" : `${modelPct.toFixed(1)}%`}
          </div>
        </div>
        <div style={{ padding: "10px 12px", background: hot ? "color-mix(in oklab, var(--acc-warn) 10%, var(--bg-card))" : "var(--bg-card)" }}>
          <div style={{ fontSize: 9, color: "var(--text-mute)", letterSpacing: ".14em", textTransform: "uppercase" }}>
            Divergence
          </div>
          <div
            className={divTone}
            style={{
              fontSize: 16,
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
              marginTop: 4,
              color: hot ? "var(--acc-warn)" : undefined,
            }}
          >
            {divergencePct == null ? "—" : `${divergencePct > 0 ? "+" : ""}${divergencePct.toFixed(1)}%`}
          </div>
        </div>
      </div>

      {/* Metadata row */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 10,
        color: "var(--text-mute)",
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        padding: "0 4px",
      }}>
        <span>YES <code>{binary.yes_price.toFixed(4)}</code> · NO <code>{binary.no_price.toFixed(4)}</code></span>
        <span>
          {binary.realized_vol_30d != null
            ? `σ ${(binary.realized_vol_30d * 100).toFixed(0)}%`
            : "σ —"}
          {Math.abs(binary.parity_sum - 1) > 0.01 && (
            <span style={{ color: "var(--acc-warn)", marginLeft: 8 }}>
              parity {binary.parity_sum.toFixed(4)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

// ── Top mentions list (Elfa) ────────────────────────────────────────────
// Renders up to 3 tweet cards with link + engagement metrics + relative
// time. No tweet text available from Elfa's free tier — clicking opens
// X in a new tab. Smart-account repost count (vs CT-account count) is
// what makes Elfa's data different from raw twitter scrape; surface it
// prominently when present.

function compactNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function relTimeFrom(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function TopMentionsList({
  mentions,
  total,
}: {
  mentions: import("@/lib/elfa").TopMention[];
  total: number;
}) {
  const top = mentions.slice(0, 3);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {top.map((m) => {
        const smart = m.repostBreakdown?.smart ?? 0;
        const ct = m.repostBreakdown?.ct ?? 0;
        return (
          <a
            key={m.tweetId}
            href={m.link}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "block",
              padding: "8px 12px",
              background: "var(--bg-chip)",
              borderRadius: "var(--radius)",
              border: ".5px solid var(--border-soft)",
              textDecoration: "none",
              color: "var(--text)",
              transition: "background .12s, border-color .12s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = "var(--bg-chip-h)";
              e.currentTarget.style.borderColor = "color-mix(in oklab, var(--acc-warn) 30%, transparent)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = "var(--bg-chip)";
              e.currentTarget.style.borderColor = "var(--border-soft)";
            }}
          >
            <div style={{
              display: "flex", justifyContent: "space-between",
              alignItems: "baseline", gap: 8,
              fontSize: 11,
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            }}>
              <span style={{ color: "var(--text-mute)" }}>
                {m.type === "quote" ? "↻ quote" : m.type === "reply" ? "↩ reply" : "✎ post"}
              </span>
              <span style={{ color: "var(--text-mute)" }}>{relTimeFrom(m.mentionedAt)}</span>
            </div>
            <div style={{
              display: "flex", gap: 14, marginTop: 6,
              fontSize: 10,
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
              color: "var(--text-mute)",
            }}>
              <span title="Views">👁 {compactNum(m.viewCount)}</span>
              <span title="Likes">♥ {compactNum(m.likeCount)}</span>
              <span title="Reposts">↻ {compactNum(m.repostCount)}</span>
              <span title="Replies">↩ {compactNum(m.replyCount)}</span>
              {smart > 0 && (
                <span
                  title="Smart-money account reposts (Elfa's verified KOL signal)"
                  style={{ color: "var(--acc-warn)", marginLeft: "auto" }}
                >
                  ★ {smart} smart
                </span>
              )}
              {smart === 0 && ct > 0 && (
                <span
                  title="Crypto-twitter (CT) reposts"
                  style={{ color: "var(--text-mute)", marginLeft: "auto" }}
                >
                  CT {ct}
                </span>
              )}
            </div>
          </a>
        );
      })}
      {total > top.length && (
        <div style={{
          fontSize: 10,
          color: "var(--text-mute)",
          textAlign: "right",
          fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          padding: "0 4px",
        }}>
          {total - top.length} more · click any to open in X
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

export default function AssetDetailModal({ symbol, onClose }: Props) {
  const [data, setData] = useState<AssetDetail | null>(null);
  const [screenerRow, setScreenerRow] = useState<ScreenerRow | null>(null);
  const [social, setSocial] = useState<{
    row: { mention_count: number; prev_count: number | null; change_pct: number | null } | null;
    rank: number | null;
    total: number | null;
  } | null>(null);
  // BTC daily binary outcome (HIP-4). Only fetched when symbol === "BTC".
  // null = not fetched yet; non-null = either real data or { error: ... }.
  const [binary, setBinary] = useState<BtcBinaryResponse | null>(null);
  // Top tweet mentions (Elfa). Lazy-loaded only after trending lookup
  // confirms the symbol is in Elfa's universe — saves a credit on
  // long-tail tickers nobody's talking about.
  const [topMentions, setTopMentions] = useState<TopMentionsRouteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    // Fetch in parallel: per-symbol detail + the screener slice + the
    // social trending list + (BTC only) the HIP-4 binary outcome state.
    // All routes are server-cached so opening multiple panels in
    // succession costs at most one upstream call to each backend.
    // The binary fetch is gated on symbol === "BTC" to save a request
    // for every other asset; Promise.resolve(null) for the rest.
    const isBtc = symbol === "BTC";
    Promise.all([
      fetch(`/api/asset/${symbol}`).then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${symbol}`);
        return r.json();
      }),
      fetch(`/api/screener?tf=1d`).then((r) => r.json()),
      fetch(`/api/social/trending?tf=24h`).then((r) => r.ok ? r.json() : null).catch(() => null),
      isBtc
        ? fetch(`/api/btc/binary`).then((r) => r.ok ? r.json() : null).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([d, rows, soc, bin]: [AssetDetail, ScreenerRow[], SocialResponse | null, BtcBinaryResponse | null]) => {
        setBinary(bin);
        setData(d);
        if (Array.isArray(rows)) {
          setScreenerRow(rows.find((r) => r.symbol === symbol) ?? null);
        }
        if (soc && Array.isArray(soc.data)) {
          // Elfa returns rows already sorted desc by current_count, but
          // sort again defensively so the rank we compute is stable
          // even if the API changes its sort.
          const sorted = [...soc.data].sort((a, b) => b.mention_count - a.mention_count);
          const idx = sorted.findIndex((r) => r.symbol === symbol);
          setSocial({
            row: idx >= 0 ? sorted[idx] : null,
            rank: idx >= 0 ? idx + 1 : null,
            total: soc.count,
          });
        }
        setLoading(false);
      })
      .catch((e) => { setError(String(e)); setLoading(false); });
  }, [symbol]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Lazy-load top mentions ONLY after we know the symbol is in Elfa's
  // trending universe. Skipping the fetch for non-trending symbols
  // saves a credit per panel open on long-tail tickers — meaningful at
  // the daily budget level. If the symbol IS trending, the route's
  // 1h cache means we hit Elfa at most once per (symbol, tf) per hour
  // regardless of how many users open the same panel.
  useEffect(() => {
    if (!social?.row) return;
    let cancelled = false;
    fetch(`/api/social/top-mentions/${symbol}?tf=24h`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TopMentionsRouteResponse | null) => {
        if (!cancelled && d) setTopMentions(d);
      })
      .catch(() => { /* silent — section just doesn't render */ });
    return () => { cancelled = true; };
  }, [social, symbol]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const perpMapping = HL_PERP_SECTOR_MAP[symbol];
  const builderMapping = BUILDER_TICKER_INFO[symbol];
  const mapping = perpMapping || builderMapping;
  const sectorColor = mapping ? SECTORS[mapping.sector as keyof typeof SECTORS]?.color || "#64748B" : "#64748B";
  const sectorLabel = mapping ? SECTORS[mapping.sector as keyof typeof SECTORS]?.label || mapping.sector : "Unknown";
  const assetName = mapping ? mapping.label : symbol;
  const description = ASSET_DESCRIPTIONS[symbol] ?? null;

  // Derive change24h from the candles (4h × 6 = 24h close-to-close).
  const change24h = useMemo(() => {
    if (!data || data.candles.length < 7) return null;
    const last = data.candles[data.candles.length - 1].close;
    const dayAgo = data.candles[data.candles.length - 7].close;
    return ((last - dayAgo) / dayAgo) * 100;
  }, [data]);

  // Multi-horizon momentum derived from candles. 4h candles let us read:
  //   1h ≈ within-bar; we approximate by the last close vs 1 bar back interpolation — but
  //   the API doesn't provide finer than 4h, so 1H will read as "—" until we
  //   plumb a per-symbol 1h fetch through. For now we surface what we have:
  //     1H  → null (placeholder)
  //     4H  → last 4h candle delta
  //     24H → 7 candles back
  //     7D  → 42 candles back (4h × 6 × 7), best-effort
  const momentum = useMemo(() => {
    if (!data || data.candles.length === 0) return { c1: null as number | null, c4: null as number | null, c24: null as number | null, c7d: null as number | null };
    const last = data.candles[data.candles.length - 1].close;
    const at = (n: number): number | null => {
      const idx = data.candles.length - 1 - n;
      if (idx < 0) return null;
      const prev = data.candles[idx].close;
      return prev > 0 ? ((last - prev) / prev) * 100 : null;
    };
    return { c1: null, c4: at(1), c24: at(6), c7d: at(42) };
  }, [data]);

  // RSI / MA values for the hero sections.
  const lastRsi = useMemo(() => {
    if (!data) return null;
    for (let i = data.indicators.rsi.length - 1; i >= 0; i--) {
      const v = data.indicators.rsi[i];
      if (v != null) return v;
    }
    return null;
  }, [data]);

  const maRows = useMemo(() => {
    if (!data) return null;
    const last = data.candles[data.candles.length - 1]?.close ?? 0;
    const ind = data.indicators;
    const cur = (arr: (number | null)[]): number | null => {
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]!;
      return null;
    };
    const list = [
      { label: "13",  ma: cur(ind.ema13)  },
      { label: "25",  ma: cur(ind.ema25)  },
      { label: "32",  ma: cur(ind.ema32)  },
      { label: "100", ma: cur(ind.ma100)  },
      { label: "200", ma: cur(ind.ema200) },
      { label: "300", ma: cur(ind.ma300)  },
    ];
    return list.map((r) => ({ ...r, above: r.ma != null ? last > r.ma : null }));
  }, [data]);

  const maAlign = useMemo(() => {
    if (!maRows) return null;
    return maRows.filter((r) => r.above === true).length;
  }, [maRows]);

  const sparkData = useMemo(() => {
    if (!data) return [];
    // Last 60 4h closes — gives ~10 days of context for the hero spark.
    return data.candles.slice(-60).map((c) => c.close);
  }, [data]);

  const heroTone = toneClass(change24h);
  const volRatio = screenerRow?.vol_ratio ?? null;
  const athPct = screenerRow?.ath_pct ?? null;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 40,
          background: "rgba(0,0,0,0.45)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          animation: "scrim-in 0.18s ease-out",
        }}
      />
      <aside
        aria-label="Asset detail"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 41,
          width: "min(580px, 92vw)",
          background: "var(--bg-card)",
          borderLeft: ".5px solid var(--border)",
          display: "flex", flexDirection: "column",
          boxShadow: "-20px 0 60px rgba(0,0,0,0.4)",
          animation: "sp-in 0.24s cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
      >
        {/* Header */}
        <header style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "18px 22px",
          borderBottom: ".5px solid var(--border)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{
              width: 10, height: 10, borderRadius: 1,
              background: sectorColor, flexShrink: 0,
            }} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text-strong)" }}>
                {assetName}
              </div>
              <div style={{ display: "flex", gap: 10, fontSize: 11, color: "var(--text-mute)", marginTop: 2 }}>
                <span className="sym" style={{ color: "var(--acc-warn)" }}>{symbol}</span>
                <span>{sectorLabel}</span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 28, height: 28,
              borderRadius: "var(--radius)",
              border: 0, background: "transparent",
              color: "var(--text-mute)", fontSize: 13, cursor: "pointer",
              transition: "background .15s, color .15s",
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.background = "var(--bg-chip-h)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-mute)";
            }}
          >
            ✕
          </button>
        </header>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 22px 40px" }}>
          {loading && (
            <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
              <div style={{
                width: 32, height: 32,
                border: "2px solid rgba(255,255,255,0.12)",
                borderTopColor: "var(--acc-warn)",
                borderRadius: "50%",
                animation: "sp-spin 0.9s linear infinite",
              }} />
            </div>
          )}

          {error && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "80px 0" }}>
              <span style={{ color: "var(--acc-down)", fontSize: 12 }}>{error}</span>
              <button
                onClick={fetchData}
                className="btn-ghost"
              >Retry</button>
            </div>
          )}

          {data && !loading && !error && (
            <>
              {/* Hero */}
              <section style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
                  <div style={{
                    fontSize: 32, fontWeight: 500, letterSpacing: "-0.02em",
                    color: "var(--text-strong)",
                    fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
                  }}>
                    ${data.stats ? fmtPrice(data.stats.price) : "—"}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 0 }}>
                    <span className={`pct-tri ${heroTone}`} style={{
                      fontSize: 18,
                      fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
                    }}>
                      {fmtPct(change24h)}
                    </span>
                    <span style={{
                      fontSize: 9, letterSpacing: ".14em",
                      color: "var(--text-mute)", marginTop: 2,
                    }}>
                      24H
                    </span>
                  </div>
                </div>
                <div className={heroTone} style={{ marginTop: 16, padding: "12px 0" }}>
                  <Sparkline data={sparkData} width={520} height={120} strokeWidth={1.75} fill />
                </div>
                {description && (
                  <p style={{
                    fontSize: 11, color: "var(--text-mute)",
                    lineHeight: 1.55, marginTop: 12,
                  }}>
                    {description}
                  </p>
                )}
              </section>

              {/* HIP-4 daily BTC binary — only rendered for BTC and only
                  when the binary fetch succeeded. Cards out target
                  price, expiry countdown, market vs model probability,
                  and divergence. */}
              {binary && symbol === "BTC" && (
                <section style={{ marginBottom: 24 }}>
                  <div className="br-label" style={{ marginBottom: 10, paddingBottom: 6, borderBottom: ".5px solid var(--border-soft)" }}>
                    Daily Binary · HIP-4
                  </div>
                  <BtcBinarySection binary={binary} />
                </section>
              )}

              {/* Momentum */}
              <section style={{ marginBottom: 24 }}>
                <div className="br-label" style={{ marginBottom: 10, paddingBottom: 6, borderBottom: ".5px solid var(--border-soft)" }}>
                  Momentum
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                  <MomentumCell label="1 Hour"  value={momentum.c1}  scale={2} />
                  <MomentumCell label="4 Hour"  value={momentum.c4}  scale={4} />
                  <MomentumCell label="24 Hour" value={momentum.c24} scale={8} />
                  <MomentumCell label="7 Day"   value={momentum.c7d} scale={25} />
                </div>
              </section>

              {/* Stats */}
              <section style={{ marginBottom: 24 }}>
                <div className="br-label" style={{ marginBottom: 10, paddingBottom: 6, borderBottom: ".5px solid var(--border-soft)" }}>
                  Stats
                </div>
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 1,
                  background: "var(--border-soft)",
                  borderRadius: "var(--radius)",
                  overflow: "hidden",
                }}>
                  <Stat label="Volume 24H" value={fmtVol(data.stats?.volume24h ?? 0)} />
                  <Stat
                    label="Volume Ratio"
                    value={volRatio == null ? "—" : `${volRatio.toFixed(2)}×`}
                    tone={volRatio != null && volRatio >= 2 ? "warn" : undefined}
                  />
                  <Stat
                    label="From ATH"
                    value={athPct == null ? "—" : `${athPct.toFixed(1)}%`}
                    tone={athPct != null && athPct <= -50 ? "down" : athPct != null && athPct <= -20 ? "warn" : undefined}
                  />
                  <Stat
                    label="Funding APR"
                    value={(() => {
                      if (!data.stats) return "—";
                      const apr = data.stats.fundingRate * 8760 * 100;
                      if (!Number.isFinite(apr)) return "—";
                      const sign = apr > 0 ? "+" : "";
                      return `${sign}${apr.toFixed(1)}%`;
                    })()}
                    tone={(() => {
                      if (!data.stats) return undefined;
                      const apr = Math.abs(data.stats.fundingRate * 8760 * 100);
                      // Same color logic as the table column. Extreme
                      // funding flips to red/green; warn band 50–100%.
                      if (apr < 10) return "mute";
                      if (apr >= 100) return data.stats.fundingRate > 0 ? "down" : "up";
                      if (apr >= 50) return "warn";
                      return data.stats.fundingRate > 0 ? "down" : "up";
                    })()}
                  />
                  <Stat
                    label="RSI"
                    value={lastRsi == null ? "—" : String(Math.round(lastRsi))}
                    tone={lastRsi != null && lastRsi >= 70 ? "warn" : lastRsi != null && lastRsi <= 30 ? "mute" : undefined}
                  />
                  <Stat
                    label="MA Alignment"
                    value={maAlign == null ? "—" : `${maAlign} / 6`}
                    tone={maAlign != null && maAlign >= 5 ? "up" : maAlign != null && maAlign <= 1 ? "down" : undefined}
                  />
                </div>
              </section>

              {/* RSI */}
              <section style={{ marginBottom: 24 }}>
                <div className="br-label" style={{ marginBottom: 10, paddingBottom: 6, borderBottom: ".5px solid var(--border-soft)" }}>
                  RSI · 14
                </div>
                <RSIGauge value={lastRsi} large />
              </section>

              {/* Moving Averages */}
              <section style={{ marginBottom: 24 }}>
                <div className="br-label" style={{ marginBottom: 10, paddingBottom: 6, borderBottom: ".5px solid var(--border-soft)" }}>
                  Moving Averages · 4H
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {(maRows ?? []).map((r) => (
                    <div
                      key={r.label}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "60px 1fr 60px",
                        gap: 12, alignItems: "center",
                        padding: "6px 0",
                      }}
                    >
                      <span className="sym" style={{ fontSize: 11, color: "var(--text)", fontWeight: 400 }}>
                        {r.label}
                      </span>
                      <span style={{
                        height: 4, background: "var(--bg-chip)",
                        borderRadius: 2, overflow: "hidden", position: "relative",
                      }}>
                        {r.above != null && (
                          <span style={{
                            position: "absolute",
                            top: 0, bottom: 0,
                            ...(r.above
                              ? { left: "50%", right: 0, background: "var(--acc-up)" }
                              : { left: 0, right: "50%", background: "var(--acc-down)" }),
                          }} />
                        )}
                      </span>
                      <span style={{
                        fontSize: 10, textAlign: "right",
                        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
                        letterSpacing: ".06em",
                        color: r.above == null ? "var(--text-mute)" :
                               r.above ? "var(--acc-up)" : "var(--acc-down)",
                      }}>
                        {r.above == null ? "—" : r.above ? "ABOVE" : "BELOW"}
                      </span>
                    </div>
                  ))}
                </div>
              </section>

              {/* Social — only render if we have data for this symbol */}
              {social?.row && (
                <section style={{ marginBottom: 24 }}>
                  <div className="br-label" style={{ marginBottom: 10, paddingBottom: 6, borderBottom: ".5px solid var(--border-soft)" }}>
                    Social · 24h
                  </div>
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 1,
                    background: "var(--border-soft)",
                    borderRadius: "var(--radius)",
                    overflow: "hidden",
                  }}>
                    <Stat
                      label="Mentions"
                      value={social.row.mention_count.toLocaleString()}
                    />
                    <Stat
                      label="24h Change"
                      value={social.row.change_pct == null
                        ? "—"
                        : `${social.row.change_pct > 0 ? "+" : ""}${social.row.change_pct.toFixed(1)}%`}
                      tone={
                        social.row.change_pct == null ? undefined :
                        social.row.change_pct >= 50 ? "warn" :
                        social.row.change_pct > 0 ? "up" :
                        "down"
                      }
                    />
                    <Stat
                      label="Mindshare Rank"
                      value={social.rank != null && social.total != null
                        ? `${social.rank} / ${social.total}`
                        : "—"}
                      tone={social.rank != null && social.rank <= 10 ? "warn" : undefined}
                    />
                  </div>
                </section>
              )}

              {/* Top mentions — Elfa-credit'd top tweets for this ticker.
                  Only rendered when trending lookup confirmed the symbol
                  has mentions to surface; lazy-loaded so non-trending
                  symbols never trigger an Elfa call. */}
              {topMentions && topMentions.mentions.length > 0 && (
                <section style={{ marginBottom: 24 }}>
                  <div className="br-label" style={{ marginBottom: 10, paddingBottom: 6, borderBottom: ".5px solid var(--border-soft)" }}>
                    Top Mentions · 24h
                  </div>
                  <TopMentionsList mentions={topMentions.mentions} total={topMentions.total} />
                </section>
              )}

              {/* Confluence */}
              <section style={{ marginBottom: 24 }}>
                <div className="br-label" style={{ marginBottom: 10, paddingBottom: 6, borderBottom: ".5px solid var(--border-soft)" }}>
                  Confluence Signals
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <ConfRow
                    label="Vol Spike"
                    hit={volRatio != null && volRatio >= 2}
                    detail={volRatio != null ? `${volRatio.toFixed(2)}× avg` : "—"}
                  />
                  <ConfRow
                    label="MA Alignment"
                    hit={maAlign != null && maAlign >= 5}
                    detail={maAlign != null ? `${maAlign}/6 above` : "—"}
                  />
                  <ConfRow
                    label="RSI Extreme"
                    hit={lastRsi != null && (lastRsi >= 70 || lastRsi <= 30)}
                    detail={lastRsi == null ? "—" :
                            lastRsi >= 70 ? "overbought" :
                            lastRsi <= 30 ? "oversold" : "neutral"}
                  />
                  <ConfRow
                    label="Strong Trend"
                    hit={momentum.c7d != null && Math.abs(momentum.c7d) >= 10}
                    detail={momentum.c7d != null ? `${momentum.c7d.toFixed(1)}% 7D` : "—"}
                  />
                  {social?.row && (
                    <ConfRow
                      label="Social Spike"
                      hit={social.row.change_pct != null && social.row.change_pct >= 50}
                      detail={social.row.change_pct != null
                        ? `${social.row.change_pct.toFixed(0)}% mention Δ`
                        : "—"}
                    />
                  )}
                </div>
              </section>

              {/* Active signals from /api/asset */}
              {data.signals && data.signals.length > 0 && (
                <section style={{ marginBottom: 24 }}>
                  <div className="br-label" style={{ marginBottom: 10, paddingBottom: 6, borderBottom: ".5px solid var(--border-soft)" }}>
                    Active Signals
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {data.signals.map((s, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: 11,
                          padding: "4px 8px",
                          borderRadius: "var(--radius)",
                          background: s.direction === "bullish"
                            ? "color-mix(in oklab, var(--acc-up) 14%, transparent)"
                            : "color-mix(in oklab, var(--acc-down) 14%, transparent)",
                          color: s.direction === "bullish" ? "var(--acc-up)" : "var(--acc-down)",
                          fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
                        }}
                      >
                        {s.direction === "bullish" ? "▲" : "▼"} {s.label}
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </aside>

      <style jsx global>{`
        @keyframes scrim-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes sp-in {
          from { transform: translateX(20px); opacity: 0; }
          to   { transform: translateX(0); opacity: 1; }
        }
        @keyframes sp-spin { to { transform: rotate(360deg); } }
      `}</style>
    </>
  );
}
