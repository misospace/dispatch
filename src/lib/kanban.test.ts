import { describe, expect, it } from "vitest";
import { getIssuesByStatus, getIssueStatus } from "./kanban";

const issues = [
  { id: "backlog", labels: ["status/backlog"], state: "open" },
  { id: "in-progress", labels: ["status/in-progress"], state: "open" },
  { id: "no-status", labels: [], state: "open" },
  { id: "unrelated", labels: ["type/bug", "project/test"], state: "open" },
  { id: "closed-no-status", labels: [], state: "closed" },
  { id: "closed-with-labels", labels: ["status/backlog"], state: "closed" },
];

describe("getIssueStatus", () => {
  it("treats closed issues as Done regardless of labels", () => {
    expect(getIssueStatus({ labels: [], state: "closed" })).toBe("status/done");
  });

  it("treats closed issues with explicit backlog label as Done", () => {
    expect(getIssueStatus({ labels: ["status/backlog"], state: "closed" })).toBe("status/done");
  });

  it("returns Backlog for open issues with no status label", () => {
    expect(getIssueStatus({ labels: [], state: "open" })).toBe("status/backlog");
  });

  it("respects explicit status labels for open issues", () => {
    expect(getIssueStatus({ labels: ["status/in-review"], state: "open" })).toBe("status/in-review");
    expect(getIssueStatus({ labels: ["status/done"], state: "open" })).toBe("status/done");
  });
});

describe("getIssuesByStatus", () => {
  it("keeps explicitly backlog issues in Backlog", () => {
    expect(getIssuesByStatus(issues, "status/backlog").map((issue) => issue.id)).toContain("backlog");
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

  it("classifies closed issues without status label as Done", () => {
    const doneIssues = getIssuesByStatus(issues, "status/done");
    expect(doneIssues.map((issue) => issue.id)).toContain("closed-no-status");
  });

  it("does not pollute Backlog with closed issues", () => {
    const backlog = getIssuesByStatus(issues, "status/backlog");
    expect(backlog.map((issue) => issue.id)).not.toContain("closed-no-status");
    expect(backlog.map((issue) => issue.id)).not.toContain("closed-with-labels");
  });

  it("moves closed backlog issues to Done instead of Backlog", () => {
    const doneIssues = getIssuesByStatus(issues, "status/done");
    expect(doneIssues.map((issue) => issue.id)).toContain("closed-with-labels");
  });
});
