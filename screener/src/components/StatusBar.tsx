"use client";

import { useEffect, useState } from "react";
import { createLatestRequestGate } from "@/lib/marketPolling";
import { getHealthView, type HealthTone } from "@/lib/healthDisplay";
import { initialHealthPollState, recordHealthError, recordHealthSuccess, type HealthPollState } from "@/lib/healthPolling";

const POLL_MS = 15_000;
const DISPLAY_TICK_MS = 1_000;
const readClock = () => ({ monotonic: performance.now(), wall: Date.now() });

function fmtAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export default function StatusBar() {
  const [state, setState] = useState<HealthPollState>(initialHealthPollState);
  const [clock, setClock] = useState(readClock);

  useEffect(() => {
    const gate = createLatestRequestGate();
    let controller: AbortController | null = null;
    const tick = () => setClock(readClock());
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const requestId = gate.start();
      try {
        const response = await fetch("/api/health", { signal: controller.signal, cache: "no-store" });
        if (!gate.isCurrent(requestId)) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value: unknown = await response.json();
        if (gate.isCurrent(requestId)) {
          const received = readClock();
          setState((previous) => recordHealthSuccess(previous, value, received.monotonic, received.wall));
          setClock(received);
        }
      } catch (error) {
        if (!gate.isCurrent(requestId) || (error instanceof DOMException && error.name === "AbortError")) return;
        setState((previous) => recordHealthError(previous, error));
        tick();
      }
    };
    const onResume = () => {
      if (document.visibilityState !== "visible") return;
      tick();
      void load();
    };
    void load();
    const poll = window.setInterval(load, POLL_MS);
    const display = window.setInterval(tick, DISPLAY_TICK_MS);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    return () => {
      gate.close();
      controller?.abort();
      window.clearInterval(poll);
      window.clearInterval(display);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, []);

  const view = getHealthView(state.receipt, clock.monotonic, state.error !== null, clock.wall);
  const sample = view.sample;
  const detail = view.availability === "unknown" ? "Health telemetry unavailable — waiting for a validated sample" : view.availability === "error" ? `Health request failed — last known readings qualified (${state.error})` : view.availability === "expired" ? "Health receipt expired — source ages are no longer current" : "Validated health telemetry";
  const healthLabel = view.availability === "unknown" ? "HEALTH LOADING" : view.availability === "error" ? `HEALTH UNAVAILABLE${sample ? " · LAST-KNOWN" : ""}` : view.availability === "expired" ? "HEALTH STALE · LAST-KNOWN" : sample?.status === "degraded" ? "HEALTH DEGRADED" : "HEALTH";
  const cell = (label: string, tone: HealthTone, title: string) => <span className={`cell t-${tone}`} title={title}><i className="dot" />{label}</span>;
  const qualifier = view.availability === "usable" ? "" : " · UNKNOWN";
  return (
    <div className="status" aria-label={detail}>
      <span className={`health-detail h-${view.availability}`} title={detail} role="status">{healthLabel}</span>
      {cell(`PRICES${qualifier}`, view.prices, sample ? `HL WS · ${sample.hlWs.symbolCount} symbols · last msg ${fmtAge(view.pricesAgeMs)} ago` : detail)}
      {cell(`SNAPSHOTS ${fmtAge(view.snapshotsAgeMs)}${qualifier}`, view.snapshots, "OI/funding time-series age (drives the radar)")}
      {cell(`FEED ${fmtAge(view.feedAgeMs)}${qualifier}`, view.feed, "newest Tree News item age")}
      {cell(sample?.treeWs.isSub === false ? `TREE·DELAYED${qualifier}` : `TREE${qualifier}`, view.tree, sample?.treeWs.authed && view.availability === "usable" ? "Tree socket authed (free tier = delayed items)" : "Tree telemetry unavailable or unauthenticated — REST backfill status unknown")}
      <span className="spacer" /><span className="brand">ASSET·TERMINAL</span>
      <style jsx>{`
        .status { display:flex; align-items:center; gap:18px; padding:5px 14px; font-family:var(--font-geist-mono),monospace; font-size:9px; letter-spacing:.12em; color:var(--text-mute); border-top:.5px solid var(--border); background:var(--bg-elev); flex-wrap:wrap; }
        .health-detail { color:var(--text-mute); white-space:nowrap; } .h-error, .h-expired { color:var(--acc-warn); } .h-unknown { color:var(--text-mute); }
        .cell { display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }
        .dot { width:6px; height:6px; border-radius:50%; display:inline-block; }
        .t-ok .dot { background:var(--acc-up); box-shadow:0 0 4px color-mix(in oklab,var(--acc-up) 60%,transparent); }
        .t-warn .dot { background:var(--acc-warn); box-shadow:0 0 4px color-mix(in oklab,var(--acc-warn) 60%,transparent); }
        .t-bad .dot { background:var(--acc-down); box-shadow:0 0 4px color-mix(in oklab,var(--acc-down) 60%,transparent); }
        .t-ok { color:var(--text-mute); } .t-warn { color:var(--acc-warn); } .t-bad { color:var(--acc-down); }
        .spacer { flex:1; } .brand { color:var(--text-mute); opacity:.5; letter-spacing:.25em; }
        @media (max-width:760px) { .status { gap:8px 12px; } .brand { display:none; } }
      `}</style>
    </div>
  );
}
