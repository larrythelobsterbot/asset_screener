import { startHlWs, getMid, getAllLiveMids } from "@/lib/hyperliquidWs";

// Server-Sent Events: live HL mids pushed to the browser ~1/s.
//
// The server already holds a live WS to Hyperliquid (allMids) — this route
// just fans the in-memory map out to clients. SSE over EventSource gives
// auto-reconnect for free and slips through nginx with buffering disabled
// (X-Accel-Buffering: no). ?symbols=BTC,ETH limits the payload; without it
// we stream every fresh mid (~330 symbols, a few KB/s).

startHlWs();

export const dynamic = "force-dynamic";

const PUSH_INTERVAL_MS = 1000;
const MAX_SYMBOLS = 80;
const STALE_MS = 60_000;

export async function GET(req: Request) {
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
        const payload: Record<string, number> = {};
        if (symbols.length > 0) {
          for (const s of symbols) {
            const m = getMid(s);
            if (m != null) payload[s] = m;
          }
        } else {
          const now = Date.now();
          for (const [sym, e] of getAllLiveMids()) {
            if (now - e.ts < STALE_MS) payload[sym] = e.mid;
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
