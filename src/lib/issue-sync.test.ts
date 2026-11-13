import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Prisma } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";
import { GitHubIssue } from "@/types";

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchIssues: vi.fn(),
    issueAggregate: vi.fn(),
    issueFindUnique: vi.fn(),
    issueFindMany: vi.fn().mockResolvedValue([]),
    issueUpdate: vi.fn(),
    issueUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
    issueCreate: vi.fn(),
    issueDeleteMany: vi.fn(),
    transaction: vi.fn(),
    queryRaw: vi.fn(),
    agentRunCount: vi.fn(),
    agentWorkCount: vi.fn(),
    leaseCount: vi.fn(),
    groomingRunCount: vi.fn(),
    groomingApplicationCount: vi.fn(),
    issueMutationGuardCount: vi.fn(),
    groomerPendingReplyCount: vi.fn(),
    issueHandoffSettlementCount: vi.fn(),
    ownershipReleaseIntentCount: vi.fn(),
    ownershipReconcileCandidateCount: vi.fn(),
    groomingChildClaimCount: vi.fn(),
    noPrConclusionCount: vi.fn(),
    blockedExternalParkCount: vi.fn(),
    issueLifecycleEventCount: vi.fn(),
    issueLaneCount: vi.fn(),
    issueLaneCreate: vi.fn(),
    auditLogCreate: vi.fn(),
    txIssueFindUnique: vi.fn(),
    createLifecycleEvent: vi.fn(),
    upsertLifecycleEvent: vi.fn(),
  },
}));

vi.mock("@/lib/github", () => ({
  fetchIssues: mocks.fetchIssues,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: {
      aggregate: mocks.issueAggregate,
      findUnique: mocks.issueFindUnique,
      findMany: mocks.issueFindMany,
      update: mocks.issueUpdate,
      updateMany: mocks.issueUpdateMany,
      create: mocks.issueCreate,
      deleteMany: mocks.issueDeleteMany,
    },
    issueLane: {
      create: mocks.issueLaneCreate,
      count: mocks.issueLaneCount,
    },
    issueLifecycleEvent: {
      create: mocks.createLifecycleEvent,
      upsert: mocks.upsertLifecycleEvent,
      count: mocks.issueLifecycleEventCount,
    },
    // Interactive transaction client (#1587 prune): the callback receives a
    // tx object carrying the same mocks the top-level client would use.
    $transaction: mocks.transaction,
    agentRun: { count: mocks.agentRunCount },
    agentWork: { count: mocks.agentWorkCount },
    lease: { count: mocks.leaseCount },
    groomingRun: { count: mocks.groomingRunCount },
    groomingApplication: { count: mocks.groomingApplicationCount },
    issueMutationGuard: { count: mocks.issueMutationGuardCount },
    groomerPendingReply: { count: mocks.groomerPendingReplyCount },
    issueHandoffSettlement: { count: mocks.issueHandoffSettlementCount },
    ownershipReleaseIntent: { count: mocks.ownershipReleaseIntentCount },
    ownershipReconcileCandidate: { count: mocks.ownershipReconcileCandidateCount },
    groomingChildClaim: { count: mocks.groomingChildClaimCount },
    noPrConclusion: { count: mocks.noPrConclusionCount },
    blockedExternalPark: { count: mocks.blockedExternalParkCount },
    auditLog: { create: mocks.auditLogCreate },
  },
}));

import {
  IssueStore,
  type SyncedIssueData,
  syncIssuesForRepos,
  mergeLabels,
  reconcileClosedIssues,
  closedIssueStatusFix,
  fetchAllStateIssues,
  makePrismaIssueStore,
  makePrismaReconcileIssueStore,
  sweepRetiredLanes,
  defaultCurrentLane,
  currentLaneForLabels,
  SYNC_OVERLAP_BUFFER_MS,
} from "./issue-sync";
import { setLaneConfig, resetLaneConfig } from "@/lib/lane-config";

const REPO_ROOT = join(__dirname, "..", "..");

function githubIssue(number: number, overrides?: Partial<GitHubIssue>): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: null,
    state: "open",
    html_url: `https://github.com/org/repo/issues/${number}`,
    labels: [{ name: "type/bug", color: "ffffff" }],
    assignees: [{ login: "alice" }],
    comments: 2,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

describe("mergeLabels", () => {
  it("preserves a lease-backed agent/* label the GitHub read does not carry yet", () => {
    const ghLabels = ["type/bug", "priority/p1"];
    const existingLabels = ["agent/saffron", "status/in-progress", "priority/p1"];
    const result = mergeLabels(ghLabels, existingLabels, ["saffron"]);
    expect(result).toContain("agent/saffron");
    // status/in-progress is NOT preserved (only agent/* labels are)
    expect(result).toContain("type/bug");
    expect(result).toContain("priority/p1");
  });

  it("drops a cached agent/* label GitHub removed and no lease vouches for (#1623)", () => {
    const ghLabels = ["type/bug", "agent/codex"];
    const existingLabels = ["agent/nu", "agent/courier-local", "agent/codex"];
    const result = mergeLabels(ghLabels, existingLabels, []);
    expect(result).toEqual(["type/bug", "agent/codex"]);
  });

  it("preserves only the lease-backed labels when several cached agents disagree", () => {
    const ghLabels = ["type/bug"];
    const existingLabels = ["agent/nu", "agent/codex"];
    const result = mergeLabels(ghLabels, existingLabels, ["codex"]);
    expect(result).toEqual(["type/bug", "agent/codex"]);
  });

  it("ignores a lease whose agent names no cached label", () => {
    const ghLabels = ["type/bug"];
    const result = mergeLabels(ghLabels, ["agent/nu"], ["saffron"]);
    expect(result).toEqual(["type/bug"]);
  });

  it("matches lease agent names with surrounding whitespace trimmed", () => {
    const result = mergeLabels(["type/bug"], ["agent/saffron"], [" saffron "]);
    expect(result).toContain("agent/saffron");
  });

  it("avoids duplicates when GitHub already has the agent label", () => {
    const ghLabels = ["type/bug", "agent/saffron"];
    const existingLabels = ["agent/saffron", "status/in-progress"];
    const result = mergeLabels(ghLabels, existingLabels, ["saffron"]);
    // Should have agent/saffron only once
    const count = result.filter((l) => l === "agent/saffron").length;
    expect(count).toBe(1);
  });

  it("only preserves labels starting with agent/", () => {
    const ghLabels = ["type/bug"];
    const existingLabels = ["agent/saffron", "status/in-progress", "priority/p1"];
    const result = mergeLabels(ghLabels, existingLabels, ["saffron"]);
    expect(result).toContain("agent/saffron");
    // Other labels from existing should NOT be merged (only agent/*)
    expect(result).not.toContain("status/in-progress");
    expect(result).not.toContain("priority/p1");
  });

  it("returns GitHub labels unchanged when no agent/* in existing", () => {
    const ghLabels = ["type/bug", "priority/p1"];
    const existingLabels = ["status/in-progress"];
    const result = mergeLabels(ghLabels, existingLabels, ["saffron"]);
    expect(result).toEqual(ghLabels);
  });

  it("treats a missing lease list as no active leases (GitHub is authoritative)", () => {
    expect(mergeLabels([], ["agent/x"])).toEqual([]);
    expect(mergeLabels([], ["agent/x"], [])).toEqual([]);
  });

  it("handles empty arrays", () => {
    expect(mergeLabels([], [])).toEqual([]);
    expect(mergeLabels(["a"], [])).toEqual(["a"]);
  });
});

