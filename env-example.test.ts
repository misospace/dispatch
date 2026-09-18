// @vitest-environment node
// Guard that `.env.example` stays in lockstep with the environment variables
// the production code actually reads.
//
// The drift this catches: a new `process.env.NAME` lands in production code
// but the var is never added to `.env.example`, so a fresh deployment misses
// it. This is the same class of drift tracked by #763 (a ~20-var sweep),
// #802 (DISPATCH_RECONCILE_INTERVAL_MS), #915 (DISPATCH_STALE_WORK_INTERVAL_MS)
// and #1032 (PR_FIX_MAX_ATTEMPTS, the DISPATCH_GROOMER_* tool-loop vars,
// DISPATCH_CI_FAILURE_LABELS, DISPATCH_DEFERRAL_TTL_DAYS).
//
// The test walks every `.ts`/`.tsx` file under `src/`, extracts each distinct
// `process.env.NAME` reference, and asserts the name appears as an entry in
// `.env.example`. Adding a var to production code that is not documented here
// fails the build.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const srcDir = join(root, "src");
const envExamplePath = join(root, ".env.example");

// Framework / build-time vars are read by the code (e.g. src/instrumentation.ts
// checks NEXT_RUNTIME) but are managed by the Next.js runtime or build process,
// not by the operator. `.env.example` intentionally omits them and documents
// that omission in a footer note, so the guard excludes them from the check.
// Keep this list in sync with that note in .env.example.
const EXCLUDED = new Set<string>(["NODE_ENV", "NEXT_RUNTIME", "NEXT_PUBLIC_DISPATCH_VERSION"]);

// `process.env.NAME` where NAME is a conventional UPPER_SNAKE token.
const ENV_REF = /process\.env\.([A-Z][A-Z0-9_]+)/g;

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, out);
      continue;
    }
    if (!st.isFile()) continue;
    // Only TypeScript sources; skip tests (their `process.env` usage is
    // harness scaffolding, not documented configuration).
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function discoverEnvVars(): Set<string> {
  const found = new Set<string>();
  for (const file of walkTsFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(ENV_REF)) {
      found.add(match[1]);
    }
  }
  return found;
}

// A var is "documented" if it has an assignment entry in .env.example — a
// commented `# VAR=...` (all the optional vars) or an active `VAR=...` (the
// required bootstrap vars). Leading `#` and indentation are tolerated.
function documentedVarNames(): Set<string> {
  const names = new Set<string>();
  const lines = readFileSync(envExamplePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.replace(/^#/, "").trimStart();
    const m = trimmed.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) names.add(m[1]);
  }
  return names;
}

describe(".env.example ↔ production code alignment", () => {
  it(".env.example is present", () => {
    expect(readFileSync).toBeDefined();
    // Guard against the test silently running against an empty tree.
    expect(walkTsFiles(srcDir).length).toBeGreaterThan(0);
    expect(documentedVarNames().size).toBeGreaterThan(0);
  });

  it("every process.env var read by production code is documented in .env.example", () => {
    const discovered = discoverEnvVars();
    const documented = documentedVarNames();

    const missing = [...discovered]
      .filter((name) => !EXCLUDED.has(name) && !documented.has(name))
      .sort();

    expect(
      missing,
      `These env vars are read via process.env.<NAME> in production code under src/ ` +
        `but have no entry in .env.example. Add a commented ` +
        `"# <NAME>=<default>" line with the current default, units, and a one-line ` +
        `description (see the existing entries).\n` +
        `Missing:\n` +
        missing.map((name) => `  - ${name}`).join("\n"),
    ).toEqual([]);
  });
});
