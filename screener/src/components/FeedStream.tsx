"use client";

// The catalyst stream — center column of /terminal. Polls /api/feed and
// renders newest-first: relative time, source badge, author, headline
// (links out), and matched-ticker chips. Market-moving rows (importance 2:
// listings / hacks / ETF / macro) get a mustard rail so they catch the eye
// in a fast-scrolling feed. Source + "movers only" + symbol filters narrow
// the stream client-side via the same query the API already supports.

import { useEffect, useState, useCallback, useRef } from "react";
import type { FeedItem } from "@/app/api/feed/route";

const POLL_MS = 8_000;
const FRESH_PULSE_MS = 1800;

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const SOURCE_LABELS: Record<string, string> = {
  tree: "TREE",
  telegram: "TG",
  twitter: "X",
};

export default function FeedStream({
  symbol,
  onPickSymbol,
}: {
  symbol?: string | null;
  onPickSymbol?: (s: string | null) => void;
}) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [source, setSource] = useState<string>("all");
  const [moversOnly, setMoversOnly] = useState(false);
  const [now, setNow] = useState(() => 0);
  // Rows that arrived since the previous poll get a one-shot mustard pulse.
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  const maxSeenIdRef = useRef<number>(0);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (source !== "all") params.set("source", source);
    if (moversOnly) params.set("minImportance", "2");
    if (symbol) params.set("symbol", symbol);
    params.set("limit", "120");
    return fetch(`/api/feed?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items: FeedItem[] } | null) => {
        if (d?.items) {
          const prevMax = maxSeenIdRef.current;
          const incoming = new Set(
            d.items.filter((it) => prevMax > 0 && it.id > prevMax).map((it) => it.id)
          );
          maxSeenIdRef.current = Math.max(prevMax, ...d.items.map((it) => it.id), 0);
          setItems(d.items);
          if (incoming.size > 0) {
            setFreshIds(incoming);
            setTimeout(() => setFreshIds(new Set()), FRESH_PULSE_MS);
          }
        }
        setNow(Date.now());
      })
      .catch(() => { /* keep last known */ });
  }, [source, moversOnly, symbol]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) load(); };
    tick();
    const id = setInterval(tick, POLL_MS);
    // Re-tick the relative clock every 15s even without a fetch so "2m"
    // ages to "3m" without waiting for the next poll.
    const clock = setInterval(() => { if (!cancelled) setNow(Date.now()); }, 15_000);
    return () => { cancelled = true; clearInterval(id); clearInterval(clock); };
  }, [load]);

  return (
    <div className="feed">
      <div className="feed-bar">
        <span className="feed-title">FEED</span>
        <div className="seg">
          {["all", "tree"].map((s) => (
            <button key={s} className={source === s ? "on" : ""} onClick={() => setSource(s)}>
              {s === "all" ? "ALL" : (SOURCE_LABELS[s] ?? s.toUpperCase())}
            </button>
          ))}
          <button className={moversOnly ? "on" : ""} onClick={() => setMoversOnly((v) => !v)}>
            MOVERS
          </button>
        </div>
        {symbol && (
          <button className="sym-filter" onClick={() => onPickSymbol?.(null)}>
            [{symbol}] ✕
          </button>
        )}
      </div>

      <div className="feed-body">
        {items.length === 0 && (
          <div className="feed-empty">no items yet — waiting on the wire…</div>
        )}
        {items.map((it) => (
          <article key={it.id} className={`row imp-${it.importance} ${freshIds.has(it.id) ? "fresh" : ""}`}>
            <div className="row-meta">
              <span className="age">{relTime(it.ts, now || it.ts)}</span>
              <span className={`src src-${it.source}`}>{SOURCE_LABELS[it.source] ?? it.source}</span>
              {it.author && <span className="author">{it.author}</span>}
            </div>
            <div className="row-main">
              {it.url ? (
                <a href={it.url} target="_blank" rel="noopener noreferrer" className="headline">
                  {it.title}
                </a>
              ) : (
                <span className="headline">{it.title}</span>
              )}
              {it.symbols.length > 0 && (
                <span className="chips">
                  {it.symbols.map((s) => (
                    <button
                      key={s}
                      className="chip"
                      onClick={() => onPickSymbol?.(s === symbol ? null : s)}
                    >
                      {s}
                    </button>
                  ))}
                </span>
              )}
            </div>
          </article>
        ))}
      </div>

      <style jsx>{`
        .feed {
          display: flex; flex-direction: column;
          height: 100%;
          background: var(--bg-card);
          overflow: hidden;
        }
        .feed-bar {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 12px;
          border-bottom: .5px solid var(--border-soft);
          flex: 0 0 auto;
        }
        .feed-title {
          font-size: 11px; font-weight: 600; letter-spacing: .14em;
          color: var(--text-strong);
          font-family: var(--font-geist-mono), monospace;
        }
        .seg { display: flex; gap: 2px; }
        .seg > button {
          font-size: 10px; letter-spacing: .08em;
          padding: 3px 8px;
          background: var(--bg-chip);
          border: .5px solid var(--border);
          border-radius: var(--radius);
          color: var(--text-mute);
          cursor: pointer;
          font-family: var(--font-geist-mono), monospace;
        }
        .seg > button:hover { color: var(--text); }
        .seg > button.on {
          color: var(--acc-warn);
          border-color: color-mix(in oklab, var(--acc-warn) 40%, transparent);
          background: var(--bg-elev);
        }
        .sym-filter {
          margin-left: auto;
          font-size: 10px; letter-spacing: .06em;
          padding: 3px 8px;
          background: var(--bg-chip);
          border: .5px solid color-mix(in oklab, var(--acc-warn) 35%, transparent);
          border-radius: var(--radius);
          color: var(--acc-warn);
          cursor: pointer;
          font-family: var(--font-geist-mono), monospace;
        }
        .feed-body { overflow-y: auto; flex: 1 1 auto; }
        .feed-empty {
          padding: 24px; text-align: center;
          color: var(--text-mute); font-size: 12px;
          font-family: var(--font-geist-mono), monospace;
        }
        .row {
          padding: 8px 12px;
          border-bottom: .5px solid var(--border-soft);
        }
        .row:hover { background: var(--bg-row-h); }
        .row.imp-2 {
          border-left: 2px solid var(--acc-warn);
          background: color-mix(in oklab, var(--acc-warn) 5%, transparent);
        }
        .row.fresh { animation: feed-flash ${FRESH_PULSE_MS}ms ease-out; }
        @keyframes feed-flash {
          0%   { background: color-mix(in oklab, var(--acc-warn) 22%, transparent); }
          100% { background: transparent; }
        }
        .row-meta {
          display: flex; align-items: center; gap: 8px;
          margin-bottom: 3px;
          font-family: var(--font-geist-mono), monospace;
        }
        .age {
          font-size: 10px; color: var(--text-mute);
          min-width: 26px; font-variant-numeric: tabular-nums;
        }
        .src {
          font-size: 9px; letter-spacing: .1em; font-weight: 600;
          padding: 1px 5px; border-radius: var(--radius);
          color: var(--text-mute);
          border: .5px solid var(--border);
        }
        .src-tree { color: var(--acc-warn); border-color: color-mix(in oklab, var(--acc-warn) 30%, transparent); }
        .author {
          font-size: 10px; color: var(--text-mute);
          letter-spacing: .04em; text-transform: uppercase;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          max-width: 220px;
        }
        .row-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
        .headline {
          font-size: 13px; line-height: 1.35; color: var(--text);
          text-decoration: none;
        }
        a.headline:hover { color: var(--text-strong); text-decoration: underline; text-decoration-color: var(--acc-warn); }
        .chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
        .chip {
          font-size: 10px; letter-spacing: .04em;
          padding: 0 5px; border-radius: var(--radius);
          background: var(--bg-chip);
          border: .5px solid var(--border);
          color: var(--text-mute);
          cursor: pointer;
          font-family: var(--font-geist-mono), monospace;
        }
        .chip:hover { color: var(--acc-warn); border-color: color-mix(in oklab, var(--acc-warn) 35%, transparent); }
      `}</style>
    </div>
  );
}
