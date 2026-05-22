"use client";

// SVG sparkline. The Bracket redesign drives all color through CSS:
// stroke + fill both use `currentColor`, so the parent's `.tone-up` /
// `.tone-down` class decides the spark's color. This keeps the spark in
// sync with the % cell it represents without duplicating logic.

interface Props {
  data: number[];
  width?: number;
  height?: number;
  // When true, paint a faint filled area below the line (used in the
  // side panel hero chart). Tiles + table rows typically don't fill so
  // the line reads crisp against the row background.
  fill?: boolean;
  strokeWidth?: number;
}

export default function Sparkline({
  data,
  width = 80,
  height = 24,
  fill = false,
  strokeWidth = 1.25,
}: Props) {
  if (!data || data.length < 2) {
    // Render an inert dash so the column doesn't reflow between rows
    // with and without data.
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line
          x1={2} y1={height / 2} x2={width - 2} y2={height / 2}
          stroke="rgba(255,255,255,0.1)" strokeWidth={1}
        />
      </svg>
    );
  }

  // Normalize values to [0, 1] so the line uses the full y-range.
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const pad = 1.5;
  const n = data.length;
  const x = (i: number) => pad + (i / (n - 1)) * (width - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / range) * (height - 2 * pad);

  let d = "";
  for (let i = 0; i < n; i++) {
    d += (i === 0 ? "M" : "L") + x(i).toFixed(2) + " " + y(data[i]).toFixed(2);
  }
  const last = data[n - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {fill && (
        <path
          d={d + ` L${x(n - 1)} ${height} L${x(0)} ${height} Z`}
          fill="currentColor"
          opacity="0.12"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(n - 1)} cy={y(last)} r={1.6} fill="currentColor" />
    </svg>
  );
}
