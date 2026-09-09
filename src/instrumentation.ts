/**
 * Next.js instrumentation hook (kept for compatibility).
 *
 * Lane config initialization moved to src/lib/lane-config.ts as a module-load
 * side effect. Turbopack standalone builds isolate instrumentation.ts into a
 * separate chunk graph, so setLaneConfig() there mutated a module instance that
 * route handlers never saw. The module-load init in lane-config.ts guarantees
 * the same module instance is used by all consumers.
 */
export async function register() {
  // Lane config init moved to src/lib/lane-config.ts module-load side effect.

  // Fail-fast OIDC config check. Runs once at startup, before the HTTP
  // listener accepts traffic, so a misconfigured DISPATCH_AUTH_MODE=oidc
  // (missing DISPATCH_OIDC_* vars) surfaces here with a clear error instead
  // of as an opaque NextAuth error at first login. Node runtime only — the
  // edge runtime has no process to fail and the check is redundant there.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISPATCH_AUTH_MODE === "oidc") {
    const { validateOidcConfig } = await import("@/lib/auth");
    validateOidcConfig();
  }

  // In-app periodic scheduler (opt-in via DISPATCH_SCHEDULER_ENABLED). Node
  // runtime only — register() also runs in the edge runtime, which has no
  // timers/loopback. Dynamic import so the edge bundle never pulls it in. The
  // scheduler fires loopback HTTP POSTs (no shared module state with routes),
  // so the Turbopack chunk-graph isolation noted above does not affect it.
  const { schedulerConfigFromEnv, startScheduler } = await import("@/lib/scheduler");
  startScheduler(schedulerConfigFromEnv(process.env), {
    fetch,
    setInterval,
    setTimeout,
    log: (message, error) =>
      error !== undefined
        ? console.error(`[scheduler] ${message}`, error)
        : console.log(`[scheduler] ${message}`),
  });
}
