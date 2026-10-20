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

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const minutesAhead = (n: number) => new Date(Date.now() + n * 60_000);

interface WorkRow {
  id: string;
  agentName: string;
  issueId: string;
  state: string;
  staleClaimReleasePending: boolean;
  lastHeartbeatAt: Date;
  /** Nullable in the schema: a row may carry no lease expiry at all. */
  leaseExpiresAt: Date | null;
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

// ─── Clause evaluator ────────────────────────────────────────────────────────
//
// The sweeper selects reclaim candidates and live siblings with WHERE
// clauses. These helpers answer those clauses against a row in memory, so the
// REAL clause the production code passes is exercised — not a hand-copied
// predicate. A clause key or operator this evaluator does not implement
// throws, so the fake can never silently agree with a clause it does not
// actually understand.

/** The clause keys the sweeper's clauses are allowed to use. */
const CLAUSE_KEYS = new Set([
  "OR",
  "id",
  "agentName",
  "issueId",
  "state",
  "staleClaimReleasePending",
  "lastHeartbeatAt",
  "leaseExpiresAt",
]);

function matchesWhere(row: Record<string, unknown>, where: unknown): boolean {
  if (where === null || typeof where !== "object") return true;
  for (const [key, cond] of Object.entries(where as Record<string, unknown>)) {
    if (key === "OR") {
      const clauses = cond as unknown[];
      if (!clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (!CLAUSE_KEYS.has(key)) {
      throw new Error(`test fake: unsupported where clause key ${key}`);
    }
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond as Record<string, unknown>)) {
        if (op === "in") {
          if (!Array.isArray(operand) || !operand.includes(value)) return false;
        } else if (op === "not") {
          if (value === operand) return false;
        } else if (op === "lt" || op === "lte" || op === "gt" || op === "gte") {
          // SQL three-valued logic: a NULL operand is never comparable, so the
          // comparison is UNKNOWN — not true. This is what makes the sweeper's
          // `leaseExpiresAt` NULL arm meaningful.
          if (value === null || value === undefined) return false;
          const left = value instanceof Date ? value.getTime() : value;
          const right = operand instanceof Date ? operand.getTime() : operand;
          if (typeof left !== "number" || typeof right !== "number") return false;
          if (op === "lt" && !(left < right)) return false;
          if (op === "lte" && !(left <= right)) return false;
          if (op === "gt" && !(left > right)) return false;
          if (op === "gte" && !(left >= right)) return false;
        } else {
          throw new Error(`test fake: unsupported where operator ${key}.${op}`);
        }
      }
      continue;
    }
    // Scalar equality: `state: "STALE"`, `staleClaimReleasePending: false`.
    if (value !== cond) return false;
  }
  return true;
}

/**
 * A sweep client over an in-memory set of `AgentWork` rows, plus the narrow
 * surfaces `sweepStaleWork` reads.
 *
 * The candidate `findMany` returns the rows the test declares as sweep
 * candidates, filtered through the sweeper's OWN candidate clause — the clause
 * is the one the production code passes, so a candidate that is not actually
 * stale never enters the sweep. The sibling `findFirst` is evaluated
 * faithfully against EVERY row in the pool (candidates and siblings alike), so
 * a wrong predicate in the production lookup fails the test instead of
 * agreeing with it by accident.
 *
 * The issue row is mutable so a release is visible to the retry, and the
 * lifecycle event table keeps rows keyed by `dedupeKey` the way the unique
 * index does — so "how many releases are in the stream" is counted, not
 * inferred.
 */
