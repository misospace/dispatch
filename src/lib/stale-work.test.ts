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

// A real MUTUAL-EXCLUSION fake of the per-issue mutation fence: while the
// sweep holds an issue's fence, any other operation requesting it gets
// `busy` and its callback never runs. This is what lets the interleaving
// tests below deterministically prove a renewal cannot commit inside the
// sweep's decide-and-release window.
const { guard } = vi.hoisted(() => {
  const held = new Map<string, { operation: string; agentName?: string }>();
  const attempts: Array<{ issueId: string; operation: string; agentName?: string; status: string }> = [];
  return {
    guard: {
      held,
      attempts,
      reset: () => {
        held.clear();
        attempts.length = 0;
      },
    },
  };
});

vi.mock("@/lib/issue-mutation-guard", () => ({
  withIssueMutationGuard: async (request: any, callback: any) => {
    const current = guard.held.get(request.issueId);
    if (current) {
      guard.attempts.push({ ...request, status: "busy" });
      return { status: "busy", ownerToken: "other", operation: current.operation };
    }
    guard.held.set(request.issueId, { operation: request.operation, agentName: request.agentName });
    guard.attempts.push({ ...request, status: "acquired" });
    try {
      const result = await callback(undefined, { resuming: false });
      if (result.complete) return { status: "completed", value: result.value };
      return { status: "retained", ownerToken: "self", value: result.value };
    } finally {
      guard.held.delete(request.issueId);
    }
  },
}));

import { removeIssueLabel } from "@/lib/github";
import { withIssueMutationGuard } from "@/lib/issue-mutation-guard";
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
  // Lease claim-epoch fence keys (#1251 review): the snapshot fields the
  // CAS delete compares against.
  "claimToken",
  "expiredAt",
  "lastRenewalObservedAt",
]);

/** Scalar equality honoring Prisma's by-value comparison for `Date`s. */
function scalarEquals(value: unknown, cond: unknown): boolean {
  if (value instanceof Date || cond instanceof Date) {
    if (!(value instanceof Date) || !(cond instanceof Date)) return false;
    return value.getTime() === cond.getTime();
  }
  return value === cond;
}

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
    // Scalar equality: `state: "STALE"`, `staleClaimReleasePending: false`,
    // and by-value Date equality for the epoch fence timestamps.
    if (!scalarEquals(value, cond)) return false;
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
/** A `Lease` row narrowed to the fields the epoch fence compares. */
interface LeaseRow {
  agentName: string;
  issueId: string;
  claimToken: string | null;
  expiredAt: Date;
  lastRenewalObservedAt: Date | null;
  createdAt: Date;
}

function makeLease(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    agentName: "alpha",
    issueId: "issue-1",
    claimToken: "token-1",
    expiredAt: minutesAgo(25),
    lastRenewalObservedAt: null,
    createdAt: minutesAgo(30),
    ...overrides,
  };
}

