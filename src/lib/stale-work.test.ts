import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/github", () => ({
  addIssueLabel: vi.fn(),
  removeIssueLabel: vi.fn(),
}));

vi.mock("@/lib/github-prs", () => ({
  fetchPullRequestState: vi.fn(),
}));

// The default client is never used: every test passes its own fake.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { removeIssueLabel } from "@/lib/github";
import { sweepStaleWork, type StaleWorkClient } from "./stale-work";

const removeIssueLabelMock = removeIssueLabel as ReturnType<typeof vi.fn>;

const REPO = "octocat/hello-world";

interface WorkRow {
  id: string;
  agentName: string;
  issueId: string;
  state: string;
  staleClaimReleasePending: boolean;
  lastHeartbeatAt: Date;
  leaseExpiresAt: Date;
  issue: {
    id: string;
    number: number;
    state: string;
    labels: string[];
    blockedReason: null;
    linkedPrNumber: null;
    repository: { fullName: string };
  };
}

/**
 * A stale AgentWork row plus the narrow surfaces `sweepStaleWork` reads. The
 * issue row is mutable so a release is visible to the retry, and the lifecycle
 * event table keeps rows keyed by `dedupeKey` the way the unique index does —
 * so "how many releases are in the stream" is counted, not inferred.
 */
function makeSweepClient(options: { work: WorkRow; dieBeforeFinalize?: boolean }) {
  const eventRows: Array<Record<string, any>> = [];
  const work = options.work;
  let crashed = false;

  const issueLifecycleEvent = {
    create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
      eventRows.push({ ...data });
      return data;
    }),
    upsert: vi.fn(async ({ where, create }: { where: { dedupeKey: string }; create: Record<string, any> }) => {
      const existing = eventRows.find((row) => row.dedupeKey === where.dedupeKey);
      if (existing) return existing;
      eventRows.push({ ...create });
      return create;
    }),
  };

  const issue = {
    update: vi.fn(async ({ data }: { data: { labels?: string[] } }) => {
      if (data.labels) issueRow.labels = [...data.labels];
      return issueRow;
    }),
    findUnique: vi.fn(async () => ({ labels: [...issueRow.labels] })),
  };
  const issueRow = work.issue;

  const agentWorkUpdateMany = vi.fn(async ({ data }: { data: Record<string, any> }) => {
    // The finalization step is what a crash lands after: the release has
    // committed, but the row is never cleared of its retry marker.
    if (options.dieBeforeFinalize && data.staleClaimReleasePending === false && !crashed) {
      crashed = true;
      throw new Error("sweep died before finalizing");
    }
    if (data.state) work.state = data.state;
    if (data.staleClaimReleasePending !== undefined) work.staleClaimReleasePending = data.staleClaimReleasePending;
    return { count: 1 };
  });

  const tx = {
    agentWork: { updateMany: agentWorkUpdateMany },
    lease: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    agentWorkHistory: { create: vi.fn().mockResolvedValue({ id: "h-1" }) },
    issue,
    issueLifecycleEvent,
  };

  const client = {
    agentWork: { findMany: vi.fn(async () => [work]) },
    issue,
    issueLifecycleEvent,
    lease: tx.lease,
    agentWorkHistory: tx.agentWorkHistory,
    auditLog: { create: vi.fn().mockResolvedValue({ id: "a-1" }) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as StaleWorkClient;

  return { client, eventRows, work };
}

function makeWork(overrides: Partial<WorkRow> = {}): WorkRow {
  return {
    id: "work-1",
    agentName: "alpha",
    issueId: "issue-1",
    state: "CLAIMED",
    staleClaimReleasePending: false,
    lastHeartbeatAt: new Date("2026-10-01T00:00:00.000Z"),
    leaseExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
    issue: {
      id: "issue-1",
      number: 42,
      state: "open",
      labels: ["agent/alpha", "status/in-progress"],
      blockedReason: null,
      linkedPrNumber: null,
      repository: { fullName: REPO },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  removeIssueLabelMock.mockResolvedValue(undefined);
});

describe("sweepStaleWork — one claim_released per claim epoch (#1202 review)", () => {
  it("records one release for a sweep that dies before finalizing, then retries", async () => {
    // The AgentWork row is the claim epoch and is stable across the retry, so
    // the release and the already-released repair the retry has to take are the
    // same release — one row, not two.
    const { client, eventRows, work } = makeSweepClient({ work: makeWork(), dieBeforeFinalize: true });

    const first = await sweepStaleWork(client);
    expect(first.released).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({ kind: "claim_released", source: "stale-recovery" });
    // The row is still marked for retry, exactly as a crash leaves it.
    expect(work.staleClaimReleasePending).toBe(true);

    const second = await sweepStaleWork(client);
    expect(second.released).toBe(1);
    expect(second.errors).toHaveLength(0);

    expect(eventRows).toHaveLength(1);
    // The retry found the agent label already gone and repaired the cache.
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(2);
    expect(removeIssueLabelMock).toHaveBeenLastCalledWith(REPO, 42, "agent/alpha");
    expect(work.issue.labels).toEqual(["status/in-progress"]);
  });

  it("records a reclaim as a second release, because the AgentWork row is new", async () => {
    // The issue was claimed again after the first sweep, so the second row is a
    // different claim epoch and its release is a different fact.
    const first = makeSweepClient({ work: makeWork() });
    await sweepStaleWork(first.client);
    expect(first.eventRows).toHaveLength(1);

    const reclaimed = makeWork({ id: "work-2", issue: makeWork().issue });
    const second = makeSweepClient({ work: reclaimed });
    await sweepStaleWork(second.client);

    expect(second.eventRows).toHaveLength(1);
    // Different identities: the two releases do not collapse onto one row.
    expect(second.eventRows[0].dedupeKey).not.toBe(first.eventRows[0].dedupeKey);
  });

  it("skips a row another sweep already took over", async () => {
    const { client, eventRows } = makeSweepClient({ work: makeWork() });
    // The conditional mark misses — a concurrent sweep owns this row now.
    (client as unknown as { $transaction: any }).$transaction.mockImplementation(async () => false);

    const report = await sweepStaleWork(client);

    expect(report).toMatchObject({ examined: 1, released: 0, skipped: 1 });
    expect(eventRows).toHaveLength(0);
  });
});