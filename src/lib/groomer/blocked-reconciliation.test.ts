import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  BLOCKED_RECONSIDER_WINDOW_HOURS,
  DEFAULT_BLOCKED_RECONCILIATION_BUDGET,
  evaluateParkedBlock,
  hasTypedDependencyAnchor,
  makePrismaBlockedReconciliationStore,
  NO_TYPED_DEPENDENCY_ANCHOR,
  runGroomingBlockedReconciliationPass,
  type BlockedReconciliationStore,
  type ParkedBlockedIssueRow,
} from "./blocked-reconciliation";

const REPO = { id: "repo-1", fullName: "org/repo" };
const NOW = new Date("2026-10-01T12:00:00.000Z");
const HOUR = 3_600_000;

/**
 * Columns the real store's where clause filters on that the pass's row shape
 * does not carry; the fake store mirrors that where clause so the pass-level
 * tests prove the pass respects it.
 */
interface Extra {
  blockedReason?: string | null;
  nextGroomingAction?: string | null;
  admissionOverrideId?: string | null;
  groomingRetryAfter?: Date | null;
  groomingStaleAt?: Date | null;
}
type FakeRow = ParkedBlockedIssueRow & Extra;

function parkedRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "issue-1",
    number: 1,
    title: "Fix it",
    body: null,
    state: "open",
    labels: ["status/blocked", "priority/p1"],
    nativeBlockedBy: [],
    groomedAt: null,
    groomedRunId: null,
    groomedIssueFingerprint: null,
    groomedDependencyKeys: [],
    groomedOpenBlockerKeys: [],
    blockedReconciliationAt: null,
    blockedReason: "waiting on #5",
    nextGroomingAction: "mark_blocked",
    admissionOverrideId: null,
    groomingRetryAfter: null,
    groomingStaleAt: null,
    ...overrides,
  };
}

interface FakeStore extends BlockedReconciliationStore {
  rows: FakeRow[];
  stale: Map<string, { reasons: string[]; detail: string }>;
  audits: string[];
  openKeys: Set<string>;
  failOpenKeys: boolean;
  raceOnMark: boolean;
  failMarkStale: boolean;
  failConsidered: boolean;
  takeSeen: number | null;
  considered: string[];
}

function fakeStore(rows: FakeRow[], openKeys: Set<string> = new Set()): FakeStore {
  const store: FakeStore = {
    rows,
    stale: new Map(),
    audits: [],
    openKeys,
    failOpenKeys: false,
    raceOnMark: false,
    failMarkStale: false,
    failConsidered: false,
    takeSeen: null,
    considered: [],
    async findParkedBlockedIssues(_repositoryId, take) {
      store.takeSeen = take;
      // Mirror the real store's where clause: open, explained block, a park
      // the groomer itself issued (an operator hold retires
      // nextGroomingAction), no admission override, retry backoff elapsed,
      // not already stale, and not a row the freshness pass owns (it has a
      // typed dependency anchor).
      const eligible = store.rows
        .filter((r) => r.state === "open" && r.blockedReason != null)
        .filter((r) => r.nextGroomingAction === "mark_blocked")
        .filter((r) => r.admissionOverrideId == null)
        .filter((r) => r.groomingRetryAfter == null || r.groomingRetryAfter.getTime() <= NOW.getTime())
        .filter((r) => !store.stale.has(r.id))
        .filter((r) => !hasTypedDependencyAnchor(r));
      // Mirror the real store's order: least-recently-considered first (NULL =
      // never considered), then never-groomed first, then issue number.
      const ordered = [...eligible].sort((a, b) => {
        const consideredA = a.blockedReconciliationAt?.getTime() ?? -Infinity;
        const consideredB = b.blockedReconciliationAt?.getTime() ?? -Infinity;
        if (consideredA !== consideredB) return consideredA - consideredB;
        const groomedA = a.groomedAt?.getTime() ?? -Infinity;
        const groomedB = b.groomedAt?.getTime() ?? -Infinity;
        if (groomedB !== groomedA) return groomedA - groomedB;
        return a.number - b.number;
      });
      return ordered.slice(0, take);
    },
    async findOpenIssueKeys() {
      if (store.failOpenKeys) throw new Error("db down");
      return store.openKeys;
    },
    async markStale(row, mark) {
      // CAS emulation: a mark lands only while the row is still unmarked and
      // the run that groomed it has not changed since the read.
      if (store.failMarkStale) throw new Error("db down");
      if (store.raceOnMark || store.stale.has(row.id)) return false;
      store.stale.set(row.id, { reasons: [...mark.reasons], detail: mark.detail });
      return true;
    },
    async recordConsidered(rows, at) {
      if (store.failConsidered) throw new Error("db down");
      store.considered.push(...rows.map((row) => row.id));
      for (const row of rows) row.blockedReconciliationAt = at;
    },    async recordAudit(_repo, row) {
      store.audits.push(row.id);
    },
  };
  return store;
}

