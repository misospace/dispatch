/**
 * Grooming freshness admission (#1065) through the real queue pipeline:
 * fetchAgentQueueData + buildAgentQueue + the /next-task and /queue routes,
 * with only Prisma and leases mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_AGENT_TOKEN as mockToken, makeDispatchEnvMock, authedRequest } from "@/test/route-helpers";

process.env.DISPATCH_AGENT_TOKEN = mockToken;

vi.mock("@/lib/dispatch-env", () => makeDispatchEnvMock());

const { mocks } = vi.hoisted(() => ({
  mocks: {
    issueFindMany: vi.fn(),
    groomingRunFindMany: vi.fn(),
    prFixFindMany: vi.fn(),
    prFixFindUnique: vi.fn(),
    prFixCreate: vi.fn(),
    prFixHistoryCreate: vi.fn(),
    prFixRows: [] as any[],
    fetchPullRequestLabels: vi.fn(),
    fetchPullRequestHeadSha: vi.fn(),
    findLeasedIssueIds: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    issue: { findMany: mocks.issueFindMany },
    groomingRun: { findMany: mocks.groomingRunFindMany },
    prFixQueueItem: {
      findMany: mocks.prFixFindMany,
      findUnique: mocks.prFixFindUnique,
      create: mocks.prFixCreate,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    prFixHistory: { create: mocks.prFixHistoryCreate },
    $transaction: async (fn: any) => fn({
      prFixQueueItem: { create: mocks.prFixCreate, findUnique: mocks.prFixFindUnique },
      prFixHistory: { create: mocks.prFixHistoryCreate },
    }),
  },
  asPrFixQueueClient: (client: unknown) => client,
}));

vi.mock("@/lib/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/github")>()),
  fetchPullRequestLabels: mocks.fetchPullRequestLabels,
  fetchPullRequestHeadSha: mocks.fetchPullRequestHeadSha,
}));

vi.mock("@/lib/lease", () => ({ findLeasedIssueIds: mocks.findLeasedIssueIds }));

import { GET as nextTask } from "./next-task/route";
import { GET as queue } from "./queue/route";
import { resetAuthCaches } from "@/lib/auth";
import { buildAgentQueue } from "@/lib/agent-queue";
import { dependencyKey } from "@/lib/issue-dependencies";
import { computeGroomingIssueFingerprint } from "@/lib/groomer/freshness";

const DIGEST = "sha256:evidence";
const SHA = "a".repeat(40);

interface Row {
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  labels: string[];
  currentLane: string;
  [key: string]: unknown;
}

function row(id: string, number: number, labels: string[], over: Record<string, unknown> = {}): Row {
  return {
    id,
    number,
    createdAt: new Date(),
    title: `Issue ${number}`,
    body: `Body ${number}`,
    url: `https://github.com/org/repo/issues/${number}`,
    labels,
    currentLane: "local",
    decomposed: false,
    repository: { fullName: "org/repo" },
    linkedPrNumber: null,
    linkedPrUrl: null,
    linkedPrNeedsFollowup: false,
    linkedPrFollowupReasons: [],
    linkedPrReviewDecision: null,
    linkedPrMergeState: null,
    linkedPrHealthCheckedAt: null,
    state: "open",
    groomedRunId: null,
    groomedIssueFingerprint: null,
    groomedEvidenceDigest: null,
    groomedEvidenceScope: null,
    groomingStaleAt: null,
    groomingStaleReasons: [],
    groomingVerifiedSha: null,
    admissionOverrideId: null,
    ...over,
  };
}

/** Give a row a fresh, verified baseline pointing at `runId`. */
function groomed(r: Row, runId: string): Row {
  return {
    ...r,
    groomedRunId: runId,
    groomedIssueFingerprint: computeGroomingIssueFingerprint({ title: r.title, body: r.body, state: "open", labels: r.labels }),
    groomedEvidenceDigest: DIGEST,
    groomedEvidenceScope: "paths",
    groomingVerifiedSha: SHA,
  };
}

function run(id: string, readiness: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    id,
    status: "completed",
    stage: "applied",
    dryRun: false,
    validatedOutput: { readiness: { ready: true, admission: "implementation", lane: "local", evidenceDigest: DIGEST, reasons: [], ...readiness } },
    ...over,
  };
}

