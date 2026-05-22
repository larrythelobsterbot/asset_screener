"use client";

// MA Ribbon — six small cells showing price-above-MA at a glance.
// Background tint = state (green above / red below). The cell content is
// the period number itself (13/25/32/100/200/300), which doubles as the
// label and saves the ✓/✗ glyph + adjacent label of the old design.
//
// Tooltip surfaces the underlying MA value so a power user can still
// see "where" without us forcing a wider column.

import type { ScreenerRow } from "@/app/api/screener/route";

const COLS: Array<{ key: keyof ScreenerRow["ma"]; label: string }> = [
  { key: "ema13",  label: "13"  },
  { key: "ema25",  label: "25"  },
  { key: "ema32",  label: "32"  },
  { key: "ma100",  label: "100" },
  { key: "ema200", label: "200" },
  { key: "ma300",  label: "300" },
];

function fmtPrice(n: number): string {
  if (n < 0.01) return n.toPrecision(3);
  if (n < 1) return n.toPrecision(4);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Props {
  row: Pick<ScreenerRow, "ma" | "above" | "last_close"> | null;
}

export default function MAGrid({ row }: Props) {
  if (!row) {
    return (
      <span style={{ color: "var(--text-mute)", fontSize: 11 }}>—</span>
    );
  }

  return (
    <div style={{ display: "flex", gap: 2 }}>
      {COLS.map((c) => {
        const above = row.above[c.key];
        const ma = row.ma[c.key];
        if (above == null || ma == null) {
          return (
            <span
              key={c.key}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                minWidth: 22, height: 16, padding: "0 3px",
                borderRadius: 3,
                fontSize: 9,
                fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
                fontWeight: 500,
                color: "var(--text-mute)",
                background: "transparent",
              }}
              title={`MA${c.label} not yet computed`}
            >
              {c.label}
            </span>
          );
        }
        const onStyle = {
          background: "color-mix(in oklab, var(--acc-up) 18%, transparent)",
          color: "var(--acc-up)",
        };
        const offStyle = {
          background: "color-mix(in oklab, var(--acc-down) 14%, transparent)",
          color: "color-mix(in oklab, var(--acc-down) 80%, var(--text-mute))",
        };
        return (
          <span
            key={c.key}
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              minWidth: 22, height: 16, padding: "0 3px",
              borderRadius: 3,
              fontSize: 9,
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
              fontWeight: 500,
              ...(above ? onStyle : offStyle),
            }}
            title={`MA${c.label} = ${fmtPrice(ma)} (price ${above ? ">" : "<"} MA${c.label})`}
          >
            {c.label}
          </span>
        );
      })}
    </div>
  );
}
