// src/components/FilterPanel.tsx
"use client";

import { useEffect, type ReactNode } from "react";
import { SECTORS, type Sector } from "@/config/sectors";
import {
  FILTER_PRESETS,
  type FilterState,
  type FilterTimeframe,
} from "@/lib/useFilters";

const VOLUME_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Any", value: null },
  { label: "> $1M", value: 1_000_000 },
  { label: "> $10M", value: 10_000_000 },
  { label: "> $50M", value: 50_000_000 },
  { label: "> $100M", value: 100_000_000 },
  { label: "> $500M", value: 500_000_000 },
];

const OI_USD_OPTIONS: { label: string; value: number | null }[] = [
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
  resultCount: number;
  totalCount: number;
  timeframe: FilterTimeframe;
}

export function FilterPanel({
  filters,
  onChange,
  onClear,
  onClose,
  resultCount,
  totalCount,
  timeframe,
}: Props) {
  // Close on Escape key
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function toggleSector(sector: Sector) {
    onChange({
      sectors: filters.sectors.includes(sector)
        ? filters.sectors.filter((value) => value !== sector)
        : [...filters.sectors, sector],
    });
  }

  const turnoverMode =
    filters.minVolOiRatio === 2 && filters.maxVolOiRatio === null
      ? "hot"
      : filters.minVolOiRatio === null && filters.maxVolOiRatio === 0.5
        ? "parked"
        : filters.minVolOiRatio === 0.5 && filters.maxVolOiRatio === 2
          ? "balanced"
          : "any";

  function setTurnover(mode: "any" | "parked" | "balanced" | "hot") {
    if (mode === "parked") onChange({ minVolOiRatio: null, maxVolOiRatio: 0.5 });
    else if (mode === "balanced") onChange({ minVolOiRatio: 0.5, maxVolOiRatio: 2 });
    else if (mode === "hot") onChange({ minVolOiRatio: 2, maxVolOiRatio: null });
    else onChange({ minVolOiRatio: null, maxVolOiRatio: null });
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filters"
        className="fixed right-0 top-0 z-50 flex h-full w-[390px] max-w-[92vw] flex-col border-l border-white/10 bg-[#0f0f13] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <div className="text-sm font-semibold uppercase tracking-wide text-white">Filters</div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-white/35">
              {resultCount} of {totalCount} markets
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-lg leading-none text-white/40 transition-colors hover:text-white/80"
            aria-label="Close filters"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-8 overflow-y-auto px-5 py-6">
          <section>
            <FilterLabel>Saved views</FilterLabel>
            <div className="grid grid-cols-2 gap-2">
              {FILTER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => onChange({
                    ...preset.filters,
                    sectors: [...preset.filters.sectors],
                    sources: [...preset.filters.sources],
                  })}
                  className="rounded-md border border-white/10 bg-white/[0.035] p-3 text-left transition-colors hover:border-amber-300/35 hover:bg-amber-300/[0.06]"
                  title={preset.description}
                >
                  <span className="block text-xs font-semibold text-white/80">{preset.label}</span>
                  <span className="mt-1 block text-[10px] leading-4 text-white/35">{preset.description}</span>
                </button>
              ))}
            </div>
          </section>

          <ToggleGroup
            label="Market source"
            options={[
              { label: "All", value: "all" },
              { label: "Perps", value: "hyperliquid" },
              { label: "Spot", value: "coingecko" },
            ]}
            selected={filters.sources.length === 1 ? filters.sources[0] : "all"}
            onSelect={(value) => onChange({
              sources: value === "all" ? [] : [value],
            })}
          />

          <section>
            <FilterLabel>Sectors</FilterLabel>
            <div className="flex flex-wrap gap-2">
              {Object.values(SECTORS).map((sector) => {
                const active = filters.sectors.includes(sector.id);
                return (
                  <button
                    key={sector.id}
                    onClick={() => toggleSector(sector.id)}
                    aria-pressed={active}
                    className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                      active
                        ? "border-amber-300/50 bg-amber-300/10 text-amber-200"
                        : "border-white/10 bg-white/5 text-white/55 hover:bg-white/10 hover:text-white/90"
                    }`}
                  >
                    {sector.label}
                  </button>
                );
              })}
            </div>
          </section>

          <ToggleGroup
            label={`${timeframe} price direction`}
            options={[
              { label: "Any", value: "any" },
              { label: "Gainers", value: "up" },
              { label: "Losers", value: "down" },
            ]}
            selected={filters.moveDirection}
            onSelect={(moveDirection) => onChange({ moveDirection })}
          />
          <FilterGroup
            label={`Min absolute ${timeframe} move`}
            options={[
              { label: "Any", value: null },
              { label: "> 2%", value: 2 },
              { label: "> 5%", value: 5 },
              { label: "> 10%", value: 10 },
            ]}
            selected={filters.minAbsMovePct}
            onSelect={(minAbsMovePct) => onChange({ minAbsMovePct })}
          />

          <FilterGroup
            label="Min 24h Volume"
            options={VOLUME_OPTIONS}
            selected={filters.minVolume}
            onSelect={(value) => onChange({ minVolume: value })}
          />
          <FilterGroup
            label="Min Open Interest (USD)"
            options={OI_USD_OPTIONS}
            selected={filters.minOIUsd}
            onSelect={(minOIUsd) => onChange({ minOIUsd })}
          />

          <ToggleGroup
            label="24h open-interest direction"
            options={[
              { label: "Any", value: "any" },
              { label: "Rising", value: "rising" },
              { label: "Falling", value: "falling" },
            ]}
            selected={filters.oiTrend}
            onSelect={(oiTrend) => onChange({ oiTrend })}
          />
          <FilterGroup
            label="Min absolute 24h OI move"
            options={[
              { label: "Any", value: null },
              { label: "> 5%", value: 5 },
              { label: "> 10%", value: 10 },
              { label: "> 25%", value: 25 },
            ]}
            selected={filters.minAbsOIChange24hPct}
            onSelect={(minAbsOIChange24hPct) => onChange({ minAbsOIChange24hPct })}
          />

          <ToggleGroup
            label="Average funding bias"
            options={[
              { label: "Any", value: "any" },
              { label: "Positive", value: "positive" },
              { label: "Negative", value: "negative" },
            ]}
            selected={filters.fundingBias}
            onSelect={(fundingBias) => onChange({ fundingBias })}
          />
          <FilterGroup
            label="Min absolute funding APR"
            options={[
              { label: "Any", value: null },
              { label: "> 10%", value: 10 },
              { label: "> 25%", value: 25 },
              { label: "> 50%", value: 50 },
              { label: "> 100%", value: 100 },
            ]}
            selected={filters.minAbsFundingAprPct}
            onSelect={(minAbsFundingAprPct) => onChange({ minAbsFundingAprPct })}
          />

          <ToggleGroup
            label="Turnover · 24h volume / OI"
            options={[
              { label: "Any", value: "any" },
              { label: "Parked ≤0.5×", value: "parked" },
              { label: "Balanced", value: "balanced" },
              { label: "Hot ≥2×", value: "hot" },
            ]}
            selected={turnoverMode}
            onSelect={setTurnover}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
          <button
            onClick={onClear}
            className="text-xs text-white/40 underline underline-offset-2 transition-colors hover:text-white/70"
          >
            Clear filters
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-amber-300/45 bg-amber-300/10 px-4 py-2 text-xs font-semibold text-amber-200 transition-colors hover:bg-amber-300/15"
          >
            View {resultCount} markets
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Internal sub-component ───────────────────────────────────────────────────

function FilterLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-white/50">
      {children}
    </p>
  );
}

interface ToggleGroupProps<T extends string> {
  label: string;
  options: Array<{ label: string; value: T }>;
  selected: T;
  onSelect: (value: T) => void;
}

function ToggleGroup<T extends string>({
  label,
  options,
  selected,
  onSelect,
}: ToggleGroupProps<T>) {
  return (
    <section>
      <FilterLabel>{label}</FilterLabel>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = option.value === selected;
          return (
            <button
              key={option.value}
              onClick={() => onSelect(option.value)}
              aria-pressed={active}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-all ${
                active
                  ? "border-amber-300/50 bg-amber-300/10 text-amber-200"
                  : "border-white/10 bg-white/5 text-white/55 hover:bg-white/10 hover:text-white/90"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

interface FilterGroupProps {
  label: string;
  options: { label: string; value: number | null }[];
  selected: number | null;
  onSelect: (value: number | null) => void;
}

function FilterGroup({ label, options, selected, onSelect }: FilterGroupProps) {
  return (
    <div>
      <FilterLabel>{label}</FilterLabel>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = opt.value === selected;
          return (
            <button
              key={String(opt.value)}
              onClick={() => onSelect(opt.value)}
              aria-pressed={active}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all border ${
                active
                  ? "border-amber-300/50 bg-amber-300/10 text-amber-200"
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