// #10 p0 ready, never groomed (unknown)  -> withheld
// #11 p0 ready, stale                    -> withheld
// #12 p1 ready, applied + ready          -> admitted
// #13 p1 ready, plan not ready           -> withheld
// #14 p3 in-progress, claimed by me      -> not gated
// #15 p0 ready, depends on open #10      -> #1038 gate (never reaches admission)
function fixture(): Row[] {
  return [
    row("i10", 10, ["status/ready", "priority/p0"]),
    { ...groomed(row("i11", 11, ["status/ready", "priority/p0"]), "run-11"), groomingStaleAt: new Date(), groomingStaleReasons: ["human_comment"] },
    groomed(row("i12", 12, ["status/ready", "priority/p1"]), "run-12"),
    groomed(row("i13", 13, ["status/ready", "priority/p1"]), "run-13"),
    row("i14", 14, ["status/in-progress", "priority/p3", "agent/example-agent"]),
    row("i15", 15, ["status/ready", "priority/p0"], { body: "depends on #10" }),
  ];
}

const RUNS = [run("run-11"), run("run-12"), run("run-13", { ready: false, admission: null, lane: null, reasons: ["verdict is backlog"] })];

const PR_FIX = {
  id: "prfix-1",
  repo: "org/repo",
  pr: 77,
  issue: 10,
  branch: "fix/issue-10",
  url: "https://github.com/org/repo/pull/77",
  title: "Fix 10",
  lane: "NORMAL",
  status: "QUEUED",
  reason: "ci failed",
  feedback: [],
  evidenceKeys: ["ci:1"],
  author: "itsmiso-ai",
  generation: 1,
  queuedAt: new Date("2026-09-20T00:00:00Z"),
  updatedAt: new Date("2026-09-20T00:00:00Z"),
};

const params = { params: Promise.resolve({ agentName: "example-agent" }) };
const req = (path: string) => authedRequest(`http://localhost/api/agents/example-agent/${path}`);

async function getNextTask(path = "next-task") {
  const res = await nextTask(req(path), params);
  expect(res.status).toBe(200);
  return res.json();
}

async function getQueue(path = "queue") {
  const res = await queue(req(path), params);
  expect(res.status).toBe(200);
  return res.json() as Promise<Array<Record<string, any>>>;
}

/** The pre-#1065 select, key for key: off mode must issue exactly this query. */
const PRE_ADMISSION_SELECT_KEYS = [
  "id",
  "number",
  "createdAt",
  "title",
  "body",
  "nativeBlockedBy",
  "url",
  "labels",
  "currentLane",
  "decomposed",
  "repository",
  "linkedPrNumber",
  "linkedPrUrl",
  "linkedPrNeedsFollowup",
  "linkedPrFollowupReasons",
  "linkedPrReviewDecision",
  "linkedPrMergeState",
  "linkedPrHealthCheckedAt",
];

beforeEach(() => {
  delete process.env.DISPATCH_AUTH_MODE;
  delete process.env.DISPATCH_QUEUE_ADMISSION_MODE;
  resetAuthCaches();
  vi.clearAllMocks();
  mocks.issueFindMany.mockImplementation(async () => fixture());
  mocks.groomingRunFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    RUNS.filter((r) => where.id.in.includes(r.id)),
  );
  mocks.prFixFindMany.mockResolvedValue([]);
  mocks.prFixRows = [];
  mocks.prFixFindUnique.mockImplementation(async ({ where }: any) => {
    const rows = [...mocks.prFixRows, ...(await mocks.prFixFindMany())];
    if (where.id !== undefined) return rows.find((r: any) => r.id === where.id) ?? null;
    return rows.find((r: any) => r.repo === where.repo_pr.repo && r.pr === where.repo_pr.pr) ?? null;
  });
  mocks.prFixCreate.mockImplementation(async ({ data }: any) => {
    const item = { id: "linked-prfix", generation: 1, agentHandouts: [], ...data };
    mocks.prFixRows.push(item);
    return item;
  });
  mocks.prFixHistoryCreate.mockResolvedValue({});
  mocks.fetchPullRequestLabels.mockResolvedValue([]);
  mocks.fetchPullRequestHeadSha.mockResolvedValue(null);
  mocks.findLeasedIssueIds.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.DISPATCH_QUEUE_ADMISSION_MODE;
});

