import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the GitHub adapters so no test touches the network. `transitionIssueStatus`
// is run for real (it only delegates to the mocked add/remove primitives), which
// is exactly how the production unclaim route and stale-work recovery compose it.
vi.mock("@/lib/github", () => ({
  addIssueLabel: vi.fn(),
  removeIssueLabel: vi.fn(),
}));

vi.mock("@/lib/github-prs", () => ({
  fetchPullRequestState: vi.fn(),
}));

import { addIssueLabel, removeIssueLabel } from "@/lib/github";
import { fetchPullRequestState } from "@/lib/github-prs";

import { releaseIssueClaim, type IssueClaimClient } from "./issue-claim";

const addIssueLabelMock = addIssueLabel as ReturnType<typeof vi.fn>;
const removeIssueLabelMock = removeIssueLabel as ReturnType<typeof vi.fn>;
const fetchPullRequestStateMock = fetchPullRequestState as ReturnType<typeof vi.fn>;

const REPO = "octocat/hello-world";
const ISSUE_NUMBER = 42;

/**
 * A `PrismaClient` stand-in, matching the pattern used by the other lib tests:
 * the function under test receives the client as a plain parameter, so we only
 * need the narrow `issue` surface it reads and writes. No database is opened.
 */
function makePrisma(overrides: Partial<{ labels: string[] }> = {}) {
  const findUnique = vi.fn((args: { where: { id: string }; select: { labels: true } }) =>
    Promise.resolve({ labels: overrides.labels }),
  );
  const update = vi.fn((args: { where: { id: string }; data: any }) =>
    Promise.resolve({ id: args.where.id }),
  );
  return {
    client: { issue: { findUnique, update } } as IssueClaimClient,
    findUnique,
    update,
  };
}

function callRelease(
  client: IssueClaimClient,
  labels: string[],
  options: {
    agentName?: string;
    blockedReason?: string | null;
    linkedPrNumber?: number | null;
    releaseOptions?: Parameters<typeof releaseIssueClaim>[0]["options"];
  },
) {
  const issue = {
    id: "issue-1",
    state: "open",
    labels,
    blockedReason: options.blockedReason ?? null,
    linkedPrNumber: options.linkedPrNumber ?? null,
  };
  return releaseIssueClaim({
    prisma: client,
    issue,
    repoFullName: REPO,
    issueNumber: ISSUE_NUMBER,
    agentName: options.agentName ?? "alpha",
    options: options.releaseOptions,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  addIssueLabelMock.mockResolvedValue(undefined);
  removeIssueLabelMock.mockResolvedValue(undefined);
  fetchPullRequestStateMock.mockResolvedValue({ state: "open", mergedAt: null });
});

describe("releaseIssueClaim — regular release (operator unclaim resting-status policy)", () => {
  it("flips status/in-progress to status/ready and mirrors the result in the cache", async () => {
    const { client, findUnique, update } = makePrisma();

    const result = await callRelease(client, ["agent/alpha", "status/in-progress"], {});

    expect(result).toEqual({
      released: true,
      labels: ["status/ready"],
      status: "status/ready",
      statusNote: null,
    });

    // Targeted label writes only — the agent label is removed directly and the
    // status transition uses the add/remove primitives (never a full-set write).
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(2);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "status/in-progress");
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(addIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "status/ready");

    // The cache mirrors the returned (post-transition) label set.
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/ready"], lastSyncedAt: expect.any(Date) },
    });
    // No re-read is needed on the regular path.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("flips an unexplained status/blocked (null blockedReason) to status/ready", async () => {
    const { client, update } = makePrisma();

    const result = await callRelease(client, ["agent/alpha", "status/blocked"], {
      blockedReason: null,
    });

    expect(result).toEqual({
      released: true,
      labels: ["status/ready"],
      status: "status/ready",
      statusNote: null,
    });
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "status/blocked");
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "status/ready");
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/ready"], lastSyncedAt: expect.any(Date) },
    });
  });

  it("keeps a deliberate status/blocked (blockedReason set) unchanged and explains why", async () => {
    const { client, update } = makePrisma();

    const result = await callRelease(client, ["agent/alpha", "status/blocked"], {
      blockedReason: "waiting on an upstream API change",
    });

    // Ownership is released but the status label is deliberately retained.
    expect(result).toEqual({
      released: true,
      labels: ["status/blocked"],
      status: "status/blocked",
      statusNote:
        "status/blocked retained: blockedReason is set, so the block was a deliberate decision",
    });

    // Only the agent label is removed — no status transition at all.
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/blocked"], lastSyncedAt: expect.any(Date) },
    });
  });

  it("keeps status/in-review unchanged while the linked PR is still open", async () => {
    const { client, update } = makePrisma();

    // beforeEach already sets the PR state to "open"; assert it is consulted.
    const result = await callRelease(client, ["agent/alpha", "status/in-review"], {
      linkedPrNumber: 7,
    });

    expect(result).toEqual({
      released: true,
      labels: ["status/in-review"],
      status: "status/in-review",
      statusNote: "status/in-review retained: linked PR #7 is still open",
    });
    // No status transition — only the agent label is removed.
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(fetchPullRequestStateMock).toHaveBeenCalledWith(REPO, 7);
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/in-review"], lastSyncedAt: expect.any(Date) },
    });
  });

  it("keeps status/in-review unchanged when no linked PR is recorded and tells the caller to move it", async () => {
    const { client, update } = makePrisma();

    const result = await callRelease(client, ["agent/alpha", "status/in-review"], {
      linkedPrNumber: null,
    });

    expect(result).toEqual({
      released: true,
      labels: ["status/in-review"],
      status: "status/in-review",
      statusNote:
        "status/in-review retained: no linked PR recorded; use set_issue_status to move the issue",
    });
    // No PR state fetch needed when there is no linked PR.
    expect(fetchPullRequestStateMock).not.toHaveBeenCalled();
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/in-review"], lastSyncedAt: expect.any(Date) },
    });
  });
});