function makeSweepClient(options: {
  candidates: WorkRow[];
  /** Every row visible to the sibling lookup. Defaults to the candidates. */
  rows?: WorkRow[];
  dieBeforeFinalize?: boolean;
}) {
  const eventRows: Array<Record<string, any>> = [];
  const auditRows: Array<Record<string, any>> = [];
  const candidates = options.candidates;
  const rows = options.rows ?? options.candidates;
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

  const findIssue = (id: string) => rows.find((row) => row.issue?.id === id)?.issue ?? null;

  const issue = {
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: { labels?: string[] } }) => {
      const target = findIssue(where.id);
      if (target && data.labels) target.labels = [...data.labels];
      return target;
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const target = findIssue(where.id);
      return target ? { labels: [...target.labels] } : null;
    }),
  };

  const agentWorkUpdateMany = vi.fn(
    async ({ where, data }: { where: unknown; data: Record<string, any> }) => {
      // The finalization step is what a crash lands after: the release has
      // committed, but the row is never cleared of its retry marker.
      if (
        options.dieBeforeFinalize &&
        data.staleClaimReleasePending === false &&
        data.state === undefined &&
        !crashed
      ) {
        crashed = true;
        throw new Error("sweep died before finalizing");
      }
      const matched = rows.filter((row) => matchesWhere(row as unknown as Record<string, unknown>, where));
      for (const row of matched) {
        if (data.state) row.state = data.state;
        if (data.staleClaimReleasePending !== undefined) {
          row.staleClaimReleasePending = data.staleClaimReleasePending;
        }
        if (data.leaseExpiresAt !== undefined) row.leaseExpiresAt = data.leaseExpiresAt;
      }
      return { count: matched.length };
    },
  );

  // The live-sibling lookup: evaluated faithfully against every row in the
  // pool, so the production predicate (agent, issue, `id not`, state, fresh
  // heartbeat, fresh-or-null lease expiry) decides the answer.
  const agentWorkFindFirst = vi.fn(async ({ where, select }: any) => {
    const matched = rows.find((row) => matchesWhere(row as unknown as Record<string, unknown>, where));
    if (!matched) return null;
    return select ? { id: matched.id } : matched;
  });

  const agentWorkFindMany = vi.fn(async ({ where, orderBy, take }: any) => {
    const selected = candidates.filter((row) =>
      matchesWhere(row as unknown as Record<string, unknown>, where),
    );
    if (orderBy?.lastHeartbeatAt === "asc") {
      selected.sort((a, b) => a.lastHeartbeatAt.getTime() - b.lastHeartbeatAt.getTime());
    }
    return typeof take === "number" ? selected.slice(0, take) : selected;
  });

  const leaseDeleteMany = vi.fn().mockResolvedValue({ count: 1 });

  const tx = {
    agentWork: { findFirst: agentWorkFindFirst, updateMany: agentWorkUpdateMany },
    lease: { deleteMany: leaseDeleteMany },
    agentWorkHistory: { create: vi.fn().mockResolvedValue({ id: "h-1" }) },
    issue,
    issueLifecycleEvent,
  };

  const client = {
    agentWork: { findMany: agentWorkFindMany },
    issue,
    issueLifecycleEvent,
    lease: tx.lease,
    agentWorkHistory: tx.agentWorkHistory,
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        auditRows.push({ ...data });
        return { id: "a-1" };
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as StaleWorkClient;

  return { client, eventRows, auditRows, leaseDeleteMany, agentWorkFindFirst, rows };
}

function makeWork(overrides: Partial<WorkRow> = {}): WorkRow {
  return {
    id: "work-1",
    agentName: "alpha",
    issueId: "issue-1",
    state: "CLAIMED",
    staleClaimReleasePending: false,
    lastHeartbeatAt: minutesAgo(30),
    leaseExpiresAt: minutesAgo(25),
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
    const work = makeWork();
    const { client, eventRows } = makeSweepClient({ candidates: [work], dieBeforeFinalize: true });

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
    const first = makeSweepClient({ candidates: [makeWork()] });
    await sweepStaleWork(first.client);
    expect(first.eventRows).toHaveLength(1);

    const reclaimed = makeWork({ id: "work-2", issue: makeWork().issue });
    const second = makeSweepClient({ candidates: [reclaimed] });
    await sweepStaleWork(second.client);

    expect(second.eventRows).toHaveLength(1);
    // Different identities: the two releases do not collapse onto one row.
    expect(second.eventRows[0].dedupeKey).not.toBe(first.eventRows[0].dedupeKey);
  });

  it("skips a row another sweep already took over", async () => {
    const { client, eventRows } = makeSweepClient({ candidates: [makeWork()] });
    // The conditional mark misses — a concurrent sweep owns this row now.
    (client as unknown as { $transaction: any }).$transaction.mockImplementation(async () => false);

    const report = await sweepStaleWork(client);

    expect(report).toMatchObject({ examined: 1, released: 0, skipped: 1 });
    expect(eventRows).toHaveLength(0);
  });
});

// ─── Claim-incarnation safety ────────────────────────────────────────────────
//
// A stale row must never release a claim that a live worker still owns. An
// older BLOCKED row and a freshly renewed IN_PROGRESS row can coexist for the
// same (agent, issue) — the renewed one keeps the claim alive, so reclaiming
// the older one must not delete the lease or the `agent/<name>` label.

