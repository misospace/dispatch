import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  define: {
    // React strips act() from its production bundle, but @testing-library/react
    // needs it to flush renders. Force test mode so the dev bundle is used.
    // Without this, ssr.noExternal causes Vite to bundle React in production mode.
    "process.env.NODE_ENV": JSON.stringify("test"),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.stories.{ts,tsx}",
        "src/**/__tests__/**",
        "src/types/**",
      ],
      // Thresholds are set below the measured baseline (statements: 78.79%,
      // branches: 68.74%, functions: 72.01%, lines: 80.01%) so the gate
      // enforces a floor and flags regressions without blocking on the
      // current snapshot.
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 70,
        lines: 75,
      },
    },
  },
  ssr: {
    noExternal: ["react", "react-dom", "@testing-library/react"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
