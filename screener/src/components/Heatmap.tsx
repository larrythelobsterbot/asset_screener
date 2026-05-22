"use client";

// Squarified treemap heatmap. Two passes: outer for sectors (sized by sum
// of their assets' weights), inner for assets within each sector (sized
// by per-asset weight = log10(marketCap || vol24h || 1e6) / 1e6 + 1).
//
// The +1 inside log10 keeps tiny markets from yielding negative weights;
// the log keeps a 50B asset from crushing a 100M one off the canvas.
//
// Key constraint flagged in the design handoff: when laying out the inner
// tiles, OFFSET BY THE SECTOR HEADER HEIGHT (22px). Otherwise the first
// tile in each group sits underneath the header label.

import { useEffect, useMemo, useRef, useState } from "react";
import { AssetData } from "@/lib/types";
import { SECTORS, Sector } from "@/config/sectors";
import { Timeframe } from "./TimeframeToggle";
import HeatmapTile from "./HeatmapTile";

interface Props {
  assets: AssetData[];
  isLoading: boolean;
  timeframe: Timeframe;
  onSelectAsset: (symbol: string) => void;
  showWatchlistOnly: boolean;
  watchlist: Set<string>;
  onToggleWatch: (symbol: string) => void;
  // Hide-list. When showHidden=false page.tsx already filtered these out
  // before the assets prop. When true, hidden tiles render dimmed so the
  // user can spot and unhide them via the tile's ✕/↻ button.
  hidden?: Set<string>;
  onToggleHide?: (symbol: string) => void;
  showHidden?: boolean;
}

// ── Squarify ─────────────────────────────────────────────────────────────
// Generic over the input shape (anything with .value). Returns the same
// shape augmented with the geometry the algorithm computes — x, y, w, h.
// Callers can read those off the return without unsafe casts.

type Placed = { x: number; y: number; w: number; h: number };
type Internal = Placed & { _area: number };

function worstRatio(row: Internal[], side: number): number {
  let s = 0, mn = Infinity, mx = -Infinity;
  for (const n of row) {
    s += n._area;
    if (n._area < mn) mn = n._area;
    if (n._area > mx) mx = n._area;
  }
  const s2 = side * side;
  const sum2 = s * s;
  return Math.max((s2 * mx) / sum2, sum2 / (s2 * mn));
}

