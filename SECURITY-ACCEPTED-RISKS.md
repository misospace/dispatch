# Accepted Security Risks

**Last updated: 2026-07-07**

There are currently no accepted npm runtime advisories.

`npm audit --omit=dev` reports **0 vulnerabilities** across 227 production dependencies.

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

- The project uses 19 production dependencies with transitive chains managed by npm.
- Key deep-chain dependencies: `next` (framework), `@modelcontextprotocol/sdk` (MCP protocol), `prisma` / `@prisma/client` (ORM).
- **Mitigation:** Renovate keeps dependencies updated; `npm audit --omit=dev` is run on every CI push.

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

## Retired Risks

The following previously accepted risks have been retired:

| Advisory | Resolved | Notes |
|---|---|---|
| `next` → bundled `postcss` XSS (GHSA-qx2v-qp2m-jg93) | Patched upstream | postcss vulnerability no longer surfaces in Next.js 16.2.x |
| `prisma` → `@hono/node-server` middleware bypass (GHSA-92pp-h63x-v22m) | Patched upstream | Fixed in Prisma dependency chain |

## Previous Resolution History

| Advisory | Status | Action |
|---|---|---|
| Trivy action pinned to SHA | ✅ Resolved | `aquasecurity/trivy-action@ed142fd` (v0.36.0) |
| `.npmrc` invalid omit config | ✅ Resolved | Fixed `omit=` → `omit=dev` |
