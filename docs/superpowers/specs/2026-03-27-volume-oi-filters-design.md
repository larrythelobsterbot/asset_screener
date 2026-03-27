# Volume & Open Interest Filters — Design Spec

**Date:** 2026-03-27
**Project:** Asset Screener (assets.lekker.design)

---

## Overview

Add a slide-in filter panel that lets users filter all screener assets by volume and open interest using threshold presets. Filters apply simultaneously to the heatmap and signal scanner. User selections persist via localStorage.

---

## UI

### Filter Button
- Lives in the top toolbar, right side
- Label: "Filters" with a funnel icon
- When one or more filters are active, shows a badge with the count of active (non-"Any") filters (e.g. "Filters •2")
- Clicking toggles the panel open/closed

### Slide-in Panel
- Slides in from the right edge of the screen
- Overlays content (does not push layout)
- Dark-themed, consistent with existing screener design
- Click outside or press Escape to close
- Contains a "Clear filters" link at the bottom that resets all selections to "Any" (does NOT auto-close the panel — user may want to try a different combination)

### Volume Filter
Label: **Min 24h Volume**
Presets (single-select):
- Any (default)
- > $1M
- > $10M
- > $50M
- > $100M
- > $500M

### Open Interest Filter
Label: **Min Open Interest**
Presets (single-select):
- Any (default)
- > $500K
- > $5M
- > $25M
- > $100M
- > $500M

---

## Data

Both `volume24h` and `openInterest` are already returned by the `/api/markets` route (sourced from Hyperliquid `metaAndAssetCtxs` fields `dayNtlVlm` and `openInterest`). CoinGecko crypto assets set `openInterest: null` since they are spot assets with no OI concept.

No API changes required.

---

## State Ownership

`useFilters` is instantiated in `page.tsx` (the root client component that renders both `<Heatmap>` and `<SignalScanner>`). The filter state and the `FilterPanel` open/close state both live at this level. Filters are passed as props to child components.

`page.tsx` also owns the markets data fetch (already the case via the existing `useAssets` hook or equivalent). This shared fetch is the single source of truth for asset metadata including `volume24h` and `openInterest`. Both `Heatmap` and `SignalScanner` receive a pre-filtered asset list from the parent rather than each running their own filter logic.

---

## Filter Logic

Filters are applied client-side in `page.tsx` after assets are fetched, producing a `filteredAssets` array that is passed to child components.

```typescript
function passesFilters(asset: AssetData, filters: FilterState): boolean {
  // Volume: always comparable (number or 0)
  if (filters.minVolume !== null && (asset.volume24h ?? 0) < filters.minVolume) {
    return false;
  }
  // OI: null means not applicable (CoinGecko/spot assets) — treat as passing when OI filter active
  // If OI filter is set and asset has OI data, apply threshold
  // If OI filter is set and asset.openInterest is null, asset passes (OI not applicable)
  if (filters.minOI !== null && asset.openInterest !== null && asset.openInterest < filters.minOI) {
    return false;
  }
  return true;
}
```

Both conditions use AND logic. Filtered-out assets are hidden entirely (not greyed out).

---

## Signal Scanner Integration

`SignalScanner` does not hold asset metadata — it fetches `Signal[]` from `/api/signals`. To apply volume/OI filters to signals, the parent `page.tsx` derives a `Set<string>` of passing symbols from `filteredAssets` and passes it to `SignalScanner`. `SignalScanner` filters its displayed signals to only those whose `symbol` is in the allowed set.

```typescript
// In page.tsx
const passingSymbols = new Set(filteredAssets.map(a => a.symbol));

// SignalScanner receives:
<SignalScanner allowedSymbols={passingSymbols} ... />

// Inside SignalScanner
const visibleSignals = signals.filter(s => allowedSymbols.has(s.symbol));
```

---

## Components

### `FilterPanel` (`src/components/FilterPanel.tsx`)
- `"use client"` component
- Slide-in panel with semi-transparent backdrop
- Renders threshold preset buttons for volume and OI
- Props: `filters: FilterState`, `onChange: (filters: FilterState) => void`, `onClear: () => void`, `onClose: () => void`

### `useFilters` hook (`src/hooks/useFilters.ts`)
- `"use client"` hook
- Manages filter state + localStorage persistence
- SSR guard: all `localStorage` access gated by `typeof window !== "undefined"` (matches pattern of existing `useWatchlist`)
- localStorage key: `"asset-screener-filters"` (consistent with `"asset-screener-watchlist"`)
- Returns: `{ filters, setFilter, clearFilters, activeCount }`

```typescript
interface FilterState {
  minVolume: number | null;  // null = Any
  minOI: number | null;      // null = Any
}
```

### Updated prop signatures

**`Heatmap`** gains:
```typescript
filteredAssets: AssetData[]  // pre-filtered by page.tsx, replaces internal assets fetch for rendering
```

**`SignalScanner`** gains:
```typescript
allowedSymbols: Set<string>  // symbols that pass current filters; signals not in set are hidden
```

### Updates to existing components
- `page.tsx`: instantiate `useFilters`, compute `filteredAssets` and `passingSymbols`, render `FilterPanel`, add Filters button to toolbar with badge
- `Heatmap`: use `filteredAssets` prop for rendering instead of its own unfiltered data
- `SignalScanner`: filter displayed signals to `allowedSymbols`

---

## Acceptance Criteria

1. Filters button appears in toolbar; clicking opens the slide-in panel
2. Badge on button shows count of active (non-"Any") filters
3. Selecting a threshold immediately filters heatmap and signal scanner
4. Filtered assets/signals disappear entirely (not greyed out)
5. "Clear filters" resets all to "Any" but keeps the panel open
6. Filter selections persist after page refresh (localStorage key `"asset-screener-filters"`)
7. Panel closes on outside click or Escape key
8. CoinGecko/spot assets (where `openInterest` is null) always pass the OI filter regardless of threshold
9. No SSR errors — localStorage access guarded by `typeof window !== "undefined"`
