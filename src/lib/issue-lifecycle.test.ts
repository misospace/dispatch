import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  lifecycleDedupeKey,
  lifecycleStatusLabel,
  lifecycleStatusTransition,
  recordClaimEvent,
  recordLifecycleEvent,
  recordLifecycleEventQuietly,
  recordPrMergedEvent,
  recordStatusTransition,
  recordStatusTransitionQuietly,
  recordSyncedIssueEvents,
  prMergedDedupeKey,
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

  it("recovers the before-state from the mirrored cache when the observed labels already show the write", async () => {
    const { client, rows } = makeClient();

    // The GitHub write landed and the local transaction that mirrors it rolled
    // back, so the retry observes labels that already carry the new status and
    // the cache still holds the state from before the write. Without the
    // fallback the first attempt's transition would be lost for good.
    const recorded = await recordStatusTransition(client, {
      ...base,
      kind: "status_changed",
      source: "api:status",
      actor: "operator",
      before: ["status/in-review"],
      after: ["status/in-review"],
      mirroredBefore: ["status/ready"],
    });

    expect(recorded).toBe(true);
    expect(rows[0]).toMatchObject({
      fromStatus: "status/ready",
      toStatus: "status/in-review",
      metadata: { recoveredFromMirroredState: true },
    });
  });

  it("records nothing when neither the observed nor the mirrored labels show a change", async () => {
    const { client, rows } = makeClient();

    const recorded = await recordStatusTransition(client, {
      ...base,
      kind: "status_changed",
      source: "api:status",
      actor: "operator",
      before: ["status/in-review"],
      after: ["status/in-review"],
      mirroredBefore: ["status/in-review"],
    });

    expect(recorded).toBe(false);
    expect(rows).toHaveLength(0);
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

  it("recovers a retried claim from the mirrored cache, and only marks it when it had to", async () => {
    const { client, rows } = makeClient();
    const after = ["status/in-progress", "agent/alpha"];

    // The claim's GitHub writes landed and its transaction rolled back: the
    // retry sees an already-claimed issue, and only the cache row — written
    // inside that transaction — still holds the pre-claim labels.
    const recovered = await recordClaimEvent(client, {
      ...base, kind: "claim", source: "api:claim", actor: "alpha", agentName: "alpha",
      before: after, after, mirroredBefore: ["status/ready"],
    });

    expect(recovered).toBe(true);
    expect(rows[0]).toMatchObject({
      kind: "claim",
      fromStatus: "status/ready",
      toStatus: "status/in-progress",
      metadata: { recoveredFromMirroredState: true },
    });

    // A claim the observed labels already show as a genuine transition is not
    // labelled as recovered.
    await recordClaimEvent(client, {
      ...base, kind: "claim", source: "api:claim", actor: "bravo", agentName: "bravo",
      before: ["status/ready"], after: ["status/in-progress", "agent/bravo"],
      mirroredBefore: ["status/backlog"],
    });
    expect(rows[1].metadata).not.toHaveProperty("recoveredFromMirroredState");
  });

  it("records nothing for a redelivered claim whose mirror already carries the claim", async () => {
    const { client, rows } = makeClient();
    const labels = ["status/in-progress", "agent/alpha"];

    const recorded = await recordClaimEvent(client, {
      ...base, kind: "claim", source: "api:claim", actor: "alpha", agentName: "alpha",
      before: labels, after: labels, mirroredBefore: labels,
    });

    expect(recorded).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("marks a recovery that a stale cache cannot distinguish from a real prior state", async () => {
    const { client, rows } = makeClient();

    // Known limitation (dispatch#1202 review, second pass): the mirrored row
    // is only a witness of the pre-write state when the cache was in step with
    // GitHub. When sync lag has left it behind, a retry that finds the observed
    // labels already at the target still recovers from it — so the recovered
    // `fromStatus` can describe the last mirrored state rather than the state
    // this claim actually displaced. There is no way to tell the two apart at
    // retry time without a durable intent recorded before the GitHub write, so
    // the row is marked instead: a reader that filters on
    // `recoveredFromMirroredState` never mistakes it for an observed move.
    // Sync independently records the real GitHub-side move, so a status change
    // is never lost — only its attribution to this writer is approximate.
    const recorded = await recordStatusTransition(client, {
      ...base, kind: "status_changed", source: "api:status", actor: "alpha",
      before: ["status/in-progress", "agent/alpha"],
      after: ["status/in-progress", "agent/beta"],
      mirroredBefore: ["status/backlog"],
    });

    expect(recorded).toBe(true);
    expect(rows[0]).toMatchObject({
      fromStatus: "status/backlog",
      toStatus: "status/in-progress",
      metadata: { recoveredFromMirroredState: true },
    });
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

  it("propagates a failed event write so the caller can defer its mirror", async () => {
    const { client } = makeClient();
    vi.mocked(client.issueLifecycleEvent.upsert).mockRejectedValue(new Error("db down"));

    // The stores record before mirroring, so swallowing this would leave a
    // cache that shows a move the stream has no record of — and the next sync
    // derives no transition from it, so the row can never be reconstructed.
    await expect(
      recordSyncedIssueEvents(client, {
        ...base,
        before: { labels: ["status/ready"], state: "open" },
        after: { labels: ["status/done"], state: "open", updatedAt: syncedAt },
      }),
    ).rejects.toThrow("db down");
  });
});

describe("recordStatusTransitionQuietly", () => {
  it("reports whether the transition was recorded and never throws", async () => {
    const { client, rows } = makeClient();

    await expect(
      recordStatusTransitionQuietly(
        client,
        { ...base, kind: "status_changed", source: "hosted-groomer", actor: "hosted-groomer",
          before: ["status/backlog"], after: ["status/ready"] },
        "hosted-groomer",
      ),
    ).resolves.toBe(true);
    expect(rows).toHaveLength(1);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(client.issueLifecycleEvent.create).mockRejectedValue(new Error("db down"));
    await expect(
      recordStatusTransitionQuietly(
        client,
        { ...base, kind: "status_changed", source: "hosted-groomer", actor: "hosted-groomer",
          before: ["status/backlog"], after: ["status/ready"] },
        "hosted-groomer",
      ),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("hosted-groomer"));
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
describe("prMergedDedupeKey / recordPrMergedEvent (#1203)", () => {
  it("keys the same instant identically as a GitHub string or a Date", () => {
    const stamp = "2026-10-01T12:00:00Z";
    expect(prMergedDedupeKey("org/repo", 42, 7, stamp)).toBe(
      prMergedDedupeKey("org/repo", 42, 7, new Date(stamp)),
    );
  });

  it("keeps the pre-#1203 reconciler key shape for second-precision stamps", () => {
    expect(prMergedDedupeKey("org/repo", 42, 7, "2026-10-01T12:00:00Z")).toBe(
      "reconciler|org/repo|42|pr_merged|7|2026-10-01T12:00:00Z",
    );
    expect(prMergedDedupeKey("org/repo", 42, 7, null)).toBe(
      "reconciler|org/repo|42|pr_merged|7|unknown",
    );
  });

  it("preserves sub-second precision when the source actually has it", () => {
    expect(prMergedDedupeKey("org/repo", 42, 7, "2026-10-01T12:00:00.123Z")).toBe(
      prMergedDedupeKey("org/repo", 42, 7, new Date("2026-10-01T12:00:00.123Z")),
    );
    expect(prMergedDedupeKey("org/repo", 42, 7, "2026-10-01T12:00:00.123Z")).toContain(".123Z");
  });

  it("records the full merge provenance metadata", async () => {
    const { client, rows } = makeClient();
    await recordPrMergedEvent(client, {
      issueId: "issue-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      source: "reconciler",
      actor: "reconciler",
      pr: {
        prNumber: 7,
        prUrl: "https://github.com/org/repo/pull/7",
        mergedAt: "2026-10-01T12:00:00Z",
        mergeCommitSha: "a".repeat(40),
        headSha: "b".repeat(40),
        linkSource: "body-keyword",
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("pr_merged");
    expect(rows[0].occurredAt.getTime()).toBe(new Date("2026-10-01T12:00:00Z").getTime());
    expect(rows[0].dedupeKey).toBe("reconciler|org/repo|42|pr_merged|7|2026-10-01T12:00:00Z");
    expect(rows[0].metadata).toEqual({
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.com/org/repo/pull/7",
      mergedAt: "2026-10-01T12:00:00.000Z",
      mergeCommitSha: "a".repeat(40),
      headSha: "b".repeat(40),
      linkSource: "body-keyword",
    });
  });

  it("keeps an unparseable mergedAt visible and keys it by raw text", async () => {
    const { client, rows } = makeClient();
    await recordPrMergedEvent(client, {
      issueId: "issue-1",
      repoFullName: "org/repo",
      issueNumber: 42,
      source: "reconciler",
      actor: "reconciler",
      pr: { prNumber: 7, mergedAt: "sometime-last-week" },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe("reconciler|org/repo|42|pr_merged|7|sometime-last-week");
    expect(rows[0].metadata.mergedAt).toBeUndefined();
    expect(rows[0].metadata.mergedAtRaw).toBe("sometime-last-week");
  });
});
