import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMockWithSafeEqual, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMockWithSafeEqual());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    findUnique: vi.fn(),
    update: vi.fn(),
    auditCreate: vi.fn(),
    fetchLatestCommit: vi.fn(),
    fetchRepositoryMetadata: vi.fn(),
    findOpenIssueKeys: vi.fn(),
    auth: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findUnique: mocks.findUnique, update: mocks.update },
    auditLog: { create: mocks.auditCreate },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock("@/lib/github-ci", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github-ci")>()),
  fetchLatestCommit: mocks.fetchLatestCommit,
}));
vi.mock("@/lib/github-code-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github-code-search")>()),
  fetchRepositoryMetadata: mocks.fetchRepositoryMetadata,
}));
vi.mock("@/lib/issue-dependency-annotation", () => ({ findOpenIssueKeys: mocks.findOpenIssueKeys }));
vi.mock("@/lib/auth-next", () => ({ auth: mocks.auth }));

import { DELETE, POST } from "./route";
import { resetAuthCaches } from "@/lib/auth";
import { resetRateLimits } from "@/lib/rate-limit";
import { computeGroomingIssueFingerprint } from "@/lib/groomer/freshness";
import { evaluateQueueAdmission } from "@/lib/queue-admission";
import { runGroomingFreshnessPass, type FreshnessIssueRow, type FreshnessStore } from "@/lib/groomer/freshness-invalidation";

const HEAD = "b".repeat(40);
const LABELS = ["status/ready", "priority/p1"];

function issue(over: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    number: 42,
    title: "Fix login",
    body: "Login fails. depends on #7",
    state: "open",
    labels: LABELS,
    commentsCount: 3,
    currentLane: "local",
    repository: { fullName: "org/repo" },
    groomedRunId: null,
    admissionOverrideId: null,
    ...over,
  };
}

const URL_ = "http://localhost/api/issues/issue-1/admission-override";
const ctx = { params: Promise.resolve({ issueId: "issue-1" }) };
const BASIC = `Basic ${Buffer.from("jory:op-pass").toString("base64")}`;

/** Operator (basic auth) request; the default for these tests. */
function operatorRequest(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method,
    headers: { Authorization: BASIC, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const post = (body?: unknown, headers: Record<string, string> = {}) => POST(operatorRequest("POST", body, headers), ctx);
const del = () => DELETE(operatorRequest("DELETE"), ctx);

function useAuthMode(mode: "basic" | "oidc" | "disabled" | undefined) {
  if (mode) process.env.DISPATCH_AUTH_MODE = mode;
  else delete process.env.DISPATCH_AUTH_MODE;
  resetAuthCaches();
}

beforeEach(() => {
  process.env.DISPATCH_AUTH_USERNAME = "jory";
  process.env.DISPATCH_AUTH_PASSWORD = "op-pass";
  useAuthMode("basic");
  resetRateLimits();
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(issue());
  mocks.update.mockResolvedValue({});
  mocks.auditCreate.mockResolvedValue({});
  mocks.fetchRepositoryMetadata.mockResolvedValue({ fullName: "org/repo", defaultBranch: "main", description: null });
  mocks.fetchLatestCommit.mockResolvedValue({ sha: HEAD });
  mocks.findOpenIssueKeys.mockResolvedValue(new Set(["org/repo#7"]));
  mocks.auth.mockResolvedValue(null);
});

describe("operator-only auth", () => {
  const bearer = (method: string) =>
    authedRequest(URL_, { method, body: method === "POST" ? {} : undefined, headers: { "x-agent-name": "worker-1" } });

  it.each([undefined, "basic", "oidc"] as const)(
    "rejects an agent bearer token with 403 for POST and DELETE (auth mode %s)",
    async (mode) => {
      useAuthMode(mode);
      mocks.findUnique.mockResolvedValue(issue({ admissionOverrideId: "override_1", groomedRunId: "override_1" }));
      for (const [handler, method] of [[POST, "POST"], [DELETE, "DELETE"]] as const) {
        const res = await handler(bearer(method), ctx);
        expect(res.status).toBe(403);
        expect((await res.json()).error).toMatch(/require operator auth.*agent bearer tokens cannot/);
      }
      expect(mocks.findUnique).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    },
  );

  it("accepts basic auth and records the operator as the actor", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(writtenData().admissionOverrideBy).toBe("jory");
    expect(JSON.parse(mocks.auditCreate.mock.calls[0][0].data.notes).authType).toBe("basic");
    mocks.findUnique.mockResolvedValue(issue({ admissionOverrideId: "override_1", groomedRunId: "override_1" }));
    expect((await del()).status).toBe(200);
  });

  it("accepts an OIDC session for POST and DELETE", async () => {
    useAuthMode("oidc");
    mocks.auth.mockResolvedValue({ user: { email: "jory@example.com" } });
    const sessionRequest = (method: string) =>
      new Request(URL_, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });

    const res = await POST(sessionRequest("POST"), ctx);
    expect(res.status).toBe(200);
    expect(writtenData().admissionOverrideBy).toBe("jory@example.com");
    expect(mocks.auditCreate.mock.calls[0][0].data).toMatchObject({ actor: "jory@example.com", action: "admission_override" });
    expect(JSON.parse(mocks.auditCreate.mock.calls[0][0].data.notes).authType).toBe("oidc");

    mocks.findUnique.mockResolvedValue(issue({ admissionOverrideId: "override_1", groomedRunId: "override_1" }));
    const cleared = await DELETE(sessionRequest("DELETE"), ctx);
    expect(cleared.status).toBe(200);
    expect(mocks.auditCreate.mock.calls[1][0].data).toMatchObject({ actor: "jory@example.com", action: "admission_override_cleared" });
  });

  it("accepts auth-disabled mode", async () => {
    useAuthMode("disabled");
    const res = await POST(new Request(URL_, { method: "POST" }), ctx);
    expect(res.status).toBe(200);
    expect(writtenData().admissionOverrideBy).toBe("operator");
  });
});

