import { describe, expect, it, beforeEach, vi } from "vitest";

// The GitHub-facing surfaces are driven by mocks: the live-label re-reads,
// the targeted label removal, and the shared claim-release policy. Everything
// else (fence evaluation, CAS, cooldown, audit) runs against a fake client.
const { githubMocks, claimGateMocks, claimMocks } = vi.hoisted(() => ({
  githubMocks: {
    removeIssueLabel: vi.fn().mockResolvedValue(undefined),
  },
  claimGateMocks: {
    getLiveIssueLabels: vi.fn(),
  },
  claimMocks: {
    releaseIssueClaim: vi.fn(),
  },
}));

vi.mock("./github", () => ({ removeIssueLabel: githubMocks.removeIssueLabel }));
vi.mock("./claim-gate", () => ({ getLiveIssueLabels: claimGateMocks.getLiveIssueLabels }));
vi.mock("./issue-claim", () => ({ releaseIssueClaim: claimMocks.releaseIssueClaim }));

import { recoverIssueCapacityHandoff, IssueCapacityHandoffClient } from "./issue-capacity-handoff";

const REPO = "org/repo";
const NUMBER = 42;
const ISSUE_ID = "issue-42";
const AGENT = "alpha";
const TOKEN = "claim_token_abc";

function makeClient(overrides: Record<string, any> = {}) {
  const audits: any[] = [];
  const mirrors: any[] = [];
  const handoffs: any[] = [];
  const client: any = {
    audits,
    mirrors,
    handoffs,
    issue: {
      findUnique: async () => ({
        id: ISSUE_ID,
        number: NUMBER,
        state: "open",
        labels: ["agent/alpha", "status/in-progress"],
        blockedReason: null,
        repository: { fullName: REPO },
      }),
      update: async ({ where, data }: any) => {
        mirrors.push({ where, data });
      },
    },
    lease: {
      findUnique: async () => ({
        id: "lease-1",
        agentName: AGENT,
        issueId: ISSUE_ID,
        claimToken: TOKEN,
        expiredAt: new Date(Date.now() + 600_000),
      }),
      deleteMany: async () => ({ count: 1 }),
    },
    agentWork: {
      findMany: async () => [],
      update: async () => ({}),
    },
    agentWorkHistory: { create: async () => ({}) },
    auditLog: {
      create: async ({ data }: any) => {
        audits.push(data);
      },
    },
    capacityHandoff: {
      create: async ({ data }: any) => {
        const row = { id: `handoff-${handoffs.length + 1}`, ...data };
        handoffs.push(row);
        return row;
      },
    },
    ...overrides,
  };
  return client as IssueCapacityHandoffClient & {
    audits: any[];
    mirrors: any[];
    handoffs: any[];
  };
}

function call(client: any, extra: Record<string, unknown> = {}) {
  return recoverIssueCapacityHandoff({
    client,
    issueId: ISSUE_ID,
    repoFullName: REPO,
    issueNumber: NUMBER,
    agentName: AGENT,
    claimToken: TOKEN,
    capacity: "provider/model-a",
    actor: AGENT,
    ...extra,
  });
}

describe("recoverIssueCapacityHandoff (#1256)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubMocks.removeIssueLabel.mockResolvedValue(undefined);
    claimGateMocks.getLiveIssueLabels.mockResolvedValue(["agent/alpha", "status/in-progress"]);
    claimMocks.releaseIssueClaim.mockResolvedValue({
      labels: ["status/ready"],
      status: "status/ready",
      statusNote: null,
    });
  });

  it("happy path: same live owner post-CAS takes the full release policy", async () => {
    const client = makeClient();
    const result = await call(client);
    expect(result.ok).toBe(true);
    expect(claimMocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    // The full policy owns the label writes; the handoff itself adds none.
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.handoffs[0]).toMatchObject({ kind: "issue", capacity: "provider/model-a" });
    expect(client.audits.at(-1)).toMatchObject({ success: true });
    expect(client.audits.at(-1).notes).not.toMatch(/ownership-only/);
  });

  it("post-CAS re-read shows a new owner: ownership-only release, never a status transition (#1256 review)", async () => {
    claimGateMocks.getLiveIssueLabels
      .mockResolvedValueOnce(["agent/alpha", "status/in-progress"])
      .mockResolvedValueOnce(["agent/omega", "status/in-progress"]);
    const client = makeClient();
    const result = await call(client);
    expect(result.ok).toBe(true);
    // The shared release policy (which flips in-progress → ready) is skipped.
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    // Only our own label is removed; the new owner's status survives.
    expect(githubMocks.removeIssueLabel).toHaveBeenCalledTimes(1);
    expect(githubMocks.removeIssueLabel).toHaveBeenCalledWith(REPO, NUMBER, "agent/alpha");
    if (!result.ok) throw new Error("unreachable");
    expect(result.status).toBe("status/in-progress");
    expect(result.statusNote).toMatch(/claim moved to agent\/omega/);
    expect(result.statusNote).toMatch(/no status change/);
    // The cache mirrors the LIVE set minus our label.
    expect(client.mirrors[0].data.labels).toEqual(["agent/omega", "status/in-progress"]);
    expect(client.audits.at(-1).notes).toMatch(/ownership changed post-CAS/);
  });

  it("post-CAS re-read FAILS: ownership-only cleanup, never a status transition (#1256 review)", async () => {
    claimGateMocks.getLiveIssueLabels
      .mockResolvedValueOnce(["agent/alpha", "status/in-progress"])
      .mockRejectedValueOnce(new Error("github unavailable"));
    const client = makeClient();
    const result = await call(client);
    // The lease is already consumed — halting would strand the claim — but
    // ownership is UNKNOWN, so the release must never touch status.
    expect(result.ok).toBe(true);
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(githubMocks.removeIssueLabel).toHaveBeenCalledTimes(1);
    expect(githubMocks.removeIssueLabel).toHaveBeenCalledWith(REPO, NUMBER, "agent/alpha");
    if (!result.ok) throw new Error("unreachable");
    // The resting status stays in-progress (mirrored), NOT flipped to ready:
    // a stale snapshot must not clobber a possible new owner's transition.
    expect(result.status).toBe("status/in-progress");
    expect(result.statusNote).toMatch(/re-read failed/);
    expect(result.statusNote).toMatch(/no status change/);
    expect(client.mirrors[0].data.labels).toEqual(["status/in-progress"]);
    expect(client.audits.at(-1).notes).toMatch(/re-read failed/);
    expect(client.audits.at(-1).notes).toMatch(/ownership-only/);
    // The handoff itself (lease gone, cooldown recorded) still completes.
    expect(client.handoffs[0]).toMatchObject({ kind: "issue", capacity: "provider/model-a" });
  });

  it("no tokened claim: refuses without pointing the worker at an unscoped unclaim", async () => {
    const client = makeClient({
      lease: {
        findUnique: async () => ({ id: "lease-1", agentName: AGENT, issueId: ISSUE_ID, claimToken: null, expiredAt: new Date(Date.now() + 600_000) }),
        deleteMany: async () => ({ count: 1 }),
      },
    });
    const result = await call(client);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_active_claim");
    expect(result.message).toMatch(/re-claim/);
    // The legacy unclaim path is exactly the unfenced release this endpoint
    // replaces; the refusal must not recommend it.
    expect(result.message).not.toMatch(/^use unclaim|use unclaim for a legacy claim/);
    expect(result.message).toMatch(/do not force an unclaim/);
    expect(client.audits).toHaveLength(0);
    expect(client.handoffs).toHaveLength(0);
  });
});
