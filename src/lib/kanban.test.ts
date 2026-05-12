import { describe, expect, it } from "vitest";
import { getIssuesByStatus } from "./kanban";

const issues = [
  { id: "backlog", labels: ["status/backlog"] },
  { id: "in-progress", labels: ["status/in-progress"] },
  { id: "no-status", labels: [] },
  { id: "unrelated", labels: ["type/bug", "project/test"] },
];

describe("getIssuesByStatus", () => {
  it("keeps explicitly backlog issues in Backlog", () => {
    expect(getIssuesByStatus(issues, "status/backlog").map((issue) => issue.id)).toContain("backlog");
  });

  it("keeps in-progress issues in In Progress", () => {
    expect(getIssuesByStatus(issues, "status/in-progress").map((issue) => issue.id)).toEqual(["in-progress"]);
  });

  it("treats issues with no status label as Backlog", () => {
    expect(getIssuesByStatus(issues, "status/backlog").map((issue) => issue.id)).toContain("no-status");
  });

  it("does not hide issues that only have unrelated labels", () => {
    expect(getIssuesByStatus(issues, "status/backlog").map((issue) => issue.id)).toContain("unrelated");
  });
});
