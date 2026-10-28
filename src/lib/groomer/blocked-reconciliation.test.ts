import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  BLOCKED_RECONSIDER_WINDOW_HOURS,
  DEFAULT_BLOCKED_RECONCILIATION_BUDGET,
  evaluateParkedBlock,
  GROOMER_OWNED_PARK,
  hasTypedDependencyAnchor,
  isGroomerOwnedPark,
  makePrismaBlockedReconciliationStore,
  NO_TYPED_DEPENDENCY_ANCHOR,
  OPERATOR_STATUS_AUDIT_ACTIONS,
  OPERATOR_STATUS_SOURCES,
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
  /** The actor that wrote the last verdict on the row. */
  groomedBy?: string | null;
  /** The issue has an operator-sourced status_changed lifecycle event. */
  operatorStatusEvent?: boolean;
  /** The issue has an operator-sourced status audit row (success only). */
  operatorStatusAudit?: boolean;
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
    operatorStatusEvent: false,
    operatorStatusAudit: false,
    admissionOverrideId: null,
    groomingRetryAfter: null,
    groomingStaleAt: null,
    ...overrides,
  };
}

/**
 * A legacy park: no verdict marker (the verdict that wrote it omitted the
 * action), the hosted groomer judged it, and no operator ever held it.
 */
