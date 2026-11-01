import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  computeConclusionContentFingerprint,
  getLiveNoPrConclusion,
  getNoPrConclusionMode,
  isNoPrConclusionOutcome,
  loadLiveNoPrConclusions,
  noPrConclusionIsLive,
  recordNoPrConclusion,
  clearNoPrConclusionPark,
  toNoPrConclusionMark,
  type NoPrConclusionRow,
} from "./no-pr-conclusion";

const ENV_KEY = "DISPATCH_NO_PR_CONCLUSION_MODE";
let savedMode: string | undefined;

beforeEach(() => {
  savedMode = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (savedMode === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedMode;
});

function row(over: Partial<NoPrConclusionRow> & { contentFingerprint: string }): NoPrConclusionRow {
  return {
    id: "park-1",
    issueId: "issue-1",
    agentName: "alpha",
    outcome: "no_changes_needed",
    summary: null,
    createdAt: new Date("2026-10-31T00:00:00.000Z"),
    ...over,
  };
}

describe("getNoPrConclusionMode", () => {
  it("defaults to enforce when unset (silence opts into the durable stop)", () => {
    expect(getNoPrConclusionMode()).toBe("enforce");
  });
  it("accepts the recognized modes case-insensitively", () => {
    for (const mode of ["off", "audit", "enforce", " AUDIT "] as const) {
      process.env[ENV_KEY] = mode;
      expect(getNoPrConclusionMode()).toBe(mode.trim().toLowerCase());
    }
  });
  it("degrades a typo to audit and warns once per distinct value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[ENV_KEY] = "enforec";
    expect(getNoPrConclusionMode()).toBe("audit");
    expect(getNoPrConclusionMode()).toBe("audit");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("isNoPrConclusionOutcome", () => {
  it("recognizes exactly the three terminal no-PR outcomes", () => {
    expect(isNoPrConclusionOutcome("no_changes_needed")).toBe(true);
    expect(isNoPrConclusionOutcome("already_addressed")).toBe(true);
    expect(isNoPrConclusionOutcome("already_done")).toBe(true);
    expect(isNoPrConclusionOutcome("pr_opened")).toBe(false);
    expect(isNoPrConclusionOutcome("blocked")).toBe(false);
    expect(isNoPrConclusionOutcome("failed")).toBe(false);
  });
});

describe("computeConclusionContentFingerprint", () => {
  const issue = { title: " Fix the widget ", body: "line one\r\nline two\r\n" };

  it("normalizes title and body so equivalent content hashes equal", () => {
    const a = computeConclusionContentFingerprint(issue);
    const b = computeConclusionContentFingerprint({ title: "Fix the widget", body: "line one\nline two" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats a missing body as empty", () => {
    expect(computeConclusionContentFingerprint({ title: "t", body: null })).toBe(
      computeConclusionContentFingerprint({ title: "t", body: "" }),
    );
  });

  it("changes when the title or body content changes", () => {
    const base = computeConclusionContentFingerprint(issue);
    expect(computeConclusionContentFingerprint({ ...issue, title: "Fix the widget! " })).not.toBe(base);
    expect(computeConclusionContentFingerprint({ ...issue, body: "line one\nline two\n\nnew section" })).not.toBe(base);
  });
});

describe("noPrConclusionIsLive", () => {
  const issue = { title: "t", body: "b" };
  const fingerprint = computeConclusionContentFingerprint(issue);

  it("is live while the content fingerprint matches", () => {
    expect(noPrConclusionIsLive({ contentFingerprint: fingerprint }, issue)).toBe(true);
  });
  it("ends the moment the content fingerprint moves", () => {
    expect(noPrConclusionIsLive({ contentFingerprint: fingerprint }, { title: "t", body: "edited" })).toBe(false);
  });
});

describe("toNoPrConclusionMark", () => {
  it("projects the row for queue diagnostics", () => {
    const mark = toNoPrConclusionMark(row({ contentFingerprint: "x", summary: "already shipped in v2" }));
    expect(mark).toEqual({
      agentName: "alpha",
      outcome: "no_changes_needed",
      at: "2026-10-31T00:00:00.000Z",
      summary: "already shipped in v2",
    });
  });
});

type MockFn = ReturnType<typeof vi.fn>;
function fakeParkClient(rows: NoPrConclusionRow[]) {
  const client: {
    noPrConclusion: Record<string, MockFn>;
    issueLifecycleEvent: Record<string, MockFn>;
  } = {
    noPrConclusion: {
      findMany: vi.fn(async () => rows),
      findUnique: vi.fn(async ({ where }: { where: { issueId: string } }) =>
        rows.find((r) => r.issueId === where.issueId) ?? null,
      ),
      delete: vi.fn(async () => ({ id: "park-1" })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    issueLifecycleEvent: { create: vi.fn(async () => ({})), upsert: vi.fn(async () => ({})) },
  };
  return client;
}

describe("loadLiveNoPrConclusions", () => {
  const issue = { id: "issue-1", title: "t", body: "b" };
  const fingerprint = computeConclusionContentFingerprint(issue);

  it("returns nothing without querying when there are no issues", async () => {
    const client = fakeParkClient([]);
    expect((await loadLiveNoPrConclusions([], client as never)).size).toBe(0);
    expect(client.noPrConclusion.findMany).not.toHaveBeenCalled();
  });

  it("keeps live parks keyed by issueId", async () => {
    const live = row({ contentFingerprint: fingerprint });
    const client = fakeParkClient([live]);
    const result = await loadLiveNoPrConclusions([issue], client as never);
    expect(result.get("issue-1")).toBe(live);
    expect(client.noPrConclusion.deleteMany).not.toHaveBeenCalled();
  });

  it("drops expired parks and cleans them up best-effort", async () => {
    const stale = row({ id: "park-old", contentFingerprint: "nope" });
    const client = fakeParkClient([stale]);
    const result = await loadLiveNoPrConclusions([issue], client as never);
    expect(result.size).toBe(0);
    expect(client.noPrConclusion.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["park-old"] } } });
  });

  it("never fails the queue over cleanup", async () => {
    const stale = row({ id: "park-old", contentFingerprint: "nope" });
    const client = fakeParkClient([stale]);
    client.noPrConclusion.deleteMany.mockRejectedValueOnce(new Error("db down"));
    const result = await loadLiveNoPrConclusions([issue], client as never);
    expect(result.size).toBe(0);
  });
});

describe("getLiveNoPrConclusion", () => {
  const issue = { id: "issue-1", title: "t", body: "b" };
  const fingerprint = computeConclusionContentFingerprint(issue);

  it("returns null with no park row", async () => {
    expect(await getLiveNoPrConclusion(issue, fakeParkClient([]) as never)).toBeNull();
  });
  it("returns the live park", async () => {
    const live = row({ contentFingerprint: fingerprint });
    expect(await getLiveNoPrConclusion(issue, fakeParkClient([live]) as never)).toBe(live);
  });
  it("treats an expired park as absent and never writes", async () => {
    const stale = row({ contentFingerprint: "nope" });
    const client = fakeParkClient([stale]);
    expect(await getLiveNoPrConclusion(issue, client as never)).toBeNull();
    expect(client.noPrConclusion.delete).not.toHaveBeenCalled();
    expect(client.noPrConclusion.deleteMany).not.toHaveBeenCalled();
  });
});

describe("recordNoPrConclusion", () => {
  it("upserts the park with the content fingerprint and records the lifecycle event", async () => {
    const client = fakeParkClient([]);
    const upsert = vi.fn(async (_args?: unknown) => row({ contentFingerprint: "x" }));
    client.noPrConclusion.upsert = upsert;
    await recordNoPrConclusion(
      {
        issueId: "issue-1",
        repoFullName: "org/repo",
        issueNumber: 42,
        agentName: "alpha",
        outcome: "already_addressed",
        summary: "shipped last week",
        evidence: "commit abc123",
        issue: { title: "t", body: "b" },
      },
      client as never,
    );
    expect(upsert).toHaveBeenCalledTimes(1);
    const args = upsert.mock.calls[0][0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(args.where).toEqual({ issueId: "issue-1" });
    expect(args.create.agentName).toBe("alpha");
    expect(args.create.outcome).toBe("already_addressed");
    expect(args.create.evidence).toBe("commit abc123");
    expect(args.create.contentFingerprint).toBe(computeConclusionContentFingerprint({ title: "t", body: "b" }));
    expect(args.update.outcome).toBe("already_addressed");
    const event = client.issueLifecycleEvent.create.mock.calls[0][0].data;
    expect(event.kind).toBe("conclusion_parked");
    expect(event.source).toBe("agent-report");
    expect(event.actor).toBe("alpha");
    expect(event.metadata.outcome).toBe("already_addressed");
  });

  it("does not fail the report when the lifecycle event write fails", async () => {
    const client = fakeParkClient([]);
    client.noPrConclusion.upsert = vi.fn(async (_args?: unknown) => row({ contentFingerprint: "x" }));
    client.issueLifecycleEvent.create = vi.fn(async () => {
      throw new Error("event write exploded");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      recordNoPrConclusion(
        {
          issueId: "issue-1",
          repoFullName: "org/repo",
          issueNumber: 42,
          agentName: "alpha",
          outcome: "no_changes_needed",
          issue: { title: "t", body: "b" },
        },
        client as never,
      ),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("clearNoPrConclusionPark", () => {
  it("is a no-op without a park", async () => {
    const client = fakeParkClient([]);
    expect(
      await clearNoPrConclusionPark(
        { issueId: "issue-1", repoFullName: "org/repo", issueNumber: 1, actor: "operator", source: "api:status" },
        client as never,
      ),
    ).toBe(false);
    expect(client.noPrConclusion.delete).not.toHaveBeenCalled();
  });

  it("removes the park and records the clearance with its provenance", async () => {
    const parked = row({ contentFingerprint: "x" });
    const client = fakeParkClient([parked]);
    expect(
      await clearNoPrConclusionPark(
        {
          issueId: "issue-1",
          repoFullName: "org/repo",
          issueNumber: 1,
          actor: "operator",
          source: "api:no-pr-conclusion",
          reason: "re-offer requested",
        },
        client as never,
      ),
    ).toBe(true);
    expect(client.noPrConclusion.delete).toHaveBeenCalledWith({ where: { issueId: "issue-1" } });
    const event = client.issueLifecycleEvent.create.mock.calls[0][0].data;
    expect(event.kind).toBe("conclusion_cleared");
    expect(event.source).toBe("api:no-pr-conclusion");
    expect(event.metadata).toMatchObject({
      parkedBy: "alpha",
      parkedOutcome: "no_changes_needed",
      reason: "re-offer requested",
    });
  });
});
