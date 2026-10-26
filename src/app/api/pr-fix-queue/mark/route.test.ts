import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMockWithSafeEqual, authedRequest } from "@/test/route-helpers";

const { WORKER_TOKEN, BOUND_WORKER_TOKEN } = vi.hoisted(() => ({
  // Legacy unbound worker credential (no agent identity).
  WORKER_TOKEN: "worker-token",
  // Bound worker credential (#1428): authenticates as agent "alpha".
  BOUND_WORKER_TOKEN: "bound-worker-token",
}));

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () =>
  makeDispatchEnvMockWithSafeEqual(
    mockToken,
    { [WORKER_TOKEN]: "worker" },
    { [BOUND_WORKER_TOKEN]: "alpha" },
  ),
);

const { mocks } = vi.hoisted(() => ({
  mocks: {
    prFixQueueClient: vi.fn(),
    parseMarkPrFixInput: vi.fn(),
    markPrFixItem: vi.fn().mockResolvedValue({ mutated: true, item: { id: "fix-1" } }),
    auditLogCreate: vi.fn().mockResolvedValue({ id: "log-1" }),
    isPrFixRepoArchived: vi.fn().mockResolvedValue(false),
  },
}));

const mergeStateMock = vi.fn();
vi.mock("@/lib/github-prs", () => ({
  fetchPullRequestMergeState: (...args: unknown[]) => mergeStateMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { create: mocks.auditLogCreate },
  },
  asPrFixQueueClient: mocks.prFixQueueClient,
}));

vi.mock("@/lib/pr-fix-queue", () => ({
  parseMarkPrFixInput: mocks.parseMarkPrFixInput,
  markPrFixItem: mocks.markPrFixItem,
  isPrFixRepoArchived: mocks.isPrFixRepoArchived,
}));

import { POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";

function postRequest(body: unknown, includeAuth = true) {
  return POST(authedRequest("http://localhost/api/pr-fix-queue/mark", { method: "POST", body, includeAuth }));
}

describe("POST /api/pr-fix-queue/mark", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "DONE" });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "DONE" } });
    mocks.auditLogCreate.mockResolvedValue({ id: "log-1" });
    mocks.isPrFixRepoArchived.mockResolvedValue(false);
  });

  it("returns 401 when no auth header is present", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE" }, false);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 for bad bearer token", async () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: "Bearer wrong-token",
    };
    const res = await POST(
      new Request("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        headers,
        body: JSON.stringify({ repo: "org/repo", pr: 42, status: "DONE" }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mockToken}`,
        },
        body: "not-json",
      }),
    );

    expect(res.status).toBe(400);
  });

  it("delegates validation errors from parseMarkPrFixInput", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ error: "repo is required" });

    const res = await postRequest({});

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("repo is required");
  });

  it("returns 400 for a bearer mark without a generation (#1074)", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("generation is required for agent/bridge marks (#1074)");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("marks item and creates audit log on success (bearer with generation)", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "org/repo", pr: 42, status: "DONE", expectedGeneration: 2,
    });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "DONE" } });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE", generation: 2 });

    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedGeneration: 2 }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });

  it("allows an operator mark without a generation (disabled mode)", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    resetAuthCaches();
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "DONE" } });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE" }, false);

    expect(res.status).toBe(200);
    // No expectedGeneration on the input: the operator mark is unconditional.
    // #1218 review: the route forwards the auth tier so markPrFixItem can
    // honor the commit-time status pin correctly.
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      repo: "org/repo", pr: 42, status: "DONE", actorTier: "maintainer",
    }));
  });

  it("allows an operator mark without a generation (basic mode)", async () => {
    process.env.DISPATCH_AUTH_MODE = "basic";
    process.env.DISPATCH_AUTH_USERNAME = "op";
    process.env.DISPATCH_AUTH_PASSWORD = "op-pass";
    resetAuthCaches();
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "DONE" } });

    const res = await POST(
      new Request("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from("op:op-pass").toString("base64")}`,
        },
        body: JSON.stringify({ repo: "org/repo", pr: 42, status: "DONE" }),
      }),
    );

    expect(res.status).toBe(200);
    // No expectedGeneration on the input: the operator mark is unconditional.
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      repo: "org/repo", pr: 42, status: "DONE", actorTier: "maintainer",
    }));
  });

  it("returns 404 when item not found", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "org/repo", pr: 42, status: "DONE", expectedGeneration: 2,
    });
    mocks.markPrFixItem.mockResolvedValue({ mutated: false, reason: "not-found" });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE", generation: 2 });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("PR fix queue item not found");
  });

  it("returns 500 on database error", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "org/repo", pr: 42, status: "DONE", expectedGeneration: 2,
    });
    mocks.markPrFixItem.mockRejectedValue(new Error("db connection lost"));

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE", generation: 2 });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to mark PR fix queue item");
  });

  it("unauthorized request does not call prisma", async () => {
    await postRequest({ repo: "org/repo", pr: 42, status: "DONE" }, false);

    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  // The item moved to a newer attempt between the caller's read and this
  // write: the generation-conditional write matched nothing.
  it("returns 409 when the expected generation no longer matches the item", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "org/repo", pr: 42, status: "DONE", expectedGeneration: 2,
    });
    mocks.markPrFixItem.mockResolvedValue({ mutated: false, reason: "generation-mismatch" });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "DONE", generation: 2 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("generation mismatch");
    expect(body.error).toContain("2");
    // A skipped mark is not audited as a mutation.
    expect(mocks.auditLogCreate).not.toHaveBeenCalled();
  });

  it("refuses a mark back to QUEUED for an archived repo (#1106)", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "QUEUED", expectedGeneration: 1 });
    mocks.isPrFixRepoArchived.mockResolvedValue(true);

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "QUEUED", generation: 1 });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Cannot requeue: repository is archived");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("does not look up archived state for non-QUEUED marks (#1106)", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "BLOCKED", expectedGeneration: 1 });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "BLOCKED", generation: 1 });

    expect(res.status).toBe(200);
    expect(mocks.isPrFixRepoArchived).not.toHaveBeenCalled();
  });
});