describe("closedIssueStatusFix", () => {
  it("leaves open issues untouched", () => {
    expect(closedIssueStatusFix(["status/ready", "type/bug"], "open")).toEqual({
      labels: ["status/ready", "type/bug"],
      added: [],
      removed: [],
    });
  });

  it("moves a closed issue from any status to status/done", () => {
    for (const from of ["status/backlog", "status/ready", "status/in-progress", "status/in-review"]) {
      const r = closedIssueStatusFix([from, "type/bug"], "closed");
      expect(r.labels).toEqual(["type/bug", "status/done"]);
      expect(r.removed).toEqual([from]);
      expect(r.added).toEqual(["status/done"]);
    }
  });

  it("adds status/done to a closed issue that has no status label", () => {
    const r = closedIssueStatusFix(["type/bug"], "closed");
    expect(r.labels).toEqual(["type/bug", "status/done"]);
    expect(r.added).toEqual(["status/done"]);
    expect(r.removed).toEqual([]);
  });

  it("is a no-op when a closed issue is already status/done", () => {
    expect(closedIssueStatusFix(["type/bug", "status/done"], "closed")).toEqual({
      labels: ["type/bug", "status/done"],
      added: [],
      removed: [],
    });
  });

  it("dedupes a stale status label alongside done", () => {
    const r = closedIssueStatusFix(["status/done", "status/ready", "type/bug"], "closed");
    expect(r.labels).toEqual(["type/bug", "status/done"]);
    expect(r.removed).toEqual(["status/ready"]);
    expect(r.added).toEqual([]);
  });
});

describe("syncIssuesForRepos", () => {
  let store: IssueStore;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store = {
      findIssue: vi.fn().mockResolvedValue(null),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
      deleteIssue: vi.fn().mockResolvedValue(true),
    };
  });

  it("returns the expected response shape and counts", async () => {
    const response = await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1), githubIssue(2)],
      store,
    );

    expect(response).toMatchObject({
      success: true,
      repos: 1,
      syncedCount: 2,
      results: [{ repo: "org/repo", synced: 2, error: null }],
    });
  });

  it("continues syncing repos after a per-repo error", async () => {
    const response = await syncIssuesForRepos(
      [
        { id: "repo-1", fullName: "org/bad" },
        { id: "repo-2", fullName: "org/good" },
      ],
      async (repo) => {
        if (repo.fullName === "org/bad") throw new Error("GitHub exploded");
        return [githubIssue(1)];
      },
      store,
    );

    expect(response).toEqual({
      success: false,
      repos: 2,
      syncedCount: 1,
      results: [
        { repo: "org/bad", synced: 0, error: "GitHub exploded" },
        { repo: "org/good", synced: 1, error: null },
      ],
    });
  });

  it("calls updateIssue for existing issues and createIssue for new ones", async () => {
    const findMock = vi.fn().mockResolvedValueOnce({ id: "existing-1", labels: [] }).mockResolvedValue(null);
    const updateMock = vi.fn().mockResolvedValue(undefined);
    const createMock = vi.fn().mockResolvedValue(undefined);

    store = {
      findIssue: findMock,
      updateIssue: updateMock,
      createIssue: createMock,
      deleteIssue: vi.fn().mockResolvedValue(true),
    };

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1), githubIssue(2)],
      store,
    );

    expect(findMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenCalledWith(
      "existing-1",
      expect.objectContaining({ number: 1 }),
      // The cached state is handed to the store alongside the write so it can
      // record what the sync changed (#1202).
      expect.objectContaining({ labels: [] }),
    );
    expect(createMock).toHaveBeenCalledWith("repo-1", expect.objectContaining({ number: 2 }));
  });

  it("preserves lease-backed agent/* labels when the GitHub read predates the claim", async () => {
    store = {
      findIssue: vi.fn().mockResolvedValue({
        id: "existing-1",
        labels: ["agent/saffron", "status/in-progress"],
        activeLeaseAgents: ["saffron"],
      }),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
      deleteIssue: vi.fn().mockResolvedValue(true),
    };

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1)],
      store,
    );

    // GitHub labels stay the base; the lease-backed agent/* label survives the
    // stale GitHub read.
    expect(store.updateIssue).toHaveBeenCalledWith(
      "existing-1",
      expect.objectContaining({ labels: ["type/bug", "agent/saffron"] }),
      expect.objectContaining({
        labels: ["agent/saffron", "status/in-progress"],
      }),
    );
  });

  it("drops stale cached agent/* labels GitHub no longer carries (#1623)", async () => {
    store = {
      findIssue: vi.fn().mockResolvedValue({
        id: "existing-1",
        labels: ["agent/nu", "agent/courier-local", "agent/codex", "status/ready"],
        activeLeaseAgents: [],
      }),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
      deleteIssue: vi.fn().mockResolvedValue(true),
    };

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1, { labels: [{ name: "type/bug", color: "f" }, { name: "agent/codex", color: "f" }] })],
      store,
    );

    // GitHub is authoritative: the unleased stale labels are gone, leaving a
    // single distinct agent so claimant resolution stops reporting
    // "ambiguous".
    expect(store.updateIssue).toHaveBeenCalledWith(
      "existing-1",
      expect.objectContaining({ labels: ["type/bug", "agent/codex"] }),
      expect.objectContaining({
        labels: ["agent/nu", "agent/courier-local", "agent/codex", "status/ready"],
      }),
    );
  });

  it("stores status/done for a closed issue and mirrors the change to GitHub", async () => {
    const syncGithubLabels = vi.fn().mockResolvedValue(undefined);

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1, { state: "closed", labels: [{ name: "status/ready", color: "f" }, { name: "type/bug", color: "f" }] })],
      store,
      [],
      syncGithubLabels,
    );

    // Cache: status/ready replaced with status/done.
    expect(store.createIssue).toHaveBeenCalledWith("repo-1", expect.objectContaining({ labels: ["type/bug", "status/done"] }));
    // GitHub: remove the stale status, add done.
    expect(syncGithubLabels).toHaveBeenCalledWith("org/repo", 1, ["status/done"], ["status/ready"]);
  });

  it("does not touch GitHub for open issues", async () => {
    const syncGithubLabels = vi.fn().mockResolvedValue(undefined);

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1, { state: "open", labels: [{ name: "status/ready", color: "f" }] })],
      store,
      [],
      syncGithubLabels,
    );

    expect(store.createIssue).toHaveBeenCalledWith("repo-1", expect.objectContaining({ labels: ["status/ready"] }));
    expect(syncGithubLabels).not.toHaveBeenCalled();
  });

  it("still fixes the cache when no GitHub writer is provided", async () => {
    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1, { state: "closed", labels: [{ name: "status/backlog", color: "f" }] })],
      store,
    );

    expect(store.createIssue).toHaveBeenCalledWith("repo-1", expect.objectContaining({ labels: ["status/done"] }));
  });
});

