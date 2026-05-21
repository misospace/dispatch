import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { vitestReactActPolyfill } from "./vitest-react-act-polyfill";

export default defineConfig({
  plugins: [react(), vitestReactActPolyfill()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
  ssr: {
    noExternal: ["react", "react-dom", "@testing-library/react"],
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
