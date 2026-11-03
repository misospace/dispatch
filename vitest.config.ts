import { defineConfig, configDefaults } from "vitest/config";
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
    // jsdom was recreated once per test file — ~62-70% of tracked time across
    // the suite (#1528). vmThreads creates the environment once per worker and
    // keeps per-file isolation (fresh VM context and module registry per file,
    // so vi.mock hoisting and module-global state still reset), unlike
    // isolate: false, which shares the module graph across files.
    // login/page.test.tsx is the one carve-out: it swaps window.location with
    // Object.defineProperty, which needs a per-file jsdom window — on the
    // shared vmThreads window, `location` is non-configurable.
    projects: [
      {
        extends: true,
        test: {
          name: "location-swap",
          pool: "threads",
          include: ["src/app/login/page.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom-shared",
          pool: "vmThreads",
          exclude: [...configDefaults.exclude, "src/app/login/page.test.tsx"],
        },
      },
    ],
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
