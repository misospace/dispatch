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
  issueId: string | null;
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

interface LeaseRow {
  id: string;
  agentName: string;
  issueId: string;
  createdAt: Date;
  renewedAt: Date | null;
  expiredAt: Date;
}

type NarrowedLeaseWhere = {
  agentName: string;
  issueId: string;
  OR: Array<Record<string, any>>;
};

interface SiblingRow {
  id: string;
  agentName: string;
  issueId: string;
  state: string;
}

/**
 * Evaluate the live-sibling guard's where clause (#1317) the way Prisma
 * would: same pair, a different row, and a state that is still active.
 * Terminal (DONE/RELEASED/STALE) siblings must not count as live.
 */
function matchesLiveSiblingWhere(row: SiblingRow, where: Record<string, any>): boolean {
  if (row.agentName !== where.agentName || row.issueId !== where.issueId) return false;
  if (row.id === where.id.not) return false;
  return where.state.in.includes(row.state);
}

/**
 * Apply the narrowed lease-release where clause (#1317) the way Prisma would:
 * pair equality plus the OR branches. The sweeper releases a lease only when
 * it has expired, or its last renewal (or creation, when never renewed)
 * predates the stale row's last heartbeat — a lease renewed later belongs to a
 * newer claim epoch of the same agent on the same issue and must survive.
 */
function matchesNarrowedLeaseWhere(row: LeaseRow, where: NarrowedLeaseWhere): boolean {
  if (row.agentName !== where.agentName || row.issueId !== where.issueId) return false;
  return where.OR.some((branch) => {
    if ("expiredAt" in branch) return row.expiredAt <= branch.expiredAt.lte;
    if ("renewedAt" in branch && branch.renewedAt === null) {
      return row.renewedAt === null && row.createdAt < branch.createdAt.lt;
    }
    if ("renewedAt" in branch) {
      return row.renewedAt !== null && row.renewedAt < branch.renewedAt.lt;
    }
    return false;
  });
}

/**
 * A stale AgentWork row plus the narrow surfaces `sweepStaleWork` reads. The
 * issue row is mutable so a release is visible to the retry, and the lifecycle
 * event table keeps rows keyed by `dedupeKey` the way the unique index does —
 * so "how many releases are in the stream" is counted, not inferred. The lease
 * store is filtered by the sweep's actual where clause so the narrowing is
 * exercised, not assumed.
 */
function makeSweepClient(options: { work: WorkRow; dieBeforeFinalize?: boolean; leases?: LeaseRow[]; siblings?: SiblingRow[] }) {
  const eventRows: Array<Record<string, any>> = [];
  const work = options.work;
  let crashed = false;
  const leaseRows: LeaseRow[] = options.leases ?? [
    { id: "lease-1", agentName: work.agentName, issueId: work.issueId ?? "issue-1", createdAt: new Date("2026-09-01T00:00:00.000Z"), renewedAt: null, expiredAt: new Date("2027-01-01T00:00:00.000Z") },
  ];

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

  const leaseDeleteMany = vi.fn(async ({ where }: { where: NarrowedLeaseWhere }) => {
    const kept = leaseRows.filter((row) => !matchesNarrowedLeaseWhere(row, where));
    const removed = leaseRows.length - kept.length;
    leaseRows.length = 0;
    leaseRows.push(...kept);
    return { count: removed };
  });
  const agentWorkCount = vi.fn(async ({ where }: { where: Record<string, any> }) => {
    const siblings = options.siblings ?? [];
    return siblings.filter((row) => matchesLiveSiblingWhere(row, where)).length;
  });

  const tx = {
    agentWork: { updateMany: agentWorkUpdateMany, count: agentWorkCount },
    lease: { deleteMany: leaseDeleteMany },
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

  return { client, eventRows, work, leaseRows, leaseDeleteMany, agentWorkCount };
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
    (client as unknown as { $transaction: any }).$transaction.mockImplementation(async () => ({
      marked: false,
      leasesReleased: 0,
    }));

    const report = await sweepStaleWork(client);

    expect(report).toMatchObject({ examined: 1, released: 0, skipped: 1 });
    expect(eventRows).toHaveLength(0);
  });
});

