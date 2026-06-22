// Import @testing-library/jest-dom/vitest for custom matchers
import "@testing-library/jest-dom/vitest";

// Provide a dummy DATABASE_URL so prisma.ts module loads without throwing.
// Tests that need real DB access mock/override as needed.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/dispatch_test";

// Patch React.act for React 19 + @testing-library/react v16 compat.
// React 19 removed React.act, but older react-dom/test-utils still calls it.
const React = require("react");
if (typeof React.act !== "function") {
  Object.defineProperty(React, "act", {
    value: function act(cb) {
      return typeof cb === "function" ? cb() : cb;
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

const localStorageStore = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore.set(key, value);
  },
  removeItem: (key: string) => {
    localStorageStore.delete(key);
  },
  clear: () => {
    localStorageStore.clear();
  },
  key: (index: number) => Array.from(localStorageStore.keys())[index] ?? null,
  get length() {
    return localStorageStore.size;
  },
};

// Environment-aware: only patch window in browser environments.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    writable: true,
    value: localStorageMock,
  });

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

Object.defineProperty(globalThis, "localStorage", {
  writable: true,
  value: localStorageMock,
});

// Reset module-level caches between tests for deterministic isolation
import { resetCaches } from "./src/lib/dispatch-env";
beforeEach(() => {
  resetCaches();
});

// Configure 3-tier lanes (local/cloud/frontier) for tests.
// Code default is minimal (default/backlog) — real deployments use
// DISPATCH_LANE_CONFIG_JSON. Tests need the full 3-tier config for mock data.
// lane-config.test.ts resets to default in its own setup.
import { setLaneConfig } from "./src/lib/lane-config";
setLaneConfig({
  lanes: [
    { id: "local", title: "Local", claimable: true, role: "default", description: "Local model lane", color: "#3b82f6" },
    { id: "cloud", title: "Cloud", claimable: true, description: "Cloud model lane", color: "#8b5cf6" },
    { id: "frontier", title: "Frontier", claimable: true, role: "escalation", description: "Frontier model lane", color: "#f97316" },
    { id: "backlog", title: "Backlog", claimable: false, description: "Backlog", color: "#6b7280" },
  ],
  laneAliases: { normal: "local", escalated: "frontier" },
});

// Re-apply lane config before each test — some tests call resetLaneConfig()
// which wipes the global setup. This ensures every test starts with the
// 3-tier config unless it explicitly calls resetLaneConfig() itself.
beforeEach(() => {
  setLaneConfig({
    lanes: [
      { id: "local", title: "Local", claimable: true, role: "default", description: "Local model lane", color: "#3b82f6" },
      { id: "cloud", title: "Cloud", claimable: true, description: "Cloud model lane", color: "#8b5cf6" },
      { id: "frontier", title: "Frontier", claimable: true, role: "escalation", description: "Frontier model lane", color: "#f97316" },
      { id: "backlog", title: "Backlog", claimable: false, description: "Backlog", color: "#6b7280" },
    ],
    laneAliases: { normal: "local", escalated: "frontier" },
  });
});
