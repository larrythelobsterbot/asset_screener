import { startHlWs, getMid, getAllLiveMids } from "@/lib/hyperliquidWs";
import { displayScaleOf } from "@/lib/hyperliquid";

// Server-Sent Events: live HL mids pushed to the browser ~1/s.
//
// The server already holds a live WS to Hyperliquid (allMids) — this route
// just fans the in-memory map out to clients. SSE over EventSource gives
// auto-reconnect for free and slips through nginx with buffering disabled
// (X-Accel-Buffering: no). ?symbols=BTC,ETH limits the payload; without it
// we stream every fresh mid (~330 symbols, a few KB/s).

export const dynamic = "force-dynamic";

const PUSH_INTERVAL_MS = 1000;
// Must comfortably exceed the derivs radar's TOP_N (100): useLiveMids sends
// the radar's full base list sorted alphabetically, and this slice silently
// drops the tail. At the old cap of 80 the last ~20 symbols (SPX, SUI, TAO,
// XRP, ZEC, ...) never received a live mid and sat on the 20s-stale price.
const MAX_SYMBOLS = 150;
const STALE_MS = 60_000;

export async function GET(req: Request) {
  // Do not open the upstream websocket at build-time module import.
  startHlWs();

  const url = new URL(req.url);
  const symbols = (url.searchParams.get("symbols") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9@:]{1,20}$/.test(s))
    .slice(0, MAX_SYMBOLS);

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        // Mids leave this route in DISPLAY units. The WS map holds HL's raw
        // quotes, but every consumer of this stream (radar, tiles) renders
        // prices scaled for display — serving SPX raw here would make the
        // row flip between ~0.37 (live mid) and ~7400 (REST refresh).
        // NOTE: /api/markets does NOT read this route — it calls getMid()
        // directly and applies the scale itself; scaling in the WS map
        // instead would double-scale that path.
        const payload: Record<string, number> = {};
        if (symbols.length > 0) {
          for (const s of symbols) {
            const m = getMid(s);
            if (m != null) payload[s] = m * displayScaleOf(s);
          }
        } else {
          const now = Date.now();
          for (const [sym, e] of getAllLiveMids()) {
            if (now - e.ts < STALE_MS) payload[sym] = e.mid * displayScaleOf(sym);
          }
        }
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // Controller already closed (client gone) — stop pushing.
          if (timer) clearInterval(timer);
        }
      };
      send();
      timer = setInterval(send, PUSH_INTERVAL_MS);
      req.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx: don't buffer the stream
    },
  });
}
