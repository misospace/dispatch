# Accepted Security Risks

**Last updated: 2026-06-17**

There are currently no accepted npm runtime advisories.

`npm audit --omit=dev` reports **0 vulnerabilities** across 227 production dependencies.

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