describe("releaseIssueClaim — preserveStatus (stale-work recovery, ownership-only)", () => {
  it("removes the agent label but leaves an in-progress status label untouched", async () => {
    // The stale caller must never drag an in-progress issue back to ready.
    const { client, findUnique, update } = makePrisma({
      labels: ["agent/alpha", "status/in-progress"],
    });

    const result = await callRelease(client, ["agent/alpha", "status/in-progress"], {
      releaseOptions: { preserveStatus: true },
    });

    expect(result).toEqual({
      released: true,
      labels: ["status/in-progress"],
      status: "status/in-progress",
      statusNote: null,
    });

    // Ownership-only: the agent label is removed directly, and no status label
    // is ever added or removed.
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).not.toHaveBeenCalled();

    // The cache re-reads the current label set, drops only the agent label, and
    // writes it back.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      select: { labels: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/in-progress"], lastSyncedAt: expect.any(Date) },
    });
  });

  it("preserves non-status labels (a cache ahead of the stale caller's snapshot)", async () => {
    // findUnique returns the freshest labels, which include a label the stale
    // caller's snapshot did not have. Only the agent label may be dropped.
    const { client, update } = makePrisma({
      labels: ["agent/alpha", "status/in-review", "priority/p1"],
    });

    const result = await callRelease(
      client,
      ["agent/alpha", "status/in-review"], // caller's (older) snapshot
      { releaseOptions: { preserveStatus: true } },
    );

    expect(result).toEqual({
      released: true,
      labels: ["status/in-review", "priority/p1"],
      status: "status/in-review",
      statusNote: null,
    });
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/in-review", "priority/p1"], lastSyncedAt: expect.any(Date) },
    });
  });

  it("falls back to the caller's snapshot minus the agent label when there is no re-read", async () => {
    // IssueClaimClient.findUnique is optional; when absent the caller's own
    // label set is the best source of truth available.
    const { client, update } = makePrisma();
    delete (client as unknown as { issue: { findUnique?: unknown } }).issue.findUnique;

    const result = await callRelease(client, ["agent/alpha", "status/in-progress"], {
      releaseOptions: { preserveStatus: true },
    });

    expect(result).toEqual({
      released: true,
      labels: ["status/in-progress"],
      status: "status/in-progress",
      statusNote: null,
    });
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/in-progress"], lastSyncedAt: expect.any(Date) },
    });
  });
});

