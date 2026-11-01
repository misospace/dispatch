import { describe, it, expect, vi } from "vitest";
import { schedulerConfigFromEnv, schedulerHealthCheck, runJob, startScheduler, schedulerState, type SchedulerConfig, type SchedulerDeps } from "./scheduler";

function fakeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps & { logs: Array<[string, unknown]> } {
  const logs: Array<[string, unknown]> = [];
  return {
    fetch: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    setInterval: vi.fn(() => "interval-handle"),
    clearInterval: vi.fn(),
    setTimeout: vi.fn(() => "timeout-handle"),
    log: (m, e) => logs.push([m, e]),
    logs,
    ...overrides,
  };
}

// Unique interval handles across captures, so clears from one start never
// alias another start's handles.
let handleSeq = 0;

const CONFIG: SchedulerConfig = {
  enabled: true,
  baseUrl: "http://127.0.0.1:3000",
  token: "tok",
  startupDelayMs: 5000,
  jobs: [{ name: "sync", path: "/api/sync/scheduled", body: { issues: true }, intervalMs: 900000 }],
};

describe("schedulerConfigFromEnv", () => {
  it("is disabled unless DISPATCH_SCHEDULER_ENABLED=true", () => {
    expect(schedulerConfigFromEnv({}).enabled).toBe(false);
    expect(schedulerConfigFromEnv({ DISPATCH_SCHEDULER_ENABLED: "true" }).enabled).toBe(true);
  });

  it("defaults the sync job to 15m and builds a loopback base from PORT", () => {
    const c = schedulerConfigFromEnv({ PORT: "8080", DISPATCH_AGENT_TOKEN: "t" });
    expect(c.baseUrl).toBe("http://127.0.0.1:8080");
    expect(c.token).toBe("t");
    const sync = c.jobs.find((j) => j.name === "sync")!;
    expect(sync.path).toBe("/api/sync/scheduled");
    expect(sync.body).toEqual({ issues: true });
    expect(sync.intervalMs).toBe(15 * 60 * 1000);
  });

  it("honors DISPATCH_SYNC_INTERVAL_MS and falls back on garbage", () => {
    const byName = (env: Record<string, string | undefined>, name: string) =>
      schedulerConfigFromEnv(env).jobs.find((j) => j.name === name)!;
    expect(byName({ DISPATCH_SYNC_INTERVAL_MS: "60000" }, "sync").intervalMs).toBe(60000);
    expect(byName({ DISPATCH_SYNC_INTERVAL_MS: "nope" }, "sync").intervalMs).toBe(15 * 60 * 1000);
    expect(schedulerConfigFromEnv({ PORT: "" }).baseUrl).toBe("http://127.0.0.1:3000");
  });

  it("configures sync + groomer + pr-followup + ci-failures + prune-closed + reconcile + stale-work with defaults", () => {
    const jobs = schedulerConfigFromEnv({}).jobs;
    // pr-fix-sweep is filtered out by default (#1211 review): the default
    // interval is `0` (disabled) until workers confirm they ack. The
    // DISPATCH_PR_FIX_SWEEP_INTERVAL_MS=0 case asserts that explicitly below;
    // here the only constraint on the default list is that the others are
    // present, and pr-fix-sweep may or may not be in it depending on the
    // explicit opt-in.
    expect(jobs.map((j) => j.name)).toContain("sync");
    expect(jobs.map((j) => j.name)).toContain("groomer");
    expect(jobs.map((j) => j.name)).toContain("pr-followup");
    expect(jobs.map((j) => j.name)).toContain("ci-failures");
    expect(jobs.map((j) => j.name)).toContain("prune-closed");
    expect(jobs.map((j) => j.name)).toContain("reconcile");
    expect(jobs.map((j) => j.name)).toContain("stale-work");
    const byName = (n: string) => jobs.find((j) => j.name === n)!;
    expect(byName("groomer").path).toBe("/api/groomer/run");
    expect(byName("groomer").intervalMs).toBe(10 * 60 * 1000);
    expect(byName("pr-followup").path).toBe("/api/pr-followup/sync");
    expect(byName("pr-followup").intervalMs).toBe(15 * 60 * 1000);
    expect(byName("ci-failures").path).toBe("/api/ci-failures/sync");
    expect(byName("ci-failures").intervalMs).toBe(30 * 60 * 1000);
    expect(byName("prune-closed").path).toBe("/api/issues/prune-closed");
    expect(byName("prune-closed").intervalMs).toBe(24 * 60 * 60 * 1000);
    expect(byName("agent-executions-prune").path).toBe("/api/agent-work/observations/prune");
    expect(byName("agent-executions-prune").intervalMs).toBe(24 * 60 * 60 * 1000);
    expect(byName("reconcile").path).toBe("/api/issues/reconcile");
    expect(byName("reconcile").intervalMs).toBe(30 * 60 * 1000);
    expect(byName("stale-work").path).toBe("/api/agent-work/sweep");
    expect(byName("stale-work").intervalMs).toBe(5 * 60 * 1000);
  });

  it("disables pr-fix-sweep by default until workers are confirmed to ack (#1211 review)", () => {
    // The reclaim sweep can wipe in-flight CoderRun when a worker simply
    // never acked; deployments that have not yet shipped the durable
    // Create-boundary ack in their worker must keep this disabled.
    const jobs = schedulerConfigFromEnv({}).jobs;
    const prFixSweep = jobs.find((j) => j.name === "pr-fix-sweep");
    expect(prFixSweep).toBeUndefined();
  });

  it("enables pr-fix-sweep when DISPATCH_PR_FIX_SWEEP_INTERVAL_MS is set explicitly", () => {
    const jobs = schedulerConfigFromEnv({ DISPATCH_PR_FIX_SWEEP_INTERVAL_MS: "300000" }).jobs;
    const prFixSweep = jobs.find((j) => j.name === "pr-fix-sweep")!;
    expect(prFixSweep).toBeDefined();
    expect(prFixSweep.path).toBe("/api/pr-fix-queue/sweep");
    expect(prFixSweep.intervalMs).toBe(5 * 60 * 1000);
  });

  it("disables reconcile when DISPATCH_RECONCILE_INTERVAL_MS is 0", () => {
    const jobs = schedulerConfigFromEnv({ DISPATCH_RECONCILE_INTERVAL_MS: "0" }).jobs;
    expect(jobs.map((j) => j.name)).not.toContain("reconcile");
  });

  it("disables stale-work when DISPATCH_STALE_WORK_INTERVAL_MS is 0", () => {
    const jobs = schedulerConfigFromEnv({ DISPATCH_STALE_WORK_INTERVAL_MS: "0" }).jobs;
    expect(jobs.map((j) => j.name)).not.toContain("stale-work");
  });

  it("disables pr-fix-sweep when DISPATCH_PR_FIX_SWEEP_INTERVAL_MS is 0", () => {
    const jobs = schedulerConfigFromEnv({ DISPATCH_PR_FIX_SWEEP_INTERVAL_MS: "0" }).jobs;
    expect(jobs.map((j) => j.name)).not.toContain("pr-fix-sweep");
  });

  it("disables agent-executions-prune when DISPATCH_AGENT_EXECUTIONS_PRUNE_INTERVAL_MS is 0", () => {
    const jobs = schedulerConfigFromEnv({ DISPATCH_AGENT_EXECUTIONS_PRUNE_INTERVAL_MS: "0" }).jobs;
    expect(jobs.map((j) => j.name)).not.toContain("agent-executions-prune");
  });

  it("honors DISPATCH_AGENT_EXECUTIONS_PRUNE_INTERVAL_MS", () => {
    const byName = schedulerConfigFromEnv({ DISPATCH_AGENT_EXECUTIONS_PRUNE_INTERVAL_MS: "3600000" }).jobs
      .find((j) => j.name === "agent-executions-prune")!;
    expect(byName.intervalMs).toBe(3600000);
  });

  it("disables an individual job when its interval env is 0", () => {
    const jobs = schedulerConfigFromEnv({ DISPATCH_GROOMER_INTERVAL_MS: "0", DISPATCH_PRUNE_CLOSED_INTERVAL_MS: "0" }).jobs;
    const names = jobs.map((j) => j.name);
    expect(names).toContain("sync");
    expect(names).toContain("pr-followup");
    expect(names).not.toContain("groomer");
    expect(names).not.toContain("prune-closed");
  });
});