function pass(store: FakeStore) {
  return runGroomingBlockedReconciliationPass(
    [REPO],
    store,
    DEFAULT_BLOCKED_RECONCILIATION_BUDGET,
    () => NOW,
    BLOCKED_RECONSIDER_WINDOW_HOURS,
  );
}

describe("parkedBlockCandidateKeys", () => {
  it("fully qualifies same-repo native blocked-by refs", () => {
    const row = parkedRow({ nativeBlockedBy: ["org/repo#5", "other/repo#9"], groomedAt: new Date(NOW.getTime() - 25 * HOUR) });
    // A still-open native prerequisite keeps the park (regression: a bare
    // "#5" key could never match the fully qualified open set).
    expect(evaluateParkedBlock(row, "org/repo", new Set(["org/repo#5"]), NOW)).toEqual({ action: "none" });
    expect(evaluateParkedBlock(row, "org/repo", new Set(["other/repo#9"]), NOW)).toEqual({ action: "none" });
    const closed = evaluateParkedBlock(row, "org/repo", new Set(), NOW);
    expect(closed).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });
    expect(closed.action === "mark" && closed.detail).toContain("org/repo#5");
    expect(closed.action === "mark" && closed.detail).toContain("other/repo#9");
  });
});

describe("evaluateParkedBlock", () => {
  it("reconsiders a legacy explained block (no baseline) whose body prerequisites all closed", () => {
    // The real legacy shape: never baselined, so the freshness pass never saw
    // it and no dependency anchor was ever recorded.
    const row = parkedRow({ body: "Depends on #5 and #6.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const decision = evaluateParkedBlock(row, "org/repo", new Set(), NOW);
    expect(decision).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });
    expect(decision.action === "mark" && decision.detail).toContain("org/repo#5");
    expect(decision.action === "mark" && decision.detail).toContain("org/repo#6");
  });

  it("leaves a legacy explained block parked while one body prerequisite is still open", () => {
    const row = parkedRow({ body: "Depends on #5 and #6.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) });
    expect(evaluateParkedBlock(row, "org/repo", new Set(["org/repo#6"]), NOW)).toEqual({ action: "none" });
  });

  it("defers evidence-incomplete reconsideration inside the window and marks it after", () => {
    // The load-bearing prerequisite lives in the model's assessment, not the
    // body: a baseline exists but its anchor is empty.
    const row = parkedRow({
      body: "Depends on #5.",
      groomedAt: new Date(NOW.getTime() - HOUR),
      groomedRunId: "gr-1",
      groomedIssueFingerprint: "fp",
      groomedDependencyKeys: [],
      groomedOpenBlockerKeys: [],
    });
    const within = evaluateParkedBlock(row, "org/repo", new Set(), NOW);
    expect(within).toEqual({ action: "defer", reason: "dependency evidence incomplete; reconsideration window not elapsed" });

    const after = evaluateParkedBlock(
      { ...row, groomedAt: new Date(NOW.getTime() - 25 * HOUR) },
      "org/repo",
      new Set(),
      NOW,
    );
    expect(after).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });
    expect(after.action === "mark" && after.detail).toContain("24h");
  });

  it("marks a never-groomed evidence-incomplete row immediately", () => {
    const row = parkedRow({ body: "Depends on #5." });
    const decision = evaluateParkedBlock(row, "org/repo", new Set(), NOW);
    expect(decision.action).toBe("mark");
    expect(decision.action === "mark" && decision.reasons).toEqual(["evidence_incomplete"]);
    expect(decision.action === "mark" && decision.detail).toContain("org/repo#5");
  });

  it("names the fallback in the detail when no candidates could be derived", () => {
    const row = parkedRow({ body: "Blocked on the vendor rollout.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const decision = evaluateParkedBlock(row, "org/repo", new Set(), NOW);
    expect(decision.action).toBe("mark");
    expect(decision.action === "mark" && decision.reasons).toEqual(["evidence_incomplete"]);
    expect(decision.action === "mark" && decision.detail).toContain(
      "no dependency candidates could be derived from the body, native blocked-by list or saved baseline",
    );
  });

  it("never marks a row with a typed dependency anchor", () => {
    // The anchor is the recorded dependency evidence: the freshness pass owns
    // the row and compares its open blockers, so this pass must not re-groom
    // it on a window.
    const row = parkedRow({
      body: "Depends on #5.",
      groomedRunId: "gr-1",
      groomedIssueFingerprint: "fp",
      groomedDependencyKeys: ["org/repo#5"],
      groomedOpenBlockerKeys: [],
      groomedAt: new Date(NOW.getTime() - 25 * HOUR),
    });
    expect(evaluateParkedBlock(row, "org/repo", new Set(), NOW)).toEqual({ action: "none" });
  });

  it("counts only keys present in the open set, across repos", () => {
    const row = parkedRow({ body: "Depends on other/repo#7.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) });
    // A mixed open set: the cross-repo prerequisite open means nothing changed.
    expect(evaluateParkedBlock(row, "org/repo", new Set(["other/repo#7", "org/repo#9"]), NOW)).toEqual({ action: "none" });
    // The same key absent (closed in its own repo) counts as closed even while
    // an unrelated same-repo issue is open.
    const decision = evaluateParkedBlock(row, "org/repo", new Set(["org/repo#9"]), NOW);
    expect(decision).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });
    expect(decision.action === "mark" && decision.detail).toContain("other/repo#7");
  });

  it("never unblocks on a new open body dependency the row lacked", () => {
    const row = parkedRow({
      body: "Depends on #5 and #11.",
      groomedAt: new Date(NOW.getTime() - HOUR),
      groomedRunId: "gr-1",
      groomedIssueFingerprint: "fp",
    });
    expect(evaluateParkedBlock(row, "org/repo", new Set(["org/repo#11"]), NOW)).toEqual({ action: "none" });
  });

  it("treats closed-as-not-planned as closed (the key is simply absent from the open set)", () => {
    const row = parkedRow({ body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const decision = evaluateParkedBlock(row, "org/repo", new Set(), NOW);
    expect(decision).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });
    expect(decision.action === "mark" && decision.detail).toContain("org/repo#5");
  });

  it("keeps a bounded 24h window for an anchorless dependency Dispatch cannot see (untracked repo)", () => {
    // An untracked repo is never in the cached open set, so its prerequisite
    // always reads closed; the bounded window keeps the cost at one re-groom
    // per window instead of stranding or looping. The row is anchorless: a
    // recorded anchor would make it the freshness pass's territory.
    const row = parkedRow({
      body: "Depends on untracked/repo#3.",
      groomedAt: new Date(NOW.getTime() - 25 * HOUR),
    });
    const decision = evaluateParkedBlock(row, "org/repo", new Set(), NOW);
    expect(decision).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });

    const recent = evaluateParkedBlock({ ...row, groomedAt: new Date(NOW.getTime() - HOUR) }, "org/repo", new Set(), NOW);
    expect(recent).toEqual({ action: "defer", reason: "dependency evidence incomplete; reconsideration window not elapsed" });
  });
});