describe("releaseIssueClaim — allowMissingAgent (idempotent repair of a stale cache)", () => {
  it("repairs a cache that is behind GitHub without touching other labels", async () => {
    // The caller's cached row already lacks the agent label (a previous sync
    // cleaned it), so the code takes the idempotent-repair branch. It must
    // re-issue the (no-op) GitHub remove, re-read the freshest label set, and
    // mirror it back verbatim — it must not add or remove any other label.
    const { client, findUnique, update } = makePrisma({
      // Fresh re-read: a non-status label that appeared on GitHub since the
      // caller's last sync.
      labels: ["status/ready", "priority/p1"],
    });

    // The caller's (stale) snapshot has no agent label and is missing the
    // non-status label, which is exactly what "behind GitHub" means here.
    const result = await callRelease(client, ["status/ready"], {
      releaseOptions: { allowMissingAgent: true },
    });

    // The cache is refreshed from the re-read, verbatim — the fresh non-status
    // label is picked up and nothing else is added or removed.
    expect(result).toEqual({
      released: true,
      labels: ["status/ready", "priority/p1"],
      status: "status/ready",
      statusNote: "agent claim already released: agent label is absent",
    });

    // The idempotent GitHub repair is the only adapter call; no status label is
    // added or removed.
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).not.toHaveBeenCalled();

    // The cache is re-read and written back with the fresh set, and the sync
    // timestamp is bumped.
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      select: { labels: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/ready", "priority/p1"], lastSyncedAt: expect.any(Date) },
    });
  });

  it("falls back to the caller's snapshot when there is no re-read", async () => {
    const { client, update } = makePrisma();
    delete (client as unknown as { issue: { findUnique?: unknown } }).issue.findUnique;

    const result = await callRelease(client, ["status/ready"], {
      releaseOptions: { allowMissingAgent: true },
    });

    expect(result).toEqual({
      released: true,
      labels: ["status/ready"],
      status: "status/ready",
      statusNote: "agent claim already released: agent label is absent",
    });
    expect(removeIssueLabelMock).toHaveBeenCalledTimes(1);
    expect(removeIssueLabelMock).toHaveBeenCalledWith(REPO, ISSUE_NUMBER, "agent/alpha");
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "issue-1" },
      data: { labels: ["status/ready"], lastSyncedAt: expect.any(Date) },
    });
  });
});

describe("releaseIssueClaim — ownership guard", () => {
  it("never removes a newer agent's claim while an old AgentWork row is being recovered", async () => {
    const { client, findUnique, update } = makePrisma();

    // The issue is now claimed by a *different* (newer) agent; the release was
    // requested on behalf of the old agent "alpha".
    const result = await callRelease(
      client,
      ["agent/beta", "status/in-progress"],
      { agentName: "alpha" },
    );

    expect(result).toEqual({
      released: false,
      labels: ["agent/beta", "status/in-progress"],
      status: "status/in-progress",
      statusNote: null,
      skipReason: "agent claim belongs to agent/beta",
    });

    // No side effects of any kind: no GitHub writes, no cache writes.
    expect(removeIssueLabelMock).not.toHaveBeenCalled();
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("releaseIssueClaim — guards", () => {
  it("throws without side effects when the agent is not assigned and allowMissingAgent is not set", async () => {
    const { client, findUnique, update } = makePrisma();

    await expect(
      callRelease(client, ["status/ready"], { agentName: "alpha" }),
    ).rejects.toThrow("Issue is not assigned to alpha");

    expect(removeIssueLabelMock).not.toHaveBeenCalled();
    expect(addIssueLabelMock).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
