import { describe, expect, it } from "vitest";
import { getProjectIssueStatus, groupIssuesByProject } from "./projects";

describe("groupIssuesByProject", () => {
  it("groups issues by repository when no project labels exist", () => {
    const groups = groupIssuesByProject([
      { id: "1", labels: [], repository: { fullName: "org/api", name: "api" } },
      { id: "2", labels: ["status/backlog"], repository: { fullName: "org/api", name: "api" } },
    ]);

    expect(groups).toEqual([
      {
        key: "org/api",
        name: "api",
        issues: [
          { id: "1", labels: [], repository: { fullName: "org/api", name: "api" } },
          { id: "2", labels: ["status/backlog"], repository: { fullName: "org/api", name: "api" } },
        ],
      },
    ]);
  });

  it("does not hide issues without project labels", () => {
    expect(
      groupIssuesByProject([{ id: "1", labels: ["status/backlog"], repository: { fullName: "org/api", name: "api" } }])
    ).toHaveLength(1);
  });

  it("keeps project labels from hiding repo-grouped issues", () => {
    expect(groupIssuesByProject([{ id: "1", labels: ["project/foo", "project/bar"], repository: { fullName: "org/api", name: "api" } }])).toEqual([
      {
        key: "org/api",
        name: "api",
        issues: [{ id: "1", labels: ["project/foo", "project/bar"], repository: { fullName: "org/api", name: "api" } }],
      },
    ]);
  });

  it("does not expect projects/* labels", () => {
    expect(groupIssuesByProject([{ id: "1", labels: ["projects/foo"], repository: { fullName: "org/api", name: "api" } }])).toEqual([
      {
        key: "org/api",
        name: "api",
        issues: [{ id: "1", labels: ["projects/foo"], repository: { fullName: "org/api", name: "api" } }],
      },
    ]);
  });

  it("returns no empty project groups", () => {
    expect(groupIssuesByProject([])).toEqual([]);
  });
});

describe("getProjectIssueStatus", () => {
  it("treats closed issues as done when no status label exists", () => {
    expect(getProjectIssueStatus({ labels: [], state: "closed" })).toBe("status/done");
  });

  it("treats closed issues as done even when another status label exists", () => {
    expect(getProjectIssueStatus({ labels: ["status/backlog"], state: "closed" })).toBe("status/done");
  });

  it("uses status labels when present", () => {
    expect(getProjectIssueStatus({ labels: ["status/in-review"], state: "open" })).toBe("status/in-review");
  });

  it("treats open issues with no status as backlog", () => {
    expect(getProjectIssueStatus({ labels: ["type/bug"], state: "open" })).toBe("status/backlog");
  });
});