function writtenData(): Record<string, any> {
  return mocks.update.mock.calls[0][0].data;
}

describe("POST /api/issues/[issueId]/admission-override", () => {
  it("requires auth", async () => {
    expect((await POST(new Request(URL_, { method: "POST" }), ctx)).status).toBe(401);
    expect((await DELETE(new Request(URL_, { method: "DELETE" }), ctx)).status).toBe(401);
  });

  it("404s an unknown issue", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
  });

  it("refuses closed issues and issues that are not status/ready", async () => {
    mocks.findUnique.mockResolvedValueOnce(issue({ state: "closed" }));
    expect((await post()).status).toBe(409);
    mocks.findUnique.mockResolvedValueOnce(issue({ labels: ["status/backlog"] }));
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/must already be status\/ready/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("validates headSha and reason", async () => {
    expect((await post({ headSha: "abc123" })).status).toBe(400);
    expect((await post({ reason: 5 })).status).toBe(400);
    expect((await post({ reason: "x".repeat(2001) })).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("records the override as a global-scope freshness baseline bound to the cached issue and live head", async () => {
    const res = await post({ reason: "groomer keeps timing out; verified by hand" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.override).toMatchObject({ actor: "jory", headSha: HEAD, defaultBranch: "main" });

    const data = writtenData();
    expect(data.admissionOverrideId).toMatch(/^override_/);
    expect(data.groomedRunId).toBe(data.admissionOverrideId);
    expect(data).toMatchObject({
      admissionOverrideBy: "jory",
      admissionOverrideReason: "groomer keeps timing out; verified by hand",
      admissionOverrideHeadSha: HEAD,
      groomedHeadSha: HEAD,
      groomingVerifiedSha: HEAD,
      groomedDefaultBranch: "main",
      groomedEvidenceScope: "global",
      groomedCommentCount: 3,
      groomedDependencyKeys: ["org/repo#7"],
      groomedOpenBlockerKeys: ["org/repo#7"],
      groomingStaleAt: null,
      groomedIssueFingerprint: computeGroomingIssueFingerprint({
        title: "Fix login",
        body: "Login fails. depends on #7",
        state: "open",
        labels: LABELS,
      }),
    });
    expect(data.admissionOverrideAt).toBeInstanceOf(Date);

    const audit = mocks.auditCreate.mock.calls[0][0].data;
    expect(audit).toMatchObject({ actor: "jory", action: "admission_override", issueNumber: 42, success: true });
    expect(JSON.parse(audit.notes)).toMatchObject({ overrideId: data.admissionOverrideId, headSha: HEAD, authType: "basic" });
  });

  it("uses a supplied headSha without resolving the head", async () => {
    const sha = "c".repeat(40);
    expect((await post({ headSha: sha })).status).toBe(200);
    expect(mocks.fetchLatestCommit).not.toHaveBeenCalled();
    expect(writtenData().groomingVerifiedSha).toBe(sha);
  });

  it("fails without writing when the head cannot be resolved", async () => {
    mocks.fetchLatestCommit.mockResolvedValue(null);
    expect((await post()).status).toBe(502);
    mocks.fetchRepositoryMetadata.mockRejectedValue(new Error("GitHub down"));
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/GitHub down/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  describe("override lifecycle", () => {
    async function overriddenIssue() {
      mocks.findUnique.mockResolvedValue(issue({ body: "Login fails." }));
      mocks.findOpenIssueKeys.mockResolvedValue(new Set());
      await post();
      return { ...issue({ body: "Login fails." }), ...writtenData() };
    }

    it("admits the issue under enforce without any grooming run", async () => {
      const current = await overriddenIssue();
      expect(evaluateQueueAdmission(current, { mode: "enforce", run: null })).toMatchObject({ admitted: true, basis: "override" });
    });

    it("goes stale through the real freshness pass when the default branch moves", async () => {
      const current = await overriddenIssue();
      let marked: string[] = [];
      const store: FreshnessStore = {
        findFreshIssues: async () => [current as unknown as FreshnessIssueRow],
        findOpenIssueKeys: async () => new Set(),
        findCachedIssueStates: async () => new Map(),
        markStale: async (_issue, mark) => {
          marked = mark.reasons;
          return true;
        },
        advance: async () => {},
        recordAudit: async () => {},
      };
      const github = {
        fetchHeadSha: async () => "d".repeat(40),
        compareCommits: async () => ({ ok: true as const, status: "ahead" as const, files: ["README.md"], truncated: false }),
        fetchRecentComments: async () => [],
        fetchIssueState: async () => "open" as const,
        fetchPullRequestState: async () => "open" as const,
      };
      await runGroomingFreshnessPass([{ id: "repo-1", fullName: "org/repo" }], store, github as never);
      expect(marked).toEqual(["global_evidence_commit"]);

      const staled = { ...current, groomingStaleAt: new Date(), groomingStaleReasons: marked };
      expect(evaluateQueueAdmission(staled, { mode: "enforce", run: null })).toMatchObject({
        admitted: false,
        reasons: [expect.objectContaining({ code: "grooming_stale" })],
      });
    });
  });
});

describe("DELETE /api/issues/[issueId]/admission-override", () => {
  it("is a no-op without an override", async () => {
    const res = await del();
    expect(await res.json()).toEqual({ success: true, cleared: false });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("clears a current override and resets freshness to unknown", async () => {
    mocks.findUnique.mockResolvedValue(issue({ admissionOverrideId: "override_1", groomedRunId: "override_1" }));
    const res = await del();
    expect(await res.json()).toEqual({ success: true, cleared: true, freshnessReset: true });
    const data = writtenData();
    expect(data).toMatchObject({ admissionOverrideId: null, groomedRunId: null, groomedIssueFingerprint: null });
    expect(data).not.toHaveProperty("groomingRetryAfter");
    expect(mocks.auditCreate.mock.calls[0][0].data.action).toBe("admission_override_cleared");
  });

  it("leaves a later groom's baseline alone", async () => {
    mocks.findUnique.mockResolvedValue(issue({ admissionOverrideId: "override_1", groomedRunId: "run-9" }));
    const res = await del();
    expect(await res.json()).toEqual({ success: true, cleared: true, freshnessReset: false });
    expect(writtenData()).not.toHaveProperty("groomedRunId");
  });
});
