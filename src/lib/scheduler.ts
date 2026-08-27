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
 * can be confined to a single replica when needed.
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
const DEFAULT_RECONCILE_INTERVAL_MS = 30 * 60 * 1000; // 30m
const DEFAULT_STALE_WORK_INTERVAL_MS = 5 * 60 * 1000; // 5m
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
    {
      name: "reconcile",
      path: "/api/issues/reconcile",
      body: {},
      intervalMs: jobIntervalFromEnv(env.DISPATCH_RECONCILE_INTERVAL_MS, DEFAULT_RECONCILE_INTERVAL_MS),
    },
    {
      name: "stale-work",
      path: "/api/agent-work/sweep",
      body: {},
      intervalMs: jobIntervalFromEnv(env.DISPATCH_STALE_WORK_INTERVAL_MS, DEFAULT_STALE_WORK_INTERVAL_MS),
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

/**
 * Startup health check: verify the scheduler can reach its own endpoints.
 * Returns true on HTTP 200, false otherwise. Does not prevent the scheduler
 * from running — provides visibility into misconfiguration without blocking
 * periodic work.
 */
export async function schedulerHealthCheck(config: SchedulerConfig, deps: SchedulerDeps): Promise<boolean> {
  try {
    const res = await deps.fetch(`${config.baseUrl}/api/health`, {
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
    });
    if (!res.ok) {
      deps.log(`scheduler health check failed — HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    deps.log(`scheduler health check failed: ${msg}`, error);
    return false;
  }
}

/**
 * Last completed run per job, and the interval each was armed with.
 *
 * A job that stops firing used to be indistinguishable from one firing
 * successfully, because runJob only logged failures. Silence meant either
 * "healthy" or "dead" and nothing could tell them apart — pr-followup stopped
 * for at least 15 hours and the only symptom was an empty queue, which looks
 * exactly like having no work to do.
 */
/** How often the supervisor checks for stopped timers. */
const SUPERVISOR_INTERVAL_MS = 60_000;

const lastRunAt = new Map<string, number>();
const armedIntervalMs = new Map<string, number>();

/** Scheduler liveness for /api/health: per job, when it last completed. */
export function schedulerState(): {
  jobs: { name: string; lastRunAt: string | null; intervalMs: number; overdue: boolean }[];
} {
  const now = Date.now();
  return {
    jobs: [...armedIntervalMs.entries()].map(([name, intervalMs]) => {
      const last = lastRunAt.get(name);
      return {
        name,
        lastRunAt: last ? new Date(last).toISOString() : null,
        intervalMs,
        // Two missed cycles: one late tick is normal, two is a stopped timer.
        overdue: last !== undefined && now - last > intervalMs * 2,
      };
    }),
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
    } else {
      // Log the healthy case too. Without it, "not running" and "running fine"
      // produce identical output, which is how this failure hid.
      deps.log(`job "${job.name}" ok (HTTP ${res.status})`);
    }
  } catch (error) {
    deps.log(`job "${job.name}" failed`, error);
  } finally {
    // Record on every path: a job that errors is still alive, and staleness
    // must mean "the timer stopped", not "the endpoint is unhappy".
    lastRunAt.set(job.name, Date.now());
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

  // Single health check after startup delay, not per-job
  deps.setTimeout(() => {
    void schedulerHealthCheck(config, deps);
  }, config.startupDelayMs);

  for (const job of config.jobs) {
    // Note this logs that the job is *registered*, not that a timer exists —
    // the interval is only armed inside the setTimeout below. Treat the
    // supervisor's output, not this line, as evidence the job is running.
    deps.log(`scheduling "${job.name}" every ${job.intervalMs}ms -> ${job.path}`);
    armedIntervalMs.set(job.name, job.intervalMs);
    deps.setTimeout(() => {
      void runJob(job, config, deps);
      const handle = deps.setInterval(() => void runJob(job, config, deps), job.intervalMs);
      handles.push(handle);
    }, config.startupDelayMs);
  }

  // Supervisor: re-arm a job whose timer has stopped firing.
  //
  // The intervals above were observed to stop while the process kept serving
  // requests: pr-followup did not fire for at least 15 hours on a pod that was
  // otherwise healthy, and a manual call to the same endpoint immediately
  // enqueued 35 items. Root cause in the standalone runtime is not established,
  // so this does not pretend to fix it — it detects the state and recovers,
  // and says so loudly rather than starving every queue in silence.
  const supervisorHandle = deps.setInterval(() => {
    const now = Date.now();
    for (const job of config.jobs) {
      const last = lastRunAt.get(job.name);
      // Never-run jobs are covered by their own startup timeout; only re-arm
      // something that ran and then stopped, so a slow start is not mistaken
      // for a dead timer.
      if (last === undefined || now - last <= job.intervalMs * 2) continue;
      deps.log(
        `job "${job.name}" has not run for ${Math.round((now - last) / 1000)}s ` +
          `(interval ${Math.round(job.intervalMs / 1000)}s) — re-arming`,
      );
      lastRunAt.set(job.name, now);
      void runJob(job, config, deps);
      handles.push(deps.setInterval(() => void runJob(job, config, deps), job.intervalMs));
    }
  }, SUPERVISOR_INTERVAL_MS);
  handles.push(supervisorHandle);

  return handles;
}
