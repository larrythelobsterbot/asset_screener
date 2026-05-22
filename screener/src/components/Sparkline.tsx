"use client";

// Minimal SVG sparkline. Renders a polyline scaled to the component's
// (width, height) box. Colors itself green if the series finished above
// where it started, red otherwise — matches the screener-row palette.
// Empty / single-point series render as a flat dash so the column doesn't
// jump in size between rows that have data and rows that don't.

interface Props {
  data: number[];
  width?: number;
  height?: number;
  // If provided, override the auto-derived stroke color. Used when the
  // caller wants the sparkline tinted by sector instead of by net direction.
  color?: string;
}

export default function Sparkline({ data, width = 70, height = 22, color }: Props) {
  if (!data || data.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line
          x1={2} y1={height / 2} x2={width - 2} y2={height / 2}
          stroke="rgba(255,255,255,0.1)" strokeWidth={1}
        />
      </svg>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1; // guard against flat series

  // Polyline points, scaled to (width × height) with 1px padding so the
  // stroke doesn't get clipped at the box edges.
  const stepX = (width - 2) / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = 1 + i * stepX;
      // Invert y so higher prices render at the top of the box.
      const y = 1 + ((max - v) / range) * (height - 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const isUp = data[data.length - 1] >= data[0];
  const stroke = color ?? (isUp ? "#10B981" : "#EF4444");

  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
