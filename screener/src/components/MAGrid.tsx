"use client";

// MA grid for the screener table. For a given asset at a given timeframe,
// shows ✓ / ✗ for each of 6 moving averages (EMA13/25/32, MA100, EMA200,
// MA300). Hover shows the MA value as a tooltip — keeps the cell compact
// but doesn't lose the underlying number.
//
// Design choice: ✓ green / ✗ red is the most scannable representation.
// We considered showing the MA value alongside (Finviz-style) but it
// triples the column width without adding information — the value is one
// hover away.

import type { ScreenerRow } from "@/app/api/screener/route";

const COLS: Array<{ key: keyof ScreenerRow["ma"]; label: string }> = [
  { key: "ema13",  label: "13" },
  { key: "ema25",  label: "25" },
  { key: "ema32",  label: "32" },
  { key: "ma100",  label: "100" },
  { key: "ema200", label: "200" },
  { key: "ma300",  label: "300" },
];

interface Props {
  row: Pick<ScreenerRow, "ma" | "above" | "last_close"> | null;
}

function fmtPrice(n: number): string {
  // Same logic as HeatmapTile so MA values look consistent with the price
  // cell in the same row.
  if (n < 0.01) return n.toPrecision(3);
  if (n < 1) return n.toPrecision(4);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function MAGrid({ row }: Props) {
  if (!row) {
    // Empty placeholder — 6 dashes so the column doesn't reflow when
    // rows alternate between data/no-data.
    return (
      <div className="flex items-center gap-1">
        {COLS.map((c) => (
          <span key={c.key} className="text-[10px] text-gray-700 font-mono w-6 text-center">—</span>
        ))}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {COLS.map((c) => {
        const above = row.above[c.key];
        const ma = row.ma[c.key];
        if (above == null || ma == null) {
          return (
            <span
              key={c.key}
              className="text-[10px] text-gray-700 font-mono w-6 text-center"
              title={`MA${c.label} not yet computed`}
            >
              —
            </span>
          );
        }
        return (
          <span
            key={c.key}
            className={`text-[10px] font-mono w-6 text-center ${
              above ? "text-emerald-400" : "text-red-400"
            }`}
            title={`MA${c.label} = ${fmtPrice(ma)} (price ${above ? ">" : "<"} MA${c.label})`}
          >
            {above ? "✓" : "✗"}
            <span className="text-gray-600 ml-0.5">{c.label}</span>
          </span>
        );
      })}
    </div>
  );
}
