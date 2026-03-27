# Volume & OI Filter Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slide-in filter panel with volume and open interest threshold presets that hide non-matching assets from the heatmap and signal scanner.

**Architecture:** A `useFilters` hook (modeled after `useWatchlist`) manages filter state with localStorage persistence. The `/api/markets` fetch is lifted out of `Heatmap` and into `page.tsx`, which becomes the single owner of asset data. `page.tsx` runs `passesFilters()` to produce `filteredAssets` (passed to `Heatmap`) and `passingSymbols: Set<string> | null` (passed to `SignalScanner`). `Heatmap` receives pre-filtered assets and no longer fetches markets itself.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS, localStorage

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/useFilters.ts` | **Create** | Filter state hook + `passesFilters` helper, localStorage persistence |
| `src/components/FilterPanel.tsx` | **Create** | Slide-in panel UI with threshold preset buttons |
| `src/app/page.tsx` | **Modify** | Own markets fetch, compute filteredAssets + passingSymbols, render FilterPanel + Filters button |
| `src/components/Heatmap.tsx` | **Modify** | Replace internal fetch with `assets: AssetData[]` prop; keep watchlist filter + sector grouping |
| `src/components/SignalScanner.tsx` | **Modify** | Accept `allowedSymbols: Set<string> \| null` prop and filter displayed signals |

> **Note on file location:** The existing `useWatchlist` hook lives in `src/lib/` (not `src/hooks/`). `useFilters` follows the same convention and is placed in `src/lib/useFilters.ts`.

---

## Task 1: `useFilters` hook

**Files:**
- Create: `src/lib/useFilters.ts`

- [ ] **Step 1: Create the hook and export `passesFilters`**

```typescript
// src/lib/useFilters.ts
"use client";

import { useState, useEffect } from "react";
import { AssetData } from "@/lib/types";

export interface FilterState {
  minVolume: number | null; // null = Any
  minOI: number | null;     // null = Any
}

const DEFAULT_FILTERS: FilterState = { minVolume: null, minOI: null };
const STORAGE_KEY = "asset-screener-filters";

/** Pure helper — exported so Heatmap and page.tsx share the same logic */
export function passesFilters(asset: AssetData, filters: FilterState): boolean {
  if (filters.minVolume !== null && asset.volume24h < filters.minVolume) {
    return false;
  }
  // openInterest is null for CoinGecko/spot assets — they always pass the OI filter
  if (
    filters.minOI !== null &&
    asset.openInterest !== null &&
    asset.openInterest < filters.minOI
  ) {
    return false;
  }
  return true;
}

export function useFilters() {
  const [filters, setFiltersState] = useState<FilterState>(DEFAULT_FILTERS);

  // Load from localStorage on mount — SSR guard required: Next.js may run this server-side
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setFiltersState(JSON.parse(raw));
    } catch {
      // ignore malformed stored data
    }
  }, []);

  function setFilter(patch: Partial<FilterState>) {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      if (typeof window !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  }

  function clearFilters() {
    setFiltersState(DEFAULT_FILTERS);
    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  const activeCount = [filters.minVolume, filters.minOI].filter(
    (v) => v !== null
  ).length;

  return { filters, setFilter, clearFilters, activeCount };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/useFilters.ts
git commit -m "feat: add useFilters hook with passesFilters helper and localStorage persistence"
```

---

## Task 2: `FilterPanel` component

**Files:**
- Create: `src/components/FilterPanel.tsx`

- [ ] **Step 1: Create the component**

```typescript
// src/components/FilterPanel.tsx
"use client";

import { useEffect } from "react";
import { FilterState } from "@/lib/useFilters";

const VOLUME_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Any", value: null },
  { label: "> $1M", value: 1_000_000 },
  { label: "> $10M", value: 10_000_000 },
  { label: "> $50M", value: 50_000_000 },
  { label: "> $100M", value: 100_000_000 },
  { label: "> $500M", value: 500_000_000 },
];

const OI_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Any", value: null },
  { label: "> $500K", value: 500_000 },
  { label: "> $5M", value: 5_000_000 },
  { label: "> $25M", value: 25_000_000 },
  { label: "> $100M", value: 100_000_000 },
  { label: "> $500M", value: 500_000_000 },
];

interface Props {
  filters: FilterState;
  /** Called with a partial patch when user selects a threshold */
  onChange: (patch: Partial<FilterState>) => void;
  /** Resets all filters to default (does NOT close the panel) */
  onClear: () => void;
  onClose: () => void;
}

