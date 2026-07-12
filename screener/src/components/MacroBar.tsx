"use client";

import { useEffect, useState } from "react";
import { MacroData } from "@/lib/types";
import Sparkline from "./Sparkline";

// Bracket-style macro bar with three layout variants.
//
//   compact  (default) — inline `[SYM] +X.XX% ▲`, one row, no sparkline
//   detailed           — sparkline + price + change, two-line per item
//   marquee            — continuous horizontal scroll, hover to pause
//
// Variant is persisted to localStorage so a user setting (not yet exposed
// in the UI, but trivial to add) sticks across reloads.

export type MacroVariant = "compact" | "detailed" | "marquee";

const STORAGE_KEY = "asset-screener-macro-variant";

interface Props {
  variant?: MacroVariant;
  // Optional right-side slot rendered after the scrolling macro items —
  // used by the main page to inline HYPE pressure + attention movers so
  // the whole market context lives in one band.
  children?: React.ReactNode;
}

function fmtPrice(n: number): string {
  if (n < 0.01) return n.toPrecision(3);
  if (n < 1) return n.toPrecision(4);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function toneClass(n: number | null): string {
  if (n == null) return "tone-flat";
  if (n > 0.005) return "tone-up";
  if (n < -0.005) return "tone-down";
  return "tone-flat";
}

export default function MacroBar({ variant: variantProp, children }: Props) {
  const [macros, setMacros] = useState<MacroData[]>([]);
  const [variant, setVariant] = useState<MacroVariant>(variantProp ?? "compact");

  // Load variant from localStorage on mount unless prop pin overrides.
  useEffect(() => {
    if (variantProp) return;
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "compact" || stored === "detailed" || stored === "marquee") {
      setVariant(stored);
    }
  }, [variantProp]);

  useEffect(() => {
    // Bail on non-OK responses rather than .json()-ing the error body
    // (which would clobber the last-known macros with garbage). On
    // failure we keep the previous macros visible; the page-level
    // banner already tells the user the backend is down.
    const fetch_ = () =>
      fetch("/api/macro")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(setMacros)
        .catch(() => { /* keep last good macros */ });
    fetch_();
    const interval = setInterval(fetch_, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Marquee duplicates the list so the seam at -50% translate is
  // invisible. The CSS animation drives translateX(0 → -50%).
  const items = variant === "marquee" ? [...macros, ...macros] : macros;

  return (
    <div className={`macro-bar macro-${variant}`}>
      <span className="macro-label">MACRO</span>
      <div className="macro-items">
        {items.map((m, i) => {
          const tone = toneClass(m.change);
          return (
            <div key={`${m.symbol}-${i}`} className={`macro-item ${tone}`}>
              {variant === "detailed" && (
                <span className="macro-spark">
                  {/* Sparkline source: we don't have per-macro candle
                      history in /api/macro yet. Render an empty
                      placeholder for now — the redesign sets up the
                      slot; backfilling the data is a follow-up. */}
                  <Sparkline data={[]} width={48} height={18} strokeWidth={1.1} />
                </span>
              )}
              <div className="macro-text">
                <div className="macro-name">
                  <span className="sym macro-sym">{m.symbol}</span>
                  {m.source === "static" && (
                    <span className="macro-delayed">DELAYED</span>
                  )}
                </div>
                <div className="macro-line">
                  {variant === "detailed" && m.value != null && (
                    <span className="macro-val">{fmtPrice(m.value)}</span>
                  )}
                  {m.change != null ? (
                    <span className={`macro-chg pct-tri ${tone}`}>{fmtPct(m.change)}</span>
                  ) : (
                    <span className="macro-chg" style={{ color: "var(--text-mute)" }}>—</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {children}

      <style jsx>{`
        .macro-bar {
          display: flex; align-items: center; gap: 20px;
          padding: 10px 24px;
          border-bottom: .5px solid var(--border);
          background: var(--bg-macro);
        }
        .macro-label {
          font-size: 10px;
          letter-spacing: .14em;
          text-transform: uppercase;
          font-weight: 600;
          color: var(--text-mute);
          flex-shrink: 0;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        .macro-items {
          display: flex; flex: 1; gap: 18px;
          overflow-x: auto;
          scrollbar-width: none;
        }
        .macro-items::-webkit-scrollbar { display: none; }

        :global(.macro-item) {
          display: flex; gap: 8px; align-items: center; flex-shrink: 0;
          font-size: 11px;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        :global(.macro-item.tone-up .macro-spark) { color: var(--acc-up); }
        :global(.macro-item.tone-down .macro-spark) { color: var(--acc-down); }
        :global(.macro-item.tone-flat .macro-spark) { color: var(--text-mute); }
        :global(.macro-spark) { display: flex; }
        :global(.macro-text) { display: flex; flex-direction: column; gap: 2px; }
        :global(.macro-name) {
          display: flex; gap: 6px; align-items: center;
        }
        :global(.macro-sym) {
          font-size: 11px;
          color: var(--text);
          font-weight: 500;
        }
        :global(.macro-delayed) {
          font-size: 9px;
          letter-spacing: .12em;
          color: var(--text-mute);
          background: transparent;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        :global(.macro-line) {
          display: flex; gap: 6px; align-items: baseline;
        }
        :global(.macro-val) {
          color: var(--text-strong);
          font-size: 13px;
          font-weight: 500;
        }
        :global(.macro-chg) {
          font-size: 11px;
        }

        /* Compact — single line, no sparkline, no price */
        :global(.macro-compact .macro-spark) { display: none; }
        :global(.macro-compact .macro-text) { flex-direction: row; gap: 6px; align-items: baseline; }
        :global(.macro-compact .macro-val) { display: none; }

        /* Detailed — two-line, with spark + price + change */
        .macro-detailed { padding-top: 9px; padding-bottom: 9px; }

        /* Marquee — looping horizontal scroll */
        .macro-marquee { overflow: hidden; padding: 7px 0; gap: 0; }
        .macro-marquee .macro-label {
          flex-shrink: 0; padding: 0 16px; z-index: 2;
          background: linear-gradient(90deg, var(--bg-macro) 0%, var(--bg-macro) 70%, transparent 100%);
        }
        .macro-marquee .macro-items {
          gap: 24px;
          animation: macro-marquee 38s linear infinite;
          flex-wrap: nowrap;
          overflow: visible;
        }
        .macro-marquee:hover .macro-items { animation-play-state: paused; }
        :global(.macro-marquee .macro-spark) { display: none; }
        :global(.macro-marquee .macro-text) { flex-direction: row; gap: 6px; align-items: baseline; }
        :global(.macro-marquee .macro-val) { display: none; }
        @keyframes macro-marquee {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}
