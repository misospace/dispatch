# Accepted Security Risks

**Last updated: 2026-10-24**

There are currently no accepted npm runtime advisories.

`npm audit --omit=dev --include=prod` reports **0 vulnerabilities** (at every severity) across the production dependency tree (17 direct production dependencies plus optional/native deps such as the Next.js platform binaries). The blocking gate runs the same query with `--audit-level=high`; the vulnerable version ranges of the advisories remediated in #1386 are pinned by `package-advisory-ranges.test.ts`, so a later lock refresh cannot silently reintroduce a vulnerable build.

## Non-NPM Risks

The following risks are tracked beyond npm advisories:

### Auth Mode Configuration Drift

- `DISPATCH_AUTH_MODE` controls authentication behavior across all API routes.
- When unset or set to `"legacy"`, the health endpoint reports `authMode: "legacy"` and auth checks fall back to `GITHUB_TOKEN` validation.
- If `DISPATCH_AUTH_MODE` is misconfigured (e.g., set to an unknown value), the system defaults to legacy mode rather than failing closed.
- **Mitigation:** CI health-check tests verify auth mode reporting; deployment runbooks document valid values (`oidc`, `disabled`, or unset for legacy).

### GitHub Token Exposure Surface

- `GITHUB_TOKEN` is read from environment variables in multiple source files:
  - `src/lib/github.ts` — Octokit client initialization (used by PR, issue, and comment operations)
  - `src/lib/auth.ts` — legacy authentication fallback for agent heartbeat, task reporting, and work summary endpoints
- The token is passed to the Octokit SDK and used for all GitHub API interactions.
- **Mitigation:** Token scope should be limited to the minimum required permissions; CI workflows use short-lived tokens where possible.

### Dependency Chain Length

- The project uses 17 production dependencies with transitive chains managed by npm.
- Key deep-chain dependencies: `next` (framework), `@modelcontextprotocol/sdk` (MCP protocol), `prisma` / `@prisma/client` (ORM).
- **Mitigation:** Renovate keeps dependencies updated; `npm audit --omit=dev --include=prod --audit-level=high` runs on every push to `main` and every pull request via `.github/workflows/security-audit.yaml` (separate from the main CI workflow) and fails the build on high/critical vulnerabilities.

### Groomer Autonomous Issue Rewrites (accepted risk)

- The hosted groomer can rewrite issue titles and enrich issue bodies based purely on LLM output, with no human-in-the-loop confirmation (`src/lib/groomer/run.ts` → `updateTitleAndBody`).
- Guardrails that bound the blast radius:
  - Schema validation enforces title length (10–200 chars) and body size (<10K chars), and `shouldRewriteTitle` / `shouldEnrichBody` gates limit when rewrites are attempted.
  - Rewrites only touch issues the groomer selected for grooming; every run is recorded (`GroomingRun`) and label changes are audit-logged.
  - `POST /api/groomer/run` is rate-limited (10/min per actor) and requires the groomer token.
- **Decision:** accepted for this internal single-team tool — original content is recoverable from GitHub issue edit history, and a confirmation gate would defeat the purpose of unattended grooming. Revisit if the tool is exposed to external users or repos with contributors outside the team.

### In-Memory Rate Limiting Is Per-Instance

- Rate limits on mutating endpoints (`src/lib/rate-limit.ts`) use module-level in-memory state; limits reset on restart and are not shared across replicas.
- **Mitigation:** acceptable for the current single-node deployment; move to a shared store if the app is ever scaled horizontally.

## Dev-Only Advisories

