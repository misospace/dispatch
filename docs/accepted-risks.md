# Accepted Risks

**Last updated: 2026-07-15**

## In-Memory Rate Limiting Is Per-Instance

- Rate limits on mutating endpoints (`src/lib/rate-limit.ts`) use a module-level in-memory `Map` with fixed-window tracking; limits reset on process restart and are not shared across replicas.
- The fixed-window check allows burst traffic at window boundaries (e.g., all requests allowed immediately after the window resets).
- **Mitigation:** acceptable for the current single-node internal ops tool deployment; move to a shared store (e.g., Redis) if the app is ever scaled horizontally or requires persistent limits across restarts.
