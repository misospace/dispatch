// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest runs tests from the project root, so `process.cwd()` is the
// repository root regardless of where the test file lives.
const packageJsonPath = join(process.cwd(), "package.json");
const lockfilePath = join(process.cwd(), "package-lock.json");

// CVEs remediated by the override (see issue #675):
//   - GHSA-f88m-g3jw-g9cj (libvips DoS / potential RCE in sharp@0.33.5)
//   - CVE-2024-28849, CVE-2024-39438 (libvips out-of-bounds writes)
// sharp ≥0.35.0 ships a patched libvips and is the floor shipped to
// production via next's optional dependency.
const MIN_PATCHED_SHARP = "0.35.0";

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

type PackageJson = {
  overrides?: Record<string, string>;
};

type Lockfile = {
  packages?: Record<string, { version?: string }>;
};

function extractSharpOverride(pkg: PackageJson): string | undefined {
  return pkg.overrides?.sharp;
}

function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split(".").map((n) => Number.parseInt(n, 10));
  const [bMajor, bMinor, bPatch] = b.split(".").map((n) => Number.parseInt(n, 10));
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

function extractSharpVersionFromLockfile(lock: Lockfile): string[] {
  const versions: string[] = [];
  if (!lock.packages) return versions;
  for (const [path, meta] of Object.entries(lock.packages)) {
    if (!path.endsWith("node_modules/sharp")) continue;
    if (meta?.version) versions.push(meta.version);
  }
  return versions;
}

function satisfiesFloor(range: string, floor: string): boolean {
  // The override should be `^0.35.0` (or any range whose minimum is >=0.35.0).
  // Avoid pulling in semver as a direct dep — parse the leading constraint.
  const cleaned = range.replace(/^\s+|\s+$/g, "");
  const match = cleaned.match(/^[\^~*]?\s*v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const overrideFloor = `${match[1]}.${match[2]}.${match[3]}`;
  return compareSemver(overrideFloor, floor) >= 0;
}

describe("sharp libvips CVE remediation (#675)", () => {
  it("package.json pins a sharp override ≥0.35.0 (libvips CVE floor)", () => {
    const pkg = readJson(packageJsonPath) as PackageJson;
    const override = extractSharpOverride(pkg);

    expect(
      override,
      "package.json must declare an overrides.sharp entry to remediate the libvips CVEs in sharp@0.33.5",
    ).toBeDefined();
    expect(
      satisfiesFloor(override as string, MIN_PATCHED_SHARP),
      `overrides.sharp (${override}) must require at least ${MIN_PATCHED_SHARP}`,
    ).toBe(true);
  });

  it("package.json comment block references the remediated CVEs / issue", () => {
    // The `"//"` comment block documents why each `overrides` entry exists.
    // Future cleanups must keep referencing issue #675 / the libvips
    // advisories so the rationale doesn't get lost.
    const pkg = readJson(packageJsonPath) as PackageJson & {
      "//"?: Record<string, string>;
    };
    const overridesComment = pkg["//"]?.overrides ?? "";
    expect(
      overridesComment.length,
      '"//".overrides rationale comment must be present',
    ).toBeGreaterThan(0);
    expect(overridesComment).toMatch(/#675/);
    expect(overridesComment).toMatch(/CVE|libvips|GHSA/i);
  });

  it("package-lock.json resolves a sharp version ≥0.35.0 for prod install", () => {
    const lock = readJson(lockfilePath) as Lockfile;
    const versions = extractSharpVersionFromLockfile(lock);
    expect(
      versions.length,
      "package-lock.json should contain at least one node_modules/sharp entry",
    ).toBeGreaterThan(0);

    for (const version of versions) {
      expect(
        compareSemver(version, MIN_PATCHED_SHARP) >= 0,
        `sharp@${version} in the lockfile must satisfy ≥${MIN_PATCHED_SHARP} to clear the libvips CVEs`,
      ).toBe(true);
    }
  });
});
