// #1357 — the open-PR-fix evidence read must use the queue's canonical repo
// identity.
//
// `PrFixQueueItem.repo` is folded (trim + lowercase) on every write
// (`normalizeQueueRepo`, #1145), so the row lives under `org/repo` even when
// the issue cache holds `Org/Repo`. The inspect read has to fold too: a raw
// casing matches no row and the open-PR-fix evidence silently disappears from
// the derived ownership state — no error, just a degraded answer.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, prFixFindFirst } = vi.hoisted(() => {
  const db = {
    issues: [] as any[],
    leases: [] as any[],
    agentWorks: [] as any[],
    prFixes: [] as any[],
  };
  // Postgres `=` on the queue's `repo` column is case-sensitive, so the fake
  // matches exactly like the real table: "Org/Repo" finds no "org/repo" row.
  const prFixFindFirst = vi.fn(async ({ where }: any) => {
    const match = db.prFixes.find((r: any) => {
      if (r.repo !== where.repo) return false;
      if (where.status?.in && !where.status.in.includes(r.status)) return false;
      return (where.OR ?? []).some(
        (c: any) =>
          (c.issue !== undefined && r.issue === c.issue) ||
          (c.pr !== undefined && r.pr === c.pr),
      );
    });
    return match ?? null;
  });
  return { db, prFixFindFirst };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      // inspectIssueOwnership: { where: { id }, include: { repository } }
      findUnique: vi.fn(async ({ where }: any) =>
        db.issues.find((i: any) => i.id === where.id) ?? null,
      ),
    },
    lease: {
      // inspect: { where: { issueId } }
      findMany: vi.fn(async ({ where }: any) =>
        db.leases.filter((l: any) => l.issueId === where.issueId),
      ),
    },
    agentWork: {
      // inspect: { where: { issueId, state: { in } }, orderBy heartbeat desc }
      findFirst: vi.fn(async ({ where }: any) =>
        db.agentWorks.find(
          (w: any) =>
            w.issueId === where.issueId &&
            (where.state?.in ?? []).includes(w.state),
        ) ?? null,
      ),
    },
    prFixQueueItem: {
      // inspect: { where: { repo, status: { in }, OR: [{ issue }, { pr }] } }
      findFirst: prFixFindFirst,
    },
  },
}));

// The forge label read is stubbed so the `live: true` case can assert WHICH
// repo casing the read was called with — the cache's, not the folded one.
const { getLiveIssueLabels } = vi.hoisted(() => ({
  getLiveIssueLabels: vi.fn(async () => ["agent/alpha", "status/in-review"]),
}));

vi.mock("@/lib/claim-gate", () => ({ getLiveIssueLabels }));

import { inspectIssueOwnership } from "./ownership-inspect";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    number: 42,
    state: "open",
    labels: ["agent/alpha", "status/in-review"] as string[],
    blockedReason: null,
    linkedPrNumber: null,
    linkedPrMergeState: null,
    // The cache holds the GitHub-shaped casing, the queue row the folded one.
    repository: { fullName: "Org/Repo", enabled: true },
    ...overrides,
  };
}

function makePrFixRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "prfix-1",
    repo: "org/repo",
    pr: 7,
    issue: 42,
    status: "QUEUED",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.issues = [];
  db.leases = [];
  db.agentWorks = [];
  db.prFixes = [];
});

describe("inspectIssueOwnership — PR-fix queue repo identity (#1357)", () => {
  it("queries the PR-fix queue with the folded repo identity", async () => {
    db.issues = [makeIssue()];
    db.prFixes = [makePrFixRow()];

    const result = await inspectIssueOwnership("issue-1", { live: false });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected the issue to be found");

    // The query must carry the queue's canonical identity, not the raw cache
    // casing — the latter matches no row.
    expect(prFixFindFirst).toHaveBeenCalledTimes(1);
    const where = prFixFindFirst.mock.calls[0]?.[0]?.where;
    expect(where.repo).toBe("org/repo");

    // The identity reported to the operator keeps the cached casing, and the
    // cached read path never reaches the forge.
    expect(result.issue.repoFullName).toBe("Org/Repo");
    expect(getLiveIssueLabels).not.toHaveBeenCalled();
  });

  it("finds the open PR-fix evidence when the cache holds uppercase casing", async () => {
    db.issues = [makeIssue()];
    db.prFixes = [makePrFixRow()];

    const result = await inspectIssueOwnership("issue-1", { live: false });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected the issue to be found");

    // Behavioural consequence: the open-PR-fix evidence is found, so the
    // derived state sees the queue row instead of degrading to "no evidence".
    expect(result.evidence.openPrFix).toBe(true);
    expect(result.assessment.state).toBe("REVIEW_OWNED");
    expect(result.assessment.reasonCodes).toContain("open_pr_fix_queue");
  });

  it("still finds the open PR-fix row when the cache already holds the folded casing", async () => {
    db.issues = [makeIssue({ repository: { fullName: "org/repo", enabled: true } })];
    db.prFixes = [makePrFixRow()];

    const result = await inspectIssueOwnership("issue-1", { live: false });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected the issue to be found");

    const where = prFixFindFirst.mock.calls[0]?.[0]?.where;
    expect(where.repo).toBe("org/repo");
    expect(result.evidence.openPrFix).toBe(true);
    expect(result.assessment.state).toBe("REVIEW_OWNED");
  });

  it("reports no open PR-fix evidence when the queue holds no matching row", async () => {
    db.issues = [makeIssue()];
    db.prFixes = [];

    const result = await inspectIssueOwnership("issue-1", { live: false });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected the issue to be found");

    const where = prFixFindFirst.mock.calls[0]?.[0]?.where;
    expect(where.repo).toBe("org/repo");
    expect(result.evidence.openPrFix).toBe(false);
  });

  it("folds only the queue lookup, never the forge label read", async () => {
    db.issues = [makeIssue()];
    db.prFixes = [makePrFixRow()];

    const result = await inspectIssueOwnership("issue-1", { live: true });

    expect(result.found).toBe(true);
    if (!result.found) throw new Error("expected the issue to be found");

    // The forge is case-insensitive but canonical: the live read keeps the
    // cached casing so the API path matches the repository exactly.
    expect(getLiveIssueLabels).toHaveBeenCalledWith("Org/Repo", 42);

    // Only the queue's identity is folded.
    const where = prFixFindFirst.mock.calls[0]?.[0]?.where;
    expect(where.repo).toBe("org/repo");
    expect(result.issue.repoFullName).toBe("Org/Repo");
    expect(result.evidence.openPrFix).toBe(true);
  });
});
