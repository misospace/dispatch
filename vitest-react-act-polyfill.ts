import type { Plugin } from "vitest";

/**
 * Placeholder vitest plugin for React 19 + @testing-library/react v16 compat.
 * The actual patching is done via:
 * 1. postinstall script (scripts/patch-react-act.js) that patches react-dom-test-utils
 * 2. vitest.setup.ts that patches React.act globally before test modules load
 */
export function vitestReactActPolyfill(): Plugin {
  return {
    name: "vitest-react-act-polyfill",
    enforce: "pre",
  };
}
