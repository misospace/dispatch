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
}
