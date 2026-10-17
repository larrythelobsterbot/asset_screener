"use client";

import { useEffect, useState } from "react";
import { ageSignalSnapshot, signalSnapshotStatusText, type SignalSnapshotRead } from "@/lib/signalSnapshotDisplay";

export default function SignalSnapshotStatus({ read, error, now }: { read: SignalSnapshotRead; error: string | null; now?: number }) {
  const [clock, setClock] = useState(() => ({ wall: Date.now(), monotonic: performance.now() }));
  useEffect(() => {
    const tick = () => setClock({ wall: Date.now(), monotonic: performance.now() });
    const onResume = () => { if (document.visibilityState === "visible") tick(); };
    tick();
    const id = window.setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, [read]);
  const view = ageSignalSnapshot(read, now ?? clock.wall, error !== null, clock.monotonic);
  const text = signalSnapshotStatusText(view);
  return (
    <div role={error ? "alert" : "status"} aria-live="polite" className={`signal-status signal-${view.status}`}>
      <span className="signal-status-mark">{view.status === "current" ? "●" : "!"}</span>
      <span>{text}</span>
      {view.ageMs !== null && <span aria-live="off"> · {Math.round(view.ageMs / 1000)}s old</span>}
      <span> · cached signal evidence is not trade-alert eligibility; scan coverage unknown</span>
      <style jsx>{`
        .signal-status { margin:0 24px 10px; padding:7px 10px; display:flex; flex-wrap:wrap; gap:6px; font:10px/1.4 var(--font-geist-mono),monospace; letter-spacing:.04em; border:1px solid color-mix(in oklab,var(--border) 70%,transparent); color:var(--text-mute); }
        .signal-status-mark { color:var(--acc-warn); } .signal-current .signal-status-mark { color:var(--acc-up); }
        .signal-stale, .signal-partial, .signal-unavailable { color:var(--acc-warn); border-color:color-mix(in oklab,var(--acc-warn) 35%,transparent); }
        .signal-unknown { color:var(--text-mute); }
        @media (max-width:760px) { .signal-status { margin-left:10px; margin-right:10px; } }
      `}</style>
    </div>
  );
}
