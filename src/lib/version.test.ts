// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import { getVersionLabel, resetVersionCache } from "./version";

describe("getVersionLabel", () => {
  beforeEach(() => {
    resetVersionCache();
  });

  it("prefixes the version with 'v'", () => {
    vi.stubEnv("NEXT_PUBLIC_DISPATCH_VERSION", "0.2.2");
    expect(getVersionLabel()).toBe("v0.2.2");
  });

  it("falls back to package.json when env is not set", () => {
    vi.unstubAllEnvs();
    const version = getVersionLabel();
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});
