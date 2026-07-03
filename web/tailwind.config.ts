import type { Config } from "tailwindcss";

/**
 * Flat trading-terminal theme. HARD RULE (CLAUDE.md): NO gradients anywhere.
 * Solid fills only. Do not add bg-gradient-* utilities or gradient tokens.
 */
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Solid, flat surfaces only.
        bg: "#0a0a0a",
        surface: "#0e1116",
        panel: "#14181f",
        "panel-2": "#181d26",
        line: "#232a35",
        "line-strong": "#2f3846",
        muted: "#7d8695",
        subtle: "#9aa4b2",
        ink: "#e6e9ef",
        // Accents (one good / cyan-green, hostile / red-amber).
        eclipse: "#22d3aa",
        "eclipse-dim": "#0f2f28",
        good: "#22d3aa",
        warn: "#f5a524",
        loss: "#ff5470",
        "loss-dim": "#331119",
        info: "#4aa8ff",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "JetBrains Mono",
          "SF Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      borderColor: {
        DEFAULT: "#232a35",
      },
    },
  },
  plugins: [],
};

export default config;