describe("admission off (default): queue behaviour is unchanged", () => {
  /** What the queue returned before #1065: buildAgentQueue over the same rows. */
  function preAdmissionQueue() {
    const rows = fixture();
    const openIssueKeys = new Set(rows.map((r) => dependencyKey("org/repo", r.number)));
    return buildAgentQueue(
      rows.map((r) => ({
        ...r,
        lane: r.currentLane,
        issueId: r.id,
        repoFullName: "org/repo",
        linkedPrHealth: {
          number: null,
          url: null,
          needsFollowup: false,
          followupReasons: [],
          reviewDecision: null,
          mergeState: null,
          checkedAt: null,
        },
      })),
      "example-agent",
      { lane: undefined, excludeDecomposed: false, includeClaimed: false, includeRenovate: false, excludedLabels: [], openIssueKeys },
    );
  }

  it.each([undefined, "off", "OFF", "not-a-mode"])("mode %j: /queue matches the pre-admission queue exactly", async (mode) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    if (mode !== undefined) process.env.DISPATCH_QUEUE_ADMISSION_MODE = mode;
    const body = await getQueue();
    expect(body).toEqual(JSON.parse(JSON.stringify(preAdmissionQueue())));
    expect(body.every((item) => !("admission" in item))).toBe(true);
    // Stale/unknown ready work is still handed out, exactly as before.
    expect(body.map((item) => item.number)).toEqual([10, 11, 12, 13, 14]);
    expect(mocks.groomingRunFindMany).not.toHaveBeenCalled();
    expect(Object.keys(mocks.issueFindMany.mock.calls[0][0].select)).toEqual(PRE_ADMISSION_SELECT_KEYS);
    warn.mockRestore();
  });

  it("/next-task hands out the top-ranked ready issue regardless of grooming state", async () => {
    const body = await getNextTask();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(10);
    expect(mocks.groomingRunFindMany).not.toHaveBeenCalled();
  });

  it("includeWithheld is a no-op", async () => {
    expect(await getQueue("queue?includeWithheld=true")).toEqual(await getQueue());
  });
});

describe("admission audit", () => {
  beforeEach(() => {
    process.env.DISPATCH_QUEUE_ADMISSION_MODE = "audit";
  });

  it("filters nothing but annotates every item with a deterministic decision", async () => {
    const body = await getQueue();
    expect(body.map((item) => item.number)).toEqual([10, 11, 12, 13, 14]);
    const byNumber = Object.fromEntries(body.map((item) => [item.number, item.admission]));
    expect(byNumber[10]).toMatchObject({ mode: "audit", admitted: false, reasons: [expect.objectContaining({ code: "grooming_unknown" })] });
    expect(byNumber[11]).toMatchObject({ admitted: false, reasons: [expect.objectContaining({ code: "grooming_stale" })] });
    expect(byNumber[12]).toMatchObject({ admitted: true, basis: "grooming", groomedRunId: "run-12" });
    expect(byNumber[13]).toMatchObject({ admitted: false, reasons: [expect.objectContaining({ code: "grooming_not_ready" })] });
    expect(byNumber[14]).toMatchObject({ admitted: true, basis: "not_gated" });
    expect(body.every((item) => item.claimable === true)).toBe(true);
  });

  it("reads each baseline's own run in one primary-key query", async () => {
    await getQueue();
    expect(mocks.groomingRunFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.groomingRunFindMany.mock.calls[0][0].where.id.in.sort()).toEqual(["run-11", "run-12", "run-13"]);
  });

  it("/next-task still hands out the top item and logs what enforce would do", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = await getNextTask();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(10);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/audit: .*#10, which enforce mode would withhold/));
    warn.mockRestore();
  });
});

