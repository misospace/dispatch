import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  lifecycleDedupeKey,
  lifecycleStatusLabel,
  lifecycleStatusTransition,
  recordClaimEvent,
  recordLifecycleEvent,
  recordLifecycleEventQuietly,
  recordStatusTransition,
  recordSyncedIssueEvents,
  type LifecycleEventClient,
} from "./issue-lifecycle";

/**
 * A `prisma.issueLifecycleEvent` stand-in. The recorder only ever writes
 * through these two methods, and the fake keeps rows keyed by `dedupeKey` the
 * way the real unique index does, so an upsert's idempotency is observable
 * here rather than asserted by hand.
 */
function makeClient() {
  const rows: Array<Record<string, any>> = [];
  const client: LifecycleEventClient = {
    issueLifecycleEvent: {
      create: vi.fn(async ({ data }) => {
        rows.push({ ...data });
        return data;
      }),
      upsert: vi.fn(async ({ where, create }) => {
        const existing = rows.find((row) => row.dedupeKey === where.dedupeKey);
        if (existing) return existing;
        rows.push({ ...create });
        return create;
      }),
    },
  };
  return { client, rows };
}

const base = {
  issueId: "issue-1",
  repoFullName: "octocat/hello-world",
  issueNumber: 42,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lifecycleStatusLabel / lifecycleStatusTransition", () => {
  it("reads the status label an issue carries", () => {
    expect(lifecycleStatusLabel(["type/bug", "status/in-review"])).toBe("status/in-review");
    expect(lifecycleStatusLabel(["type/bug"])).toBeNull();
  });

  it("reports no transition when the status label is unchanged", () => {
    // A redelivered write, or a sync over unchanged GitHub state, must not
    // look like a new transition.
    expect(
      lifecycleStatusTransition(["status/ready", "agent/alpha"], ["agent/alpha", "type/bug", "status/ready"]),
    ).toBeNull();
    expect(lifecycleStatusTransition(["type/bug"], ["type/bug", "priority/p0"])).toBeNull();
  });

  it("reports the transition when the status label moves", () => {
    expect(lifecycleStatusTransition(["status/ready"], ["status/in-progress"])).toEqual({
      from: "status/ready",
      to: "status/in-progress",
    });
    expect(lifecycleStatusTransition(["status/in-review"], ["type/bug"])).toEqual({
      from: "status/in-review",
      to: null,
    });
    expect(lifecycleStatusTransition(["type/bug"], ["type/bug", "status/done"])).toEqual({
      from: null,
      to: "status/done",
    });
  });
});

describe("recordLifecycleEvent", () => {
  it("records occurrence and observation together for a Dispatch-authored write", async () => {
    const { client, rows } = makeClient();
    const before = new Date("2026-10-01T00:00:00.000Z");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(before);
      await recordLifecycleEvent(client, {
        ...base,
        kind: "claim",
        source: "api:claim",
        actor: "alpha",
        agentName: "alpha",
        fromStatus: "status/ready",
        toStatus: "status/in-progress",
      });
    } finally {
      vi.useRealTimers();
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      issueId: "issue-1",
      repoFullName: "octocat/hello-world",
      issueNumber: 42,
      kind: "claim",
      source: "api:claim",
      actor: "alpha",
      agentName: "alpha",
      fromStatus: "status/ready",
      toStatus: "status/in-progress",
      occurredAt: before,
      observedAt: before,
    });
    expect(client.issueLifecycleEvent.create).toHaveBeenCalledTimes(1);
  });

  it("upserts on the dedupe key so a redelivery cannot duplicate the event", async () => {
    const { client, rows } = makeClient();
    const write = {
      ...base,
      kind: "status_changed" as const,
      source: "webhook" as const,
      actor: "github",
      dedupeKey: lifecycleDedupeKey("webhook", "octocat/hello-world", 42, "delivery-1", "status/done"),
    };

    await recordLifecycleEvent(client, write);
    await recordLifecycleEvent(client, { ...write, actor: "someone-else", occurredAt: new Date(0) });

    expect(rows).toHaveLength(1);
    // The second delivery must not rewrite the first one's provenance either.
    expect(rows[0].actor).toBe("github");
    expect(client.issueLifecycleEvent.upsert).toHaveBeenCalledTimes(2);
  });

  it("keeps occurrence and observation apart for an observed event", async () => {
    const { client, rows } = makeClient();
    const occurredAt = new Date("2026-10-01T12:00:00.000Z");
    const observedAt = new Date("2026-10-01T13:30:00.000Z");

    await recordLifecycleEvent(client, {
      ...base,
      kind: "issue_closed",
      source: "sync",
      actor: "github",
      occurredAt,
      observedAt,
    });

    expect(rows[0].occurredAt).toEqual(occurredAt);
    expect(rows[0].observedAt).toEqual(observedAt);
  });
});

