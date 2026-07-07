import { describe, expect, it } from "vitest";
import { getIssuesByStatus, getIssueStatus } from "./kanban";

const issues = [
  { id: "backlog", labels: ["status/backlog"], state: "open" },
  { id: "ready", labels: ["status/ready"], state: "open" },
  { id: "in-progress", labels: ["status/in-progress"], state: "open" },
  { id: "in-review", labels: ["status/in-review"], state: "open" },
  { id: "no-status", labels: [], state: "open" },
  { id: "unrelated", labels: ["type/bug", "project/test"], state: "open" },
  { id: "closed-no-status", labels: [], state: "closed" },
  { id: "closed-with-labels", labels: ["status/backlog"], state: "closed" },
];

describe("getIssueStatus", () => {
  it("respects explicit status labels on open issues", () => {
    expect(getIssueStatus({ labels: ["status/in-review"], state: "open" })).toBe("status/in-review");
  });

  it("returns Backlog for open issues with no status label", () => {
    expect(getIssueStatus({ labels: [], state: "open" })).toBe("status/backlog");
  });

  it("returns Done for closed issues with no status label", () => {
    expect(getIssueStatus({ labels: [], state: "closed" })).toBe("status/done");
  });

  it("respects explicit ready and in-review status labels", () => {
    expect(getIssueStatus({ labels: ["status/ready"], state: "open" })).toBe("status/ready");
    expect(getIssueStatus({ labels: ["status/in-review"], state: "open" })).toBe("status/in-review");
  });

  it("treats closed issues as Done even when another status label exists", () => {
    expect(getIssueStatus({ labels: ["status/backlog"], state: "closed" })).toBe("status/done");
    expect(getIssueStatus({ labels: ["status/in-progress"], state: "closed" })).toBe("status/done");
    expect(getIssueStatus({ labels: ["status/done"], state: "closed" })).toBe("status/done");
  });

  it("ignores non-status labels and defaults to Backlog", () => {
    expect(getIssueStatus({ labels: ["type/bug", "priority/p1"], state: "open" })).toBe("status/backlog");
  });
});

describe("getIssuesByStatus", () => {
  it("keeps explicitly backlog issues in Backlog", () => {
    expect(getIssuesByStatus(issues, "status/backlog").map((issue) => issue.id)).toContain("backlog");
  });

  it("keeps ready issues in Ready", () => {
    expect(getIssuesByStatus(issues, "status/ready").map((issue) => issue.id)).toEqual(["ready"]);
  });

  it("keeps in-review issues in In Review", () => {
    expect(getIssuesByStatus(issues, "status/in-review").map((issue) => issue.id)).toEqual(["in-review"]);
  });

  it("keeps in-progress issues in In Progress", () => {
    expect(getIssuesByStatus(issues, "status/in-progress").map((issue) => issue.id)).toEqual(["in-progress"]);
  });

  it("treats open issues with no status label as Backlog", () => {
    expect(getIssuesByStatus(issues, "status/backlog").map((issue) => issue.id)).toContain("no-status");
  });

  it("does not hide issues that only have unrelated labels", () => {
    expect(getIssuesByStatus(issues, "status/backlog").map((issue) => issue.id)).toContain("unrelated");
  });

  it("puts closed issues without status label in Done, not Backlog", () => {
    expect(getIssuesByStatus(issues, "status/done").map((issue) => issue.id)).toContain("closed-no-status");
    expect(getIssuesByStatus(issues, "status/backlog").map((issue) => issue.id)).not.toContain("closed-no-status");
  });

  it("puts closed issues with stale status labels in Done, not their labelled column", () => {
    expect(getIssuesByStatus(issues, "status/done").map((issue) => issue.id)).toContain("closed-with-labels");
    expect(getIssuesByStatus(issues, "status/backlog").map((issue) => issue.id)).not.toContain("closed-with-labels");
  });

  it("does not pollute Backlog with closed issues", () => {
    const backlog = getIssuesByStatus(issues, "status/backlog");
    expect(backlog.map((issue) => issue.id)).toEqual(["backlog", "no-status", "unrelated"]);
  });
});