describe("admission enforce", () => {
  beforeEach(() => {
    process.env.DISPATCH_QUEUE_ADMISSION_MODE = "enforce";
  });

  it("/queue returns only admitted work; the #1038 gate still applies first", async () => {
    const body = await getQueue();
    expect(body.map((item) => item.number)).toEqual([12, 14]);
    expect(body[0].admission).toMatchObject({ mode: "enforce", admitted: true });
  });

  it("/queue?includeWithheld=true appends withheld items as unclaimable, with reasons", async () => {
    const body = await getQueue("queue?includeWithheld=true");
    expect(body.map((item) => item.number)).toEqual([12, 14, 10, 11, 13]);
    const withheld = body.slice(2);
    expect(withheld.every((item) => item.claimable === false && item.admission.admitted === false)).toBe(true);
    expect(withheld.map((item) => item.admission.reasons[0].code)).toEqual(["grooming_unknown", "grooming_stale", "grooming_not_ready"]);
    expect(withheld[2].admission.summary).toContain("verdict is backlog");
    // #15 is dependency-blocked: the #1038 gate withholds it before admission runs.
    expect(body.some((item) => item.number === 15)).toBe(false);
  });

  it("/next-task never emits an implementation task for stale or ungroomed ready work", async () => {
    const body = await getNextTask();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(12);
  });

  it("/next-task goes idle with a reason when every ready issue is withheld", async () => {
    mocks.issueFindMany.mockImplementation(async () => fixture().filter((r) => [10, 11, 13].includes(r.number)));
    const body = await getNextTask();
    expect(body.type).toBe("idle");
    expect(body.reason).toBe("No work available (3 ready issues withheld by grooming admission)");
  });

  it("ignores readiness on a newer skipped run: only the baseline's run counts", async () => {
    // run-13 (the baseline) is not ready; a later in-flight skip recorded a
    // ready plan, which admission never reads.
    mocks.groomingRunFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      [...RUNS, run("run-13-skip", {}, { stage: "skipped" })].filter((r) => where.id.in.includes(r.id)),
    );
    const body = await getQueue("queue?includeWithheld=true");
    expect(mocks.groomingRunFindMany.mock.calls[0][0].where.id.in).not.toContain("run-13-skip");
    expect(body.find((item) => item.number === 13)?.admission.admitted).toBe(false);
  });

  it("admits a current operator override without a grooming run", async () => {
    mocks.issueFindMany.mockImplementation(async () => [
      { ...groomed(row("i10", 10, ["status/ready", "priority/p0"]), "override_x"), admissionOverrideId: "override_x", groomedEvidenceScope: "global" },
    ]);
    const body = await getNextTask();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(10);
    expect(mocks.groomingRunFindMany).not.toHaveBeenCalled();
  });

  it("PR-fix items are unaffected and still come first", async () => {
    mocks.prFixFindMany.mockResolvedValue([PR_FIX]);
    const body = await getNextTask();
    expect(body.type).toBe("followup-pr");
    expect(body.prFixItem).toEqual({ id: "prfix-1", generation: 1 });

    const listed = await getQueue();
    expect(listed[0]).toMatchObject({ pr: 77, repo: "org/repo" });
    expect(listed[0]).not.toHaveProperty("admission");
  });

  it("linked-PR follow-up routing still reaches a withheld issue's PR", async () => {
    mocks.issueFindMany.mockImplementation(async () => [
      row("i10", 10, ["status/ready", "priority/p0"], {
        linkedPrNumber: 88,
        linkedPrUrl: "https://github.com/org/repo/pull/88",
        linkedPrNeedsFollowup: true,
        linkedPrFollowupReasons: ["ci_failed"],
      }),
      groomed(row("i12", 12, ["status/ready", "priority/p1"]), "run-12"),
    ]);
    const body = await getNextTask();
    expect(body.type).toBe("followup-pr");
    expect(body.pullRequest.number).toBe(88);
    expect(body.issue.number).toBe(10);
  });

  it("does not gate a worker's own in-progress issue", async () => {
    mocks.issueFindMany.mockImplementation(async () => fixture().filter((r) => r.number === 14));
    const body = await getNextTask();
    expect(body.type).toBe("implement");
    expect(body.issue.number).toBe(14);
  });
});
