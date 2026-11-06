import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  blockedExternalParkIsLive,
  blockedExternalParkThreshold,
  clearBlockedExternalPark,
  deriveBlockedExternalDescriptor,
  getBlockedExternalParkMode,
  getLiveBlockedExternalPark,
  isBlockedExternalOutcome,
  isFreshWorkOutcome,
  loadLiveBlockedExternalParks,
  recordBlockedExternalSettlement,
  toBlockedExternalParkMark,
  type BlockedExternalParkRow,
} from "./blocked-external-park";
import { computeConclusionContentFingerprint } from "./no-pr-conclusion";

const MODE_KEY = "DISPATCH_BLOCKED_EXTERNAL_PARK_MODE";
const THRESHOLD_KEY = "DISPATCH_BLOCKED_EXTERNAL_PARK_THRESHOLD";
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    [MODE_KEY]: process.env[MODE_KEY],
    [THRESHOLD_KEY]: process.env[THRESHOLD_KEY],
  };
  delete process.env[MODE_KEY];
  delete process.env[THRESHOLD_KEY];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function row(over: Partial<BlockedExternalParkRow> & { contentFingerprint: string }): BlockedExternalParkRow {
  return {
    id: "park-1",
    issueId: "issue-1",
    agentName: "alpha",
    outcome: "blocked",
    descriptor: "blocked:abc123",
    consecutiveCount: 3,
    summary: null,
    lastSettledAt: new Date("2026-11-06T12:00:00.000Z"),
    createdAt: new Date("2026-11-06T00:00:00.000Z"),
    updatedAt: new Date("2026-11-06T12:00:00.000Z"),
    ...over,
  };
}

