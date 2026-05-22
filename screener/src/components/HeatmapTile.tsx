"use client";

// Heatmap tile — absolutely positioned by parent treemap (x/y/w/h come in
// as props). Background = step-scaled heat color based on |change|.
// Visible content: bracketed sym + change %.

import { AssetData } from "@/lib/types";

interface Props {
  asset: AssetData;
  x: number;
  y: number;
  w: number;
  h: number;
  change: number | null;
  onClick: () => void;
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
}: Props) {
  const tiny = w < 50 || h < 36;

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
    <button
      onClick={onClick}
      className={`heatmap-tile ${toneClass}`}
      style={{
        position: "absolute",
        left: x, top: y, width: w, height: h,
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
      <style jsx>{`
        .heatmap-tile:hover {
          transform: scale(1.02);
          filter: brightness(1.2);
          z-index: 3;
        }
      `}</style>
    </button>
  );
}