describe("POST /api/pr-fix-queue/mark — worker tier (#1111)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.auditLogCreate.mockResolvedValue({ id: "log-1" });
    mocks.isPrFixRepoArchived.mockResolvedValue(false);
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "FIXED" } });
  });

  // Bound worker credential (#1428): the legacy unbound token is refused on
  // this route, so the settlement-capable worker tests act as agent "alpha".
  // The `x-agent-name` header stays on the request to prove the bound token's
  // identity — not the header — is what the route trusts.
  function workerPost(body: unknown) {
    return POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body,
        token: BOUND_WORKER_TOKEN,
        headers: { "x-agent-name": "worker-agent" },
      }),
    );
  }

  it("allows a worker to mark an item WAITING_EXTERNAL with the exact generation", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "WAITING_EXTERNAL", expectedGeneration: 2 });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "WAITING_EXTERNAL" } });
    const res = await workerPost({ repo: "org/repo", pr: 42, status: "WAITING_EXTERNAL", generation: 2 });
    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "WAITING_EXTERNAL", expectedGeneration: 2 }));
  });

  it("rejects a worker external wait without a generation", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "WAITING_EXTERNAL" });
    const res = await workerPost({ repo: "org/repo", pr: 42, status: "WAITING_EXTERNAL" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("generation is required for WAITING_EXTERNAL");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("allows a worker to mark an item FIXED with a generation", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "FIXED", expectedGeneration: 2 });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "FIXED" } });

    const res = await workerPost({ repo: "org/repo", pr: 42, status: "FIXED", generation: 2 });

    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "FIXED", expectedGeneration: 2 }),
    );
  });

  it("returns 403 when a worker marks an item QUEUED", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "QUEUED", expectedGeneration: 2 });

    const res = await workerPost({ repo: "org/repo", pr: 42, status: "QUEUED", generation: 2 });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Marking an item QUEUED or IGNORED requires a maintainer token");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "pr_fix_mark",
        success: false,
        errorMessage: "Marking an item QUEUED or IGNORED requires a maintainer token",
      }),
    });
  });

  it("still returns 403 when the worker denial audit write fails", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "QUEUED", expectedGeneration: 2 });
    // The 403 path's audit row is best-effort: a failing write must not
    // mask the denial or settle the queue item.
    mocks.auditLogCreate.mockRejectedValueOnce(new Error("db down"));

    const res = await workerPost({ repo: "org/repo", pr: 42, status: "QUEUED", generation: 2 });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Marking an item QUEUED or IGNORED requires a maintainer token");
    // The write was attempted (then failed) with the denial payload; the
    // queue item is untouched.
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    // The bound token's identity ("alpha") is the audit actor; the
    // caller-supplied `x-agent-name` header never overrides it (#1322).
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "pr_fix_mark",
        success: false,
        errorMessage: "Marking an item QUEUED or IGNORED requires a maintainer token",
        actor: "alpha",
        repoFullName: "org/repo",
        issueNumber: null,
      }),
    });
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("returns 403 when a worker marks an item IGNORED", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "IGNORED", expectedGeneration: 2 });

    const res = await workerPost({ repo: "org/repo", pr: 42, status: "IGNORED", generation: 2 });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Marking an item QUEUED or IGNORED requires a maintainer token");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("allows a maintainer to mark an item QUEUED", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "QUEUED", expectedGeneration: 2 });
    mocks.isPrFixRepoArchived.mockResolvedValue(false);
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "QUEUED" } });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "QUEUED", generation: 2 });

    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalled();
  });
});

