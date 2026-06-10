"use client";

// UTC clock + countdown to the next Hyperliquid funding settlement (hourly,
// on the hour). The countdown matters at 20x: holding a crowded-funding
// position through the tick is a real cost, and squeezes often cluster
// around funding boundaries.

import { useEffect, useState } from "react";

function pad(n: number): string { return String(n).padStart(2, "0"); }

export default function TermClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Render a stable placeholder during SSR/hydration (clock starts client-side).
  if (!now) {
    return (
      <div className="clock">
        <span className="utc">--:--:--</span>
        <span className="fund">FUNDING --:--</span>
        <style jsx>{clockCss}</style>
      </div>
    );
  }

  const secsToHour = 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
  const fm = Math.floor(secsToHour / 60);
  const fs = secsToHour % 60;
  const soon = secsToHour <= 300; // highlight the last 5 minutes

  return (
    <div className="clock">
      <span className="utc" suppressHydrationWarning>
        {pad(now.getUTCHours())}:{pad(now.getUTCMinutes())}:{pad(now.getUTCSeconds())}
        <em>UTC</em>
      </span>
      <span className={`fund ${soon ? "soon" : ""}`} title="Next hourly HL funding settlement" suppressHydrationWarning>
        FUNDING {pad(fm)}:{pad(fs)}
      </span>
      <style jsx>{clockCss}</style>
    </div>
  );
}

const clockCss = `
  .clock {
    display: flex; align-items: baseline; gap: 14px;
    font-family: var(--font-geist-mono), monospace;
    white-space: nowrap;
  }
  .utc {
    font-size: 13px; color: var(--text-strong);
    font-variant-numeric: tabular-nums; letter-spacing: .05em;
  }
  .utc em { font-style: normal; font-size: 9px; color: var(--text-mute); margin-left: 5px; letter-spacing: .12em; }
  .fund {
    font-size: 10px; color: var(--text-mute);
    letter-spacing: .1em; font-variant-numeric: tabular-nums;
  }
  .fund.soon { color: var(--acc-warn); }
`;