function makeSweepClient(options: {
  candidates: WorkRow[];
  /** Every row visible to the sibling lookup. Defaults to the candidates. */
  rows?: WorkRow[];
  dieBeforeFinalize?: boolean;
  /** Lease rows visible to the epoch snapshot and the fenced delete. */
  leases?: LeaseRow[];
  /**
   * Runs INSIDE the sweep's decision window — after the claim-epoch snapshot
   * and the live-sibling lookup, before the fenced lease delete. This is the
   * deterministic stand-in for the interleaving the review demanded: a
   * renewal / re-claim / fresh claim that commits exactly there.
   */
  afterSiblingLookup?: () => void | Promise<void>;
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
  // heartbeat, fresh-or-null lease expiry) decides the answer. The
  // `afterSiblingLookup` hook then runs — the scripted interleave lands
  // between this lookup and the fenced lease delete.
  const agentWorkFindFirst = vi.fn(async ({ where, select }: any) => {
    const matched = rows.find((row) => matchesWhere(row as unknown as Record<string, unknown>, where));
    if (options.afterSiblingLookup) await options.afterSiblingLookup();
    if (!matched) return null;
    return select ? { id: matched.id } : matched;
  });

  const candidateClauses: unknown[] = [];
  const agentWorkFindMany = vi.fn(async ({ where, orderBy, take }: any) => {
    candidateClauses.push(where);
    const selected = candidates.filter((row) =>
      matchesWhere(row as unknown as Record<string, unknown>, where),
    );
    if (orderBy?.lastHeartbeatAt === "asc") {
      selected.sort((a, b) => a.lastHeartbeatAt.getTime() - b.lastHeartbeatAt.getTime());
    }
    return typeof take === "number" ? selected.slice(0, take) : selected;
  });

  // The lease pool the epoch snapshot reads and the fenced delete matches
  // against — evaluated faithfully, so a fence the production code does not
  // actually write (or writes wrongly) deletes nothing / deletes the wrong
  // row here exactly as it would in the database.
  const leases = options.leases ?? [];

  const leaseFindFirst = vi.fn(async ({ where }: any) => {
    const matched = leases.find((lease) => matchesWhere(lease as unknown as Record<string, unknown>, where));
    return matched ? { ...matched } : null;
  });

  const leaseDeleteMany = vi.fn(async ({ where }: any) => {
    const doomed = leases.filter((lease) => matchesWhere(lease as unknown as Record<string, unknown>, where));
    for (const doomed_ of doomed) leases.splice(leases.indexOf(doomed_), 1);
    return { count: doomed.length };
  });

  const tx = {
    agentWork: { findFirst: agentWorkFindFirst, updateMany: agentWorkUpdateMany },
    lease: { findFirst: leaseFindFirst, deleteMany: leaseDeleteMany },
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

  return { client, eventRows, auditRows, leaseDeleteMany, leaseFindFirst, agentWorkFindFirst, candidateClauses, rows, leases };
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
  guard.reset();
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
      // Exactly what `renewOwnership` writes onto the freshest active row:
      // the operation's own clock as the heartbeat, and the renewed ownership
      // expiry (`now + DISPATCH_OWNERSHIP_RENEW_TTL_MS`, default 30 min) as
      // the lease expiry.
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAhead(30),
    });

    const { client, eventRows, auditRows, leaseDeleteMany, candidateClauses } = makeSweepClient({
      candidates: [stale],
      rows: [stale, live],
    });
    const liveHeartbeatBefore = live.lastHeartbeatAt.getTime();
    const liveExpiryBefore = live.leaseExpiresAt?.getTime() ?? null;

    const report = await sweepStaleWork(client);

    // The stale row was examined and reclaimed…
    expect(report.examined).toBe(1);
    expect(stale.state).toBe("STALE");
    // …but the claim was retained, not released.
    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);
    expect(report.skipped).toBe(0);

    // The reclaimed row stops asking for a release: the retry marker is down,
    // so the next sweep does not pick it up again.
    expect(stale.staleClaimReleasePending).toBe(false);
    // The live sibling is untouched by the reclaim of its stale sibling.
    expect(live.state).toBe("IN_PROGRESS");
    expect(live.lastHeartbeatAt.getTime()).toBe(liveHeartbeatBefore);
    expect(live.leaseExpiresAt?.getTime() ?? null).toBe(liveExpiryBefore);
    // The live sibling was never a reclaim candidate in the first place — it
    // is the STALE sibling's reclaim that must not take the claim down.
    const [candidateClause] = candidateClauses;
    expect(matchesWhere(live as unknown as Record<string, unknown>, candidateClause)).toBe(false);

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

    // The label is removed and exactly one release is recorded. With no
    // lease row at the snapshot there is nothing legitimate to delete, so no
    // delete is attempted at all — and a fresh claim created inside the
    // window would be caught by the existence recheck instead.
    expect(leaseDeleteMany).not.toHaveBeenCalled();
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
      leases: [makeLease()],
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
      leases: [makeLease()],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("does not treat an already reclaimed STALE sibling as live", async () => {
    // A previously reclaimed row is `STALE`, not an active one. Counting it as
    // live would withhold the pending release of a later retry forever — the
    // claim would never be released at all.
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const reclaimed = makeWork({
      id: "work-reclaimed",
      issue,
      state: "STALE",
      staleClaimReleasePending: true,
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAhead(30),
    });

    const { client, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, reclaimed],
      leases: [makeLease()],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("needs BOTH arms of the live predicate: a fresh heartbeat alone is not live", async () => {
    // The sweeper reclaims a row when its heartbeat OR its expiry falls past
    // the cutoff, so "live" is the exact complement: BOTH must be fresh. A
    // sibling that is fresh by heartbeat but whose expiry has lapsed is itself
    // reclaimable, and must not shield the claim forever.
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const freshHeartbeatStaleExpiry = makeWork({
      id: "work-half-fresh",
      issue,
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAgo(25),
    });

    const { client, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, freshHeartbeatStaleExpiry],
      leases: [makeLease()],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("needs BOTH arms of the live predicate: a fresh expiry alone is not live", async () => {
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const staleHeartbeatFreshExpiry = makeWork({
      id: "work-half-stale",
      issue,
      state: "IN_PROGRESS",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAhead(30),
    });

    const { client, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, staleHeartbeatFreshExpiry],
      leases: [makeLease()],
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
      leases: [makeLease()],
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

// ─── Fence + claim-epoch protection (#1251 review, TOCTOU blocker) ───────────
//
// The live-sibling lookup alone is a check, not a fence: a renewal or fresh
// claim could commit between the lookup and the lease delete. Two layers now
// close the window — the per-issue `IssueMutationGuard` fence (serializes
// every claim-path writer out of the decide-and-release pipeline) and the
// claim-epoch CAS on the delete itself (backs off if a writer commits inside
// the decision window anyway).

describe("sweepStaleWork — decide-and-release under the per-issue fence and claim-epoch CAS", () => {
  const staleRow = (overrides: Partial<WorkRow> = {}) =>
    makeWork({
      id: "work-stale",
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
      ...overrides,
    });

  it("holds the issue-scoped stale-release fence around the whole pipeline", async () => {
    const stale = staleRow();
    const { client, eventRows } = makeSweepClient({ candidates: [stale], rows: [stale] });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(guard.attempts).toEqual([
      { issueId: "issue-1", operation: "stale-release", agentName: "alpha", status: "acquired" },
    ]);
    // The fence is released when the pipeline finishes.
    expect(guard.held.size).toBe(0);
    expect(eventRows.filter((row) => row.kind === "claim_released")).toHaveLength(1);
  });

  it("skips the candidate while a claim-path writer holds the issue fence, touching nothing", async () => {
    // A claim/renewal holds the issue fence RIGHT NOW. The sweep must not
    // mark, not delete the lease, and not touch the label — it defers to the
    // next sweep instead of racing the writer.
    guard.held.set("issue-1", { operation: "ownership", agentName: "alpha" });
    const stale = staleRow();
    const lease = makeLease();
    const { client, eventRows, auditRows, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report).toMatchObject({ examined: 1, released: 0, claimRetained: 0, skipped: 1, errors: [] });
    // Nothing moved: no mark, no delete, no release, no audit.
    expect(stale.state).toBe("BLOCKED");
    expect(stale.staleClaimReleasePending).toBe(false);
    expect(leaseDeleteMany).not.toHaveBeenCalled();
    expect(removeIssueLabelMock).not.toHaveBeenCalled();
    expect(eventRows).toHaveLength(0);
    expect(auditRows).toHaveLength(0);
    expect(guard.attempts).toEqual([
      { issueId: "issue-1", operation: "stale-release", agentName: "alpha", status: "busy" },
    ]);
  });

  it("a renewal committing between the sibling lookup and the delete keeps lease, label and claim", async () => {
    // The exact interleaving the review demanded, scripted deterministically:
    // the sibling is stale at lookup, and the renewal commits inside the
    // window — after the epoch snapshot and lookup, before the fenced delete.
    const lease = makeLease({ claimToken: "token-1", expiredAt: minutesAgo(25), lastRenewalObservedAt: null });
    const renewedExpiry = minutesAhead(30);
    const stale = staleRow();

    const { client, eventRows, auditRows, leaseDeleteMany, leases } = makeSweepClient({
      candidates: [stale],
      rows: [stale],
      leases: [lease],
      afterSiblingLookup: () => {
        // Exactly what an accepted `renewOwnership` commits onto the lease:
        // the renewed expiry and the renewal clock; the claim token is kept
        // (same attempt).
        lease.expiredAt = renewedExpiry;
        lease.lastRenewalObservedAt = new Date();
      },
    });

    const report = await sweepStaleWork(client);

    // The sweep tried its fenced delete…
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
    // …and backed off: the epoch no longer matches the snapshot.
    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);

    // The renewed claim survives in full: lease row with the renewed expiry…
    expect(leases).toHaveLength(1);
    expect(leases[0].expiredAt.getTime()).toBe(renewedExpiry.getTime());
    // …no label removal…
    expect(removeIssueLabelMock).not.toHaveBeenCalled();
    expect(stale.issue.labels).toEqual(["agent/alpha", "status/in-progress"]);
    // …no release in the lifecycle stream.
    expect(eventRows.filter((row) => row.kind === "claim_released")).toHaveLength(0);

    // The reclaimed row stops asking: STALE, but the retry marker is down.
    expect(stale.state).toBe("STALE");
    expect(stale.staleClaimReleasePending).toBe(false);

    // The retention is audited as an epoch-moved retention, not a sibling one.
    const audit = auditRows.find((row) => row.action === "stale_agentwork_claim_retained");
    expect(audit).toBeDefined();
    expect(audit?.notes).toContain("claim epoch moved");
  });

  it("the fence itself refuses a renewal that tries to commit inside the sweep window", async () => {
    // The serialization proof: with the sweep holding the issue fence, the
    // real fence entry point a renewal uses comes back `busy` and its write
    // never runs — the interleaving cannot happen at all, independent of the
    // epoch CAS.
    const renewalOutcomes: string[] = [];
    let renewalCallbackRan = 0;

    const stale = staleRow();
    const { client } = makeSweepClient({
      candidates: [stale],
      rows: [stale],
      afterSiblingLookup: async () => {
        const result = await withIssueMutationGuard(
          { issueId: "issue-1", operation: "ownership", agentName: "alpha", claimToken: "token-1" },
          async () => {
            renewalCallbackRan += 1;
            return { complete: true, value: "renewed" };
          },
        );
        renewalOutcomes.push(result.status);
      },
    });

    const report = await sweepStaleWork(client);

    expect(renewalOutcomes).toEqual(["busy"]);
    expect(renewalCallbackRan).toBe(0);
    // The stale claim itself is reclaimed normally (the renewal lost the race
    // and will retry against post-sweep state).
    expect(report.released).toBe(1);
    expect(guard.held.size).toBe(0);
  });

  it("a fresh claim created inside the decision window is neither deleted nor released", async () => {
    // No lease at the snapshot; a brand-new claim (new row, new token)
    // commits inside the window. The null-snapshot fence must not consume it,
    // and the post-delete recheck must force the back-off.
    const stale = staleRow();
    const { client, eventRows, leaseDeleteMany, leases } = makeSweepClient({
      candidates: [stale],
      rows: [stale],
      leases: [],
      afterSiblingLookup: () => {
        leases.push(
          makeLease({ claimToken: "token-2", createdAt: new Date(), expiredAt: minutesAhead(30) }),
        );
      },
    });

    const report = await sweepStaleWork(client);

    // With no snapshot row the sweep never deletes: the existence recheck is
    // what catches the fresh claim.
    expect(leaseDeleteMany).not.toHaveBeenCalled();
    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);
    expect(leases).toHaveLength(1);
    expect(leases[0].claimToken).toBe("token-2");
    expect(removeIssueLabelMock).not.toHaveBeenCalled();
    expect(eventRows.filter((row) => row.kind === "claim_released")).toHaveLength(0);
  });

  it("negative control: the same candidate with no interleaved write releases normally through the epoch fence", async () => {
    const lease = makeLease({ claimToken: "token-1", expiredAt: minutesAgo(25), lastRenewalObservedAt: null });
    const expiryBefore = lease.expiredAt;
    const stale = staleRow();
    const { client, eventRows, leaseDeleteMany, leases } = makeSweepClient({
      candidates: [stale],
      rows: [stale],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    // The delete is CAS-fenced on the exact epoch the snapshot read.
    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: {
        agentName: "alpha",
        issueId: "issue-1",
        claimToken: "token-1",
        expiredAt: expiryBefore,
        lastRenewalObservedAt: null,
      },
    });
    expect(leases).toHaveLength(0);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, 42, "agent/alpha");
    expect(eventRows.filter((row) => row.kind === "claim_released")).toHaveLength(1);
  });

  it("a terminal disposition is not a claim-epoch move: the disposed lease is still deleted", async () => {
    // The fence keys on renewal/re-claim evidence ONLY. A worker cleanly
    // disposing its claim inside the window must not make the sweep back off
    // forever.
    const lease = makeLease({ claimToken: "token-1" });
    const stale = staleRow();
    const { client, leases } = makeSweepClient({
      candidates: [stale],
      rows: [stale],
      leases: [lease],
      afterSiblingLookup: () => {
        (lease as unknown as Record<string, unknown>).disposition = "completed";
      },
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    expect(leases).toHaveLength(0);
  });
});

// ─── No guard wedge behind a failed post-decision audit (#1251 review) ───────
//
// Once the row is marked STALE without a pending release (retention) or
// finalized (release), it is no longer a sweep candidate — so a throwing
// trailing audit write must not escape the pipeline. An escaped error would
// demote the mutation guard with nothing left to resume it, freezing every
// claim-path write on the issue.

describe("sweepStaleWork — a failed post-decision audit never strands the fence", () => {
  it("release still completes and the guard is released when the release audit throws", async () => {
    const stale = makeWork({ id: "work-stale", state: "BLOCKED" });
    const { client, eventRows } = makeSweepClient({ candidates: [stale], rows: [stale] });
    (client as unknown as { auditLog: { create: any } }).auditLog.create = vi.fn(
      async () => {
        throw new Error("audit store unreachable");
      },
    );

    const report = await sweepStaleWork(client);

    // The release itself happened and the fence came back clean.
    expect(report.released).toBe(1);
    expect(guard.held.size).toBe(0);
    expect(eventRows.filter((row) => row.kind === "claim_released")).toHaveLength(1);
    // The audit failure is visible in the report, not swallowed.
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].error).toContain("release audit failed");
  });

  it("retention still completes and the guard is released when the retention audit throws", async () => {
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
    const { client, leaseDeleteMany } = makeSweepClient({
      candidates: [stale],
      rows: [stale, live],
    });
    (client as unknown as { auditLog: { create: any } }).auditLog.create = vi.fn(
      async () => {
        throw new Error("audit store unreachable");
      },
    );

    const report = await sweepStaleWork(client);

    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);
    expect(leaseDeleteMany).not.toHaveBeenCalled();
    expect(guard.held.size).toBe(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].error).toContain("claim-retention audit failed");
  });
});

// ─── #1317: lease-release accounting over the fenced epoch delete ────────────
//
// #1317's hazard: a re-claim only releases CLAIMED/IN_PROGRESS sibling rows,
// so a BLOCKED sibling survives the re-claim; sweeping that stale sibling must
// never consume the NEWER claim epoch's lease. Under the merged mechanism this
// is closed structurally — the live-sibling guard defers the sweep while the
// newer epoch is live, and the claim-epoch CAS delete can only consume the
// exact lease the snapshot read (any renew / re-claim / fresh claim makes it
// match nothing). `leasesReleased` reports how many leases the sweep actually
// deleted, so operators can see the difference between a release that consumed
// a lease and a no-lease reclaim.

describe("sweepStaleWork — leasesReleased accounting (#1317)", () => {
  it("counts the lease consumed by the epoch-fenced delete on a normal release", async () => {
    const lease = makeLease({ claimToken: "token-1" });
    const stale = makeWork({ id: "work-stale", state: "BLOCKED" });
    const { client, leases } = makeSweepClient({
      candidates: [stale],
      rows: [stale],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.leasesReleased).toBe(1);
    expect(leases).toHaveLength(0);
  });

  it("reports zero when the marked row's pair has no lease row at snapshot", async () => {
    const stale = makeWork({ id: "work-stale", state: "BLOCKED" });
    const { client } = makeSweepClient({ candidates: [stale], rows: [stale] });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.leasesReleased).toBe(0);
  });

  it("a live-sibling retention counts no lease release (#1317 scenario: BLOCKED sibling surviving a re-claim)", async () => {
    // The exact #1317 setup in current terms: the newer claim epoch of the
    // SAME agent on the SAME issue is live — its row heartbeats and its lease
    // was renewed with a fresh claim token — while an older BLOCKED row from
    // before the re-claim goes stale and enters the sweep.
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-blocked-old",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const live = makeWork({
      id: "work-new-epoch",
      issue,
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAhead(30),
    });
    const renewedLease = makeLease({
      claimToken: "token-epoch-2",
      expiredAt: minutesAhead(30),
      lastRenewalObservedAt: new Date(),
    });

    const { client, leaseDeleteMany, leases } = makeSweepClient({
      candidates: [stale],
      rows: [stale, live],
      leases: [renewedLease],
    });

    const report = await sweepStaleWork(client);

    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);
    expect(report.leasesReleased).toBe(0);
    // The live epoch's lease is untouched — not even a delete attempt.
    expect(leaseDeleteMany).not.toHaveBeenCalled();
    expect(leases).toHaveLength(1);
    expect(leases[0].claimToken).toBe("token-epoch-2");
    expect(live.state).toBe("IN_PROGRESS");
  });

  it("an epoch move inside the decision window consumes no lease and counts zero (#1317 accounting)", async () => {
    const lease = makeLease({ claimToken: "token-1", expiredAt: minutesAgo(25), lastRenewalObservedAt: null });
    const stale = makeWork({ id: "work-stale", state: "BLOCKED" });
    const { client, leases } = makeSweepClient({
      candidates: [stale],
      rows: [stale],
      leases: [lease],
      afterSiblingLookup: () => {
        lease.expiredAt = minutesAhead(30);
        lease.lastRenewalObservedAt = new Date();
      },
    });

    const report = await sweepStaleWork(client);

    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);
    expect(report.leasesReleased).toBe(0);
    expect(leases).toHaveLength(1);
  });

  it("accumulates across a batch: only rows whose fenced delete consumed a lease are counted (#1317)", async () => {
    const baseIssue = makeWork().issue;
    const otherIssue = { ...baseIssue, id: "issue-2", number: 43, labels: ["agent/alpha", "status/in-progress"] };
    const releasable = makeWork({ id: "work-1", state: "BLOCKED" });
    const lease = makeLease({ claimToken: "token-1" });
    const withheld = makeWork({
      id: "work-2",
      issueId: "issue-2",
      issue: otherIssue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(40),
      leaseExpiresAt: minutesAgo(35),
    });
    const liveSibling = makeWork({
      id: "work-3",
      issueId: "issue-2",
      issue: otherIssue,
      state: "IN_PROGRESS",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: minutesAhead(30),
    });

    const { client, leases } = makeSweepClient({
      candidates: [releasable, withheld],
      rows: [releasable, withheld, liveSibling],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report.examined).toBe(2);
    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(1);
    expect(report.leasesReleased).toBe(1);
    expect(leases).toHaveLength(0);
  });
});