describe("POST /api/pr-fix-queue/mark — alreadyAddressed merge gate (#1121)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.isPrFixRepoArchived.mockResolvedValue(false);
    mocks.auditLogCreate.mockResolvedValue({ id: "log-1" });
  });

  // Bound worker credential (#1428): the unbound legacy token is refused on
  // this route before any settlement logic runs.
  function workerMark(body: unknown) {
    return POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body,
        token: BOUND_WORKER_TOKEN,
        headers: { "x-agent-name": "worker-agent" },
      }),
    );
  }

  it("refuses a worker already-addressed mark on a non-mergeable PR and does not settle", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "o/r", pr: 42, status: "FIXED", alreadyAddressed: true, evidence: "sha", expectedGeneration: 2,
    });
    mergeStateMock.mockResolvedValue({ mergeable: false, mergeableState: "CONFLICTING" });

    const res = await workerMark({ repo: "o/r", pr: 42, status: "FIXED", alreadyAddressed: true, evidence: "sha", generation: 2 });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("not mergeable");
    expect(mergeStateMock).toHaveBeenCalledWith("o/r", 42);
    expect(mergeStateMock).toHaveBeenCalledTimes(1);
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("settles a worker already-addressed mark when the PR is mergeable (unchanged head allowed)", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "o/r", pr: 42, status: "FIXED", alreadyAddressed: true, evidence: "sha", expectedGeneration: 2,
    });
    mergeStateMock.mockResolvedValue({ mergeable: true, mergeableState: "clean" });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "FIXED" } });

    const res = await workerMark({ repo: "o/r", pr: 42, status: "FIXED", alreadyAddressed: true, evidence: "sha", generation: 2 });

    expect(res.status).toBe(200);
    expect(mergeStateMock).toHaveBeenCalledWith("o/r", 42);
    expect(mergeStateMock).toHaveBeenCalledTimes(1);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "FIXED", alreadyAddressed: true }),
    );
  });

  it("defers with 503 retry-later when the merge-state check throws", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "o/r", pr: 42, status: "FIXED", alreadyAddressed: true, expectedGeneration: 2,
    });
    mergeStateMock.mockRejectedValue(new Error("token header build failed"));

    const res = await workerMark({ repo: "o/r", pr: 42, status: "FIXED", alreadyAddressed: true, generation: 2 });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("retry later");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("defers with 503 retry-later when merge state is unknown (null), not a terminal verdict", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "o/r", pr: 42, status: "FIXED", alreadyAddressed: true, expectedGeneration: 2,
    });
    // fetchPullRequestMergeState returns { mergeable: null } (never throws) for
    // both "GitHub still computing" and "GitHub unreachable".
    mergeStateMock.mockResolvedValue({ mergeable: null, mergeableState: null });

    const res = await workerMark({ repo: "o/r", pr: 42, status: "FIXED", alreadyAddressed: true, generation: 2 });

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("retry later");
    expect(mergeStateMock).toHaveBeenCalledWith("o/r", 42);
    expect(mergeStateMock).toHaveBeenCalledTimes(1);
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("does NOT run the merge gate for a plain FIXED mark (no alreadyAddressed)", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "o/r", pr: 42, status: "FIXED", expectedGeneration: 2 });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "FIXED" } });

    const res = await postRequest({ repo: "o/r", pr: 42, status: "FIXED", generation: 2 });

    expect(res.status).toBe(200);
    expect(mergeStateMock).not.toHaveBeenCalled();
    expect(mocks.markPrFixItem).toHaveBeenCalled();
  });
});

