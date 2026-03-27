import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        base: "#0A0A0F",
        surface: "#111827",
        "surface-light": "#1F2937",
        "sector-l1": "#3B82F6",
        "sector-defi": "#10B981",
        "sector-meme": "#EC4899",
        "sector-ai": "#A78BFA",
        "sector-gaming": "#F97316",
        "sector-infra": "#64748B",
        "sector-stocks": "#3B82F6",
        "sector-commodities": "#F59E0B",
        "sector-preipo": "#8B5CF6",
        "sector-indices": "#FCD34D",
        "sector-major": "#06B6D4",
        "sector-alt": "#F43F5E",
        positive: "#22C55E",
        negative: "#EF4444",
      },
      fontFamily: {
        sans: ["var(--font-satoshi)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)"],
      },
    },
  },
  plugins: [],
};
export default config;
