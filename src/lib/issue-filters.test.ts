import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  appendIssueWhere,
  applyRenovateIssueExclusion,
  buildExcludedLabelWhere,
  buildGroomingStateExclusionWhere,
  buildLabelWhere,
  buildNoStatusWhere,
  buildRenovateIssueExclusionWhere,
  buildVisibleIssueWhere,
  DEFAULT_DONE_RETENTION_DAYS,
  discoverLabelFilterOptions,
  getDoneRetentionDays,
  isRenovateIssue,
  toProjectLabel,
} from "./issue-filters";

describe("issue filter helpers", () => {
  it("discovers sorted agent and owner options from labels only", () => {
    const options = discoverLabelFilterOptions([
      { labels: ["agent/beta", "owner/alice", "assignee/example-agent"] },
      { labels: ["agent/alpha", "owner/bob", "agent/beta"] },
      { labels: ["priority/p1", "status/backlog"] },
    ]);

    expect(options).toEqual({
      agents: ["agent/alpha", "agent/beta"],
      owners: ["owner/alice", "owner/bob"],
    });
  });

  it("returns empty options when no agent or owner labels exist", () => {
    expect(discoverLabelFilterOptions([{ labels: ["priority/p2"] }, { labels: [] }])).toEqual({
      agents: [],
      owners: [],
    });
  });

  it("builds a single-label Prisma array filter", () => {
    expect(buildLabelWhere(["agent/alpha"])).toEqual({ has: "agent/alpha" });
  });

  it("builds a combined Prisma array filter for multiple labels", () => {
    expect(buildLabelWhere(["agent/alpha", undefined, "owner/alice", "priority/p1"])).toEqual({
      hasEvery: ["agent/alpha", "owner/alice", "priority/p1"],
    });
  });

  it("omits empty label filters", () => {
    expect(buildLabelWhere([undefined, null, ""])).toBeUndefined();
  });

  it("normalizes project filter values to project labels", () => {
    expect(toProjectLabel("api")).toBe("project/api");
    expect(toProjectLabel("")).toBeUndefined();
  });
});

describe("buildNoStatusWhere", () => {
  it("returns undefined when includeUntriaged is false", () => {
    expect(buildNoStatusWhere(false)).toBeUndefined();
  });

  it("returns a NOT hasSome filter with STATUS_LABELS when includeUntriaged is true", () => {
    const result = buildNoStatusWhere(true);
    expect(result).toBeDefined();
    const labels = result!.NOT.labels.hasSome;
    expect(labels).toContain("status/backlog");
    expect(labels).toContain("status/ready");
    expect(labels).toContain("status/in-progress");
    expect(labels).toContain("status/in-review");
    expect(labels).toContain("status/done");
  });
});

describe("issue exclusion filters", () => {
  it("builds excluded label filters with Prisma-supported scalar-list syntax", () => {
    expect(buildExcludedLabelWhere(["renovate"])).toEqual({
      NOT: { labels: { hasSome: ["renovate"] } },
    });
  });

  it("appends issue where clauses with AND", () => {
    const where: Record<string, unknown> = { repository: { enabled: true } };
    appendIssueWhere(where, { NOT: { labels: { hasSome: ["renovate"] } } });
    appendIssueWhere(where, { NOT: { labels: { hasSome: ["status/ready"] } } });

    expect(where.AND).toEqual([
      { NOT: { labels: { hasSome: ["renovate"] } } },
      { NOT: { labels: { hasSome: ["status/ready"] } } },
    ]);
  });

  it("adds Renovate exclusion as an AND clause", () => {
    const where: Record<string, unknown> = { repository: { enabled: true } };
    applyRenovateIssueExclusion(where);

    expect(where.AND).toEqual([
      expect.objectContaining({
        NOT: expect.objectContaining({
          OR: expect.arrayContaining([
            { labels: { hasSome: ["renovate", "dependencies", "automated"] } },
          ]),
        }),
      }),
    ]);
  });

  it("detects Renovate issues by shared heuristics", () => {
    expect(isRenovateIssue({ title: "Dependency Dashboard", labels: [] })).toBe(true);
    expect(isRenovateIssue({ title: "Update image node to v20", labels: [] })).toBe(true);
    expect(isRenovateIssue({ title: "Bump lodash", labels: ["renovate"] })).toBe(true);
    expect(isRenovateIssue({ title: "Fix login bug", labels: ["bug"] })).toBe(false);
  });
});