function squarify<T extends { value: number }>(
  nodes: T[], x: number, y: number, w: number, h: number
): (T & Placed)[] {
  // Skip zero/negative values and exit cleanly for degenerate viewports.
  const valid = nodes.filter((n) => n.value > 0);
  const total = valid.reduce((s, n) => s + n.value, 0);
  if (total <= 0 || valid.length === 0 || w <= 0 || h <= 0) return [];

  // Sort desc — squarify wants the largest items first so the early rows
  // are wide and have low aspect ratios.
  const items = [...valid].sort((a, b) => b.value - a.value) as Array<T & Internal>;
  const area = w * h;
  for (const n of items) n._area = (n.value / total) * area;

  let rx = x, ry = y, rw = w, rh = h;

  function layoutRow(row: Array<T & Internal>): void {
    const horiz = rw <= rh;
    const s = row.reduce((a, b) => a + b._area, 0);
    if (horiz) {
      const rowH = s / rw;
      let cx = rx;
      for (const n of row) {
        const cw = n._area / rowH;
        n.x = cx; n.y = ry; n.w = cw; n.h = rowH;
        cx += cw;
      }
      ry += rowH; rh -= rowH;
    } else {
      const rowW = s / rh;
      let cy = ry;
      for (const n of row) {
        const ch = n._area / rowW;
        n.x = rx; n.y = cy; n.w = rowW; n.h = ch;
        cy += ch;
      }
      rx += rowW; rw -= rowW;
    }
  }

  const placed: Array<T & Internal> = [];
  let i = 0;
  while (i < items.length) {
    const row: Array<T & Internal> = [items[i]];
    const side = Math.min(rw, rh);
    let bestRatio = worstRatio(row, side);
    let j = i + 1;
    while (j < items.length) {
      const tryRow = row.concat(items[j]);
      const r = worstRatio(tryRow, side);
      if (r > bestRatio) break;
      row.push(items[j]);
      bestRatio = r;
      j++;
    }
    layoutRow(row);
    placed.push(...row);
    i = j;
  }
  return placed;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function assetWeight(a: AssetData): number {
  // log10(value/1e6 + 1). +1 protects against negative when value < 1e6.
  // We don't have market cap for HL perps, so use volume24h as the proxy.
  const v = a.volume24h ?? 1e6;
  return Math.log10(Math.max(1, v) / 1e6 + 1);
}

function changeFor(a: AssetData, tf: Timeframe): number | null {
  switch (tf) {
    case "1h":  return a.change1h;
    case "4h":  return a.change4h;
    case "24h": return a.change24h;
    case "7d":  return a.change7d;
  }
}

// ── Component ────────────────────────────────────────────────────────────

const HEADER_H = 22;

export default function Heatmap({
  assets, isLoading, timeframe,
  onSelectAsset, showWatchlistOnly, watchlist,
  hidden, onToggleHide,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [dim, setDim] = useState({ w: 1200, h: 700 });

  useEffect(() => {
    const upd = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        setDim({ w: r.width, h: r.height });
      }
    };
    upd();
    const ro = new ResizeObserver(upd);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const visibleAssets = useMemo(() => {
    return showWatchlistOnly ? assets.filter((a) => watchlist.has(a.symbol)) : assets;
  }, [assets, showWatchlistOnly, watchlist]);

  const layout = useMemo(() => {
    if (visibleAssets.length === 0 || dim.w === 0 || dim.h === 0) return [];

    const groupsMap = new Map<Sector, {
      sector: Sector;
      label: string;
      color: string;
      items: AssetData[];
      value: number;
    }>();
    for (const a of visibleAssets) {
      const existing = groupsMap.get(a.sector);
      if (existing) {
        existing.items.push(a);
      } else {
        groupsMap.set(a.sector, {
          sector: a.sector,
          label: SECTORS[a.sector]?.label ?? a.sector,
          color: SECTORS[a.sector]?.color ?? "#64748B",
          items: [a],
          value: 0, // populated below
        });
      }
    }
    for (const g of groupsMap.values()) {
      g.value = Math.max(0.0001, g.items.reduce((s, a) => s + assetWeight(a), 0));
    }

    const placedSectors = squarify([...groupsMap.values()], 0, 0, dim.w, dim.h);

    return placedSectors.map((g) => {
      const innerH = Math.max(0, g.h - HEADER_H);
      const assetNodes = g.items.map((a) => ({
        asset: a,
        value: assetWeight(a),
      }));
      const placedAssets = squarify(assetNodes, 0, HEADER_H, g.w, innerH);
      return { sector: g, tiles: placedAssets };
    });
  }, [visibleAssets, dim]);

  if (isLoading) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 0" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 32, height: 32,
              border: "2px solid rgba(255,255,255,0.12)",
              borderTopColor: "var(--acc-warn)",
              borderRadius: "50%",
              animation: "heatmap-spin 0.9s linear infinite",
            }}
          />
          <span style={{ fontSize: 11, color: "var(--text-mute)", letterSpacing: ".12em", textTransform: "uppercase" }}>
            Loading markets…
          </span>
        </div>
        <style jsx>{`@keyframes heatmap-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (showWatchlistOnly && visibleAssets.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 0" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 24, color: "var(--text-mute)", marginBottom: 8 }}>☆</div>
          <div style={{ fontSize: 12, color: "var(--text-mute)" }}>No assets in your watchlist yet.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "0 24px 24px", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          background: "var(--bg-card)",
          border: ".5px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
          flex: 1,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 14px",
            borderBottom: ".5px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pulse" />
            <span style={{
              fontSize: 11, fontWeight: 600,
              letterSpacing: ".16em", textTransform: "uppercase",
              color: "var(--text)",
            }}>
              Heatmap
            </span>
            <span style={{
              fontSize: 10, color: "var(--text-mute)",
              padding: "2px 6px", borderRadius: 3,
              background: "var(--bg-chip)",
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            }}>
              {visibleAssets.length} assets
            </span>
            <span style={{
              fontSize: 10, color: "var(--text-mute)",
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
              textTransform: "uppercase",
            }}>
              · {timeframe} change
            </span>
          </div>

          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            fontSize: 10, color: "var(--text-mute)",
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
          }}>
            <span>−10%</span>
            <span style={{
              width: 100, height: 8, borderRadius: 2,
              background: "linear-gradient(90deg, var(--acc-down), var(--bg-chip), var(--acc-up))",
            }} />
            <span>+10%</span>
          </div>
        </div>

        <div
          ref={wrapRef}
          style={{
            position: "relative",
            width: "100%",
            flex: 1,
            minHeight: 500,
          }}
        >
          {layout.map(({ sector, tiles }) => (
            <div
              key={sector.sector}
              style={{
                position: "absolute",
                left: sector.x, top: sector.y,
                width: sector.w, height: sector.h,
                padding: 0,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0, left: 0, right: 0,
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "4px 8px",
                  fontSize: 10,
                  letterSpacing: ".12em",
                  textTransform: "uppercase",
                  color: "var(--text)",
                  fontWeight: 600,
                  fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
                  background: `linear-gradient(90deg, ${sector.color}33, transparent)`,
                  zIndex: 2,
                  pointerEvents: "none",
                  height: HEADER_H,
                  boxSizing: "border-box",
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: sector.color,
                }} />
                {sector.label}
                <span style={{ color: "var(--text-mute)", marginLeft: "auto", fontWeight: 400 }}>
                  {sector.items.length}
                </span>
              </div>

              {tiles.map((t) => (
                <HeatmapTile
                  key={t.asset.symbol}
                  asset={t.asset}
                  x={t.x}
                  y={t.y}
                  w={t.w}
                  h={t.h}
                  change={changeFor(t.asset, timeframe)}
                  onClick={() => onSelectAsset(t.asset.symbol)}
                  isHidden={hidden?.has(t.asset.symbol) ?? false}
                  onToggleHide={onToggleHide}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