describe("sweepStaleWork — lease release is narrowed to the marked claim epoch (#1317)", () => {
  const QUIET_AT = new Date("2026-10-01T00:00:00.000Z");

  it("does not release a lease renewed by a newer claim epoch of the same agent", async () => {
    // The stale CLAIMED row went quiet at 00:00; the same agent later
    // re-claimed the same issue, which renewed the pair's singleton lease at
    // 02:00. The sweep marks the old row but must leave that live epoch's
    // lease alone — deleting by (agentName, issueId) pair would kill it.
    const { client, leaseRows, leaseDeleteMany } = makeSweepClient({
      work: makeWork({ lastHeartbeatAt: QUIET_AT }),
      leases: [
        {
          id: "lease-live",
          agentName: "alpha",
          issueId: "issue-1",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          renewedAt: new Date("2026-10-02T00:00:00.000Z"),
          expiredAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      ],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.leasesReleased).toBe(0);
    expect(leaseRows).toHaveLength(1);
    expect(leaseRows[0].id).toBe("lease-live");
    // The delete is narrowed by claim epoch, not by pair: the where clause
    // carries the expiry and renewal-time branches on top of the pair
    // equality.
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
    const where = (leaseDeleteMany.mock.calls[0][0] as { where: NarrowedLeaseWhere }).where;
    expect(where.agentName).toBe("alpha");
    expect(where.issueId).toBe("issue-1");
    expect(where.OR).toHaveLength(3);
    expect(where.OR[1]).toEqual({ renewedAt: { lt: QUIET_AT } });
    expect(where.OR[2]).toEqual({ renewedAt: null, createdAt: { lt: QUIET_AT } });
    expect((where.OR[0] as { expiredAt: { lte: Date } }).expiredAt.lte).toBeInstanceOf(Date);
  });

  it("does not release a fresh first-claim lease created after the row went quiet", async () => {
    // A lease that was never renewed has no renewedAt, but its createdAt is
    // after the swept row's last heartbeat: this is a newer epoch's first
    // claim on the pair, and the createdAt branch must not swallow it.
    const { client, leaseRows, leaseDeleteMany } = makeSweepClient({
      work: makeWork({ lastHeartbeatAt: QUIET_AT }),
      leases: [
        {
          id: "lease-fresh",
          agentName: "alpha",
          issueId: "issue-1",
          createdAt: new Date("2026-10-02T00:00:00.000Z"),
          renewedAt: null,
          expiredAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      ],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.leasesReleased).toBe(0);
    expect(leaseRows).toHaveLength(1);
    expect(leaseDeleteMany).toHaveBeenCalled();
  });

  it("still releases the lease of the epoch the sweep actually marked", async () => {
    // A lease whose last renewal predates the row's last heartbeat belongs to
    // the marked epoch, so the narrowed delete still releases it.
    const renewed = makeSweepClient({
      work: makeWork({ lastHeartbeatAt: QUIET_AT }),
      leases: [
        {
          id: "lease-epoch",
          agentName: "alpha",
          issueId: "issue-1",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          renewedAt: new Date("2026-09-30T00:00:00.000Z"),
          expiredAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      ],
    });
    const renewedReport = await sweepStaleWork(renewed.client);
    expect(renewedReport.released).toBe(1);
    expect(renewedReport.leasesReleased).toBe(1);
    expect(renewed.leaseRows).toHaveLength(0);

    // A never-renewed lease created before the row went quiet is the marked
    // epoch's own lease.
    const neverRenewed = makeSweepClient({
      work: makeWork({ lastHeartbeatAt: QUIET_AT }),
      leases: [
        {
          id: "lease-fresh",
          agentName: "alpha",
          issueId: "issue-1",
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
          renewedAt: null,
          expiredAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      ],
    });
    const neverReport = await sweepStaleWork(neverRenewed.client);
    expect(neverReport.released).toBe(1);
    expect(neverReport.leasesReleased).toBe(1);
    expect(neverRenewed.leaseRows).toHaveLength(0);

    // An already-expired lease blocks nothing, so the sweep releases it even
    // when its renewal time would otherwise preserve it.
    const expired = makeSweepClient({
      work: makeWork({ lastHeartbeatAt: QUIET_AT }),
      leases: [
        {
          id: "lease-expired",
          agentName: "alpha",
          issueId: "issue-1",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          renewedAt: new Date("2026-10-02T00:00:00.000Z"),
          expiredAt: new Date("2026-09-15T00:00:00.000Z"),
        },
      ],
    });
    const expiredReport = await sweepStaleWork(expired.client);
    expect(expiredReport.released).toBe(1);
    expect(expiredReport.leasesReleased).toBe(1);
    expect(expired.leaseRows).toHaveLength(0);
  });

  it("leaves the lease alone when a live sibling row shares the pair", async () => {
    // A heartbeat can land on a stale sibling after a newer claim renewed the
    // lease, so the epoch rule alone is not enough: with another
    // CLAIMED/IN_PROGRESS/BLOCKED row for the same pair, the lease may belong
    // to that sibling and the sweep defers entirely — even for an
    // already-expired lease, because the guard gates the whole delete.
    const liveSiblingStates = ["CLAIMED", "IN_PROGRESS", "BLOCKED"];
    for (const siblingState of liveSiblingStates) {
      const { client, leaseRows, leaseDeleteMany, agentWorkCount } = makeSweepClient({
        work: makeWork({ lastHeartbeatAt: QUIET_AT }),
        leases: [
          {
            id: "lease-epoch",
            agentName: "alpha",
            issueId: "issue-1",
            createdAt: new Date("2026-09-01T00:00:00.000Z"),
            renewedAt: new Date("2026-09-30T00:00:00.000Z"),
            expiredAt: new Date("2026-09-15T00:00:00.000Z"),
          },
        ],
        siblings: [{ id: "work-2", agentName: "alpha", issueId: "issue-1", state: siblingState }],
      });

      const report = await sweepStaleWork(client);

      expect(report.released).toBe(1);
      expect(report.leasesReleased).toBe(0);
      expect(agentWorkCount).toHaveBeenCalledTimes(1);
      // The guard is pair-scoped, excludes the swept row itself, and only
      // counts rows that are still active.
      const countWhere = (agentWorkCount.mock.calls[0][0] as { where: Record<string, any> }).where;
      expect(countWhere).toEqual({
        agentName: "alpha",
        issueId: "issue-1",
        id: { not: "work-1" },
        state: { in: ["CLAIMED", "IN_PROGRESS", "BLOCKED"] },
      });
      expect(leaseRows).toHaveLength(1);
      expect(leaseDeleteMany).not.toHaveBeenCalled();
    }
  });

  it("ignores terminal siblings and releases the epoch's lease", async () => {
    // DONE/RELEASED/STALE siblings are not live owners: the guard must not
    // count them, so the marked epoch's own lease is still released.
    const terminalStates = ["DONE", "RELEASED", "STALE"];
    for (const siblingState of terminalStates) {
      const { client, leaseRows, leaseDeleteMany, agentWorkCount } = makeSweepClient({
        work: makeWork({ lastHeartbeatAt: QUIET_AT }),
        leases: [
          {
            id: "lease-epoch",
            agentName: "alpha",
            issueId: "issue-1",
            createdAt: new Date("2026-09-01T00:00:00.000Z"),
            renewedAt: new Date("2026-09-30T00:00:00.000Z"),
            expiredAt: new Date("2027-01-01T00:00:00.000Z"),
          },
        ],
        siblings: [{ id: "work-2", agentName: "alpha", issueId: "issue-1", state: siblingState }],
      });

      const report = await sweepStaleWork(client);

      expect(report.released).toBe(1);
      expect(report.leasesReleased).toBe(1);
      expect(agentWorkCount).toHaveBeenCalledTimes(1);
      expect(leaseRows).toHaveLength(0);
      expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
    }
  });

  it("only considers leases for the swept pair, and only deletes when the row has an issue", async () => {
    // Another agent's lease on the same issue is outside the sweep's pair and
    // must survive untouched.
    const scoped = makeSweepClient({
      work: makeWork({ lastHeartbeatAt: QUIET_AT }),
      leases: [
        {
          id: "lease-other-agent",
          agentName: "beta",
          issueId: "issue-1",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          renewedAt: null,
          expiredAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      ],
    });
    const scopedReport = await sweepStaleWork(scoped.client);
    expect(scopedReport.released).toBe(1);
    expect(scopedReport.leasesReleased).toBe(0);
    expect(scoped.leaseRows).toHaveLength(1);

    // A row with no issue never touches the lease store.
    const noIssue = makeSweepClient({ work: makeWork({ issueId: null, lastHeartbeatAt: QUIET_AT }) });
    const noIssueReport = await sweepStaleWork(noIssue.client);
    expect(noIssueReport.released).toBe(1);
    expect(noIssueReport.leasesReleased).toBe(0);
    expect(noIssue.leaseDeleteMany).not.toHaveBeenCalled();
    expect(noIssue.agentWorkCount).not.toHaveBeenCalled();
  });

  it("retries the same narrowed delete, leaving a renewed lease untouched", async () => {
    // The retry re-marks the same STALE row, so the same snapshot heartbeat
    // bounds the delete — the newer epoch's lease survives both passes and
    // the renewal-bound branches of the two where clauses are identical.
    const { client, leaseRows, leaseDeleteMany } = makeSweepClient({
      work: makeWork({
        state: "STALE",
        staleClaimReleasePending: true,
        lastHeartbeatAt: QUIET_AT,
      }),
      leases: [
        {
          id: "lease-live",
          agentName: "alpha",
          issueId: "issue-1",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          renewedAt: new Date("2026-10-02T00:00:00.000Z"),
          expiredAt: new Date("2027-01-01T00:00:00.000Z"),
        },
      ],
    });

    const first = await sweepStaleWork(client);
    const second = await sweepStaleWork(client);

    expect(first.released).toBe(1);
    expect(second.released).toBe(1);
    expect(leaseRows).toHaveLength(1);
    expect(leaseDeleteMany).toHaveBeenCalledTimes(2);
    const firstWhere = (leaseDeleteMany.mock.calls[0][0] as { where: NarrowedLeaseWhere }).where;
    const secondWhere = (leaseDeleteMany.mock.calls[1][0] as { where: NarrowedLeaseWhere }).where;
    expect(firstWhere.agentName).toEqual(secondWhere.agentName);
    expect(firstWhere.issueId).toEqual(secondWhere.issueId);
    // The expiry branch is keyed to each run's clock; the epoch bounds are
    // keyed to the row snapshot and must be identical across retries.
    expect(firstWhere.OR.slice(1)).toEqual(secondWhere.OR.slice(1));
  });
});