describe("syncIssuesForRepos — excluded-label reconcile at sync (#1587)", () => {
  let store: IssueStore;
  let deleteMock: Mock<(id: string) => Promise<boolean>>;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deleteMock = vi.fn().mockResolvedValue(true);
    store = {
      findIssue: vi.fn().mockResolvedValue(null),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
      deleteIssue: deleteMock,
    };
  });

  const EXCLUDED = ["wontfix"];

  function runSync(ghIssue: GitHubIssue) {
    return syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [ghIssue],
      store,
      EXCLUDED,
    );
  }

  it("prunes a cached row whose GitHub labels have become excluded", async () => {
    vi.mocked(store.findIssue).mockResolvedValue({ id: "zombie-1", labels: ["type/bug"] });

    const response = await runSync(githubIssue(7, { labels: [{ name: "wontfix", color: "ffffff" }] }));

    expect(store.deleteIssue).toHaveBeenCalledWith("zombie-1");
    expect(store.updateIssue).not.toHaveBeenCalled();
    expect(store.createIssue).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("pruned cached issue org/repo#7"));
    // A prune is a removal, not a sync: it never counts toward syncedCount.
    expect(response.syncedCount).toBe(0);
  });

  it("skips a new issue with an excluded label — never ingested, then deleted", async () => {
    // findIssue resolves null: the row was never cached.
    await runSync(githubIssue(8, { labels: [{ name: "wontfix", color: "ffffff" }] }));

    expect(store.createIssue).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("keeps a cached row the store refuses to delete, logs a warning, and persists the exclusion into the cached labels", async () => {
    vi.mocked(store.findIssue).mockResolvedValue({ id: "zombie-1", labels: ["agent/alpha"], activeLeaseAgents: ["alpha"] });
    deleteMock.mockResolvedValueOnce(false);

    await runSync(githubIssue(7, { labels: [{ name: "wontfix", color: "ffffff" }] }));

    expect(deleteMock).toHaveBeenCalledWith("zombie-1");
    expect(store.createIssue).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("kept cached issue org/repo#7"));
    // The kept row must not stay dispatchable: board and queue exclusion
    // filters read the *cached* labels, so the refusal persists the
    // GitHub-authoritative labels — the excluded label among them. The
    // lease-backed agent/* label survives the merge (the dependent work is a
    // live claim).
    expect(store.updateIssue).toHaveBeenCalledWith(
      "zombie-1",
      expect.objectContaining({ labels: ["wontfix", "agent/alpha"] }),
      { labels: ["agent/alpha"], state: null },
    );
  });

  it("persists closed⇒done on a refused prune, without mirroring the relabel to GitHub", async () => {
    // A refused prune writes the cache only: the branch continues before the
    // closed⇒done mirror, and a closed excluded issue still lands on
    // status/done in the cache. The status fix applies to the GitHub labels
    // BEFORE the lease-backed agent/* labels are merged on top.
    vi.mocked(store.findIssue).mockResolvedValue({ id: "zombie-1", labels: ["agent/alpha"], activeLeaseAgents: ["alpha"] });
    deleteMock.mockResolvedValueOnce(false);

    await runSync(
      githubIssue(7, { state: "closed", labels: [{ name: "wontfix", color: "ffffff" }] }),
    );

    expect(store.updateIssue).toHaveBeenCalledWith(
      "zombie-1",
      expect.objectContaining({ labels: ["wontfix", "status/done", "agent/alpha"], state: "closed" }),
      { labels: ["agent/alpha"], state: null },
    );
  });

  it("does not prune on a cache-side match — GitHub labels are authoritative", async () => {
    // The cached row still carries "wontfix" (prune pending), but GitHub no
    // longer has it: the issue is back in scope and syncs normally.
    vi.mocked(store.findIssue).mockResolvedValue({ id: "live-1", labels: ["wontfix"] });

    await runSync(githubIssue(9));

    expect(store.deleteIssue).not.toHaveBeenCalled();
    expect(store.updateIssue).toHaveBeenCalled();
  });

  it("keeps the row and persists the exclusion labels when the prune itself fails, and keeps syncing the repo", async () => {
    // The prune is the first BLOCKING write in the sync path: it waits on the
    // row lock, so it can fail where the other writes cannot (a lock wait
    // that outran the transaction timeout). One issue's failure must not skip
    // the rest of the repo's sync, and the kept row must not keep its stale
    // labels — the cached labels are what the board/queue exclusion filters
    // read. So the failure falls through to the keep path.
    vi.mocked(store.findIssue)
      .mockResolvedValueOnce({ id: "zombie-1", labels: ["agent/alpha"], activeLeaseAgents: ["alpha"] })
      .mockResolvedValueOnce(null);
    deleteMock.mockRejectedValueOnce(new Error("Transaction API error: transaction expired"));

    const response = await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [
        githubIssue(7, { labels: [{ name: "wontfix", color: "ffffff" }] }),
        githubIssue(8),
      ],
      store,
      EXCLUDED,
    );

    // The repo's sync continues: the next issue is ingested.
    expect(response.syncedCount).toBe(1);
    expect(response.results).toEqual([{ repo: "org/repo", synced: 1, error: null }]);
    expect(store.createIssue).toHaveBeenCalledWith("repo-1", expect.objectContaining({ number: 8 }));
    // The kept row carries the excluded label, so it stays out of the board
    // and queue paths until a later sync can prune it.
    expect(store.updateIssue).toHaveBeenCalledWith(
      "zombie-1",
      expect.objectContaining({ labels: ["wontfix", "agent/alpha"] }),
      { labels: ["agent/alpha"], state: null },
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("prune failed for cached issue org/repo#7"),
      expect.any(Error),
    );
    // The warning says the prune FAILED — not that dependent rows exist,
    // which would be a false statement about why the row was kept.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("kept cached issue org/repo#7: prune failed"),
    );
  });

  it("leaves non-excluded issues untouched by the prune path", async () => {
    vi.mocked(store.findIssue).mockResolvedValue(null);

    await runSync(githubIssue(10));

    expect(store.createIssue).toHaveBeenCalledWith("repo-1", expect.objectContaining({ number: 10 }));
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe("syncIssuesForRepos native blocked_by persistence", () => {
  let store: IssueStore;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("writes native keys on create", async () => {
    const createMock = vi.fn().mockResolvedValue(undefined);
    store = {
      findIssue: vi.fn().mockResolvedValue(null),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: createMock,
      deleteIssue: vi.fn().mockResolvedValue(true),
    };

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1, { nativeBlockedBy: ["org/repo#5", "other/repo#9"] })],
      store,
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][1].nativeBlockedBy).toEqual(["org/repo#5", "other/repo#9"]);
  });

  it("does not clear stored keys when the field is absent/unknown", async () => {
    const updateMock = vi.fn().mockResolvedValue(undefined);
    store = {
      findIssue: vi.fn().mockResolvedValue({ id: "existing-2", labels: [] }),
      updateIssue: updateMock,
      createIssue: vi.fn().mockResolvedValue(undefined),
      deleteIssue: vi.fn().mockResolvedValue(true),
    };

    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(2)],
      store,
    );

    expect(updateMock).toHaveBeenCalledTimes(1);
    // undefined → Prisma omits the field, so stored keys are preserved.
    expect(updateMock.mock.calls[0][1].nativeBlockedBy).toBeUndefined();
  });

  it("overwrites stored keys when the fetch returns a new non-empty set", async () => {
    const updateMock = vi.fn().mockResolvedValue(undefined);
    store = {
      findIssue: vi.fn().mockResolvedValue({ id: "existing-2", labels: [] }),
      updateIssue: updateMock,
      createIssue: vi.fn().mockResolvedValue(undefined),
      deleteIssue: vi.fn().mockResolvedValue(true),
    };

    // A blocker added after creation: the freshly-fetched non-empty set is
    // authoritative and replaces the stored keys.
    await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(2, { nativeBlockedBy: ["org/repo#10", "other/repo#4"] })],
      store,
    );

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][1].nativeBlockedBy).toEqual(["org/repo#10", "other/repo#4"]);
  });
});

