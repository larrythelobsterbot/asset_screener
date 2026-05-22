"use client";

// MomentumCell — a single % change rendered with a magnitude-tinted
// background. Used in the side panel's [ MOMENTUM ] grid (1H/4H/24H/7D)
// and could be reused elsewhere where we want the same visual.
//
// The tint scales linearly with |change|/scale, capped at 1. Per the
// design spec the scale differs by horizon: shorter horizons cap at
// smaller magnitudes (a 2% move in 1H is huge) so the tints are
// comparable across the row.

interface Props {
  label: string;
  value: number | null;
  // Magnitude at which the tint reaches full intensity. Defaults match
  // the design: 1H = 2, 4H = 4, 24H = 8, 7D = 25.
  scale?: number;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function tone(v: number | null): "up" | "down" | "flat" {
  if (v == null) return "flat";
  if (v > 0.005) return "up";
  if (v < -0.005) return "down";
  return "flat";
}

export default function MomentumCell({ label, value, scale = 5 }: Props) {
  const t = tone(value);
  const abs = value == null ? 0 : Math.min(Math.abs(value) / scale, 1);
  const color =
    t === "up" ? "var(--acc-up)" :
    t === "down" ? "var(--acc-down)" :
    "var(--text-mute)";

  return (
    <div
      style={{
        padding: "12px 10px",
        borderRadius: "var(--radius)",
        // Background tints currentColor — set via the inline color below
        // so the color-mix tracks the up/down/flat state correctly.
        background: `color-mix(in oklab, ${color} ${(abs * 22).toFixed(0)}%, var(--bg-chip))`,
        border: `0.5px solid color-mix(in oklab, ${color} ${(abs * 30).toFixed(0)}%, var(--border-soft))`,
        color,
      }}
    >
      <div style={{
        fontSize: 9,
        color: "var(--text-mute)",
        letterSpacing: ".12em",
        textTransform: "uppercase",
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 16,
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        fontWeight: 500,
        marginTop: 4,
        color,
      }}>
        {fmtPct(value)}
      </div>
    </div>
  );
}
