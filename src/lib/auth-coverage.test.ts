import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * Smoke test: every API route file must either call authorizeRequest /
 * authorizeGroomerRequest or be on the explicit public allowlist.
 *
 * This prevents future routes from silently regressing into unauthenticated
 * state, per the #509 auth-uniformity policy.
 */
describe("auth coverage across all API routes", () => {
  const apiDir = join(__dirname, "..", "app", "api");

  // Recursively find all route.ts files (excluding test files)
  function findRouteFiles(dir: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findRouteFiles(fullPath));
      } else if (entry.name === "route.ts" && !entry.name.endsWith(".test.ts")) {
        results.push(fullPath);
      }
    }
    return results;
  }

  // Routes that are intentionally public (no auth required)
  const publicAllowlist = [
    // Health check endpoint
    "health/route.ts",
    // Login page redirect
    "login/route.ts",
    // NextAuth handler — manages session lifecycle
    "auth/[...nextauth]/route.ts",
    // Logout — clears session cookie
    "auth/logout/route.ts",
    // GitHub webhook — validates via secret token, not session auth
    "pr-followup/webhook/route.ts",
  ];

  const routeFiles = findRouteFiles(apiDir);

  it("has at least one route file to check", () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  for (const filePath of routeFiles) {
    const relativePath = relative(apiDir, filePath);

    it(`"${relativePath}" has auth or is on public allowlist`, () => {
      const content = readFileSync(filePath, "utf-8");

      // Check if this route is on the public allowlist
      const isPublic = publicAllowlist.some(
        (allowed) => relativePath === allowed || relativePath.endsWith(allowed)
      );

      if (isPublic) {
        // Public routes are allowed — no auth check needed
        return;
      }

      // Non-public routes must call authorizeRequest or authorizeGroomerRequest
      const hasAuth =
        content.includes("authorizeRequest") ||
        content.includes("authorizeGroomerRequest");

      expect(hasAuth, `${relativePath} must call authorizeRequest or authorizeGroomerRequest`).toBe(true);
    });
  }
});
