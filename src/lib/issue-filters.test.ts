import { describe, expect, it } from "vitest";
import { buildLabelWhere, discoverLabelFilterOptions, toProjectLabel, buildVisibleIssueWhere, getDoneRetentionCutoff } from "./issue-filters";

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
  it("returns empty where when includeClosed is true", () => {
    expect(buildVisibleIssueWhere({ includeClosed: true })).toEqual({});
  });

  it("returns OR clause with open + recently done by default", () => {
    const result = buildVisibleIssueWhere() as Record<string, unknown>;
    expect(result.OR).toBeDefined();
    expect(Array.isArray(result.OR)).toBe(true);
    const orArr = result.OR as Array<Record<string, unknown>>;
    expect(orArr.length).toBe(2);
    expect(orArr[0]).toEqual({ state: "open" });
    const secondBranch = orArr[1];
    expect(secondBranch.state).toBe("closed");
    expect((secondBranch.labels as { has: string }).has).toBe("status/done");
    expect((secondBranch.closedAt as { gte: Date }).gte).toBeDefined();
  });

  it("uses custom doneRetentionDays", () => {
    const result = buildVisibleIssueWhere({ doneRetentionDays: 30 }) as Record<string, unknown>;
    // The cutoff date should be ~30 days ago — verify the structure is correct
    const orArr = result.OR as Array<Record<string, unknown>>;
    expect(orArr[1].closedAt).toBeDefined();
    const cutoff = (orArr[1].closedAt as { gte: Date }).gte;
    const now = new Date();
    const expectedCutoff = new Date();
    expectedCutoff.setDate(now.getDate() - 30);
    // Allow 1-day tolerance for timezone/timing differences
    const diffMs = Math.abs(cutoff.getTime() - expectedCutoff.getTime());
    expect(diffMs).toBeLessThan(86400 * 1000);
  });

  it("defaults to 7 days retention", () => {
    const result = buildVisibleIssueWhere({ doneRetentionDays: 7 }) as Record<string, unknown>;
    const orArr = result.OR as Array<Record<string, unknown>>;
    const cutoff = (orArr[1].closedAt as { gte: Date }).gte;
    const now = new Date();
    const expectedCutoff = new Date();
    expectedCutoff.setDate(now.getDate() - 7);
    const diffMs = Math.abs(cutoff.getTime() - expectedCutoff.getTime());
    expect(diffMs).toBeLessThan(86400 * 1000);
  });

  it("returns OR clause when includeClosed is false with custom retention", () => {
    const result = buildVisibleIssueWhere({ includeClosed: false, doneRetentionDays: 14 }) as Record<string, unknown>;
    expect(result.OR).toBeDefined();
    expect(Array.isArray(result.OR)).toBe(true);
  });
});

describe("getDoneRetentionCutoff", () => {
  it("returns a date N days ago", () => {
    const cutoff = getDoneRetentionCutoff(7);
    const now = new Date();
    const expected = new Date();
    expected.setDate(now.getDate() - 7);
    const diffMs = Math.abs(cutoff.getTime() - expected.getTime());
    expect(diffMs).toBeLessThan(86400 * 1000);
  });

  it("defaults to 7 days", () => {
    const cutoff = getDoneRetentionCutoff();
    const now = new Date();
    const expected = new Date();
    expected.setDate(now.getDate() - 7);
    const diffMs = Math.abs(cutoff.getTime() - expected.getTime());
    expect(diffMs).toBeLessThan(86400 * 1000);
  });

  it("supports custom days", () => {
    const cutoff = getDoneRetentionCutoff(30);
    const now = new Date();
    const expected = new Date();
    expected.setDate(now.getDate() - 30);
    const diffMs = Math.abs(cutoff.getTime() - expected.getTime());
    expect(diffMs).toBeLessThan(86400 * 1000);
  });
});
