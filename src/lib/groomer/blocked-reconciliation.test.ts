import { describe, expect, it } from "vitest";
import {
  BLOCKED_RECONSIDER_WINDOW_HOURS,
  DEFAULT_BLOCKED_RECONCILIATION_BUDGET,
  evaluateParkedBlock,
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
    blockedReason: "waiting on #5",
    nextGroomingAction: "mark_blocked",
    admissionOverrideId: null,
    groomingRetryAfter: null,
    groomingStaleAt: null,
    ...overrides,
  };
}

/** The real store excludes baselined rows with a non-empty open-blocker anchor. */
function baselinedWithAnchor(row: FakeRow): boolean {
  return row.groomedIssueFingerprint != null && row.groomedOpenBlockerKeys.length > 0;
}

interface FakeStore extends BlockedReconciliationStore {
  rows: FakeRow[];
  stale: Map<string, { reasons: string[]; detail: string }>;
  audits: string[];
  openKeys: Set<string>;
  failOpenKeys: boolean;
  raceOnMark: boolean;
  takeSeen: number | null;
}

function fakeStore(rows: FakeRow[], openKeys: Set<string> = new Set()): FakeStore {
  const store: FakeStore = {
    rows,
    stale: new Map(),
    audits: [],
    openKeys,
    failOpenKeys: false,
    raceOnMark: false,
    takeSeen: null,
    async findParkedBlockedIssues(_repositoryId, take) {
      store.takeSeen = take;
      // Mirror the real store's where clause: open, explained block, a park
      // the groomer itself issued (an operator hold retires
      // nextGroomingAction), no admission override, retry backoff elapsed,
      // not already stale, and not a baselined row the freshness pass owns.
      return store.rows
        .filter((r) => r.state === "open" && r.blockedReason != null)
        .filter((r) => r.nextGroomingAction === "mark_blocked")
        .filter((r) => r.admissionOverrideId == null)
        .filter((r) => r.groomingRetryAfter == null || r.groomingRetryAfter.getTime() <= NOW.getTime())
        .filter((r) => !store.stale.has(r.id))
        .filter((r) => !baselinedWithAnchor(r))
        .slice(0, take);
    },
    async findOpenIssueKeys() {
      if (store.failOpenKeys) throw new Error("db down");
      return store.openKeys;
    },
    async markStale(row, mark) {
      // CAS emulation: a mark lands only while the row is still unmarked and
      // the run that groomed it has not changed since the read.
      if (store.raceOnMark || store.stale.has(row.id)) return false;
      store.stale.set(row.id, { reasons: [...mark.reasons], detail: mark.detail });
      return true;
    },
    async recordAudit(_repo, row) {
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

  it("keeps a bounded 24h treadmill for a dependency Dispatch cannot see (untracked repo)", () => {
    // An untracked repo is never in the cached open set, so its prerequisite
    // always reads closed; the bounded window keeps the cost at one re-groom
    // per window instead of stranding or looping.
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
