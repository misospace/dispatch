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