describe("runGroomingBlockedReconciliationPass", () => {
  it("marks, records and audits a reconsiderable parked block", async () => {
    const store = fakeStore([
      parkedRow({ body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
    ]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(1);
    expect(result.markedStale).toEqual([{ repo: "org/repo", issueNumber: 1, reasons: ["evidence_incomplete"] }]);
    expect(store.stale.get("issue-1")?.reasons).toEqual(["evidence_incomplete"]);
    expect(store.audits).toEqual(["issue-1"]);
    expect(result.warnings).toEqual([]);
  });

  it("defers evidence-incomplete rows inside the window without writing", async () => {
    const store = fakeStore([
      parkedRow({ body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - HOUR), groomedRunId: "gr-1", groomedIssueFingerprint: "fp" }),
    ]);
    const result = await pass(store);
    expect(result.markedStale).toEqual([]);
    expect(result.deferred).toEqual([
      { repo: "org/repo", issueNumber: 1, reason: "dependency evidence incomplete; reconsideration window not elapsed" },
    ]);
    expect(store.stale.size).toBe(0);
    expect(store.audits).toEqual([]);
  });

  it("skips operator and worker blocks written through the status route", async () => {
    // The status route retires nextGroomingAction when it writes a deliberate
    // blockedReason: a human hold, never reconsidered by this pass.
    const store = fakeStore([
      parkedRow({ id: "issue-1", number: 1, nextGroomingAction: null }),
      parkedRow({ id: "issue-2", number: 2, nextGroomingAction: "mark_not_ready" }),
      parkedRow({ id: "issue-3", number: 3 }),
    ]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(1);
    expect(result.markedStale).toEqual([{ repo: "org/repo", issueNumber: 3, reasons: ["evidence_incomplete"] }]);
  });

  it("skips baselined rows with a typed anchor: the freshness pass owns them", async () => {
    const store = fakeStore([
      parkedRow({
        id: "issue-1",
        number: 1,
        groomedRunId: "gr-1",
        groomedIssueFingerprint: "fp",
        groomedDependencyKeys: ["org/repo#5"],
        groomedOpenBlockerKeys: ["org/repo#5"],
      }),
      parkedRow({ id: "issue-2", number: 2 }),
    ]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(1);
    expect(result.markedStale).toEqual([{ repo: "org/repo", issueNumber: 2, reasons: ["evidence_incomplete"] }]);
  });

  it("skips an anchored row whose recorded open blockers are empty: no re-groom treadmill", async () => {
    // The dependency was unknown (or already closed) at verdict time, so the
    // open-blocker set is empty while the anchor stands. Nothing about the
    // dependency changed, so the row must not be re-groomed every window.
    const store = fakeStore([
      parkedRow({
        id: "issue-1",
        number: 1,
        groomedRunId: "gr-1",
        groomedIssueFingerprint: "fp",
        groomedDependencyKeys: ["org/repo#5"],
        groomedOpenBlockerKeys: [],
        groomedAt: new Date(NOW.getTime() - 25 * HOUR),
      }),
    ]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.stale.size).toBe(0);
    expect(store.audits).toEqual([]);
  });

  it("defers every row with a warning when the openness read fails, without throwing", async () => {
    const store = fakeStore([
      parkedRow({ body: "Depends on #5." }),
      parkedRow({ id: "issue-2", number: 2, body: "Depends on #6." }),
    ]);
    store.failOpenKeys = true;
    const result = await pass(store);
    expect(result.markedStale).toEqual([]);
    expect(result.deferred).toEqual([
      { repo: "org/repo", issueNumber: 1, reason: "openness check failed" },
      { repo: "org/repo", issueNumber: 2, reason: "openness check failed" },
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("openness check failed");
  });

  it("is idempotent across repeated passes over the same state", async () => {
    const store = fakeStore([parkedRow({ body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) })]);
    const first = await pass(store);
    expect(first.markedStale).toHaveLength(1);
    const second = await pass(store);
    expect(second.markedStale).toEqual([]);
    expect(second.issuesConsidered).toBe(0);
    expect(store.audits).toEqual(["issue-1"]);
  });

  it("drops the write when a concurrent groom changed the baseline since the read", async () => {
    const store = fakeStore([parkedRow({ body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) })]);
    store.raceOnMark = true;
    const result = await pass(store);
    expect(result.markedStale).toEqual([]);
    expect(store.audits).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("skips worker-owned statuses, renovate issues, future retry backoff and admission overrides", async () => {
    const store = fakeStore([
      parkedRow({ id: "issue-1", number: 1, labels: ["status/blocked", "status/in-progress"] }),
      parkedRow({ id: "issue-2", number: 2, title: "Dependency dashboard", labels: [] }),
      parkedRow({ id: "issue-3", number: 3, groomingRetryAfter: new Date(NOW.getTime() + HOUR) }),
      parkedRow({ id: "issue-4", number: 4, admissionOverrideId: "override-1" }),
      parkedRow({ id: "issue-5", number: 5, groomingRetryAfter: new Date(NOW.getTime() - HOUR) }),
    ]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(1);
    expect(result.markedStale).toEqual([
      { repo: "org/repo", issueNumber: 5, reasons: ["evidence_incomplete"] },
    ]);
  });

  it("considers at most the budget's rows per repo", async () => {
    const store = fakeStore([parkedRow(), parkedRow({ id: "issue-2", number: 2 }), parkedRow({ id: "issue-3", number: 3 })]);
    const result = await runGroomingBlockedReconciliationPass(
      [REPO],
      store,
      { maxIssuesPerRepo: 2 },
      () => NOW,
      BLOCKED_RECONSIDER_WINDOW_HOURS,
    );
    expect(store.takeSeen).toBe(2);
    expect(result.issuesConsidered).toBe(2);
  });

  it("rotates the capped slice so a row that cannot progress does not starve the tail", async () => {
    // Rows 1 and 2 wait on an open prerequisite: the pass can make no
    // progress on them. Before the rotation stamp they held the capped slice
    // on every pass, so row 3 — whose prerequisite closed — was never
    // reconsidered.
    const store = fakeStore(
      [
        parkedRow({ id: "issue-1", number: 1, body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
        parkedRow({ id: "issue-2", number: 2, body: "Depends on #6.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
        parkedRow({ id: "issue-3", number: 3, body: "Depends on #7.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
      ],
      new Set(["org/repo#5", "org/repo#6"]),
    );
    const budget = { maxIssuesPerRepo: 2 };

    const first = await runGroomingBlockedReconciliationPass([REPO], store, budget, () => NOW, BLOCKED_RECONSIDER_WINDOW_HOURS);
    expect(first.markedStale).toEqual([]);
    expect(first.issuesConsidered).toBe(2);

    // The next pass reads the least-recently-considered rows first, so the
    // never-considered row 3 is in the slice and its closed prerequisite is
    // noticed.
    const second = await runGroomingBlockedReconciliationPass([REPO], store, budget, () => NOW, BLOCKED_RECONSIDER_WINDOW_HOURS);
    expect(second.markedStale).toEqual([{ repo: "org/repo", issueNumber: 3, reasons: ["evidence_incomplete"] }]);
  });

  it("stamps every row the scan reached, including the rows the pass skips", async () => {
    // A worker-owned row and a renovate row are skipped in memory. They are
    // still stamped: a row the pass cannot act on must not pin the head of
    // the order forever and starve a later parked issue.
    const store = fakeStore([
      parkedRow({ id: "issue-1", number: 1, labels: ["status/blocked", "status/in-progress"] }),
      parkedRow({ id: "issue-2", number: 2, title: "Dependency dashboard", labels: [] }),
    ]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.considered).toEqual(["issue-1", "issue-2"]);
  });

  it("turns a failed consideration stamp into a warning without failing the pass", async () => {
    const store = fakeStore([parkedRow({ body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) })]);
    store.failConsidered = true;
    const result = await pass(store);
    // The stale mark still lands: the stamp is a rotation aid, not a fence.
    expect(result.markedStale).toEqual([{ repo: "org/repo", issueNumber: 1, reasons: ["evidence_incomplete"] }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("consideration stamp failed");
  });

  it("leaves the rows an error cut off before they were reached unstamped", async () => {
    // The mark write failed on the first row, so the pass never reached the
    // other two. Stamping them would push them to the back of the rotation
    // for a pass that never looked at them; unstamped, they lead the next
    // pass and are retried first.
    const store = fakeStore([
      parkedRow({ id: "issue-1", number: 1, body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
      parkedRow({ id: "issue-2", number: 2, body: "Depends on #6.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
    ]);
    store.failMarkStale = true;
    const result = await pass(store);
    expect(result.markedStale).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(store.considered).toEqual(["issue-1"]);
  });

  it("turns a repo-level failure into a warning and keeps the other repos", async () => {
    const healthy = fakeStore([
      parkedRow({ body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
    ]);
    const result = await runGroomingBlockedReconciliationPass(
      [
        { id: "repo-bad", fullName: "org/bad" },
        { id: "repo-1", fullName: "org/repo" },
      ],
      // The same fake serves both repos; make the first one blow up in find.
      {
        ...healthy,
        findParkedBlockedIssues: async (repositoryId, take) => {
          if (repositoryId === "repo-bad") throw new Error("db down");
          return healthy.findParkedBlockedIssues(repositoryId, take);
        },
      } as BlockedReconciliationStore,
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("org/bad");
    expect(result.markedStale).toEqual([{ repo: "org/repo", issueNumber: 1, reasons: ["evidence_incomplete"] }]);
  });
});

describe("makePrismaBlockedReconciliationStore", () => {
  it("pins the production selection to anchorless rows", async () => {
    let captured: { where?: { AND?: unknown[] }; orderBy?: unknown } = {};
    const client = {
      issue: {
        findMany: async (args: { where?: { AND?: unknown[] }; orderBy?: unknown }) => {
          captured = args;
          return [];
        },
      },
    } as unknown as PrismaClient;
    const store = makePrismaBlockedReconciliationStore(client);
    await store.findParkedBlockedIssues("repo-1", 10);
    // The store selects anchorless rows: a typed dependency anchor
    // (groomedDependencyKeys) makes a row the freshness pass's territory,
    // whatever its recorded open-blocker set says. The fake store mirrors this
    // clause, so the rule is pinned on both sides.
    expect(NO_TYPED_DEPENDENCY_ANCHOR).toEqual({ groomedDependencyKeys: { isEmpty: true } });
    expect(captured.where?.AND).toContainEqual(NO_TYPED_DEPENDENCY_ANCHOR);
  });

  it("pins the production scan order to least-recently-considered first", async () => {
    let captured: { orderBy?: unknown } = {};
    const client = {
      issue: {
        findMany: async (args: { orderBy?: unknown }) => {
          captured = args;
          return [];
        },
      },
    } as unknown as PrismaClient;
    const store = makePrismaBlockedReconciliationStore(client);
    await store.findParkedBlockedIssues("repo-1", 10);
    // The capped slice must rotate: the rotation stamp leads (NULL = never
    // considered first), then never-groomed legacy rows, then the issue
    // number as a deterministic tiebreak.
    expect(captured.orderBy).toEqual([
      { blockedReconciliationAt: { sort: "asc", nulls: "first" } },
      { groomedAt: { sort: "asc", nulls: "first" } },
      { number: "asc" },
    ]);
  });

  it("stamps the rows the scan reached in one bulk write", async () => {
    const updates: Array<{ where: unknown; data: unknown }> = [];
    const client = {
      issue: {
        updateMany: async (args: { where: unknown; data: unknown }) => {
          updates.push(args);
          return { count: 2 };
        },
      },
    } as unknown as PrismaClient;
    const store = makePrismaBlockedReconciliationStore(client);
    const rows = [parkedRow({ id: "issue-1" }), parkedRow({ id: "issue-2", number: 2 })];
    const at = new Date("2026-10-01T12:00:00.000Z");
    await store.recordConsidered(rows, at);
    // One write, scoped to rows that are still groomer-owned parked blocks: a
    // row that left the parked state meanwhile is not stamped and leads the
    // next pass.
    expect(updates).toEqual([
      {
        where: { id: { in: ["issue-1", "issue-2"] }, blockedReason: { not: null }, nextGroomingAction: "mark_blocked" },
        data: { blockedReconciliationAt: at },
      },
    ]);
  });
});
