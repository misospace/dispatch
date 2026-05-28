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
