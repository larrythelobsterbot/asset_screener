"use client";

// /terminal — read-only information terminal.
//
//   ┌─ header: back link · MacroBar (BTC/ETH/SPX) · HYPE pressure ──────┐
//   ├───────────────────────────────┬───────────────────────────────────┤
//   │  FeedStream (Tree News +       │  MoversPanel (top movers, 1h/4h/   │
//   │  later TG/Twitter), catalysts  │  24h) — the "Radar"                │
//   └───────────────────────────────┴───────────────────────────────────┘
//
// Symbol selection is shared: click a ticker chip in the feed or a row in
// the movers rail and both panels focus that symbol. Phase 2 adds OI /
// funding / liquidation cards to the Radar from /api/derivs.

import { useState } from "react";
import Link from "next/link";
import MacroBar from "@/components/MacroBar";
import HypePressureCard from "@/components/HypePressureCard";
import FeedStream from "@/components/FeedStream";
import MoversPanel from "@/components/MoversPanel";
import DerivsRadar from "@/components/DerivsRadar";

export default function Terminal() {
  const [symbol, setSymbol] = useState<string | null>(null);

  return (
    <main className="term">
      <header className="term-head">
        <div className="term-brand">
          <Link href="/" className="back">[ ← SCREENER ]</Link>
          <span className="term-name">TERMINAL</span>
        </div>
        <div className="term-macro"><MacroBar /></div>
        <HypePressureCard />
      </header>

      <section className="term-grid">
        <FeedStream symbol={symbol} onPickSymbol={setSymbol} />
        <div className="term-rail">
          <DerivsRadar symbol={symbol} onPickSymbol={setSymbol} />
          <MoversPanel symbol={symbol} onPickSymbol={setSymbol} />
        </div>
      </section>

      <style jsx>{`
        .term {
          height: 100vh;
          display: flex; flex-direction: column;
          padding: 12px;
          gap: 12px;
          background: var(--bg);
        }
        .term-head {
          display: flex; align-items: center; gap: 16px;
          flex: 0 0 auto;
          flex-wrap: wrap;
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
        .term-grid {
          flex: 1 1 auto;
          display: grid;
          grid-template-columns: 1fr 340px;
          gap: 12px;
          min-height: 0; /* let children scroll instead of growing the page */
        }
        .term-rail {
          display: grid;
          grid-template-rows: 3fr 2fr; /* Derivs radar gets the larger share */
          gap: 12px;
          min-height: 0;
        }
        @media (max-width: 820px) {
          .term-grid { grid-template-columns: 1fr; }
          .term-rail { grid-template-rows: 360px 280px; }
        }
      `}</style>
    </main>
  );
}
