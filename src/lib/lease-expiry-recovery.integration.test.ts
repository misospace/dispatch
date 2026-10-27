/**
 * The #1417 dead-claim recovery chain against a real PostgreSQL.
 *
 * Audit F1 (misospace/dispatch#1417): a canonical worker claims an issue —
 * a `Lease` row plus the `agent/<name>` label, and NO `AgentWork` row until
 * agent-work/start — and then crashes. The lease expires; the stale-work
 * sweep sees only AgentWork rows; the queue filters the issue out for every
 * other identity. Historically `releaseExpiredLeases` DELETED the expired
 * lease row, destroying the only Dispatch-side evidence, so the claim could
 * strand forever. The cleanup now tombstones the row instead, and this file
 * proves the full recovery chain the acceptance criterion names — dead
 * worker + missing AgentWork + expired lease + agent label:
 *
 *   1. `releaseExpiredLeases` tombstones the expired lease without touching
 *      its claim-epoch fence (claimToken/expiredAt/renewedAt), is idempotent,
 *      and never consumes a still-running `retryAfter` park (#1316/#1334).
 *   2. `reconcileOwnership` in AUDIT mode surfaces the tombstoned claim as an
 *      ABANDONED_CANDIDATE annotation (`disposition_expired` +
 *      `evidence_stale`) with zero forge writes and zero mutations.
  *   3. `reconcileOwnership` in ENFORCE mode ladders the same claim through
  *      the §8.2 confirmation ladder and releases it via the §8.7 protocol:
  *      the epoch CAS pins the tombstone, the forge delete removes exactly the
  *      claim label, and the Phase C settle consumes the tombstone row.
  *   4. ENFORCE never prunes a tombstone on the cached label mirror alone
  *      (#1417 review round 4): a cached pre-claim label set with a LIVE
  *      forge claim keeps its tombstone evidence and stays recoverable.
  *      The cache is non-authoritative — the claim route writes GitHub
  *      before the local mirror transaction.
 *
 * Opt-in via RUN_DB_INTEGRATION=1, NOT merely DATABASE_URL: that variable is
 * set workflow-wide in ci.yaml, so gating on it alone would make this file
 * run in the ordinary Tests job, which has no postgres service. `npm test`
 * on a laptop is unaffected; the database-integration CI job opts in
 * explicitly. GitHub access is mocked at the `@/lib/github` boundary (the
 * §8.5 status transition and the claim-gate are the only importers reached).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION === "1" && Boolean(url);
// Vitest's conditional-suite form: no explicit opt-in, no run.
const suite = enabled ? describe : describe.skip;

const REPO_PREFIX = "integration/lease-expiry-recovery-";

// A value that can never match a row: `Issue.id` is a cuid, so this literal
// is never a real id. It is the initial value of `issueId`, so any cleanup
// or assertion built from it before setup completed is a no-op instead of an
// unscoped store access — Prisma omits an `undefined` filter entirely, which
// would erase every row of those tables in the shared integration database.
const UNSET_ISSUE_ID = "integration-lease-expiry-unset-issue-id";

// The reconcile windows the assertions are computed against, pinned for
// determinism (defaults in src/lib/worker-ownership.ts /
// src/lib/ownership-reconciliation.ts).
const ACTIVE_MS = 15 * 60_000;
const LONG_RUN_GRACE_MS = 45 * 60_000;
const RECHECK_MS = 5 * 60_000;

// The tombstoned claim's evidence shape: claimed 3h ago, TTL elapsed 2.5h
// ago, nothing since. Freshest liveness evidence (3h) is far beyond the
// long-run grace, and expiredAt is well past the candidate scan's
// `expiredAt <= now - longRunGraceMs` cutoff.
const CLAIMED_AT_MS_AGO = 3 * 60 * 60_000;
const EXPIRED_AT_MS_AGO = 2.5 * 60 * 60_000;
const CLAIM_TOKEN = "tok-integration-dead-claim";

// Captured before any setup runs: the unset default must be a defined,
// non-matching value from the start, so a cleanup that ran before setup
// completed could never build an unscoped filter.
let issueId: string = UNSET_ISSUE_ID;
let issueSeeded = false;
// Secondary issues created by individual scenarios (e.g. the stale-mirror
// regression); cleaned with the same issue-scoped guards.
let extraIssueIds: string[] = [];

const { holder, githubCalls } = vi.hoisted(() => ({
  holder: { prisma: null as unknown },
  githubCalls: {
    add: [] as Array<{ repo: string; number: number; label: string }>,
    remove: [] as Array<{ repo: string; number: number; label: string }>,
    fetchIssue: [] as Array<{ repo: string; number: number }>,
  },
}));

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return holder.prisma;
  },
}));

// The reconciler's forge is injected; this mock only fences the module-level
// importers reached transitively (`transitionIssueStatus`'s label writes and
// the claim-gate's fetch), so the run stays repository-local and every
// GitHub-bound call is observable in an assertion.
vi.mock("@/lib/github", () => ({
  addIssueLabel: async (repo: string, number: number, label: string) => {
    githubCalls.add.push({ repo, number, label });
  },
  removeIssueLabel: async (repo: string, number: number, label: string) => {
    githubCalls.remove.push({ repo, number, label });
  },
  fetchIssue: async (repo: string, number: number) => {
    githubCalls.fetchIssue.push({ repo, number });
    return { labels: [] };
  },
}));

const { releaseExpiredLeases } = await import("./lease");
const { reconcileOwnership } = await import("./ownership-reconciliation");
const { withIssueMutationGuard } = await import("./issue-mutation-guard");

/** The injected forge adapter: an in-memory label set keyed per test. */
function makeForge(initial: string[]) {
  const state = { labels: [...initial] };
  return {
    state,
    async getLiveIssueLabels() {
      return [...state.labels];
    },
    async removeIssueLabel(_repo: string, _number: number, label: string) {
      state.labels = state.labels.filter((l) => l !== label);
    },
  };
}

