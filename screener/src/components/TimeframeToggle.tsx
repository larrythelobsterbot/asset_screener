"use client";

const TIMEFRAMES = ["1h", "4h", "24h", "7d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

interface Props {
  selected: Timeframe;
  onChange: (tf: Timeframe) => void;
}

export default function TimeframeToggle({ selected, onChange }: Props) {
  return (
    <div className="flex items-center gap-1 bg-surface rounded-lg p-1">
      {TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          onClick={() => onChange(tf)}
          className={`px-3 py-1.5 rounded-md text-xs font-medium uppercase transition-all ${
            selected === tf
              ? "bg-white/10 text-white shadow-sm"
              : "text-gray-500 hover:text-gray-300"
          }`}
        >
          {tf}
        </button>
      ))}
    </div>
  );
}
