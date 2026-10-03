import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  root: "renderer",
  // Relative asset URLs so the built bundle loads from file:// (packaged
  // Electron, main.ts:309) as well as from http:// (dev server + e2e).
  // Absolute '/' URLs resolve to file:///assets/... under file:// and 404
  // (P2-T21 probe evidence: 2x ERR_FILE_NOT_FOUND, blank window).
  base: "./",
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(__dirname, "renderer/src") },
  },
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
