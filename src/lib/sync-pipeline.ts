/**
 * Sync-pipeline arm state (#1255) — the single derived fact about whether
 * the issue-sync pipeline is expected to run.
 *
 * The in-process scheduler (DISPATCH_SCHEDULER_ENABLED) is OFF by default
 * while Dispatch documents external cron/CronJob topologies as supported, so
 * "is the scheduler armed?" is NOT the same question as "should the sync
 * pipeline run?". Inferring the latter from the former silently suppressed
 * every sync-freshness alert in exactly the deployments where the pipeline
 * genuinely runs.
 *
 * The arm state is therefore driven by the DECLARED topology plus in-process
 * facts only — never by sync history:
 *
 * - The operator declares the topology (DISPATCH_SYNC_PIPELINE:
 *   auto|external|off). `auto` means "the in-process scheduler decides", and
 *   it resolves to `unknown` when the in-process scheduler is not running: an
 *   operator running an external driver MUST declare `external`.
 * - Sync history is deliberately NOT part of the arm state. A single one-off
 *   manual sync is not a pipeline: inferring "armed" from history turned the
 *   DEFAULT deployment (in-process scheduler off, `auto`, default 15m
 *   interval) into a false CRITICAL A2 thirty minutes after any manual
 *   `POST /api/sync`. History also cannot tell "an external driver that is
 *   currently broken" from "a deployment that syncs rarely by design" — only
 *   the operator's declaration can. The trade-off is explicit: an external
 *   driver that is not declared `external` is reported as `unknown` (never
 *   healthy, never stale) and therefore never pages.
 *
 * The three states keep their meanings:
 * - armed: the pipeline is expected to run; freshness IS evaluable.
 * - off: the operator opted out; an opt-out is never a fault.
 * - unknown: it cannot be told — never "healthy", never "stale".
 */

export type SyncPipelineDeclaration = "auto" | "external" | "off";

export type SyncPipelineState = "armed" | "off" | "unknown";

/** Every state value of the arm state, in a deterministic order. */
export const SYNC_PIPELINE_STATES: readonly SyncPipelineState[] = ["armed", "off", "unknown"];

let warnedDeclaration: string | null = null;
let warnedExternalWithoutInterval = false;

/**
 * The operator's declaration. Unset means "auto" (infer); an unrecognised
 * value is logged once and treated as "auto" so a typo can never silence the
 * pipeline.
 */
export function syncPipelineDeclarationFromEnv(
  env: Record<string, string | undefined> = process.env,
): SyncPipelineDeclaration {
  const raw = env.DISPATCH_SYNC_PIPELINE?.trim().toLowerCase();
  if (!raw) return "auto";
  if (raw === "auto") return "auto";
  if (raw === "off") return "off";
  if (raw === "external") {
    warnIfExternalWithoutInterval(env);
    return "external";
  }
  if (warnedDeclaration !== raw) {
    warnedDeclaration = raw;
    console.warn(
      `[sync-pipeline] unrecognised DISPATCH_SYNC_PIPELINE="${raw}"; expected auto, external or off. Falling back to auto.`,
    );
  }
  return "auto";
}

/**
 * An external driver runs on its own cadence, but the freshness window the
 * sync-freshness alerts judge comes from DISPATCH_SYNC_INTERVAL_MS. Without
 * it the window silently defaults to 900000 ms (15m), so a slower driver
 * pages falsely — so say it once, loudly, at boot.
 */
function warnIfExternalWithoutInterval(env: Record<string, string | undefined>): void {
  if (warnedExternalWithoutInterval) return;
  if (env.DISPATCH_SYNC_INTERVAL_MS?.trim()) return;
  warnedExternalWithoutInterval = true;
  console.warn(
    "[sync-pipeline] DISPATCH_SYNC_PIPELINE=external but DISPATCH_SYNC_INTERVAL_MS is unset — the freshness window the sync-freshness alerts judge defaults to 900000 ms (15m); set it to your driver's cadence or the staleness alerts will misfire.",
  );
}

/**
 * Derive the arm state from the declaration and the in-process facts.
 *
 * Resolution order:
 * 1. `off` — the operator opted out; explicit intent wins.
 * 2. `external` — an external driver owns the pipeline, so it is armed
 *    regardless of the in-process scheduler and regardless of history.
 * 3. `auto` + a disabled sync job (interval 0) — the documented opt-out knob.
 * 4. `auto` + the in-process scheduler ticking — armed.
 * 5. otherwise — unknown: the in-process scheduler is not running, so
 *    Dispatch cannot tell whether a pipeline is expected. An operator running
 *    an external driver MUST declare `external`; sync history is never
 *    evidence of one.
 */
export function resolveSyncPipelineState(
  declaration: SyncPipelineDeclaration,
  facts: { schedulerEnabled: boolean; syncIntervalMs: number },
): SyncPipelineState {
  if (declaration === "off") return "off";
  if (declaration === "external") return "armed";
  if (facts.syncIntervalMs === 0) return "off";
  if (facts.schedulerEnabled) return "armed";
  return "unknown";
}
