"use client";

import type { ActiveFilter, FilterKey } from "@/lib/useFilters";

interface Props {
  filters: ActiveFilter[];
  resultCount: number;
  totalCount: number;
  onRemove: (key: FilterKey) => void;
  onClear: () => void;
  onOpen: () => void;
}

export default function ActiveFilterBar({
  filters,
  resultCount,
  totalCount,
  onRemove,
  onClear,
  onOpen,
}: Props) {
  return (
    <div className="filter-summary" aria-label="Active market filters">
      <div className="filter-result" aria-live="polite">
        <strong>{resultCount}</strong>
        <span>of {totalCount} markets</span>
      </div>
      <div className="filter-chips">
        {filters.length === 0 ? (
          <button className="filter-empty" onClick={onOpen}>No market filters · add a saved view or facet</button>
        ) : filters.map((filter) => (
          <button
            key={filter.key}
            className="filter-chip"
            onClick={() => onRemove(filter.key)}
            aria-label={`Remove ${filter.label} filter`}
            title={`Remove ${filter.label}`}
          >
            {filter.label}<span>×</span>
          </button>
        ))}
      </div>
      <div className="filter-actions">
        {filters.length > 0 && <button onClick={onClear}>Clear</button>}
        <button className="filter-edit" onClick={onOpen}>Edit filters</button>
      </div>
      <style jsx>{`
        .filter-summary {
          display: flex;
          align-items: center;
          gap: 12px;
          min-height: 43px;
          margin: 0 24px 12px;
          padding: 7px 10px;
          border: .5px solid var(--border-soft);
          background: var(--bg-card);
        }
        .filter-result { display: flex; align-items: baseline; gap: 5px; white-space: nowrap; font-family: var(--font-geist-mono), monospace; }
        .filter-result strong { color: var(--text-strong); font-size: 12px; }
        .filter-result span { color: var(--text-mute); font-size: 9px; }
        .filter-chips { display: flex; flex: 1; gap: 6px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
        .filter-chips::-webkit-scrollbar { display: none; }
        .filter-chip, .filter-empty {
          flex: none;
          border: .5px solid var(--border-soft);
          border-radius: 999px;
          background: var(--bg-chip);
          color: var(--text);
          padding: 5px 8px;
          font-size: 9px;
          cursor: pointer;
          white-space: nowrap;
        }
        .filter-chip { border-color: color-mix(in oklab, var(--acc-warn) 28%, var(--border-soft)); }
        .filter-chip span { margin-left: 6px; color: var(--text-mute); }
        .filter-chip:hover { color: var(--acc-warn); border-color: color-mix(in oklab, var(--acc-warn) 50%, transparent); }
        .filter-empty { color: var(--text-mute); border-style: dashed; }
        .filter-actions { display: flex; gap: 5px; white-space: nowrap; }
        .filter-actions button { border: 0; background: transparent; color: var(--text-mute); font-size: 9px; cursor: pointer; padding: 6px; }
        .filter-actions button:hover { color: var(--text); }
        .filter-actions .filter-edit { border: .5px solid var(--border-soft); border-radius: var(--radius); color: var(--acc-warn); padding-inline: 9px; }
        @media (max-width: 720px) {
          .filter-summary { margin: 0 10px 10px; flex-wrap: wrap; }
          .filter-chips { order: 3; flex-basis: 100%; }
          .filter-actions { margin-left: auto; }
        }
      `}</style>
    </div>
  );
}