describe("Renovate exclusion criteria agreement (DB vs in-memory)", () => {
  type Issue = { title: string; labels: string[] };

  // Minimal evaluator for the Prisma where-clause shape produced by
  // buildRenovateIssueExclusionWhere, mirroring Prisma semantics:
  // hasSome is case-sensitive; title filters honor mode: "insensitive".
  function matchesWhere(issue: Issue, clause: Record<string, unknown>): boolean {
    if ("NOT" in clause) return !matchesWhere(issue, clause.NOT as Record<string, unknown>);
    if ("OR" in clause) {
      return (clause.OR as Record<string, unknown>[]).some((c) => matchesWhere(issue, c));
    }
    if ("labels" in clause) {
      const { hasSome } = clause.labels as { hasSome: string[] };
      return hasSome.some((label) => issue.labels.includes(label));
    }
    if ("title" in clause) {
      const filter = clause.title as { contains?: string; startsWith?: string; mode?: string };
      const insensitive = filter.mode === "insensitive";
      const title = insensitive ? issue.title.toLowerCase() : issue.title;
      const normalize = (needle: string) => (insensitive ? needle.toLowerCase() : needle);
      if (filter.contains !== undefined) return title.includes(normalize(filter.contains));
      if (filter.startsWith !== undefined) return title.startsWith(normalize(filter.startsWith));
    }
    throw new Error(`Unsupported where clause: ${JSON.stringify(clause)}`);
  }

  it("DB-level and in-memory exclusion agree on the same fixture set", () => {
    const fixtures: Issue[] = [
      // Renovate: title heuristics
      { title: "Dependency Dashboard", labels: [] },
      { title: "DEPENDENCY DASHBOARD", labels: [] },
      { title: "Renovate Dashboard 🤖", labels: [] },
      { title: "Update dependency lodash to v4.18.0", labels: [] },
      { title: "Update deps devDependencies", labels: [] },
      { title: "Update image node to v20", labels: [] },
      { title: "update dependency foo", labels: [] },
      // Renovate: label heuristics
      { title: "Bump lodash", labels: ["renovate"] },
      { title: "Bump lodash", labels: ["dependencies"] },
      { title: "Bump lodash", labels: ["automated"] },
      { title: "Fix login bug", labels: ["bug", "renovate"] },
      // Not Renovate
      { title: "Fix login bug", labels: ["bug", "priority/p1"] },
      { title: "Bump lodash", labels: [] },
      { title: "Add update dependency docs", labels: [] },
      { title: "Renovate the dashboard layout", labels: ["frontend"] },
      { title: "", labels: ["status/ready"] },
    ];

    const where = buildRenovateIssueExclusionWhere();
    for (const issue of fixtures) {
      // The where clause matches issues that SURVIVE the exclusion, so it
      // must agree with the negation of the in-memory predicate.
      expect(matchesWhere(issue, where), `disagreement on ${JSON.stringify(issue)}`).toBe(
        !isRenovateIssue(issue),
      );
    }
  });
});

