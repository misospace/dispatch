import { describe, expect, it } from "vitest";
import { buildLabelWhere, discoverLabelFilterOptions, toProjectLabel } from "./issue-filters";

describe("issue filter helpers", () => {
  it("discovers sorted agent and owner options from labels only", () => {
    const options = discoverLabelFilterOptions([
      { labels: ["agent/beta", "owner/alice", "assignee/saffron"] },
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
