// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest runs tests from the project root, so `process.cwd()` is the
// repository root regardless of where the test file lives.
const lockfilePath = join(process.cwd(), "package-lock.json");
const acceptedRisksPath = join(process.cwd(), "SECURITY-ACCEPTED-RISKS.md");

// The vulnerable version ranges below are the **union of every advisory the
// npm advisory feed lists for these packages** (fetched per-package on
// 2026-10-24), not only the advisories named in #1386: the blocking gate flags
// any vulnerable resolution, so pinning a subset of a package's advisory
// history would let a re-resolution into an older advisory through.
//
// Every boundary was read from the feed and cross-checked: no release the feed
// marks as patched falls inside a pinned range (checked per major line for
// `fast-uri`, `body-parser` and `undici`), and every version the feed marks
// vulnerable falls inside one. They are deliberately expressed as ranges
// instead of a single floor: the advisories are per-major-line — `fast-uri` 2.x
// ends at 2.4.7 while its 4.x line only ends at 4.2.2, `body-parser` 1.x only
// up to 1.20.8 — so one floor per package would fail on clean copies.
//
// Scope mirrors the gate itself: the blocking audit is scoped to the
// production tree (`npm audit --omit=dev --include=prod`), so production
// packages are only checked on production-reachable copies. Dev-only copies
// stay visible in the informational dev-inclusive audit step.
//
// `from` is inclusive and `to` is exclusive, matching the feed's
// `< first-patched` boundary style: a range pins "vulnerable from `from`
// until the first patched release".
type VersionRange = { from: string; to: string };

type AdvisorySpec = {
  name: string;
  ranges: VersionRange[];
  advisories: string[];
  scope: "prod" | "dev";
  // One version per pinned range that the advisory feed marks vulnerable,
  // plus the first patched release of each affected major line. If a range
  // is dropped or narrowed, the vulnerable probes stop being flagged and
  // this data fails the guard below.
  vulnerableProbes: string[];
  patchedProbes: string[];
};

const ADVISORY_SPECS: AdvisorySpec[] = [
  {
    // body-parser: trailing-bytes DoS on a compressed body (2.0.0 - <2.4.0)
    // plus the earlier advisories covering every 1.x below 1.20.9.
    name: "body-parser",
    ranges: [
      { from: "0.0.0", to: "1.20.9" },
      { from: "2.0.0", to: "2.4.0" },
    ],
    advisories: ["GHSA-27r3-jxmh-p828"],
    scope: "prod",
    vulnerableProbes: ["1.20.8", "2.3.0"],
    patchedProbes: ["1.20.9", "2.4.0"],
  },
  {
    // hono: the serveStatic request-path double-decode middleware bypass
    // (4.12.4 - <4.13.11) together with the advisories covering every earlier
    // release. Fixed in 4.13.11.
    name: "hono",
    ranges: [{ from: "0.0.0", to: "4.13.11" }],
    advisories: ["GHSA-5r4p-p66f-jhc7"],
    scope: "prod",
    vulnerableProbes: ["4.13.10"],
    patchedProbes: ["4.13.11"],
  },
  {
    // ip-address: Address6 quadratic-time stall on zone-identifier input plus
    // the earlier advisories (SSRF / trust-boundary bypasses, XSS, subnet
    // comparison) covering every release below 10.7.4. Fixed in 10.7.4.
    name: "ip-address",
    ranges: [{ from: "0.0.0", to: "10.7.4" }],
    advisories: ["GHSA-rxp7-6hxx-x8q5"],
    scope: "prod",
    vulnerableProbes: ["10.7.3"],
    patchedProbes: ["10.7.4"],
  },
  {
    // fast-uri: URI scheme spoofing, path-equivalence, host-confusion and
    // scheme-injection advisories. Each major line carries its own boundary:
    // 2.x below 2.4.8 (host confusion opens at 2.4.2), 3.x below 3.1.9, 4.x
    // below 4.2.3. Fixed in 2.4.8 / 3.1.9 / 4.2.3.
    name: "fast-uri",
    ranges: [
      { from: "0.0.0", to: "2.4.8" },
      { from: "3.0.0", to: "3.1.9" },
      { from: "4.0.0", to: "4.2.3" },
    ],
    advisories: [
      "GHSA-w74x-v6f9-j3xg",
      "GHSA-xhq7-xmqj-769h",
      "GHSA-wjr9-j795-jxcr",
      "GHSA-333x-w4r6-6crp",
    ],
    scope: "prod",
    vulnerableProbes: ["2.4.7", "3.1.8", "4.2.2"],
    patchedProbes: ["2.4.8", "3.1.9", "4.2.3"],
  },
  {
    // undici: EventSource memory DoS, SRI bypass, content-encoding DoS and
    // the earlier 4.x-7.x advisories (WebSocket parser crashes, response
    // splitting, cookie disclosure, proxy pooling, TLS validation). The 6.x
    // line closes at 6.29.1, 7.x at 7.30.1 and 8.x at 8.12.2.
    name: "undici",
    ranges: [
      { from: "0.0.0", to: "6.29.1" },
      { from: "7.0.0", to: "7.30.1" },
      { from: "8.0.0", to: "8.12.2" },
    ],
    advisories: [
      "GHSA-4qv8-2p9j-2685",
      "GHSA-f72v-6w45-q472",
      "GHSA-xjj6-f33q-929c",
    ],
    scope: "dev",
    vulnerableProbes: ["6.29.0", "7.30.0", "8.12.1"],
    patchedProbes: ["6.29.1", "7.30.1", "8.12.2"],
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

// `range.to` is the first patched release and is exclusive: a version equal to
// `to` is fixed, not vulnerable.
function isInRange(version: string, range: VersionRange): boolean {
  return (
    compareVersions(version, range.from) >= 0 &&
    compareVersions(version, range.to) < 0
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
            `${spec.name}@${version} (${copy.path}) falls inside the vulnerable range ${range.from} <= v < ${range.to} (${spec.advisories.join(", ")})`,
          ).toBe(false);
        }
      }
    });
  }

  // Self-check on the pins themselves: every vulnerable probe must fall in a
  // pinned range and every patched probe must fall in none. This is what
  // catches a range being dropped or narrowed (the #1386 review finding: the
  // original pins missed fast-uri's 2.x and 4.x advisory lines).
  for (const spec of ADVISORY_SPECS) {
    it(`${spec.name} pins cover exactly their vulnerable/patched probe versions`, () => {
      for (const version of spec.vulnerableProbes) {
        expect(
          spec.ranges.some((range) => isInRange(version, range)),
          `${spec.name}@${version} must be pinned as vulnerable`,
        ).toBe(true);
      }
      for (const version of spec.patchedProbes) {
        expect(
          spec.ranges.some((range) => isInRange(version, range)),
          `${spec.name}@${version} is patched and must not be pinned as vulnerable`,
        ).toBe(false);
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