function legacyPark(overrides: Partial<FakeRow> = {}): FakeRow {
  return parkedRow({
    nextGroomingAction: null,
    groomedBy: "hosted-groomer",
    groomedAt: new Date(NOW.getTime() - 25 * HOUR),
    ...overrides,
  });
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
      // the groomer itself issued (the verdict marker, or a legacy park the
      // hosted groomer judged that no operator has held since), no admission
      // override, retry backoff elapsed, not already stale, and not a row the
      // freshness pass owns (it has a typed dependency anchor).
      const eligible = store.rows
        .filter((r) => r.state === "open" && r.blockedReason != null)
        .filter((r) =>
          isGroomerOwnedPark(
            {
              nextGroomingAction: r.nextGroomingAction ?? null,
              groomedBy: r.groomedBy ?? null,
              groomedAt: r.groomedAt,
              labels: r.labels,
            },
            {
              operatorStatusEvent: r.operatorStatusEvent ?? false,
              operatorStatusAudit: r.operatorStatusAudit ?? false,
            },
          ),
        )
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
    // Regression: a bare "#5" key could never match the fully qualified open
    // set, so an open same-repo prerequisite would have read as closed.
    const open = evaluateParkedBlock(row, "org/repo", new Set(["org/repo#5"]), NOW);
    expect(open).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });
    expect(open.action === "mark" && open.detail).toContain("open now: org/repo#5");
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

  it("reconsiders a legacy explained block while one body prerequisite is still open", () => {
    // The review finding: an anchorless row is not excluded by an open
    // candidate. The pass cannot tell which dependency the verdict relied on,
    // so an open prerequisite does not prove the park holds — the bounded
    // re-groom re-reads the dependency state and re-decides. It never
    // unblocks the issue on its own.
    const row = parkedRow({ body: "Depends on #5 and #6.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) });
    const decision = evaluateParkedBlock(row, "org/repo", new Set(["org/repo#6"]), NOW);
    expect(decision).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });
    expect(decision.action === "mark" && decision.detail).toContain("open now: org/repo#6");
    expect(decision.action === "mark" && decision.detail).toContain("24h");
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

  it("records which candidates are still open in the audit detail, across repos", () => {
    const row = parkedRow({ body: "Depends on other/repo#7.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) });
    // A mixed open set: the cross-repo prerequisite is open, and the detail
    // names it, so the operator sees the prerequisite the fresh verdict must
    // weigh.
    const open = evaluateParkedBlock(row, "org/repo", new Set(["other/repo#7", "org/repo#9"]), NOW);
    expect(open).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });
    expect(open.action === "mark" && open.detail).toContain("open now: other/repo#7");
    // The same key absent (closed in its own repo) counts as closed even while
    // an unrelated same-repo issue is open.
    const decision = evaluateParkedBlock(row, "org/repo", new Set(["org/repo#9"]), NOW);
    expect(decision).toMatchObject({ action: "mark", reasons: ["evidence_incomplete"] });
    expect(decision.action === "mark" && decision.detail).toContain("other/repo#7");
    expect(decision.action === "mark" && decision.detail).toContain("no candidate dependency is open");
  });

  it("never unblocks on a new open body dependency the row lacked", () => {
    const row = parkedRow({
      body: "Depends on #5 and #11.",
      groomedAt: new Date(NOW.getTime() - HOUR),
      groomedRunId: "gr-1",
      groomedIssueFingerprint: "fp",
    });
    // Inside the reconsideration window the row is deferred, not marked: a
    // stale mark is a re-groom, never an unblock.
    expect(evaluateParkedBlock(row, "org/repo", new Set(["org/repo#11"]), NOW)).toEqual({
      action: "defer",
      reason: "dependency evidence incomplete; reconsideration window not elapsed",
    });
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
    // The row still rotates out of the capped slice: a row whose mark lost the
    // race cannot pin the head of the order and starve a later parked issue.
    expect(store.considered).toEqual(["issue-1"]);
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
    // Rows 1 and 2 are worker-owned: the store hands them to the pass, but the
    // pass skips them in memory, so it can make no progress on them.
    // Before the rotation stamp they held the capped slice on every pass (they
    // are the oldest never-considered rows), so row 3 was never reconsidered.
    const store = fakeStore([
      parkedRow({ id: "issue-1", number: 1, labels: ["status/blocked", "status/in-progress"], groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
      parkedRow({ id: "issue-2", number: 2, title: "Dependency dashboard", groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
      parkedRow({ id: "issue-3", number: 3, body: "Depends on #7.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
    ]);
    const budget = { maxIssuesPerRepo: 2 };

    const first = await runGroomingBlockedReconciliationPass([REPO], store, budget, () => NOW, BLOCKED_RECONSIDER_WINDOW_HOURS);
    expect(first.markedStale).toEqual([]);
    expect(first.issuesConsidered).toBe(0);

    // The next pass reads the least-recently-considered rows first, so the
    // never-considered row 3 is in the slice and is reconsidered.
    const second = await runGroomingBlockedReconciliationPass([REPO], store, budget, () => NOW, BLOCKED_RECONSIDER_WINDOW_HOURS);
    expect(second.markedStale).toEqual([{ repo: "org/repo", issueNumber: 3, reasons: ["evidence_incomplete"] }]);
  });

  it("reconsiders an anchorless parked block whose prerequisite is still open", async () => {
    // The review finding at the pass level: an open candidate must not
    // suppress the bounded reconsideration. The row is still parked when the
    // mark lands (the mark only schedules a re-groom) and the open
    // prerequisite rides into the audit detail.
    const store = fakeStore(
      [parkedRow({ id: "issue-1", number: 1, body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) })],
      new Set(["org/repo#5"]),
    );
    const result = await pass(store);
    expect(result.markedStale).toEqual([{ repo: "org/repo", issueNumber: 1, reasons: ["evidence_incomplete"] }]);
    expect(store.stale.get("issue-1")?.detail).toContain("open now: org/repo#5");
    expect(store.audits).toEqual(["issue-1"]);
  });

  it("stamps every row the scan reached, including the rows the pass skips", async () => {
    // A worker-owned row and a renovate row are skipped in memory. They are
    // still stamped: a row the pass cannot act on must not pin the head of
    // the order forever and starve a later parked issue.
    const store = fakeStore([
      parkedRow({ id: "issue-1", number: 1, labels: ["status/blocked", "status/in-progress"] }),
      parkedRow({ id: "issue-2", number: 2, title: "Dependency dashboard" }),
    ]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.considered).toEqual(["issue-1", "issue-2"]);
  });

  it("does not reach a row that is not a park: no blocked column, no park to reconsider", async () => {
    // The cached block reason can outlive the card's column (a human moved the
    // card, or the label write never landed). A row that is not on the blocked
    // column is not a park, so the pass never selects it and never spends the
    // scan cap on it.
    const store = fakeStore([
      parkedRow({ id: "issue-1", number: 1, labels: ["status/backlog"], groomedAt: new Date(NOW.getTime() - 25 * HOUR) }),
    ]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.considered).toEqual([]);
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

describe("legacy parks (a park without the verdict marker)", () => {
  it("reconsiders a legacy park the hosted groomer judged and no operator has held", async () => {
    // The review finding: a park whose verdict omitted the action marker
    // carries no marker at all, so the marker-only scan stranded it forever.
    // The legacy branch reconsiders it under the same bounded window.
    const store = fakeStore([legacyPark({ body: "Depends on #5." })]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(1);
    expect(result.markedStale).toEqual([{ repo: "org/repo", issueNumber: 1, reasons: ["evidence_incomplete"] }]);
    expect(store.stale.get("issue-1")?.reasons).toEqual(["evidence_incomplete"]);
    expect(store.audits).toEqual(["issue-1"]);
  });

  it("never revisits a legacy park an operator held through the status route", async () => {
    // The status route retires the marker and writes a `status_changed`
    // lifecycle event: a deliberate human hold.
    const store = fakeStore([legacyPark({ operatorStatusEvent: true })]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.stale.size).toBe(0);
    expect(store.audits).toEqual([]);
  });

  it("never revisits a legacy park an operator re-blocked without a label move", async () => {
    // The same-status re-block: the status label did not move, so no
    // lifecycle event was recorded — only the status route's successful
    // `set_status` audit row proves the hold.
    const store = fakeStore([legacyPark({ operatorStatusAudit: true })]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.stale.size).toBe(0);
    expect(store.audits).toEqual([]);
  });

  it("never revisits a legacy park the hosted groomer did not judge", async () => {
    // Never groomed by the hosted groomer: the row is not a groomer-owned
    // park, whatever its blocked reason says.
    const store = fakeStore([legacyPark({ groomedBy: null })]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.stale.size).toBe(0);
  });

  it("never revisits a legacy park a human groomed", async () => {
    // The manual groom route stamps the operator actor, not the hosted
    // groomer: a human's own park is a human's decision. The status route
    // stamps its actor the same way, so a hold it wrote is excluded by that
    // stamp alone — atomically with the hold, which no audit row can promise.
    const store = fakeStore([legacyPark({ groomedBy: "operator" })]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.stale.size).toBe(0);
  });

  it("never revisits a marked park a human moved off the blocked column", async () => {
    // A board drag off the blocked column is a human decision about the card:
    // the cached block reason is left behind, but the card is no longer a
    // park, so the pass must not re-groom it over the human's move.
    const store = fakeStore([parkedRow({ labels: ["status/ready"], groomedAt: new Date(NOW.getTime() - 25 * HOUR) })]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.stale.size).toBe(0);
  });

  it("never revisits a legacy park that is no longer on the blocked column", async () => {
    // The legacy branch has no marker to prove the card is still parked, so
    // the blocked label is its positive evidence.
    const store = fakeStore([legacyPark({ labels: ["status/ready"] })]);
    const result = await pass(store);
    expect(result.issuesConsidered).toBe(0);
    expect(result.markedStale).toEqual([]);
    expect(store.stale.size).toBe(0);
  });

  it("defers a legacy park whose reconsideration window has not elapsed", async () => {
    // The legacy branch is reconsidered on the same bounded window as a
    // marked park: at most one re-groom per window.
    const store = fakeStore([legacyPark({ groomedAt: new Date(NOW.getTime() - HOUR) })]);
    const result = await pass(store);
    expect(result.markedStale).toEqual([]);
    expect(result.deferred).toEqual([
      { repo: "org/repo", issueNumber: 1, reason: "dependency evidence incomplete; reconsideration window not elapsed" },
    ]);
    expect(store.stale.size).toBe(0);
  });

  it("still reconsiders a marked park", async () => {
    // The modern branch is unchanged by the legacy branch.
    const store = fakeStore([parkedRow({ body: "Depends on #5.", groomedAt: new Date(NOW.getTime() - 25 * HOUR) })]);
    const result = await pass(store);
    expect(result.markedStale).toEqual([{ repo: "org/repo", issueNumber: 1, reasons: ["evidence_incomplete"] }]);
  });
});

describe("isGroomerOwnedPark", () => {
  const park = {
    nextGroomingAction: null,
    groomedBy: "hosted-groomer",
    groomedAt: new Date("2020-01-01T00:00:00.000Z"),
    labels: ["status/blocked"],
  };
  const noEvidence = { operatorStatusEvent: false, operatorStatusAudit: false };

  it("accepts a marked park whatever else the row says", () => {
    expect(isGroomerOwnedPark({ ...park, nextGroomingAction: "mark_blocked" }, noEvidence)).toBe(true);
  });

  it("accepts a legacy park without operator evidence", () => {
    expect(isGroomerOwnedPark(park, noEvidence)).toBe(true);
  });

  it("rejects a legacy park with operator evidence", () => {
    expect(isGroomerOwnedPark(park, { operatorStatusEvent: true, operatorStatusAudit: false })).toBe(false);
    expect(isGroomerOwnedPark(park, { operatorStatusEvent: false, operatorStatusAudit: true })).toBe(false);
  });

  it("rejects a legacy park the hosted groomer did not judge", () => {
    expect(isGroomerOwnedPark({ ...park, groomedBy: null }, noEvidence)).toBe(false);
    expect(isGroomerOwnedPark({ ...park, groomedBy: "operator" }, noEvidence)).toBe(false);
  });

  it("rejects a legacy park that was never judged or is no longer parked", () => {
    expect(isGroomerOwnedPark({ ...park, groomedAt: null }, noEvidence)).toBe(false);
    expect(isGroomerOwnedPark({ ...park, labels: ["status/ready"] }, noEvidence)).toBe(false);
  });

  it("rejects a marked park that is no longer on the blocked column", () => {
    // The marker alone is not enough: a card a human moved off the blocked
    // column keeps the cached block reason, and the pass must leave it be.
    expect(isGroomerOwnedPark({ ...park, nextGroomingAction: "mark_blocked", labels: ["status/ready"] }, noEvidence)).toBe(
      false,
    );
  });

  it("rejects a park whose marker is neither the groomer's nor absent", () => {
    // A manual groom writes a prose marker: a human's decision, never this
    // pass's business.
    expect(isGroomerOwnedPark({ ...park, nextGroomingAction: "Resolve the blocking dependency" }, noEvidence)).toBe(false);
  });
});

describe("makePrismaBlockedReconciliationStore", () => {
  it("pins the groomer-owned park predicate to the marker and the legacy branch", () => {
    // The clause shape is the rule: the marker branch (the verdict marker and
    // the card still on the blocked column), and the legacy branch with every
    // part of it spelled out — no marker, the hosted groomer's verdict, an
    // actual verdict, the blocked column, and no operator evidence (a status
    // route lifecycle event or a successful status audit row). The status
    // route is the only writer of an operator's block reason, so it is the
    // only operator evidence: a board move and a manual groom change the
    // card's column or write a prose marker, and the column check covers the
    // first.
    expect(OPERATOR_STATUS_SOURCES).toEqual(["api:status"]);
    expect(OPERATOR_STATUS_AUDIT_ACTIONS).toEqual(["set_status"]);
    expect(GROOMER_OWNED_PARK).toEqual({
      OR: [
        {
          AND: [{ nextGroomingAction: "mark_blocked" }, { labels: { has: "status/blocked" } }],
        },
        {
          AND: [
            { nextGroomingAction: null },
            { groomedBy: "hosted-groomer" },
            { groomedAt: { not: null } },
            { labels: { has: "status/blocked" } },
            {
              lifecycleEvents: {
                none: { kind: "status_changed", source: { in: ["api:status"] } },
              },
            },
            { auditLogs: { none: { action: { in: ["set_status"] }, success: true } } },
          ],
        },
      ],
    });
  });

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
    // The scan selects groomer-owned parks: the verdict marker, or a legacy
    // park the hosted groomer judged that no operator has held since. The
    // predicate rides in the `AND` array — as a sibling `OR` it would
    // overwrite the retry-backoff clause.
    expect(captured.where?.AND).toContainEqual(GROOMER_OWNED_PARK);
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

  it("pins the production stale mark to the same fences the scan filters on", async () => {
    const updates: Array<{ where: Record<string, unknown>; data: unknown }> = [];
    const client = {
      issue: {
        updateMany: async (args: { where: Record<string, unknown>; data: unknown }) => {
          updates.push(args);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;
    const store = makePrismaBlockedReconciliationStore(client);
    const at = new Date("2026-10-01T12:00:00.000Z");
    const wrote = await store.markStale(parkedRow({ id: "issue-1" }), { reasons: ["evidence_incomplete"], detail: "why" }, at);
    expect(wrote).toBe(true);
    // The write lands only while the read still describes the issue: same
    // baseline, no stale mark yet, still parked, still a groomer-owned park,
    // not operator held and not in a retry backoff — the same fences the scan
    // query filters on, so the mark can never land on a row the scan would
    // not have selected.
    expect(updates).toEqual([
      {
        where: {
          id: "issue-1",
          groomedRunId: null,
          groomingStaleAt: null,
          blockedReason: { not: null },
          admissionOverrideId: null,
          // The retry backoff and the park-ownership predicate are both
          // `OR`s, so they are separate elements of one `AND` array — two
          // `OR` keys in one `where` would overwrite each other.
          AND: [
            { OR: [{ groomingRetryAfter: null }, { groomingRetryAfter: { lte: at } }] },
            GROOMER_OWNED_PARK,
          ],
        },
        data: { groomingStaleAt: at, groomingStaleReasons: ["evidence_incomplete"], groomingStaleDetail: "why" },
      },
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
    // next pass. The stamp shares the scan's park-ownership predicate.
    expect(updates).toEqual([
      {
        where: { id: { in: ["issue-1", "issue-2"] }, blockedReason: { not: null }, AND: [GROOMER_OWNED_PARK] },
        data: { blockedReconciliationAt: at },
      },
    ]);
  });
});