describe("POST /api/pr-fix-queue/mark — hand-out scope (#1428)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "FIXED", expectedGeneration: 2 });
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "FIXED" } });
    mocks.auditLogCreate.mockResolvedValue({ id: "log-1" });
    mocks.isPrFixRepoArchived.mockResolvedValue(false);
  });

  it("refuses the legacy unbound DISPATCH_WORKER_TOKEN (no identity to bind)", async () => {
    const res = await POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body: { repo: "org/repo", pr: 42, status: "FIXED", generation: 2 },
        token: WORKER_TOKEN,
        headers: { "x-agent-name": "some-agent" },
      }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Worker token is not bound to an agent");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("refuses the unbound token even for the statuses it used to carry", async () => {
    mocks.parseMarkPrFixInput.mockReturnValue({ repo: "org/repo", pr: 42, status: "BLOCKED", expectedGeneration: 2 });

    const res = await POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body: { repo: "org/repo", pr: 42, status: "BLOCKED", generation: 2 },
        token: WORKER_TOKEN,
      }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Worker token is not bound to an agent");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });

  it("forwards the bound token's agent as the hand-out scope, never the header", async () => {
    const res = await POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body: { repo: "org/repo", pr: 42, status: "FIXED", generation: 2 },
        token: BOUND_WORKER_TOKEN,
        headers: { "x-agent-name": "someone-else" },
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "FIXED", expectedGeneration: 2, handoutScopedAgent: "alpha" }),
    );
  });

  it("maps not-handed to a 403 refusal with a reason outside the outcome vocabulary", async () => {
    mocks.markPrFixItem.mockResolvedValue({ mutated: false, reason: "not-handed" });

    const res = await POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body: { repo: "org/repo", pr: 42, status: "FIXED", generation: 2 },
        token: BOUND_WORKER_TOKEN,
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("not-handed");
    expect(body.error).toContain("not handed to the authenticated agent");
    // The refusal is audited best-effort with the bound identity.
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "pr_fix_mark",
        success: false,
        actor: "alpha",
        errorMessage: expect.stringContaining("holds no hand-out"),
      }),
    });
  });

  it("still returns 403 when the not-handed denial audit write fails", async () => {
    mocks.markPrFixItem.mockResolvedValue({ mutated: false, reason: "not-handed" });
    mocks.auditLogCreate.mockRejectedValueOnce(new Error("db down"));

    const res = await POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body: { repo: "org/repo", pr: 42, status: "FIXED", generation: 2 },
        token: BOUND_WORKER_TOKEN,
      }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("not-handed");
  });

  it("a maintainer bearer mark carries no hand-out scope", async () => {
    const res = await postRequest({ repo: "org/repo", pr: 42, status: "FIXED", generation: 2 });

    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorTier: "maintainer" }),
    );
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ handoutScopedAgent: expect.anything() }),
    );
  });

  it("an auth-disabled operator mark carries no hand-out scope", async () => {
    process.env.DISPATCH_AUTH_MODE = "disabled";
    resetAuthCaches();

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "FIXED" }, false);

    expect(res.status).toBe(200);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ handoutScopedAgent: expect.anything() }),
    );
  });
});