describe("buildVisibleIssueWhere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISPATCH_DONE_RETENTION_DAYS;
  });

  it("defaults to open issues + recently closed Done issues (7-day retention)", () => {
    const now = new Date();
    const expectedCutoff = new Date();
    expectedCutoff.setDate(expectedCutoff.getDate() - 7);
    const where: Record<string, unknown> = { repository: { enabled: true } };
    buildVisibleIssueWhere(where);

    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toBeDefined();
    expect(Array.isArray(or)).toBe(true);
    expect(or.length).toBe(2);
    expect(or[0]).toEqual({ state: "open" });
    const branch1 = or[1] as Record<string, unknown>;
    expect(branch1.state).toBe("closed");
    expect((branch1.labels as Record<string, string>).has).toBe("status/done");
    const gte = (branch1.closedAt as Record<string, Date>).gte as Date;
    expect(gte).toBeInstanceOf(Date);
    expect(gte.getTime()).toBeGreaterThanOrEqual(expectedCutoff.getTime() - 1000);
    expect(gte.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it("shows all issues when includeClosed is true", () => {
    const where: Record<string, unknown> = { repository: { enabled: true } };
    buildVisibleIssueWhere(where, { includeClosed: true });

    expect(where.OR).toBeUndefined();
    expect(where.state).toBeUndefined();
  });

  it("respects custom doneRetentionDays option with exact cutoff", () => {
    const now = new Date();
    const expectedCutoff = new Date();
    expectedCutoff.setDate(expectedCutoff.getDate() - 30);
    const where: Record<string, unknown> = { repository: { enabled: true } };
    buildVisibleIssueWhere(where, { includeClosed: false, doneRetentionDays: 30 });

    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toBeDefined();
    const branch1 = or[1] as Record<string, unknown>;
    const gte = (branch1.closedAt as Record<string, Date>).gte as Date;
    expect(gte).toBeInstanceOf(Date);
    expect(gte.getTime()).toBeGreaterThanOrEqual(expectedCutoff.getTime() - 1000);
    expect(gte.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it("respects DISPATCH_DONE_RETENTION_DAYS env var with exact cutoff", () => {
    const now = new Date();
    const expectedCutoff = new Date();
    expectedCutoff.setDate(expectedCutoff.getDate() - 14);
    process.env.DISPATCH_DONE_RETENTION_DAYS = "14";
    const where: Record<string, unknown> = { repository: { enabled: true } };
    buildVisibleIssueWhere(where);

    const or = where.OR as Array<Record<string, unknown>>;
    const branch1 = or[1] as Record<string, unknown>;
    const gte = (branch1.closedAt as Record<string, Date>).gte as Date;
    expect(gte).toBeInstanceOf(Date);
    expect(gte.getTime()).toBeGreaterThanOrEqual(expectedCutoff.getTime() - 1000);
    expect(gte.getTime()).toBeLessThanOrEqual(now.getTime());
    delete process.env.DISPATCH_DONE_RETENTION_DAYS;
  });

  it("does not set OR when includeClosed is true", () => {
    const where: Record<string, unknown> = { repository: { enabled: true }, state: "open" };
    buildVisibleIssueWhere(where, { includeClosed: true });

    expect(where.OR).toBeUndefined();
  });

  it("preserves existing where clauses while adding OR", () => {
    const where: Record<string, unknown> = { repository: { enabled: true } };
    buildVisibleIssueWhere(where);

    expect(where.repository).toEqual({ enabled: true });
    expect(where.OR).toBeDefined();
  });
});

describe("getDoneRetentionDays", () => {
  beforeEach(() => {
    delete process.env.DISPATCH_DONE_RETENTION_DAYS;
  });

  it("returns default of 7 when env var is not set", () => {
    expect(getDoneRetentionDays()).toBe(DEFAULT_DONE_RETENTION_DAYS);
    expect(getDoneRetentionDays()).toBe(7);
  });

  it("respects DISPATCH_DONE_RETENTION_DAYS environment variable", () => {
    process.env.DISPATCH_DONE_RETENTION_DAYS = "30";
    expect(getDoneRetentionDays()).toBe(30);
  });

  it("clamps invalid values to default", () => {
    process.env.DISPATCH_DONE_RETENTION_DAYS = "abc";
    expect(getDoneRetentionDays()).toBe(DEFAULT_DONE_RETENTION_DAYS);

    process.env.DISPATCH_DONE_RETENTION_DAYS = "0";
    expect(getDoneRetentionDays()).toBe(DEFAULT_DONE_RETENTION_DAYS);

    process.env.DISPATCH_DONE_RETENTION_DAYS = "-5";
    expect(getDoneRetentionDays()).toBe(DEFAULT_DONE_RETENTION_DAYS);
  });
});

describe("deferral TTL", () => {
  // Four issues were parked indefinitely by groomer-written reasons that
  // asserted maintainer decisions nobody made ("Explicitly deferred by
  // maintainer", "Kept in backlog per audit decision"). notReadyReason
  // excluded them from grooming forever, so one fabricated sentence was
  // irreversible. A deferral now expires and the issue is reconsidered.
  it("keeps a fresh deferral excluded but lets an aged one back in", () => {
    const where = buildGroomingStateExclusionWhere(24) as {
      AND: Array<Record<string, unknown>>;
    };
    const deferralClause = where.AND.find(
      (c) => Array.isArray(c.OR) && JSON.stringify(c.OR).includes("notReadyReason"),
    ) as { OR: Array<Record<string, unknown>> };

    expect(deferralClause).toBeDefined();
    // Either no deferral at all, or one whose last groom is older than the TTL.
    expect(deferralClause.OR).toEqual([
      { notReadyReason: null },
      { groomedAt: { lt: expect.any(Date) } },
    ]);

    const cutoff = (deferralClause.OR[1].groomedAt as { lt: Date }).lt;
    const daysAgo = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(daysAgo).toBeGreaterThan(13);
    expect(daysAgo).toBeLessThan(15);
  });
});