describe("reconcileClosedIssues", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("marks closed issues with active status labels as done", async () => {
    const updateCalls: Array<{ id: string; data: any }> = [];

    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async (_, number) =>
        githubIssue(number, {
          state: "closed",
          labels: [{ name: "type/bug", color: "ffffff" }],
          closed_at: "2026-01-03T00:00:00.000Z",
        }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          { id: "issue-1", number: 42, labels: ["status/ready", "type/bug"], state: "open" },
        ]),
        updateIssue: vi.fn().mockImplementation((id, data) => {
          updateCalls.push({ id, data });
        }),
      },
    );

    expect(result.issuesReconciled).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].data.state).toBe("closed");
    expect(updateCalls[0].data.labels).toContain("status/done");
    expect(updateCalls[0].data.labels).not.toContain("status/ready");
  });

  it("fixes stale state for issues with status/done but open state", async () => {
    const updateCalls: Array<{ id: string; data: any }> = [];

    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async (_, number) =>
        githubIssue(number, {
          state: "closed",
          labels: [{ name: "status/done", color: "ffffff" }, { name: "type/bug", color: "ffffff" }],
          closed_at: "2026-01-03T00:00:00.000Z",
        }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          // Issue has status/done label but still shows as open (stale cache)
          { id: "issue-460", number: 460, labels: ["status/done", "type/bug"], state: "open" },
        ]),
        updateIssue: vi.fn().mockImplementation((id, data) => {
          updateCalls.push({ id, data });
        }),
      },
    );

    expect(result.issuesReconciled).toBe(1);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].data.state).toBe("closed");
    // Labels should be preserved (already has status/done)
    expect(updateCalls[0].data.labels).toContain("status/done");
    expect(updateCalls[0].data.labels).toContain("type/bug");

    // Verify the action is "state_fixed" not "marked_done"
    const stateFixedResults = result.results.filter((r) => r.action === "state_fixed");
    expect(stateFixedResults).toHaveLength(1);
    expect(stateFixedResults[0].issueNumber).toBe(460);
  });

  it("skips issues without reconcilable status labels or done label", async () => {
    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => githubIssue(99, { state: "closed", closed_at: "2026-01-03T00:00:00.000Z" }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          // No reconcilable status label and no done label — should be skipped
          { id: "issue-99", number: 99, labels: ["type/bug"], state: "open" },
        ]),
        updateIssue: vi.fn(),
      },
    );

    expect(result.issuesReconciled).toBe(0);
    expect(result.issuesChecked).toBe(0);
    // No results generated since the issue was filtered out before processing
    expect(result.results).toHaveLength(0);
  });

  it("does not reconcile if GitHub still shows the issue as open", async () => {
    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => githubIssue(42, { state: "open" }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          { id: "issue-42", number: 42, labels: ["status/ready"], state: "open" },
        ]),
        updateIssue: vi.fn(),
      },
    );

    expect(result.issuesReconciled).toBe(0);
    expect(result.results[0].reconciled).toBe(false);
    expect(result.results[0].action).toBe("no_change");
  });

  it("marks in-progress issues as released_lease", async () => {
    const result = await reconcileClosedIssues(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => githubIssue(42, { state: "closed", closed_at: "2026-01-03T00:00:00.000Z" }),
      {
        findActiveCachedIssues: vi.fn().mockResolvedValue([
          { id: "issue-42", number: 42, labels: ["status/in-progress"], state: "open" },
        ]),
        updateIssue: vi.fn(),
      },
    );

    expect(result.issuesReconciled).toBe(1);
    expect(result.results[0].action).toBe("released_lease");
  });
});

describe("fetchAllStateIssues", () => {
  beforeEach(() => {
    mocks.fetchIssues.mockReset().mockResolvedValue([]);
    mocks.issueAggregate.mockReset();
  });

  it("does a full fetch (no since) when the repo has no cached issues", async () => {
    mocks.issueAggregate.mockResolvedValue({ _max: { lastSyncedAt: null } });

    await fetchAllStateIssues({ id: "repo-1", fullName: "org/repo" });

    expect(mocks.issueAggregate).toHaveBeenCalledWith({
      where: { repositoryId: "repo-1" },
      _max: { lastSyncedAt: true },
    });
    expect(mocks.fetchIssues).toHaveBeenCalledWith("org/repo", {
      state: "open",
      includeNativeBlockers: true,
    });
    expect(mocks.fetchIssues).toHaveBeenCalledWith("org/repo", { state: "closed", since: undefined });
  });

  it("always full-fetches open issues (no since) even when the repo has cached issues", async () => {
    const anchor = new Date("2026-07-01T00:00:00.000Z");
    mocks.issueAggregate.mockResolvedValue({ _max: { lastSyncedAt: anchor } });

    await fetchAllStateIssues({ id: "repo-1", fullName: "org/repo" });

    // dispatch#991: an open issue missed by the initial fetch and never
    // updated_at-touched must not be stranded — open issues are fetched in
    // full every sync, never narrowed by `since`.
    expect(mocks.fetchIssues).toHaveBeenCalledWith("org/repo", {
      state: "open",
      includeNativeBlockers: true,
    });
  });

  it("narrows the closed-issue tail with since = anchor - SYNC_OVERLAP_BUFFER_MS when the repo has cached issues", async () => {
    const anchor = new Date("2026-07-01T00:00:00.000Z");
    mocks.issueAggregate.mockResolvedValue({ _max: { lastSyncedAt: anchor } });

    await fetchAllStateIssues({ id: "repo-1", fullName: "org/repo" });

    expect(mocks.fetchIssues).toHaveBeenCalledWith("org/repo", {
      state: "closed",
      since: new Date(anchor.getTime() - SYNC_OVERLAP_BUFFER_MS),
    });
  });

  it("merges open and closed results, deduping by issue number", async () => {
    mocks.issueAggregate.mockResolvedValue({ _max: { lastSyncedAt: null } });
    mocks.fetchIssues.mockImplementation(async (_repo: string, options?: { state?: string }) => {
      if (options?.state === "open") {
        return [githubIssue(1), githubIssue(2)];
      }
      return [githubIssue(2, { state: "closed", closed_at: "2026-01-03T00:00:00.000Z" }), githubIssue(3, { state: "closed", closed_at: "2026-01-03T00:00:00.000Z" })];
    });

    const result = await fetchAllStateIssues({ id: "repo-1", fullName: "org/repo" });

    expect(result.map((i) => i.number).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // The open copy of #2 wins over the closed one.
    expect(result.find((i) => i.number === 2)?.state).toBe("open");
  });
});

describe("defaultCurrentLane (dispatch#964)", () => {
  afterEach(() => resetLaneConfig());

  it("returns the configured default claimable lane id", () => {
    // A renamed multi-lane deployment: the default lane is `local`, and
    // `normal` is only an alias. An ingested issue must start on `local`, the
    // lane a worker actually polls — never the old hardcoded `normal`.
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true, role: "default" },
        { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
      laneAliases: { normal: "local", escalated: "frontier" },
    });
    expect(defaultCurrentLane()).toBe("local");
  });

  it("falls back to the built-in default lane when config is unset", () => {
    resetLaneConfig();
    // DEFAULT_LANE_CONFIG's claimable lane is `default` — agnostic, and still
    // never the removed `normal`.
    expect(defaultCurrentLane()).toBe("default");
  });

  it("prefers the first claimable lane when none is marked role=default", () => {
    setLaneConfig({
      lanes: [
        { id: "backlog", title: "Backlog", claimable: false },
        { id: "work", title: "Work", claimable: true },
      ],
    });
    expect(defaultCurrentLane()).toBe("work");
  });
});

describe("currentLaneForLabels (dispatch#988)", () => {
  afterEach(() => resetLaneConfig());

  it("routes an escalation-labeled issue to the escalation lane", () => {
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true, role: "default" },
        { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
      laneAliases: { normal: "local", escalated: "frontier" },
    });
    // A scan/CVE CI failure filed with the escalation label must land on the
    // frontier lane at ingest, not the default lane a standard coder polls.
    expect(currentLaneForLabels(["bug", "needs-escalation"])).toBe("frontier");
    // The legacy alias is honored too, and matching is case-insensitive.
    expect(currentLaneForLabels(["needs-gpt"])).toBe("frontier");
    expect(currentLaneForLabels(["Needs-Escalation"])).toBe("frontier");
  });

  it("routes a plain issue to the default claimable lane", () => {
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true, role: "default" },
        { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
      ],
      laneAliases: { normal: "local", escalated: "frontier" },
    });
    expect(currentLaneForLabels(["bug", "priority/p1"])).toBe("local");
    expect(currentLaneForLabels([])).toBe("local");
  });

  it("falls back to the default lane when an escalation label has no escalation lane", () => {
    setLaneConfig({
      lanes: [{ id: "work", title: "Work", claimable: true }],
    });
    // No lane carries role=escalation, so an escalation-labeled issue must not
    // vanish — it falls back to the default claimable lane.
    expect(currentLaneForLabels(["needs-escalation"])).toBe("work");
  });
});