describe("runJob", () => {
  it("POSTs JSON with bearer auth to baseUrl+path", async () => {
    const deps = fakeDeps();
    await runJob(CONFIG.jobs[0], CONFIG, deps);
    expect(deps.fetch).toHaveBeenCalledWith("http://127.0.0.1:3000/api/sync/scheduled", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ issues: true }),
    });
    // A successful run logs. Staying quiet on success was what made a stopped
    // scheduler indistinguishable from a healthy one: pr-followup silently
    // stopped firing for 15+ hours and the only symptom was an empty queue.
    expect(deps.logs).toHaveLength(1);
    expect(deps.logs[0][0]).toContain('job "sync" ok');
  });

  it("treats 409 as expected (lock held), not an error", async () => {
    const deps = fakeDeps({ fetch: vi.fn(async () => new Response(null, { status: 409 })) as unknown as typeof fetch });
    await runJob(CONFIG.jobs[0], CONFIG, deps);
    // A lock collision is a healthy run, so it logs as ok rather than as a
    // failure — but it must still log, because it is evidence the timer fired.
    expect(deps.logs).toHaveLength(1);
    expect(deps.logs[0][0]).toContain('job "sync" ok');
  });

  it("logs non-ok statuses without throwing", async () => {
    const deps = fakeDeps({ fetch: vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch });
    await expect(runJob(CONFIG.jobs[0], CONFIG, deps)).resolves.toBeUndefined();
    expect(deps.logs[0][0]).toContain("HTTP 500");
  });

  it("swallows fetch rejection (a transient failure must not kill the interval)", async () => {
    const deps = fakeDeps({ fetch: vi.fn(async () => { throw new Error("econnrefused"); }) as unknown as typeof fetch });
    await expect(runJob(CONFIG.jobs[0], CONFIG, deps)).resolves.toBeUndefined();
    expect(deps.logs[0][0]).toContain("failed");
  });
});

