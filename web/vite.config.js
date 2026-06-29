import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static-first build; dist is deployable on any static host.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    strictPort: false
  },
  build: {
    outDir: "dist",
    target: "es2020",
    cssMinify: "esbuild",
    sourcemap: false
  }
});
