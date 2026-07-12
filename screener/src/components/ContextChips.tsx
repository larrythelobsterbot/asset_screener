"use client";

// Right-side slot for the macro bar: HYPE TWAP pressure + top attention
// movers, compressed into inline chips so the whole market context sits
// in ONE band. Replaces the floating HypePressureCard on the main page
// (the full card still lives on /terminal where there's a rail for it).

import { useEffect, useState } from "react";
import type { PressureResponse } from "@/app/api/hype/pressure/route";
import { useAttention, attentionTone } from "@/lib/useAttention";

function fmtUsdCompact(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3)}K`;
  return `${sign}$${Math.round(abs)}`;
}

interface Props {
  onSelectAsset?: (symbol: string) => void;
}

export default function ContextChips({ onSelectAsset }: Props) {
  const [pressure, setPressure] = useState<PressureResponse | null>(null);
  const { top } = useAttention();

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      fetch("/api/hype/pressure")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: PressureResponse | null) => {
          if (!cancelled && d) setPressure(d);
        })
        .catch(() => { /* keep last known */ });
    tick();
    const id = setInterval(tick, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const hot = pressure != null && pressure.pressure_1h_usd >= pressure.threshold_usd;
  const movers = top.slice(0, 3);

  return (
    <div className="ctx">
      {pressure && (
        <span
          className={`ctx-chip ${hot ? "ctx-hot" : ""}`}
          title={`HYPE TWAP buy pressure — next 1h ${fmtUsdCompact(pressure.pressure_1h_usd)}, next 24h ${fmtUsdCompact(pressure.pressure_24h_usd)} · ${pressure.active_twap_count} active TWAPs`}
        >
          <span className="ctx-label">HYPE TWAP</span>
          <span className={`ctx-val ${pressure.pressure_1h_usd > 0 ? "tone-up" : pressure.pressure_1h_usd < 0 ? "tone-down" : "tone-flat"}`}>
            {fmtUsdCompact(pressure.pressure_1h_usd)}
          </span>
          <span className="ctx-sub">1h</span>
        </span>
      )}
      {movers.length > 0 && (
        <span className="ctx-chip" title="Top attention movers — mention acceleration vs trailing baseline (Attention Radar)">
          <span className="ctx-label">👁</span>
          {movers.map((m) => {
            const tone = attentionTone(m.klass);
            return (
              <button
                key={m.symbol}
                className={`ctx-mover ${tone ? `mv-${tone}` : ""} ${m.isHL && onSelectAsset ? "mv-click" : ""}`}
                onClick={m.isHL && onSelectAsset ? () => onSelectAsset(m.symbol) : undefined}
                title={`${m.symbol}: ${m.mentions} mentions, ${m.accel.toFixed(1)}× baseline (${m.klass?.replace("_", " ")})`}
              >
                {m.symbol} {m.accel.toFixed(1)}×
              </button>
            );
          })}
        </span>
      )}

      <style jsx>{`
        .ctx {
          display: flex; align-items: center; gap: 10px;
          flex-shrink: 0;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        .ctx-chip {
          display: flex; align-items: center; gap: 6px;
          padding: 2px 8px;
          background: var(--bg-chip);
          border: 0.5px solid var(--border-soft);
          border-radius: 3px;
          font-size: 10px;
          white-space: nowrap;
        }
        .ctx-chip.ctx-hot {
          border-color: color-mix(in oklab, var(--acc-warn) 45%, transparent);
          background: color-mix(in oklab, var(--acc-warn) 10%, transparent);
        }
        .ctx-label {
          color: var(--text-mute);
          letter-spacing: 0.1em;
          font-size: 9px;
          text-transform: uppercase;
        }
        .ctx-val { font-variant-numeric: tabular-nums; }
        .ctx-sub { color: var(--text-mute); font-size: 9px; }
        .ctx-mover {
          background: transparent;
          border: 0;
          padding: 0 2px;
          font-family: inherit;
          font-size: 10px;
          color: var(--text);
          font-variant-numeric: tabular-nums;
          cursor: default;
        }
        .ctx-mover.mv-click { cursor: pointer; }
        .ctx-mover.mv-click:hover { text-decoration: underline; }
        .ctx-mover.mv-warn { color: var(--acc-warn); }
        .ctx-mover.mv-up { color: var(--acc-up); }
        .ctx-mover.mv-down { color: var(--acc-down); }
        .ctx-mover + .ctx-mover {
          border-left: 0.5px solid var(--border-soft);
          padding-left: 6px;
          margin-left: 2px;
        }
        @media (max-width: 900px) {
          .ctx { display: none; }
        }
      `}</style>
    </div>
  );
}