`npm audit --include=dev` reports **0 vulnerabilities**: the dev-inclusive tree is currently clean. The dev-only advisory that used to be accepted here (the `braces` stack-exhaustion DoS) was withdrawn upstream — see [Retired Risks](#retired-risks).

## Retired Risks

The following previously accepted risks have been retired:

| Advisory | Resolved | Notes |
|---|---|---|
| `next` → bundled `postcss` XSS (GHSA-qx2v-qp2m-jg93) | Patched upstream | postcss vulnerability no longer surfaces in Next.js 16.2.x |
| `prisma` → `@hono/node-server` middleware bypass (GHSA-92pp-h63x-v22m) | Patched upstream | Fixed in Prisma dependency chain |
| `braces` stack-exhaustion DoS (GHSA-vfj7-8cjw-p6xm, CVE-2026-93687) | Withdrawn upstream | GitHub withdrew the advisory on 2026-10-23 as "not a practically exploitable vulnerability", and npm's advisory feed no longer flags `braces` — `npm audit --include=dev` is clean again. The package is still in the dev-only lint chain (`eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces`) and still ships in no published image; the accepted-risk entry was retired rather than reopened. Revisit if the advisory is reinstated upstream — nothing else changes, since the accepted-risk decision was scope-based and the production gate stays scoped to `--omit=dev --include=prod` (#1166). |

## Previous Resolution History

| Advisory | Status | Action |
|---|---|---|
| Trivy action pinned to SHA | ✅ Resolved | `aquasecurity/trivy-action@ed142fd` (v0.36.0). The SHA pin is intentional: trivy is the release gate, so a floating tag must not reach a release build. Renovate's `github-tags` datasource cannot resolve a bare SHA pin (it only produced a `no-result` lookup failure on the dashboard), so the action is excluded from Renovate in `renovate.json` (`matchPackageNames: ["aquasecurity/trivy-action"]`, `enabled: false`) and is bumped manually, with the version comment, after reviewing an upstream release. |
| `.npmrc` invalid omit config | ✅ Resolved | Fixed `omit=` → `omit=dev` |
| `npm audit` gate silently auditing the dev tree | ✅ Resolved (#1166) | `.npmrc` `include=dev` (added #428) overrides `--omit=dev` in npm's config, so `npm audit --omit=dev` audited devDependencies too. The dev-only `braces` advisory GHSA-vfj7-8cjw-p6xm (all versions, no fix) exposed it on main. Fixed by adding an explicit `--include=prod` to the `audit` script so `--omit=dev` takes effect (prod + optional still audited); regression-guarded by `package-audit.test.ts`. |
| Dev-only advisory chain `eslint-config-next` -> `@next/eslint-plugin-next` -> `fast-glob` -> `micromatch` -> `braces` (GHSA-vfj7-8cjw-p6xm) | ✅ Resolved (image scope) | #1173: the `-mcp` image is now built from a production-only install plus a tsx layer, so the chain ships in no published image. It remains in dev installs only; `.github/workflows/image.yaml` asserts its absence from the `-mcp` image on every build. |
| `body-parser` DoS via trailing bytes after a compressed request body (GHSA-27r3-jxmh-p828, high) | ✅ Resolved (#1386) | Transitive production dependency (`@modelcontextprotocol/sdk` → `express` → `body-parser`). No `package.json` range changed; the lockfile resolves `body-parser` 2.4.0, past the affected ranges through 1.20.8 and 2.0.0-2.3.0. Guarded by `package-advisory-ranges.test.ts`. |
| `hono` `serveStatic` request-path double-decode middleware bypass (GHSA-5r4p-p66f-jhc7, moderate) | ✅ Resolved (#1386) | Transitive production dependency (`@modelcontextprotocol/sdk` → `hono`, also via `@hono/node-server` → `hono`). Lockfile resolves `hono` 4.13.13, past the affected range 4.12.4-4.13.10. Guarded by `package-advisory-ranges.test.ts`. |
| `ip-address` `Address6` quadratic-time stall on zone-identifier input (GHSA-rxp7-6hxx-x8q5, moderate) | ✅ Resolved (#1386) | Transitive production dependency (`@modelcontextprotocol/sdk` → `express-rate-limit` → `ip-address`). Lockfile resolves `ip-address` 10.7.4, past the affected range up to 10.7.3. Guarded by `package-advisory-ranges.test.ts`. |
| `fast-uri` URI scheme spoofing, path-equivalence, host-confusion and scheme-injection advisories (GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp; moderate/low) | ✅ Resolved (#1386) | Transitive production dependency (`ajv` → `fast-uri`, reached from `@modelcontextprotocol/sdk` and `@prisma/streams-local`). Lockfile resolves `fast-uri` 3.1.9, past the affected range 3.0.0-3.1.8. Guarded by `package-advisory-ranges.test.ts`. |
| `undici` EventSource memory DoS, SRI bypass and content-encoding DoS advisories (GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472, GHSA-xjj6-f33q-929c; moderate/high) | ✅ Resolved (#1386) | Dev-only dependency (`jsdom` → `undici`); it never reached a published image. Lockfile resolves `undici` 8.12.3, past the affected ranges up to 6.29.0, 7.0.0-7.30.0 and 8.0.0-8.12.1. Guarded by `package-advisory-ranges.test.ts`. |
