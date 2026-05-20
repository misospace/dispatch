// Polyfill for React 19: React.act was removed, but react-dom/test-utils still
// tries to call it. Vitest's test runner handles act internally, so we provide
// a no-op shim that returns the result directly.
import React from "react";
if (typeof (React as any).act !== "function") {
  (React as any).act = <T>(fn: () => T): T => fn();
}

import "@testing-library/jest-dom/vitest";

// Monkey-patch createRoot to use flushSync for jsdom compatibility with React 19.
const _patchCreateRoot = () => {
  try {
    const { flushSync } = require("react-dom");
    const mod = require("react-dom/client");
    const originalCreateRoot = mod.createRoot;
    
    try {
      Object.defineProperty(mod, "createRoot", {
        configurable: true,
        writable: true,
        value: function(...args: any[]) {
          const root = originalCreateRoot(...args);
          const originalRender = root.render.bind(root);
          root.render = function(element: any) {
            flushSync(() => originalRender(element));
          };
          return root;
        }
      });
    } catch {
      const originalFn = mod.createRoot.bind(mod);
      (mod as any).createRoot = function(...args: any[]) {
        const root = originalFn(...args);
        const originalRender = root.render.bind(root);
        root.render = function(element: any) {
          flushSync(() => originalRender(element));
        };
        return root;
      };
    }
  } catch (e) {
    console.warn("[vitest-setup] Failed to patch createRoot:", (e as Error).message);
  }
};

_patchCreateRoot();

const localStorageStore = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore.set(key, value);
  },
  removeItem: (key: number) => {
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

// Guard against non-jsdom environments (e.g., node environment for routes.test.ts)
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    writable: true,
    value: localStorageMock,
  });
}

Object.defineProperty(globalThis, "localStorage", {
  writable: true,
  value: localStorageMock,
});

if (typeof window !== "undefined") {
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

// Reset module-level caches between tests for deterministic isolation
import { resetCaches } from "./src/lib/dispatch-env";
beforeEach(() => {
  resetCaches();
});
