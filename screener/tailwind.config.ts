import type { Config } from "tailwindcss";

// Tailwind tokens are intentionally THIN — the Bracket design system
// lives mostly in CSS custom properties (see src/app/globals.css). This
// config only exposes class shortcuts for the new color tokens so Tailwind
// utilities (`text-acc-warn`, `border-strong`, etc.) can be used alongside
// hand-rolled CSS without duplicating the palette.

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Bracket palette
        bg:          "var(--bg)",
        "bg-elev":   "var(--bg-elev)",
        "bg-card":   "var(--bg-card)",
        "bg-macro":  "var(--bg-macro)",
        "bg-chip":   "var(--bg-chip)",
        "bg-chip-h": "var(--bg-chip-h)",
        "bg-row-h":  "var(--bg-row-h)",

        text:           "var(--text)",
        "text-mute":    "var(--text-mute)",
        "text-strong":  "var(--text-strong)",

        "acc-up":   "var(--acc-up)",
        "acc-down": "var(--acc-down)",
        "acc-warn": "var(--acc-warn)",
        "acc-star": "var(--acc-star)",

        // Sector dot colors — preserved from previous palette so the
        // sector taxonomy in src/config/sectors.ts keeps working.
        "sector-majors":      "#F0B90B",
        "sector-l1":          "#3B82F6",
        "sector-defi":        "#10B981",
        "sector-meme":        "#EC4899",
        "sector-ai":          "#A78BFA",
        "sector-gaming":      "#F97316",
        "sector-infra":       "#64748B",
        "sector-stocks":      "#3B82F6",
        "sector-commodities": "#F59E0B",
        "sector-preipo":      "#8B5CF6",
        "sector-indices":     "#FCD34D",
        "sector-major":       "#06B6D4",
        "sector-alt":         "#F43F5E",

        // Aliases kept while we migrate any not-yet-restyled components.
        // Once the redesign lands fully these can be removed alongside
        // their uses.
        positive: "var(--acc-up)",
        negative: "var(--acc-down)",
        base:     "var(--bg)",
        surface:  "var(--bg-card)",
      },
      borderColor: {
        DEFAULT: "var(--border)",
        soft: "var(--border-soft)",
        strong: "var(--border-strong)",
      },
      borderRadius: {
        bracket: "var(--radius)",
      },
      fontFamily: {
        sans: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
