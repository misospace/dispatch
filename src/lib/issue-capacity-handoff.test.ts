import { describe, expect, it, beforeEach, vi } from "vitest";

const { githubMocks, claimGateMocks, claimMocks, guardState } = vi.hoisted(() => ({
  guardState: { resuming: false },
  githubMocks: { removeIssueLabel: vi.fn().mockResolvedValue(undefined) },
  claimGateMocks: { getLiveIssueLabels: vi.fn() },
  claimMocks: { releaseIssueClaim: vi.fn() },
}));

vi.mock("./github", () => ({ removeIssueLabel: githubMocks.removeIssueLabel }));
vi.mock("./claim-gate", () => ({ getLiveIssueLabels: claimGateMocks.getLiveIssueLabels }));
vi.mock("./issue-claim", () => ({ releaseIssueClaim: claimMocks.releaseIssueClaim }));
vi.mock("./issue-mutation-guard", () => ({
  withIssueMutationGuard: async (_request: unknown, callback: (...args: any[]) => Promise<{ complete: boolean; value: unknown }>) => ({
    status: "completed", value: (await callback(undefined, { resuming: guardState.resuming })).value,
  }),
}));

import { recoverIssueCapacityHandoff, IssueCapacityHandoffClient } from "./issue-capacity-handoff";

const REPO = "org/repo", NUMBER = 42, ISSUE_ID = "issue-42", AGENT = "alpha", TOKEN = "claim_token_abc";

function makeClient(overrides: Record<string, any> = {}) {
  const audits: any[] = [], mirrors: any[] = [], handoffs: any[] = [];
  const client: any = {
    audits, mirrors, handoffs,
    issue: {
      findUnique: async () => ({ id: ISSUE_ID, number: NUMBER, state: "open", labels: ["agent/alpha", "status/in-progress"], blockedReason: null, repository: { fullName: REPO } }),
      update: async ({ where, data }: any) => mirrors.push({ where, data }),
    },
    lease: {
      findUnique: async () => ({ id: "lease-1", agentName: AGENT, issueId: ISSUE_ID, claimToken: TOKEN, expiredAt: new Date(Date.now() + 600_000) }),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    agentWork: { findMany: async () => [], update: async () => ({}) },
    agentWorkHistory: { create: async () => ({}) },
    auditLog: { create: async ({ data }: any) => audits.push(data) },
    capacityHandoff: { create: async ({ data }: any) => { const row = { id: `handoff-${handoffs.length + 1}`, ...data }; handoffs.push(row); return row; } },
    ...overrides,
  };
  return client as IssueCapacityHandoffClient & { audits: any[]; mirrors: any[]; handoffs: any[] };
}

function call(client: any) {
  return recoverIssueCapacityHandoff({ client, issueId: ISSUE_ID, repoFullName: REPO, issueNumber: NUMBER, agentName: AGENT, claimToken: TOKEN, capacity: "provider/model-a", actor: AGENT });
}

describe("recoverIssueCapacityHandoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardState.resuming = false;
    githubMocks.removeIssueLabel.mockResolvedValue(undefined);
    claimGateMocks.getLiveIssueLabels.mockResolvedValue(["agent/alpha", "status/in-progress"]);
    claimMocks.releaseIssueClaim.mockResolvedValue({ labels: ["status/ready"], status: "status/ready", statusNote: null });
  });

  it("releases through the full policy after both live reads succeed", async () => {
    const client = makeClient();
    expect((await call(client)).ok).toBe(true);
    expect(claimMocks.releaseIssueClaim).toHaveBeenCalledTimes(1);
    expect(client.lease.deleteMany).toHaveBeenCalledTimes(1);
  });

  it.each(["status/blocked", "status/done"])("refuses late %s without ownership or lease mutation", async (status) => {
    claimGateMocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/alpha", "status/in-progress"]).mockResolvedValueOnce(["agent/alpha", status]);
    const client = makeClient();
    expect(await call(client)).toMatchObject({ ok: false, code: status === "status/blocked" ? "human_hold" : "issue_done" });
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
  });

  it("second read failure returns 503 without writes and retains lease", async () => {
    claimGateMocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/alpha", "status/in-progress"]).mockRejectedValueOnce(new Error("offline"));
    const client = makeClient();
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 503, code: "github_unavailable" });
    expect(githubMocks.removeIssueLabel).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
    expect(client.audits.at(-1)).toMatchObject({ success: false });
  });

  it("failed targeted removal returns 500 without cache mirroring", async () => {
    claimGateMocks.getLiveIssueLabels.mockResolvedValueOnce(["agent/alpha", "status/in-progress"]).mockResolvedValueOnce(["agent/omega", "status/in-progress"]);
    githubMocks.removeIssueLabel.mockRejectedValueOnce(new Error("write failed"));
    const client = makeClient();
    const result = await call(client);
    expect(result).toMatchObject({ ok: false, httpStatus: 500, code: "release_failed" });
    expect(client.lease.deleteMany).not.toHaveBeenCalled();
    expect(client.mirrors).toHaveLength(0);
    expect(client.audits.at(-1)).toMatchObject({ success: false });
  });

  it("resumes exact-token cleanup after prior label removal without changing resting status", async () => {
    guardState.resuming = true;
    claimGateMocks.getLiveIssueLabels.mockResolvedValue(["status/in-progress"]);
    const client = makeClient();
    const result = await call(client);
    expect(result).toMatchObject({ ok: true, status: "status/in-progress" });
    expect(claimMocks.releaseIssueClaim).not.toHaveBeenCalled();
    expect(client.lease.deleteMany).toHaveBeenCalledWith({ where: { id: "lease-1", agentName: AGENT, issueId: ISSUE_ID, claimToken: TOKEN } });
  });

  it("refuses a claim without a token", async () => {
    const client = makeClient({ lease: { findUnique: async () => ({ id: "lease-1", claimToken: null, expiredAt: new Date(Date.now() + 600_000) }), deleteMany: vi.fn() } });
    expect(await call(client)).toMatchObject({ ok: false, code: "no_active_claim" });
    expect(client.audits).toHaveLength(0);
  });
});