describe("startScheduler", () => {
  it("no-ops when disabled", () => {
    const deps = fakeDeps();
    expect(startScheduler({ ...CONFIG, enabled: false }, deps)).toEqual([]);
    expect(deps.setTimeout).not.toHaveBeenCalled();
  });

  it("no-ops (and warns) when enabled but token is missing", () => {
    const deps = fakeDeps();
    expect(startScheduler({ ...CONFIG, token: "" }, deps)).toEqual([]);
    expect(deps.setTimeout).not.toHaveBeenCalled();
    expect(deps.logs.some(([m]) => m.includes("DISPATCH_AGENT_TOKEN is unset"))).toBe(true);
  });

  it("schedules a single health check and each job after the startup delay, then on an interval", () => {
    const deps = fakeDeps();
    startScheduler(CONFIG, deps);
    // one setTimeout for the health check, one for the job
    expect(deps.setTimeout).toHaveBeenCalledTimes(2);
    expect(deps.setTimeout).toHaveBeenCalledWith(expect.any(Function), 5000);
    // fire both startup timers
    const calls = (deps.setTimeout as ReturnType<typeof vi.fn>).mock.calls;
    for (const c of calls) (c[0] as () => void)();
    expect(deps.fetch).toHaveBeenCalledTimes(2); // health check + job
    expect(deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 900000);
  });
});