suite("the #1417 dead-claim recovery chain against a real PostgreSQL", () => {
  let db: PrismaClient;
  let fullName = "";
  let base: Date;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url as string }) });
    holder.prisma = db;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    issueId = UNSET_ISSUE_ID;
    issueSeeded = false;
    extraIssueIds = [];
    base = new Date();
    githubCalls.add.length = 0;
    githubCalls.remove.length = 0;
    githubCalls.fetchIssue.length = 0;

    // The F1 evidence state: a live claim (agent label + in-progress) whose
    // worker died before agent-work/start — NO AgentWork row — and whose
    // lease has since expired unrenewed.
    const repo = await db.repository.create({
      data: {
        name: REPO_PREFIX,
        owner: "integration",
        fullName: `${REPO_PREFIX}repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    fullName = repo.fullName;
    const issue = await db.issue.create({
      data: {
        number: 1,
        repositoryId: repo.id,
        title: "dead claim recovery",
        state: "open",
        url: "https://example.test/dead-claim-recovery",
        labels: ["agent/dead", "status/in-progress"],
        assignees: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    issueId = issue.id;
    issueSeeded = true;
    await db.lease.create({
      data: {
        agentName: "dead",
        issueId,
        checkpoint: "issue_claimed",
        claimToken: CLAIM_TOKEN,
        expiredAt: new Date(base.getTime() - EXPIRED_AT_MS_AGO),
        renewedAt: new Date(base.getTime() - CLAIMED_AT_MS_AGO),
        lastRenewalObservedAt: new Date(base.getTime() - CLAIMED_AT_MS_AGO),
        renewCount: 0,
      },
    });
  });

  /**
   * Remove this file's rows from the shared database. Issue-scoped deletes
   * are guarded by `issueSeeded` so their filters are never built from an
   * unset id (Prisma omits `undefined`, which would be unscoped); the audit
   * rows go by this file's repo prefix.
   */
  async function cleanupSeededRows(): Promise<void> {
    if (issueSeeded) {
      await db.lease.deleteMany({ where: { issueId } });
      await db.ownershipReleaseIntent.deleteMany({ where: { issueId } });
      await db.ownershipReconcileCandidate.deleteMany({ where: { issueId } });
      await db.issueLifecycleEvent.deleteMany({ where: { issueId } });
      await db.issue.deleteMany({ where: { id: issueId } });
    }
    for (const extraId of extraIssueIds) {
      await db.lease.deleteMany({ where: { issueId: extraId } });
      await db.ownershipReleaseIntent.deleteMany({ where: { issueId: extraId } });
      await db.ownershipReconcileCandidate.deleteMany({ where: { issueId: extraId } });
      await db.issueLifecycleEvent.deleteMany({ where: { issueId: extraId } });
      await db.issue.deleteMany({ where: { id: extraId } });
    }
    await db.auditLog.deleteMany({ where: { repoFullName: { startsWith: REPO_PREFIX } } });
    await db.repository.deleteMany({ where: { fullName: { startsWith: REPO_PREFIX } } });
  }

  afterEach(async () => {
    await cleanupSeededRows();
    issueId = UNSET_ISSUE_ID;
    issueSeeded = false;
    extraIssueIds = [];
    vi.unstubAllEnvs();
  });

  function stubReconcileWindows() {
    vi.stubEnv("DISPATCH_OWNERSHIP_ACTIVE_WINDOW_MS", String(ACTIVE_MS));
    vi.stubEnv("DISPATCH_OWNERSHIP_LONG_RUN_GRACE_MS", String(LONG_RUN_GRACE_MS));
    vi.stubEnv("DISPATCH_RECONCILE_RECHECK_INTERVAL_MS", String(RECHECK_MS));
  }

  it("tombstones the expired lease, preserves the claim-epoch evidence, and is idempotent", async () => {
    const before = await db.lease.findUnique({
      where: { agentName_issueId: { agentName: "dead", issueId } },
    });
    expect(before).not.toBeNull();

    const first = await releaseExpiredLeases(issueId);
    expect(first).toBe(1);

    const tombstone = await db.lease.findUnique({
      where: { agentName_issueId: { agentName: "dead", issueId } },
    });
    // The row SURVIVES as expired-claim evidence, stamped system-only.
    expect(tombstone).not.toBeNull();
    expect(tombstone!.disposition).toBe("expired");
    expect(tombstone!.dispositionObservedAt).not.toBeNull();
    expect(tombstone!.dispositionNote).toContain("#1417");
    // The claim-epoch fence and renewal provenance are untouched — the
    // reconciler's Phase A epoch CAS must still match this row.
    expect(tombstone!.claimToken).toBe(CLAIM_TOKEN);
    expect(tombstone!.expiredAt).toEqual(before!.expiredAt);
    expect(tombstone!.renewedAt).toEqual(before!.renewedAt);

    // Idempotent: the disposition CAS matches nothing the second time.
    const second = await releaseExpiredLeases(issueId);
    expect(second).toBe(0);
    const after = await db.lease.findUnique({
      where: { agentName_issueId: { agentName: "dead", issueId } },
    });
    expect(after!.disposition).toBe("expired");
    expect(after!.dispositionObservedAt).toEqual(tombstone!.dispositionObservedAt);
  });

  it("never tombstones a lease whose retryAfter park is still running (#1316/#1334)", async () => {
    await db.lease.create({
      data: {
        agentName: "parked",
        issueId,
        checkpoint: "issue_claimed",
        claimToken: "tok-integration-parked",
        expiredAt: new Date(base.getTime() - EXPIRED_AT_MS_AGO),
        retryAfter: new Date(base.getTime() + 60 * 60_000),
        waitReason: "external dependency",
      },
    });

    const count = await releaseExpiredLeases(issueId);

    // Only the dead claim's plain-expired lease is stamped; the running park
    // keeps its receipt and its EXTERNAL_WAIT evidence.
    expect(count).toBe(1);
    const parked = await db.lease.findUnique({
      where: { agentName_issueId: { agentName: "parked", issueId } },
    });
    expect(parked!.disposition).toBeNull();
    expect(parked!.retryAfter).not.toBeNull();
    const dead = await db.lease.findUnique({
      where: { agentName_issueId: { agentName: "dead", issueId } },
    });
    expect(dead!.disposition).toBe("expired");
  });

  it("audit mode surfaces the tombstoned claim as an ABANDONED_CANDIDATE with zero mutations", async () => {
    await releaseExpiredLeases(issueId);
    stubReconcileWindows();
    vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", "audit");
    const forge = makeForge(["agent/dead", "status/in-progress"]);

    const report = await reconcileOwnership(
      { prisma: db as unknown as NonNullable<Parameters<typeof reconcileOwnership>[0]>["prisma"], forge, guard: withIssueMutationGuard },
      base,
    );

    expect(report.mode).toBe("audit");
    expect(report.examined).toBe(1);
    expect(report.released).toBe(0);

    // The annotation names the derived state and BOTH reason codes.
    const annotations = await db.auditLog.findMany({
      where: { actor: "reconciler", action: "ownership_reconcile_candidate", issueId },
    });
    expect(annotations.length).toBeGreaterThanOrEqual(1);
    const notes = annotations.map((r) => r.notes ?? "").join("\n");
    expect(notes).toContain("state=ABANDONED_CANDIDATE");
    expect(notes).toContain("disposition_expired");
    expect(notes).toContain("evidence_stale");

    // Audit promises no mutations: no intent, no forge write, no release,
    // and the tombstone row exactly as the cleanup left it.
    expect(await db.ownershipReleaseIntent.count({ where: { issueId } })).toBe(0);
    expect(githubCalls.remove).toHaveLength(0);
    expect(forge.state.labels).toContain("agent/dead");
    const lease = await db.lease.findUnique({
      where: { agentName_issueId: { agentName: "dead", issueId } },
    });
    expect(lease!.disposition).toBe("expired");
    expect(lease!.claimToken).toBe(CLAIM_TOKEN);
  });

  it("enforce mode ladders the tombstoned claim and releases it through the §8.7 protocol", async () => {
    await releaseExpiredLeases(issueId);
    stubReconcileWindows();
    vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", "enforce");
    const forge = makeForge(["agent/dead", "status/in-progress"]);
    const deps = {
      prisma: db as unknown as NonNullable<Parameters<typeof reconcileOwnership>[0]>["prisma"],
      forge,
      guard: withIssueMutationGuard,
    };

    // First observation: the ladder records and retains.
    const first = await reconcileOwnership(deps, base);
    expect(first.retained).toBe(1);
    expect(first.released).toBe(0);
    expect(githubCalls.remove).toHaveLength(0);
    const candidate = await db.ownershipReconcileCandidate.findUnique({ where: { issueId } });
    expect(candidate!.staleCount).toBe(1);

    // Second observation after the re-check interval: the epoch CAS pins the
    // tombstone, Phase B deletes exactly the claim label, Phase C settles.
    const second = await reconcileOwnership(deps, new Date(base.getTime() + 10 * 60_000));
    expect(second.released).toBe(1);
    // Phase B removes the claim label through the INJECTED forge adapter.
    expect(forge.state.labels).not.toContain("agent/dead");
    // The only mocked-github writer on this path is the §8.5 status swap:
    // the unexplained in-progress falls back to ready.
    expect(githubCalls.remove).toEqual([{ repo: fullName, number: 1, label: "status/in-progress" }]);
    expect(githubCalls.add).toEqual([{ repo: fullName, number: 1, label: "status/ready" }]);

    // §8.5: the unexplained in-progress falls back to ready, mirrored in the
    // cache without the dead agent label.
    const issue = await db.issue.findUnique({ where: { id: issueId } });
    expect(issue!.labels).not.toContain("agent/dead");
    expect(issue!.labels).toContain("status/ready");

    // The settle consumed the tombstone: the claim is gone everywhere.
    expect(await db.lease.count({ where: { issueId } })).toBe(0);
    expect(await db.ownershipReleaseIntent.count({ where: { issueId } })).toBe(0);
    const releases = await db.issueLifecycleEvent.findMany({
      where: { issueId, kind: "claim_released" },
    });
    expect(releases).toHaveLength(1);
    // The churn bound survives the release (§8.2 item 4).
    const candidateAfter = await db.ownershipReconcileCandidate.findUnique({ where: { issueId } });
    expect(candidateAfter!.reclaimCount).toBe(1);
  });

  it("enforce never prunes a tombstone whose cached labels lost the agent label while the forge still carries it (#1417 review round 4)", async () => {
    // The claim route writes GitHub BEFORE the local mirror transaction; a
    // failed mirror leaves the live claim invisible to the cached labels.
    // A second issue models exactly that: cached labels are pre-claim, the
    // forge still carries the claim, the lease has tombstoned.
    const staleIssue = await db.issue.create({
      data: {
        number: 2,
        repositoryId: (await db.issue.findUniqueOrThrow({ where: { id: issueId }, select: { repositoryId: true } })).repositoryId,
        title: "stale mirror pre-claim cache",
        state: "open",
        url: "https://example.test/stale-mirror",
        labels: ["status/in-progress"], // cache: pre-claim, no agent/*
        assignees: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    extraIssueIds.push(staleIssue.id);
    await db.lease.create({
      data: {
        agentName: "stalemirror",
        issueId: staleIssue.id,
        checkpoint: "issue_claimed",
        claimToken: "tok-integration-stale-mirror",
        expiredAt: new Date(base.getTime() - EXPIRED_AT_MS_AGO),
        renewedAt: new Date(base.getTime() - CLAIMED_AT_MS_AGO),
        lastRenewalObservedAt: new Date(base.getTime() - CLAIMED_AT_MS_AGO),
        renewCount: 0,
      },
    });
    await releaseExpiredLeases(staleIssue.id);
    stubReconcileWindows();
    vi.stubEnv("DISPATCH_OWNERSHIP_RECONCILE_MODE", "enforce");
    // The forge's single label set serves both issues on this fake; it still
    // carries BOTH claims — the destructive decision must not happen.
    const forge = makeForge(["agent/dead", "agent/stalemirror", "status/in-progress"]);
    const deps = {
      prisma: db as unknown as NonNullable<Parameters<typeof reconcileOwnership>[0]>["prisma"],
      forge,
      guard: withIssueMutationGuard,
    };

    const report = await reconcileOwnership(deps, base);

    // The stale-cache issue is not a candidate source (the scan filters on
    // cached labels), but its tombstone evidence SURVIVES the enforce pass.
    const preserved = await db.lease.findUnique({
      where: { agentName_issueId: { agentName: "stalemirror", issueId: staleIssue.id } },
    });
    expect(preserved).not.toBeNull();
    expect(preserved!.disposition).toBe("expired");
    expect(preserved!.claimToken).toBe("tok-integration-stale-mirror");
    // The primary tombstone was examined as the candidate it is.
    expect(report.examined).toBe(1);

    // Recoverable: once sync reflects the live label, the SAME tombstone
    // becomes candidate evidence and is examined — still never destroyed.
    await db.issue.update({
      where: { id: staleIssue.id },
      data: { labels: ["status/in-progress", "agent/stalemirror"] },
    });
    const second = await reconcileOwnership(deps, base);
    expect(second.examined).toBe(2);
    const stillThere = await db.lease.findUnique({
      where: { agentName_issueId: { agentName: "stalemirror", issueId: staleIssue.id } },
    });
    expect(stillThere).not.toBeNull();
  });
});
