"use client";

// 0-100 RSI gauge strip. Shows a 3-zone bar (oversold | neutral | overbought)
// with a dot at the current value. Designed for the screener table — fits
// in a ~80px wide cell next to the numeric RSI.

interface Props {
  value: number | null;
  width?: number;
  height?: number;
  showLabel?: boolean;
}

export default function RSIGauge({ value, width = 80, height = 14, showLabel = true }: Props) {
  if (value == null || !Number.isFinite(value)) {
    return (
      <span className="text-gray-600 text-[10px] font-mono">—</span>
    );
  }

  // Clamp so misbehaving inputs don't overflow the bar.
  const v = Math.max(0, Math.min(100, value));
  const dotX = (v / 100) * (width - 6); // 6 = dot diameter

  // 3-zone fill: red (0-30), neutral (30-70), green (70-100). Widths in %
  // since SVG nested rects don't need to be pixel-aligned.
  const oversoldW = (30 / 100) * width;
  const overboughtX = (70 / 100) * width;
  const overboughtW = width - overboughtX;

  // Dot color matches the zone the value sits in, so an "overbought" RSI
  // doesn't render as a neutral-looking marker.
  const dotColor =
    v >= 70 ? "#EF4444" : v <= 30 ? "#10B981" : "#E5E7EB";

  return (
    <div className="flex items-center gap-1.5">
      <svg width={width} height={height} aria-hidden="true">
        {/* Background bar */}
        <rect x={0} y={height / 2 - 1.5} width={width} height={3} rx={1.5}
          fill="rgba(255,255,255,0.05)" />
        {/* Oversold zone */}
        <rect x={0} y={height / 2 - 1.5} width={oversoldW} height={3} rx={1.5}
          fill="rgba(16,185,129,0.25)" />
        {/* Overbought zone */}
        <rect x={overboughtX} y={height / 2 - 1.5} width={overboughtW} height={3} rx={1.5}
          fill="rgba(239,68,68,0.25)" />
        {/* Current value dot */}
        <circle cx={dotX + 3} cy={height / 2} r={3} fill={dotColor} />
      </svg>
      {showLabel && (
        <span
          className={`text-[10px] font-mono ${
            v >= 70 ? "text-red-400" : v <= 30 ? "text-emerald-400" : "text-gray-400"
          }`}
        >
          {v.toFixed(0)}
        </span>
      )}
    </div>
  );
}
