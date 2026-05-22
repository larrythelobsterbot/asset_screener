"use client";

// Heatmap tile — absolutely positioned by parent treemap (x/y/w/h come in
// as props). Background = step-scaled heat color based on |change|.
// Visible content: bracketed sym + change %, plus a hover-only ✕/↻
// button in the top-right corner that toggles the hide-list.

import { AssetData } from "@/lib/types";

interface Props {
  asset: AssetData;
  x: number;
  y: number;
  w: number;
  h: number;
  change: number | null;
  onClick: () => void;
  // Optional hide-list integration. When provided, a small action
  // button appears in the top-right of the tile on hover.
  isHidden?: boolean;
  onToggleHide?: (symbol: string) => void;
}

// Six-step intensity scale matching the design handoff:
// <0.5→10, <1→22, <2→38, <5→55, <10→72, else→88.
function heatStep(abs: number): number {
  if (abs < 0.5) return 10;
  if (abs < 1) return 22;
  if (abs < 2) return 38;
  if (abs < 5) return 55;
  if (abs < 10) return 72;
  return 88;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export default function HeatmapTile({
  asset, x, y, w, h, change, onClick,
  isHidden = false, onToggleHide,
}: Props) {
  const tiny = w < 50 || h < 36;
  // Suppress the hide button on tiny tiles — it would overlap the sym
  // label. The user can still hide them via the table view.
  const showHideBtn = !!onToggleHide && !tiny;

  let bg: string;
  if (change == null) {
    bg = "rgba(255,255,255,0.04)";
  } else {
    const step = heatStep(Math.abs(change));
    const hue = change >= 0 ? "up" : "down";
    bg = `var(--heat-${hue}-${step})`;
  }

  const toneClass = change == null ? "tone-flat" : change >= 0 ? "tone-up" : "tone-down";

  return (
    <div
      className={`heatmap-tile-wrap ${isHidden ? "tile-hidden" : ""}`}
      style={{
        position: "absolute",
        left: x, top: y, width: w, height: h,
      }}
    >
      <button
        onClick={onClick}
        className={`heatmap-tile ${toneClass}`}
        style={{
          width: "100%", height: "100%",
          background: bg,
          border: ".5px solid rgba(0,0,0,0.4)",
          display: "flex", flexDirection: "column",
          alignItems: "flex-start", justifyContent: "flex-start",
          padding: "6px 8px",
          fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          color: "var(--text-strong)",
          textAlign: "left",
          cursor: "pointer",
          transition: "transform .12s, filter .12s",
          overflow: "hidden",
          boxSizing: "border-box",
        }}
        title={`${asset.name} (${asset.symbol}) — ${fmtPct(change)}`}
      >
        <span className="sym" style={{ fontSize: 12, fontWeight: 600 }}>
          {asset.symbol}
        </span>
        {!tiny && (
          <span
            className={`pct-tri ${toneClass}`}
            style={{ fontSize: 10, opacity: 0.95, marginTop: 2 }}
          >
            {fmtPct(change)}
          </span>
        )}
      </button>

      {showHideBtn && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleHide!(asset.symbol); }}
          className={`tile-hide ${isHidden ? "tile-hide-on" : ""}`}
          title={isHidden ? "Unhide this asset" : "Hide this asset"}
          aria-label={isHidden ? "Unhide" : "Hide"}
        >
          {isHidden ? "↻" : "✕"}
        </button>
      )}

      <style jsx>{`
        .heatmap-tile-wrap {
          /* Wrapper exists only to host the absolutely-positioned hide
             button. The clickable tile fills 100% so background +
             hover-scale behave exactly as before. */
        }
        .heatmap-tile-wrap.tile-hidden {
          opacity: 0.4;
          transition: opacity .15s;
        }
        .heatmap-tile-wrap.tile-hidden:hover {
          opacity: 0.85;
        }
        .heatmap-tile:hover {
          transform: scale(1.02);
          filter: brightness(1.2);
          z-index: 3;
        }
        .tile-hide {
          position: absolute;
          top: 4px; right: 4px;
          width: 16px; height: 16px;
          border: 0; background: rgba(0,0,0,0.35);
          color: var(--text-strong);
          font-size: 10px; line-height: 1;
          border-radius: 2px;
          cursor: pointer;
          opacity: 0;
          transition: opacity .15s, background .15s, color .15s;
          z-index: 4;
          padding: 0;
        }
        .heatmap-tile-wrap:hover .tile-hide { opacity: 0.9; }
        .tile-hide:hover {
          background: var(--acc-down);
          color: var(--text-strong);
          opacity: 1;
        }
        .tile-hide.tile-hide-on {
          background: rgba(212, 197, 72, 0.85);
          color: var(--bg);
          opacity: 1;
        }
      `}</style>
    </div>
  );
}
