// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #1166: `.npmrc` sets `include=dev` (added in #428) so `npm ci` installs
// devDependencies for lint/test. In npm's config the `include` set wins over
// the `omit` set, so `npm audit --omit=dev` silently audited the dev tree —
// the dev-only braces advisory GHSA-vfj7-8cjw-p6xm (all versions, no patched
// release) turned the gate red on main. The fix is an explicit `--include=prod`
// in the audit script, which cancels the .npmrc value and lets `--omit=dev`
// take effect; production and optional dependencies stay fully in scope.

// The audit gate is now robust to .npmrc at any config level, so this test
// deliberately does NOT pin `include=dev` in .npmrc — CI installs pass
// `--include=dev` explicitly via .github/actions/setup-node/action.yml.

// Vitest runs tests from the project root, so `process.cwd()` is the
// repository root regardless of where the test file lives.
const packageJsonPath = join(process.cwd(), "package.json");

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

type PackageJson = {
  scripts?: Record<string, string>;
  "//"?: Record<string, string>;
};

describe("npm audit gate scoped to prod dependencies (#1166)", () => {
  it("audit script contains --omit=dev", () => {
    const pkg = readJson(packageJsonPath) as PackageJson;
    const audit = pkg.scripts?.audit;
    expect(audit, "package.json must declare an audit script").toBeDefined();
    expect(audit).toContain("--omit=dev");
  });

  it("audit script contains --include=prod", () => {
    const pkg = readJson(packageJsonPath) as PackageJson;
    const audit = pkg.scripts?.audit;
    expect(audit, "package.json must declare an audit script").toBeDefined();
    expect(audit).toContain("--include=prod");
  });

  it("audit script contains --audit-level=high", () => {
    const pkg = readJson(packageJsonPath) as PackageJson;
    const audit = pkg.scripts?.audit;
    expect(audit, "package.json must declare an audit script").toBeDefined();
    expect(audit).toContain("--audit-level=high");
  });

  it("audit script carries the empirically validated adjacent flag pair `--omit=dev --include=prod`", () => {
    const pkg = readJson(packageJsonPath) as PackageJson;
    const audit = pkg.scripts?.audit;
    expect(audit, "package.json must declare an audit script").toBeDefined();
    // The exact adjacent pair is what was validated on this lockfile:
    // `--omit=dev` alone is silently overridden by .npmrc's `include=dev`.
    expect(audit).toContain("--omit=dev --include=prod");
  });

  it('package.json "//" block documents the audit scoping rationale', () => {
    const pkg = readJson(packageJsonPath) as PackageJson;
    const auditComment = pkg["//"]?.audit ?? "";
    expect(
      auditComment.length,
      '"//".audit rationale comment must be present and non-empty',
    ).toBeGreaterThan(0);
    expect(auditComment).toMatch(/#1166/);
    expect(auditComment).toMatch(/GHSA/i);
  });

  it("Security Audit workflow still runs the blocking `npm run audit` gate", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "security-audit.yaml"),
      "utf8",
    );
    expect(workflow).toContain("npm run audit");
    // The dev-inclusive pass must stay non-blocking (visibility, not a gate).
    expect(workflow).toMatch(/continue-on-error:\s*true[\s\S]*npm audit --include=dev/);
  });
});
