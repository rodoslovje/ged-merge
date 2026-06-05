import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Use relative base so the static build can be hosted from any subpath
  // (GitHub Pages project sites, etc.).
  base: "./",
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
