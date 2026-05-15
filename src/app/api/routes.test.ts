import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("API route smoke checks", () => {
  it.each([
    "src/app/api/sync/route.ts",
    "src/app/api/issues/route.ts",
    "src/app/api/issues/move/route.ts",
    "src/app/api/issues/claim/route.ts",
    "src/app/api/issues/unclaim/route.ts",
    "src/app/api/automation/repos/route.ts",
    "src/app/api/health/route.ts",
    "src/app/api/agents/[agentName]/queue/route.ts",
  ])("keeps %s present", (routePath) => {
    expect(existsSync(join(root, routePath))).toBe(true);
  });
});
