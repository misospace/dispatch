import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueFindMany: vi.fn(),
  agentWorkGroupBy: vi.fn(),
  agentRunGroupBy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
    agentWork: { groupBy: mocks.agentWorkGroupBy },
    agentRun: { groupBy: mocks.agentRunGroupBy },
  },
}));

import {
  AGENT_EXECUTING_WORK_STATES,
  AGENT_LIVE_WORK_STATES,
  DEFAULT_AGENT_ACTIVITY_WINDOW_MS,
  classifyAgentActivity,
  getAgentActivityWindowMs,
  getAgentDirectory,
} from "./agent-directory";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function issue(labels: string[]) {
  return { labels };
}

function workGroup(agentName: string, state: string, count = 1) {
  return { agentName, state, _count: { _all: count } };
}

function runGroup(agentName: string, lastSeen: Date | null) {
  return { agentName, _max: { createdAt: lastSeen } };
}

function mockEmptyLedger() {
  mocks.issueFindMany.mockResolvedValue([]);
  mocks.agentWorkGroupBy.mockResolvedValue([]);
  mocks.agentRunGroupBy.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmptyLedger();
});

describe("activity window policy", () => {
  const original = process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS;
    else process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS = original;
  });

  it("defaults to 7 days", () => {
    delete process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS;
    expect(DEFAULT_AGENT_ACTIVITY_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(getAgentActivityWindowMs()).toBe(DEFAULT_AGENT_ACTIVITY_WINDOW_MS);
  });

  it("accepts an operator override", () => {
    process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS = String(2 * HOUR);
    expect(getAgentActivityWindowMs()).toBe(2 * HOUR);
  });

  it("clamps the override to a sane range", () => {
    process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS = "1";
    expect(getAgentActivityWindowMs()).toBe(60_000);
    process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS = String(365 * 24 * HOUR);
    expect(getAgentActivityWindowMs()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("falls back to the default on garbage values", () => {
    process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS = "not-a-number";
    expect(getAgentActivityWindowMs()).toBe(DEFAULT_AGENT_ACTIVITY_WINDOW_MS);
  });

  it("rejects unit-suffixed values instead of silently reading the prefix", () => {
    // "7d" parseInt-parses to 7, which would clamp to a 1-minute window.
    process.env.DISPATCH_AGENT_ACTIVITY_WINDOW_MS = "7d";
    expect(getAgentActivityWindowMs()).toBe(DEFAULT_AGENT_ACTIVITY_WINDOW_MS);
  });
});

describe("classifyAgentActivity", () => {
  const base = { windowMs: DEFAULT_AGENT_ACTIVITY_WINDOW_MS, now: NOW };

  it("marks an open assignment active", () => {
    expect(
      classifyAgentActivity({ ...base, hasOpenAssignment: true, liveWorkCount: 0, lastSeenAt: null }),
    ).toEqual({ active: true, reasons: ["assigned-open"] });
  });

  it("marks live work active even with no reports at all", () => {
    expect(
      classifyAgentActivity({ ...base, hasOpenAssignment: false, liveWorkCount: 1, lastSeenAt: null }),
    ).toEqual({ active: true, reasons: ["live-work"] });
  });

  it("marks a recent report active even without assignments or work", () => {
    expect(
      classifyAgentActivity({
        ...base,
        hasOpenAssignment: false,
        liveWorkCount: 0,
        lastSeenAt: new Date(NOW.getTime() - HOUR),
      }),
    ).toEqual({ active: true, reasons: ["recent-report"] });
  });

  it("treats a report exactly at the window edge as stale", () => {
    expect(
      classifyAgentActivity({
        ...base,
        hasOpenAssignment: false,
        liveWorkCount: 0,
        lastSeenAt: new Date(NOW.getTime() - DEFAULT_AGENT_ACTIVITY_WINDOW_MS),
      }),
    ).toEqual({ active: false, reasons: [] });
  });

  it("stacks reasons when several signals hold", () => {
    expect(
      classifyAgentActivity({
        ...base,
        hasOpenAssignment: true,
        liveWorkCount: 2,
        lastSeenAt: new Date(NOW.getTime() - HOUR),
      }),
    ).toEqual({ active: true, reasons: ["assigned-open", "live-work", "recent-report"] });
  });

  it("is inactive when nothing recent is observed — an evidence gap, not proven offline", () => {
    expect(
      classifyAgentActivity({
        ...base,
        hasOpenAssignment: false,
        liveWorkCount: 0,
        lastSeenAt: new Date(NOW.getTime() - 400 * 24 * HOUR),
      }),
    ).toEqual({ active: false, reasons: [] });
  });
});

describe("getAgentDirectory", () => {
  it("reads open issues with enabled-repository and Renovate filtering intact", async () => {
    await getAgentDirectory();

    const call = mocks.issueFindMany.mock.calls[0]?.[0] as {
      select: unknown;
      where: Record<string, unknown>;
    };
    expect(call.select).toEqual({ labels: true });
    expect(call.where).toMatchObject({ repository: { enabled: true }, state: "open" });
    const and = call.where.AND as Record<string, unknown>[];
    expect(and[0]).toHaveProperty("NOT");
  });

  it("filters live work to non-terminal AgentWork states", async () => {
    await getAgentDirectory();

    const call = mocks.agentWorkGroupBy.mock.calls[0]?.[0] as { where: { state: { in: string[] } } };
    expect(call.where.state.in.sort()).toEqual([...AGENT_LIVE_WORK_STATES].sort());
    expect(AGENT_EXECUTING_WORK_STATES).toEqual(["CLAIMED", "IN_PROGRESS"]);
  });

  it("hides a retired-only identity by default but keeps it in the history view", async () => {
    mocks.agentRunGroupBy.mockResolvedValue([
      runGroup("saffron-old", new Date(NOW.getTime() - 60 * 24 * HOUR)),
    ]);

    const view = await getAgentDirectory({ now: NOW });
    expect(view.agents).toEqual([]);
    expect(view.inactiveHidden).toBe(1);
    expect(view.totalIdentities).toBe(1);

    const history = await getAgentDirectory({ includeInactive: true, now: NOW });
    expect(history.agents).toHaveLength(1);
    const entry = history.agents[0];
    expect(entry.agentName).toBe("saffron-old");
    expect(entry.active).toBe(false);
    expect(entry.reasons).toEqual([]);
    expect(entry.lastSeenAt).toEqual(new Date(NOW.getTime() - 60 * 24 * HOUR));
  });

  it("keeps an active identity with an old report visible via its open assignment", async () => {
    mocks.issueFindMany.mockResolvedValue([issue(["agent/alpha", "status/in-progress"])]);
    mocks.agentRunGroupBy.mockResolvedValue([
      runGroup("alpha", new Date(NOW.getTime() - 30 * 24 * HOUR)),
    ]);

    const { agents } = await getAgentDirectory({ now: NOW });
    expect(agents).toHaveLength(1);
    expect(agents[0].reasons).toEqual(["assigned-open"]);
    expect(agents[0].lastSeenAt).toEqual(new Date(NOW.getTime() - 30 * 24 * HOUR));
    expect(agents[0].inProgress).toBe(1);
  });

  it("shows an honest missing last-seen for an identity that never reported", async () => {
    mocks.issueFindMany.mockResolvedValue([issue(["agent/beta"])]);

    const { agents } = await getAgentDirectory({ now: NOW });
    expect(agents).toHaveLength(1);
    expect(agents[0].agentName).toBe("beta");
    expect(agents[0].active).toBe(true);
    expect(agents[0].lastSeenAt).toBeNull();
  });

  it("counts executing work separately from assigned open issues", async () => {
    mocks.issueFindMany.mockResolvedValue([
      issue(["agent/gamma", "status/ready"]),
      issue(["agent/gamma"]),
    ]);
    mocks.agentWorkGroupBy.mockResolvedValue([
      workGroup("gamma", "IN_PROGRESS", 2),
      workGroup("gamma", "BLOCKED", 1),
    ]);

    const { agents } = await getAgentDirectory({ now: NOW });
    expect(agents[0].assignedOpen).toBe(2);
    expect(agents[0].executing).toBe(2);
    expect(agents[0].reasons).toContain("live-work");
  });

  it("treats a blocked-parked row as current work without inflating the executing count", async () => {
    mocks.agentWorkGroupBy.mockResolvedValue([workGroup("delta", "BLOCKED")]);

    const { agents } = await getAgentDirectory({ now: NOW });
    expect(agents).toHaveLength(1);
    expect(agents[0].executing).toBe(0);
    expect(agents[0].reasons).toEqual(["live-work"]);
  });

  it("reactivates a hidden identity as soon as it reports again", async () => {
    mocks.agentRunGroupBy.mockResolvedValue([runGroup("saffron-old", new Date(NOW.getTime() - HOUR))]);

    const { agents, inactiveHidden } = await getAgentDirectory({ now: NOW });
    expect(inactiveHidden).toBe(0);
    expect(agents).toHaveLength(1);
    expect(agents[0].reasons).toEqual(["recent-report"]);
  });

  it("aggregates multiple agents per issue and one agent across issues", async () => {
    mocks.issueFindMany.mockResolvedValue([
      issue(["agent/alpha", "agent/beta", "status/in-review", "owner/odin"]),
      issue(["agent/alpha", "status/done"]),
      issue(["owner/odin"]),
    ]);

    const { agents } = await getAgentDirectory({ now: NOW });
    expect(agents.map((a) => a.agentName)).toEqual(["alpha", "beta"]);
    const alpha = agents.find((a) => a.agentName === "alpha")!;
    expect(alpha.assignedOpen).toBe(2);
    expect(alpha.inReview).toBe(1);
    const beta = agents.find((a) => a.agentName === "beta")!;
    expect(beta.assignedOpen).toBe(1);
    expect(beta.inReview).toBe(1);
  });

  it("joins identities case-insensitively without losing open-assignment signals", async () => {
    // GitHub label dedup preserves the label's original casing, so the repo
    // can carry agent/Alpha while run/work rows say alpha: one identity.
    mocks.issueFindMany.mockResolvedValue([issue(["agent/Alpha", "status/ready"])]);
    mocks.agentRunGroupBy.mockResolvedValue([runGroup("alpha", new Date(NOW.getTime() - HOUR))]);

    const { agents, totalIdentities } = await getAgentDirectory({ now: NOW });
    expect(totalIdentities).toBe(1);
    expect(agents).toHaveLength(1);
    // The identity's own reported name wins over the label casing.
    expect(agents[0].agentName).toBe("alpha");
    expect(agents[0].assignedOpen).toBe(1);
    expect(agents[0].ready).toBe(1);
    expect(agents[0].reasons).toEqual(["assigned-open", "recent-report"]);
  });

  it("returns an empty directory when no identity has ever been observed", async () => {
    const view = await getAgentDirectory({ now: NOW });
    expect(view).toEqual({ agents: [], inactiveHidden: 0, totalIdentities: 0 });
  });

  it("maps the per-agent run-row maximum to last-seen", async () => {
    // Last-seen provenance is the per-agent _max of AgentRun.createdAt —
    // server-recorded report/heartbeat time, never inferred liveness.
    mocks.agentRunGroupBy.mockResolvedValue([
      runGroup("epsilon", new Date(NOW.getTime() - 3 * 24 * HOUR)),
    ]);

    const { agents } = await getAgentDirectory({ now: NOW });
    expect(agents[0].lastSeenAt).toEqual(new Date(NOW.getTime() - 3 * 24 * HOUR));
  });
});
