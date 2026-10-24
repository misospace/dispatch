// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest runs tests from the project root, so `process.cwd()` is the
// repository root regardless of where the test file lives.
const lockfilePath = join(process.cwd(), "package-lock.json");
const acceptedRisksPath = join(process.cwd(), "SECURITY-ACCEPTED-RISKS.md");

// The vulnerable version ranges below mirror npm's advisory feed for the
// transitive dependencies that kept the blocking `npm run audit` gate red on
// `main` (#1386). They are checked against the lockfile so a later lock
// refresh cannot silently re-resolve one of these packages into a vulnerable
// release.
//
// The ranges were read from npm's advisory database on 2026-10-24 and every
// boundary was probed with `npm audit` against that exact version. They are
// deliberately expressed as ranges instead of a single floor: several of the
// advisories only cover part of a major line — `fast-uri` 2.x is not affected,
// `body-parser` 1.x only up to 1.20.8, `undici` 6.x and 7.x have their own
// boundaries — so one floor per package would fail on clean copies.
//
// Scope mirrors the gate itself: the blocking audit is scoped to the
// production tree (`npm audit --omit=dev --include=prod`), so production
// packages are only checked on production-reachable copies. Dev-only copies
// stay visible in the informational dev-inclusive audit step.
type VersionRange = { from: string; to: string };

type AdvisorySpec = {
  name: string;
  ranges: VersionRange[];
  advisories: string[];
  scope: "prod" | "dev";
};

const ADVISORY_SPECS: AdvisorySpec[] = [
  {
    // body-parser: trailing-bytes DoS on a compressed body (2.0.0 - 2.3.0)
    // plus the earlier 1.x advisories (through 1.20.8). Fixed in 1.20.9 and
    // 2.4.0 respectively.
    name: "body-parser",
    ranges: [
      { from: "0.0.0", to: "1.20.8" },
      { from: "2.0.0", to: "2.3.0" },
    ],
    advisories: ["GHSA-27r3-jxmh-p828"],
    scope: "prod",
  },
  {
    // hono: the serveStatic request-path double-decode middleware bypass
    // (4.12.4 - 4.13.10) together with the earlier advisories covering every
    // release up to 4.13.6. Fixed in 4.13.11.
    name: "hono",
    ranges: [{ from: "0.0.0", to: "4.13.10" }],
    advisories: ["GHSA-5r4p-p66f-jhc7"],
    scope: "prod",
  },
  {
    // ip-address: Address6 quadratic-time stall on zone-identifier input and
    // the earlier advisories (SSRF / trust-boundary bypasses) covering every
    // release up to 10.7.3. Fixed in 10.7.4.
    name: "ip-address",
    ranges: [{ from: "0.0.0", to: "10.7.3" }],
    advisories: ["GHSA-rxp7-6hxx-x8q5"],
    scope: "prod",
  },
  {
    // fast-uri: URI scheme spoofing, path-equivalence, host-confusion and
    // scheme-injection advisories across 3.0.0 - 3.1.8. Fixed in 3.1.9.
    name: "fast-uri",
    ranges: [{ from: "3.0.0", to: "3.1.8" }],
    advisories: [
      "GHSA-w74x-v6f9-j3xg",
      "GHSA-xhq7-xmqj-769h",
      "GHSA-wjr9-j795-jxcr",
      "GHSA-333x-w4r6-6crp",
    ],
    scope: "prod",
  },
  {
    // undici: EventSource memory DoS, SRI bypass and content-encoding DoS
    // across 8.0.0 - 8.12.1, plus the earlier 6.x and 7.x advisories. Fixed
    // in 6.29.1, 7.31.0 and 8.12.2 respectively.
    name: "undici",
    ranges: [
      { from: "0.0.0", to: "6.29.0" },
      { from: "7.0.0", to: "7.30.0" },
      { from: "8.0.0", to: "8.12.1" },
    ],
    advisories: [
      "GHSA-4qv8-2p9j-2685",
      "GHSA-f72v-6w45-q472",
      "GHSA-xjj6-f33q-929c",
    ],
    scope: "dev",
  },
];

type Lockfile = {
  packages?: Record<string, { version?: string; dev?: boolean }>;
};

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

// Versions in a lockfile are always `major.minor.patch`; prerelease and build
// metadata are stripped so a prerelease is compared against its numeric core.
function parseVersion(raw: string): [number, number, number] {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`cannot compare version "${raw}": expected major.minor.patch`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function isInRange(version: string, range: VersionRange): boolean {
  return (
    compareVersions(version, range.from) >= 0 &&
    compareVersions(version, range.to) <= 0
  );
}

// Every resolved copy ships, so each copy is checked on its own — a nested
// copy inside a parent package is installed too.
function resolvedCopies(lock: Lockfile, name: string) {
  const copies: { path: string; version?: string; devOnly: boolean }[] = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.endsWith(`node_modules/${name}`)) continue;
    copies.push({ path, version: meta?.version, devOnly: meta?.dev === true });
  }
  return copies;
}

describe("advisory version ranges for the blocking npm audit gate (#1386)", () => {
  for (const spec of ADVISORY_SPECS) {
    it(`no ${spec.scope}-reachable copy of ${spec.name} resolves into a vulnerable range`, () => {
      const lock = readJson(lockfilePath) as Lockfile;
      const copies = resolvedCopies(lock, spec.name);

      // Production packages are only checked on production-reachable copies:
      // that is the scope the blocking gate covers. A package that left the
      // tree entirely has nothing left to guard.
      const inScope =
        spec.scope === "dev"
          ? copies
          : copies.filter((copy) => !copy.devOnly);

      for (const copy of inScope) {
        expect(
          copy.version,
          `${copy.path} must carry a resolved version`,
        ).toBeDefined();
        const version = copy.version as string;

        for (const range of spec.ranges) {
          expect(
            isInRange(version, range),
            `${spec.name}@${version} (${copy.path}) falls inside the vulnerable range ${range.from} - ${range.to} (${spec.advisories.join(", ")})`,
          ).toBe(false);
        }
      }
    });
  }

  it("SECURITY-ACCEPTED-RISKS.md documents every pinned advisory", () => {
    const acceptedRisks = readFileSync(acceptedRisksPath, "utf8");
    expect(
      acceptedRisks.length,
      "SECURITY-ACCEPTED-RISKS.md must be present and non-empty",
    ).toBeGreaterThan(0);

    for (const spec of ADVISORY_SPECS) {
      for (const advisory of spec.advisories) {
        expect(
          acceptedRisks,
          `SECURITY-ACCEPTED-RISKS.md must document ${advisory} (${spec.name})`,
        ).toContain(advisory);
      }
    }
  });

  it("SECURITY-ACCEPTED-RISKS.md references the issue that drove the remediation", () => {
    const acceptedRisks = readFileSync(acceptedRisksPath, "utf8");
    expect(acceptedRisks).toMatch(/#1386/);
  });
});