describe("sweepStaleWork — a stale row never releases a claim a live sibling owns", () => {
  it("keeps the lease, the label and the claim of a freshly renewed sibling", async () => {
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const live = makeWork({
      id: "work-live",
      issue,
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAhead(30),
    });

    const { client, eventRows, auditRows, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, live],
    });

    const report = await sweepStaleWork(client);

    // The stale row was examined and reclaimed…
    expect(report.examined).toBe(1);
    expect(stale.state).toBe("STALE");
    // …but the claim was retained, not released.
    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);
    expect(report.skipped).toBe(0);

    // The live claim survives: no lease delete.
    expect(leaseDeleteMany).not.toHaveBeenCalled();
    // The GitHub agent label survives: no label removal, labels unchanged.
    expect(removeIssueLabelMock).not.toHaveBeenCalled();
    expect(issue.labels).toEqual(["agent/alpha", "status/in-progress"]);
    // No release was recorded in the lifecycle stream.
    expect(eventRows.filter((row) => row.kind === "claim_released")).toHaveLength(0);

    // The retention is audited as a retention, with unchanged labels.
    const audit = auditRows.find((row) => row.action === "stale_agentwork_claim_retained");
    expect(audit).toBeDefined();
    expect(audit?.actor).toBe("system");
    expect(audit?.success).toBe(true);
    expect(audit?.beforeLabels).toEqual(["agent/alpha", "status/in-progress"]);
    expect(audit?.afterLabels).toEqual(audit?.beforeLabels);
    // The notes name the reclaimed row, the agent, the issue and the live row
    // that still owns the claim.
    expect(audit?.notes).toContain("work-stale");
    expect(audit?.notes).toContain("alpha");
    expect(audit?.notes).toContain("issue-1");
    expect(audit?.notes).toContain("work-live");
    expect(auditRows.find((row) => row.action === "stale_agentwork_released")).toBeUndefined();
  });

  it("negative control: the same stale row with no live sibling still releases the claim", async () => {
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });

    const { client, eventRows, auditRows, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    expect(report.skipped).toBe(0);

    // The lease is deleted, the label is removed, exactly one release is
    // recorded.
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: { agentName: "alpha", issueId: "issue-1" },
    });
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, 42, "agent/alpha");
    expect(issue.labels).toEqual(["status/in-progress"]);
    const releases = eventRows.filter((row) => row.kind === "claim_released");
    expect(releases).toHaveLength(1);
    expect(auditRows.find((row) => row.action === "stale_agentwork_released")).toBeDefined();
    expect(auditRows.find((row) => row.action === "stale_agentwork_claim_retained")).toBeUndefined();
  });

  it("releases the claim when the only sibling is stale too", async () => {
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const alsoStale = makeWork({
      id: "work-older",
      issue,
      state: "CLAIMED",
      lastHeartbeatAt: minutesAgo(45),
      leaseExpiresAt: minutesAgo(40),
    });

    const { client, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, alsoStale],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("counts a live sibling with a NULL lease expiry as live", async () => {
    // The sweeper's own staleness predicate cannot see a NULL expiry
    // (`NULL < cutoff` is UNKNOWN), so such a row is NOT stale — and must
    // therefore keep the claim alive.
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const live = makeWork({
      id: "work-live",
      issue,
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: null,
    });

    const { client, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, live],
    });

    const report = await sweepStaleWork(client);

    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);
    expect(leaseDeleteMany).not.toHaveBeenCalled();
  });

  it("does not treat a sibling in a non-active state as live", async () => {
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const done = makeWork({
      id: "work-done",
      issue,
      state: "DONE",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAhead(30),
    });

    const { client, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, done],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("does not treat a sibling on another issue or another agent as live", async () => {
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const otherIssue = makeWork({
      id: "work-other-issue",
      issueId: "issue-2",
      issue: { ...makeWork().issue, id: "issue-2", number: 43 },
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAhead(30),
    });
    const otherAgent = makeWork({
      id: "work-other-agent",
      agentName: "beta",
      issue,
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAhead(30),
    });

    const { client, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, otherIssue, otherAgent],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("withholds the release on the retry path too, and stops the retry loop", async () => {
    // The row was already marked STALE with a pending release when the live
    // sibling renewed. The retry must not delete the lease the live sibling
    // now owns — and it must clear the retry marker so the row stops asking.
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "STALE",
      staleClaimReleasePending: true,
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const live = makeWork({
      id: "work-live",
      issue,
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAhead(30),
    });

    const { client, eventRows, auditRows, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, live],
    });

    const report = await sweepStaleWork(client);

    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);
    expect(leaseDeleteMany).not.toHaveBeenCalled();
    expect(removeIssueLabelMock).not.toHaveBeenCalled();
    expect(eventRows.filter((row) => row.kind === "claim_released")).toHaveLength(0);
    // The retry marker is cleared: the row is not asked to release again.
    expect(stale.staleClaimReleasePending).toBe(false);
    expect(auditRows.find((row) => row.action === "stale_agentwork_claim_retained")).toBeDefined();
  });
});
