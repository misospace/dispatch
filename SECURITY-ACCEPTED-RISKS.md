# Accepted Security Risks

**Last updated: 2026-10-03**

There are currently no accepted npm runtime advisories.

`npm audit --omit=dev --include=prod` reports **0 vulnerabilities** across the production dependency tree (17 direct production dependencies plus optional/native deps such as the Next.js platform binaries).

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

### braces stack-exhaustion DoS (GHSA-vfj7-8cjw-p6xm)

- **Severity:** high.
- **Affected:** all published `braces` versions (`<=3.0.3`; no patched release as of 2026-10-03).
- **Reachability:** dev lint chain only — `eslint-config-next -> @next/eslint-plugin-next -> fast-glob -> micromatch -> braces`.
- **Shipping surface:** the main server runtime image installs production dependencies only (`Dockerfile` `prod-deps` stage: `npm ci --omit=dev`), so the chain is absent from the server image. Caveat: the separately published `-mcp` image runs from the `deps` stage tree (`npm ci`, devDependencies included, entrypoint `tsx`), so the lint chain is present there as inert tooling — the MCP server never invokes micromatch/braces.
- **Exploit path:** requires feeding attacker-controlled deeply-nested glob patterns to micromatch during lint tooling; no request path in the server or MCP image reaches it.
- **Decision:** accepted for the dev toolchain; the production audit gate is scoped with `--omit=dev --include=prod` (#1166), and dev advisories stay visible via the non-blocking dev-inclusive audit step in `.github/workflows/security-audit.yaml`. Revisit if an upstream patched release lands (then remove nothing — the scoped gate stays; optionally test whether the advisory clears).

## Retired Risks

The following previously accepted risks have been retired:

| Advisory | Resolved | Notes |
|---|---|---|
| `next` → bundled `postcss` XSS (GHSA-qx2v-qp2m-jg93) | Patched upstream | postcss vulnerability no longer surfaces in Next.js 16.2.x |
| `prisma` → `@hono/node-server` middleware bypass (GHSA-92pp-h63x-v22m) | Patched upstream | Fixed in Prisma dependency chain |

## Previous Resolution History

| Advisory | Status | Action |
|---|---|---|
| Trivy action pinned to SHA | ✅ Resolved | `aquasecurity/trivy-action@ed142fd` (v0.36.0). The SHA pin is intentional: trivy is the release gate, so a floating tag must not reach a release build. Renovate's `github-tags` datasource cannot resolve a bare SHA pin (it only produced a `no-result` lookup failure on the dashboard), so the action is excluded from Renovate in `renovate.json` (`matchPackageNames: ["aquasecurity/trivy-action"]`, `enabled: false`) and is bumped manually, with the version comment, after reviewing an upstream release. |
| `.npmrc` invalid omit config | ✅ Resolved | Fixed `omit=` → `omit=dev` |
| `npm audit` gate silently auditing the dev tree | ✅ Resolved (#1166) | `.npmrc` `include=dev` (added #428) overrides `--omit=dev` in npm's config, so `npm audit --omit=dev` audited devDependencies too. The dev-only `braces` advisory GHSA-vfj7-8cjw-p6xm (all versions, no fix) exposed it on main. Fixed by adding an explicit `--include=prod` to the `audit` script so `--omit=dev` takes effect (prod + optional still audited); regression-guarded by `package-audit.test.ts`. |