describe("POST /api/pr-fix-queue/mark — hand-out-scoped external wait replay (#1430)", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_AUTH_MODE;
    resetAuthCaches();
    vi.clearAllMocks();
    mocks.prFixQueueClient.mockReturnValue({});
    mocks.parseMarkPrFixInput.mockReturnValue({
      repo: "org/repo",
      pr: 42,
      status: "WAITING_EXTERNAL",
      expectedGeneration: 3,
    });
    mocks.isPrFixRepoArchived.mockResolvedValue(false);
    mocks.auditLogCreate.mockResolvedValue({ id: "log-1" });
  });

  // A bound worker credential: the identity is the token's binding, never a
  // self-reported header or body field.
  function boundAlphaPost(body: unknown) {
    return POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body,
        token: BOUND_WORKER_TOKEN,
      }),
    );
  }

  it("maps a not-handed replay refusal to 403 with a failed audit row", async () => {
    mocks.markPrFixItem.mockResolvedValue({ mutated: false, reason: "not-handed" });

    const res = await boundAlphaPost({ repo: "org/repo", pr: 42, status: "WAITING_EXTERNAL", generation: 3 });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("not-handed");
    expect(body.error).toContain("not handed to the authenticated agent");
    // The route forwards the bound token's identity — never a body/header value.
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "WAITING_EXTERNAL",
        expectedGeneration: 3,
        actorTier: "worker",
        handoutScopedAgent: "alpha",
      }),
    );
    // The refusal is audited as a failure (named to the bound agent), never as a success.
    expect(mocks.auditLogCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "pr_fix_mark",
        actor: "alpha",
        repoFullName: "org/repo",
        success: false,
        errorMessage: expect.stringContaining("holds no hand-out"),
      }),
    });
  });

  it("answers the recorded waiter's own same-generation replay with 200 and the row", async () => {
    const row = { id: "fix-1", status: "WAITING_EXTERNAL", externalWaitBy: "alpha" };
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: row });

    const res = await boundAlphaPost({ repo: "org/repo", pr: 42, status: "WAITING_EXTERNAL", generation: 3 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(row);
    expect(mocks.markPrFixItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "WAITING_EXTERNAL",
        expectedGeneration: 3,
        actorTier: "worker",
        handoutScopedAgent: "alpha",
      }),
    );
    expect(mocks.auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "pr_fix_mark",
        actor: "alpha",
        success: true,
      }),
    });
  });

  it("does not forward a hand-out identity for maintainer marks", async () => {
    mocks.markPrFixItem.mockResolvedValue({ mutated: true, item: { id: "fix-1", status: "WAITING_EXTERNAL" } });

    const res = await postRequest({ repo: "org/repo", pr: 42, status: "WAITING_EXTERNAL", generation: 3 });

    expect(res.status).toBe(200);
    const [, input] = mocks.markPrFixItem.mock.calls[0] as [unknown, any];
    expect(input.handoutScopedAgent).toBeUndefined();
    expect(input.actorTier).toBe("maintainer");
  });

  it("refuses the legacy unbound worker token before replay authorization (#1428)", async () => {
    const res = await POST(
      authedRequest("http://localhost/api/pr-fix-queue/mark", {
        method: "POST",
        body: { repo: "org/repo", pr: 42, status: "WAITING_EXTERNAL", generation: 3 },
        token: WORKER_TOKEN,
        headers: { "x-agent-name": "worker-agent" },
      }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Worker token is not bound to an agent");
    expect(mocks.markPrFixItem).not.toHaveBeenCalled();
  });
});
