import { describe, it, expect, vi } from "vitest";
import { schedulerConfigFromEnv, runJob, startScheduler, type SchedulerConfig, type SchedulerDeps } from "./scheduler";

function fakeDeps(overrides: Partial<SchedulerDeps> = {}): SchedulerDeps & { logs: Array<[string, unknown]> } {
  const logs: Array<[string, unknown]> = [];
  return {
    fetch: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    setInterval: vi.fn(() => "interval-handle"),
    setTimeout: vi.fn(() => "timeout-handle"),
    log: (m, e) => logs.push([m, e]),
    logs,
    ...overrides,
  };
}

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
    expect(schedulerConfigFromEnv({ DISPATCH_SYNC_INTERVAL_MS: "60000" }).jobs[0].intervalMs).toBe(60000);
    expect(schedulerConfigFromEnv({ DISPATCH_SYNC_INTERVAL_MS: "nope" }).jobs[0].intervalMs).toBe(15 * 60 * 1000);
    expect(schedulerConfigFromEnv({ PORT: "" }).baseUrl).toBe("http://127.0.0.1:3000");
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
    expect(deps.logs).toHaveLength(0); // 200 -> quiet
  });

  it("treats 409 as expected (lock held), not an error", async () => {
    const deps = fakeDeps({ fetch: vi.fn(async () => new Response(null, { status: 409 })) as unknown as typeof fetch });
    await runJob(CONFIG.jobs[0], CONFIG, deps);
    expect(deps.logs).toHaveLength(0);
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

  it("schedules each job after the startup delay, then on an interval", () => {
    const deps = fakeDeps();
    startScheduler(CONFIG, deps);
    expect(deps.setTimeout).toHaveBeenCalledTimes(1);
    expect(deps.setTimeout).toHaveBeenCalledWith(expect.any(Function), 5000);
    // fire the startup timer -> it runs once and arms the interval
    const startupCb = (deps.setTimeout as ReturnType<typeof vi.fn>).mock.calls[0][0] as () => void;
    startupCb();
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 900000);
  });
});
