"use client";

// /terminal — read-only information terminal, v2 (full-bleed).
//
//   ┌─ [←] [JOURNAL]  TERMINAL · macro · clock+funding · HYPE pressure ──┐
//   ├──────────────────────────────────┬──────────────────────────────────┤
//   │ FEED (Tree News, flash-in)        │ RADAR (OI×price, sparklines,     │
//   │                                   │   live SSE prices)               │
//   │                                   ├──────────────────────────────────┤
//   │                                   │ VARIATIONAL (funding arb)        │
//   │                                   ├──────────────────────────────────┤
//   │                                   │ MOVERS (1h/4h/24h)               │
//   ├──────────────────────────────────┴──────────────────────────────────┤
//   │ STATUS — prices·snapshots·feed·tree dots, data ages                  │
//   └──────────────────────────────────────────────────────────────────────┘
//
// Layout uses the 1px-gap trick: the grid's background is the hairline
// color and panels are opaque, so dividers render without per-panel
// borders. Symbol selection cross-filters feed ↔ radar ↔ movers.

import { useState } from "react";
import Link from "next/link";
import MacroBar from "@/components/MacroBar";
import HypePressureCard from "@/components/HypePressureCard";
import FeedStream from "@/components/FeedStream";
import MoversPanel from "@/components/MoversPanel";
import DerivsRadar from "@/components/DerivsRadar";
import SmartFlowPanel from "@/components/SmartFlowPanel";
import VariationalPanel from "@/components/VariationalPanel";
import TermClock from "@/components/TermClock";
import StatusBar from "@/components/StatusBar";

export default function Terminal() {
  const [symbol, setSymbol] = useState<string | null>(null);

  return (
    <main className="term">
      <header className="term-head">
        <div className="term-brand">
          <Link href="/" className="back">[ ← SCREENER ]</Link>
          <Link href="/journal" className="back">[ JOURNAL ]</Link>
          <span className="term-name">TERMINAL</span>
        </div>
        <div className="term-macro"><MacroBar /></div>
        <TermClock />
        <div className="term-hype"><HypePressureCard /></div>
      </header>

      <section className="term-frame">
        <div className="term-grid">
          <div className="cell feed-cell"><FeedStream symbol={symbol} onPickSymbol={setSymbol} /></div>
          <div className="term-rail">
            <div className="cell rail-radar"><DerivsRadar symbol={symbol} onPickSymbol={setSymbol} /></div>
            <div className="cell rail-smartflow"><SmartFlowPanel /></div>
            <div className="cell rail-var"><VariationalPanel /></div>
            <div className="cell rail-movers"><MoversPanel symbol={symbol} onPickSymbol={setSymbol} /></div>
          </div>
        </div>
        <StatusBar />
      </section>

      <style jsx>{`
        .term {
          height: 100vh;
          display: flex; flex-direction: column;
          padding: 10px 12px 12px;
          gap: 10px;
          background: var(--bg);
        }
        .term-head {
          display: flex; align-items: center; gap: 18px;
          flex: 0 0 auto; flex-wrap: wrap;
        }
        .term-brand {
          display: flex; align-items: baseline; gap: 12px;
          font-family: var(--font-geist-mono), monospace;
        }
        .back {
          font-size: 11px; letter-spacing: .08em;
          color: var(--text-mute); text-decoration: none;
        }
        .back:hover { color: var(--acc-warn); }
        .term-name {
          font-size: 13px; font-weight: 700; letter-spacing: .2em;
          color: var(--text-strong);
        }
        .term-macro { flex: 1 1 auto; min-width: 0; overflow: hidden; }
        .term-hype { flex: 0 0 auto; }

        /* Full-bleed frame: one outer border, hairline internal dividers
           via gap+background. Panels must keep opaque backgrounds. */
        .term-frame {
          flex: 1 1 auto; min-height: 0;
          display: flex; flex-direction: column;
          border: .5px solid var(--border);
          border-radius: var(--radius);
          overflow: hidden;
          background: var(--border-soft);
        }
        .term-grid {
          flex: 1 1 auto; min-height: 0;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 400px;
          gap: 1px;
        }
        .term-rail {
          display: grid;
          grid-template-rows: minmax(0, 5fr) minmax(0, 3fr) minmax(0, 3fr) minmax(0, 4fr);
          gap: 1px;
          min-height: 0;
        }
        .cell { min-height: 0; min-width: 0; background: var(--bg-card); }

        @media (max-width: 900px) {
          .term { height: auto; }
          .term-grid { grid-template-columns: 1fr; }
          .feed-cell { height: 60vh; }
          .term-rail { grid-template-rows: 380px 200px 180px 260px; }
        }
      `}</style>
    </main>
  );
}