describe("getBlockedExternalParkMode", () => {
  it("defaults to enforce when unset (silence opts into the durable stop)", () => {
    expect(getBlockedExternalParkMode()).toBe("enforce");
  });
  it("accepts the recognized modes case-insensitively", () => {
    for (const mode of ["off", "audit", "enforce", " AUDIT "] as const) {
      process.env[MODE_KEY] = mode;
      expect(getBlockedExternalParkMode()).toBe(mode.trim().toLowerCase());
    }
  });
  it("degrades a typo to audit and warns once per distinct value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[MODE_KEY] = "enforec";
    expect(getBlockedExternalParkMode()).toBe("audit");
    expect(getBlockedExternalParkMode()).toBe("audit");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("blockedExternalParkThreshold", () => {
  it("defaults to 3", () => {
    expect(blockedExternalParkThreshold()).toBe(3);
  });
  it("clamps below 2 up to 2 (one settlement must stay re-offerable)", () => {
    process.env[THRESHOLD_KEY] = "1";
    expect(blockedExternalParkThreshold()).toBe(2);
  });
  it("clamps above 10 down to 10", () => {
    process.env[THRESHOLD_KEY] = "99";
    expect(blockedExternalParkThreshold()).toBe(10);
  });
  it("accepts an in-range value and rejects non-integers", () => {
    process.env[THRESHOLD_KEY] = "5";
    expect(blockedExternalParkThreshold()).toBe(5);
    process.env[THRESHOLD_KEY] = "three";
    expect(blockedExternalParkThreshold()).toBe(3);
    process.env[THRESHOLD_KEY] = "2.5";
    expect(blockedExternalParkThreshold()).toBe(3);
  });
});

describe("isBlockedExternalOutcome", () => {
  it("recognizes exactly the two blocked-on-a-prerequisite outcomes", () => {
    expect(isBlockedExternalOutcome("blocked")).toBe(true);
    expect(isBlockedExternalOutcome("waiting-external")).toBe(true);
    expect(isBlockedExternalOutcome("failed")).toBe(false);
    expect(isBlockedExternalOutcome("pr_opened")).toBe(false);
    expect(isBlockedExternalOutcome("no_changes_needed")).toBe(false);
  });
});

describe("isFreshWorkOutcome", () => {
  it("accepts only outcomes that show real progress or a terminal conclusion", () => {
    for (const outcome of ["pr_opened", "pr_updated", "issue_updated", "issue_closed", "no_changes_needed", "already_addressed", "already_done"]) {
      expect(isFreshWorkOutcome(outcome)).toBe(true);
    }
    // A failed attempt, a hand-off, and a capacity release say nothing about
    // the prerequisite; they must not end a park.
    for (const outcome of ["failed", "handed-off", "capacity-exhausted", "blocked", "waiting-external"]) {
      expect(isFreshWorkOutcome(outcome)).toBe(false);
    }
  });
});

describe("deriveBlockedExternalDescriptor", () => {
  it("uses the structured external-wait identity when the contract parses", () => {
    const descriptor = deriveBlockedExternalDescriptor({
      outcome: "waiting-external",
      externalWait: {
        kind: "upstream_issue",
        ref: "org/repo#1482",
        evidence: "still open",
        trigger: { kind: "closed" },
      },
    });
    expect(descriptor).toBe("wait:upstream_issue:org/repo#1482");
  });
  it("falls back to the text digest when the external-wait contract is malformed", () => {
    const descriptor = deriveBlockedExternalDescriptor({
      outcome: "waiting-external",
      externalWait: { kind: "not-a-kind" },
      error: "harness missing on main",
    });
    expect(descriptor).toMatch(/^blocked:[0-9a-f]{16}$/);
  });
  it("ignores blockReason — a coarse class is not a prerequisite identity", () => {
    // Two different prerequisites of the same blockReason class must NOT
    // accumulate into one park; the text decides, so different classes with
    // the same text match and the same class with different text does not.
    // blockReason is passed as a stray field (workers may send it) and the
    // descriptor derivation must ignore it.
    const report = (blockReason: string, error: string) => {
      const body = { outcome: "blocked" as const, error, blockReason };
      return deriveBlockedExternalDescriptor(body);
    };
    const a = report("human_decision", "decision needed on X");
    const b = report("infra_failure", "decision needed on X");
    const c = report("human_decision", "decision needed on Y");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it("digests the error text over the summary text", () => {
    const fromError = deriveBlockedExternalDescriptor({ outcome: "blocked", error: "harness missing", summary: "ignored" });
    const fromSummary = deriveBlockedExternalDescriptor({ outcome: "blocked", summary: "harness missing" });
    expect(fromError).toBe(fromSummary);
  });
  it("matches across whitespace-only differences and separates different texts", () => {
    const a = deriveBlockedExternalDescriptor({ outcome: "blocked", error: "prerequisite   missing" });
    const b = deriveBlockedExternalDescriptor({ outcome: "blocked", error: "prerequisite\nmissing" });
    const c = deriveBlockedExternalDescriptor({ outcome: "blocked", error: "prerequisite missing later" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it("is stable across repeated calls", () => {
    const report = { outcome: "blocked" as const, error: "same text" };
    expect(deriveBlockedExternalDescriptor(report)).toBe(deriveBlockedExternalDescriptor(report));
  });
  it("names the empty case when no structured identity and no text exist", () => {
    expect(deriveBlockedExternalDescriptor({ outcome: "blocked" })).toBe("blocked:none");
    expect(deriveBlockedExternalDescriptor({ outcome: "blocked", error: "   " })).toBe("blocked:none");
  });
});

describe("blockedExternalParkIsLive", () => {
  const issue = { title: "t", body: "b" };
  const fingerprint = computeConclusionContentFingerprint(issue);

  it("is live at the threshold with a matching fingerprint", () => {
    expect(blockedExternalParkIsLive({ consecutiveCount: 3, contentFingerprint: fingerprint }, issue, 3)).toBe(true);
    expect(blockedExternalParkIsLive({ consecutiveCount: 4, contentFingerprint: fingerprint }, issue, 3)).toBe(true);
  });
  it("is NOT live below the threshold (a counter is not a park)", () => {
    expect(blockedExternalParkIsLive({ consecutiveCount: 2, contentFingerprint: fingerprint }, issue, 3)).toBe(false);
  });
  it("ends the moment the content fingerprint moves", () => {
    expect(blockedExternalParkIsLive({ consecutiveCount: 5, contentFingerprint: "nope" }, issue, 3)).toBe(false);
  });
});

describe("toBlockedExternalParkMark", () => {
  it("projects the row for queue diagnostics", () => {
    const mark = toBlockedExternalParkMark(
      row({ contentFingerprint: "x", descriptor: "wait:upstream_issue:org/repo#1482" }),
      3,
    );
    expect(mark).toEqual({
      agentName: "alpha",
      outcome: "blocked",
      descriptor: "wait:upstream_issue:org/repo#1482",
      count: 3,
      threshold: 3,
      at: "2026-11-06T12:00:00.000Z",
    });
  });
});

// An in-memory client so record/clear semantics run against real state.
function fakeParkClient(initial: BlockedExternalParkRow[] = []) {
  const rows = new Map(initial.map((r) => [r.issueId, { ...r }]));
  const events: Array<Record<string, unknown>> = [];
  const client = {
    blockedExternalPark: {
      findMany: vi.fn(async ({ where }: { where: { issueId: { in: string[] } } }) =>
        rows ? [...rows.values()].filter((r) => where.issueId.in.includes(r.issueId)) : [],
      ),
      findUnique: vi.fn(async ({ where }: { where: { issueId: string } }) => rows.get(where.issueId) ?? null),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const [issueId, r] of rows) if (where.id.in.includes(r.id)) rows.delete(issueId);
        return { count: where.id.in.length };
      }),
      delete: vi.fn(async ({ where }: { where: { issueId: string } }) => {
        const r = rows.get(where.issueId);
        rows.delete(where.issueId);
        return r ?? null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { issueId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = rows.get(where.issueId);
          const base = existing ?? {
            id: `park-${rows.size + 1}`,
            issueId: where.issueId,
            agentName: "",
            outcome: "",
            descriptor: "",
            consecutiveCount: 0,
            summary: null,
            contentFingerprint: "",
            lastSettledAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          // Prisma upsert applies `create` ONLY when the row is absent and
          // `update` ONLY when it exists; the fake must not conflate the two.
          const merged = { ...base } as Record<string, unknown>;
          if (!existing) {
            for (const [k, v] of Object.entries(create)) {
              merged[k] = v;
            }
          } else {
            for (const [k, v] of Object.entries(update)) {
              if (
                typeof v === "object" &&
                v !== null &&
                "increment" in (v as Record<string, unknown>) &&
                typeof merged[k] === "number"
              ) {
                merged[k] = (merged[k] as number) + ((v as { increment: number }).increment as number);
              } else {
                merged[k] = v;
              }
            }
          }
          rows.set(where.issueId, merged as unknown as BlockedExternalParkRow);
          return merged as unknown as BlockedExternalParkRow;
        },
      ),
    },
    issueLifecycleEvent: {
      create: vi.fn(async (args: unknown) => {
        events.push((args as { data: Record<string, unknown> }).data);
        return {};
      }),
      upsert: vi.fn(async () => ({})),
    },
  };
  return { client, rows, events };
}

function settlementInput(over: Partial<Parameters<typeof recordBlockedExternalSettlement>[0]> = {}) {
  return {
    issueId: "issue-1",
    repoFullName: "org/repo",
    issueNumber: 42,
    agentName: "alpha",
    outcome: "blocked" as const,
    descriptor: "blocked:abc123",
    summary: "harness missing",
    issue: { title: "t", body: "b" },
    ...over,
  };
}

describe("recordBlockedExternalSettlement", () => {
  it("counts the first settlement without parking and records no event", async () => {
    const { client, events } = fakeParkClient();
    const result = await recordBlockedExternalSettlement(settlementInput(), client as never);
    expect(result.previousCount).toBe(0);
    expect(result.nextCount).toBe(1);
    expect(result.crossed).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("keeps counting same-descriptor settlements until the threshold crossing parks once", async () => {
    const { client, events } = fakeParkClient();
    const input = settlementInput();
    let last;
    for (let i = 1; i <= 4; i++) {
      last = await recordBlockedExternalSettlement(input, client as never);
      expect(last.nextCount).toBe(i);
    }
    // Default threshold 3: the third settlement crossed, the fourth did not.
    expect(last?.crossed).toBe(false);
    const crossings = events.filter((e) => e.kind === "blocked_external_parked");
    expect(crossings).toHaveLength(1);
    expect(crossings[0].metadata).toMatchObject({ outcome: "blocked", descriptor: "blocked:abc123", count: 3, threshold: 3 });
  });

  it("resets the count when the descriptor changes (a changed prerequisite is fresh)", async () => {
    const { client } = fakeParkClient();
    const first = await recordBlockedExternalSettlement(settlementInput({ descriptor: "blocked:aaa" }), client as never);
    expect(first.nextCount).toBe(1);
    const second = await recordBlockedExternalSettlement(settlementInput({ descriptor: "blocked:aaa" }), client as never);
    expect(second.nextCount).toBe(2);
    const reset = await recordBlockedExternalSettlement(settlementInput({ descriptor: "blocked:bbb" }), client as never);
    expect(reset.previousCount).toBe(2);
    expect(reset.nextCount).toBe(1);
    expect(reset.crossed).toBe(false);
  });

  it("resets a live park's count when the descriptor changes (un-parks on fresh prerequisite)", async () => {
    const { client, events } = fakeParkClient();
    const a = settlementInput({ descriptor: "blocked:aaa" });
    await recordBlockedExternalSettlement(a, client as never);
    await recordBlockedExternalSettlement(a, client as never);
    await recordBlockedExternalSettlement(a, client as never); // live now
    expect(events.filter((e) => e.kind === "blocked_external_parked")).toHaveLength(1);
    // The same loop with a DIFFERENT descriptor starts from scratch.
    await recordBlockedExternalSettlement(settlementInput({ descriptor: "blocked:bbb" }), client as never);
    const stored = await client.blockedExternalPark.findUnique({ where: { issueId: "issue-1" } });
    expect(stored?.consecutiveCount).toBe(1);
    expect(events.filter((e) => e.kind === "blocked_external_parked")).toHaveLength(1);
  });

  it("stamps the content fingerprint of the issue it settled against", async () => {
    const { client } = fakeParkClient();
    await recordBlockedExternalSettlement(settlementInput(), client as never);
    const stored = await client.blockedExternalPark.findUnique({ where: { issueId: "issue-1" } });
    expect(stored?.contentFingerprint).toBe(computeConclusionContentFingerprint({ title: "t", body: "b" }));
  });

  it("resets the count when the issue content changed between settlements (B1)", async () => {
    const { client, events } = fakeParkClient();
    const before = settlementInput();
    await recordBlockedExternalSettlement(before, client as never);
    await recordBlockedExternalSettlement(before, client as never);
    // A human edits the issue body between settlements: fresh evidence.
    const after = settlementInput({ issue: { title: "t", body: "edited" } });
    const result = await recordBlockedExternalSettlement(after, client as never);
    expect(result.previousCount).toBe(2);
    expect(result.nextCount).toBe(1);
    expect(result.crossed).toBe(false);
    const stored = await client.blockedExternalPark.findUnique({ where: { issueId: "issue-1" } });
    expect(stored?.contentFingerprint).toBe(computeConclusionContentFingerprint({ title: "t", body: "edited" }));
    expect(events.filter((e) => e.kind === "blocked_external_parked")).toHaveLength(0);
  });

  it("does not resurrect a live park from a post-edit settlement (B1)", async () => {
    const { client, events } = fakeParkClient();
    const before = settlementInput();
    await recordBlockedExternalSettlement(before, client as never);
    await recordBlockedExternalSettlement(before, client as never);
    await recordBlockedExternalSettlement(before, client as never); // live park, fp = v1
    expect(events.filter((e) => e.kind === "blocked_external_parked")).toHaveLength(1);
    // The body is edited; the next same-descriptor settlement must start over.
    const after = settlementInput({ issue: { title: "t", body: "edited" } });
    const result = await recordBlockedExternalSettlement(after, client as never);
    expect(result.nextCount).toBe(1);
    expect(events.filter((e) => e.kind === "blocked_external_parked")).toHaveLength(1);
  });

  it("derives the crossing from the POST-write row count, not the stale read (C4)", async () => {
    // Seed a row already at count 2, as a concurrent first writer would have
    // left it while a second writer was still reading count 1. The second
    // writer's write lands the row ON the threshold, so the event must fire
    // from the row's count (3), not from the stale previousCount comparison
    // (which would see 1 -> 2 and stay silent, losing the event).
    const { client, events } = fakeParkClient([
      row({ contentFingerprint: computeConclusionContentFingerprint({ title: "t", body: "b" }), consecutiveCount: 2 }),
    ]);
    const result = await recordBlockedExternalSettlement(settlementInput(), client as never);
    expect(result.previousCount).toBe(2);
    expect(result.nextCount).toBe(3);
    expect(result.crossed).toBe(true);
    expect(events.filter((e) => e.kind === "blocked_external_parked")).toHaveLength(1);
  });

  it("records no second event when a settlement lands on an already-live park", async () => {
    const { client, events } = fakeParkClient([
      row({ contentFingerprint: computeConclusionContentFingerprint({ title: "t", body: "b" }), consecutiveCount: 4 }),
    ]);
    const result = await recordBlockedExternalSettlement(settlementInput(), client as never);
    expect(result.nextCount).toBe(5);
    expect(result.crossed).toBe(false);
    expect(events.filter((e) => e.kind === "blocked_external_parked")).toHaveLength(0);
  });
});

describe("loadLiveBlockedExternalParks", () => {
  const issue = { id: "issue-1", title: "t", body: "b" };
  const fingerprint = computeConclusionContentFingerprint(issue);

  it("returns nothing without querying when there are no issues", async () => {
    const { client } = fakeParkClient();
    expect((await loadLiveBlockedExternalParks([], 3, client as never)).size).toBe(0);
    expect(client.blockedExternalPark.findMany).not.toHaveBeenCalled();
  });

  it("keeps live parks keyed by issueId", async () => {
    const live = row({ contentFingerprint: fingerprint, consecutiveCount: 3 });
    const { client } = fakeParkClient([live]);
    const result = await loadLiveBlockedExternalParks([issue], 3, client as never);
    expect(result.get("issue-1")).toStrictEqual(live);
    expect(client.blockedExternalPark.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps sub-threshold rows (they are counters, not parks) and deletes only expired ones", async () => {
    const counter = row({ id: "park-counter", issueId: "issue-1", contentFingerprint: fingerprint, consecutiveCount: 1 });
    const expired = row({ id: "park-old", issueId: "issue-2", contentFingerprint: "nope", consecutiveCount: 5 });
    const { client } = fakeParkClient([counter, expired]);
    const result = await loadLiveBlockedExternalParks(
      [
        { id: "issue-1", title: "t", body: "b" },
        { id: "issue-2", title: "t", body: "b" },
      ],
      3,
      client as never,
    );
    expect(result.size).toBe(0);
    expect(client.blockedExternalPark.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["park-old"] } } });
    // The counter survives the read.
    expect(await client.blockedExternalPark.findUnique({ where: { issueId: "issue-1" } })).toStrictEqual(counter);
  });

  it("never fails the queue over cleanup", async () => {
    const expired = row({ id: "park-old", contentFingerprint: "nope", consecutiveCount: 5 });
    const { client } = fakeParkClient([expired]);
    client.blockedExternalPark.deleteMany.mockRejectedValueOnce(new Error("db down"));
    const result = await loadLiveBlockedExternalParks([issue], 3, client as never);
    expect(result.size).toBe(0);
  });
});

describe("getLiveBlockedExternalPark", () => {
  const issue = { id: "issue-1", title: "t", body: "b" };
  const fingerprint = computeConclusionContentFingerprint(issue);

  it("returns null with no row", async () => {
    const { client } = fakeParkClient();
    expect(await getLiveBlockedExternalPark(issue, 3, client as never)).toBeNull();
  });
  it("returns the live park", async () => {
    const live = row({ contentFingerprint: fingerprint, consecutiveCount: 3 });
    const { client } = fakeParkClient([live]);
    expect(await getLiveBlockedExternalPark(issue, 3, client as never)).toStrictEqual(live);
  });
  it("treats a sub-threshold counter and an expired park as absent and never writes", async () => {
    const { client } = fakeParkClient([
      row({ contentFingerprint: fingerprint, consecutiveCount: 2 }),
      row({ issueId: "issue-1", id: "stale", contentFingerprint: "nope", consecutiveCount: 9 }),
    ]);
    expect(await getLiveBlockedExternalPark(issue, 3, client as never)).toBeNull();
    expect(client.blockedExternalPark.delete).not.toHaveBeenCalled();
    expect(client.blockedExternalPark.deleteMany).not.toHaveBeenCalled();
  });
});

describe("clearBlockedExternalPark", () => {
  it("is a no-op without a row", async () => {
    const { client, events } = fakeParkClient();
    expect(
      await clearBlockedExternalPark(
        { issueId: "issue-1", repoFullName: "org/repo", issueNumber: 1, actor: "operator", source: "api:status" },
        client as never,
      ),
    ).toBe(false);
    expect(client.blockedExternalPark.delete).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("removes the row and records the clearance with its provenance", async () => {
    const parked = row({ contentFingerprint: "x", descriptor: "blocked:9f2c1a", consecutiveCount: 4 });
    const { client, events } = fakeParkClient([parked]);
    expect(
      await clearBlockedExternalPark(
        {
          issueId: "issue-1",
          repoFullName: "org/repo",
          issueNumber: 1,
          actor: "operator",
          source: "api:blocked-external",
          reason: "operator clear",
        },
        client as never,
      ),
    ).toBe(true);
    expect(client.blockedExternalPark.delete).toHaveBeenCalledWith({ where: { issueId: "issue-1" } });
    const event = events[0];
    expect(event.kind).toBe("blocked_external_cleared");
    expect(event.source).toBe("api:blocked-external");
    expect(event.metadata).toMatchObject({
      parkedBy: "alpha",
      parkedOutcome: "blocked",
      parkedDescriptor: "blocked:9f2c1a",
      count: 4,
      reason: "operator clear",
    });
  });
});
