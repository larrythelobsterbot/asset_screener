"use client";

// Timeframe segmented control — uses the global .seg class so the visual
// stays in sync with the Heatmap/Table view toggle.

const TIMEFRAMES = ["1h", "4h", "24h", "7d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

interface Props {
  selected: Timeframe;
  onChange: (tf: Timeframe) => void;
}

export default function TimeframeToggle({ selected, onChange }: Props) {
  return (
    <div className="seg">
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          onClick={() => onChange(tf)}
          className={selected === tf ? "on" : ""}
          style={{ textTransform: "uppercase" }}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}
