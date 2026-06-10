# Accepted Security Risks

The following moderate-severity advisories are accepted as low-risk for the dispatch project.
Fixing them would require major version downgrades that break functionality.

## 1. `next` → bundled `postcss` (XSS via unescaped `</style>` — GHSA-qx2v-qp2m-jg93)

- **Affected:** `next@16.2.7` bundles `postcss@8.4.31` (< 8.5.10)
- **Impact:** Moderate (CVSS 6.1) — XSS requires user interaction (UI:R in CVSS)
- **Why not fix:** Latest stable Next.js (16.2.7) still bundles vulnerable postcss.
  Upgrading to a patched version would require a major downgrade to `next@9.3.3`,
  which is not viable. The attack surface requires user-supplied CSS with crafted
  `</style>` tags — unlikely in our self-hosted deployment model.

## 2. `prisma` → `@prisma/dev` → `@hono/node-server` (Middleware bypass — GHSA-92pp-h63x-v22m)

- **Affected:** `prisma@7.8.0` depends on `@prisma/dev` ≤ 0.24.8, which depends
  on `@hono/node-server` < 1.19.13 (middleware bypass via repeated slashes in serveStatic)
- **Impact:** Moderate (CVSS 5.3) — path traversal in static file serving
- **Why not fix:** The only fix available is downgrading to `prisma@6.19.3` (major downgrade).
  Our deployment does not use `serveStatic` with user-controlled paths, and Prisma's
  dev tools are not exposed in production builds.

## Resolution

| Advisory | Status | Action |
|---|---|---|
| Trivy action pinned to SHA | ✅ Resolved | `aquasecurity/trivy-action@ed142fd` (v0.36.0) |
| `.npmrc` invalid omit config | ✅ Resolved | Fixed `omit=` → `omit=dev` |
| next/postcss XSS | 🟡 Accepted risk | Monitor for Next.js patch; no viable upgrade path |
| prisma/@hono/node-server bypass | 🟡 Accepted risk | Monitor for Prisma patch; no viable upgrade path |
