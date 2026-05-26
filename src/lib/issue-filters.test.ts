import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildLabelWhere, discoverLabelFilterOptions, toProjectLabel, buildVisibleIssueWhere, getDoneRetentionDays, DEFAULT_DONE_RETENTION_DAYS } from "./issue-filters";

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

describe("buildVisibleIssueWhere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DISPATCH_DONE_RETENTION_DAYS;
  });

  it("defaults to open issues + recently closed Done issues (7-day retention)", () => {
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
    expect((branch1.closedAt as Record<string, Date>).gte).toBeDefined();
  });

  it("shows all issues when includeClosed is true", () => {
    const where: Record<string, unknown> = { repository: { enabled: true } };
    buildVisibleIssueWhere(where, { includeClosed: true });

    expect(where.OR).toBeUndefined();
    expect(where.state).toBeUndefined();
  });

  it("respects custom doneRetentionDays option", () => {
    const where: Record<string, unknown> = { repository: { enabled: true } };
    buildVisibleIssueWhere(where, { includeClosed: false, doneRetentionDays: 30 });

    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toBeDefined();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const branch1 = or[1] as Record<string, unknown>;
    expect((branch1.closedAt as Record<string, Date>).gte).toBeTruthy();
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