describe("makePrismaIssueStore — lifecycle evidence (#1202)", () => {
  const updatedAt = new Date("2026-10-02T08:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issueUpdate.mockResolvedValue({ id: "issue-1" });
    mocks.issueCreate.mockResolvedValue({ id: "issue-1" });
    mocks.issueFindUnique.mockResolvedValue({
      id: "issue-1",
      labels: ["status/ready"],
      state: "open",
      repository: { fullName: "org/repo" },
    });
    mocks.createLifecycleEvent.mockResolvedValue({ id: "evt-1" });
    mocks.upsertLifecycleEvent.mockResolvedValue({ id: "evt-1" });
  });

  function syncData(overrides: Partial<SyncedIssueData> = {}): SyncedIssueData {
    return {
      number: 42,
      title: "Issue 42",
      body: null,
      url: "https://github.com/org/repo/issues/42",
      labels: ["status/in-review"],
      assignees: [],
      commentsCount: 0,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt,
      closedAt: null,
      lastSyncedAt: updatedAt,
      state: "open",
      ...overrides,
    };
  }

  it("records the status move the sync mirrored, with GitHub's timestamp as the occurrence time", async () => {
    const store = makePrismaIssueStore();
    await store.findIssue("repo-1", 42);
    await store.updateIssue("issue-1", syncData(), { labels: ["status/ready"], state: "open" });

    expect(mocks.upsertLifecycleEvent).toHaveBeenCalledWith({
      where: { dedupeKey: "sync|org/repo|42|status_changed|status/ready|status/in-review|2026-10-02T08:00:00.000Z" },
      create: expect.objectContaining({
        issueId: "issue-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        kind: "status_changed",
        source: "sync",
        fromStatus: "status/ready",
        toStatus: "status/in-review",
        occurredAt: updatedAt,
      }),
      update: {},
    });
  });

  it("records a close GitHub reported, separately from the status label moving to done", async () => {
    const store = makePrismaIssueStore();
    await store.findIssue("repo-1", 42);
    await store.updateIssue(
      "issue-1",
      syncData({ labels: ["status/done"], state: "closed", closedAt: updatedAt }),
      { labels: ["status/in-progress"], state: "open" },
    );

    const kinds = mocks.upsertLifecycleEvent.mock.calls.map((call: any[]) => call[0].create.kind);
    expect(kinds).toEqual(["status_changed", "issue_closed"]);
  });

  it("records nothing when the synced issue did not change", async () => {
    const store = makePrismaIssueStore();
    await store.findIssue("repo-1", 42);
    await store.updateIssue("issue-1", syncData({ labels: ["status/ready"] }), { labels: ["status/ready"], state: "open" });

    expect(mocks.issueUpdate).toHaveBeenCalled();
    expect(mocks.createLifecycleEvent).not.toHaveBeenCalled();
    expect(mocks.upsertLifecycleEvent).not.toHaveBeenCalled();
  });

  it("collapses a repeated sync over the same GitHub state onto one row", async () => {
    const store = makePrismaIssueStore();
    await store.findIssue("repo-1", 42);
    await store.updateIssue("issue-1", syncData(), { labels: ["status/ready"], state: "open" });
    await store.findIssue("repo-1", 42);
    await store.updateIssue("issue-1", syncData(), { labels: ["status/ready"], state: "open" });

    const keys = mocks.upsertLifecycleEvent.mock.calls.map((call: any[]) => call[0].where.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("defers the mirror when the event write fails, then records exactly one event on the next sync", async () => {
    // The evidence is written before the mirror, so a failed event write must
    // leave the cache row untouched: an already-mirrored change would leave the
    // next sync with no transition to derive, and the missing row could never
    // be reconstructed.
    const failedRun = makePrismaIssueStore();
    await failedRun.findIssue("repo-1", 42);
    mocks.upsertLifecycleEvent.mockRejectedValueOnce(new Error("db down"));

    await expect(
      failedRun.updateIssue("issue-1", syncData(), { labels: ["status/ready"], state: "open" }),
    ).rejects.toThrow("db down");
    expect(mocks.issueUpdate).not.toHaveBeenCalled();

    // The next sync sees the same before-state, re-derives the same transition
    // and upserts onto the same source-derived key.
    const retriedRun = makePrismaIssueStore();
    await retriedRun.findIssue("repo-1", 42);
    await retriedRun.updateIssue("issue-1", syncData(), { labels: ["status/ready"], state: "open" });

    expect(mocks.issueUpdate).toHaveBeenCalledTimes(1);
    // Both attempts carried the same identity, so the retry upserts the row the
    // failed run could not write instead of appending a second one.
    const keys = mocks.upsertLifecycleEvent.mock.calls.map((call: any[]) => call[0].where.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("makePrismaIssueStore — excluded-reconcile delete (#1587)", () => {
  // Every Issue relation that holds live state (work, coordination, policy).
  // A row in any of them refuses the prune: the schema cascades those, so an
  // unguarded delete would destroy real work. The pair with the derived
  // history below is the only thing the prune may take with the row.
  const dependentCounts = [
    ["AgentRun", mocks.agentRunCount, "issueId"],
    ["AgentWork", mocks.agentWorkCount, "issueId"],
    ["Lease", mocks.leaseCount, "issueId"],
    ["GroomingRun", mocks.groomingRunCount, "issueId"],
    ["GroomingApplication", mocks.groomingApplicationCount, "issueId"],
    ["IssueMutationGuard", mocks.issueMutationGuardCount, "issueId"],
    ["GroomerPendingReply", mocks.groomerPendingReplyCount, "issueId"],
    ["IssueHandoffSettlement", mocks.issueHandoffSettlementCount, "issueId"],
    ["OwnershipReleaseIntent", mocks.ownershipReleaseIntentCount, "issueId"],
    ["OwnershipReconcileCandidate", mocks.ownershipReconcileCandidateCount, "issueId"],
    ["GroomingChildClaim", mocks.groomingChildClaimCount, "parentIssueId"],
    ["NoPrConclusion", mocks.noPrConclusionCount, "issueId"],
    ["BlockedExternalPark", mocks.blockedExternalParkCount, "issueId"],
  ] as const;
  // The row's own derived history: removed with it, counted and recorded.
  const derivedCounts = [
    ["IssueLifecycleEvent", mocks.issueLifecycleEventCount],
    ["IssueLane", mocks.issueLaneCount],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    // Interactive transaction: the callback runs against a tx client carrying
    // the same mocks as the top-level client.
    mocks.transaction.mockImplementation((fn: (tx: any) => unknown) =>
      fn({
        $queryRaw: mocks.queryRaw,
        agentRun: { count: mocks.agentRunCount },
        agentWork: { count: mocks.agentWorkCount },
        lease: { count: mocks.leaseCount },
        groomingRun: { count: mocks.groomingRunCount },
        groomingApplication: { count: mocks.groomingApplicationCount },
        issueMutationGuard: { count: mocks.issueMutationGuardCount },
        groomerPendingReply: { count: mocks.groomerPendingReplyCount },
        issueHandoffSettlement: { count: mocks.issueHandoffSettlementCount },
        ownershipReleaseIntent: { count: mocks.ownershipReleaseIntentCount },
        ownershipReconcileCandidate: { count: mocks.ownershipReconcileCandidateCount },
        groomingChildClaim: { count: mocks.groomingChildClaimCount },
        noPrConclusion: { count: mocks.noPrConclusionCount },
        blockedExternalPark: { count: mocks.blockedExternalParkCount },
        issueLifecycleEvent: { count: mocks.issueLifecycleEventCount },
        issueLane: { count: mocks.issueLaneCount },
        auditLog: { create: mocks.auditLogCreate },
        issue: { findUnique: mocks.txIssueFindUnique, deleteMany: mocks.issueDeleteMany },
      }),
    );
    mocks.queryRaw.mockResolvedValue([]);
    dependentCounts.forEach(([, count]) => count.mockResolvedValue(0));
    derivedCounts.forEach(([, count]) => count.mockResolvedValue(0));
    mocks.txIssueFindUnique.mockResolvedValue({
      number: 42,
      labels: ["wontfix"],
      repository: { fullName: "org/repo" },
    });
    mocks.auditLogCreate.mockResolvedValue({ id: "audit-1" });
    mocks.issueDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("locks the row, checks every dependent model, then deletes", async () => {
    const store = makePrismaIssueStore();

    await expect(store.deleteIssue("zombie-1")).resolves.toBe(true);

    // The lock must be taken: an insert referencing the issue takes a
    // FOR KEY SHARE lock on the parent row, and FOR UPDATE is the mode that
    // conflicts with it — such an insert waits until the check-then-delete
    // decision commits. Pin the mode itself: FOR NO KEY UPDATE does NOT
    // conflict with FOR KEY SHARE (a dependent insert could slip in between
    // the counts and the delete and be cascade-deleted), and a weaker lock
    // (FOR SHARE) would keep the call count and silently defeat the
    // serialization. The row-returning SELECT must run through $queryRaw:
    // $executeRaw is for statements that change rows and cannot return a
    // result set, so the lock would never be taken through it.
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    const [lockQuery] = mocks.queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const lockSql = lockQuery.join("$1");
    expect(lockSql).toContain('FROM "Issue"');
    expect(lockSql).toContain("FOR UPDATE");
    expect(lockSql).not.toContain("FOR NO KEY UPDATE");
    // Every relation that holds live state is counted, under its own foreign
    // key name. A relation left out of this list cascades silently.
    dependentCounts.forEach(([, count, field]) => {
      expect(count).toHaveBeenCalledWith({ where: { [field]: "zombie-1" } });
    });
    expect(mocks.issueDeleteMany).toHaveBeenCalledWith({ where: { id: "zombie-1" } });
  });

  it("runs the decision under READ COMMITTED so the counts see a row committed after it started", async () => {
    // The dependent-row counts must read the CURRENT state: under a stronger
    // isolation level (REPEATABLE READ / SERIALIZABLE) they would read this
    // transaction's original snapshot, miss a dependent row that committed
    // while the decision was running, and the delete would destroy it. The
    // level is pinned so the guarantee does not depend on the server default.
    const store = makePrismaIssueStore();

    await expect(store.deleteIssue("zombie-1")).resolves.toBe(true);

    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  });

  it("reports pruned when the row vanished under the check", async () => {
    // A row that is already gone satisfies the goal (the cache no longer
    // holds it); false — and its "dependent rows exist" warning — is
    // reserved for real refusals, so the log never mislabels this race.
    mocks.issueDeleteMany.mockResolvedValue({ count: 0 });
    const store = makePrismaIssueStore();

    await expect(store.deleteIssue("zombie-1")).resolves.toBe(true);
    // Nothing was removed, so nothing is recorded.
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it.each(dependentCounts)(
    "refuses the delete when a dependent %s exists",
    async (_name, count) => {
      count.mockResolvedValue(1);
      const store = makePrismaIssueStore();

      await expect(store.deleteIssue("zombie-1")).resolves.toBe(false);
      // No dependent row may cascade or null out: the row is kept whole.
      expect(mocks.issueDeleteMany).not.toHaveBeenCalled();
      // A refused prune removes nothing, so it records nothing.
      expect(mocks.auditLogCreate).not.toHaveBeenCalled();
    },
  );

  it("records the prune in an audit row, and counts the derived history that goes with it", async () => {
    // The prune removes the row's own derived history (lifecycle events, lane
    // classifications). That loss must be recorded, not silent: the audit row
    // survives the delete because its issue link is nullable.
    mocks.issueLifecycleEventCount.mockResolvedValue(3);
    mocks.issueLaneCount.mockResolvedValue(1);
    const store = makePrismaIssueStore();

    await expect(store.deleteIssue("zombie-1")).resolves.toBe(true);

    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    const audit = mocks.auditLogCreate.mock.calls[0][0].data;
    expect(audit.action).toBe("prune_excluded_issue");
    expect(audit.actor).toBe("sync");
    expect(audit.repoFullName).toBe("org/repo");
    expect(audit.issueNumber).toBe(42);
    // The row this entry describes is deleted in the same transaction, so the
    // link cannot be kept.
    expect(audit.issueId).toBeNull();
    expect(audit.beforeLabels).toEqual(["wontfix"]);
    expect(audit.success).toBe(true);
    expect(audit.notes).toContain("org/repo#42");
    expect(audit.notes).toContain("3 lifecycle event(s)");
    expect(audit.notes).toContain("1 lane classification(s)");
    // The counts are read for THIS row.
    expect(mocks.issueLifecycleEventCount).toHaveBeenCalledWith({ where: { issueId: "zombie-1" } });
    expect(mocks.issueLaneCount).toHaveBeenCalledWith({ where: { issueId: "zombie-1" } });
  });

  it("classifies every relation the Issue model has", () => {
    // The guard list is hand-maintained, so a relation added to the schema
    // later would be cascade-deleted without anyone noticing. This test reads
    // the schema and fails until every Issue relation is classified: guarded
    // (a dependent row refuses the prune), derived history (removed with the
    // row and recorded), or surviving (a nullable link that is only cleared).
    const schema = readFileSync(join(REPO_ROOT, "prisma", "schema.prisma"), "utf-8");
    const modelBlock = schema.slice(schema.indexOf("model Issue {"));
    const body = modelBlock.slice(0, modelBlock.indexOf("\n}"));
    const scalarTypes = new Set([
      "String",
      "Boolean",
      "Int",
      "Float",
      "BigInt",
      "Decimal",
      "DateTime",
      "Json",
      "Bytes",
    ]);
    const relations = [...body.matchAll(/^\s+(\w+)\s+([A-Z]\w+)(\[\]|\?)?\s*$/gm)]
      .map((match) => ({ field: match[1], model: match[2] }))
      .filter((relation) => !scalarTypes.has(relation.model));

    expect(relations.length).toBeGreaterThan(0);

    const guarded = new Set<string>(dependentCounts.map(([model]) => model));
    const derived = new Set(["IssueLifecycleEvent", "IssueLane"]);
    const surviving = new Set(["AuditLog"]);
    for (const relation of relations) {
      expect(
        guarded.has(relation.model) || derived.has(relation.model) || surviving.has(relation.model),
        `Issue relation "${relation.field}" (${relation.model}) is not classified for the #1587 prune`,
      ).toBe(true);
    }
    // And the guard list must not name a model the schema no longer has: a
    // stale entry would count a table that no longer exists.
    for (const [model] of dependentCounts) {
      expect(
        relations.some((relation) => relation.model === model),
        `the prune guard names ${model}, which the Issue model no longer relates to`,
      ).toBe(true);
    }
  });

  it("writes no audit row when the row is already gone", async () => {
    // The row vanished while the transaction waited for the lock: the goal is
    // already met, and nothing was removed, so nothing is recorded.
    mocks.txIssueFindUnique.mockResolvedValue(null);
    const store = makePrismaIssueStore();

    await expect(store.deleteIssue("zombie-1")).resolves.toBe(true);

    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
    expect(mocks.issueDeleteMany).not.toHaveBeenCalled();
  });

  it("keeps the repo mapping on refusal so the persisted-label update records lifecycle events", async () => {
    // The refusal path's follow-up updateIssue persists the excluded labels
    // and needs the repo name the findIssue stashed to record the
    // excluded-label transition as lifecycle evidence (#1202). Clearing the
    // entry inside deleteIssue would silently skip that recording.
    mocks.issueFindUnique.mockResolvedValue({
      id: "zombie-1",
      labels: ["agent/alpha"],
      state: "open",
      repository: { fullName: "org/repo" },
    });
    mocks.upsertLifecycleEvent.mockResolvedValue({ id: "evt-1" });
    mocks.issueUpdate.mockResolvedValue({ id: "zombie-1" });
    mocks.leaseCount.mockResolvedValue(1);
    const store = makePrismaIssueStore();

    await store.findIssue("repo-1", 42);
    await expect(store.deleteIssue("zombie-1")).resolves.toBe(false);
    await store.updateIssue(
      "zombie-1",
      {
        number: 42,
        title: "Issue 42",
        body: null,
        url: "https://github.com/org/repo/issues/42",
        labels: ["wontfix", "agent/alpha"],
        assignees: [],
        commentsCount: 0,
        state: "open",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        closedAt: null,
        lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      { labels: ["status/ready", "agent/alpha"], state: "open" },
    );

    expect(mocks.upsertLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ repoFullName: "org/repo" }),
      }),
    );
  });

  it("drops the repo mapping once the issue is pruned", async () => {
    // The entry must not outlive the row: after a successful prune no update
    // follows for that id, and a stray late call must not fabricate lifecycle
    // evidence for an issue that no longer exists.
    mocks.issueFindUnique.mockResolvedValue({
      id: "zombie-1",
      labels: [],
      state: "open",
      repository: { fullName: "org/repo" },
    });
    mocks.upsertLifecycleEvent.mockResolvedValue({ id: "evt-1" });
    mocks.issueUpdate.mockResolvedValue({ id: "zombie-1" });
    const store = makePrismaIssueStore();

    await store.findIssue("repo-1", 42);
    await expect(store.deleteIssue("zombie-1")).resolves.toBe(true);
    await store.updateIssue(
      "zombie-1",
      {
        number: 42,
        title: "Issue 42",
        body: null,
        url: "https://github.com/org/repo/issues/42",
        labels: ["status/in-review"],
        assignees: [],
        commentsCount: 0,
        state: "open",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        closedAt: null,
        lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
      { labels: [], state: "open" },
    );
    expect(mocks.upsertLifecycleEvent).not.toHaveBeenCalled();
  });
});

describe("makePrismaReconcileIssueStore — lifecycle evidence (#1202)", () => {
  const closedAt = new Date("2026-10-02T09:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.issueUpdate.mockResolvedValue({ id: "issue-1" });
    mocks.issueFindUnique.mockResolvedValue({
      number: 42,
      repository: { fullName: "org/repo" },
    });
    mocks.createLifecycleEvent.mockResolvedValue({ id: "evt-1" });
    mocks.upsertLifecycleEvent.mockResolvedValue({ id: "evt-1" });
  });

  const closedData = { labels: ["status/done"], state: "closed", closedAt };

  it("records the closure before mirroring it", async () => {
    const store = makePrismaReconcileIssueStore();
    await store.updateIssue("issue-1", closedData, { labels: ["status/ready"], state: "open" });

    // Reconciling a close moves the status label and closes the issue, so both
    // facts are recorded: a label that reads status/done on an open issue is
    // not the same evidence as GitHub having closed it.
    expect(mocks.upsertLifecycleEvent).toHaveBeenCalledWith({
      where: { dedupeKey: "sync|org/repo|42|issue_closed|2026-10-02T09:00:00.000Z" },
      create: expect.objectContaining({
        issueId: "issue-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        kind: "issue_closed",
        source: "sync",
      }),
      update: {},
    });
    expect(mocks.upsertLifecycleEvent).toHaveBeenCalledWith({
      where: { dedupeKey: "sync|org/repo|42|status_changed|status/ready|status/done|" },
      create: expect.objectContaining({
        issueId: "issue-1",
        kind: "status_changed",
        fromStatus: "status/ready",
        toStatus: "status/done",
      }),
      update: {},
    });
    expect(mocks.issueUpdate).toHaveBeenCalledTimes(1);
  });

  it("defers the mirror when the event write fails, then records one closure on the next pass", async () => {
    // Same ordering guarantee as the sync store: this store resolves the repo
    // name itself, so it is the only place where an event failure could leave
    // an already-closed cache row that no later reconcile could observe.
    const failedRun = makePrismaReconcileIssueStore();
    mocks.upsertLifecycleEvent.mockRejectedValueOnce(new Error("db down"));

    await expect(
      failedRun.updateIssue("issue-1", closedData, { labels: ["status/ready"], state: "open" }),
    ).rejects.toThrow("db down");
    expect(mocks.issueUpdate).not.toHaveBeenCalled();

    const retriedRun = makePrismaReconcileIssueStore();
    await retriedRun.updateIssue("issue-1", closedData, { labels: ["status/ready"], state: "open" });

    expect(mocks.issueUpdate).toHaveBeenCalledTimes(1);
    // The failed pass got as far as the first of the two identities before the
    // write was rejected, and the retry derives both of them again from the
    // unchanged cache row: three attempts, two identities, so the row the
    // failed pass could not write is upserted rather than duplicated.
    const keys = mocks.upsertLifecycleEvent.mock.calls.map((call: any[]) => call[0].where.dedupeKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("mirrors without an event when there is no before-state to measure against", async () => {
    const store = makePrismaReconcileIssueStore();
    await store.updateIssue("issue-1", closedData);

    expect(mocks.upsertLifecycleEvent).not.toHaveBeenCalled();
    expect(mocks.issueUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("sweepRetiredLanes (dispatch#1589)", () => {
  interface SweepCandidate {
    id: string;
    number: number;
    currentLane?: string | null; // what the transaction's fresh read sees
    groomingSummary?: string | null;
  }

  function stubSweepQueries(laneValues: Array<string | null>, candidates: SweepCandidate[] = []) {
    mocks.issueFindMany.mockImplementation((args: any) =>
      Promise.resolve(
        args?.distinct
          ? laneValues.map((currentLane) => ({ currentLane }))
          : candidates.map((c) => ({ id: c.id, number: c.number, repository: { fullName: "org/repo" } })),
      ),
    );
    mocks.issueFindUnique.mockImplementation((args: any) => {
      const match = candidates.find((c) => c.id === args?.where?.id);
      return Promise.resolve(
        match
          ? {
              currentLane: match.currentLane === undefined ? "legacy-queue" : match.currentLane,
              groomingSummary: match.groomingSummary ?? null,
            }
          : null,
      );
    });
  }

  function runTransaction(fn: (tx: unknown) => Promise<unknown>) {
    return fn({
      issue: { findUnique: mocks.issueFindUnique, updateMany: mocks.issueUpdateMany },
      issueLane: { create: mocks.issueLaneCreate },
    });
  }

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setLaneConfig({
      lanes: [
        { id: "local", title: "Local", claimable: true, role: "default" },
        { id: "frontier", title: "Frontier", claimable: true, role: "escalation" },
        { id: "backlog", title: "Backlog", claimable: false },
      ],
      laneAliases: { normal: "local", escalated: "frontier" },
    });
    mocks.issueFindMany.mockReset().mockResolvedValue([]);
    mocks.issueUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mocks.issueLaneCreate.mockReset().mockResolvedValue({ id: "lane-1" });
    mocks.issueFindUnique.mockReset();
    mocks.transaction.mockReset().mockImplementation(runTransaction);
  });

  afterEach(() => {
    resetLaneConfig();
    vi.restoreAllMocks();
    // Restore the module-level defaults the other describes rely on.
    mocks.issueFindMany.mockReset().mockResolvedValue([]);
    mocks.issueUpdateMany.mockReset().mockResolvedValue({ count: 0 });
    mocks.issueFindUnique.mockReset();
    mocks.transaction.mockReset();
  });

  it("sweeps an issue with a retired lane id to the backlog lane with provenance", async () => {
    stubSweepQueries(["legacy-queue"], [{ id: "issue-1", number: 42 }]);

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(1);
    expect(mocks.issueFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { repositoryId: { in: ["repo-1"] }, currentLane: "legacy-queue" } }),
    );
    expect(mocks.issueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "issue-1",
          currentLane: "legacy-queue",
          groomingSummary: { equals: null },
        },
        data: expect.objectContaining({
          currentLane: "backlog",
          groomingSummary: expect.stringContaining('retired lane "legacy-queue"'),
        }),
      }),
    );
    expect(mocks.issueLaneCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          issueId: "issue-1",
          lane: "backlog",
          model: "lane-sweep",
          reason: expect.stringContaining("legacy-queue"),
        }),
      }),
    );
  });

  it("appends the sweep note without dropping an existing grooming summary", async () => {
    stubSweepQueries(["legacy-queue"], [
      { id: "issue-1", number: 42, groomingSummary: "operator note: hold for the release cut" },
    ]);

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(1);
    const summary = mocks.issueUpdateMany.mock.calls[0][0].data.groomingSummary;
    expect(summary.startsWith("operator note: hold for the release cut")).toBe(true);
    expect(summary).toContain("Lane sweep");
  });

  it("leaves an issue with an aliased lane id untouched — aliases never rewrite issue data", async () => {
    stubSweepQueries(["normal", "escalated"], []);

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(0);
    expect(mocks.issueUpdateMany).not.toHaveBeenCalled();
    expect(mocks.issueLaneCreate).not.toHaveBeenCalled();
  });

  it("leaves issues on valid configured lanes untouched, and tolerates a null lane value", async () => {
    stubSweepQueries(["local", "frontier", "backlog", null], []);

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(0);
    expect(mocks.issueUpdateMany).not.toHaveBeenCalled();
    expect(mocks.issueLaneCreate).not.toHaveBeenCalled();
  });

  it("skips a row whose lane was re-set between the candidate query and the transaction", async () => {
    // The distinct pass saw the retired id; the fresh read inside the
    // transaction sees a groomer/lane-API re-lane that landed in between.
    stubSweepQueries(["legacy-queue"], [{ id: "issue-1", number: 42, currentLane: "local" }]);

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(0);
    expect(mocks.issueUpdateMany).not.toHaveBeenCalled();
    expect(mocks.issueLaneCreate).not.toHaveBeenCalled();
  });

  it("skips a row whose write guard misses, without a history row", async () => {
    stubSweepQueries(["legacy-queue"], [{ id: "issue-1", number: 42 }]);
    mocks.issueUpdateMany.mockResolvedValue({ count: 0 }); // the guard missed

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(0);
    expect(mocks.issueLaneCreate).not.toHaveBeenCalled();
  });

  it("pins the freshly-read summary in the write guard so a concurrent summary-only groom wins", async () => {
    // The sweep reads "pre-groom summary"; a concurrent manual groom then
    // refreshes the summary WITHOUT changing the lane. The conditional write
    // must carry the read value in its WHERE clause so the concurrent write
    // wins and the sweep defers to the next sync pass.
    stubSweepQueries(["legacy-queue"], [
      { id: "issue-1", number: 42, groomingSummary: "pre-groom summary" },
    ]);
    mocks.issueUpdateMany.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.groomingSummary?.equals === "pre-groom summary" ? { count: 0 } : { count: 1 }),
    );

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(0);
    expect(mocks.issueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "issue-1",
          currentLane: "legacy-queue",
          groomingSummary: { equals: "pre-groom summary" },
        }),
      }),
    );
    expect(mocks.issueLaneCreate).not.toHaveBeenCalled();
  });

  it("skips a row whose summary was concurrently set from null — the IS NULL guard misses", async () => {
    // The sweep read a null summary (equals: null → IS NULL); a concurrent
    // groom set a summary without changing the lane, so the guard must miss.
    stubSweepQueries(["legacy-queue"], [{ id: "issue-1", number: 42 }]);
    mocks.issueUpdateMany.mockImplementation((args: any) =>
      Promise.resolve(args?.where?.groomingSummary?.equals === null ? { count: 0 } : { count: 1 }),
    );

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(0);
    expect(mocks.issueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          groomingSummary: { equals: null },
        }),
      }),
    );
    expect(mocks.issueLaneCreate).not.toHaveBeenCalled();
  });

  it("appends onto a summary that survived the guarded write — the CAS matches the row it read", async () => {
    stubSweepQueries(["legacy-queue"], [
      { id: "issue-1", number: 42, groomingSummary: "operator note" },
    ]);

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(1);
    expect(mocks.issueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          groomingSummary: { equals: "operator note" },
        }),
        data: expect.objectContaining({
          groomingSummary: expect.stringContaining("operator note"),
        }),
      }),
    );
  });

  it("rolls back a re-lane whose history row write fails — no lane change without provenance", async () => {
    stubSweepQueries(["legacy-queue"], [{ id: "issue-1", number: 42 }]);
    mocks.issueLaneCreate.mockRejectedValue(new Error("db blip"));

    const swept = await sweepRetiredLanes(["repo-1"]);

    // The mock transaction runs the writes in order; a history-write failure
    // throws out of the transaction, so the sweep reports the row un-swept
    // (a real transaction would roll the lane update back the same way).
    expect(swept).toBe(0);
    expect(mocks.issueLaneCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps sweeping other issues when one transaction fails", async () => {
    stubSweepQueries(["legacy-queue"], [
      { id: "issue-a", number: 1 },
      { id: "issue-b", number: 2 },
    ]);
    mocks.issueUpdateMany.mockImplementation((args: any) =>
      args.where.id === "issue-a"
        ? Promise.reject(new Error("db blip"))
        : Promise.resolve({ count: 1 }),
    );

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(1);
    expect(mocks.issueLaneCreate).toHaveBeenCalledTimes(1);
    expect(mocks.issueLaneCreate.mock.calls[0][0].data.issueId).toBe("issue-b");
  });

  it("does nothing when no non-claimable lane is configured (fail-safe, no query)", async () => {
    setLaneConfig({ lanes: [{ id: "work", title: "Work", claimable: true, role: "default" }] });

    const swept = await sweepRetiredLanes(["repo-1"]);

    expect(swept).toBe(0);
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
  });

  it("does nothing when no repository ids are given", async () => {
    const swept = await sweepRetiredLanes([]);
    expect(swept).toBe(0);
    expect(mocks.issueFindMany).not.toHaveBeenCalled();
  });

  it("runs automatically as part of syncIssuesForRepos, scoped to the synced repos", async () => {
    stubSweepQueries(["legacy-queue"], [{ id: "issue-1", number: 42 }]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const store: IssueStore = {
      findIssue: vi.fn().mockResolvedValue(null),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
      deleteIssue: vi.fn().mockResolvedValue(false),
    };

    const response = await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1)],
      store,
    );

    expect(response.success).toBe(true);
    expect(mocks.issueFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ["currentLane"],
        where: { repositoryId: { in: ["repo-1"] }, currentLane: { not: null } },
      }),
    );
    expect(mocks.issueUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentLane: "backlog" }),
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Lane sweep re-laned 1"));
  });

  it("a failing sweep does not fail the sync", async () => {
    mocks.issueFindMany.mockRejectedValue(new Error("db down"));
    const store: IssueStore = {
      findIssue: vi.fn().mockResolvedValue(null),
      updateIssue: vi.fn().mockResolvedValue(undefined),
      createIssue: vi.fn().mockResolvedValue(undefined),
      deleteIssue: vi.fn().mockResolvedValue(false),
    };

    const response = await syncIssuesForRepos(
      [{ id: "repo-1", fullName: "org/repo" }],
      async () => [githubIssue(1)],
      store,
    );

    expect(response.success).toBe(true);
    expect(response.syncedCount).toBe(1);
    expect(mocks.issueUpdateMany).not.toHaveBeenCalled();
  });
});
