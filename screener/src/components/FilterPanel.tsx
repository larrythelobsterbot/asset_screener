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
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filters"
        className="fixed right-0 top-0 z-50 h-full w-72 bg-[#0f0f13] border-l border-white/10 shadow-2xl flex flex-col"
      >
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
