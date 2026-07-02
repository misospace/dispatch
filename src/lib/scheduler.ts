/**
 * In-app periodic scheduler.
 *
 * Runs periodic work (issue sync today; groomer/pr-followup/prune to follow)
 * from inside the Next.js server process instead of external Kubernetes
 * cronjobs, wired from `src/instrumentation.ts` `register()`.
 *
 * Jobs fire as **loopback HTTP POSTs to the app's own endpoints**, not direct
 * function calls. This is deliberate:
 *   - It routes through the real Next.js router (the route handler's module
 *     graph), avoiding the Turbopack standalone chunk-graph isolation that the
 *     instrumentation.ts / lane-config.ts comments describe — a scheduler in
 *     the instrumentation chunk that imported job functions directly could run
 *     against a different module instance (stale lane config, etc.).
 *   - It reuses each endpoint's existing auth + locking for free (e.g. the sync
 *     endpoint's DB lock makes concurrent fires collapse to one via 409).
 *
 * Opt-in via DISPATCH_SCHEDULER_ENABLED so dev/CI don't spin timers, and so it
 * can be confined to a single replica until per-job locks exist for the others.
 */

export interface ScheduledJob {
  name: string;
  /** App-relative path, e.g. "/api/sync/scheduled". */
  path: string;
  /** JSON body POSTed to the endpoint. */
  body: unknown;
  intervalMs: number;
}

export interface SchedulerConfig {
  enabled: boolean;
  /** Loopback base, e.g. "http://127.0.0.1:3000". */
  baseUrl: string;
  /** Bearer token for the endpoints (DISPATCH_AGENT_TOKEN). */
  token: string;
  /** Delay before the first fire, so the HTTP server is listening. */
  startupDelayMs: number;
  jobs: ScheduledJob[];
}

export interface SchedulerDeps {
  fetch: typeof fetch;
  setInterval: (fn: () => void, ms: number) => unknown;
  setTimeout: (fn: () => void, ms: number) => unknown;
  log: (message: string, error?: unknown) => void;
}

const DEFAULT_SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15m
const DEFAULT_GROOMER_INTERVAL_MS = 10 * 60 * 1000; // 10m
const DEFAULT_PR_FOLLOWUP_INTERVAL_MS = 15 * 60 * 1000; // 15m
const DEFAULT_PRUNE_CLOSED_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DEFAULT_STARTUP_DELAY_MS = 5 * 1000;

function intFromEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per-job interval: unset → fallback; explicit "0" → 0 (job disabled and
 * filtered out); any other positive value overrides.
 */
function jobIntervalFromEnv(raw: string | undefined, fallback: number): number {
  if (raw !== undefined && raw.trim() === "0") return 0;
  return intFromEnv(raw, fallback);
}

/**
 * Build the scheduler config from the environment. All periodic jobs run via
 * loopback POSTs to the existing endpoints; each is authed with
 * DISPATCH_AGENT_TOKEN (the groomer endpoint accepts it too) and can be
 * disabled individually by setting its interval env to "0".
 */
export function schedulerConfigFromEnv(env: Record<string, string | undefined>): SchedulerConfig {
  const port = env.PORT && env.PORT.trim() !== "" ? env.PORT.trim() : "3000";
  const jobs: ScheduledJob[] = [
    {
      name: "sync",
      path: "/api/sync/scheduled",
      body: { issues: true },
      intervalMs: jobIntervalFromEnv(env.DISPATCH_SYNC_INTERVAL_MS, DEFAULT_SYNC_INTERVAL_MS),
    },
    {
      name: "groomer",
      path: "/api/groomer/run",
      body: {},
      intervalMs: jobIntervalFromEnv(env.DISPATCH_GROOMER_INTERVAL_MS, DEFAULT_GROOMER_INTERVAL_MS),
    },
    {
      name: "pr-followup",
      path: "/api/pr-followup/sync",
      body: {},
      intervalMs: jobIntervalFromEnv(env.DISPATCH_PR_FOLLOWUP_INTERVAL_MS, DEFAULT_PR_FOLLOWUP_INTERVAL_MS),
    },
    {
      name: "prune-closed",
      path: "/api/issues/prune-closed",
      body: {},
      intervalMs: jobIntervalFromEnv(env.DISPATCH_PRUNE_CLOSED_INTERVAL_MS, DEFAULT_PRUNE_CLOSED_INTERVAL_MS),
    },
  ];
  return {
    enabled: env.DISPATCH_SCHEDULER_ENABLED === "true",
    baseUrl: `http://127.0.0.1:${port}`,
    token: env.DISPATCH_AGENT_TOKEN ?? "",
    startupDelayMs: intFromEnv(env.DISPATCH_SCHEDULER_STARTUP_DELAY_MS, DEFAULT_STARTUP_DELAY_MS),
    jobs: jobs.filter((job) => job.intervalMs > 0),
  };
}

/** Fire one job. Never throws — a transient failure must not kill the interval. */
export async function runJob(job: ScheduledJob, config: SchedulerConfig, deps: SchedulerDeps): Promise<void> {
  try {
    const res = await deps.fetch(`${config.baseUrl}${job.path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(job.body),
    });
    // 409 = another run holds the lock (expected under concurrency); not an error.
    if (!res.ok && res.status !== 409) {
      deps.log(`job "${job.name}" -> HTTP ${res.status}`);
    }
  } catch (error) {
    deps.log(`job "${job.name}" failed`, error);
  }
}

/**
 * Start the scheduler. No-op (returns []) when disabled or when no token is
 * configured. Each job runs once after startupDelayMs, then every intervalMs.
 * Returns the interval handles (for teardown in tests).
 */
export function startScheduler(config: SchedulerConfig, deps: SchedulerDeps): unknown[] {
  if (!config.enabled) {
    deps.log("disabled (set DISPATCH_SCHEDULER_ENABLED=true to enable)");
    return [];
  }
  if (!config.token) {
    deps.log("enabled but DISPATCH_AGENT_TOKEN is unset; not scheduling any jobs");
    return [];
  }

  const handles: unknown[] = [];
  for (const job of config.jobs) {
    deps.log(`scheduling "${job.name}" every ${job.intervalMs}ms -> ${job.path}`);
    deps.setTimeout(() => {
      void runJob(job, config, deps);
      const handle = deps.setInterval(() => void runJob(job, config, deps), job.intervalMs);
      handles.push(handle);
    }, config.startupDelayMs);
  }
  return handles;
}
