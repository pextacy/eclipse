import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite 5 + React. `@eclipse/shared` is an ESM workspace package built to dist/.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
  },
});
