"use client";

// Bracket-style horizontal RSI bar. 0–100 track with shaded zones at
// 0–30 (oversold, red tint) and 70–100 (overbought, green tint) — at
// extremes the indicator implies a tradable signal regardless of trend
// direction, so the zone tint is informational, not directional.
//
// Two flavors:
//   default  — table row width (small, 70px), inline with the price row
//   `large`  — side-panel hero gauge (fat 32px track with grid ticks)
//
// Value is clamped to [0, 100] so misbehaving inputs don't push the dot
// past the bar.

interface Props {
  value: number | null;
  width?: number;
  large?: boolean;
}

export default function RSIGauge({ value, width = 70, large = false }: Props) {
  if (value == null || !Number.isFinite(value)) {
    return <span style={{ color: "var(--text-mute)", fontSize: 10 }}>—</span>;
  }
  const v = Math.max(0, Math.min(100, value));
  const state = v < 30 ? "os" : v > 70 ? "ob" : "neu";

  if (large) {
    // Side-panel hero gauge — 32px tall, with 20/40/60/80 grid ticks.
    return (
      <div>
        <div
          style={{
            position: "relative",
            height: 32,
            background: "var(--bg-chip)",
            borderRadius: 4,
            overflow: "hidden",
            marginBottom: 6,
          }}
        >
          <div style={{
            position: "absolute", top: 0, bottom: 0, left: 0, width: "30%",
            background: "color-mix(in oklab, var(--acc-down) 22%, transparent)",
          }} />
          <div style={{
            position: "absolute", top: 0, bottom: 0, left: "70%", right: 0,
            background: "color-mix(in oklab, var(--acc-up) 22%, transparent)",
          }} />
          {[20, 40, 60, 80].map((t) => (
            <span key={t} style={{
              position: "absolute", top: 0, bottom: 0, left: `${t}%`,
              width: 1, background: "var(--border-soft)",
            }} />
          ))}
          <div style={{
            position: "absolute", top: "50%", left: `${v}%`,
            transform: "translate(-50%, -50%)",
            width: 18, height: 18, borderRadius: "50%",
            background: state === "ob" ? "var(--acc-up)" : state === "os" ? "var(--acc-down)" : "var(--text-strong)",
            boxShadow: "0 0 0 3px var(--bg-card), 0 2px 8px rgba(0,0,0,0.4)",
          }} />
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between",
          fontSize: 9, color: "var(--text-mute)",
          fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        }}>
          <span>0</span><span>30</span><span>50</span><span>70</span><span>100</span>
        </div>
        <div style={{
          marginTop: 8, fontSize: 11,
          letterSpacing: ".12em", textTransform: "uppercase",
          color: "var(--text)",
        }}>
          {state === "ob" ? "Overbought" : state === "os" ? "Oversold" : "Neutral"}
        </div>
      </div>
    );
  }

  // Table-row variant: compact horizontal bar + numeric value.
  const dotColor =
    state === "ob" ? "var(--acc-up)" :
    state === "os" ? "var(--acc-down)" :
    "var(--text-strong)";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, width }}>
      <div style={{
        position: "relative",
        height: 4,
        borderRadius: 2,
        background: "var(--bg-chip)",
        flex: 1,
        minWidth: 40,
        overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", top: 0, bottom: 0, left: 0, width: "30%",
          background: "color-mix(in oklab, var(--acc-down) 18%, transparent)",
        }} />
        <div style={{
          position: "absolute", top: 0, bottom: 0, left: "70%", right: 0,
          background: "color-mix(in oklab, var(--acc-up) 18%, transparent)",
        }} />
        <div style={{
          position: "absolute", top: "50%", left: `${v}%`,
          transform: "translate(-50%, -50%)",
          width: 8, height: 8, borderRadius: "50%",
          background: dotColor,
          boxShadow: "0 0 0 1.5px var(--bg-card)",
        }} />
      </div>
      <span style={{
        fontSize: 10,
        color: "var(--text-mute)",
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        width: 18,
        textAlign: "right",
      }}>
        {Math.round(v)}
      </span>
    </div>
  );
}