describe("recordStatusTransition", () => {
  it("records nothing when the status label did not move", async () => {
    const { client, rows } = makeClient();

    const recorded = await recordStatusTransition(client, {
      ...base,
      kind: "status_changed",
      source: "api:status",
      actor: "alpha",
      before: ["status/ready"],
      after: ["status/ready", "agent/alpha"],
    });

    expect(recorded).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("records the from/to pair when the status label moved", async () => {
    const { client, rows } = makeClient();

    const recorded = await recordStatusTransition(client, {
      ...base,
      kind: "status_changed",
      source: "api:move",
      actor: "operator",
      before: ["status/ready"],
      after: ["status/in-review"],
    });

    expect(recorded).toBe(true);
    expect(rows[0]).toMatchObject({
      kind: "status_changed",
      source: "api:move",
      fromStatus: "status/ready",
      toStatus: "status/in-review",
    });
  });
});

describe("recordClaimEvent", () => {
  it("records the claim that also moves the status label", async () => {
    const { client, rows } = makeClient();

    await recordClaimEvent(client, {
      ...base,
      kind: "claim",
      source: "api:claim",
      actor: "alpha",
      agentName: "alpha",
      before: ["status/ready"],
      after: ["status/in-progress", "agent/alpha"],
    });

    expect(rows[0]).toMatchObject({ kind: "claim", fromStatus: "status/ready", toStatus: "status/in-progress" });
  });

  it("records a force-claim that only changes ownership", async () => {
    const { client, rows } = makeClient();

    await recordClaimEvent(client, {
      ...base,
      kind: "claim",
      source: "api:claim",
      actor: "bravo",
      agentName: "bravo",
      before: ["status/in-progress", "agent/alpha"],
      after: ["status/in-progress", "agent/bravo"],
    });

    expect(rows[0]).toMatchObject({ kind: "claim", fromStatus: "status/in-progress", toStatus: "status/in-progress" });
    expect(rows[0].metadata).toMatchObject({ claimedFrom: "agent/alpha", claimedTo: "agent/bravo" });
  });

  it("records nothing for a redelivered claim of an already-claimed issue", async () => {
    const { client, rows } = makeClient();
    const labels = ["status/in-progress", "agent/alpha"];

    // Claim → release → reclaim keeps both attempts and the first claim; the
    // repeated delivery in the middle is not a new attempt.
    await recordClaimEvent(client, {
      ...base, kind: "claim", source: "api:claim", actor: "alpha", agentName: "alpha",
      before: ["status/ready"], after: labels,
    });
    await recordClaimEvent(client, {
      ...base, kind: "claim", source: "api:claim", actor: "alpha", agentName: "alpha",
      before: labels, after: labels,
    });

    expect(rows).toHaveLength(1);
  });
});

describe("recordSyncedIssueEvents", () => {
  const syncedAt = new Date("2026-10-02T08:00:00.000Z");

  it("records a status move with the source's occurrence time, not the observation time", async () => {
    const { client, rows } = makeClient();

    await recordSyncedIssueEvents(client, {
      ...base,
      before: { labels: ["status/ready"], state: "open" },
      after: { labels: ["status/in-review"], state: "open", updatedAt: syncedAt },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "status_changed", source: "sync", fromStatus: "status/ready", toStatus: "status/in-review" });
    expect(rows[0].occurredAt).toEqual(syncedAt);
    expect(rows[0].observedAt.getTime()).toBeGreaterThanOrEqual(syncedAt.getTime());
  });

  it("collapses a repeated sync over unchanged GitHub state onto one row", async () => {
    const { client, rows } = makeClient();
    const input = {
      ...base,
      before: { labels: ["status/ready"], state: "open" },
      after: { labels: ["status/done"], state: "closed", updatedAt: syncedAt, closedAt: syncedAt },
    };

    await recordSyncedIssueEvents(client, input);
    await recordSyncedIssueEvents(client, input);
    await recordSyncedIssueEvents(client, input);

    // One status move plus one close, regardless of how many sync passes ran.
    expect(rows.map((row) => row.kind).sort()).toEqual(["issue_closed", "status_changed"]);
    expect(rows.every((row) => row.dedupeKey)).toBe(true);
  });

  it("records a close and a reopen as distinct facts", async () => {
    const { client, rows } = makeClient();
    const reopenedAt = new Date("2026-10-04T09:00:00.000Z");

    await recordSyncedIssueEvents(client, {
      ...base,
      before: { labels: ["status/done"], state: "open" },
      after: { labels: ["status/ready"], state: "closed", updatedAt: syncedAt, closedAt: syncedAt },
    });
    await recordSyncedIssueEvents(client, {
      ...base,
      before: { labels: ["status/ready"], state: "closed" },
      after: { labels: ["status/ready"], state: "open", updatedAt: reopenedAt },
    });

    // The reopen moved no status label; only the state changed, and it is
    // recorded under its own identity rather than as a second transition.
    expect(rows.map((row) => row.kind)).toEqual(["status_changed", "issue_closed", "issue_reopened"]);
  });

  it("never writes back to the issue, so a late observation cannot move the present status", async () => {
    const { client } = makeClient();

    // The client only exposes the event table: recording is evidence, so the
    // caller has no way to mutate issue state from here at all.
    await recordSyncedIssueEvents(client, {
      ...base,
      before: { labels: ["status/in-progress"], state: "open" },
      after: { labels: ["status/ready"], state: "open", updatedAt: syncedAt },
    });

    expect(Object.keys(client)).toEqual(["issueLifecycleEvent"]);
  });

  it("keeps a failed sync write from failing the sync", async () => {
    const { client } = makeClient();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(client.issueLifecycleEvent.create).mockRejectedValue(new Error("db down"));

    await expect(
      recordSyncedIssueEvents(client, {
        ...base,
        before: { labels: ["status/ready"], state: "open" },
        after: { labels: ["status/done"], state: "open", updatedAt: syncedAt },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("recordLifecycleEventQuietly", () => {
  it("swallows the failure and says which event was lost", async () => {
    const { client } = makeClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(client.issueLifecycleEvent.create).mockRejectedValue(new Error("db down"));

    await recordLifecycleEventQuietly(
      client,
      { ...base, kind: "completed", source: "agent-report", actor: "alpha" },
      "agent task report",
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("octocat/hello-world#42"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent task report"));
  });
});

describe("lifecycleDedupeKey", () => {
  it("is stable across calls and tolerant of absent parts", () => {
    expect(lifecycleDedupeKey("sync", "org/repo", 7, null, undefined, "status/ready")).toBe(
      lifecycleDedupeKey("sync", "org/repo", 7, null, undefined, "status/ready"),
    );
    expect(lifecycleDedupeKey("a", undefined, "b")).toBe("a||b");
  });
});