// ─── #1316: a parked blocked claim outlives the park ─────────────────────────
//
// A `blocked` ownership disposition parks the claim as an external wait by
// moving the settled row's `leaseExpiresAt` to the `retryAfter` deadline
// (`worker-ownership.ts`). The parked worker is silent BY DESIGN, so the
// BLOCKED family is reclaim-gated on the park deadline alone — heartbeat
// silence must not reclaim a row whose park is still running, or the sweep
// destroys the very lease the park was recorded on.

describe("sweepStaleWork — parked blocked claims (#1316)", () => {
  it("leaves a parked BLOCKED row out of the reclaim candidates despite heartbeat silence", async () => {
    const parked = makeWork({
      id: "work-parked",
      state: "BLOCKED",
      // The shape a blocked disposition actually leaves: the worker is gone,
      // its last heartbeat keeps aging, and the row now carries the park
      // deadline (retryAfter) as its lease expiry.
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAhead(40),
    });
    const lease = makeLease();
    const { client, eventRows, leaseDeleteMany, leases, candidateClauses } = makeSweepClient({
      candidates: [parked],
      rows: [parked],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report).toMatchObject({ examined: 0, released: 0, claimRetained: 0, skipped: 0 });
    expect(parked.state).toBe("BLOCKED");
    expect(leaseDeleteMany).not.toHaveBeenCalled();
    expect(leases).toHaveLength(1);
    expect(eventRows).toHaveLength(0);

    // Forensic delta against the REAL clause: the identical row with the old
    // (unrefreshed, now lapsed) expiry — the pre-disposition-fix shape a few
    // minutes after the disposition — IS selected. The park deadline is the
    // only thing keeping the row alive.
    const [candidateClause] = candidateClauses;
    const preFixShape = { ...parked, leaseExpiresAt: minutesAgo(10) } as unknown as Record<string, unknown>;
    expect(matchesWhere(preFixShape, candidateClause)).toBe(true);
  });

  it("reclaims a silent BLOCKED row once its deadline elapsed (delta control for the park)", async () => {
    // The ONLY difference from the parked row above is a lapsed deadline: the
    // sweep still reclaims silent BLOCKED rows, so the parked row's survival
    // is caused by the park itself, not by a broken clause.
    const unparked = makeWork({
      id: "work-unparked",
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(10),
    });
    const lease = makeLease();
    const { client, leaseDeleteMany, leases } = makeSweepClient({
      candidates: [unparked],
      rows: [unparked],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(unparked.state).toBe("STALE");
    expect(report.leasesReleased).toBe(1);
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
    expect(leases).toHaveLength(0);
  });

  it("reclaims the parked row once the park deadline has elapsed", async () => {
    // Past `retryAfter` (+ the sweep's age window) the park is over: the row
    // follows the normal reclaim path and releases the claim for re-dispatch.
    const expiredPark = makeWork({
      id: "work-park-expired",
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(10),
    });
    const lease = makeLease();
    const { client, leaseDeleteMany, leases } = makeSweepClient({
      candidates: [expiredPark],
      rows: [expiredPark],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(expiredPark.state).toBe("STALE");
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
    expect(leases).toHaveLength(0);
  });

  it("reclaims a BLOCKED row with no park deadline (NULL expiry) even with a fresh heartbeat", async () => {
    // No deadline means no park: the NULL arm keeps such rows on the normal
    // stale path instead of letting them hold the claim forever.
    const nullDeadline = makeWork({
      id: "work-null-deadline",
      state: "BLOCKED",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: null,
    });
    const lease = makeLease();
    const { client, leases } = makeSweepClient({
      candidates: [nullDeadline],
      rows: [nullDeadline],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(nullDeadline.state).toBe("STALE");
    expect(leases).toHaveLength(0);
  });

  it("a parked BLOCKED sibling keeps the claim of a reclaimed stale row", async () => {
    // The parked park deadline — not a heartbeat — is what shields the claim:
    // reclaiming the older row must not delete the lease the park sits on.
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "CLAIMED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const parked = makeWork({
      id: "work-parked",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: minutesAgo(40),
      leaseExpiresAt: minutesAhead(40),
    });
    const lease = makeLease();
    const { client, auditRows, leaseDeleteMany, leases } = makeSweepClient({
      candidates: [stale],
      rows: [stale, parked],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report.claimRetained).toBe(1);
    expect(report.released).toBe(0);
    expect(leaseDeleteMany).not.toHaveBeenCalled();
    expect(leases).toHaveLength(1);
    expect(parked.state).toBe("BLOCKED");
    const audit = auditRows.find((row) => row.action === "stale_agentwork_claim_retained");
    expect(audit?.notes).toContain("work-parked");
  });

  it("a NULL-expiry BLOCKED sibling is not live: no park, no shield", async () => {
    // The exact complement of the reclaim arm: `leaseExpiresAt IS NULL` is
    // reclaimable for BLOCKED rows, so it must NOT count as a live sibling
    // (a silent NULL-expiry row would otherwise hold the claim forever).
    const issue = makeWork().issue;
    const stale = makeWork({
      id: "work-stale",
      issue,
      state: "CLAIMED",
      lastHeartbeatAt: minutesAgo(30),
      leaseExpiresAt: minutesAgo(25),
    });
    const nullDeadline = makeWork({
      id: "work-null-deadline",
      issue,
      state: "BLOCKED",
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: null,
    });
    const lease = makeLease();
    const { client, leaseDeleteMany, leases } = makeSweepClient({
      candidates: [stale],
      rows: [stale, nullDeadline],
      leases: [lease],
    });

    const report = await sweepStaleWork(client);

    expect(report.released).toBe(1);
    expect(report.claimRetained).toBe(0);
    expect(leaseDeleteMany).toHaveBeenCalledTimes(1);
    expect(leases).toHaveLength(0);
  });
});