describe("schedulerHealthCheck", () => {
  it("returns true when health endpoint responds with 200", async () => {
    const mockFetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch;
    const deps = fakeDeps({ fetch: mockFetch });
    const result = await schedulerHealthCheck(CONFIG, deps);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:3000/api/health", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns false and logs when health endpoint returns non-ok status", async () => {
    const mockFetch = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof globalThis.fetch;
    const log = vi.fn();
    const deps = fakeDeps({ fetch: mockFetch, log });
    const result = await schedulerHealthCheck(CONFIG, deps);

    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith("scheduler health check failed — HTTP 503");
  });

  it("returns false and logs when fetch throws", async () => {
    const mockFetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch;
    const log = vi.fn();
    const deps = fakeDeps({ fetch: mockFetch, log });
    const result = await schedulerHealthCheck(CONFIG, deps);

    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith("scheduler health check failed: ECONNREFUSED", expect.any(Error));
  });
});

describe("supervisor", () => {
  // Regression for the 2026-08-27 stall: pr-followup stopped firing on a pod
  // that kept serving requests, for at least 15 hours. A manual POST to the
  // same endpoint enqueued 35 items immediately, so the endpoint was fine and
  // the timer was not. Root cause in the standalone runtime is unproven, so
  // the contract here is detect-and-recover, not prevent.
  function capture() {
    const intervals: Array<() => void> = [];
    const timeouts: Array<() => void> = [];
    const deps = fakeDeps({
      setInterval: vi.fn((fn: () => void) => { intervals.push(fn); return "h"; }) as unknown as SchedulerDeps["setInterval"],
      setTimeout: vi.fn((fn: () => void) => { timeouts.push(fn); return "h"; }) as unknown as SchedulerDeps["setTimeout"],
    });
    return { deps, intervals, timeouts };
  }

  it("re-arms a job whose timer stopped, and reports it overdue", async () => {
    // A 1ms interval makes "two missed cycles" arrive in real time, which
    // avoids fake timers fighting the async finally{} that records the run.
    // Distinct job name: lastRunAt is module state and bleeds between cases.
    const cfg: SchedulerConfig = {
      ...CONFIG,
      startupDelayMs: 0,
      jobs: [{ ...CONFIG.jobs[0], name: "stalled", intervalMs: 1 }],
    };
    const { deps, intervals, timeouts } = capture();
    startScheduler(cfg, deps);

    for (const t of timeouts) t();
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalled());
    const before = (deps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    await new Promise((r) => globalThis.setTimeout(r, 20));
    expect(schedulerState().jobs.find((j) => j.name === "stalled")!.overdue).toBe(true);

    // The supervisor is armed inside startScheduler, before any startup
    // timeout fires, so it is the FIRST interval — the job's own interval is
    // pushed later, when its setTimeout callback runs.
    intervals[0]!();
    await vi.waitFor(() =>
      expect((deps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before),
    );
    expect(deps.logs.some(([m]) => m.includes("re-arming"))).toBe(true);
  });

  it("does not re-arm a job that has simply never run yet", () => {
    const cfg: SchedulerConfig = { ...CONFIG, jobs: [{ ...CONFIG.jobs[0], name: "never-ran" }] };
    const { deps, intervals } = capture();
    startScheduler(cfg, deps);
    const before = (deps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    intervals[0]!();
    expect((deps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
    expect(deps.logs.some(([m]) => m.includes("re-arming"))).toBe(false);
  });

  // Regression for audit finding F6 (#1421): the supervisor re-armed overdue
  // jobs with a fresh setInterval without clearing the previous handle. A
  // timer that was merely delayed (a stalled event loop) rather than dead
  // stayed live alongside each replacement, so every supervisor pass stacked
  // another duplicate periodic invocation.
  describe("re-arm handle hygiene (#1421)", () => {
    function captureHandles() {
      const intervals: Array<{ fn: () => void; handle: string }> = [];
      const timeouts: Array<() => void> = [];
      const cleared: string[] = [];
      // live = armed and not cleared, from this instance's view; a stale
      // clear of another start's handle deletes nothing here.
      const live = new Map<string, () => void>();
      const deps = fakeDeps({
        setInterval: vi.fn((fn: () => void) => {
          const handle = `i${handleSeq++}`;
          intervals.push({ fn, handle });
          live.set(handle, fn);
          return handle;
        }) as unknown as SchedulerDeps["setInterval"],
        clearInterval: vi.fn((handle: unknown) => {
          cleared.push(handle as string);
          live.delete(handle as string);
        }) as unknown as SchedulerDeps["clearInterval"],
        setTimeout: vi.fn((fn: () => void) => {
          timeouts.push(fn);
          return "t";
        }) as unknown as SchedulerDeps["setTimeout"],
      });
      return { deps, intervals, timeouts, cleared, live };
    }

    it("clears the overdue job's original interval before arming the replacement", async () => {
      const cfg: SchedulerConfig = {
        ...CONFIG,
        startupDelayMs: 0,
        jobs: [{ ...CONFIG.jobs[0], name: "rearm-clear", intervalMs: 1 }],
      };
      const cap = captureHandles();
      startScheduler(cfg, cap.deps);
      for (const t of cap.timeouts) t();
      await vi.waitFor(() => expect(cap.deps.fetch).toHaveBeenCalled());

      // intervals[0] is the supervisor; the job's own interval is the next.
      const supervisor = cap.intervals[0]!;
      const originalJobHandle = cap.intervals[1]!.handle;
      expect(supervisor.handle).not.toBe(originalJobHandle);

      await new Promise((r) => globalThis.setTimeout(r, 20));
      supervisor.fn();
      await vi.waitFor(() =>
        expect(cap.deps.logs.some(([m]) => m.includes("re-arming"))).toBe(true),
      );

      // The replacement replaced the original: the stale handle is cleared and
      // exactly one job interval (the replacement) plus the supervisor remain.
      expect(cap.cleared).toContain(originalJobHandle);
      expect(cap.live.size).toBe(2);
    });

    it("keeps exactly one live interval per job across repeated supervisor ticks", async () => {
      const cfg: SchedulerConfig = {
        ...CONFIG,
        startupDelayMs: 0,
        jobs: [{ ...CONFIG.jobs[0], name: "rearm-stack", intervalMs: 1 }],
      };
      const cap = captureHandles();
      startScheduler(cfg, cap.deps);
      for (const t of cap.timeouts) t();
      await vi.waitFor(() => expect(cap.deps.fetch).toHaveBeenCalled());

      const supervisor = cap.intervals[0]!;
      for (let tick = 0; tick < 3; tick++) {
        await new Promise((r) => globalThis.setTimeout(r, 20));
        supervisor.fn();
      }
      await vi.waitFor(() =>
        expect(cap.deps.logs.filter(([m]) => m.includes("re-arming")).length).toBe(3),
      );

      // Three overdue passes re-armed three times, but each pass cleared the
      // previous handle: supervisor + exactly one live job interval.
      expect(cap.live.size).toBe(2);
      const jobHandleAfter = cap.intervals[cap.intervals.length - 1]!.handle;
      expect(cap.live.has(jobHandleAfter)).toBe(true);
    });

    it("a second startScheduler call replaces the previous supervisor timer (restart)", () => {
      const cfg: SchedulerConfig = {
        ...CONFIG,
        jobs: [{ ...CONFIG.jobs[0], name: "restart-hygiene" }],
      };
      const first = captureHandles();
      startScheduler(cfg, first.deps);
      const firstSupervisor = first.intervals[0]!.handle;

      const second = captureHandles();
      startScheduler(cfg, second.deps);

      // The restart cleared the previous supervisor instead of stacking a
      // second one beside it.
      expect(second.deps.clearInterval).toHaveBeenCalledWith(firstSupervisor);
      expect(second.live.size).toBe(1); // only the new supervisor; job timers arm via startup timeout
    });
  });
});