export function FilterPanel({ filters, onChange, onClear, onClose }: Props) {
  // Close on Escape key
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 z-50 h-full w-72 bg-[#0f0f13] border-l border-white/10 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <span className="text-sm font-semibold text-white tracking-wide uppercase">
            Filters
          </span>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white/80 transition-colors text-lg leading-none"
            aria-label="Close filters"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-8">
          <FilterGroup
            label="Min 24h Volume"
            options={VOLUME_OPTIONS}
            selected={filters.minVolume}
            onSelect={(value) => onChange({ minVolume: value })}
          />
          <FilterGroup
            label="Min Open Interest"
            options={OI_OPTIONS}
            selected={filters.minOI}
            onSelect={(value) => onChange({ minOI: value })}
          />
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/10">
          <button
            onClick={onClear}
            className="text-sm text-white/40 hover:text-white/70 transition-colors underline underline-offset-2"
          >
            Clear filters
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Internal sub-component ───────────────────────────────────────────────────

interface FilterGroupProps {
  label: string;
  options: { label: string; value: number | null }[];
  selected: number | null;
  onSelect: (value: number | null) => void;
}

function FilterGroup({ label, options, selected, onSelect }: FilterGroupProps) {
  return (
    <div>
      <p className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-3">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = opt.value === selected;
          return (
            <button
              key={String(opt.value)}
              onClick={() => onSelect(opt.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all border ${
                active
                  ? "bg-violet-600 border-violet-500 text-white"
                  : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white/90"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/FilterPanel.tsx
git commit -m "feat: add FilterPanel slide-in component with threshold preset buttons"
```

---

## Task 3: Modify `SignalScanner` to accept `allowedSymbols`

**Files:**
- Modify: `src/components/SignalScanner.tsx`

Signals only have a `symbol` field — no volume/OI. We receive `allowedSymbols` from the parent and filter signals against it. `null` means "data not loaded yet — show all" (prevents hiding all signals on initial render).

- [ ] **Step 1: Update `SignalScanner`'s props interface**

Find the existing `interface Props` and add `allowedSymbols`:

```typescript
interface Props {
  onSelectAsset: (symbol: string) => void;
  allowedSymbols: Set<string> | null; // null = not loaded yet, show all
}
```

- [ ] **Step 2: Filter signals before passing to feed/table**

Inside `SignalScanner`, locate where `signals` are passed to `SignalFeed` / `SignalTable` and add a filter:

```typescript
const visibleSignals =
  allowedSymbols === null
    ? signals
    : signals.filter((s) => allowedSymbols.has(s.symbol));
```

Replace all uses of `signals` in the render (passed to `SignalFeed`, `SignalTable`, and any badge count) with `visibleSignals`.

- [ ] **Step 3: Commit**

```bash
git add src/components/SignalScanner.tsx
git commit -m "feat: add allowedSymbols prop to SignalScanner for filter integration"
```

---

## Task 4: Lift markets fetch into `page.tsx` and refactor `Heatmap`

This task lifts the `/api/markets` fetch out of `Heatmap` and into `page.tsx` so the parent can compute `filteredAssets` and `passingSymbols` from one source of truth.

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/components/Heatmap.tsx`

### 4a — Add markets fetch to `page.tsx`

- [ ] **Step 1: Add the markets fetch state and effect**

In `page.tsx`, import what's needed and add state + effect:

```typescript
// Add to imports
import { AssetData } from "@/lib/types";
import { useFilters, passesFilters } from "@/lib/useFilters";
import { FilterPanel } from "@/components/FilterPanel";

// Inside the Home component, add:
const { filters, setFilter, clearFilters, activeCount } = useFilters();
const [filterPanelOpen, setFilterPanelOpen] = useState(false);
const [allAssets, setAllAssets] = useState<AssetData[]>([]);

useEffect(() => {
  async function load() {
    try {
      const res = await fetch("/api/markets");
      if (res.ok) setAllAssets(await res.json());
    } catch {
      // ignore; Heatmap will receive empty array and show nothing until loaded
    }
  }
  load();
  const id = setInterval(load, 30_000);
  return () => clearInterval(id);
}, []);
```

- [ ] **Step 2: Compute `filteredAssets` and `passingSymbols`**

```typescript
// Derived values — recomputed whenever allAssets or filters change
const filteredAssets = allAssets.filter((a) => passesFilters(a, filters));

// null when data not yet loaded = show all signals in SignalScanner
const passingSymbols: Set<string> | null =
  allAssets.length === 0
    ? null
    : new Set(filteredAssets.map((a) => a.symbol));
```

- [ ] **Step 3: Add the Filters button to the toolbar**

Find the existing toolbar (where `TimeframeToggle` or the watchlist toggle button lives) and add a Filters button:

```tsx
<button
  onClick={() => setFilterPanelOpen((prev) => !prev)}
  className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-all ${
    activeCount > 0
      ? "bg-violet-600/20 border-violet-500/50 text-violet-300"
      : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10 hover:text-white/90"
  }`}
>
  {/* Funnel icon */}
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
    />
  </svg>
  Filters
  {activeCount > 0 && (
    <span className="absolute -top-1.5 -right-1.5 bg-violet-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
      {activeCount}
    </span>
  )}
</button>
```

- [ ] **Step 4: Render `FilterPanel` and update child component props**

Add `FilterPanel` near the top of the JSX (outside layout wrappers, as it's fixed-position):

```tsx
{filterPanelOpen && (
  <FilterPanel
    filters={filters}
    onChange={setFilter}
    onClear={clearFilters}
    onClose={() => setFilterPanelOpen(false)}
  />
)}
```

Update `<Heatmap>` to pass `assets`:
```tsx
<Heatmap
  assets={filteredAssets}         // ← new prop
  timeframe={timeframe}
  onSelectAsset={setSelectedAsset}
  showWatchlistOnly={showWatchlist}
  watchlist={watchlist}
  onToggleWatch={toggle}
/>
```

Update `<SignalScanner>` to pass `allowedSymbols`:
```tsx
<SignalScanner
  onSelectAsset={setSelectedAsset}
  allowedSymbols={passingSymbols}   // ← new prop
/>
```

- [ ] **Step 5: Commit page.tsx changes**

```bash
git add src/app/page.tsx
git commit -m "feat: lift markets fetch to page.tsx, wire filters and FilterPanel"
```

### 4b — Refactor `Heatmap` to receive assets as a prop

- [ ] **Step 6: Update `Heatmap`'s props interface**

In `src/components/Heatmap.tsx`, update the interface:

```typescript
// Add import at top
import { AssetData } from "@/lib/types";

interface Props {
  assets: AssetData[];              // ← replaces internal fetch
  timeframe: Timeframe;
  onSelectAsset: (symbol: string) => void;
  showWatchlistOnly: boolean;
  watchlist: Set<string>;
  onToggleWatch: (symbol: string) => void;
}
```

- [ ] **Step 7: Remove the internal markets fetch from `Heatmap`**

Delete (or comment out) the `useEffect` + `useState` that fetches `/api/markets` and the associated `setInterval`. The component now gets `assets` from props — no fetch needed.

Keep everything else: the `showWatchlistOnly` filter, sector grouping logic, and tile rendering are all unchanged.

Replace any reference to the internal `assets` state variable with the `assets` prop.

- [ ] **Step 8: Commit Heatmap changes**

```bash
git add src/components/Heatmap.tsx
git commit -m "refactor: Heatmap receives pre-filtered assets as prop instead of fetching internally"
```

---

## Task 5: Build and verify

- [ ] **Step 1: Build the app**

```bash
cd /home/muffinman/asset_screener/screener
npm run build
```

Expected: Build completes with no TypeScript errors. Type errors indicate a missed prop update — check that every `<Heatmap>` call now passes `assets` and every `<SignalScanner>` call passes `allowedSymbols`.

- [ ] **Step 2: Restart pm2**

```bash
pm2 restart asset-screener
```

- [ ] **Step 3: Smoke test checklist**

Check at https://assets.lekker.design:
- [ ] Filters button visible in toolbar
- [ ] Click Filters button → panel slides in from right
- [ ] Click backdrop → panel closes
- [ ] Press Escape → panel closes
- [ ] Select a volume threshold (e.g. > $100M) → heatmap tiles with lower volume disappear
- [ ] Badge on Filters button shows "1"
- [ ] Select an OI threshold → badge shows "2"
- [ ] Click "Clear filters" → both reset to "Any", badge disappears, all tiles return, **panel stays open**
- [ ] Reload page → filter selections are still applied (localStorage persistence)
- [ ] Signal scanner hides signals for filtered-out symbols when filters are active

- [ ] **Step 4: Final commit if any tweaks were needed**

```bash
git add -p
git commit -m "fix: filter panel polish"
```
